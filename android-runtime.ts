import { spawn, spawnSync, ChildProcess } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync, openSync, closeSync, readSync, fstatSync } from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import type { WebSocket } from 'ws';

/**
 * AndroidRuntimeManager
 *
 * Owns one Android emulator + ws-scrcpy instance per runtimeId on this host.
 * No Docker for the runtime itself (needs KVM/HVF; the orchestrator box is a
 * VM in prod, so the runtime manager must run on a KVM-capable worker).
 *
 * Env:
 *   ANDROID_SDK_ROOT   SDK root (emulator/, platform-tools/ inside)
 *   ANDROID_AVD_HOME   where AVDs live (defaults to ~/.android/avd)
 *   AVD_NAME           AVD name to boot for a runtime (default "rnp")
 *   WSSCRCPY_DIR       dir containing ws-scrcpy build (dist/index.js)
 *   WSSCRCPY_PORT_BASE first port for ws-scrcpy HTTP/WS (default 8010)
 *   ANDROID_RUNTIME_ALLOWED  "true" to enable the endpoints (default off)
 *   ANDROID_RUNTIME_STATE_FILE   session persistence path (default /tmp/rnp-android-runtimes.json)
 *   RNP_KEEP_AVD       "true" keeps AVD data on Stop (default) - quick-boot.
 */

export interface RuntimeInfo {
    runtimeId: string;
    status: 'starting' | 'ready' | 'stopping' | 'stopped' | 'error';
    avdName: string;
    adbSerial: string;
    wsScrcpyPort?: number | undefined;
    streamUrl?: string | undefined;   // deep link for the embedded panel iframe
    display?: { width: number; height: number } | undefined; // main display px (wm size); input mapping target
    error?: string | undefined;
    startedAt?: number | undefined;
}

interface RuntimeInternals extends RuntimeInfo {
    emulatorProc?: ChildProcess | undefined;
    scrcpyProc?: ChildProcess | undefined;
    bootWaitAbort?: AbortController | undefined;
    /** serializes `adb shell input` invocations (they must not interleave) */
    inputQueue: Promise<unknown>;
    controlSockets: Set<WebSocket>;
    /** passthrough to the spawned emulator (state file) */
    emuArgs?: string[] | undefined;
    /** last ControlSocket disconnect (drives the idle stop timer) */
    idleSince?: number | undefined;
}

const SDK_ROOT = process.env.ANDROID_SDK_ROOT || `${process.env.HOME}/Library/Android/sdk`;
const AVD_NAME = process.env.AVD_NAME || 'rnp';
const WSSCRCPY_DIR = process.env.WSSCRCPY_DIR || '/tmp/ws-scrcpy/dist';
const WSSCRCPY_PORT_BASE = Number(process.env.WSSCRCPY_PORT_BASE || 8010);
const BOOT_TIMEOUT_MS = 300_000; // first boot of a fresh AVD can be slow
const ADB = `${SDK_ROOT}/platform-tools/adb`;
// The emulator binary does not have to live in the SDK: a standalone canary
// build works fine (adb is what matters from the SDK). Override explicitly.
const EMULATOR = process.env.ANDROID_EMULATOR_BIN || `${SDK_ROOT}/emulator/emulator`;

const runtimes = new Map<string, RuntimeInternals>();
let nextScrcpyPort = WSSCRCPY_PORT_BASE;

/**
 * ws-scrcpy has NO --port CLI flag. Its port comes from a config file
 * (JSON/YAML) pointed at by the WS_SCRCPY_CONFIG env var (see
 * ws-scrcpy/src/server/EnvName.ts + Config.ts). Unrecognised argv is
 * silently ignored, which would make every instance bind the default
 * :8000 and collide. So: one temp config file per instance.
 */
function scrcpyConfigPath(port: number): string {
    return path.join(os.tmpdir(), `rnp-wsscrcpy-${port}.json`);
}

function sh(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
        const p = spawn(cmd, args);
        let out = '', err = '';
        const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out, err }); });
        p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    });
}

/** Ask adb for a free emulator console port pair (5554+2n). */
async function findFreeAdbSerial(): Promise<string> {
    const { out } = await sh(ADB, ['devices']);
    const used = new Set(
        out.split('\n')
            .map((l) => l.trim().split(/\s+/)[0] || '')
            .filter((s) => /^emulator-\d+$/.test(s)),
    );
    for (let port = 5554; port <= 5684; port += 2) {
        const serial = `emulator-${port}`;
        if (!used.has(serial)) return serial;
    }
    throw new Error('No free emulator adb ports (5554-5684 range exhausted)');
}

