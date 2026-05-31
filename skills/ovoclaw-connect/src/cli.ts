#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from 'node:fs'
import { platform, arch } from 'node:os'
import { parseArgs, requireString, optionalString, optionalInt, CliError } from './argparse.js'
import { parseInvite } from './invite.js'
import {
  connect,
  getManifest,
  getSkillUpdateNotice,
  makeError,
  pollConnect,
  pollReplies,
  reauthorize,
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
  sendMessage,
  type ConnectResponse,
  type ApiError,
  type DeviceCodeResponse,
  type SkillUpdateNotice,
} from './api.js'
import {
  STATE_DIR,
  STATE_FILE,
  AUTH_FILE,
  clearAuth,
  deleteSession,
  getSession,
  listSessions,
  loadAuth,
  newHandle,
  saveAuth,
  saveSession,
  updateSession,
  type AuthState,
  type Session,
} from './state.js'
import { SKILL_NAME, SKILL_VERSION } from './version.js'

// TEST/playground build: dev environment by default (see invite.ts). Public
// release uses https://ovo.ovoclaw.com. Override with OVOCLAW_API_BASE.
const DEFAULT_API_BASE = 'https://ovo.ovoclaw.com/dev'

// ── Output contract ────────────────────────────────────────────────────
// Every successful invocation prints exactly ONE JSON object to stdout
// and exits 0. Every failed invocation prints exactly ONE JSON object to
// stderr and exits non-zero. No banners, no decorative text, no progress
// logging. The consumer is an LLM; stable machine-readable output is the
// whole point of this CLI.

// Attach a `skill_update` block when this run heard about a newer skill from
// the server. SKILL.md tells the agent to relay it to the user.
function withUpdateNotice<T extends object>(body: T): T & { skill_update?: SkillUpdateNotice } {
  const upd = getSkillUpdateNotice()
  return upd ? { ...body, skill_update: upd } : body
}

function ok(value: unknown): never {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? withUpdateNotice(value as object)
      : value
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  process.exit(0)
}

function fail(err: unknown, exitCode = 1): never {
  let body: Record<string, unknown>
  if (err instanceof CliError) {
    body = { error: err.message, code: 'cli_error' }
  } else if (err instanceof Error) {
    const apiErr = err as ApiError
    // Default to 'unknown' so every failure JSON includes a machine-readable
    // `code` — SKILL.md tells agents to branch on `code`, never on the English
    // message, so this field must always be present.
    body = { error: err.message, code: apiErr.code ?? 'unknown' }
    if (typeof apiErr.status === 'number') body.status = apiErr.status
    if (apiErr.body !== undefined) body.details = apiErr.body
  } else {
    body = { error: String(err), code: 'unknown' }
  }
  process.stderr.write(JSON.stringify(withUpdateNotice(body), null, 2) + '\n')
  process.exit(exitCode)
}

async function persistFromConnect(res: ConnectResponse, slug: string, host: string): Promise<Session> {
  if (res.token_already_delivered || !res.token || !res.token_expires_at || !res.your_user_id || !res.client_secret) {
    const e = new Error(
      res.token_already_delivered
        ? 'This connection was approved but its one-time token was already delivered and can no longer be retrieved. If you already have a session_handle for it you are connected (run list-sessions); otherwise ask the owner to disconnect you, then run connect again with the invite.'
        : `connect succeeded but the response was missing token fields: ${JSON.stringify(res)}`,
    ) as Error & { code: string }
    e.code = res.token_already_delivered ? 'token_already_delivered' : 'missing_token_fields'
    throw e
  }
  const session: Session = {
    handle: newHandle(),
    slug,
    host,
    peerAgentName: res.peer_name,
    token: res.token,
    tokenExpiresAt: res.token_expires_at,
    clientUserId: res.your_user_id,
    clientSecret: res.client_secret,
    conversationId: res.conversation_id,
    lastSeq: 0,
    createdAt: new Date().toISOString(),
  }
  await saveSession(session)
  return session
}

// ── Subcommand handlers ───────────────────────────────────────────────

async function cmdInspectInvite(flags: Record<string, string | true>) {
  const invite = requireString(flags, 'invite', 'inspect-invite')
  const { slug, host } = parseInvite(invite)
  const m = await getManifest(host, slug)
  ok({
    host,
    slug,
    agent: m.agent,
    requires_approval: m.requires_approval ?? false,
    protocol: m.ovo_protocol,
  })
}

