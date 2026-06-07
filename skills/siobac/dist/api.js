// HTTP client for the Siobac owner-side API + OAuth Device Authorization
// endpoints. Every public function here normalizes server errors into the
// same ApiError shape so the CLI layer can emit a stable `code` field for
// agents to branch on.
import { SKILL_VERSION } from './version.js';
export function makeApiError(code, message, extras = {}) {
    const err = new Error(message);
    err.code = code;
    if (extras.status !== undefined)
        err.status = extras.status;
    if (extras.body !== undefined)
        err.body = extras.body;
    return err;
}
// This is the TEST/playground build: it targets the dev environment (the /dev
// tunnel to the local server) so testing never touches public production data.
// The polished public release points at https://api.ovoclaw.com instead.
// (The Siobac brand keeps the ovoclaw.com backend domain.) Override anytime with
// SIOBAC_API_BASE (legacy OVOCLAW_API_BASE still honored).
const DEFAULT_API_BASE = 'https://ovo.ovoclaw.com/dev';
export function getApiBase() {
    return process.env.SIOBAC_API_BASE ?? process.env.OVOCLAW_API_BASE ?? DEFAULT_API_BASE;
}
let seenLatest = null;
let seenMin = null;
let seenUrl = null;
function captureUpdateHeaders(res) {
    // Prefer the new x-siobac-* headers; fall back to legacy x-ovoclaw-* so the
    // skill still reads update info from an older server that hasn't switched.
    const latest = res.headers.get('x-siobac-share-latest') ?? res.headers.get('x-ovoclaw-share-latest');
    if (!latest)
        return; // old server without the version hook — stay silent
    seenLatest = latest;
    seenMin = res.headers.get('x-siobac-share-min') ?? res.headers.get('x-ovoclaw-share-min');
    seenUrl = res.headers.get('x-siobac-share-update-url') ?? res.headers.get('x-ovoclaw-share-update-url');
}
// a < b for dotted numeric versions (e.g. '0.2.0' < '0.10.1'). Non-numeric or
// missing parts read as 0, so it degrades gracefully on odd inputs.
function versionLt(a, b) {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0, y = pb[i] ?? 0;
        if (x < y)
            return true;
        if (x > y)
            return false;
    }
    return false;
}
// The update notice to surface, or null when we're current / heard nothing.
export function getSkillUpdateNotice() {
    if (!seenLatest)
        return null;
    const behind = versionLt(SKILL_VERSION, seenLatest);
    const required = !!seenMin && versionLt(SKILL_VERSION, seenMin);
    if (!behind && !required)
        return null;
    return {
        current: SKILL_VERSION,
        latest: seenLatest,
        required,
        update_url: seenUrl,
        message: required
            ? 'This siobac skill is older than the server\'s minimum supported version and may misbehave — update it before relying on it.'
            : 'A newer siobac skill is available — tell the user they can update when convenient.',
    };
}
export async function getVersionStatus() {
    let reachable = false;
    try {
        const res = await fetch(`${getApiBase()}/health`, {
            method: 'GET',
            headers: { 'X-Siobac-Share-Version': SKILL_VERSION },
        });
        captureUpdateHeaders(res);
        reachable = true;
    }
    catch {
        /* offline — doctor's own api_reachable check reports the network error */
    }
    const behind = !!seenLatest && versionLt(SKILL_VERSION, seenLatest);
    const required = !!seenMin && versionLt(SKILL_VERSION, seenMin);
    return {
        up_to_date: reachable && !behind && !required,
        current: SKILL_VERSION,
        latest: seenLatest,
        required,
        update_url: seenUrl,
        reachable,
    };
}
function classifyStatus(status, body, opts) {
    if (opts.oauthEndpoint && status === 404)
        return 'server_not_ready';
    if (status === 400)
        return 'invalid_request';
    if (status === 401) {
        const e = body?.error ?? '';
        if (e === 'authorization_pending')
            return 'authorization_pending';
        if (e === 'slow_down')
            return 'slow_down';
        if (e === 'access_denied')
            return 'access_denied';
        if (e === 'expired_token')
            return 'expired_token';
        return 'session_expired';
    }
    if (status === 403)
        return 'forbidden';
    if (status === 404)
        return 'not_found';
    if (status === 429)
        return 'rate_limited';
    if (status >= 500)
        return 'server_error';
    return 'unknown';
}
async function jsonFetch(opts) {
    const url = `${getApiBase()}${opts.path}`;
    const headers = {
        Accept: 'application/json',
        // Tag every call with our version so the server can tell us (via reply
        // headers) when a newer skill is out — see captureUpdateHeaders below.
        'X-Ovoclaw-Share-Version': SKILL_VERSION,
    };
    if (opts.body !== undefined)
        headers['Content-Type'] = 'application/json';
    if (opts.bearer)
        headers['Authorization'] = `Bearer ${opts.bearer}`;
    let res;
    try {
        res = await fetch(url, {
            method: opts.method,
            headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
    }
    catch (e) {
        const cause = e.cause;
        const reason = cause?.code || cause?.message || e.message || 'fetch failed';
        throw makeApiError('network_error', `network_error: ${reason}`);
    }
    // Record the server's version signal on every response (success OR error).
    captureUpdateHeaders(res);
    const text = await res.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    }
    catch {
        body = { raw: text };
    }
    if (!res.ok) {
        const b = body;
        const code = classifyStatus(res.status, b, opts);
        const msg = b?.message || b?.error || res.statusText;
        throw makeApiError(code, `${code} (HTTP ${res.status}): ${msg}`, { status: res.status, body });
    }
    return body;
}
export async function requestDeviceCode(scope, agentHint) {
    const body = {
        client_id: 'ovoclaw-share-cli',
        // Unified skill: one login both serves (share/respond) AND reaches out as a
        // registered agent (connect). The server gate grants each capability per
        // scope; guest reach-out needs no token at all.
        scope: scope ?? 'agent:share agent:respond agent:connect',
    };
    // Remembered agent from a prior share — the approval page auto-confirms it
    // when the logged-in account still owns a matching agent.
    if (agentHint)
        body.agent_hint = agentHint;
    return jsonFetch({
        method: 'POST',
        path: '/oauth/device/code',
        body,
        oauthEndpoint: true,
    });
}
export async function pollDeviceToken(deviceCode) {
    return jsonFetch({
        method: 'POST',
        path: '/oauth/device/token',
        body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            client_id: 'ovoclaw-share-cli',
        },
        oauthEndpoint: true,
    });
}
export async function refreshAccessToken(refreshToken) {
    return jsonFetch({
        method: 'POST',
        path: '/oauth/token',
        body: {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: 'ovoclaw-share-cli',
        },
        oauthEndpoint: true,
    });
}
export async function listMyAgents(bearer) {
    return jsonFetch({ method: 'GET', path: '/agents', bearer });
}
export async function createShare(bearer, agentId, options) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-invite`,
        bearer,
        body: options,
    });
}
// Toggle whether new connections need the owner's approval — IN PLACE, keeping
// the SAME slug/QR (PATCH, not regenerate). Returns the unchanged invite with the
// new flag.
export async function updateShareApproval(bearer, agentId, requiresApproval) {
    return jsonFetch({
        method: 'PATCH',
        path: `/agents/${encodeURIComponent(agentId)}/external-invite`,
        bearer,
        body: { requires_approval: requiresApproval },
    });
}
export async function listShares(bearer) {
    // Phase 3: server-side aggregate over every agent the owner owns
    // (GET /agents/external-shares).
    return jsonFetch({ method: 'GET', path: '/agents/external-shares', bearer });
}
export async function revokeShare(bearer, agentId) {
    return jsonFetch({
        method: 'DELETE',
        path: `/agents/${encodeURIComponent(agentId)}/external-invite`,
        bearer,
    });
}
export async function regenerateShare(bearer, agentId, options = {}) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-invite/regenerate`,
        bearer,
        body: options,
    });
}
export async function listConnections(bearer, agentId) {
    return jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections`,
        bearer,
    });
}
export async function actOnConnection(bearer, agentId, connectionId, action) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/${action}`,
        bearer,
    });
}
export async function fetchInbox(bearer) {
    // Phase 3: server-side aggregate (GET /agents/external-inbox) — pending
    // requests + unanswered inbound messages + a per-connection seq high-water
    // map, all scoped to the owner's agents.
    return jsonFetch({ method: 'GET', path: '/agents/external-inbox', bearer });
}
export async function postReply(bearer, agentId, connectionId, content) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/respond`,
        bearer,
        body: { content },
    });
}
export async function readConversation(bearer, agentId, connectionId, opts = {}) {
    const params = new URLSearchParams();
    if (opts.since !== undefined)
        params.set('since', String(opts.since));
    if (opts.limit !== undefined)
        params.set('limit', String(opts.limit));
    const qs = params.toString();
    return jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/conversation${qs ? `?${qs}` : ''}`,
        bearer,
    });
}
// ── Directive (private, owner-only) ──────────────────────────────────
// The owner's prescriptive instructions to the agent (rules + purpose +
// info-handling standard). Private; only the owner reads/edits it; it is NEVER
// disclosed to a connecting friend.
export async function getDirective(bearer, agentId) {
    return jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/directive`,
        bearer,
    });
}
export async function setDirective(bearer, agentId, content, ownerMsgSeq) {
    return jsonFetch({
        method: 'PUT',
        path: `/agents/${encodeURIComponent(agentId)}/directive`,
        bearer,
        body: ownerMsgSeq !== undefined ? { content, owner_msg_seq: ownerMsgSeq } : { content },
    });
}
export async function getAgentProfile(bearer, agentId) {
    return jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/profile`,
        bearer,
    });
}
export async function setAgentProfile(bearer, agentId, patch) {
    return jsonFetch({
        method: 'PUT',
        path: `/agents/${encodeURIComponent(agentId)}/profile`,
        bearer,
        body: patch,
    });
}
export async function getTalkContext(bearer, agentId, connectionId) {
    return jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/context`,
        bearer,
    });
}
export async function submitMemory(bearer, agentId, connectionId, deltas) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/memory`,
        bearer,
        body: { memory_deltas: deltas },
    });
}
export async function autoStart(bearer, agentId, connectionId, purpose, maxTurns, mode) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-start`,
        bearer,
        body: { purpose, ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}), ...(mode ? { mode } : {}) },
    });
}
// Draft mode: approve (optionally edited) the reply the agent drafted, sending
// it and advancing the session.
export async function autoApprove(bearer, agentId, connectionId, edited) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-approve`,
        bearer,
        ...(edited !== undefined ? { body: { edited } } : {}),
    });
}
export async function autoDrafts(bearer, agentId) {
    const r = await jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/auto-drafts`,
        bearer,
    });
    return r.drafts;
}
// ── Auto-converse v2: per-agent opt-in + checkpoints + resume ─────────────
// When auto_converse is ON, every connection this agent is part of auto-responds
// by default (no auto-start) — and if the other end's agent is also on, the two
// agents converse on their own. The owner watches via `check` and steers via
// auto-resume; a soft checkpoint pauses them every few turns.
export async function getAutoConverse(bearer, agentId) {
    return jsonFetch({ method: 'GET', path: `/agents/${encodeURIComponent(agentId)}/auto-converse`, bearer });
}
export async function setAutoConverse(bearer, agentId, enabled) {
    return jsonFetch({ method: 'PUT', path: `/agents/${encodeURIComponent(agentId)}/auto-converse`, bearer, body: { enabled } });
}
export async function autoCheckpoints(bearer, agentId) {
    const r = await jsonFetch({
        method: 'GET', path: `/agents/${encodeURIComponent(agentId)}/auto-checkpoints`, bearer,
    });
    return r.checkpoints;
}
// Continue a checkpoint-paused conversation. An optional purpose re-points
// (steers) both sides' goal; '' clears it back to free chat.
export async function autoResume(bearer, agentId, connectionId, purpose) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-resume`,
        bearer,
        ...(purpose !== undefined ? { body: { purpose } } : {}),
    });
}
export async function autoStop(bearer, agentId, connectionId) {
    return jsonFetch({
        method: 'POST',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-stop`,
        bearer,
    });
}
export async function autoStatus(bearer, agentId, connectionId) {
    return jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connectionId)}/auto-status`,
        bearer,
    });
}
export async function autoUpdates(bearer, agentId) {
    const r = await jsonFetch({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agentId)}/auto-updates`,
        bearer,
    });
    return r.updates;
}
function classifyInviteStatus(status, body) {
    if (status === 400)
        return 'invalid_request';
    if (status === 401)
        return 'session_expired';
    if (status === 403)
        return 'blocked_by_owner';
    if (status === 404)
        return 'invalid_invite';
    if (status === 409)
        return body?.error === 'agent_busy' || body?.error === 'queue_full' ? 'agent_busy' : 'agent_unavailable';
    if (status === 429)
        return body?.error === 'auth_blocked' ? 'auth_blocked' : 'rate_limited';
    if (status >= 500)
        return 'server_error';
    return 'unknown';
}
// Full-URL fetch (no getApiBase prefix) with the same error normalization shape.
async function inviteFetch(url, init) {
    let res;
    try {
        res = await fetch(url, init);
    }
    catch (e) {
        const cause = e.cause;
        const reason = cause?.code || cause?.message || e.message || 'fetch failed';
        throw makeApiError('network_error', `network_error: ${reason}`);
    }
    const text = await res.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    }
    catch {
        body = { raw: text };
    }
    if (!res.ok) {
        const b = body;
        const code = classifyInviteStatus(res.status, b);
        throw makeApiError(code, `${code} (HTTP ${res.status}): ${b?.message || b?.error || res.statusText}`, { status: res.status, body });
    }
    return body;
}
export async function getManifest(host, slug) {
    return inviteFetch(`${host}/manifest/${encodeURIComponent(slug)}`, { method: 'GET' });
}
// bearer: the owner login token → REGISTERED connect; omit → GUEST connect.
export async function connectToInvite(host, slug, body, bearer) {
    const headers = { 'Content-Type': 'application/json' };
    if (bearer)
        headers['Authorization'] = `Bearer ${bearer}`;
    return inviteFetch(`${host}/connect/${encodeURIComponent(slug)}`, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
}
export async function pollConnect(host, slug, requestId) {
    return inviteFetch(`${host}/connect/${encodeURIComponent(slug)}/poll/${encodeURIComponent(requestId)}`, { method: 'GET' });
}
export async function sendToConnection(host, token, content) {
    return inviteFetch(`${host}/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content }),
    });
}
export async function pollConnectionReplies(host, token, sinceSeq, waitSeconds = 0, full = false) {
    const params = new URLSearchParams({ since: String(sinceSeq), wait: String(waitSeconds) });
    if (full)
        params.set('full', '1'); // whole-conversation read (both directions)
    return inviteFetch(`${host}/poll?${params.toString()}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
}
// ── Connector-side auto-response (the agent that connected OUT drives ITS side).
// Token-authed, full-URL like message/poll. Mirrors the owner-side auto-* but on
// an OUTBOUND conversation. The server arms side='connector'. Registered
// (logged-in) connections only — guests have no agent to auto-respond as.
function authHdr(token, json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` };
}
export async function autoStartOut(host, token, purpose, maxTurns, mode) {
    return inviteFetch(`${host}/auto/start`, {
        method: 'POST', headers: authHdr(token, true),
        body: JSON.stringify({ purpose, ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}), ...(mode ? { mode } : {}) }),
    });
}
export async function autoStopOut(host, token) {
    return inviteFetch(`${host}/auto/stop`, { method: 'POST', headers: authHdr(token) });
}
export async function autoStatusOut(host, token) {
    return inviteFetch(`${host}/auto/status`, { method: 'GET', headers: authHdr(token) });
}
export async function autoResumeOut(host, token, purpose) {
    return inviteFetch(`${host}/auto/resume`, {
        method: 'POST', headers: authHdr(token, purpose !== undefined),
        ...(purpose !== undefined ? { body: JSON.stringify({ purpose }) } : {}),
    });
}
export async function brainOwnerChannelRead(bearer, agentId, since = 0) {
    return jsonFetch({ method: 'GET', path: `/agents/${encodeURIComponent(agentId)}/owner-channel?since=${since}`, bearer });
}
export async function brainOwnerChannelPost(bearer, agentId, from, text) {
    return jsonFetch({ method: 'POST', path: `/agents/${encodeURIComponent(agentId)}/owner-channel`, bearer, body: { from, text } });
}
export async function brainHeartbeat(bearer, agentId, instanceId) {
    return jsonFetch({ method: 'POST', path: `/agents/${encodeURIComponent(agentId)}/heartbeat`, bearer, body: { instance_id: instanceId } });
}
export async function brainHandback(bearer, agentId) {
    return jsonFetch({ method: 'POST', path: `/agents/${encodeURIComponent(agentId)}/handback`, bearer });
}
export async function brainSlice(bearer, agentId, budget) {
    return jsonFetch({ method: 'GET', path: `/agents/${encodeURIComponent(agentId)}/brain/slice?budget=${budget}`, bearer });
}
// Reply on a connection — auto-routes by side (owner vs connector), so it drives
// BOTH inbound conversations AND the agent's own outbound/connector ones.
export async function brainReply(bearer, agentId, connId, content) {
    return jsonFetch({ method: 'POST', path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connId)}/brain-reply`, bearer, body: { content } });
}
export async function brainEscalate(bearer, agentId, connId, reason, proposedDraft) {
    return jsonFetch({ method: 'POST', path: `/agents/${encodeURIComponent(agentId)}/external-connections/${encodeURIComponent(connId)}/escalate`, bearer, body: { reason, proposed_draft: proposedDraft } });
}
export async function brainPending(bearer, agentId) {
    return jsonFetch({ method: 'GET', path: `/agents/${encodeURIComponent(agentId)}/brain/pending`, bearer });
}
export async function brainResolve(bearer, agentId, requestId, action) {
    return jsonFetch({ method: 'POST', path: `/agents/${encodeURIComponent(agentId)}/brain/pending/${encodeURIComponent(requestId)}/resolve`, bearer, body: { action } });
}