async function waitPortFree(host: string, port: number, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const free = await new Promise<boolean>((resolve) => {
            const s = net.connect(port, host);
            s.on('connect', () => { s.destroy(); resolve(false); });
            s.on('error', () => resolve(true));
        });
        if (free) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

async function waitBooted(serial: string, proc: ChildProcess, timeoutMs = BOOT_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // Fail fast: a second emulator on the same AVD dies instantly on the
        // AVD lockfile ("run two emulators on one avd is not allowed").
        if (proc.exitCode !== null || proc.signalCode !== null) {
            throw new Error(
                `emulator for ${serial} exited immediately (code ${proc.exitCode}, signal ${proc.signalCode}). ` +
                `Common cause: AVD already in use by another emulator, or bad AVD name. log tail: ${tailFile(emuLogPath(serial), 1024) || 'empty'}`,
            );
        }
        const r = await sh(ADB, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], 10_000);
        if (r.code === 0 && r.out.trim() === '1') return;
        await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`Emulator ${serial} did not finish booting within ${timeoutMs}ms`);
}

function emuLogPath(serial: string): string {
    return `${os.tmpdir()}/rnp-emu-${serial}.log`;
}

/** Last maxBytes of a log file, '' if unreadable. */
function tailFile(p: string, maxBytes: number): string {
    try {
        const fd = openSync(p, 'r');
        try {
            const size = fstatSync(fd).size;
            const len = Math.min(maxBytes, size);
            const buf = Buffer.alloc(len);
            const bytes = readSync(fd, buf, 0, len, size - len);
            return buf.subarray(0, bytes).toString('utf8').trim();
        } finally { closeSync(fd); }
    } catch { return ''; }
}

async function startScrcpy(rt: RuntimeInternals): Promise<void> {
    if (!existsSync(`${WSSCRCPY_DIR}/index.js`)) {
        throw new Error(`ws-scrcpy build not found at ${WSSCRCPY_DIR} (set WSSCRCPY_DIR)`);
    }
    let port = nextScrcpyPort;
    nextScrcpyPort = nextScrcpyPort >= WSSCRCPY_PORT_BASE + 90 ? WSSCRCPY_PORT_BASE : nextScrcpyPort + 1;
    if (!(await waitPortFree('127.0.0.1', port, 1))) port = await newPortFallback(port);

    const cfgPath = scrcpyConfigPath(port);
    writeFileSync(cfgPath, JSON.stringify({ server: [{ secure: false, port }] }));
    // File stdio, same SIGPIPE rationale as the emulator spawn above.
    const scrcLogPath = `${os.tmpdir()}/rnp-scrcpy-${port}.log`;
    const scrcFd = openSync(scrcLogPath, 'a');
    const proc = spawn('node', ['index.js'], {
        cwd: WSSCRCPY_DIR,
        env: { ...process.env, WS_SCRCPY_CONFIG: cfgPath },
        stdio: ['ignore', scrcFd, scrcFd],
    });
    closeSync(scrcFd);
    rt.scrcpyProc = proc;
    rt.wsScrcpyPort = port;
    // ws-scrcpy logs readiness to its log file; poll the HTTP port instead.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const up = await new Promise<boolean>((resolve) => {
            const s = net.connect(port, '127.0.0.1');
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('error', () => resolve(false));
        });
        if (up) return;
        if (proc.exitCode !== null) throw new Error(`ws-scrcpy exited early with code ${proc.exitCode}: ${tailFile(scrcLogPath, 1024) || 'no stderr'}`);
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`ws-scrcpy did not listen on :${port} within 30s: ${tailFile(scrcLogPath, 1024) || 'no stderr'} (log: ${scrcLogPath})`);
}

async function newPortFallback(preferred: number): Promise<number> {
    for (let p = preferred; p < preferred + 90; p++) {
        if (await waitPortFree('127.0.0.1', p, 1)) return p;
    }
    throw new Error('No free ws-scrcpy port in range');
}

/**
 * Public API used by the orchestrator routes.
 */

/**
 * Thrown by startRuntime when another runtime already holds the requested
 * AVD. Fast, actionable conflict (HTTP 409) instead of waiting ~seconds for
 * the second emulator to die on the AVD lockfile.
 */
export class AvdBusyError extends Error {
    constructor(public avdName: string, public busyRuntimeId: string) {
        super(`AVD ${avdName} is already in use by runtime ${busyRuntimeId}`);
    }
}

/**
 * One runtime per AVD: check in-memory runtimes AND persisted 'live' records
 * (the latter covers runtimeIds this process has not re-adopted yet).
 */
function findAvdBusy(avdName: string, excludeRuntimeId: string): string | undefined {
    for (const [id, rt] of runtimes) {
        if (id !== excludeRuntimeId && rt.avdName === avdName && (rt.status === 'ready' || rt.status === 'starting')) return id;
    }
    for (const [id, ses] of SESSIONS) {
        if (id !== excludeRuntimeId && ses.kind === 'live' && ses.avdName === avdName && pidAlive(ses.emuPid)) return id;
    }
    return undefined;
}

