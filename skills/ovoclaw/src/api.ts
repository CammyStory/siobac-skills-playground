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
  // ── Reach-out (active connect) codes, from the merged connect transport ──
  | 'invalid_invite'       // 404: unknown slug / invite_not_found
  | 'agent_unavailable'    // 409: the shared agent is stopped/unavailable
  | 'agent_busy'           // 409: agent_busy / queue_full (single-user mode)
  | 'blocked_by_owner'     // 403: post-rejection cooldown on the connect side
  | 'auth_blocked'         // 429: per-IP brute-force throttle
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

// This is the TEST/playground build: it targets the dev environment (the /dev
// tunnel to the local server) so testing never touches public production data.
// The polished public release points at https://api.ovoclaw.com instead.
// Override anytime with OVOCLAW_API_BASE.
const DEFAULT_API_BASE = 'https://ovo.ovoclaw.com/dev'

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
  // Enriched by the CLI before surfacing (see cli.ts): the exact on-disk skill
  // folder and a concrete, copy-pasteable update instruction.
  skill_path?: string
  how_to_update?: string
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
      ? 'This ovoclaw skill is older than the server\'s minimum supported version and may misbehave — update it before relying on it.'
      : 'A newer ovoclaw skill is available — tell the user they can update when convenient.',
  }
}

// Definitive freshness verdict, ALWAYS returned (never null). Actively probes
// the server — sends our version to /health and captures the reply headers —
// so a fresh process (e.g. `doctor`, which ran no other command) still knows
// whether it's current. Falls back to whatever was already seen this run if the
// probe can't reach the server.
export interface VersionStatus {
  up_to_date: boolean
  current: string
  latest: string | null
  required: boolean        // below the server's MINIMUM supported version
  update_url: string | null
  reachable: boolean       // false → couldn't reach the server to check
}
export async function getVersionStatus(): Promise<VersionStatus> {
  let reachable = false
  try {
    const res = await fetch(`${getApiBase()}/health`, {
      method: 'GET',
      headers: { 'X-Ovoclaw-Share-Version': SKILL_VERSION },
    })
    captureUpdateHeaders(res)
    reachable = true
  } catch {
    /* offline — doctor's own api_reachable check reports the network error */
  }
  const behind = !!seenLatest && versionLt(SKILL_VERSION, seenLatest)
  const required = !!seenMin && versionLt(SKILL_VERSION, seenMin)
  return {
    up_to_date: reachable && !behind && !required,
    current: SKILL_VERSION,
    latest: seenLatest,
    required,
    update_url: seenUrl,
    reachable,
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
    // Unified skill: one login both serves (share/respond) AND reaches out as a
    // registered agent (connect). The server gate grants each capability per
    // scope; guest reach-out needs no token at all.
    scope: scope ?? 'agent:share agent:respond agent:connect',
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

// Toggle whether new connections need the owner's approval — IN PLACE, keeping
// the SAME slug/QR (PATCH, not regenerate). Returns the unchanged invite with the
// new flag.
export async function updateShareApproval(
  bearer: string,
  agentId: string,
  requiresApproval: boolean,
): Promise<ShareInvite> {
  return jsonFetch<ShareInvite>({
    method: 'PATCH',
    path: `/agents/${encodeURIComponent(agentId)}/external-invite`,
    bearer,
    body: { requires_approval: requiresApproval },
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

// ── Directive (private, owner-only) ──────────────────────────────────
// The owner's prescriptive instructions to the agent (rules + purpose +
// info-handling standard). Private; only the owner reads/edits it; it is NEVER
// disclosed to a connecting friend.
export async function getDirective(bearer: string, agentId: string): Promise<{ content: string }> {
  return jsonFetch<{ content: string }>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/directive`,
    bearer,
  })
}

export async function setDirective(bearer: string, agentId: string, content: string): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>({
    method: 'PUT',
    path: `/agents/${encodeURIComponent(agentId)}/directive`,
    bearer,
    body: { content },
  })
}

// ── Agent profile (public card) — onboarding read + owner edit ───────
export interface AgentProfile {
  name: string
  description: string
  avatar_url: string | null
  directive: string
  profile_complete: boolean
  directive_set: boolean
  is_new: boolean
}
export async function getAgentProfile(bearer: string, agentId: string): Promise<AgentProfile> {
  return jsonFetch<AgentProfile>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/profile`,
    bearer,
  })
}
export async function setAgentProfile(
  bearer: string, agentId: string, patch: { name?: string; description?: string },
): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>({
    method: 'PUT',
    path: `/agents/${encodeURIComponent(agentId)}/profile`,
    bearer,
    body: patch,
  })
}

// ── Read-before-talk context + write-after-talk memory ───────────────
export interface FriendMemoryItem {
  id: string
  kind: 'fact' | 'preference' | 'event' | 'summary'
  content: string
  disclosure: 'private' | 'friend_shared'
  confidence: number | null
  source_seq: number | null
  updated_at: string
}
export interface TalkContext {
  // directive.disclose is always false — it shapes HOW you reply, never shown.
  directive: { content: string; disclose: false }
  profile: { name: string; description: string | null; avatar_url: string | null } | null
  friend_memory: FriendMemoryItem[]
  mode: 'guest' | 'registered'
}
export async function getTalkContext(
  bearer: string, agentId: string, connectionId: string,
): Promise<TalkContext> {
  return jsonFetch<TalkContext>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/context`,
    bearer,
  })
}

export interface MemoryDelta {
  op: 'add' | 'update' | 'supersede'
  scope: 'friend'
  friend_id: string
  kind: 'fact' | 'preference' | 'event' | 'summary'
  content: string
  disclosure?: 'private' | 'friend_shared'
  confidence?: number
  supersedes?: string
  source_seq?: number
}
export async function submitMemory(
  bearer: string, agentId: string, connectionId: string, deltas: MemoryDelta[],
): Promise<{ ok: true; applied: number }> {
  return jsonFetch<{ ok: true; applied: number }>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/memory`,
    bearer,
    body: { memory_deltas: deltas },
  })
}

