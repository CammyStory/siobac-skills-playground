// HTTP client for the OvOclaw owner-side API + OAuth Device Authorization
// endpoints. Every public function here normalizes server errors into the
// same ApiError shape so the CLI layer can emit a stable `code` field for
// agents to branch on.

import type { AuthState } from './state.js'
import { SKILL_VERSION } from './version.js'

export type ApiErrorCode =
  | 'network_error'        // fetch threw (DNS, ECONNREFUSED, TLS, timeout, ...)
  | 'authorization_pending'// device flow: user hasn't approved yet
  | 'slow_down'            // device flow: polling too fast, increase interval
  | 'access_denied'        // device flow: user explicitly denied
  | 'expired_token'        // device flow: device_code expired before approval
  | 'not_authenticated'    // CLI: no auth.json or token expired locally
  | 'session_expired'      // 401: token rejected by server (revoked / expired remotely)
  | 'forbidden'            // 403: token lacks scope, or owner doesn't own this agent
  | 'not_found'            // 404: agent / connection / invite not found
  | 'invalid_request'      // 400: malformed body
  | 'rate_limited'         // 429
  | 'server_error'         // 5xx
  | 'server_not_ready'     // device-flow endpoints not deployed yet (404 on /oauth/*)
  | 'not_implemented_yet'  // CLI: command stubbed pending real implementation
  | 'cli_error'            // local CLI input error
  | 'unknown'

export interface ApiError extends Error {
  code: ApiErrorCode
  status?: number
  body?: unknown
}

export function makeApiError(
  code: ApiErrorCode,
  message: string,
  extras: { status?: number; body?: unknown } = {},
): ApiError {
  const err = new Error(message) as ApiError
  err.code = code
  if (extras.status !== undefined) err.status = extras.status
  if (extras.body !== undefined) err.body = extras.body
  return err
}

const DEFAULT_API_BASE = 'https://api.ovoclaw.com'

export function getApiBase(): string {
  return process.env.OVOCLAW_API_BASE ?? DEFAULT_API_BASE
}

// ── Skill update reminder ─────────────────────────────────────────────
// The server echoes the latest/min skill version on every response (only for
// requests carrying our X-Ovoclaw-Share-Version). We stash the last values
// seen this run; the CLI attaches a `skill_update` block to its output when
// we're behind, so the agent can tell the user to update.

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
  const latest = res.headers.get('x-ovoclaw-share-latest')
  if (!latest) return // old server without the version hook — stay silent
  seenLatest = latest
  seenMin = res.headers.get('x-ovoclaw-share-min')
  seenUrl = res.headers.get('x-ovoclaw-share-update-url')
}

// a < b for dotted numeric versions (e.g. '0.2.0' < '0.10.1'). Non-numeric or
// missing parts read as 0, so it degrades gracefully on odd inputs.
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
      ? 'This ovoclaw-share skill is older than the server\'s minimum supported version and may misbehave — update it before relying on it.'
      : 'A newer ovoclaw-share skill is available — tell the user they can update when convenient.',
  }
}

// ── Wire helpers ──────────────────────────────────────────────────────

interface FetchOpts {
  method: string
  path: string
  bearer?: string
  body?: unknown
  // Used when /oauth/* returns 404 because the server hasn't been updated
  // yet — mapped to a clearer code than just "not_found".
  oauthEndpoint?: boolean
}

function classifyStatus(
  status: number,
  body: { error?: string } | undefined,
  opts: FetchOpts,
): ApiErrorCode {
  if (opts.oauthEndpoint && status === 404) return 'server_not_ready'
  if (status === 400) return 'invalid_request'
  if (status === 401) {
    const e = body?.error ?? ''
    if (e === 'authorization_pending') return 'authorization_pending'
    if (e === 'slow_down') return 'slow_down'
    if (e === 'access_denied') return 'access_denied'
    if (e === 'expired_token') return 'expired_token'
    return 'session_expired'
  }
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'unknown'
}