/**
 * Boot failures, kept after the failed runtime is torn down so a polling
 * client (GET /android/runtime/:id) can see why instead of a bare 404.
 */
const lastErrors = new Map<string, { avdName: string; error: string }>();

/**
 * Returns at once with status 'starting'; the boot (up to BOOT_TIMEOUT_MS)
 * runs in the background and clients poll getRuntime. A request held open
 * for the whole boot would outlive proxy timeouts (Cloudflare cuts at 100s).
 */
export function startRuntime(runtimeId: string, avdName = AVD_NAME): RuntimeInfo {
    const exists = runtimes.get(runtimeId);
    if (exists && (exists.status === 'ready' || exists.status === 'starting')) {
        return getRuntime(runtimeId) as RuntimeInfo;
    }
    const busy = findAvdBusy(avdName, runtimeId);
    if (busy) throw new AvdBusyError(avdName, busy);
    lastErrors.delete(runtimeId);

    let rt = exists;
    if (rt) {
        // Retry after the emulator died: its ws-scrcpy is still running.
        rt.scrcpyProc?.kill('SIGTERM');
        if (rt.wsScrcpyPort) unlinkSyncSafe(scrcpyConfigPath(rt.wsScrcpyPort));
        rt.emulatorProc = undefined;
        rt.scrcpyProc = undefined;
        rt.wsScrcpyPort = undefined;
        rt.streamUrl = undefined;
        rt.status = 'starting';
        rt.error = undefined;
    } else {
        rt = {
            runtimeId,
            status: 'starting',
            avdName,
            adbSerial: '', // picked in startRuntimeInner
            startedAt: Date.now(),
            inputQueue: Promise.resolve(),
            controlSockets: new Set(),
        };
        runtimes.set(runtimeId, rt);
    }
    void boot(rt);
    return getRuntime(runtimeId) as RuntimeInfo;
}

async function boot(rt: RuntimeInternals): Promise<void> {
    try {
        persistSession(rt);
        await startRuntimeInner(rt);
        persistSession(rt);
    } catch (e: any) {
        if (rt.status === 'stopping') return; // stopped mid-boot, not a failure
        const error = String(e?.message || e);
        console.error(`[AndroidRuntime] ${rt.runtimeId} boot failed:`, error);
        await stopRuntime(rt.runtimeId).catch(() => {});
        lastErrors.set(rt.runtimeId, { avdName: rt.avdName, error });
    }
}

async function startRuntimeInner(rt: RuntimeInternals): Promise<void> {
    if (!existsSync(EMULATOR)) throw new Error(`emulator binary not found at ${EMULATOR} (set ANDROID_EMULATOR_BIN)`);

    const serial = rt.adbSerial || await findFreeAdbSerial();
    rt.adbSerial = serial;
    const emulatorArgs = [
        '-avd', rt.avdName,
        '-port', serial.replace('emulator-', ''),
        '-no-window', '-no-boot-anim', '-gpu', 'swiftshader_indirect',
    ];
    rt.emuArgs = emulatorArgs;
    // Child logs go to FILES, never pipes: after an orchestrator restart the
    // emulator/ws-scrcpy are intentionally re-parented orphans (adoption
    // depends on them surviving), and a pipe whose read end died means the
    // child's next log write raises SIGPIPE and kills it. A file fd keeps
    // working; tail it for diagnostics (see procSpawnError).
    const logPath = emuLogPath(serial);
    const emuFd = openSync(logPath, 'a');
    // Audio off in server contexts; keep snapshots ON (default) so resume
    // is fast on restart. Prod images may add -no-snapshot.
    rt.emulatorProc = spawn(EMULATOR, emulatorArgs, { stdio: ['ignore', emuFd, emuFd] });
    closeSync(emuFd); // the child holds its own dup; ours is only for spawn

    rt.emulatorProc.on('exit', (code) => {
        if (rt.status === 'stopping') return;
        rt.status = 'error';
        rt.error = `emulator exited unexpectedly (code ${code}); log: ${logPath}`;
        persistSession(rt);
    });

    await waitBooted(serial, rt.emulatorProc);
    rt.display = await queryDisplaySize(serial);
    await ensureScrcpyServer(serial);
    await startScrcpy(rt);
    // Stop landed mid-boot: stopRuntime already ran, so this ws-scrcpy is ours to kill.
    if (rt.status === 'stopping') {
        rt.scrcpyProc?.kill('SIGTERM');
        throw new Error('stopped during boot');
    }

    rt.status = 'ready';
    rt.streamUrl = `http://localhost:${rt.wsScrcpyPort}/#!action=stream&udid=${rt.adbSerial}` +
        `&ws=${encodeURIComponent(`ws://localhost:${rt.wsScrcpyPort}/?action=proxy-adb&remote=tcp:8886&udid=${rt.adbSerial}`)}` +
        `&player=WebCodecs`;
}