// ── Auto-Response (server-driven; docs/auto-response-design.md) ──────
// The owner hands a connection a natural-language PURPOSE; the server's
// event-driven loop composes (LLM) + sends each reply IN CHARACTER on the
// owner's behalf, toward the purpose, until it's met / capped / the owner stops.
// Owner-side, one inbound connection at a time.
// mode: 'auto' = compose + SEND each reply directly; 'draft' = hold each reply
// for the owner to approve (auto-approve) before it sends.
export type AutoMode = 'auto' | 'draft'
export interface AutoSession {
  id?: string
  connection_id?: string
  agent_id?: string
  purpose?: string
  status: 'running' | 'paused_checkpoint' | 'done' | 'interrupted' | 'stalled' | 'failed' | 'none' | 'no_draft'
  mode?: AutoMode
  turn_count?: number
  max_turns?: number
  result_summary?: string | null
  reason?: string | null
  // Draft mode: the reply waiting for approval (auto-status surfaces it too).
  pending_draft?: string | null
  pending_draft_done?: number
  created_at?: string
  updated_at?: string
  last_tick_at?: string | null
  warning?: string   // e.g. relay-backed agent (auto only fills in while offline)
}

export async function autoStart(
  bearer: string, agentId: string, connectionId: string, purpose: string, maxTurns?: number, mode?: AutoMode,
): Promise<AutoSession> {
  return jsonFetch<AutoSession>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-start`,
    bearer,
    body: { purpose, ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}), ...(mode ? { mode } : {}) },
  })
}

// Draft mode: approve (optionally edited) the reply the agent drafted, sending
// it and advancing the session.
export async function autoApprove(
  bearer: string, agentId: string, connectionId: string, edited?: string,
): Promise<AutoSession> {
  return jsonFetch<AutoSession>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-approve`,
    bearer,
    ...(edited !== undefined ? { body: { edited } } : {}),
  })
}