async function jsonFetch<T>(opts: FetchOpts): Promise<T> {
  const url = `${getApiBase()}${opts.path}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Tag every call with our version so the server can tell us (via reply
    // headers) when a newer skill is out — see captureUpdateHeaders below.
    'X-Ovoclaw-Share-Version': SKILL_VERSION,
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`

  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch (e) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
    const reason = cause?.code || cause?.message || (e as Error).message || 'fetch failed'
    throw makeApiError('network_error', `network_error: ${reason}`)
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
    const b = body as { error?: string; message?: string } | undefined
    const code = classifyStatus(res.status, b, opts)
    const msg = b?.message || b?.error || res.statusText
    throw makeApiError(code, `${code} (HTTP ${res.status}): ${msg}`, { status: res.status, body })
  }

  return body as T
}

// ── OAuth Device Authorization (RFC 8628) ────────────────────────────
// These endpoints don't exist on the OvOclaw server yet — Phase 2 work.
// Calls will return code:server_not_ready until they're deployed.

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export async function requestDeviceCode(scope?: string, agentHint?: string): Promise<DeviceCodeResponse> {
  const body: Record<string, unknown> = {
    client_id: 'ovoclaw-share-cli',
    scope: scope ?? 'agent:share agent:respond',
  }
  // Remembered agent from a prior share — the approval page auto-confirms it
  // when the logged-in account still owns a matching agent.
  if (agentHint) body.agent_hint = agentHint
  return jsonFetch<DeviceCodeResponse>({
    method: 'POST',
    path: '/oauth/device/code',
    body,
    oauthEndpoint: true,
  })
}

export interface DeviceTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
  account_id?: string
  // Agent this token is scoped to act as (set by the approval page's picker).
  agent_id?: string | null
  // Display name of that agent, so we can surface + remember it by name.
  agent_name?: string | null
}

export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResponse> {
  return jsonFetch<DeviceTokenResponse>({
    method: 'POST',
    path: '/oauth/device/token',
    body: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: 'ovoclaw-share-cli',
    },
    oauthEndpoint: true,
  })
}

export async function refreshAccessToken(refreshToken: string): Promise<DeviceTokenResponse> {
  return jsonFetch<DeviceTokenResponse>({
    method: 'POST',
    path: '/oauth/token',
    body: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'ovoclaw-share-cli',
    },
    oauthEndpoint: true,
  })
}

// ── Owner-side API (existing JWT-authed endpoints, to be reused once
//    OAuth-issued tokens are accepted in addition to JWT) ─────────────
//
// Every function takes a `bearer` from the loaded AuthState. The endpoint
// paths mirror what's already implemented in apps/server's agents.routes.ts
// — the Phase 2 server work will add OAuth bearer acceptance to those.

export interface AgentSummary {
  id: string
  name: string
  description?: string
  status?: string
}

export interface ShareInvite {
  id: string
  agent_id: string
  slug: string
  requires_approval: boolean
  created_at: string
  share_url?: string
}

export interface ExternalConnection {
  id: string
  agent_id: string
  status: 'pending' | 'active' | 'paused' | 'rejected' | 'disconnected'
  intro_text?: string
  conversation_id: string
  shadow_user_id: string
  shadow_name?: string
  created_at: string
  accepted_at?: string
  last_seen_at?: string
}

// Who sent it / who's connecting — pulled from the connection's intro_meta.
export interface FriendIdentity {
  agent_name: string | null
  owner_name: string | null
}

export interface InboundMessage {
  id: string
  connection_id: string
  agent_id: string
  agent_name: string
  from?: FriendIdentity
  seq: number
  sender_user_id: string
  content: string
  created_at: string
}

export interface PendingRequest {
  id: string
  agent_id: string
  agent_name: string
  from?: FriendIdentity
  intro_text?: string | null
  intro_meta?: Record<string, unknown> | null
  conversation_id: string | null
  shadow_user_id: string | null
  created_at: string
}

// One thread per friend (connection) — messages still needing a reply, in
// chronological order. The grouped view to DISPLAY to the owner.
export interface InboxThread {
  connection_id: string
  agent_id: string
  agent_name: string
  from: FriendIdentity
  unread_count: number
  latest_at: string
  messages: { id: string; seq: number; content: string; created_at: string }[]
}

