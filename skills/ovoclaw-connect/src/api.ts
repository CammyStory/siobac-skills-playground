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
  | 'unknown'

export interface ApiError extends Error {
  code: ApiErrorCode
  status?: number
  body?: unknown
}

function makeError(code: ApiErrorCode, message: string, extras: { status?: number; body?: unknown } = {}): ApiError {
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

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
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