async function cmdConnect(flags: Record<string, string | true>) {
  const invite = requireString(flags, 'invite', 'connect')
  const introduction = requireString(flags, 'intro', 'connect')
  const your_agent_name = optionalString(flags, 'agent-name')
  const your_owner_name = optionalString(flags, 'owner-name')
  const purpose_hint = optionalString(flags, 'purpose')

  const { slug, host } = parseInvite(invite)
  // If logged in, send the agent:connect bearer → registered (friendship)
  // connect. Otherwise this is a guest connect (today's behaviour).
  const bearer = await loginBearer()
  const res = await connect(host, slug, {
    your_agent_name,
    your_owner_name,
    introduction,
    purpose_hint,
  }, bearer ?? undefined)

  if (res.status === 'active' || res.status === 'reauthorized' || res.status === 'already_connected') {
    const session = await persistFromConnect(res, slug, host)
    ok({
      status: res.status,
      session_handle: session.handle,
      peer_name: session.peerAgentName,
      token_expires_at: session.tokenExpiresAt,
      conversation_id: session.conversationId,
      registered: res.registered ?? false,
      ...(res.registered
        ? { note: 'Registered friendship: you are saved as a friend — reconnecting later (while logged in) needs no re-approval and survives reinstalls.' }
        : {}),
    })
  }

  if (res.status === 'awaiting_approval') {
    ok({
      status: 'awaiting_approval',
      request_id: res.request_id,
      invite,
      hint: 'Call `check-approval --invite <same> --request-id <id>` periodically. When status becomes "active", a session_handle will be returned.',
    })
  }

  // Any other status (agent_unavailable, agent_busy, rate_limited, etc.):
  // strip credential-shaped fields defensively before emitting. The current
  // OvO server never includes a token in non-success responses, but the
  // ConnectResponse type is open-ended ([k: string]: unknown) — if the
  // server ever changes shape, we don't want to leak through this path.
  ok(sanitizeConnectResponse(res))
}

async function cmdCheckApproval(flags: Record<string, string | true>) {
  const invite = requireString(flags, 'invite', 'check-approval')
  const requestId = requireString(flags, 'request-id', 'check-approval')
  const { slug, host } = parseInvite(invite)
  const res = await pollConnect(host, slug, requestId)
  // The connection is approved/active, but the server can no longer hand back
  // the one-time token (it's held only briefly in memory). Don't try to persist
  // a session from a tokenless response — surface a clear, recoverable status
  // instead of crashing with "missing token fields".
  if (res.status === 'active' && res.token_already_delivered) {
    ok({
      status: 'token_already_delivered',
      message:
        'This connection was approved, but its one-time access token can no longer be retrieved. The server holds it only briefly in memory — it is cleared after the first successful check-approval, after about 5 minutes, or if the server restarts.',
      already_connected_hint:
        'If an earlier connect or check-approval already returned a session_handle, you are ALREADY connected — run list-sessions and keep using that session; do not reconnect.',
      recovery:
        'Otherwise the token is unrecoverable: ask the owner to disconnect you, then run `connect` again with the same invite to mint a fresh token.',
      conversation_id: res.conversation_id,
      your_user_id: res.your_user_id,
    })
  }
  if (res.status === 'active') {
    const session = await persistFromConnect(res, slug, host)
    ok({
      status: 'active',
      session_handle: session.handle,
      peer_name: session.peerAgentName,
      token_expires_at: session.tokenExpiresAt,
    })
  }
  // Same sanitization rationale as cmdConnect's fall-through.
  ok(sanitizeConnectResponse(res))
}

// Strip any credential-shaped fields from a ConnectResponse before the CLI
// emits it to stdout. Only called from fall-through paths; success paths
// already use explicit allow-lists.
function sanitizeConnectResponse(res: ConnectResponse): Record<string, unknown> {
  const { token: _t, client_secret: _cs, ...safe } = res
  return safe as Record<string, unknown>
}

// Refresh the session's bearer token when it's expired or within this skew, so
// a command never starts with a token about to lapse mid-request.
const TOKEN_REFRESH_SKEW_MS = 60_000

// Return the session with a fresh bearer token, silently reauthorizing via the
// stored client_secret when the current token is expired/near-expiry. The
// rotated token is persisted so the next command reuses it.
async function freshToken(sess: Session): Promise<Session> {
  if (new Date(sess.tokenExpiresAt).getTime() - Date.now() > TOKEN_REFRESH_SKEW_MS) return sess
  const { token, token_expires_at } = await reauthorize(sess.host, sess.slug, sess.clientUserId, sess.clientSecret)
  const updated: Session = { ...sess, token, tokenExpiresAt: token_expires_at }
  await saveSession(updated)
  return updated
}

