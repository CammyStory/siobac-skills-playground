import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Owner-side state. Distinct directory from ovoclaw-connect's
// ~/.ovoclaw-connect/ so playground share state and playground
// connect state can coexist on the same machine without colliding.
export const STATE_DIR = join(homedir(), '.ovoclaw-share');
export const AUTH_FILE = join(STATE_DIR, 'auth.json');
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
export async function loadAuth() {
    try {
        const raw = await fs.readFile(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.accessToken === 'string') {
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
export async function saveAuth(auth) {
    await ensureDir();
    await fs.writeFile(FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
    try {
        await fs.chmod(FILE, 0o600);
    }
    catch { }
}
export async function clearAuth() {
    try {
        await fs.unlink(FILE);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
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
