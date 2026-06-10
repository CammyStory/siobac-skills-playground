import { promises as fs, constants as fsConstants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

// Owner-side state lives under ~/.siobac/. On a platform that runs MULTIPLE
// agents under one home, a single shared ~/.siobac/auth.json would let one
// agent's login OVERWRITE another's — silently re-binding it to the wrong
// account (and then it never sees its own connect requests / messages).
//
// PER-AGENT ISOLATION via a LOCAL BINDING FILE. Every agent platform runs its
// agents in their OWN working directory, so we scope state by a `.siobac.json`
// file in that working dir (found by walking cwd → up to $HOME). It holds only
// a NON-SECRET pointer { agent_key } — never tokens — and selects the private
// folder ~/.siobac/agents/<agent_key>/ where auth/agent/sessions live. `login`
// and `connect` auto-create the file on first use, so two agents in two working
// dirs get two folders and can never touch each other's login. An explicit
// SIOBAC_AGENT_KEY env var overrides the file; with NEITHER, we fall back to
// the shared ~/.siobac default (single-agent installs, unchanged).
export const STATE_BASE = join(homedir(), '.siobac')
// Where state lived before the rename to Siobac (ovoclaw → siobac).
// migrateLegacyState() copies an existing login over on first run so users
// don't have to log in again after the rename.
export const LEGACY_STATE_BASE = join(homedir(), '.ovoclaw')
// The local per-working-directory pointer file (no secrets — just agent_key).
// Legacy `.ovoclaw.json` bindings are still honored (read-only) so existing
// working dirs don't lose their agent after the rename.
export const BINDING_FILENAME = '.siobac.json'
export const LEGACY_BINDING_FILENAME = '.ovoclaw.json'

function sanitizeKey(k: string): string {
  return k.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)
}

// Nearest .siobac.json (or legacy .ovoclaw.json) carrying a usable agent_key,
// walking cwd up to $HOME. The new filename wins at each level; the legacy name
// is honored so existing bindings survive the rename.
function findBindingFile(): { path: string; key: string } | null {
  const home = homedir()
  let d = process.cwd()
  for (let i = 0; i < 40; i++) {
    for (const name of [BINDING_FILENAME, LEGACY_BINDING_FILENAME]) {
      const candidate = join(d, name)
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
        const key = sanitizeKey(String(parsed?.agent_key ?? '').trim())
        if (key) return { path: candidate, key }
      } catch { /* missing or malformed — try the next name / walk up */ }
    }
    if (d === home) break
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

// Once resolved (or created) within a process the key is PINNED, so every
// command in the same run reads/writes the SAME folder — including the very run
// of `login` that just created the binding file.
let _pinnedKey: string | null = null

function resolveAgentKey(): string {
  if (_pinnedKey !== null) return _pinnedKey
  const env = (process.env.SIOBAC_AGENT_KEY ?? process.env.OVOCLAW_AGENT_KEY ?? '').trim()
  if (env) return sanitizeKey(env)
  const bf = findBindingFile()
  return bf ? bf.key : ''
}

function stateDirFor(key: string): string {
  return key ? join(STATE_BASE, 'agents', key) : STATE_BASE
}

// State dir for the current run (env key > local binding file > shared default).
export function stateDir(): string { return stateDirFor(resolveAgentKey()) }

export type BindingSource = 'env' | 'local-file' | 'default-shared'
export interface AgentBinding {
  key: string
  source: BindingSource
  binding_file: string | null
  state_dir: string
  created: boolean
}

// Resolve the per-agent binding. When `create` is true and nothing is bound yet,
// CREATE a fresh .siobac.json in the current working directory so this agent
// gets its OWN isolated folder. login/connect pass create=true; read-only
// callers (doctor) pass false.
export async function ensureAgentBinding(create: boolean): Promise<AgentBinding> {
  const env = (process.env.SIOBAC_AGENT_KEY ?? process.env.OVOCLAW_AGENT_KEY ?? '').trim()
  if (env) {
    const key = sanitizeKey(env)
    _pinnedKey = key
    return { key, source: 'env', binding_file: null, state_dir: stateDirFor(key), created: false }
  }
  const found = findBindingFile()
  if (found) {
    _pinnedKey = found.key
    return { key: found.key, source: 'local-file', binding_file: found.path, state_dir: stateDirFor(found.key), created: false }
  }
  if (!create) {
    _pinnedKey = ''
    return { key: '', source: 'default-shared', binding_file: null, state_dir: STATE_BASE, created: false }
  }
  // No binding yet → mint one in the CURRENT working directory. The key is a
  // readable cwd basename + a random suffix so it's both recognizable and unique.
  const base = (sanitizeKey(process.cwd().split(/[\\/]/).filter(Boolean).pop() || 'agent') || 'agent').slice(0, 24)
  const key = `${base}-${randomBytes(4).toString('hex')}`
  const path = join(process.cwd(), BINDING_FILENAME)
  const body = {
    agent_key: key,
    created_at: new Date().toISOString(),
    note: "Siobac per-agent binding. Points to the private ~/.siobac/agents/<agent_key>/ folder that holds THIS agent's login — contains no secrets. Keep one per agent working directory; delete to unbind.",
  }
  try {
    await fs.writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 })
    try { await fs.chmod(path, 0o600) } catch {}
    _pinnedKey = key
    return { key, source: 'local-file', binding_file: path, state_dir: stateDirFor(key), created: true }
  } catch {
    // cwd not writable — degrade to the shared default rather than fail outright.
    _pinnedKey = ''
    return { key: '', source: 'default-shared', binding_file: null, state_dir: STATE_BASE, created: false }
  }
}