// Run a token-bearing call with auto-refresh: refresh proactively first, and if
// the call is still rejected (401 → session_expired, e.g. revoked mid-flight),
// reauthorize once and retry. A genuine dead connection surfaces session_expired.
async function withFreshToken<T>(sess: Session, fn: (s: Session) => Promise<T>): Promise<T> {
  let s = await freshToken(sess)
  try {
    return await fn(s)
  } catch (e) {
    if ((e as ApiError).code !== 'session_expired') throw e
    const { token, token_expires_at } = await reauthorize(s.host, s.slug, s.clientUserId, s.clientSecret)
    s = { ...s, token, tokenExpiresAt: token_expires_at }
    await saveSession(s)
    return await fn(s)
  }
}

// ── Login mode (optional) ──────────────────────────────────────────────
// OAuth endpoints live at the server root (not behind an invite), so login
// uses the skill's default base / OVOCLAW_API_BASE.
function loginBase(): string {
  return process.env.OVOCLAW_API_BASE ?? DEFAULT_API_BASE
}

// Return a fresh agent:connect bearer if the user is logged in (refreshing it
// silently when expired/near-expiry), or null when in guest mode.
async function loginBearer(): Promise<string | null> {
  const auth = await loadAuth()
  if (!auth) return null
  if (new Date(auth.expiresAt).getTime() - Date.now() > 60_000) return auth.accessToken
  if (!auth.refreshToken) return auth.accessToken
  try {
    const t = await refreshAccessToken(loginBase(), auth.refreshToken)
    const updated: AuthState = {
      ...auth,
      accessToken: t.access_token,
      tokenType: t.token_type,
      expiresAt: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      refreshToken: t.refresh_token ?? auth.refreshToken,
      scope: t.scope ?? auth.scope,
    }
    await saveAuth(updated)
    return updated.accessToken
  } catch {
    return auth.accessToken // refresh failed; let the server decide
  }
}

async function cmdLogin(flags: Record<string, string | true>) {
  const base = loginBase()
  const agentHint = optionalString(flags, 'agent') // pre-select which of your agents to connect as
  const codeResp: DeviceCodeResponse = await requestDeviceCode(base, agentHint)

  // Surface the approval link; prefer the pre-filled one. Then poll.
  process.stdout.write(JSON.stringify({
    status: 'awaiting_user_approval',
    verification_uri_complete: codeResp.verification_uri_complete,
    verification_uri: codeResp.verification_uri,
    user_code: codeResp.user_code,
    expires_in_seconds: codeResp.expires_in,
    message:
      'Show the user verification_uri_complete and tell them to click it — the code is pre-filled, no typing. ' +
      '(Fallback: open verification_uri and enter user_code.) They sign in, pick which of THEIR agents to connect as, and approve. ' +
      'The CLI keeps polling and continues automatically once approved.',
  }, null, 2) + '\n')

  const expiresAt = Date.now() + codeResp.expires_in * 1000
  let interval = codeResp.interval * 1000
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, interval))
    try {
      const token = await pollDeviceToken(base, codeResp.device_code)
      const auth: AuthState = {
        accessToken: token.access_token,
        tokenType: token.token_type,
        expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        refreshToken: token.refresh_token,
        scope: token.scope,
        ovoclawAccountId: token.account_id,
        agentId: token.agent_id ?? undefined,
        agentName: token.agent_name ?? undefined,
        loggedInAt: new Date().toISOString(),
      }
      await saveAuth(auth)
      const label = auth.agentName ?? auth.agentId
      ok({
        status: 'authenticated',
        mode: 'login',
        scope: auth.scope,
        expires_at: auth.expiresAt,
        account_id: auth.ovoclawAccountId,
        agent_id: auth.agentId,
        agent_name: auth.agentName ?? null,
        note:
          'Logged in as a registered agent. Connections you make while logged in become saved FRIENDSHIPS — the owner approves you once, then recognizes you next time (no re-approval), and it survives reinstalls / new devices. Guest mode (no login) still works for one-off, no-signup reach.',
        remember: label
          ? `Logged in to OvOclaw as agent "${label}" (id ${auth.agentId}). Record this in your durable memory; next login you can pass \`login --agent "${label}"\` to re-bind the same identity without the picker.`
          : undefined,
      })
    } catch (e) {
      const code = (e as ApiError).code
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') { interval = Math.round(interval * 1.5); continue }
      throw e
    }
  }
  throw makeError('expired_token', 'device authorization expired before approval. Run `login` again.')
}