// ---- Session persistence (survives an orchestrator restart) ----
//
// The Android runtime is stateful: the emulator keeps user-visible state
// (installed apps, Chrome profile, files) in the AVD directory. In-memory
// registry only = orchestrator restart strands the user mid-session and
// orphans a running emulator. Two things make persistence work:
//
// 1. ADOPT  (record.live, processes still running after restart): the new
//    orchestrator process re-registers the runtime from PIDs and takes the
//    emulator + ws-scrcpy over AS-IS (no respawn); stream + control keep
//    working, and the panel reconnect gives a fresh control socket.
// 2. RESUME (record.exited, or live-but-processes-died): nothing to adopt;
//    the next start() for this user boots the SAME AVD, whose quick-boot
//    snapshot (written by the previous emulator at exit) restores the
//    previous Android state. That IS the resume: AVD data was never deleted.

type SessionKind = 'live' | 'exited';

interface PersistedSession {
    kind: SessionKind;
    runtimeId: string; // == `rt_${userId}`
    avdName: string;
    serial?: string | undefined;
    emuPid?: number | undefined;
    emuArgs?: string[] | undefined;
    scrcPid?: number | undefined;
    scrcPort?: number | undefined;
    display?: { width: number; height: number } | undefined;
    savedAt: number;
}

const RUNTIME_STATE_FILE = process.env.ANDROID_RUNTIME_STATE_FILE || path.join(os.tmpdir(), 'rnp-android-runtimes.json');
const IDLE_GRACE_MS = 45_000; // last control socket detach -> safe refresh window
const SESSIONS = new Map<string, PersistedSession>(); // runtimeId -> record
let idleBell: ReturnType<typeof setInterval> | null = null;

function readPersisted(): void {
    try {
        const raw = readFileSync(RUNTIME_STATE_FILE, 'utf8');
        const arr = JSON.parse(raw) as { sessions?: PersistedSession[] };
        for (const s of arr.sessions || []) {
            if (s && typeof s.runtimeId === 'string') SESSIONS.set(s.runtimeId, s);
        }
    } catch (e: any) {
        if (e?.code !== 'ENOENT') console.error('[AndroidRuntime] state file unreadable:', e?.message || e);
    }
}

/** Write the session file SYNCHRONOUSLY. There is no debounce on purpose:
 *  the write is tiny and infrequent, and the whole point is to survive a
 *  kill that lands right after a status transition (a debounced "live"
 *  record that never reached disk turns restart adoption into a downgrade
 *  and strands the user). */
function flushSessions(): void {
    try {
        writeFileSync(RUNTIME_STATE_FILE, JSON.stringify({ sessions: [...SESSIONS.values()] }, null, 2));
    } catch (e) {
        console.error('[AndroidRuntime] state file write failed:', String(e));
    }
}

function persistSession(rt: RuntimeInternals, forcedKind?: SessionKind): void {
    const kind: SessionKind = forcedKind ?? (rt.emulatorProc ? 'live' : 'exited');
    const rec: PersistedSession = {
        kind: rt.status === 'error' || rt.status === 'stopped' ? 'exited' : kind,
        runtimeId: rt.runtimeId,
        avdName: rt.avdName,
        serial: rt.adbSerial || undefined,
        emuPid: rt.emulatorProc?.pid ?? undefined,
        emuArgs: rt.emuArgs,
        scrcPid: rt.scrcpyProc?.pid ?? undefined,
        scrcPort: rt.wsScrcpyPort,
        display: rt.display,
        savedAt: Date.now(),
    };
    SESSIONS.set(rec.runtimeId, rec);
    flushSessions();
}

/** Process liveness via signal-0 (same user; re-parented orphans count). */
function pidAlive(pid?: number): boolean {
    if (!pid || pid <= 1) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Extract the value after `-avd` from a ps command line split into args. */
function avdFromArgs(args: string[] | undefined): string {
    if (!args?.length) return '';
    const i = args.lastIndexOf('-avd');
    return i >= 0 && i + 1 < args.length ? (args[i + 1] ?? '') : '';
}

/** One-shot sync scan for live emulator processes (boot time only). */
function listEmulatorProcesses(): { pid: number; args: string[] }[] {
    const out: { pid: number; args: string[] }[] = [];
    try {
        const res = spawnSync('ps', ['-A', '-o', 'pid=,command=', '-ww'], { encoding: 'utf8' });
        if (res.status !== 0 || !res.stdout) return out;
        for (const line of res.stdout.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\S+)(.*)$/);
            if (!m) continue;
            const cmdPath = m[2] ?? '';
            const rest = m[3] ?? '';
            const base = path.basename(cmdPath);
            // qemu-system-<arch> covers x86_64 AND aarch64 (this AVD is arm64);
            // 'emulator' catches the launcher while it is still the exec'd
            // binary on some platforms.
            if (!/^qemu-system-/.test(base) && base !== 'emulator') continue;
            // args after the binary, shell-ish split (args contain no quotes)
            const args = rest.trim().length ? rest.trim().split(/\s+/) : [];
            out.push({ pid: Number(m[1]), args });
        }
    } catch { /* boot reconciliation is best-effort */ }
    return out;
}

