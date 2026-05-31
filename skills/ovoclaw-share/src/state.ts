import { promises as fs, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Owner-side state. Distinct directory from ovoclaw-connect's
// ~/.ovoclaw-connect/ so playground share state and playground
// connect state can coexist on the same machine without colliding.
export const STATE_DIR = join(homedir(), '.ovoclaw-share')
export const AUTH_FILE = join(STATE_DIR, 'auth.json')
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

export async function loadAuth(): Promise<AuthState | null> {
  try {
    const raw = await fs.readFile(FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as AuthState).accessToken === 'string') {
      return parsed as AuthState
    }
    return null
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function saveAuth(auth: AuthState): Promise<void> {
  await ensureDir()
  await fs.writeFile(FILE, JSON.stringify(auth, null, 2), { mode: 0o600 })
  try { await fs.chmod(FILE, 0o600) } catch {}
}

export async function clearAuth(): Promise<void> {
  try {
    await fs.unlink(FILE)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
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