async function cmdLogout() {
  await clearAuth()
  ok({ ok: true, status: 'logged_out', auth_file_path: AUTH_FILE })
}

async function cmdSendMessage(flags: Record<string, string | true>) {
  const handle = requireString(flags, 'session', 'send-message')
  const content = requireString(flags, 'content', 'send-message')
  const sess = await getSession(handle)
  if (!sess) {
    throw new CliError(
      `Unknown --session "${handle}". Use list-sessions to see active handles, or connect first.`,
    )
  }
  const res = await withFreshToken(sess, (s) => sendMessage(s.host, s.token, content))
  ok({
    ok: res.ok,
    message_id: res.message?.id,
    seq: res.message?.seq,
    reply_status: res.reply_status,
    agent_reply: res.agent_message,
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// With --watch the SKILL itself does the retry loop, so the cadence is
// guaranteed instead of relying on the agent to call this repeatedly (which it
// often won't). Defaults give 12 checks total (the first read + 11 retries),
// ~10s apart (~2 minutes), returning the INSTANT a reply arrives. Without
// --watch it's a single immediate read (backwards-compatible). The window is
// tunable with --retries and --interval. Note: with --watch this command can
// block up to retries×interval seconds — fine for a foreground call, but if the
// host kills long commands, lower --retries/--interval and call it more often.
async function cmdCheckReplies(flags: Record<string, string | true>) {
  const handle = requireString(flags, 'session', 'check-replies')
  const wait = optionalInt(flags, 'wait', 'check-replies') ?? 0
  if (wait < 0 || wait > 60) throw new CliError('check-replies: --wait must be between 0 and 60 seconds')
  const watch = flags.watch !== undefined
  const retries = optionalInt(flags, 'retries', 'check-replies') ?? (watch ? 11 : 0)
  const interval = optionalInt(flags, 'interval', 'check-replies') ?? 10
  if (retries < 0 || retries > 60) throw new CliError('check-replies: --retries must be between 0 and 60')
  if (interval < 1 || interval > 60) throw new CliError('check-replies: --interval must be between 1 and 60 seconds')

  const sess = await getSession(handle)
  if (!sess) throw new CliError(`Unknown --session "${handle}".`)

  // Poll with the session's original cursor each time; only commit lastSeq at
  // the end. Stop early the moment any reply arrives.
  let res = await withFreshToken(sess, (s) => pollReplies(s.host, s.token, sess.lastSeq, wait))
  let checks = 1
  while (checks <= retries && (res.messages ?? []).length === 0) {
    await sleep(interval * 1000)
    res = await withFreshToken(sess, (s) => pollReplies(s.host, s.token, sess.lastSeq, wait))
    checks++
  }
  if (res.last_seq > sess.lastSeq) {
    await updateSession(sess.handle, { lastSeq: res.last_seq })
  }
  ok({ messages: res.messages, last_seq: res.last_seq, checks })
}

async function cmdListSessions() {
  const all = await listSessions()
  ok(
    all.map((s) => ({
      handle: s.handle,
      peer: s.peerAgentName,
      slug: s.slug,
      host: s.host,
      expires_at: s.tokenExpiresAt,
      last_seq: s.lastSeq,
      created_at: s.createdAt,
    })),
  )
}

async function cmdForgetSession(flags: Record<string, string | true>) {
  const handle = requireString(flags, 'session', 'forget-session')
  await deleteSession(handle)
  ok({ ok: true, forgot: handle })
}

// ── doctor ─────────────────────────────────────────────────────────────
// Self-diagnostic: prints environment + connectivity. Useful for
// agents to confirm the skill is healthy before attempting a connect,
// and for users to attach to bug reports.

interface DoctorCheck {
  ok: boolean
  value?: unknown
  reason?: string
  warning?: string
}

async function checkStateDir(): Promise<DoctorCheck> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
    await fs.access(STATE_DIR, fsConstants.W_OK)
    return { ok: true, value: STATE_DIR }
  } catch (e) {
    return { ok: false, value: STATE_DIR, reason: (e as Error).message }
  }
}

async function checkSessionsFile(): Promise<DoctorCheck> {
  try {
    const st = await fs.stat(STATE_FILE)
    const modeOctal = (st.mode & 0o777).toString(8).padStart(3, '0')
    const tooPermissive = (st.mode & 0o077) !== 0
    return {
      ok: !tooPermissive,
      value: { path: STATE_FILE, mode: modeOctal, exists: true },
      warning: tooPermissive
        ? `sessions.json mode ${modeOctal} is world/group readable; expected 600. Run: chmod 600 ${STATE_FILE}`
        : undefined,
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: { path: STATE_FILE, exists: false } }
    }
    return { ok: false, value: STATE_FILE, reason: (e as Error).message }
  }
}