/**
 * Adopt-at-boot: read the state file, reconcile each 'live' record with the
 * real process list, re-register live runtimes, downgrade the rest. The ps
 * scan is sync; at boot nothing else races us. Called once by the orchestrator
 * BEFORE listen() so no request can hit a half-initialized registry.
 */
export function initAndroidRuntime(): void {
    startIdleBell();
    readPersisted();
    if (!SESSIONS.size) return;
    const procs = listEmulatorProcesses();
    for (const ses of SESSIONS.values()) {
        if (ses.kind !== 'live') continue;
        const emu = ses.emuPid ? procs.find((p) => p.pid === ses.emuPid) : undefined;
        if (!emu || avdFromArgs(emu.args) !== ses.avdName) {
            ses.kind = 'exited';
            ses.emuPid = undefined;
            ses.emuArgs = undefined;
            ses.scrcPid = undefined;
            ses.scrcPort = undefined;
            console.log(`[AndroidRuntime] ${ses.runtimeId}: recorded live but emulator gone -> exited (AVD data kept for resume)`);
            continue;
        }
        if (!pidAlive(ses.scrcPid) || !ses.scrcPort) {
            ses.kind = 'exited';
            ses.scrcPid = undefined;
            ses.scrcPort = undefined;
            // Emulator alive but its stream process died: do NOT kill the
            // emulator; the idle-health check below will own it from here.
            console.log(`[AndroidRuntime] ${ses.runtimeId}: ws-scrcpy gone -> exited (emulator left running by health check)`);
            continue;
        }
        const rt: RuntimeInternals = {
            runtimeId: ses.runtimeId,
            status: 'ready',
            avdName: ses.avdName,
            adbSerial: ses.serial || '',
            wsScrcpyPort: ses.scrcPort,
            display: ses.display,
            startedAt: ses.savedAt,
            inputQueue: Promise.resolve(),
            controlSockets: new Set(),
            idleSince: Date.now(), // no client re-attached yet; grace timer runs
        };
        runtimes.set(ses.runtimeId, rt);
        console.log(`[AndroidRuntime] adopted ${ses.runtimeId} (user ${ses.runtimeId.slice(3)}): emulator pid ${ses.emuPid} on ${ses.serial}, ws-scrcpy pid ${ses.scrcPid} on :${ses.scrcPort}`);
        verifyAdopted(rt, ses);
    }
    flushSessions();
}

/**
 * Adopted sessions verify reachability asynchronously: if the streamed port
 * no longer answers (port stolen during downtime, etc.), retire the runtime
 * but leave the emulator running - the user's next start() adopts or, at
 * worst, replaces the dead ws-scrcpy.
 */
async function verifyAdopted(rt: RuntimeInternals, ses: PersistedSession): Promise<void> {
    const ok = await portListening(ses.scrcPort as number, 5_000);
    if (ok) return;
    rt.status = 'error';
    rt.error = 'adopted ws-scrcpy port stopped answering after restart';
    runtimes.delete(rt.runtimeId);
    SESSIONS.set(rt.runtimeId, { ...ses, kind: 'exited', scrcPid: undefined, scrcPort: undefined, savedAt: Date.now() });
    flushSessions();
    console.log(`[AndroidRuntime] adopted ${rt.runtimeId}: stream port ${ses.scrcPort} dead -> session exited (emulator untouched)`);
}

async function portListening(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise<boolean>((resolve) => {
            const s = net.connect(port, '127.0.0.1');
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('error', () => resolve(false));
        });
        if (ok) return true;
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}

/**
 * Idle reaper: a runtime whose panel gone for IDLE_GRACE_MS gets a clean
 * stop (quick-boot snapshot + AVD data kept); when the student returns,
 * start() resumes into the same Android state. Only adopted sessions start
 * their grace window at boot (a fresh start boots because a client asked
 * for it - its socket attaches within the first tick anyway).
 */
