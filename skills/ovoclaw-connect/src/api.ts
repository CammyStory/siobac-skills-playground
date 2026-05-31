import { SKILL_VERSION } from './version.js'

export interface Manifest {
  agent: { id: string; name: string; description?: string; status?: string }
  ovo_protocol?: string
  requires_approval?: boolean
  connect_url?: string
  message_url?: string
  poll_url?: string
  connect_poll_url_template?: string
  approval_poll_interval_seconds?: number
  [k: string]: unknown
}

export type ConnectStatus =
  | 'active'
  | 'awaiting_approval'
  | 'agent_unavailable'
  | 'agent_busy'
  | 'already_connected'
  | 'reauthorized'
  | 'invalid_client_credentials'
  | 'invalid_invite'
  | 'rate_limited'
  | 'blocked_by_owner'

export interface ConnectResponse {
  status: ConnectStatus
  token?: string
  token_expires_at?: string
  client_secret?: string
  your_user_id?: string
  request_id?: string
  conversation_id?: string
  peer_name?: string
  retry_after_seconds?: number
  // Set by the approval-poll endpoint when the connection is already `active`
  // but its one-time token+secret are no longer retrievable (the server holds
  // them only briefly, in memory — cleared on first pickup, after ~5 min, or on
  // a server restart). When true, `token`/`client_secret` are absent.
  token_already_delivered?: boolean
  [k: string]: unknown
}

export interface ConnectInput {
  your_agent_name?: string
  your_owner_name?: string
  introduction: string
  purpose_hint?: string
  client_user_id?: string
  client_secret?: string
}

export interface SendMessageResponse {
  ok: boolean
  message: { id: string; seq: number; [k: string]: unknown }
  agent_message?: unknown
  reply_status?: 'received' | 'pending'
  conversation_id?: string
  your_user_id?: string
  delivery?: unknown
  next_step?: unknown
}

export interface ReplyMessage {
  id: string
  seq: number
  sender_user_id?: string
  content: string
  created_at: string
  [k: string]: unknown
}

export interface PollRepliesResponse {
  messages: ReplyMessage[]
  last_seq: number
  conversation_id?: string
  your_user_id?: string
  delivery?: unknown
}

// Normalized error code surfaced on every ApiError. The CLI layer
// emits this verbatim as the `code` field of the stderr JSON, so
// agents can branch on it without parsing English messages.
export type ApiErrorCode =
  | 'network_error'      // fetch threw (DNS, ECONNREFUSED, TLS, timeout, …)
  | 'invalid_invite'     // 404 invite_not_found / unknown slug
  | 'session_expired'    // 401 with token_expired / invalid_token / missing_token
  | 'auth_blocked'       // 429 from per-IP brute-force throttle
  | 'rate_limited'       // 429 from per-connection / per-IP rate limit
  | 'blocked_by_owner'   // 403 from post-rejection cooldown
  | 'agent_unavailable'  // 409 agent_unavailable
  | 'agent_busy'         // 409 agent_busy / queue_full
  | 'invalid_request'    // 400 client error (schema, missing fields)
  | 'server_error'       // 5xx
  // Login-mode (device-flow) codes:
  | 'authorization_pending' // 401: user hasn't approved the device yet (keep polling)
  | 'slow_down'             // 401: polling too fast (back off)
  | 'access_denied'         // 401: user denied the device approval
  | 'expired_token'         // 401: device code expired before approval
  | 'not_authenticated'     // CLI: no auth.json / not logged in
  | 'server_not_ready'      // 404 on /oauth/*: server doesn't support login mode yet
  | 'unknown'

export interface ApiError extends Error {
  code: ApiErrorCode
  status?: number
  body?: unknown
}

export function makeError(code: ApiErrorCode, message: string, extras: { status?: number; body?: unknown } = {}): ApiError {
  const err = new Error(message) as ApiError
  err.code = code
  if (extras.status !== undefined) err.status = extras.status
  if (extras.body !== undefined) err.body = extras.body
  return err
}