function checkNodeVersion(): DoctorCheck {
  const v = process.versions.node
  const major = Number.parseInt(v.split('.')[0] ?? '0', 10)
  if (major >= 18) return { ok: true, value: `v${v}` }
  return { ok: false, value: `v${v}`, reason: `Node ${v} is too old; this skill requires >= 18 for built-in fetch.` }
}

function checkFetch(): DoctorCheck {
  if (typeof fetch === 'function') return { ok: true }
  return { ok: false, reason: 'global fetch is not available; Node 18+ required.' }
}

function checkApiBase(): { check: DoctorCheck; base: string } {
  const fromEnv = process.env.OVOCLAW_API_BASE
  if (!fromEnv) {
    return { check: { ok: true, value: DEFAULT_API_BASE, warning: 'using built-in default (OVOCLAW_API_BASE not set)' }, base: DEFAULT_API_BASE }
  }
  try {
    const u = new URL(fromEnv)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { check: { ok: false, value: fromEnv, reason: `OVOCLAW_API_BASE must use http or https, got ${u.protocol}` }, base: fromEnv }
    }
    return { check: { ok: true, value: fromEnv }, base: fromEnv }
  } catch {
    return { check: { ok: false, value: fromEnv, reason: 'OVOCLAW_API_BASE is not a valid URL' }, base: fromEnv }
  }
}

async function checkApiReachable(base: string): Promise<DoctorCheck> {
  const start = Date.now()
  try {
    const res = await fetch(`${base}/manifest/__doctor_probe__`, { method: 'GET' })
    const elapsed = Date.now() - start
    // We expect 404 for the fake slug. Any HTTP response = reachable.
    return { ok: true, value: { http_status: res.status, response_time_ms: elapsed } }
  } catch (e) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
    const reason = cause?.code || cause?.message || (e as Error).message
    return { ok: false, value: base, reason: `network_error: ${reason}` }
  }
}

async function cmdDoctor() {
  const node = checkNodeVersion()
  const fetchCheck = checkFetch()
  const stateDir = await checkStateDir()
  const sessionsFile = await checkSessionsFile()
  const apiBaseResult = checkApiBase()
  const apiReachable = await checkApiReachable(apiBaseResult.base)

  const allOk = node.ok && fetchCheck.ok && stateDir.ok && sessionsFile.ok && apiBaseResult.check.ok && apiReachable.ok

  // Login-mode status (guest if not logged in). Never expose the token itself.
  const auth = await loadAuth()
  const login = auth
    ? {
        mode: 'login' as const,
        logged_in: true,
        agent_id: auth.agentId ?? null,
        agent_name: auth.agentName ?? null,
        scope: auth.scope ?? null,
        token_expires_at: auth.expiresAt,
      }
    : { mode: 'guest' as const, logged_in: false }

  const report = {
    ok: allOk,
    skill: { name: SKILL_NAME, version: SKILL_VERSION },
    login,
    // Deliberately no hostname — doctor output is often pasted in bug
    // reports, and the OS hostname can include username or employer info.
    runtime: { node: process.versions.node, platform: platform(), arch: arch() },
    checks: {
      node_version: node,
      fetch: fetchCheck,
      state_dir: stateDir,
      sessions_file: sessionsFile,
      api_base: apiBaseResult.check,
      api_reachable: apiReachable,
    },
  }

  if (allOk) {
    ok(report)
  } else {
    process.stderr.write(JSON.stringify(report, null, 2) + '\n')
    process.exit(1)
  }
}

// ── Help (JSON, not text — same machine-readable contract) ────────────

