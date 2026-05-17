import express from 'express';
import Docker from 'dockerode';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = process.env.PORT || 4000;
const BACKEND_IMAGE = process.env.BACKEND_IMAGE || 'notaryan/rn-playground-backend:latest';
const PUBLIC_IP = process.env.PUBLIC_IP || 'localhost';

const PORT_RANGE_START = 50000;
const PORT_RANGE_END = 50100;

app.use(cors());
app.use(express.json());

const docker = new Docker();

// Keep track of which user is on which port for the proxy
const userPortMap = new Map<string, string>();

let nextPort = PORT_RANGE_START;
function getNextPort() {
    const port = nextPort;
    nextPort++;
    if (nextPort > PORT_RANGE_END) nextPort = PORT_RANGE_START;
    return port;
}

app.post('/workspaces', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const containerName = `workspace-con-${userId}`;
    const volumeName = `workspace-vol-${userId}`;

    try {
        await docker.getVolume(volumeName).inspect().catch(() => docker.createVolume({ Name: volumeName }));

        let container = docker.getContainer(containerName);
        let info;
        try {
            info = await container.inspect();
            if (!info.State.Running) await container.start();
        } catch (e) {
            console.log(`Creating new container ${containerName}`);
            const assignedPort = getNextPort();
            container = await docker.createContainer({
                Image: BACKEND_IMAGE,
                name: containerName,
                HostConfig: {
                    PortBindings: { '3000/tcp': [{ HostPort: assignedPort.toString() }] },
                    Binds: [`${volumeName}:/workspace`],
                },
                Env: [`WORKSPACE_DIR=/workspace`]
            });
            await container.start();
            await new Promise(r => setTimeout(r, 2000));
            info = await container.inspect();
        }

        const hostPort = info.NetworkSettings.Ports['3000/tcp']?.[0]?.HostPort;
        if (!hostPort) throw new Error('Failed to retrieve host port');

        // Store for proxy
        userPortMap.set(userId, hostPort);

        // In production (Cloudflare), we connect to the secure tunnel URL
        // We use the proxy path so everything goes through port 443/4000
        const scheme = PUBLIC_IP.includes('localhost') ? 'ws' : 'wss';
        
        res.json({
            status: 'ready',
            url: `${scheme}://${PUBLIC_IP}/proxy/${userId}`
        });

    } catch (err: any) {
        console.error('Docker Orchestration error:', err);
        res.status(500).json({ error: 'Failed to provision workspace' });
    }
});

// The "Magic Proxy": Forwards traffic from /proxy/userId to localhost:assignedPort
app.use('/proxy/:userId', (req, res, next) => {
    const { userId } = req.params;
    const targetPort = userPortMap.get(userId || '');

    if (!targetPort) {
        return res.status(404).send('Workspace session not found. Please refresh the editor.');
    }

    return createProxyMiddleware({
        target: `http://localhost:${targetPort}`,
        changeOrigin: true,
        ws: true,
        pathRewrite: {
            [`^/proxy/${userId}`]: '',
        },
        on: {
            error: (err) => console.error(`Proxy error for ${userId}:`, err)
        }
    })(req, res, next);
});

app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🚀 Secure Orchestrator ready on port ${PORT}`);
    
    // Cleanup interval
    setInterval(async () => {
        try {
            const containers = await docker.listContainers({ all: true, filters: { status: ['exited'] } });
            for (const c of containers) {
                if (c.Names[0]?.includes('workspace-con-')) {
                    await docker.getContainer(c.Id).remove();
                    console.log(`Cleaned up: ${c.Names[0]}`);
                }
            }
        } catch (e) {}
    }, 5 * 60 * 1000);
});