function startIdleBell(): void {
    if (idleBell) return;
    idleBell = setInterval(() => {
        const now = Date.now();
        for (const rt of [...runtimes.values()]) {
            if (rt.status === 'stopping' || rt.status === 'stopped') continue;
            // The panel only opens its control socket once the runtime is ready,
            // so a boot (35-65s on EC2) must not count as idle time.
            if (rt.controlSockets.size > 0 || rt.status === 'starting') {
                rt.idleSince = undefined;
                continue;
            }
            if (rt.idleSince === undefined) rt.idleSince = now;
            if (now - rt.idleSince > IDLE_GRACE_MS) {
                console.log(`[AndroidRuntime] ${rt.runtimeId}: no client for ${IDLE_GRACE_MS}ms -> stopping (AVD ${rt.avdName} data + snapshots kept)`);
                void stopRuntime(rt.runtimeId).catch((e) => console.error(`[AndroidRuntime] idle stop ${rt.runtimeId} failed:`, String(e?.message || e)));
            }
        }
    }, 5_000);
    idleBell.unref?.();
}

export async function stopRuntime(runtimeId: string): Promise<RuntimeInfo> {
    const rt = runtimes.get(runtimeId);
    // Unknown runtime: still degrade the session record so persistence never
    // advertises a runtime the API cannot see (and a stale record cannot make
    // startRuntime return a phantom).
    if (!rt) {
        const ses = SESSIONS.get(runtimeId);
        if (ses && ses.kind === 'live') {
            SESSIONS.set(runtimeId, { ...ses, kind: 'exited', emuPid: undefined, emuArgs: undefined, scrcPid: undefined, scrcPort: undefined, savedAt: Date.now() });
            flushSessions();
        }
        throw new Error(`Unknown runtime ${runtimeId}`);
    }
    rt.status = 'stopping';
    for (const sock of rt.controlSockets) {
        try { sock.close(1001, 'runtime stopped'); } catch { /* already closed */ }
    }
    rt.controlSockets.clear();
    rt.idleSince = undefined;
    if (rt.wsScrcpyPort) unlinkSyncSafe(scrcpyConfigPath(rt.wsScrcpyPort));
    // Adopted runtimes have no ChildProcess handles; their pids live in the session record.
    const ses = SESSIONS.get(runtimeId);
    if (rt.scrcpyProc) rt.scrcpyProc.kill('SIGTERM');
    else if (ses?.scrcPid && pidAlive(ses.scrcPid)) process.kill(ses.scrcPid, 'SIGTERM');
    if (rt.adbSerial) {
        // Clean the guest before the quick-boot snapshot is written, or the stale
        // scrcpy server comes back on next boot holding tcp:8886.
        await sh(ADB, ['-s', rt.adbSerial, 'shell', 'pkill', '-f', 'scrcpy'], 5_000);
        // Graceful first (emu kill writes the quick-boot snapshot so the NEXT
        // start resumes into this Android state), then hard kill as fallback.
        const emuKill = await sh(ADB, ['-s', rt.adbSerial, 'emu', 'kill'], 10_000);
        if (emuKill.code !== 0) {
            if (rt.emulatorProc) rt.emulatorProc.kill('SIGTERM');
            else if (ses?.emuPid && pidAlive(ses.emuPid)) process.kill(ses.emuPid, 'SIGTERM');
        }
    } else {
        rt.emulatorProc?.kill('SIGTERM');
    }
    runtimes.delete(runtimeId);
    persistSession(rt, 'exited');
    const { emulatorProc: _e, scrcpyProc: _s, bootWaitAbort: _a, inputQueue: _q, controlSockets: _c, emuArgs: _g, idleSince: _i, ...info } = rt;
    return { ...info, status: 'stopped' };
}

function unlinkSyncSafe(p: string): void {
    try { unlinkSync(p); } catch { /* already gone */ }
}

export function getRuntime(runtimeId: string): RuntimeInfo | undefined {
    const rt = runtimes.get(runtimeId);
    if (!rt) {
        const failed = lastErrors.get(runtimeId);
        return failed && { runtimeId, status: 'error', avdName: failed.avdName, adbSerial: '', error: failed.error };
    }
    const { emulatorProc: _e, scrcpyProc: _s, inputQueue: _q, controlSockets: _c, emuArgs: _g, idleSince: _i, ...info } = rt;
    return info;
}

export function listRuntimes(): RuntimeInfo[] {
    return [...runtimes.values()].map((rt) => {
        const { emulatorProc: _e, scrcpyProc: _s, inputQueue: _q, controlSockets: _c, emuArgs: _g, idleSince: _i, ...info } = rt;
        return info;
    });
}

const SCRCPY_SERVER_JAR = `${WSSCRCPY_DIR}/vendor/Genymobile/scrcpy/scrcpy-server.jar`;
// Must match ws-scrcpy's own launch (src/common/Constants.ts -> ARGS_STRING):
// version 1.19-ws8, type web, log ERROR, port 8886, listen-on-all-interfaces,
// with the redirect so `adb shell` returns immediately instead of holding the
// socket open (that is what keeps nohup'd children detached).
const SCRCPY_RUN_CMD =
    'CLASSPATH=/data/local/tmp/scrcpy-server.jar nohup app_process / ' +
    'com.genymobile.scrcpy.Server 1.19-ws8 web ERROR 8886 true 2>&1 > /dev/null';

