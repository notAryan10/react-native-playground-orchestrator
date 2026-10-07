import 'dotenv/config';
import express from 'express';
import Docker from 'dockerode';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { randomBytes } from 'crypto';

const app = express();
const PORT = process.env.PORT || 4000;
const BACKEND_IMAGE = process.env.BACKEND_IMAGE || '';
const PUBLIC_IP = process.env.PUBLIC_IP || '';
const PROXY_PROTOCOL = process.env.PROXY_PROTOCOL || 'http';
const PROXY_HOST = process.env.PROXY_HOST || 'localhost';

const PORT_RANGE_START = 50000;
const PORT_RANGE_END = 50100;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Orchestrator is running' });
});

const docker = new Docker();

// Keep track of user activity
const userPortMap = new Map<string, string>();
const lastActivityMap = new Map<string, number>();

const INACTIVITY_LIMIT = 60 * 60 * 1000; // 1 hour

function updateActivity(userId: string) {
    lastActivityMap.set(userId, Date.now());
}

let nextPort = PORT_RANGE_START;
function getNextPort() {
    const port = nextPort;
    nextPort++;
    if (nextPort > PORT_RANGE_END) nextPort = PORT_RANGE_START;
    return port;
}

// Short-lived, single-use pairing tokens for the rnp:// helper flow, so the
// workspace id never travels through an OS-level URL. In memory: an
// orchestrator restart voids outstanding tokens (the user just clicks again).
const PAIR_TOKEN_TTL_MS = 10 * 60 * 1000;
const pairTokens = new Map<string, { userId: string; expires: number }>();

app.post('/pair', (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const now = Date.now();
    for (const [t, p] of pairTokens) if (p.expires < now) pairTokens.delete(t);
    const token = randomBytes(16).toString('hex');
    pairTokens.set(token, { userId, expires: now + PAIR_TOKEN_TTL_MS });
    res.json({ token, expiresInMs: PAIR_TOKEN_TTL_MS });
});

app.post('/pair/redeem', (req, res) => {
    const { token } = req.body || {};
    const p = typeof token === 'string' ? pairTokens.get(token) : undefined;
    if (p) pairTokens.delete(token);
    if (!p || p.expires < Date.now()) return res.status(404).json({ error: 'pairing token invalid or expired' });
    res.json({ id: p.userId });
});

// The RNP Device helper installs the mobile app from here, so the APK source
// is server config, never something an rnp:// link can choose.
app.get('/apk', (_req, res) => {
    const url = process.env.APK_DOWNLOAD_URL;
    if (!url) return res.status(404).json({ error: 'APK_DOWNLOAD_URL is not configured' });
    res.redirect(302, url);
});