function classifyStatus(status: number, body: { error?: string } | undefined): ApiErrorCode {
  if (status === 400) return 'invalid_request'
  if (status === 401) return 'session_expired'
  if (status === 403) return 'blocked_by_owner'
  if (status === 404) return 'invalid_invite'
  if (status === 409) {
    const e = body?.error ?? ''
    if (e === 'agent_busy' || e === 'queue_full') return 'agent_busy'
    return 'agent_unavailable'
  }
  if (status === 429) {
    return body?.error === 'auth_blocked' ? 'auth_blocked' : 'rate_limited'
  }
  if (status >= 500) return 'server_error'
  return 'unknown'
}

// ── Skill update reminder ─────────────────────────────────────────────
// We tag every request with X-Ovoclaw-Connect-Version; the server echoes the
// latest/min it knows on the response. The CLI attaches a `skill_update` block
// to its output when we're behind, so the agent can tell the user to update.

export interface SkillUpdateNotice {
  current: string
  latest: string
  required: boolean        // true when below the server's minimum supported version
  update_url: string | null
  message: string
}

let seenLatest: string | null = null
let seenMin: string | null = null
let seenUrl: string | null = null

function captureUpdateHeaders(res: Response): void {
  const latest = res.headers.get('x-ovoclaw-connect-latest')
  if (!latest) return // old server without the version hook — stay silent
  seenLatest = latest
  seenMin = res.headers.get('x-ovoclaw-connect-min')
  seenUrl = res.headers.get('x-ovoclaw-connect-update-url')
}

// a < b for dotted numeric versions (e.g. '0.9.0' < '0.10.1').
function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x < y) return true
    if (x > y) return false
  }
  return false
}

// The update notice to surface, or null when we're current / heard nothing.
export function getSkillUpdateNotice(): SkillUpdateNotice | null {
  if (!seenLatest) return null
  const behind = versionLt(SKILL_VERSION, seenLatest)
  const required = !!seenMin && versionLt(SKILL_VERSION, seenMin)
  if (!behind && !required) return null
  return {
    current: SKILL_VERSION,
    latest: seenLatest,
    required,
    update_url: seenUrl,
    message: required
      ? 'This ovoclaw-connect skill is older than the server\'s minimum supported version and may misbehave — update it before relying on it.'
      : 'A newer ovoclaw-connect skill is available — tell the user they can update when convenient.',
  }
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  // Tag every call with our version so the server can tell us (via response
  // headers) when a newer skill is out — see captureUpdateHeaders below.
  init = { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'X-Ovoclaw-Connect-Version': SKILL_VERSION } }
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    // Network-level failure: fetch threw before any HTTP response.
    // Common in Node: DNS failure, ECONNREFUSED, TLS error, timeout.
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
    const reason = cause?.code || cause?.message || (e as Error).message || 'fetch failed'
    throw makeError('network_error', `network_error: ${reason}`)
  }

  // Record the server's version signal on every response (success OR error).
  captureUpdateHeaders(res)

  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }

  if (!res.ok) {
    const b = body as { message?: string; error?: string } | undefined
    const code = classifyStatus(res.status, b)
    const msg = b?.message || b?.error || res.statusText
    throw makeError(code, `${code} (HTTP ${res.status}): ${msg}`, { status: res.status, body })
  }

  return body as T
}

export async function getManifest(host: string, slug: string): Promise<Manifest> {
  return jsonFetch<Manifest>(`${host}/manifest/${encodeURIComponent(slug)}`, {
    method: 'GET',
  })
}

export async function connect(
  host: string,
  slug: string,
  body: ConnectInput,
): Promise<ConnectResponse> {
  return jsonFetch<ConnectResponse>(`${host}/connect/${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Silently mint a fresh bearer token from the long-lived client_secret — no
// owner re-approval, same shadow user / conversation / history. The bearer
// token only lives ~1h; the secret never expires, so this keeps a connection
// alive indefinitely. `introduction` is required by the endpoint but ignored on
// the reauth path (the server returns before any message is created). Any
// status other than 'reauthorized' means the connection is gone (the owner
// disconnected you, or the secret no longer matches) → surfaced as
// session_expired so the caller reconnects with the invite.
export async function reauthorize(
  host: string,
  slug: string,
  clientUserId: string,
  clientSecret: string,
): Promise<{ token: string; token_expires_at: string }> {
  const res = await connect(host, slug, {
    introduction: 'token refresh',
    client_user_id: clientUserId,
    client_secret: clientSecret,
  })
  if (res.status === 'reauthorized' && res.token && res.token_expires_at) {
    return { token: res.token, token_expires_at: res.token_expires_at }
  }
  throw makeError(
    'session_expired',
    `could not refresh the session (status: ${String(res.status ?? 'unknown')}) — the owner may have disconnected you. Reconnect with the invite.`,
  )
}

export async function pollConnect(
  host: string,
  slug: string,
  requestId: string,
): Promise<ConnectResponse> {
  return jsonFetch<ConnectResponse>(
    `${host}/connect/${encodeURIComponent(slug)}/poll/${encodeURIComponent(requestId)}`,
    { method: 'GET' },
  )
}

export async function sendMessage(
  host: string,
  token: string,
  content: string,
): Promise<SendMessageResponse> {
  return jsonFetch<SendMessageResponse>(`${host}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content }),
  })
}

