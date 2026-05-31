import { SKILL_VERSION } from './version.js';
export function makeError(code, message, extras = {}) {
    const err = new Error(message);
    err.code = code;
    if (extras.status !== undefined)
        err.status = extras.status;
    if (extras.body !== undefined)
        err.body = extras.body;
    return err;
}
function classifyStatus(status, body) {
    if (status === 400)
        return 'invalid_request';
    if (status === 401)
        return 'session_expired';
    if (status === 403)
        return 'blocked_by_owner';
    if (status === 404)
        return 'invalid_invite';
    if (status === 409) {
        const e = body?.error ?? '';
        if (e === 'agent_busy' || e === 'queue_full')
            return 'agent_busy';
        return 'agent_unavailable';
    }
    if (status === 429) {
        return body?.error === 'auth_blocked' ? 'auth_blocked' : 'rate_limited';
    }
    if (status >= 500)
        return 'server_error';
    return 'unknown';
}
let seenLatest = null;
let seenMin = null;
let seenUrl = null;
function captureUpdateHeaders(res) {
    const latest = res.headers.get('x-ovoclaw-connect-latest');
    if (!latest)
        return; // old server without the version hook — stay silent
    seenLatest = latest;
    seenMin = res.headers.get('x-ovoclaw-connect-min');
    seenUrl = res.headers.get('x-ovoclaw-connect-update-url');
}
// a < b for dotted numeric versions (e.g. '0.9.0' < '0.10.1').
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
            ? 'This ovoclaw-connect skill is older than the server\'s minimum supported version and may misbehave — update it before relying on it.'
            : 'A newer ovoclaw-connect skill is available — tell the user they can update when convenient.',
    };
}
async function jsonFetch(url, init) {
    // Tag every call with our version so the server can tell us (via response
    // headers) when a newer skill is out — see captureUpdateHeaders below.
    init = { ...init, headers: { ...init.headers, 'X-Ovoclaw-Connect-Version': SKILL_VERSION } };
    let res;
    try {
        res = await fetch(url, init);
    }
    catch (e) {
        // Network-level failure: fetch threw before any HTTP response.
        // Common in Node: DNS failure, ECONNREFUSED, TLS error, timeout.
        const cause = e.cause;
        const reason = cause?.code || cause?.message || e.message || 'fetch failed';
        throw makeError('network_error', `network_error: ${reason}`);
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
        const code = classifyStatus(res.status, b);
        const msg = b?.message || b?.error || res.statusText;
        throw makeError(code, `${code} (HTTP ${res.status}): ${msg}`, { status: res.status, body });
    }
    return body;
}
export async function getManifest(host, slug) {
    return jsonFetch(`${host}/manifest/${encodeURIComponent(slug)}`, {
        method: 'GET',
    });
}
export async function connect(host, slug, body, bearer) {
    const headers = { 'Content-Type': 'application/json' };
    if (bearer)
        headers.Authorization = `Bearer ${bearer}`;
    return jsonFetch(`${host}/connect/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}
// Silently mint a fresh bearer token from the long-lived client_secret — no
// owner re-approval, same shadow user / conversation / history. The bearer
// token only lives ~1h; the secret never expires, so this keeps a connection
// alive indefinitely. `introduction` is required by the endpoint but ignored on
// the reauth path (the server returns before any message is created). Any
// status other than 'reauthorized' means the connection is gone (the owner
// disconnected you, or the secret no longer matches) → surfaced as
// session_expired so the caller reconnects with the invite.
export async function reauthorize(host, slug, clientUserId, clientSecret) {
    const res = await connect(host, slug, {
        introduction: 'token refresh',
        client_user_id: clientUserId,
        client_secret: clientSecret,
    });
    if (res.status === 'reauthorized' && res.token && res.token_expires_at) {
        return { token: res.token, token_expires_at: res.token_expires_at };
    }
    throw makeError('session_expired', `could not refresh the session (status: ${String(res.status ?? 'unknown')}) — the owner may have disconnected you. Reconnect with the invite.`);
}
export async function pollConnect(host, slug, requestId) {
    return jsonFetch(`${host}/connect/${encodeURIComponent(slug)}/poll/${encodeURIComponent(requestId)}`, { method: 'GET' });
}
export async function sendMessage(host, token, content) {
    return jsonFetch(`${host}/message`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content }),
    });
}
export async function pollReplies(host, token, sinceSeq, waitSeconds = 0) {
    const params = new URLSearchParams({
        since: String(sinceSeq),
        wait: String(waitSeconds),
    });
    return jsonFetch(`${host}/poll?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
    });
}
// ── Login mode: OAuth device flow ─────────────────────────────────────────
// The connector can OPTIONALLY log in as a real bound agent (scope
// `agent:connect`), which makes the connection a registered friendship instead
// of a guest session. Reuses the same /oauth/* endpoints the share skill uses.
// See docs/login-mode-design.md.
export const CONNECT_CLIENT_ID = 'ovoclaw-connect-cli';
export const CONNECT_SCOPE = 'agent:connect';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// OAuth endpoints answer with { error, message } and (for the device-flow
// poll) carry their state in `error` at HTTP 401. Map those to our codes; a
// 404 means the server predates login mode.
const OAUTH_ERROR_CODES = {
    authorization_pending: 'authorization_pending',
    slow_down: 'slow_down',
    access_denied: 'access_denied',
    expired_token: 'expired_token',
    invalid_grant: 'expired_token',
};
async function oauthFetch(base, path, body) {
    const url = `${base}${path}`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Ovoclaw-Connect-Version': SKILL_VERSION },
            body: JSON.stringify(body),
        });
    }
    catch (e) {
        const cause = e.cause;
        const reason = cause?.code || cause?.message || e.message || 'fetch failed';
        throw makeError('network_error', `network_error: ${reason}`);
    }
    captureUpdateHeaders(res);
    const text = await res.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    }
    catch {
        payload = { raw: text };
    }
    if (res.status === 404) {
        throw makeError('server_not_ready', 'login: the server does not expose the OAuth device-flow endpoints (HTTP 404) — it may not support login mode yet.', { status: 404, body: payload });
    }
    if (!res.ok) {
        const oauth = payload.error ? OAUTH_ERROR_CODES[payload.error] : undefined;
        const code = oauth ?? classifyStatus(res.status, payload);
        const msg = payload.message || payload.error || res.statusText;
        throw makeError(code, `${code} (HTTP ${res.status}): ${msg}`, { status: res.status, body: payload });
    }
    return payload;
}
export async function requestDeviceCode(base, agentHint) {
    const body = { client_id: CONNECT_CLIENT_ID, scope: CONNECT_SCOPE };
    if (agentHint)
        body.agent_hint = agentHint;
    return oauthFetch(base, '/oauth/device/code', body);
}
export async function pollDeviceToken(base, deviceCode) {
    return oauthFetch(base, '/oauth/device/token', {
        grant_type: DEVICE_CODE_GRANT,
        device_code: deviceCode,
        client_id: CONNECT_CLIENT_ID,
    });
}
export async function refreshAccessToken(base, refreshToken) {
    return oauthFetch(base, '/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CONNECT_CLIENT_ID,
    });
}
