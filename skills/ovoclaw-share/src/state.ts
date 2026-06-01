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
  await fs.writeFile(FILE, json, { mode: 0o600 })
  try { await fs.chmod(FILE, 0o600) } catch {}
  // Mirror to the backup so a lost/corrupt auth.json can self-heal on next load.
  try {
    await fs.writeFile(AUTH_BACKUP_FILE, json, { mode: 0o600 })
    try { await fs.chmod(AUTH_BACKUP_FILE, 0o600) } catch {}
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

// ── Auto-reply (owner side) state ──────────────────────────────────────────
// The owner's scheduled auto-reply. Stored once per install (the skill is bound
// to one agent). The actual answering runs in the platform scheduler; this is
// the on/off flag + status the owner can start/stop/check, and which the
// scheduled run reads (answer only while running) and updates: check-inbox
// stamps lastCheckedAt and respond bumps repliesSent — both only while running.
export const AUTOREPLY_FILE = join(STATE_DIR, 'autoreply.json')
export type AutoReplyStatus = 'running' | 'off'
export interface AutoReplyState {
  status: AutoReplyStatus
  startedAt?: string       // ISO when turned on
  lastCheckedAt?: string   // ISO of the most recent check-inbox while running
  repliesSent: number      // cumulative replies sent since started
}

export async function loadAutoReply(): Promise<AutoReplyState> {
  try {
    const raw = await fs.readFile(AUTOREPLY_FILE, 'utf8')
    const p = JSON.parse(raw)
    if (p && typeof p === 'object' && (p.status === 'running' || p.status === 'off')) {
      return {
        status: p.status,
        startedAt: typeof p.startedAt === 'string' ? p.startedAt : undefined,
        lastCheckedAt: typeof p.lastCheckedAt === 'string' ? p.lastCheckedAt : undefined,
        repliesSent: typeof p.repliesSent === 'number' ? p.repliesSent : 0,
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return { status: 'off', repliesSent: 0 }
}

export async function saveAutoReply(state: AutoReplyState): Promise<void> {
  await ensureDir()
  await fs.writeFile(AUTOREPLY_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
  try { await fs.chmod(AUTOREPLY_FILE, 0o600) } catch {}
}