// Recurring report: draft-mode replies waiting for owner approval, across the
// bound agent's connections. `check` surfaces these every time until handled.
export interface AutoDraft {
  connection_id: string
  purpose: string
  turn_count: number
  draft: string
  would_finalize: boolean
}
export async function autoDrafts(bearer: string, agentId: string): Promise<AutoDraft[]> {
  const r = await jsonFetch<{ drafts: AutoDraft[] }>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/auto-drafts`,
    bearer,
  })
  return r.drafts
}

// ── Auto-converse v2: per-agent opt-in + checkpoints + resume ─────────────
// When auto_converse is ON, every connection this agent is part of auto-responds
// by default (no auto-start) — and if the other end's agent is also on, the two
// agents converse on their own. The owner watches via `check` and steers via
// auto-resume; a soft checkpoint pauses them every few turns.
export async function getAutoConverse(bearer: string, agentId: string): Promise<{ enabled: boolean }> {
  return jsonFetch<{ enabled: boolean }>({ method: 'GET', path: `/agents/${encodeURIComponent(agentId)}/auto-converse`, bearer })
}
export async function setAutoConverse(bearer: string, agentId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return jsonFetch<{ enabled: boolean }>({ method: 'PUT', path: `/agents/${encodeURIComponent(agentId)}/auto-converse`, bearer, body: { enabled } })
}

// A conversation paused at a soft checkpoint, awaiting continue / steer / wrap-up.
export interface AutoCheckpoint {
  connection_id: string
  side: 'owner' | 'connector'
  turn_count: number
  purpose: string
}
export async function autoCheckpoints(bearer: string, agentId: string): Promise<AutoCheckpoint[]> {
  const r = await jsonFetch<{ checkpoints: AutoCheckpoint[] }>({
    method: 'GET', path: `/agents/${encodeURIComponent(agentId)}/auto-checkpoints`, bearer,
  })
  return r.checkpoints
}

// Continue a checkpoint-paused conversation. An optional purpose re-points
// (steers) both sides' goal; '' clears it back to free chat.
export async function autoResume(bearer: string, agentId: string, connectionId: string, purpose?: string): Promise<AutoSession> {
  return jsonFetch<AutoSession>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-resume`,
    bearer,
    ...(purpose !== undefined ? { body: { purpose } } : {}),
  })
}
export async function autoStop(bearer: string, agentId: string, connectionId: string): Promise<AutoSession> {
  return jsonFetch<AutoSession>({
    method: 'POST',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-stop`,
    bearer,
  })
}
export async function autoStatus(bearer: string, agentId: string, connectionId: string): Promise<AutoSession> {
  return jsonFetch<AutoSession>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-status`,
    bearer,
  })
}

// Report-back: finished auto-sessions the owner hasn't been shown yet (drains
// them, each surfaced once). `check` calls this so the agent can tell the owner
// the outcome of an auto-conversation that ran while they were away.
export interface AutoUpdate {
  connection_id: string
  status: 'done' | 'stalled' | 'failed'
  purpose?: string
  turn_count?: number
  result_summary?: string | null
  reason?: string | null
}
export async function autoUpdates(bearer: string, agentId: string): Promise<AutoUpdate[]> {
  const r = await jsonFetch<{ updates: AutoUpdate[] }>({
    method: 'GET',
    path: `/agents/${encodeURIComponent(agentId)}/auto-updates`,
    bearer,
  })
  return r.updates
}

// ── Reach-out transport (active connect) ─────────────────────────────
// These talk to a FULL host (resolved from the invite by parseInvite), not
// getApiBase(): an invite can point at any server/prefix. connect/manifest are
// unauthenticated; message/poll use the per-connection bearer (xext_) returned
// at connect. (A logged-in connect ALSO passes the owner login bearer so the
// server makes it a REGISTERED friendship; guest connect passes none.)
export interface Manifest {
  agent: { id: string; name: string; description?: string; status?: string }
  ovo_protocol?: string
  requires_approval?: boolean
  [k: string]: unknown
}
export type ConnectStatus =
  | 'active' | 'awaiting_approval' | 'agent_unavailable' | 'agent_busy'
  | 'already_connected' | 'reauthorized' | 'invalid_client_credentials'
  | 'invalid_invite' | 'rate_limited' | 'blocked_by_owner'
export interface ConnectResponse {
  status: ConnectStatus
  token?: string; token_expires_at?: string; client_secret?: string
  your_user_id?: string; request_id?: string; conversation_id?: string
  peer_name?: string; registered?: boolean; retry_after_seconds?: number
  [k: string]: unknown
}
export interface ConnectInput {
  your_agent_name?: string; your_owner_name?: string
  introduction: string; purpose_hint?: string
  client_user_id?: string; client_secret?: string
}
export interface SendMessageResponse {
  ok: boolean; message: { id: string; seq: number; [k: string]: unknown }
  agent_message?: unknown; reply_status?: 'received' | 'pending'
  conversation_id?: string; your_user_id?: string; delivery?: unknown
}
export interface ReplyMessage {
  id: string; seq: number; sender_user_id?: string; content: string; created_at: string
  [k: string]: unknown
}
export interface PollRepliesResponse {
  messages: ReplyMessage[]; last_seq: number; conversation_id?: string
  your_user_id?: string; delivery?: unknown
}

