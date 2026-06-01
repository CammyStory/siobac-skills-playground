import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Owner-side state. Distinct directory from ovoclaw-connect's
// ~/.ovoclaw-connect/ so playground share state and playground
// connect state can coexist on the same machine without colliding.
export const STATE_DIR = join(homedir(), '.ovoclaw-share');
export const AUTH_FILE = join(STATE_DIR, 'auth.json');
// A mirror of auth.json written on every save. If auth.json is later lost or
// corrupted (e.g. an interrupted write, or a clumsy skill update), loadAuth
// transparently restores from this backup — so the user keeps their login
// instead of having to run `login` again.
export const AUTH_BACKUP_FILE = join(STATE_DIR, 'auth.json.bak');
// Which agent this skill last shared. Kept SEPARATE from auth.json so it
// survives logout / token expiry: on the next `login` we pass this id to the
// approval page as agent_hint, and it auto-confirms the same agent — so every
// re-share re-binds the same OvOclaw identity without the user re-choosing.
export const AGENT_FILE = join(STATE_DIR, 'agent.json');
const DIR = STATE_DIR;
const FILE = AUTH_FILE;
async function ensureDir() {
    await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
    try {
        await fs.chmod(DIR, 0o700);
    }
    catch { }
}
// Atomic write: temp file + rename (atomic on POSIX), so a reader never sees a
// half-written file and concurrent writers can't interleave bytes. Guards
// auth.json against corruption from an interrupted/parallel write — corruption
// there reads as "logged out" and forces a needless re-login.
async function writeFileAtomic(path, data) {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    try {
        await fs.chmod(tmp, 0o600);
    }
    catch { }
    try {
        await fs.rename(tmp, path);
    }
    catch {
        await fs.writeFile(path, data, { mode: 0o600 });
        try {
            await fs.chmod(path, 0o600);
        }
        catch { }
        try {
            await fs.unlink(tmp);
        }
        catch { }
    }
}
// Read + validate an auth file. Returns null for missing (ENOENT) or corrupt /
// malformed contents; rethrows only unexpected fs errors (e.g. permissions).
async function readAuthFrom(path) {
    let raw;
    try {
        raw = await fs.readFile(path, 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.accessToken === 'string') {
            return parsed;
        }
    }
    catch {
        // corrupt JSON — fall through to null so the caller can try the backup
    }
    return null;
}
export async function loadAuth() {
    const primary = await readAuthFrom(FILE);
    if (primary)
        return primary;
    // Primary missing or corrupt — recover from the backup and restore it so the
    // user stays logged in without re-running `login`.
    const backup = await readAuthFrom(AUTH_BACKUP_FILE);
    if (backup) {
        try {
            await saveAuth(backup);
        }
        catch { /* restore is best-effort */ }
        return backup;
    }
    return null;
}
export async function saveAuth(auth) {
    await ensureDir();
    const json = JSON.stringify(auth, null, 2);
    // Atomic so a refresh's rotated token always lands intact.
    await writeFileAtomic(FILE, json);
    // Mirror to the backup so a lost/corrupt auth.json can self-heal on next load.
    try {
        await writeFileAtomic(AUTH_BACKUP_FILE, json);
    }
    catch { /* backup is best-effort; never fail a login over it */ }
}
export async function clearAuth() {
    // Remove BOTH files — otherwise loadAuth would restore the login from the
    // backup and logout wouldn't stick.
    for (const f of [FILE, AUTH_BACKUP_FILE]) {
        try {
            await fs.unlink(f);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
}
export async function loadBoundAgent() {
    try {
        const raw = await fs.readFile(AGENT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.agentId === 'string') {
            return parsed;
        }
        return null;
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw e;
    }
}
export async function saveBoundAgent(agent) {
    await ensureDir();
    await fs.writeFile(AGENT_FILE, JSON.stringify(agent, null, 2), { mode: 0o600 });
    try {
        await fs.chmod(AGENT_FILE, 0o600);
    }
    catch { }
}
export async function isAuthFileWriteable() {
    try {
        await ensureDir();
        await fs.access(DIR, fsConstants.W_OK);
        return { ok: true };
    }
    catch (e) {
        return { ok: false, reason: e.message };
    }
}
// ── Auto-reply (owner side) state ──────────────────────────────────────────
// The owner's scheduled auto-reply. Stored once per install (the skill is bound
// to one agent). The actual answering runs in the platform scheduler; this is
// the on/off flag + status the owner can start/stop/check, and which the
// scheduled run reads (answer only while running) and updates: check-inbox
// stamps lastCheckedAt and respond bumps repliesSent — both only while running.
export const AUTOREPLY_FILE = join(STATE_DIR, 'autoreply.json');
export async function loadAutoReply() {
    try {
        const raw = await fs.readFile(AUTOREPLY_FILE, 'utf8');
        const p = JSON.parse(raw);
        if (p && typeof p === 'object' && (p.status === 'running' || p.status === 'off')) {
            return {
                status: p.status,
                startedAt: typeof p.startedAt === 'string' ? p.startedAt : undefined,
                lastCheckedAt: typeof p.lastCheckedAt === 'string' ? p.lastCheckedAt : undefined,
                repliesSent: typeof p.repliesSent === 'number' ? p.repliesSent : 0,
            };
        }
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    // No state on disk → OFF. "Auto-reply on by default" is materialised at LOGIN
    // (ensureAutoReplyDefaultOn writes a running state), NOT by this default — so a
    // logged-out / cleared state correctly reads as off, and logout (which deletes
    // this file) leaves auto-reply stopped until the next login turns it back on.
    return { status: 'off', repliesSent: 0 };
}
export async function saveAutoReply(state) {
    await ensureDir();
    await fs.writeFile(AUTOREPLY_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    try {
        await fs.chmod(AUTOREPLY_FILE, 0o600);
    }
    catch { }
}
// Stop + clear auto-reply state. Called on logout so the scheduled task halts
// (its next tick reads off and exits) and the next login re-enables the default.
export async function clearAutoReply() {
    try {
        await fs.unlink(AUTOREPLY_FILE);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
}
// On login, materialise the default-ON auto-reply state with a real startedAt —
// so `auto-reply-status` shows running (healthy lifecycle) right after login,
// tying "auto-reply is on" to login as the initial design. Only writes if the
// owner has never set it; an explicit prior stop (file exists) is respected.
export async function ensureAutoReplyDefaultOn() {
    try {
        await fs.access(AUTOREPLY_FILE);
        return; // already configured (running or explicitly off) — leave it
    }
    catch { /* absent → create the default-on state below */ }
    await saveAutoReply({ status: 'running', startedAt: new Date().toISOString(), repliesSent: 0 });
}
