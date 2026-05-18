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

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Orchestrator is running' });
});

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

        // Dynamically determine the host and scheme
        // 1. Priority: PUBLIC_IP env var (if you want to force a specific domain)
        // 2. Fallback: req.headers.host (automatically handles IP/Port from the browser's perspective)
        const host = PUBLIC_IP !== 'localhost' ? PUBLIC_IP : (req.headers.host || 'localhost');
        
        // Protocol logic:
        // - From Vercel/HTTPS, we MUST use wss://
        // - For local development, we use ws://
        // If the request is HTTPS, or if we are not on localhost, default to wss
        const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
        const scheme = (req.protocol === 'https' || !isLocal) ? 'wss' : 'ws';
        
        res.json({
            status: 'ready',
            url: `${scheme}://${host}/proxy/${userId}`
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
        pathRewrite: {
            [`^/proxy/${userId}`]: '',
        },
        on: {
            error: (err) => console.error(`Proxy error for ${userId}:`, err)
        }
    })(req, res, next);
});

const server = app.listen(Number(PORT), '0.0.0.0', () => {
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

// Handle WebSocket upgrades manually for the dynamic proxy
server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url || '';
    console.log(`[Upgrade] Incoming upgrade request for: ${rawUrl}`);
    
    // Simple path parsing
    const pathname = rawUrl.split('?')[0];
    const match = pathname.match(/^\/proxy\/([^/]+)/);

    if (match) {
        const userId = match[1];
        const targetPort = userPortMap.get(userId);

        if (targetPort) {
            console.log(`[Upgrade] Success: Routing ${userId} to localhost:${targetPort}`);
            const proxy = createProxyMiddleware({
                target: `http://localhost:${targetPort}`,
                changeOrigin: true,
                ws: true,
                pathRewrite: {
                    [`^/proxy/${userId}`]: '',
                },
                on: {
                    error: (err) => console.error(`[Upgrade] Proxy error for ${userId}:`, err)
                }
            });
            
            // @ts-ignore
            if (typeof proxy.upgrade === 'function') {
                // @ts-ignore
                proxy.upgrade(req, socket, head);
            } else {
                console.error('[Upgrade] Error: Proxy upgrade method not found');
                socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            }
        } else {
            console.warn(`[Upgrade] Failed: No port found in map for user ${userId}. Map size: ${userPortMap.size}`);
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        }
    } else {
        console.warn(`[Upgrade] Failed: URL ${rawUrl} did not match /proxy/:userId pattern`);
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});