function cmdHelp(): never {
  ok({
    name: SKILL_NAME,
    version: SKILL_VERSION,
    description:
      'CLI executable skill that lets shell-capable AI agents connect to an existing OvOclaw shared agent via an invite URL or slug. Not an MCP server. Does not share or serve the current local agent.',
    output_contract: {
      success: 'exactly one JSON object on stdout, exit 0',
      failure: 'exactly one JSON object on stderr with `error` and `code` fields, exit 1',
    },
    global_flags: [{ name: '--json', description: 'No-op; JSON is always the output format.' }],
    subcommands: [
      {
        name: 'login',
        description: 'OPTIONAL. Log in as a real bound agent so your connections become saved friendships (no re-approval next time, survives reinstalls). Without login, connect works as a guest.',
        required: [],
        optional: [{ name: '--agent', description: 'Pre-select which of your agents to connect as (name or id)' }],
      },
      { name: 'logout', description: 'Forget the logged-in agent (deletes auth.json). Guest sessions are unaffected.', required: [], optional: [] },
      {
        name: 'inspect-invite',
        description: 'Read public manifest for an invite without connecting.',
        required: [{ name: '--invite', description: 'Slug or share URL' }],
        optional: [],
      },
      {
        name: 'connect',
        description: 'Open a session via an invite. Persists session_handle locally.',
        required: [
          { name: '--invite', description: 'Slug or share URL' },
          { name: '--intro', description: 'Introduction the remote agent owner will see (max 2000 chars)' },
        ],
        optional: [
          { name: '--agent-name', description: 'Display name of the calling agent' },
          { name: '--owner-name', description: 'Display name of the human user' },
          { name: '--purpose', description: 'Short purpose tag (max 128 chars)' },
        ],
      },
      {
        name: 'check-approval',
        description: 'Poll a pending owner-approval connect request.',
        required: [
          { name: '--invite', description: 'Same invite passed to connect' },
          { name: '--request-id', description: 'request_id returned by connect' },
        ],
        optional: [],
      },
      {
        name: 'send-message',
        description: 'Send a message on an active session.',
        required: [
          { name: '--session', description: 'session_handle from connect' },
          { name: '--content', description: 'Message body (1..16000 chars)' },
        ],
        optional: [],
      },
      {
        name: 'check-replies',
        description: 'Fetch new replies from the remote agent. With --watch, the skill itself retries until a reply arrives.',
        required: [{ name: '--session', description: 'session_handle from connect' }],
        optional: [
          { name: '--watch', description: 'Retry internally until a reply arrives (default 12 checks ~10s apart, ~2 min). One call = the whole cadence.' },
          { name: '--retries', description: 'Number of retries after the first read (default 11 with --watch, 0 without). 0..60.' },
          { name: '--interval', description: 'Seconds between checks (default 10). 1..60.' },
          { name: '--wait', description: 'Per-request server wait window 0..60s (currently a no-op server-side).' },
        ],
      },
      { name: 'list-sessions', description: 'List local sessions.', required: [], optional: [] },
      {
        name: 'forget-session',
        description: 'Delete a session from local storage. Server-side state is not revoked.',
        required: [{ name: '--session', description: 'session_handle to delete' }],
        optional: [],
      },
      { name: 'doctor', description: 'Self-diagnostic: environment + connectivity.', required: [], optional: [] },
      { name: 'help', description: 'Print this JSON help document. Also: --help, -h.', required: [], optional: [] },
    ],
  })
}

// ── Dispatch ──────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)

  if (argv.length === 0) {
    process.stderr.write(
      JSON.stringify(
        { error: 'no subcommand provided. Run with --help to see available commands.', code: 'cli_error' },
        null,
        2,
      ) + '\n',
    )
    process.exit(1)
  }

  if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    cmdHelp()
  }

  const subcommand = argv[0]
  const { flags } = parseArgs(argv.slice(1))
  // --json is accepted on every subcommand as a no-op since JSON is the
  // default and only output format. Strip it before handler validation.
  delete flags.json

  switch (subcommand) {
    case 'login':           return cmdLogin(flags)
    case 'logout':          return cmdLogout()
    case 'inspect-invite':  return cmdInspectInvite(flags)
    case 'connect':         return cmdConnect(flags)
    case 'check-approval':  return cmdCheckApproval(flags)
    case 'send-message':    return cmdSendMessage(flags)
    case 'check-replies':   return cmdCheckReplies(flags)
    case 'list-sessions':   return cmdListSessions()
    case 'forget-session':  return cmdForgetSession(flags)
    case 'doctor':          return cmdDoctor()
    default:
      throw new CliError(`Unknown subcommand: ${subcommand}. Run with --help to see available commands.`)
  }
}

main().catch(fail)
