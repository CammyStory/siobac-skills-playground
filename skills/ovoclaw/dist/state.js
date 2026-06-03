import { promises as fs, constants as fsConstants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
// Owner-side state lives under ~/.ovoclaw/. On a platform that runs MULTIPLE
// agents under one home, a single shared ~/.ovoclaw/auth.json would let one
// agent's login OVERWRITE another's — silently re-binding it to the wrong
// account (and then it never sees its own connect requests / messages).
//
// PER-AGENT ISOLATION via a LOCAL BINDING FILE. Every agent platform runs its
// agents in their OWN working directory, so we scope state by a `.ovoclaw.json`
// file in that working dir (found by walking cwd → up to $HOME). It holds only
// a NON-SECRET pointer { agent_key } — never tokens — and selects the private
// folder ~/.ovoclaw/agents/<agent_key>/ where auth/agent/sessions live. `login`
// and `connect` auto-create the file on first use, so two agents in two working
// dirs get two folders and can never touch each other's login. An explicit
// OVOCLAW_AGENT_KEY env var overrides the file; with NEITHER, we fall back to
// the shared ~/.ovoclaw default (single-agent installs, unchanged).
export const STATE_BASE = join(homedir(), '.ovoclaw');
// Where state lived before the skill was renamed ovoclaw-share → ovoclaw.
// migrateLegacyState() copies an existing login over on first run so users
// don't have to log in again after the rename.
export const LEGACY_STATE_BASE = join(homedir(), '.ovoclaw-share');
// The local per-working-directory pointer file (no secrets — just agent_key).
export const BINDING_FILENAME = '.ovoclaw.json';
function sanitizeKey(k) {
    return k.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
}
// Nearest .ovoclaw.json carrying a usable agent_key, walking cwd up to $HOME.
function findBindingFile() {
    const home = homedir();
    let d = process.cwd();
    for (let i = 0; i < 40; i++) {
        const candidate = join(d, BINDING_FILENAME);
        try {
            const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
            const key = sanitizeKey(String(parsed?.agent_key ?? '').trim());
            if (key)
                return { path: candidate, key };
        }
        catch { /* missing or malformed — keep walking up */ }
        if (d === home)
            break;
        const parent = dirname(d);
        if (parent === d)
            break;
        d = parent;
    }
    return null;
}
// Once resolved (or created) within a process the key is PINNED, so every
// command in the same run reads/writes the SAME folder — including the very run
// of `login` that just created the binding file.
let _pinnedKey = null;
function resolveAgentKey() {
    if (_pinnedKey !== null)
        return _pinnedKey;
    const env = (process.env.OVOCLAW_AGENT_KEY ?? '').trim();
    if (env)
        return sanitizeKey(env);
    const bf = findBindingFile();
    return bf ? bf.key : '';
}
function stateDirFor(key) {
    return key ? join(STATE_BASE, 'agents', key) : STATE_BASE;
}
// State dir for the current run (env key > local binding file > shared default).
export function stateDir() { return stateDirFor(resolveAgentKey()); }
// Resolve the per-agent binding. When `create` is true and nothing is bound yet,
// CREATE a fresh .ovoclaw.json in the current working directory so this agent
// gets its OWN isolated folder. login/connect pass create=true; read-only
// callers (doctor) pass false.
export async function ensureAgentBinding(create) {
    const env = (process.env.OVOCLAW_AGENT_KEY ?? '').trim();
    if (env) {
        const key = sanitizeKey(env);
        _pinnedKey = key;
        return { key, source: 'env', binding_file: null, state_dir: stateDirFor(key), created: false };
    }
    const found = findBindingFile();
    if (found) {
        _pinnedKey = found.key;
        return { key: found.key, source: 'local-file', binding_file: found.path, state_dir: stateDirFor(found.key), created: false };
    }
    if (!create) {
        _pinnedKey = '';
        return { key: '', source: 'default-shared', binding_file: null, state_dir: STATE_BASE, created: false };
    }
    // No binding yet → mint one in the CURRENT working directory. The key is a
    // readable cwd basename + a random suffix so it's both recognizable and unique.
    const base = (sanitizeKey(process.cwd().split(/[\\/]/).filter(Boolean).pop() || 'agent') || 'agent').slice(0, 24);
    const key = `${base}-${randomBytes(4).toString('hex')}`;
    const path = join(process.cwd(), BINDING_FILENAME);
    const body = {
        agent_key: key,
        created_at: new Date().toISOString(),
        note: "OvOclaw per-agent binding. Points to the private ~/.ovoclaw/agents/<agent_key>/ folder that holds THIS agent's login — contains no secrets. Keep one per agent working directory; delete to unbind.",
    };
    try {
        await fs.writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
        try {
            await fs.chmod(path, 0o600);
        }
        catch { }
        _pinnedKey = key;
        return { key, source: 'local-file', binding_file: path, state_dir: stateDirFor(key), created: true };
    }
    catch {
        // cwd not writable — degrade to the shared default rather than fail outright.
        _pinnedKey = '';
        return { key: '', source: 'default-shared', binding_file: null, state_dir: STATE_BASE, created: false };
    }
}
// Lazy per-run paths — each resolves the keyed dir fresh (honoring a pinned key)
// so a binding created mid-run (by `login`) takes effect immediately.
function dir() { return stateDir(); }
function authFile() { return join(dir(), 'auth.json'); }
// A mirror of auth.json written on every save. If auth.json is later lost or
// corrupted (e.g. an interrupted write, or a clumsy skill update), loadAuth
// transparently restores from this backup — so the user keeps their login.
function authBackupFile() { return join(dir(), 'auth.json.bak'); }
// Which agent this skill last shared. Kept SEPARATE from auth.json so it
// survives logout / token expiry: on the next `login` we pass this id to the
// approval page as agent_hint, and it auto-confirms the same agent.
function agentFile() { return join(dir(), 'agent.json'); }
// Exposed for diagnostics (doctor) + logout messaging.
export function authFilePath() { return authFile(); }
async function ensureDir() {
    await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
    try {
        await fs.chmod(dir(), 0o700);
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
    const primary = await readAuthFrom(authFile());
    if (primary)
        return primary;
    // Primary missing or corrupt — recover from the backup and restore it so the
    // user stays logged in without re-running `login`.
    const backup = await readAuthFrom(authBackupFile());
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
    await writeFileAtomic(authFile(), json);
    // Mirror to the backup so a lost/corrupt auth.json can self-heal on next load.
    try {
        await writeFileAtomic(authBackupFile(), json);
    }
    catch { /* backup is best-effort; never fail a login over it */ }
}
export async function clearAuth() {
    // Remove BOTH files — otherwise loadAuth would restore the login from the
    // backup and logout wouldn't stick.
    for (const f of [authFile(), authBackupFile()]) {
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
        const raw = await fs.readFile(agentFile(), 'utf8');
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
    const f = agentFile();
    await fs.writeFile(f, JSON.stringify(agent, null, 2), { mode: 0o600 });
    try {
        await fs.chmod(f, 0o600);
    }
    catch { }
}
export async function isAuthFileWriteable() {
    try {
        await ensureDir();
        await fs.access(dir(), fsConstants.W_OK);
        return { ok: true };
    }
    catch (e) {
        return { ok: false, reason: e.message };
    }
}
// ── Reach-out sessions (active connections this agent started) ───────────
// Stored alongside auth.json in the SAME state dir (the merged skill keeps one
// home). A session holds the per-connection bearer (xext_) for /message+/poll.
// Ported from ovoclaw-connect when the skills merged.
function sessionsFile() { return join(dir(), 'sessions.json'); }
const SESSION_HANDLE_RE = /^s_[0-9a-f]{16}$/;
function isValidHandle(h) { return SESSION_HANDLE_RE.test(h); }
async function readSessions() {
    try {
        const raw = await fs.readFile(sessionsFile(), 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return {};
        throw e;
    }
}
async function writeSessions(data) {
    await ensureDir();
    const f = sessionsFile();
    await fs.writeFile(f, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
        await fs.chmod(f, 0o600);
    }
    catch { }
}
export async function saveSession(s) {
    if (!isValidHandle(s.handle))
        throw new Error(`saveSession: invalid handle ${JSON.stringify(s.handle)}`);
    const all = await readSessions();
    all[s.handle] = s;
    await writeSessions(all);
}
export async function getSession(handle) {
    if (!isValidHandle(handle))
        return null;
    const all = await readSessions();
    return Object.prototype.hasOwnProperty.call(all, handle) ? all[handle] : null;
}
export async function listSessions() {
    const all = await readSessions();
    return Object.entries(all).filter(([k]) => isValidHandle(k)).map(([, v]) => v);
}
export async function deleteSession(handle) {
    if (!isValidHandle(handle))
        return;
    const all = await readSessions();
    if (!Object.prototype.hasOwnProperty.call(all, handle))
        return;
    delete all[handle];
    await writeSessions(all);
}
export async function updateSession(handle, patch) {
    if (!isValidHandle(handle))
        return null;
    const all = await readSessions();
    if (!Object.prototype.hasOwnProperty.call(all, handle))
        return null;
    all[handle] = { ...all[handle], ...patch };
    await writeSessions(all);
    return all[handle];
}
export function newSessionHandle() { return 's_' + randomBytes(8).toString('hex'); }
// One-time migration after the ovoclaw-share → ovoclaw rename: if the new state
// dir has no auth yet but the legacy ~/.ovoclaw-share equivalent does, copy the
// login (auth/agent/sessions) over so the user stays logged in. No-op once
// migrated, for fresh users, or when there's nothing legacy to copy.
export async function migrateLegacyState() {
    const target = dir();
    try {
        await fs.access(authFile());
        return;
    }
    catch { /* new dir has no auth — maybe migrate */ }
    const legacyDir = target.replace(STATE_BASE, LEGACY_STATE_BASE);
    if (legacyDir === target)
        return;
    try {
        await fs.access(join(legacyDir, 'auth.json'));
    }
    catch {
        return;
    } // nothing legacy
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    try {
        await fs.chmod(target, 0o700);
    }
    catch { }
    for (const f of ['auth.json', 'auth.json.bak', 'agent.json', 'sessions.json']) {
        try {
            const buf = await fs.readFile(join(legacyDir, f));
            await fs.writeFile(join(target, f), buf, { mode: 0o600 });
            try {
                await fs.chmod(join(target, f), 0o600);
            }
            catch { }
        }
        catch { /* that file didn't exist in legacy — skip */ }
    }
}
