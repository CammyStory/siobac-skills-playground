#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from 'node:fs';
import { platform, arch } from 'node:os';
import { parseArgs, requireString, optionalString, CliError, } from './argparse.js';
import * as api from './api.js';
import { STATE_DIR, AUTH_FILE, loadAuth, saveAuth, clearAuth, loadBoundAgent, saveBoundAgent, isAuthFileWriteable, saveSession, getSession, listSessions, deleteSession, updateSession, newSessionHandle, } from './state.js';
import { parseInvite } from './invite.js';
import { SKILL_NAME, SKILL_VERSION } from './version.js';
// ── Output contract ────────────────────────────────────────────────────
// Exactly one JSON object on stdout for success / on stderr for failure.
// Same shape as ovoclaw-connect — agents already trained on that contract
// can branch on `code` here without learning a new convention.
// Attach a `skill_update` block when this run heard about a newer skill from
// the server. SKILL.md tells the agent to relay it to the user.
function withUpdateNotice(body) {
    const upd = api.getSkillUpdateNotice();
    return upd ? { ...body, skill_update: upd } : body;
}
function ok(value) {
    const payload = value && typeof value === 'object' && !Array.isArray(value)
        ? withUpdateNotice(value)
        : value;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.exit(0);
}
function fail(err, exitCode = 1) {
    let body;
    if (err instanceof CliError) {
        body = { error: err.message, code: 'cli_error' };
    }
    else if (err instanceof Error) {
        const apiErr = err;
        body = { error: err.message, code: apiErr.code ?? 'unknown' };
        if (typeof apiErr.status === 'number')
            body.status = apiErr.status;
        if (apiErr.body !== undefined)
            body.details = apiErr.body;
    }
    else {
        body = { error: String(err), code: 'unknown' };
    }
    process.stderr.write(JSON.stringify(withUpdateNotice(body), null, 2) + '\n');
    process.exit(exitCode);
}
// Refresh once the access token has less than this much life left, so a
// command never starts with a token about to expire mid-request.
const TOKEN_REFRESH_SKEW_MS = 60_000;
async function requireAuth() {
    const auth = await loadAuth();
    if (!auth) {
        throw api.makeApiError('not_authenticated', 'no auth.json found. Run `login` first to authenticate via device flow.');
    }
    // Token still has comfortable life left — use it as-is.
    if (new Date(auth.expiresAt).getTime() - Date.now() > TOKEN_REFRESH_SKEW_MS) {
        return auth;
    }
    // Access token expired (or about to). Before forcing a full device-flow
    // re-login, try to swap the stored refresh token (valid ~30 days, rotated
    // each use) for a fresh access token — silent, no browser. Only when the
    // refresh token itself is missing/expired/revoked do we ask for a re-login.
    if (!auth.refreshToken) {
        throw api.makeApiError('session_expired', 'access token expired and no refresh token is stored. Run `login` to re-authenticate.');
    }
    let token;
    try {
        token = await api.refreshAccessToken(auth.refreshToken);
    }
    catch (e) {
        const code = e.code;
        // 401 (invalid_grant) → the refresh token is expired/revoked: the 30-day
        // window lapsed, the user logged out elsewhere, or a rotated token leaked.
        // A fresh login is the only way forward. network_error / server_error /
        // server_not_ready propagate unchanged so the caller can retry.
        if (code === 'session_expired') {
            throw api.makeApiError('session_expired', 'refresh token expired or revoked (idle 30+ days, logged out, or revoked). Run `login` to re-authenticate.');
        }
        throw e;
    }
    // Persist the rotated pair so the next command keeps the chain alive. The
    // server preserves the agent binding across refreshes; keep it (and the
    // original login time) if the response omits anything.
    const refreshed = {
        accessToken: token.access_token,
        tokenType: token.token_type,
        expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        refreshToken: token.refresh_token ?? auth.refreshToken,
        scope: token.scope ?? auth.scope,
        ovoclawAccountId: token.account_id ?? auth.ovoclawAccountId,
        agentId: token.agent_id ?? auth.agentId,
        loggedInAt: auth.loggedInAt,
    };
    await saveAuth(refreshed);
    return refreshed;
}
async function cmdDoctor() {
    const checks = {};
    // Node version
    const nodeV = process.versions.node;
    const major = Number.parseInt(nodeV.split('.')[0] ?? '0', 10);
    checks.node_version =
        major >= 18
            ? { ok: true, value: `v${nodeV}` }
            : { ok: false, value: `v${nodeV}`, reason: 'requires Node >= 18 for built-in fetch' };
    checks.fetch = typeof fetch === 'function'
        ? { ok: true }
        : { ok: false, reason: 'global fetch unavailable; Node 18+ required' };
    // State directory + auth file
    const writeCheck = await isAuthFileWriteable();
    checks.state_dir = writeCheck.ok
        ? { ok: true, value: STATE_DIR }
        : { ok: false, value: STATE_DIR, reason: writeCheck.reason ?? 'unknown' };
    try {
        const st = await fs.stat(AUTH_FILE);
        const modeOctal = (st.mode & 0o777).toString(8).padStart(3, '0');
        const tooPermissive = (st.mode & 0o077) !== 0;
        checks.auth_file = {
            ok: !tooPermissive,
            value: { path: AUTH_FILE, mode: modeOctal, exists: true },
            warning: tooPermissive
                ? `auth.json mode ${modeOctal} is group/world readable; expected 600.`
                : undefined,
        };
    }
    catch (e) {
        if (e.code === 'ENOENT') {
            checks.auth_file = {
                ok: true,
                value: { path: AUTH_FILE, exists: false },
                warning: 'not logged in yet — run `login` to authenticate',
            };
        }
        else {
            checks.auth_file = { ok: false, value: AUTH_FILE, reason: e.message };
        }
    }
    // API base + reachability
    const apiBase = api.getApiBase();
    try {
        const u = new URL(apiBase);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            checks.api_base = { ok: false, value: apiBase, reason: `must be http or https; got ${u.protocol}` };
        }
        else {
            checks.api_base = { ok: true, value: apiBase };
        }
    }
    catch {
        checks.api_base = { ok: false, value: apiBase, reason: 'invalid URL' };
    }
    if (checks.api_base.ok) {
        const start = Date.now();
        try {
            const res = await fetch(`${apiBase}/health`, { method: 'GET' });
            checks.api_reachable = {
                ok: true,
                value: { http_status: res.status, response_time_ms: Date.now() - start },
            };
        }
        catch (e) {
            const cause = e.cause;
            const reason = cause?.code || cause?.message || e.message;
            checks.api_reachable = { ok: false, value: apiBase, reason: `network_error: ${reason}` };
        }
    }
    else {
        checks.api_reachable = { ok: false, reason: 'skipped — api_base invalid' };
    }
    const allOk = Object.values(checks).every((c) => c.ok);
    const report = {
        ok: allOk,
        skill: { name: SKILL_NAME, version: SKILL_VERSION },
        runtime: { node: process.versions.node, platform: platform(), arch: arch() },
        checks,
    };
    if (allOk)
        ok(report);
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(1);
}
async function cmdLogin(flags) {
    // Device flow: request a device_code, surface the verification URL to the
    // user, then poll until they approve. The server-side /oauth/* endpoints
    // landed in phase 2; if a deployment predates them this still degrades
    // cleanly to code:server_not_ready.
    //
    // Agent pre-select hint, in priority order:
    //   1. --agent <name-or-id> — the owner told us which agent to share (ask
    //      them before login when they already have one on OvOclaw). The approval
    //      page resolves it by id or unique name and auto-selects that agent.
    //   2. the agent we bound to on a prior share (agent.json) — so every
    //      re-login re-binds the same identity without re-choosing.
    // Either way it's only a hint: an unknown/ambiguous value is ignored
    // server-side and the page falls back to the pick-or-create chooser.
    const explicitAgent = optionalString(flags, 'agent');
    const bound = await loadBoundAgent();
    const agentHint = explicitAgent ?? bound?.agentId;
    let codeResp;
    try {
        codeResp = await api.requestDeviceCode(undefined, agentHint);
    }
    catch (e) {
        const apiErr = e;
        if (apiErr.code === 'server_not_ready') {
            throw api.makeApiError('server_not_ready', 'login: OAuth device flow endpoints not deployed on the server yet (phase 2 work). The skill is ready; the server side ships next.');
        }
        throw e;
    }
    // Show the user the verification link. Prefer verification_uri_complete —
    // opening it pre-fills the code automatically, so the user clicks once and
    // never types anything. verification_uri + user_code are the manual
    // fallback (e.g. approving on a different device).
    process.stdout.write(JSON.stringify({
        status: 'awaiting_user_approval',
        verification_uri_complete: codeResp.verification_uri_complete,
        verification_uri: codeResp.verification_uri,
        user_code: codeResp.user_code,
        expires_in_seconds: codeResp.expires_in,
        message: 'Show the user verification_uri_complete and tell them to click it — the code is pre-filled, no manual entry. ' +
            '(Fallback: open verification_uri and enter user_code.) Then they sign in, pick which agent to share, and approve. ' +
            'The CLI keeps polling and continues automatically once approved.',
    }, null, 2) + '\n');
    // Poll for token. Sleep `interval` between attempts. Stop after expires_in.
    const expiresAt = Date.now() + codeResp.expires_in * 1000;
    let interval = codeResp.interval * 1000;
    while (Date.now() < expiresAt) {
        await new Promise((r) => setTimeout(r, interval));
        try {
            const token = await api.pollDeviceToken(codeResp.device_code);
            const auth = {
                accessToken: token.access_token,
                tokenType: token.token_type,
                expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
                refreshToken: token.refresh_token,
                scope: token.scope,
                ovoclawAccountId: token.account_id,
                agentId: token.agent_id ?? undefined,
                loggedInAt: new Date().toISOString(),
            };
            await saveAuth(auth);
            const agentName = token.agent_name ?? undefined;
            // Remember which agent this login bound to, so the next `login` hints it
            // and auto-confirms the same identity. Survives logout / token expiry.
            // We keep the name too — purely so a future session can show it.
            if (auth.agentId) {
                await saveBoundAgent({
                    agentId: auth.agentId,
                    agentName,
                    boundAt: new Date().toISOString(),
                });
            }
            // First-time setup nudge: has this agent been given a directive yet?
            // Best-effort — never block login if the check fails.
            let directiveSet = false;
            try {
                if (auth.agentId) {
                    const d = await api.getDirective(auth.accessToken, auth.agentId);
                    directiveSet = !!(d.content && d.content.trim());
                }
            }
            catch { /* ignore */ }
            // Tell the agent which OvOclaw agent it's now bound to AND ask it to
            // remember — so on a fresh install (where the local agent.json may not
            // survive) it can recall this from its own memory and pass it as
            // `--agent` next login, re-binding the same identity without a picker.
            const rememberLabel = agentName ?? auth.agentId;
            ok({
                status: 'authenticated',
                scope: auth.scope,
                expires_at: auth.expiresAt,
                account_id: auth.ovoclawAccountId,
                agent_id: auth.agentId,
                agent_name: agentName ?? null,
                note: 'This login is bound to a single agent. All commands act as that agent only.',
                profile_setup_needed: !directiveSet,
                next_step: directiveSet
                    ? 'Confirm with the owner that their PUBLIC PROFILE (name/description) still reflects who they are — outside agents read that — then `share-self`.'
                    : 'FIRST, design this agent before sharing (do not skip — it is what makes the agent represent the owner well): (1) write its private DIRECTIVE — the rules + purpose for how it should think and reply on the owner\'s behalf — and save it with `set-directive --content "…"`; (2) make sure the PUBLIC PROFILE (name/description) clearly says who the owner is, since outside agents read that to understand them. Then `share-self`. See "First-time setup" in SKILL.md.',
                remember: rememberLabel
                    ? `You are now sharing the OvOclaw agent "${rememberLabel}" (id ${auth.agentId}). ` +
                        `Record this in your durable memory as your OvOclaw agent. Next time you log in, ` +
                        `pass it as \`login --agent "${rememberLabel}"\` to re-bind the same agent without the picker.`
                    : undefined,
            });
        }
        catch (e) {
            const apiErr = e;
            if (apiErr.code === 'authorization_pending')
                continue;
            if (apiErr.code === 'slow_down') {
                interval = Math.round(interval * 1.5);
                continue;
            }
            throw e;
        }
    }
    throw api.makeApiError('expired_token', 'device authorization expired before approval. Run `login` again.');
}
async function cmdLogout() {
    await clearAuth();
    ok({ ok: true, status: 'logged_out', auth_file_path: AUTH_FILE });
}
// ── Owner-side commands (wired to apps/server in phase 3) ──
// Parse a tri-state --requires-approval flag:
//   (absent)                  → undefined (server default: gated/approval-on)
//   --requires-approval       → true
//   --requires-approval=false → false  (open invite, connects immediately)
function parseRequiresApproval(flags) {
    const v = flags['requires-approval'];
    if (v === undefined)
        return undefined;
    if (v === true)
        return true;
    return !(v === 'false' || v === '0' || v === 'no');
}
// Every owner-side command acts as the ONE agent this login is bound to. The
// agent_id is baked into the access token at login (the approval page's agent
// picker), so the skill never takes an --agent-id — it can't act as any other
// agent, and the server enforces that too. A token from before agent-scoping
// (no agentId) is treated as stale → re-login.
async function requireBoundAgent() {
    const auth = await requireAuth();
    if (!auth.agentId) {
        throw api.makeApiError('not_authenticated', 'this login is not bound to an agent (old token). Run `login` again and pick the agent to authorize.');
    }
    return { auth, agentId: auth.agentId };
}
function shareUrlFor(slug) {
    // The legacy /external/share/:slug landing page is served on the same host
    // the owner API lives on, so this resolves without needing the protocol
    // subdomain. The server's list-shares builds the same shape host-aware.
    return `${api.getApiBase()}/external/share/${encodeURIComponent(slug)}`;
}
// A scannable PNG QR of the share landing URL — surface this so the agent can
// SHOW a QR (not just a link) to its owner after sharing.
function qrUrlFor(slug) {
    return `${shareUrlFor(slug)}/qr.png`;
}
// A ready-to-render inline image embed for the QR. On image-capable platforms
// the agent drops this straight into its reply so the user sees a scannable QR
// image, not a bare URL. SKILL.md tells the agent to prefer this over the link.
function qrMarkdownFor(slug) {
    return `![Scan to reach me on OvOclaw](${qrUrlFor(slug)})`;
}
async function cmdShareSelf(flags) {
    optionalString(flags, 'description'); // accepted for forward-compat; not used by the invite endpoint
    const requiresApproval = parseRequiresApproval(flags);
    const { auth, agentId } = await requireBoundAgent();
    const invite = await api.createShare(auth.accessToken, agentId, { requires_approval: requiresApproval });
    ok({
        status: 'shared',
        agent_id: agentId,
        invite: {
            id: invite.id,
            slug: invite.slug,
            requires_approval: invite.requires_approval,
            created_at: invite.created_at,
        },
        share_url: shareUrlFor(invite.slug),
        qr_url: qrUrlFor(invite.slug),
        qr_markdown: qrMarkdownFor(invite.slug),
        note: 'DISPLAY THE QR INLINE: render it as an image so the user sees a scannable QR, not a link — drop the ready-made `qr_markdown` straight into your reply (it is `![](qr_url)`). Also give `share_url` as a copyable link. Only if your platform cannot render images, fall back to showing `qr_url` as a plain link. (createInvite is idempotent — an already-shared agent returns its existing invite.)',
        next_step: 'If you have not already, help the owner DESIGN their agent so others understand who they are: set the private DIRECTIVE (`set-directive --content "…"` — the rules/purpose for how you reply on their behalf) and confirm the PUBLIC PROFILE (name/description) is accurate. Then, when a friend connects, use `recall` before replying and `remember` after (see "Talking in character" in SKILL.md).',
    });
}
async function cmdListShares() {
    const auth = await requireAuth();
    const shares = await api.listShares(auth.accessToken);
    // Add a scannable qr_url alongside each share's slug.
    const withQr = shares.map((s) => ({
        ...s,
        qr_url: s.invite?.slug ? qrUrlFor(s.invite.slug) : null,
        qr_markdown: s.invite?.slug ? qrMarkdownFor(s.invite.slug) : null,
    }));
    ok({
        status: 'ok',
        count: withQr.length,
        shares: withQr,
        note: 'To show a share again, render its `qr_markdown` inline as an image (it is `![](qr_url)`) so the user sees a scannable QR, with `share_url` as the copyable link — not just the raw URL.',
    });
}
async function cmdRevokeShare() {
    const { auth, agentId } = await requireBoundAgent();
    const result = await api.revokeShare(auth.accessToken, agentId);
    ok({ status: 'revoked', agent_id: agentId, ...result });
}
async function cmdRegenerateShare(flags) {
    const requiresApproval = parseRequiresApproval(flags);
    const { auth, agentId } = await requireBoundAgent();
    const invite = await api.regenerateShare(auth.accessToken, agentId, { requires_approval: requiresApproval });
    ok({
        status: 'regenerated',
        agent_id: agentId,
        invite: {
            id: invite.id,
            slug: invite.slug,
            requires_approval: invite.requires_approval,
            created_at: invite.created_at,
        },
        share_url: shareUrlFor(invite.slug),
        qr_url: qrUrlFor(invite.slug),
        qr_markdown: qrMarkdownFor(invite.slug),
        note: 'DISPLAY THE QR INLINE: render `qr_markdown` as an image (it is `![](qr_url)`) so the user sees a scannable QR, with `share_url` as the copyable link — do not just paste the URL. Fall back to the plain `qr_url` link only if your platform cannot render images. The previous slug is now revoked; existing connections are unaffected, but old share links / QR codes stop working.',
    });
}
async function cmdListConnections(flags) {
    const statusFilter = optionalString(flags, 'status');
    const { auth, agentId } = await requireBoundAgent();
    let conns = await api.listConnections(auth.accessToken, agentId);
    if (statusFilter)
        conns = conns.filter((c) => c.status === statusFilter);
    ok({
        status: 'ok',
        agent_id: agentId,
        status_filter: statusFilter ?? null,
        count: conns.length,
        connections: conns,
    });
}
// accept/reject act on a pending connection (the request_id IS the connection
// id of the pending row). pause/resume/disconnect/rotate-token act on an
// existing connection. All act on the bound agent's own connections.
async function actOnConnectionCmd(flags, cmd, idFlag, action, doneStatus) {
    const connectionId = requireString(flags, idFlag, cmd);
    const { auth, agentId } = await requireBoundAgent();
    const result = await api.actOnConnection(auth.accessToken, agentId, connectionId, action);
    ok({ status: doneStatus, agent_id: agentId, connection_id: connectionId, result });
}
async function cmdAcceptPending(flags) {
    return actOnConnectionCmd(flags, 'accept-pending', 'request-id', 'accept', 'accepted');
}
async function cmdRejectPending(flags) {
    return actOnConnectionCmd(flags, 'reject-pending', 'request-id', 'reject', 'rejected');
}
async function cmdPauseConnection(flags) {
    return actOnConnectionCmd(flags, 'pause-connection', 'connection-id', 'pause', 'paused');
}
async function cmdResumeConnection(flags) {
    return actOnConnectionCmd(flags, 'resume-connection', 'connection-id', 'resume', 'resumed');
}
async function cmdDisconnect(flags) {
    return actOnConnectionCmd(flags, 'disconnect', 'connection-id', 'disconnect', 'disconnected');
}
async function cmdRotateToken(flags) {
    return actOnConnectionCmd(flags, 'rotate-token', 'connection-id', 'rotate-token', 'token_rotated');
}
async function cmdCheckInbox(flags) {
    void flags;
    // Auth is enough — the server scopes the inbox to the bound agent.
    const auth = await requireAuth();
    const inbox = await api.fetchInbox(auth.accessToken);
    ok({
        status: 'ok',
        pending_count: inbox.pending_requests.length,
        unread_count: inbox.new_messages.length,
        thread_count: inbox.threads.length,
        new_messages_truncated: inbox.new_messages_truncated,
        // DISPLAY THIS: per-friend threads (messages still needing a reply, grouped
        // by sender, chronological within each, most-recent friend first). See the
        // "Presenting the inbox" layout in SKILL.md.
        threads: inbox.threads,
        pending_requests: inbox.pending_requests,
        // Flat list kept for convenience; prefer `threads` for display.
        new_messages: inbox.new_messages,
        last_seq_by_connection: inbox.last_seq_by_connection,
    });
}
async function cmdRespond(flags) {
    const connectionId = requireString(flags, 'connection-id', 'respond');
    const content = requireString(flags, 'content', 'respond');
    const { auth, agentId } = await requireBoundAgent();
    const result = await api.postReply(auth.accessToken, agentId, connectionId, content);
    ok({ status: 'sent', agent_id: agentId, connection_id: connectionId, ...result });
}
async function cmdReadConversation(flags) {
    const connectionId = requireString(flags, 'connection-id', 'read-conversation');
    const since = optionalString(flags, 'since');
    const limit = optionalString(flags, 'limit');
    const { auth, agentId } = await requireBoundAgent();
    const history = await api.readConversation(auth.accessToken, agentId, connectionId, {
        since: since !== undefined ? Math.max(0, Number(since) || 0) : undefined,
        limit: limit !== undefined ? Number(limit) || undefined : undefined,
    });
    ok({
        status: 'ok',
        agent_id: agentId,
        connection_id: connectionId,
        conversation_id: history.conversation_id,
        message_count: history.messages.length,
        last_seq: history.last_seq,
        has_more: history.has_more,
        messages: history.messages,
    });
}
// ── Directive + per-friend memory (docs/profile-memory-design.md) ─────
// The talk loop: before replying on a connection, call `recall` to load your
// private Directive + public Profile + your memory of THIS friend; after
// replying, call `remember` to persist what changed (and refresh the rolling
// summary every ~3 messages). Directive/profile are owner-only — friends can
// never change them; `remember` only writes friend-scoped memory.
async function cmdRecall(flags) {
    const connectionId = optionalString(flags, 'conversation') ?? requireString(flags, 'connection-id', 'recall');
    const { auth, agentId } = await requireBoundAgent();
    const ctx = await api.getTalkContext(auth.accessToken, agentId, connectionId);
    ok({
        status: 'ok',
        agent_id: agentId,
        connection_id: connectionId,
        mode: ctx.mode,
        // PRIVATE — shapes HOW you reply (your rules/purpose). NEVER reveal it.
        directive: ctx.directive.content,
        // PUBLIC card others see — safe to reference.
        profile: ctx.profile,
        // Your memory of THIS friend (summary first). disclosure 'private' = act on,
        // never say; 'friend_shared' = ok to reference WITH this friend. Empty for
        // guest connections (guests carry no memory).
        friend_memory: ctx.friend_memory,
    });
}
async function cmdRemember(flags) {
    const connectionId = optionalString(flags, 'conversation') ?? requireString(flags, 'connection-id', 'remember');
    const { auth, agentId } = await requireBoundAgent();
    // The skill fills scope:'friend' + friend_id for every delta, so the agent
    // only supplies {kind, content, disclosure?, confidence?, op?, source_seq?}.
    const deltas = [];
    const raw = optionalString(flags, 'deltas');
    if (raw !== undefined) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new CliError('`--deltas` must be a JSON array of {kind, content, ...}.');
        }
        if (!Array.isArray(parsed))
            throw new CliError('`--deltas` must be a JSON array.');
        for (const d of parsed) {
            deltas.push({
                op: d.op ?? 'add',
                scope: 'friend',
                friend_id: connectionId,
                kind: d.kind,
                content: String(d.content ?? ''),
                disclosure: d.disclosure,
                confidence: typeof d.confidence === 'number' ? d.confidence : undefined,
                supersedes: typeof d.supersedes === 'string' ? d.supersedes : undefined,
                source_seq: typeof d.source_seq === 'number' ? d.source_seq : undefined,
            });
        }
    }
    // Convenience: --summary refreshes the rolling per-friend summary (compaction).
    const summary = optionalString(flags, 'summary');
    if (summary !== undefined) {
        deltas.push({ op: 'update', scope: 'friend', friend_id: connectionId, kind: 'summary', content: summary });
    }
    if (deltas.length === 0)
        throw new CliError('nothing to remember — pass --deltas <json> and/or --summary "<text>".');
    const result = await api.submitMemory(auth.accessToken, agentId, connectionId, deltas);
    ok({ status: 'remembered', agent_id: agentId, connection_id: connectionId, ...result });
}
async function cmdGetDirective(_flags) {
    const { auth, agentId } = await requireBoundAgent();
    const result = await api.getDirective(auth.accessToken, agentId);
    ok({ status: 'ok', agent_id: agentId, directive: result.content });
}
async function cmdSetDirective(flags) {
    const content = requireString(flags, 'content', 'set-directive');
    const { auth, agentId } = await requireBoundAgent();
    await api.setDirective(auth.accessToken, agentId, content);
    ok({ status: 'ok', agent_id: agentId, updated: true });
}
// ── Reach out + unified conversations (merged from ovoclaw-connect) ──────
// One agent is symmetric: it can be reached (passive) AND reach out (active).
// A conversation handle disambiguates the transport: `s_…` = one I started
// (connection bearer); anything else = a connection id I own (login token).
function isActiveHandle(h) { return /^s_[0-9a-f]{16}$/.test(h); }
async function persistSession(res, slug, host) {
    if (!res.token || !res.token_expires_at || !res.your_user_id || !res.client_secret) {
        throw new CliError(`connect succeeded but the response is missing token fields (status ${res.status}).`);
    }
    const handle = newSessionHandle();
    await saveSession({
        handle, slug, host,
        peerAgentName: res.peer_name,
        token: res.token, tokenExpiresAt: res.token_expires_at,
        clientUserId: res.your_user_id, clientSecret: res.client_secret,
        conversationId: res.conversation_id, lastSeq: 0,
        createdAt: new Date().toISOString(),
    });
    return handle;
}
function sanitizeConnect(res) {
    const { token: _t, client_secret: _cs, ...safe } = res;
    return safe;
}
async function cmdInspectInvite(flags) {
    const invite = requireString(flags, 'invite', 'inspect-invite');
    const { slug, host } = parseInvite(invite);
    const m = await api.getManifest(host, slug);
    const auth = await loadAuth();
    ok({
        status: 'ok', host, slug, agent: m.agent,
        requires_approval: m.requires_approval ?? false,
        your_login_state: auth?.agentId ? 'logged_in' : 'guest',
    });
}
async function cmdConnect(flags) {
    const invite = requireString(flags, 'invite', 'connect');
    const introduction = requireString(flags, 'intro', 'connect');
    const { slug, host } = parseInvite(invite);
    const auth = await loadAuth();
    const loggedIn = !!(auth && auth.agentId);
    const guest = flags['guest'] === true || flags['guest'] === 'true' || flags['guest'] === '';
    const existing = (await listSessions()).find((s) => s.slug === slug);
    // Login-choice gate (per the owner's rule): logged-in → use the agent;
    // logged-out + no --guest + no prior session → ASK login-or-guest.
    if (!loggedIn && !guest && !existing) {
        ok({
            status: 'login_choice_required',
            message: 'You are not logged in. Ask the owner: LOG IN so this agent reaches out as ITSELF (a saved, account-anchored friendship), OR connect once as an anonymous GUEST.',
            options: {
                login: 'run `login` (bind this agent), then `connect` again → registered friendship',
                guest: 're-run `connect … --guest` → one-off anonymous connection, no account',
            },
        });
    }
    const bearer = loggedIn ? auth.accessToken : undefined;
    const res = await api.connectToInvite(host, slug, {
        your_agent_name: optionalString(flags, 'agent-name'),
        your_owner_name: optionalString(flags, 'owner-name'),
        introduction,
        purpose_hint: optionalString(flags, 'purpose'),
    }, bearer);
    if (res.status === 'active' || res.status === 'reauthorized' || res.status === 'already_connected') {
        const handle = await persistSession(res, slug, host);
        ok({ status: res.status, conversation: handle, peer_name: res.peer_name ?? null, mode: bearer ? 'registered' : 'guest', token_expires_at: res.token_expires_at });
    }
    if (res.status === 'awaiting_approval') {
        ok({ status: 'awaiting_approval', request_id: res.request_id, invite, hint: 'Poll `check-approval --invite <same> --request-id <id>`; when it turns active you get a `conversation` handle.' });
    }
    ok(sanitizeConnect(res));
}
async function cmdCheckApproval(flags) {
    const invite = requireString(flags, 'invite', 'check-approval');
    const requestId = requireString(flags, 'request-id', 'check-approval');
    const { slug, host } = parseInvite(invite);
    const res = await api.pollConnect(host, slug, requestId);
    if (res.status === 'active') {
        const handle = await persistSession(res, slug, host);
        ok({ status: 'active', conversation: handle, peer_name: res.peer_name ?? null, token_expires_at: res.token_expires_at });
    }
    ok(sanitizeConnect(res));
}
async function cmdConversations(_flags) {
    const auth = await loadAuth();
    const conversations = [];
    if (auth && auth.agentId) {
        const conns = await api.listConnections(auth.accessToken, auth.agentId);
        for (const c of conns) {
            conversations.push({ conversation: c.id, direction: 'inbound', started: 'they connected to me', peer: c.shadow_name ?? null, status: c.status, conversation_id: c.conversation_id, created_at: c.created_at });
        }
    }
    for (const s of await listSessions()) {
        conversations.push({ conversation: s.handle, direction: 'outbound', started: 'I connected out', peer: s.peerAgentName ?? null, slug: s.slug, host: s.host, created_at: s.createdAt, token_expires_at: s.tokenExpiresAt });
    }
    ok({ status: 'ok', logged_in: !!(auth && auth.agentId), count: conversations.length, conversations });
}
async function cmdRead(flags) {
    const handle = requireString(flags, 'conversation', 'read');
    if (isActiveHandle(handle)) {
        const sess = await getSession(handle);
        if (!sess)
            throw new CliError(`Unknown conversation "${handle}". Run \`conversations\` to list, or \`connect\` first.`);
        const res = await api.pollConnectionReplies(sess.host, sess.token, 0, 0);
        ok({ status: 'ok', conversation: handle, direction: 'outbound', peer: sess.peerAgentName ?? null, messages: res.messages, last_seq: res.last_seq, note: "Active side shows the OTHER agent's replies (the connector transport doesn't echo your own sent messages)." });
    }
    const { auth, agentId } = await requireBoundAgent();
    const since = optionalString(flags, 'since');
    const hist = await api.readConversation(auth.accessToken, agentId, handle, { since: since !== undefined ? Math.max(0, Number(since) || 0) : undefined });
    ok({ status: 'ok', conversation: handle, direction: 'inbound', conversation_id: hist.conversation_id, message_count: hist.messages.length, last_seq: hist.last_seq, has_more: hist.has_more, messages: hist.messages });
}
async function cmdSend(flags) {
    const handle = requireString(flags, 'conversation', 'send');
    const message = requireString(flags, 'message', 'send');
    if (isActiveHandle(handle)) {
        const sess = await getSession(handle);
        if (!sess)
            throw new CliError(`Unknown conversation "${handle}". Run \`conversations\` to list, or \`connect\` first.`);
        const res = await api.sendToConnection(sess.host, sess.token, message);
        ok({ status: 'sent', conversation: handle, direction: 'outbound', message_id: res.message?.id, seq: res.message?.seq, reply_status: res.reply_status });
    }
    const { auth, agentId } = await requireBoundAgent();
    const res = await api.postReply(auth.accessToken, agentId, handle, message);
    ok({ status: 'sent', conversation: handle, direction: 'inbound', ...res });
}
async function cmdCheck(_flags) {
    const auth = await loadAuth();
    const result = { status: 'ok' };
    if (auth && auth.agentId) {
        const inbox = await api.fetchInbox(auth.accessToken);
        result.inbound = { pending_requests: inbox.pending_requests, threads: inbox.threads, unanswered_count: inbox.new_messages.length };
    }
    else {
        result.inbound = { note: 'not logged in — only outbound (guest) conversations checked' };
    }
    const outbound = [];
    for (const s of await listSessions()) {
        try {
            const res = await api.pollConnectionReplies(s.host, s.token, s.lastSeq, 0);
            if (res.last_seq > s.lastSeq)
                await updateSession(s.handle, { lastSeq: res.last_seq });
            if (res.messages.length)
                outbound.push({ conversation: s.handle, peer: s.peerAgentName ?? null, new_messages: res.messages, last_seq: res.last_seq });
        }
        catch { /* a dead session shouldn't sink the whole check */ }
    }
    result.outbound = outbound;
    ok(result);
}
async function cmdRequests(_flags) {
    const auth = await requireAuth();
    const inbox = await api.fetchInbox(auth.accessToken);
    ok({ status: 'ok', count: inbox.pending_requests.length, pending_requests: inbox.pending_requests });
}
async function cmdListSessions() {
    const all = await listSessions();
    ok({ status: 'ok', sessions: all.map((s) => ({ conversation: s.handle, peer: s.peerAgentName ?? null, slug: s.slug, host: s.host, expires_at: s.tokenExpiresAt, last_seq: s.lastSeq, created_at: s.createdAt })) });
}
async function cmdForgetSession(flags) {
    const handle = requireString(flags, 'conversation', 'forget-session');
    await deleteSession(handle);
    ok({ status: 'ok', forgot: handle });
}
// ── Help (JSON) ──────────────────────────────────────────────────────
function cmdHelp() {
    ok({
        name: SKILL_NAME,
        version: SKILL_VERSION,
        description: 'Private dev playground for ovoclaw-share. Owner-side skill that lets shell-capable AI agents share themselves on OvOclaw and serve inbound connections without per-platform integration work.',
        playground_phase: 3,
        note: 'Phase 3 + agent-scoped. `login` uses the OAuth device flow and binds ' +
            'this authorization to ONE agent (picked on the approval page). Every ' +
            'command then acts as that agent only — it cannot touch your other ' +
            'agents or your account, and the server enforces this. No --agent-id ' +
            'flag anywhere. Set OVOCLAW_API_BASE to target a non-default server.',
        identity_model: 'self-scoped: this skill shares ITSELF and serves ITS OWN connections. ' +
            'To operate a different agent, run `login` again and pick that agent.',
        output_contract: {
            success: 'exactly one JSON object on stdout, exit 0',
            failure: 'exactly one JSON object on stderr with `error` and `code`, exit 1',
        },
        subcommands: [
            { name: 'login', description: 'OAuth device flow — authenticate + bind to one agent. Optional: --agent <name-or-id> to pre-select an existing OvOclaw agent so the approval page auto-confirms it' },
            { name: 'logout', description: 'Delete local auth.json' },
            { name: 'doctor', description: 'Self-diagnostic: Node, state dir, auth file, API reachability' },
            { name: 'share-self', description: 'Share this agent (creates an external invite). Optional: --requires-approval[=false]' },
            { name: 'list-shares', description: 'Show this agent\'s active share' },
            { name: 'revoke-share', description: 'Revoke this agent\'s share (invalidates the slug)' },
            { name: 'regenerate-share', description: 'Mint a new slug for this agent\'s share' },
            { name: 'list-connections', description: 'List this agent\'s inbound connections. Optional: --status' },
            { name: 'accept-pending', description: 'Approve a pending request. --request-id <id>' },
            { name: 'reject-pending', description: 'Reject a pending request. --request-id <id>' },
            { name: 'pause-connection', description: 'Pause a connection. --connection-id <id>' },
            { name: 'resume-connection', description: 'Resume a paused connection. --connection-id <id>' },
            { name: 'disconnect', description: 'Terminate a connection. --connection-id <id>' },
            { name: 'rotate-token', description: 'Rotate a connection\'s bearer. --connection-id <id>' },
            { name: 'conversations', description: 'List EVERY conversation — ones others started with you AND ones you started — in one list' },
            { name: 'read', description: 'Read a conversation (either direction). --conversation <handle> [--since <seq>]' },
            { name: 'send', description: 'Send a message in a conversation (either direction). --conversation <handle> --message "<text>"' },
            { name: 'check', description: 'New / unanswered messages across ALL conversations, both directions' },
            { name: 'requests', description: 'List pending incoming connect requests' },
            { name: 'approve', description: 'Approve a pending incoming request. --request-id <id>' },
            { name: 'reject', description: 'Reject a pending incoming request. --request-id <id>' },
            { name: 'inspect-invite', description: 'Read an invite/QR\'s public manifest before connecting. --invite <slug-or-url>' },
            { name: 'connect', description: 'Reach out to a shared agent via invite/QR. --invite <slug-or-url> --intro "<text>" [--guest]. Logged in → registered friendship; logged out → asks login-or-guest' },
            { name: 'check-approval', description: 'Poll a pending OUTBOUND connect. --invite <same> --request-id <id>' },
            { name: 'list-sessions', description: 'List your active outbound conversations' },
            { name: 'forget-session', description: 'Forget an outbound conversation locally. --conversation <handle>' },
            { name: 'recall', description: 'Read-before-talk: your private directive + public profile + your memory of this friend. --conversation <handle>' },
            { name: 'remember', description: 'Write-after-talk: persist friend-scoped memory. --conversation <handle> [--deltas \'[{"kind","content","disclosure?"}]\'] [--summary "<rolling summary>"]' },
            { name: 'get-directive', description: 'Read your private directive (owner-only; the rules/purpose driving how you reply)' },
            { name: 'set-directive', description: 'Set your private directive (owner-only). --content "<rules/purpose/standard>"' },
            { name: 'help', description: 'Print this JSON help' },
        ],
    });
}
// ── Dispatch ──────────────────────────────────────────────────────────
async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        process.stderr.write(JSON.stringify({ error: 'no subcommand provided. Run with --help to see available commands.', code: 'cli_error' }, null, 2) + '\n');
        process.exit(1);
    }
    if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
        cmdHelp();
    }
    const subcommand = argv[0];
    const { flags } = parseArgs(argv.slice(1));
    delete flags.json; // no-op flag, same convention as ovoclaw-connect
    switch (subcommand) {
        case 'doctor': return cmdDoctor();
        case 'login': return cmdLogin(flags);
        case 'logout': return cmdLogout();
        case 'share-self': return cmdShareSelf(flags);
        case 'list-shares': return cmdListShares();
        case 'revoke-share': return cmdRevokeShare();
        case 'regenerate-share': return cmdRegenerateShare(flags);
        case 'list-connections': return cmdListConnections(flags);
        case 'accept-pending': return cmdAcceptPending(flags);
        case 'reject-pending': return cmdRejectPending(flags);
        case 'pause-connection': return cmdPauseConnection(flags);
        case 'resume-connection': return cmdResumeConnection(flags);
        case 'disconnect': return cmdDisconnect(flags);
        case 'rotate-token': return cmdRotateToken(flags);
        // Unified conversations (both directions)
        case 'conversations': return cmdConversations(flags);
        case 'read': return cmdRead(flags);
        case 'send': return cmdSend(flags);
        case 'check': return cmdCheck(flags);
        // Reach out (active connect)
        case 'inspect-invite': return cmdInspectInvite(flags);
        case 'connect': return cmdConnect(flags);
        case 'check-approval': return cmdCheckApproval(flags);
        case 'list-sessions': return cmdListSessions();
        case 'forget-session': return cmdForgetSession(flags);
        // Incoming requests (passive)
        case 'requests': return cmdRequests(flags);
        case 'approve': return cmdAcceptPending(flags);
        case 'reject': return cmdRejectPending(flags);
        case 'recall': return cmdRecall(flags);
        case 'remember': return cmdRemember(flags);
        case 'get-directive': return cmdGetDirective(flags);
        case 'set-directive': return cmdSetDirective(flags);
        default:
            throw new CliError(`Unknown subcommand: ${subcommand}. Run with --help to see available commands.`);
    }
}
// Reference unused imports so strict TS doesn't complain about prepared
// surfaces that the stubs don't actively touch yet.
void fsConstants;
main().catch(fail);