app.post('/workspaces', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    updateActivity(userId);

    if (process.env.LOCAL_DEV === 'true') {
        console.log(`[LocalDev] Routing ${userId} directly to host port 3000`);
        userPortMap.set(userId, '3000');
        const host = req.headers.host || 'localhost';
        const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
        const scheme = (req.protocol === 'https' || !isLocal) ? 'wss' : 'ws';
        return res.json({
            status: 'ready',
            url: `${scheme}://${host}/proxy/${userId}`
        });
    }

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
            
            // Force remove if it already exists to avoid 409 Conflict
            await docker.getContainer(containerName).remove({ force: true }).catch(() => {});

            const assignedPort = getNextPort();
            container = await docker.createContainer({
                Image: BACKEND_IMAGE,
                name: containerName,
                Cmd: ['node', 'dist/server.js'],
                WorkingDir: '/app',
                HostConfig: {
                    PortBindings: { '3000/tcp': [{ HostPort: assignedPort.toString() }] },
                    Binds: [`${volumeName}:/workspace`],
                },
                Env: [
                    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                    `WORKSPACE_DIR=/workspace`,
                    `DATABASE_URL=${process.env.DATABASE_URL || ''}`
                ]
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
    if (userId) updateActivity(userId);
    const targetPort = userPortMap.get(userId || '');

    if (!targetPort) {
        return res.status(404).send('Workspace session not found. Please refresh the editor.');
    }

    return createProxyMiddleware({
        target: `${PROXY_PROTOCOL}://${PROXY_HOST}:${targetPort}`,
        changeOrigin: true,
        pathRewrite: {
            [`^/proxy/${userId}`]: '',
        },
        on: {
            error: (err) => console.error(`Proxy error for ${userId}:`, err)
        }
    })(req, res, next);
});

// ---- Android runtime endpoints (Milestone 3) ----
// Enabled only when ANDROID_RUNTIME_ALLOWED=true so prod boxes without KVM
// simply don't expose them. See android-runtime.ts for env config.
import { WebSocketServer } from 'ws';
import { startRuntime, stopRuntime, getRuntime, listRuntimes, handleControl, attachControlSocket, detachControlSocket, initAndroidRuntime, AvdBusyError } from './android-runtime.js';

const ANDROID_ALLOWED = process.env.ANDROID_RUNTIME_ALLOWED === 'true';

// Control-plane WebSocket (browser input -> adb). Upgrades are routed manually
// in server.on('upgrade') below; this server only speaks the message protocol.
const controlWss = new WebSocketServer({ noServer: true });

if (ANDROID_ALLOWED) {
    app.post('/android/runtime/start', async (req, res) => {
        const { userId } = req.body || {};
        if (!userId) return res.status(400).json({ error: 'userId is required' });
        try {
            const info = startRuntime(`rt_${userId}`);
            res.json({
                runtimeId: info.runtimeId,
                status: info.status,
                stream: info.status === 'ready'
                    ? { type: 'ws-scrcpy', url: info.streamUrl }
                    : undefined,
            });
        } catch (e: any) {
            if (e instanceof AvdBusyError) {
                res.status(409).json({
                    error: e.message,
                    avdName: e.avdName,
                    busyRuntimeId: e.busyRuntimeId,
                    hint: 'one runtime per AVD; stop the busy runtime first (POST /android/runtime/:id/stop)',
                });
                return;
            }
            console.error('[AndroidRuntime] start failed:', e?.message || e);
            res.status(502).json({ error: 'Android runtime failed to start', detail: String(e?.message || e) });
        }
    });

    app.get('/android/runtime/:runtimeId', (req, res) => {
        const info = getRuntime(req.params.runtimeId);
        if (!info) return res.status(404).json({ error: 'unknown runtime' });
        res.json(info);
    });

    app.post('/android/runtime/:runtimeId/stop', async (req, res) => {
        try {
            res.json(await stopRuntime(req.params.runtimeId));
        } catch (e: any) {
            res.status(404).json({ error: String(e?.message || e) });
        }
    });

    app.get('/android/runtimes', (_req, res) => {
        res.json({ runtimes: listRuntimes() });
    });

    // Stream proxy: same ORIGIN path the embedded panel uses for the iframe
    // and for the ws-scrcpy video WebSocket (via the upgrade handler below).
    // Both dev and prod go through this route so the panel has exactly one
    // stream URL shape; ws-scrcpy's index.html uses relative asset paths, so
    // /bundle.js etc. resolve under the prefix and are proxied too.
    app.use('/android/stream/:runtimeId', (req, res, next) => {
        const info = getRuntime(req.params.runtimeId);
        if (!info || info.status !== 'ready' || !info.wsScrcpyPort) {
            return res.status(404).send('Android runtime not found or not ready');
        }
        return createProxyMiddleware({
            target: `http://127.0.0.1:${info.wsScrcpyPort}`,
            changeOrigin: true,
            pathRewrite: (path: string) => path.replace(/^\/android\/stream\/[^/]+/, ''),
            on: {
                error: (err) => console.error(`[AndroidStream] proxy error for ${req.params.runtimeId}:`, err),
            },
        })(req, res, next);
    });

    console.log('[AndroidRuntime] endpoints enabled (ANDROID_RUNTIME_ALLOWED=true)');
}

// Reconcile persisted sessions with reality (adopt live emulators, downgrade
// dead records) BEFORE accepting requests, so no route can see a
// half-initialized registry.
if (ANDROID_ALLOWED) {
    initAndroidRuntime();
}

const server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🚀 Secure Orchestrator ready on port ${PORT}`);
    
    // Cleanup interval
    setInterval(async () => {
        const now = Date.now();
        console.log(`[Cleanup] Running scheduled cleanup check...`);
        
        try {
            // 1. Remove containers that have exited naturally
            const exitedContainers = await docker.listContainers({ all: true, filters: { status: ['exited'] } });
            for (const c of exitedContainers) {
                if (c.Names[0]?.includes('workspace-con-')) {
                    await docker.getContainer(c.Id).remove().catch(() => {});
                    console.log(`[Cleanup] Removed exited container: ${c.Names[0]}`);
                }
            }

            // 2. Forcefully remove containers that have been inactive for too long
            const allContainers = await docker.listContainers({ all: true });
            for (const c of allContainers) {
                const name = c.Names[0];
                if (name?.includes('workspace-con-')) {
                    const userId = name.replace('/workspace-con-', '').replace('/', '');
                    const lastSeen = lastActivityMap.get(userId) || 0;
                    
                    if (now - lastSeen > INACTIVITY_LIMIT) {
                        console.log(`[Cleanup] User ${userId} inactive for > 1hr. Forcefully removing container.`);
                        const container = docker.getContainer(c.Id);
                        await container.stop().catch(() => {});
                        await container.remove().catch(() => {});
                        lastActivityMap.delete(userId);
                        userPortMap.delete(userId);
                    }
                }
            }
        } catch (e: any) {
            console.error('[Cleanup] Error during cleanup:', e.message);
        }
    }, 5 * 60 * 1000);
});

// Handle WebSocket upgrades manually for the dynamic proxy
server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url;
    if (!rawUrl) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
    }

    console.log(`[Upgrade] Incoming upgrade request for: ${rawUrl}`);
    
    // Simple path parsing
    const pathname = rawUrl.split('?')[0];
    if (!pathname) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
    }

    // Android runtime control plane: browser touch/keyboard -> adb input.
    const controlMatch = pathname.match(/^\/android\/runtime\/([^/]+)\/control$/);
    if (controlMatch) {
        if (!ANDROID_ALLOWED) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        const runtimeId = controlMatch[1];
        if (!runtimeId) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        const info = getRuntime(runtimeId);
        if (!info) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        controlWss.handleUpgrade(req, socket, head, (ws) => {
            if (!attachControlSocket(runtimeId, ws)) {
                ws.close(1008, 'unknown runtime');
                return;
            }
            console.log(`[AndroidRuntime] control socket connected for ${runtimeId}`);
            ws.send(JSON.stringify({ type: 'hello', runtimeId, serial: info.adbSerial, display: info.display }));
            ws.on('message', (data) => {
                let msg: unknown;
                try { msg = JSON.parse(String(data)); } catch {
                    ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }));
                    return;
                }
                const m = msg as { id?: string; type?: string };
                if (m?.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong', id: m.id }));
                    return;
                }
                handleControl(runtimeId, msg)
                    .then((res) => {
                        if (res.ok) ws.send(JSON.stringify({ type: 'ack', id: m?.id }));
                        else ws.send(JSON.stringify({ type: 'error', error: res.error, id: m?.id }));
                    })
                    .catch((e) => ws.send(JSON.stringify({ type: 'error', error: String(e?.message || e), id: m?.id })));
            });
            ws.on('close', () => detachControlSocket(runtimeId, ws));
            ws.on('error', () => { /* socket failures surface via close */ });
        });
        return;
    }

    // ws-scrcpy video WebSocket for the embedded panel (deep-link `ws` param
    // points here). Same proxy contract as the HTTP route above.
    const streamMatch = pathname.match(/^\/android\/stream\/([^/]+)(\/.*)?$/);
    if (streamMatch && streamMatch[1]) {
        if (!ANDROID_ALLOWED) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        const streamRuntimeId = streamMatch[1];
        const streamInfo = getRuntime(streamRuntimeId);
        if (!streamInfo || streamInfo.status !== 'ready' || !streamInfo.wsScrcpyPort) {
            socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
            return;
        }
        const streamProxy = createProxyMiddleware({
            target: `http://127.0.0.1:${streamInfo.wsScrcpyPort}`,
            changeOrigin: true,
            ws: true,
            pathRewrite: (path: string) => path.replace(/^\/android\/stream\/[^/]+/, ''),
            on: {
                error: (err) => console.error(`[AndroidStream] upgrade error for ${streamRuntimeId}:`, err),
            },
        });
        // @ts-ignore
        if (typeof streamProxy.upgrade === 'function') {
            // @ts-ignore
            streamProxy.upgrade(req, socket, head);
        } else {
            socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        }
        return;
    }

    const match = pathname.match(/^\/proxy\/([^/]+)/);

    if (match && match[1]) {
        const userId = match[1];
        updateActivity(userId);
        const targetPort = userPortMap.get(userId);

        if (targetPort) {
            console.log(`[Upgrade] Success: Routing ${userId} to localhost:${targetPort}`);
            const proxy = createProxyMiddleware({
                target: `${PROXY_PROTOCOL}://${PROXY_HOST}:${targetPort}`,
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