export interface InboxSnapshot {
  pending_requests: PendingRequest[]
  new_messages: InboundMessage[]
  threads: InboxThread[]
  // True when more unanswered inbound existed than the server returned — the
  // caller should drain via respond/read-conversation rather than assume this
  // is the full set.
  new_messages_truncated: boolean
  last_seq_by_connection: Record<string, number>
}

export async function listMyAgents(bearer: string): Promise<AgentSummary[]> {
  return jsonFetch<AgentSummary[]>({ method: 'GET', path: '/agents', bearer })
}

export async function createShare(
  bearer: string,
  agentId: string,
  options: { requires_approval?: boolean },
): Promise<ShareInvite> {
  return jsonFetch<ShareInvite>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-invite`,
    bearer,
    body: options,
  })
}

export interface ShareListEntry {
  agent_id: string
  agent_name: string
  invite: {
    id: string
    slug: string
    requires_approval: boolean
    created_at: string
  }
  share_url: string
}

export async function listShares(bearer: string): Promise<ShareListEntry[]> {
  // Phase 3: server-side aggregate over every agent the owner owns
  // (GET /agents/external-shares).
  return jsonFetch<ShareListEntry[]>({ method: 'GET', path: '/agents/external-shares', bearer })
}

export async function revokeShare(bearer: string, agentId: string): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>({
    method: 'DELETE',
    path: `/agents/${encodeURIComponent(agentId)}/external-invite`,
    bearer,
  })
}

export async function regenerateShare(
  bearer: string,
  agentId: string,
  options: { requires_approval?: boolean } = {},
): Promise<ShareInvite> {
  return jsonFetch<ShareInvite>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-invite/regenerate`,
    bearer,
    body: options,
  })
}

export async function listConnections(
  bearer: string,
  agentId: string,
): Promise<ExternalConnection[]> {
  return jsonFetch<ExternalConnection[]>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections`,
    bearer,
  })
}

export async function actOnConnection(
  bearer: string,
  agentId: string,
  connectionId: string,
  action: 'accept' | 'reject' | 'disconnect' | 'pause' | 'resume' | 'rotate-token',
): Promise<ExternalConnection | { ok: true }> {
  return jsonFetch<ExternalConnection | { ok: true }>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/${action}`,
    bearer,
  })
}

export async function fetchInbox(bearer: string): Promise<InboxSnapshot> {
  // Phase 3: server-side aggregate (GET /agents/external-inbox) — pending
  // requests + unanswered inbound messages + a per-connection seq high-water
  // map, all scoped to the owner's agents.
  return jsonFetch<InboxSnapshot>({ method: 'GET', path: '/agents/external-inbox', bearer })
}

export async function postReply(
  bearer: string,
  agentId: string,
  connectionId: string,
  content: string,
): Promise<{ ok: true; seq: number; message_id: string; conversation_id: string }> {
  return jsonFetch<{ ok: true; seq: number; message_id: string; conversation_id: string }>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/respond`,
    bearer,
    body: { content },
  })
}

export interface ConversationMessage {
  id: string
  seq: number
  content: string
  message_type: string
  sender_user_id: string
  sender_name: string | null
  direction: 'inbound' | 'outbound'
  created_at: string
}

export interface ConversationHistory {
  conversation_id: string | null
  shadow_user_id: string | null
  messages: ConversationMessage[]
  last_seq: number
  has_more: boolean
}

export async function readConversation(
  bearer: string,
  agentId: string,
  connectionId: string,
  opts: { since?: number; limit?: number } = {},
): Promise<ConversationHistory> {
  const params = new URLSearchParams()
  if (opts.since !== undefined) params.set('since', String(opts.since))
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return jsonFetch<ConversationHistory>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/conversation${qs ? `?${qs}` : ''}`,
    bearer,
  })
}

// Re-export the AuthState type for convenience in cli.ts.
export type { AuthState }