export async function pollReplies(
  host: string,
  token: string,
  sinceSeq: number,
  waitSeconds = 0,
): Promise<PollRepliesResponse> {
  const params = new URLSearchParams({
    since: String(sinceSeq),
    wait: String(waitSeconds),
  })
  return jsonFetch<PollRepliesResponse>(`${host}/poll?${params.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ── Login mode: OAuth device flow ─────────────────────────────────────────
// The connector can OPTIONALLY log in as a real bound agent (scope
// `agent:connect`), which makes the connection a registered friendship instead
// of a guest session. Reuses the same /oauth/* endpoints the share skill uses.
// See docs/login-mode-design.md.

export const CONNECT_CLIENT_ID = 'ovoclaw-connect-cli'
export const CONNECT_SCOPE = 'agent:connect'
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export interface DeviceTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
  account_id?: string
  agent_id?: string | null
  agent_name?: string | null
}

// OAuth endpoints answer with { error, message } and (for the device-flow
// poll) carry their state in `error` at HTTP 401. Map those to our codes; a
// 404 means the server predates login mode.
const OAUTH_ERROR_CODES: Record<string, ApiErrorCode> = {
  authorization_pending: 'authorization_pending',
  slow_down: 'slow_down',
  access_denied: 'access_denied',
  expired_token: 'expired_token',
  invalid_grant: 'expired_token',
}

async function oauthFetch<T>(base: string, path: string, body: Record<string, unknown>): Promise<T> {
  const url = `${base}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ovoclaw-Connect-Version': SKILL_VERSION },
      body: JSON.stringify(body),
    })
  } catch (e) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
    const reason = cause?.code || cause?.message || (e as Error).message || 'fetch failed'
    throw makeError('network_error', `network_error: ${reason}`)
  }
  captureUpdateHeaders(res)
  const text = await res.text()
  let payload: { error?: string; message?: string; [k: string]: unknown }
  try { payload = text ? JSON.parse(text) : {} } catch { payload = { raw: text } as never }

  if (res.status === 404) {
    throw makeError('server_not_ready', 'login: the server does not expose the OAuth device-flow endpoints (HTTP 404) — it may not support login mode yet.', { status: 404, body: payload })
  }
  if (!res.ok) {
    const oauth = payload.error ? OAUTH_ERROR_CODES[payload.error] : undefined
    const code = oauth ?? classifyStatus(res.status, payload)
    const msg = payload.message || payload.error || res.statusText
    throw makeError(code, `${code} (HTTP ${res.status}): ${msg}`, { status: res.status, body: payload })
  }
  return payload as T
}

export async function requestDeviceCode(base: string, agentHint?: string): Promise<DeviceCodeResponse> {
  const body: Record<string, unknown> = { client_id: CONNECT_CLIENT_ID, scope: CONNECT_SCOPE }
  if (agentHint) body.agent_hint = agentHint
  return oauthFetch<DeviceCodeResponse>(base, '/oauth/device/code', body)
}

export async function pollDeviceToken(base: string, deviceCode: string): Promise<DeviceTokenResponse> {
  return oauthFetch<DeviceTokenResponse>(base, '/oauth/device/token', {
    grant_type: DEVICE_CODE_GRANT,
    device_code: deviceCode,
    client_id: CONNECT_CLIENT_ID,
  })
}

export async function refreshAccessToken(base: string, refreshToken: string): Promise<DeviceTokenResponse> {
  return oauthFetch<DeviceTokenResponse>(base, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CONNECT_CLIENT_ID,
  })
}
