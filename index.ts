import express from 'express';
import Docker from 'dockerode';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = process.env.PORT || 4000;
// Prioritize environment variable, fallback to local image for dev
const BACKEND_IMAGE = process.env.BACKEND_IMAGE || 'rn-playground-backend:latest';
const PORT_RANGE_START = 50000;
const PORT_RANGE_END = 50100;

// Simple port tracker
let nextPort = PORT_RANGE_START;

function getNextPort() {
    const port = nextPort;
    nextPort++;
    if (nextPort > PORT_RANGE_END) nextPort = PORT_RANGE_START;
    return port;
}

app.use(cors());
app.use(express.json());

const docker = new Docker(); // Defaults to /var/run/docker.sock on Unix

async function ensureVolume(userId: string) {
    const volumeName = `workspace-vol-${userId}`;
    try {
        await docker.getVolume(volumeName).inspect();
        console.log(`Volume ${volumeName} already exists`);
    } catch (e: any) {
        if (e.statusCode === 404) {
            await docker.createVolume({ Name: volumeName });
            console.log(`Created Volume ${volumeName}`);
        } else throw e;
    }
    return volumeName;
}

async function getContainerIp(container: Docker.Container) {
    const data = await container.inspect();
    // In local bridge network, this will be the internal IP.
    // However, on Mac/Windows, we can't hit this IP directly from the host.
    // Instead, we will map ports dynamically.
    return data.NetworkSettings.IPAddress;
}

app.post('/workspaces', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const containerName = `workspace-con-${userId}`;
    const volumeName = `workspace-vol-${userId}`;

    try {
        await ensureVolume(userId);

        let container: Docker.Container;
        try {
            container = docker.getContainer(containerName);
            const info = await container.inspect();
            
            if (!info.State.Running) {
                console.log(`Starting existing container ${containerName}`);
                await container.start();
            } else {
                console.log(`Container ${containerName} is already running`);
            }
        } catch (e: any) {
            if (e.statusCode === 404) {
                console.log(`Creating new container ${containerName}`);
                const assignedPort = getNextPort();
                
                container = await docker.createContainer({
                    Image: BACKEND_IMAGE,
                    name: containerName,
                    ExposedPorts: { '3000/tcp': {} },
                    HostConfig: {
                        PortBindings: { '3000/tcp': [{ HostPort: assignedPort.toString() }] },
                        Binds: [`${volumeName}:/workspace`],
                    },
                    Env: [`WORKSPACE_DIR=/workspace`]
                });
                await container.start();
                // Wait a moment for the node process inside to start and bind the port
                console.log('Waiting for container process to initialize...');
                await new Promise(r => setTimeout(r, 2000));
            } else throw e;
        }

        const info = await container.inspect();
        const hostPort = info.NetworkSettings.Ports['3000/tcp']?.[0]?.HostPort;

        if (!hostPort) throw new Error('Failed to retrieve host port');

        const publicIp = process.env.PUBLIC_IP || 'localhost';

        res.json({
            status: 'ready',
            // Return the public AWS IP so the browser can connect
            url: `ws://${publicIp}:${hostPort}`
        });

    } catch (err: any) {
        console.error('Docker Orchestration error:', err);
        res.status(500).json({ error: 'Failed to provision workspace' });
    }
});

// Proxy is no longer needed in this direct HostPort mapping model, 
// but we'll keep the endpoint structure for frontend compatibility if needed.
// Actually, let's simplify and have the frontend connect directly to the returned port.

app.listen(PORT, () => {
    console.log(`🚀 Docker Orchestrator ready on port ${PORT}`);
    
    // Cleanup interval: Remove exited containers every 5 minutes
    setInterval(async () => {
        try {
            const containers = await docker.listContainers({ all: true, filters: { status: ['exited'] } });
            for (const containerInfo of containers) {
                if (containerInfo.Names.some(name => name.includes('workspace-con-'))) {
                    const container = docker.getContainer(containerInfo.Id);
                    await container.remove();
                    console.log(`Cleaned up exited container: ${containerInfo.Names[0]}`);
                }
            }
        } catch (e) {
            console.error('Cleanup error:', e);
        }
    }, 5 * 60 * 1000);
});