function classifyInviteStatus(status: number, body: { error?: string } | undefined): ApiErrorCode {
  if (status === 400) return 'invalid_request'
  if (status === 401) return 'session_expired'
  if (status === 403) return 'blocked_by_owner'
  if (status === 404) return 'invalid_invite'
  if (status === 409) return body?.error === 'agent_busy' || body?.error === 'queue_full' ? 'agent_busy' : 'agent_unavailable'
  if (status === 429) return body?.error === 'auth_blocked' ? 'auth_blocked' : 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'unknown'
}

// Full-URL fetch (no getApiBase prefix) with the same error normalization shape.
async function inviteFetch<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
    const reason = cause?.code || cause?.message || (e as Error).message || 'fetch failed'
    throw makeApiError('network_error', `network_error: ${reason}`)
  }
  const text = await res.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!res.ok) {
    const b = body as { message?: string; error?: string } | undefined
    const code = classifyInviteStatus(res.status, b)
    throw makeApiError(code, `${code} (HTTP ${res.status}): ${b?.message || b?.error || res.statusText}`, { status: res.status, body })
  }
  return body as T
}

export async function getManifest(host: string, slug: string): Promise<Manifest> {
  return inviteFetch<Manifest>(`${host}/manifest/${encodeURIComponent(slug)}`, { method: 'GET' })
}
// bearer: the owner login token → REGISTERED connect; omit → GUEST connect.
export async function connectToInvite(host: string, slug: string, body: ConnectInput, bearer?: string): Promise<ConnectResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`
  return inviteFetch<ConnectResponse>(`${host}/connect/${encodeURIComponent(slug)}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
}
export async function pollConnect(host: string, slug: string, requestId: string): Promise<ConnectResponse> {
  return inviteFetch<ConnectResponse>(`${host}/connect/${encodeURIComponent(slug)}/poll/${encodeURIComponent(requestId)}`, { method: 'GET' })
}
export async function sendToConnection(host: string, token: string, content: string): Promise<SendMessageResponse> {
  return inviteFetch<SendMessageResponse>(`${host}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content }),
  })
}
export async function pollConnectionReplies(host: string, token: string, sinceSeq: number, waitSeconds = 0): Promise<PollRepliesResponse> {
  const params = new URLSearchParams({ since: String(sinceSeq), wait: String(waitSeconds) })
  return inviteFetch<PollRepliesResponse>(`${host}/poll?${params.toString()}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
}

// ── Connector-side auto-response (the agent that connected OUT drives ITS side).
// Token-authed, full-URL like message/poll. Mirrors the owner-side auto-* but on
// an OUTBOUND conversation. The server arms side='connector'. Registered
// (logged-in) connections only — guests have no agent to auto-respond as.
function authHdr(token: string, json = false): Record<string, string> {
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` }
}
export async function autoStartOut(host: string, token: string, purpose: string, maxTurns?: number, mode?: AutoMode): Promise<AutoSession> {
  return inviteFetch<AutoSession>(`${host}/auto/start`, {
    method: 'POST', headers: authHdr(token, true),
    body: JSON.stringify({ purpose, ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}), ...(mode ? { mode } : {}) }),
  })
}
export async function autoStopOut(host: string, token: string): Promise<AutoSession> {
  return inviteFetch<AutoSession>(`${host}/auto/stop`, { method: 'POST', headers: authHdr(token) })
}
export async function autoStatusOut(host: string, token: string): Promise<AutoSession> {
  return inviteFetch<AutoSession>(`${host}/auto/status`, { method: 'GET', headers: authHdr(token) })
}
export async function autoResumeOut(host: string, token: string, purpose?: string): Promise<AutoSession> {
  return inviteFetch<AutoSession>(`${host}/auto/resume`, {
    method: 'POST', headers: authHdr(token, purpose !== undefined),
    ...(purpose !== undefined ? { body: JSON.stringify({ purpose }) } : {}),
  })
}

// Re-export the AuthState type for convenience in cli.ts.
export type { AuthState }
