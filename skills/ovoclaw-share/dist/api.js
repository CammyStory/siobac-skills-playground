// HTTP client for the OvOclaw owner-side API + OAuth Device Authorization
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
// Override anytime with OVOCLAW_API_BASE.
const DEFAULT_API_BASE = 'https://ovo.ovoclaw.com/dev';
export function getApiBase() {
    return process.env.OVOCLAW_API_BASE ?? DEFAULT_API_BASE;
}
let seenLatest = null;
let seenMin = null;
let seenUrl = null;
function captureUpdateHeaders(res) {
    const latest = res.headers.get('x-ovoclaw-share-latest');
    if (!latest)
        return; // old server without the version hook — stay silent
    seenLatest = latest;
    seenMin = res.headers.get('x-ovoclaw-share-min');
    seenUrl = res.headers.get('x-ovoclaw-share-update-url');
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
            ? 'This ovoclaw-share skill is older than the server\'s minimum supported version and may misbehave — update it before relying on it.'
            : 'A newer ovoclaw-share skill is available — tell the user they can update when convenient.',
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
export async function setDirective(bearer, agentId, content) {
    return jsonFetch({
        method: 'PUT',
        path: `/agents/${encodeURIComponent(agentId)}/directive`,
        bearer,
        body: { content },
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
export async function pollConnectionReplies(host, token, sinceSeq, waitSeconds = 0) {
    const params = new URLSearchParams({ since: String(sinceSeq), wait: String(waitSeconds) });
    return inviteFetch(`${host}/poll?${params.toString()}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
}