// Lazy per-run paths — each resolves the keyed dir fresh (honoring a pinned key)
// so a binding created mid-run (by `login`) takes effect immediately.
function dir(): string { return stateDir() }
function authFile(): string { return join(dir(), 'auth.json') }
// A mirror of auth.json written on every save. If auth.json is later lost or
// corrupted (e.g. an interrupted write, or a clumsy skill update), loadAuth
// transparently restores from this backup — so the user keeps their login.
function authBackupFile(): string { return join(dir(), 'auth.json.bak') }
// Which agent this skill last shared. Kept SEPARATE from auth.json so it
// survives logout / token expiry: on the next `login` we pass this id to the
// approval page as agent_hint, and it auto-confirms the same agent.
function agentFile(): string { return join(dir(), 'agent.json') }

// Exposed for diagnostics (doctor) + logout messaging.
export function authFilePath(): string { return authFile() }

// auth.json shape. Populated by the device-flow login command. Holds the
// access token returned by the Siobac OAuth endpoint plus the refresh
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
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 })
  try { await fs.chmod(dir(), 0o700) } catch {}
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
  const primary = await readAuthFrom(authFile())
  if (primary) return primary
  // Primary missing or corrupt — recover from the backup and restore it so the
  // user stays logged in without re-running `login`.
  const backup = await readAuthFrom(authBackupFile())
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
  await writeFileAtomic(authFile(), json)
  // Mirror to the backup so a lost/corrupt auth.json can self-heal on next load.
  try {
    await writeFileAtomic(authBackupFile(), json)
  } catch { /* backup is best-effort; never fail a login over it */ }
}

