import { promises as fs, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Owner-side state. Distinct directory from ovoclaw-connect's
// ~/.ovoclaw-connect/ so playground share state and playground
// connect state can coexist on the same machine without colliding.
export const STATE_DIR = join(homedir(), '.ovoclaw-share')
export const AUTH_FILE = join(STATE_DIR, 'auth.json')
// A mirror of auth.json written on every save. If auth.json is later lost or
// corrupted (e.g. an interrupted write, or a clumsy skill update), loadAuth
// transparently restores from this backup — so the user keeps their login
// instead of having to run `login` again.
export const AUTH_BACKUP_FILE = join(STATE_DIR, 'auth.json.bak')
// Which agent this skill last shared. Kept SEPARATE from auth.json so it
// survives logout / token expiry: on the next `login` we pass this id to the
// approval page as agent_hint, and it auto-confirms the same agent — so every
// re-share re-binds the same OvOclaw identity without the user re-choosing.
export const AGENT_FILE = join(STATE_DIR, 'agent.json')

const DIR = STATE_DIR
const FILE = AUTH_FILE

// auth.json shape. Populated by the device-flow login command. Holds the
// access token returned by the OvOclaw OAuth endpoint plus the refresh
// token (when present) so we can rotate without forcing a re-login.
export interface AuthState {
  accessToken: string
  tokenType: string
  expiresAt: string  // ISO 8601
  refreshToken?: string
  scope?: string
  ovoclawAccountId?: string
  // The agent this authorization is bound to. The token can act ONLY as this
  // agent — share it and serve its own connections. Set at login from the
  // approval page's agent picker; every owner-side command uses it implicitly.
  agentId?: string
  loggedInAt: string  // ISO 8601
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 })
  try { await fs.chmod(DIR, 0o700) } catch {}
}

// Atomic write: temp file + rename (atomic on POSIX), so a reader never sees a
// half-written file and concurrent writers can't interleave bytes. Guards
// auth.json against corruption from an interrupted/parallel write — corruption
// there reads as "logged out" and forces a needless re-login.
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, data, { mode: 0o600 })
  try { await fs.chmod(tmp, 0o600) } catch {}
  try {
    await fs.rename(tmp, path)
  } catch {
    await fs.writeFile(path, data, { mode: 0o600 })
    try { await fs.chmod(path, 0o600) } catch {}
    try { await fs.unlink(tmp) } catch {}
  }
}

// Read + validate an auth file. Returns null for missing (ENOENT) or corrupt /
// malformed contents; rethrows only unexpected fs errors (e.g. permissions).
async function readAuthFrom(path: string): Promise<AuthState | null> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as AuthState).accessToken === 'string') {
      return parsed as AuthState
    }
  } catch {
    // corrupt JSON — fall through to null so the caller can try the backup
  }
  return null
}

export async function loadAuth(): Promise<AuthState | null> {
  const primary = await readAuthFrom(FILE)
  if (primary) return primary
  // Primary missing or corrupt — recover from the backup and restore it so the
  // user stays logged in without re-running `login`.
  const backup = await readAuthFrom(AUTH_BACKUP_FILE)
  if (backup) {
    try { await saveAuth(backup) } catch { /* restore is best-effort */ }
    return backup
  }
  return null
}

export async function saveAuth(auth: AuthState): Promise<void> {
  await ensureDir()
  const json = JSON.stringify(auth, null, 2)
  // Atomic so a refresh's rotated token always lands intact.
  await writeFileAtomic(FILE, json)
  // Mirror to the backup so a lost/corrupt auth.json can self-heal on next load.
  try {
    await writeFileAtomic(AUTH_BACKUP_FILE, json)
  } catch { /* backup is best-effort; never fail a login over it */ }
}

export async function clearAuth(): Promise<void> {
  // Remove BOTH files — otherwise loadAuth would restore the login from the
  // backup and logout wouldn't stick.
  for (const f of [FILE, AUTH_BACKUP_FILE]) {
    try {
      await fs.unlink(f)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
}

// agent.json shape — the remembered share binding. agentName is cosmetic
// (handy for logs / future UX); only agentId is used as the login hint.
export interface BoundAgentState {
  agentId: string
  agentName?: string
  boundAt: string  // ISO 8601
}

export async function loadBoundAgent(): Promise<BoundAgentState | null> {
  try {
    const raw = await fs.readFile(AGENT_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as BoundAgentState).agentId === 'string') {
      return parsed as BoundAgentState
    }
    return null
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function saveBoundAgent(agent: BoundAgentState): Promise<void> {
  await ensureDir()
  await fs.writeFile(AGENT_FILE, JSON.stringify(agent, null, 2), { mode: 0o600 })
  try { await fs.chmod(AGENT_FILE, 0o600) } catch {}
}

export async function isAuthFileWriteable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await ensureDir()
    await fs.access(DIR, fsConstants.W_OK)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}


// ── Reach-out sessions (active connections this agent started) ───────────
// Stored alongside auth.json in the SAME state dir (the merged skill keeps one
// home). A session holds the per-connection bearer (xext_) for /message+/poll.
// Ported from ovoclaw-connect when the skills merged.
import { randomBytes } from 'node:crypto'

export const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

export interface Session {
  handle: string
  slug: string
  host: string
  peerAgentName?: string
  token: string
  tokenExpiresAt: string
  clientUserId: string
  clientSecret: string
  conversationId?: string
  lastSeq: number
  createdAt: string
}

const SESSION_HANDLE_RE = /^s_[0-9a-f]{16}$/
function isValidHandle(h: string): boolean { return SESSION_HANDLE_RE.test(h) }

async function readSessions(): Promise<Record<string, Session>> {
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Session>) : {}
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}
async function writeSessions(data: Record<string, Session>): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  try { await fs.chmod(STATE_DIR, 0o700) } catch {}
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
  try { await fs.chmod(SESSIONS_FILE, 0o600) } catch {}
}

export async function saveSession(s: Session): Promise<void> {
  if (!isValidHandle(s.handle)) throw new Error(`saveSession: invalid handle ${JSON.stringify(s.handle)}`)
  const all = await readSessions(); all[s.handle] = s; await writeSessions(all)
}
export async function getSession(handle: string): Promise<Session | null> {
  if (!isValidHandle(handle)) return null
  const all = await readSessions()
  return Object.prototype.hasOwnProperty.call(all, handle) ? all[handle] : null
}
export async function listSessions(): Promise<Session[]> {
  const all = await readSessions()
  return Object.entries(all).filter(([k]) => isValidHandle(k)).map(([, v]) => v)
}
export async function deleteSession(handle: string): Promise<void> {
  if (!isValidHandle(handle)) return
  const all = await readSessions()
  if (!Object.prototype.hasOwnProperty.call(all, handle)) return
  delete all[handle]; await writeSessions(all)
}
export async function updateSession(handle: string, patch: Partial<Session>): Promise<Session | null> {
  if (!isValidHandle(handle)) return null
  const all = await readSessions()
  if (!Object.prototype.hasOwnProperty.call(all, handle)) return null
  all[handle] = { ...all[handle], ...patch }; await writeSessions(all); return all[handle]
}
export function newSessionHandle(): string { return 's_' + randomBytes(8).toString('hex') }