/**
 * The deep-link stream (action=stream & proxy-adb) only TUNNELS to guest
 * tcp:8886; nothing starts the scrcpy server for a direct-connect client.
 * So the runtime manager starts it itself, the same way ws-scrcpy's
 * DeviceTracker does (ScrcpyServer.run): push jar, launch, wait for the pid
 * file it writes once its guest WebSocket server is listening.
 */
async function ensureScrcpyServer(serial: string): Promise<void> {
    if (!existsSync(SCRCPY_SERVER_JAR)) {
        throw new Error(`scrcpy-server.jar not found at ${SCRCPY_SERVER_JAR} (set WSSCRCPY_DIR)`);
    }
    // 1. Clear any stale server + stale pid file (quick-boot snapshots can
    //    resurrect a server holding tcp:8886, which wedges the fresh stream).
    await sh(ADB, ['-s', serial, 'shell', 'pkill -f scrcpy; rm -f /data/local/tmp/ws_scrcpy.pid'], 10_000);
    // 2. Push the exact jar the ws-scrcpy build vendors.
    const push = await sh(ADB, ['-s', serial, 'push', SCRCPY_SERVER_JAR, '/data/local/tmp/scrcpy-server.jar'], 30_000);
    if (push.code !== 0) throw new Error(`adb push scrcpy-server.jar failed: ${push.err || push.out}`);
    // 3. Launch detached in the guest.
    await sh(ADB, ['-s', serial, 'shell', SCRCPY_RUN_CMD], 15_000);
    // 4. Wait for readiness: the server writes the pid file only after its
    //    guest WS server is up (see ws-scrcpy ScrcpyServer.waitForServerPid).
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const pid = await sh(ADB, ['-s', serial, 'shell', 'cat /data/local/tmp/ws_scrcpy.pid 2>/dev/null'], 5_000);
        if (pid.code === 0 && pid.out.trim()) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('scrcpy server in guest did not become ready within 20s (no pid file)');
}

// ---- Control relay (browser -> adb input) ----
//
// The ws-scrcpy fork's guest server (1.19-ws8) has a dead Controller on
// Android 14 (IClipboard AIDL, upstream scrcpy #4285) - video works but
// scrcpy touch injection silently drops everything. The orchestrator owns
// control over adb:
//
//   client sends normalized coords (0..1 of the streamed picture)
//   -> mapped onto the main display (`wm size`)
//   -> `adb shell input tap/swipe/text/keyevent`

export interface ControlRequest {
    type: 'tap' | 'swipe' | 'text' | 'key';
    id?: string;         // echoed back in ack/error
    x?: number;          // tap: normalized 0..1 (device px when abs)
    y?: number;
    x1?: number; y1?: number; x2?: number; y2?: number; // swipe (normalized)
    durationMs?: number; // swipe duration, default 300
    text?: string;       // printable ASCII, <= 500 chars
    key?: string;        // friendly name, KEYCODE_* or numeric keycode
    abs?: boolean;       // interpret coordinates as device px (debug)
}

export type ControlResult = { ok: true } | { ok: false; error: string };

const KEY_CODES: Record<string, number> = {
    HOME: 3, BACK: 4, MENU: 82, ENTER: 66, DEL: 67, FORWARD_DEL: 112,
    POWER: 26, VOLUME_UP: 24, VOLUME_DOWN: 25, VOLUME_MUTE: 164,
    TAB: 61, ESCAPE: 111,
    DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
    APP_SWITCH: 187, WAKEUP: 224, SLEEP: 223,
};

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function toDevicePx(v: number, dim: number, abs?: boolean): number {
    return abs ? Math.round(clamp(v, 0, dim)) : Math.round(clamp(v, 0, 1) * dim);
}

/**
 * `adb shell` joins argv and re-parses on the device with sh, so the text must
 * survive a shell parse. Restrict to printable ASCII, encode spaces as %s
 * (what `input text` expects), single-quote with '\'' escaping.
 */