export async function clearAuth(): Promise<void> {
  // Remove BOTH files — otherwise loadAuth would restore the login from the
  // backup and logout wouldn't stick.
  for (const f of [authFile(), authBackupFile()]) {
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
  // Set the first time the owner confirms/sets the agent's NAME (`set-profile --name`).
  // The server has no "name confirmed" flag (a new agent ships with an auto-name), so
  // the setup checklist tracks confirmation HERE — otherwise the name step could never
  // read as done for a brand-new agent. ISO 8601.
  nameConfirmedAt?: string
}

// Mark the bound agent's NAME as confirmed (idempotent; no-op if no binding yet).
// Called when the owner sets the name via `set-profile --name`, and on login --finish
// for an already-designed (non-new) agent so a fresh state dir on another machine
// doesn't re-prompt the name for an agent that's clearly already set up.
// `name`, when given, also refreshes the remembered display name (it goes stale when
// the profile is renamed, which made re-login pre-select / show the wrong name).
export async function markNameConfirmed(name?: string): Promise<void> {
  const bound = await loadBoundAgent()
  if (!bound) return
  const next: BoundAgentState = { ...bound }
  let changed = false
  if (!bound.nameConfirmedAt) { next.nameConfirmedAt = new Date().toISOString(); changed = true }
  const trimmed = name?.trim()
  if (trimmed && bound.agentName !== trimmed) { next.agentName = trimmed; changed = true }
  if (changed) await saveBoundAgent(next)
}

export async function loadBoundAgent(): Promise<BoundAgentState | null> {
  try {
    const raw = await fs.readFile(agentFile(), 'utf8')
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
  const f = agentFile()
  await fs.writeFile(f, JSON.stringify(agent, null, 2), { mode: 0o600 })
  try { await fs.chmod(f, 0o600) } catch {}
}

// ── Pending device-flow login (two-step) ─────────────────────────────
// `login` requests a device code and stashes it here, then returns the
// approval URL immediately WITHOUT polling. `login --finish` — run only after
// the user says they approved — reads this back and polls once for the token.
// Kept in the SAME per-agent state dir so the finished token lands in the right
// folder. This is what stops the agent from silently looping `login`.
function pendingLoginFile(): string { return join(dir(), 'login-pending.json') }

export interface PendingLogin {
  deviceCode: string
  interval: number   // seconds between polls (server hint)
  expiresAt: string  // ISO 8601 — after this the device code is dead
  agentHint?: string
  startedAt: string  // ISO 8601
}

export async function savePendingLogin(p: PendingLogin): Promise<void> {
  await ensureDir()
  const f = pendingLoginFile()
  await fs.writeFile(f, JSON.stringify(p, null, 2), { mode: 0o600 })
  try { await fs.chmod(f, 0o600) } catch {}
}
export async function loadPendingLogin(): Promise<PendingLogin | null> {
  try {
    const raw = await fs.readFile(pendingLoginFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as PendingLogin).deviceCode === 'string') {
      return parsed as PendingLogin
    }
    return null
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
export async function clearPendingLogin(): Promise<void> {
  try { await fs.unlink(pendingLoginFile()) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

export async function isAuthFileWriteable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await ensureDir()
    await fs.access(dir(), fsConstants.W_OK)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}


// ── Reach-out sessions (active connections this agent started) ───────────
// Stored alongside auth.json in the SAME state dir (the merged skill keeps one
// home). A session holds the per-connection bearer (xext_) for /message+/poll.
// Ported from ovoclaw-connect when the skills merged.
function sessionsFile(): string { return join(dir(), 'sessions.json') }

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
    const raw = await fs.readFile(sessionsFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Session>) : {}
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}
async function writeSessions(data: Record<string, Session>): Promise<void> {
  await ensureDir()
  const f = sessionsFile()
  await fs.writeFile(f, JSON.stringify(data, null, 2), { mode: 0o600 })
  try { await fs.chmod(f, 0o600) } catch {}
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

// One-time migration after the ovoclaw → siobac rename: if the new ~/.siobac
// state dir has no auth yet but the legacy ~/.ovoclaw equivalent does, copy the
// login (auth/agent/sessions) over so the user stays logged in (no re-login
// after the rename). No-op once migrated, for fresh users, or nothing to copy.
export async function migrateLegacyState(): Promise<void> {
  const target = dir()
  try { await fs.access(authFile()); return } catch { /* new dir has no auth — maybe migrate */ }
  const legacyDir = target.replace(STATE_BASE, LEGACY_STATE_BASE)
  if (legacyDir === target) return
  try { await fs.access(join(legacyDir, 'auth.json')) } catch { return } // nothing legacy
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  try { await fs.chmod(target, 0o700) } catch {}
  for (const f of ['auth.json', 'auth.json.bak', 'agent.json', 'sessions.json']) {
    try {
      const buf = await fs.readFile(join(legacyDir, f))
      await fs.writeFile(join(target, f), buf, { mode: 0o600 })
      try { await fs.chmod(join(target, f), 0o600) } catch {}
    } catch { /* that file didn't exist in legacy — skip */ }
  }
}
