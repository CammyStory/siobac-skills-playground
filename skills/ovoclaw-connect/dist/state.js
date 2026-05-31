import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
export const STATE_DIR = join(homedir(), '.ovoclaw-connect');
export const STATE_FILE = join(STATE_DIR, 'sessions.json');
const DIR = STATE_DIR;
const FILE = STATE_FILE;
async function readAll() {
    try {
        const raw = await fs.readFile(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return {};
        throw e;
    }
}
// Session handles are always s_ + 16 lowercase hex chars. We reject anything
// else as input to guard against (a) prototype-chain access via keys like
// "__proto__" / "constructor" and (b) accidental confusion with arbitrary
// user-supplied strings.
const HANDLE_RE = /^s_[0-9a-f]{16}$/;
function isValidHandle(handle) {
    return HANDLE_RE.test(handle);
}
async function writeAll(data) {
    await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
    // mkdir's mode flag is only honored when the directory is created. If the
    // directory pre-existed with looser perms (e.g. 0755), the flag is a no-op
    // and the file would be world-readable through its parent. Force the mode.
    // Same logic for the file below: writeFile's mode flag is only applied on
    // initial create. chmod ensures the perms after every write. Best-effort
    // on platforms where chmod is a no-op (Windows).
    try {
        await fs.chmod(DIR, 0o700);
    }
    catch { }
    await fs.writeFile(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
        await fs.chmod(FILE, 0o600);
    }
    catch { }
}
export async function saveSession(s) {
    if (!isValidHandle(s.handle)) {
        throw new Error(`saveSession: invalid handle ${JSON.stringify(s.handle)}`);
    }
    const all = await readAll();
    all[s.handle] = s;
    await writeAll(all);
}
export async function getSession(handle) {
    if (!isValidHandle(handle))
        return null;
    const all = await readAll();
    // Object.hasOwn avoids returning Object.prototype if someone reaches
    // through the handle-validation guard somehow.
    return Object.prototype.hasOwnProperty.call(all, handle) ? all[handle] : null;
}
export async function listSessions() {
    const all = await readAll();
    // Only return entries whose key matches the expected handle shape, in case
    // sessions.json was hand-edited with junk keys.
    return Object.entries(all)
        .filter(([k]) => isValidHandle(k))
        .map(([, v]) => v);
}
export async function deleteSession(handle) {
    if (!isValidHandle(handle))
        return;
    const all = await readAll();
    if (!Object.prototype.hasOwnProperty.call(all, handle))
        return;
    delete all[handle];
    await writeAll(all);
}
export async function updateSession(handle, patch) {
    if (!isValidHandle(handle))
        return null;
    const all = await readAll();
    if (!Object.prototype.hasOwnProperty.call(all, handle))
        return null;
    const existing = all[handle];
    all[handle] = { ...existing, ...patch };
    await writeAll(all);
    return all[handle];
}
export function newHandle() {
    return 's_' + randomBytes(8).toString('hex');
}
// ── Login-mode auth (registered connector) ────────────────────────────────
// Optional: present only when the user runs `login`. Guest mode never touches
// this. Stored separately from sessions.json. Mirrors the share skill's backup
// + self-heal so a skill update / corruption never forces a re-login.
export const AUTH_FILE = join(STATE_DIR, 'auth.json');
export const AUTH_BACKUP_FILE = join(STATE_DIR, 'auth.json.bak');
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
        // corrupt JSON — fall through so the caller can try the backup
    }
    return null;
}
export async function loadAuth() {
    const primary = await readAuthFrom(AUTH_FILE);
    if (primary)
        return primary;
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
    await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
    try {
        await fs.chmod(DIR, 0o700);
    }
    catch { }
    const json = JSON.stringify(auth, null, 2);
    await fs.writeFile(AUTH_FILE, json, { mode: 0o600 });
    try {
        await fs.chmod(AUTH_FILE, 0o600);
    }
    catch { }
    // Mirror to the backup so a lost/corrupt auth.json can self-heal on next load.
    try {
        await fs.writeFile(AUTH_BACKUP_FILE, json, { mode: 0o600 });
        try {
            await fs.chmod(AUTH_BACKUP_FILE, 0o600);
        }
        catch { }
    }
    catch { /* best-effort */ }
}
export async function clearAuth() {
    // Remove BOTH files so logout sticks (loadAuth would otherwise self-restore).
    for (const f of [AUTH_FILE, AUTH_BACKUP_FILE]) {
        try {
            await fs.unlink(f);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
}