function sanitizeInputText(text: string): string | null {
    if (typeof text !== 'string' || !text.length || text.length > 500) return null;
    const cleaned = text.replace(/[\r\n]+/g, ' ');
    if (!/^[\x20-\x7E]+$/.test(cleaned)) return null;
    return "'" + cleaned.replace(/ /g, '%s').replace(/'/g, "'\\''") + "'";
}

function validateAndBuild(rt: RuntimeInternals, req: ControlRequest): { args?: string[]; error?: string } {
    const disp = rt.display;
    if (!disp) return { error: 'runtime display size unknown' };
    switch (req.type) {
        case 'tap': {
            const x = num(req.x); const y = num(req.y);
            if (x === null || y === null) return { error: 'tap needs numeric x,y (normalized 0..1)' };
            return { args: ['input', 'tap', String(toDevicePx(x, disp.width, req.abs)), String(toDevicePx(y, disp.height, req.abs))] };
        }
        case 'swipe': {
            const x1 = num(req.x1); const y1 = num(req.y1);
            const x2 = num(req.x2); const y2 = num(req.y2);
            if (x1 === null || y1 === null || x2 === null || y2 === null) {
                return { error: 'swipe needs numeric x1,y1,x2,y2 (normalized 0..1)' };
            }
            const dur = Math.round(clamp(num(req.durationMs) ?? 300, 50, 10_000));
            return {
                args: [
                    'input', 'swipe',
                    String(toDevicePx(x1, disp.width, req.abs)), String(toDevicePx(y1, disp.height, req.abs)),
                    String(toDevicePx(x2, disp.width, req.abs)), String(toDevicePx(y2, disp.height, req.abs)),
                    String(dur),
                ],
            };
        }
        case 'text': {
            const esc = sanitizeInputText(req.text ?? '');
            if (!esc) return { error: 'text must be 1-500 printable ASCII chars, no newlines' };
            return { args: ['input', 'text', esc] };
        }
        case 'key': {
            const k = req.key;
            let code: string | undefined;
            if (typeof k === 'string' && k in KEY_CODES) code = String(KEY_CODES[k]);
            else if (typeof k === 'string' && /^KEYCODE_[A-Z0-9_]+$/.test(k)) code = k;
            else if (typeof k === 'string' && /^\d+$/.test(k)) code = k;
            if (!code) {
                return { error: `unknown key ${String(k)}: use one of ${Object.keys(KEY_CODES).join(', ')}, KEYCODE_*, or a numeric keycode` };
            }
            return { args: ['input', 'keyevent', code] };
        }
        default:
            return { error: `unsupported control type ${String((req as { type?: unknown }).type)}` };
    }
}

export async function handleControl(runtimeId: string, raw: unknown): Promise<ControlResult> {
    const rt = runtimes.get(runtimeId);
    if (!rt) return { ok: false, error: 'unknown runtime' };
    if (rt.status !== 'ready') return { ok: false, error: `runtime not ready (status: ${rt.status})` };
    const req = raw as ControlRequest;
    if (!req || typeof req !== 'object' || typeof req.type !== 'string') {
        return { ok: false, error: 'control message must be an object with a string type' };
    }
    const built = validateAndBuild(rt, req);
    if (built.error || !built.args) return { ok: false, error: built.error || 'invalid control message' };
    const args = built.args;

    // Serialize per runtime: overlapping `input` invocations produce garbage
    // gestures (two interleaved swipes, etc.).
    let result!: ControlResult;
    rt.inputQueue = rt.inputQueue
        .then(async () => {
            const r = await sh(ADB, ['-s', rt.adbSerial, 'shell', ...args], 10_000);
            result = r.code === 0
                ? { ok: true }
                : { ok: false, error: `adb ${args[1]} failed (code ${r.code}): ${(r.err || r.out).trim() || 'no output'}` };
        })
        .catch((e) => { result = { ok: false, error: String(e?.message || e) }; });
    await rt.inputQueue;
    return result;
}

/**
 * Input injection targets the MAIN display; `wm size` reports it. Prefer
 * "Override size" when present (that is what the UI actually runs at).
 */
async function queryDisplaySize(serial: string): Promise<{ width: number; height: number }> {
    const r = await sh(ADB, ['-s', serial, 'shell', 'wm', 'size'], 10_000);
    if (r.code !== 0) throw new Error(`wm size failed: ${(r.err || r.out).trim()}`);
    const pick = (label: string) => r.out.match(new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`));
    const m = pick('Override') || pick('Physical');
    if (!m) throw new Error(`unparseable wm size output: ${r.out.trim()}`);
    return { width: Number(m[1]), height: Number(m[2]) };
}

export function attachControlSocket(runtimeId: string, sock: WebSocket): boolean {
    const rt = runtimes.get(runtimeId);
    if (!rt) return false;
    rt.controlSockets.add(sock);
    rt.idleSince = undefined; // someone is here again
    return true;
}

export function detachControlSocket(runtimeId: string, sock: WebSocket): void {
    const rt = runtimes.get(runtimeId);
    if (!rt) return;
    rt.controlSockets.delete(sock);
    if (rt.controlSockets.size === 0 && rt.status === 'ready') {
        rt.idleSince = Date.now(); // grace window starts (refresh tolerance)
    }
}
