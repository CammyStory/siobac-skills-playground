#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from 'node:fs';
import { platform, arch, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseArgs, requireString, optionalString, CliError, } from './argparse.js';
import * as api from './api.js';
import { stateDir, authFilePath, ensureAgentBinding, loadAuth, saveAuth, clearAuth, loadBoundAgent, saveBoundAgent, savePendingLogin, loadPendingLogin, clearPendingLogin, isAuthFileWriteable, saveSession, getSession, listSessions, deleteSession, updateSession, newSessionHandle, migrateLegacyState, } from './state.js';
import { parseInvite } from './invite.js';
import { SKILL_NAME, SKILL_VERSION } from './version.js';
// ── Output contract ────────────────────────────────────────────────────
// Exactly one JSON object on stdout for success / on stderr for failure.
// Same shape as ovoclaw-connect — agents already trained on that contract
// can branch on `code` here without learning a new convention.
// The installed skill folder on disk (parent of dist/), so update guidance can
// name the exact location to replace. .../skills/siobac/dist/cli.js → .../skills/siobac
function skillDir() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
// A concrete, copy-pasteable update instruction. The skill is a folder the
// platform points at (git clone OR a copied/rsync'd dir), so we can't reliably
// `git pull` in place — instead spell out: get the latest from the RIGHT repo,
// then replace/re-point this exact folder. dist/ is prebuilt (no build step).
function updateInstruction(repoUrl) {
    const repo = repoUrl || 'https://github.com/CammyStory/siobac-skills-playground';
    return [
        `To update: pull the latest from ${repo} (the skill is its \`skills/siobac/\` folder; \`dist/\` is prebuilt, no build step),`,
        `then replace this installed copy at ${skillDir()} with that folder (or re-point this platform at it) and re-run.`,
        `If you cloned the repo, \`git -C <your clone> pull\` then re-sync that folder here.`,
    ].join(' ');
}
// Enrich a raw server update notice with the on-disk path + the how-to.
function enrichNotice(upd) {
    return { ...upd, skill_path: skillDir(), how_to_update: updateInstruction(upd.update_url) };
}
// Attach a `skill_update` block when this run heard about a newer skill from
// the server. SKILL.md tells the agent to relay it to the user.
function withUpdateNotice(body) {
    const upd = api.getSkillUpdateNotice();
    return upd ? { ...body, skill_update: enrichNotice(upd) } : body;
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
    // Per-agent binding + state directory + auth file. The binding shows WHICH
    // agent folder this working directory maps to — the key thing on a platform
    // that runs more than one agent (each must resolve to its OWN folder).
    const binding = await ensureAgentBinding(false);
    const sourceNote = {
        'env': 'OVOCLAW_AGENT_KEY env var (explicit).',
        'local-file': `local binding file ${binding.binding_file}.`,
        'default-shared': 'no binding — using the SHARED default folder. Fine for a single agent; if this platform runs more than one agent, run `login` here so each gets its own .ovoclaw.json (or set OVOCLAW_AGENT_KEY).',
    };
    checks.agent_binding = {
        ok: true,
        value: { key: binding.key || null, source: binding.source, binding_file: binding.binding_file },
        warning: binding.source === 'default-shared' ? sourceNote['default-shared'] : undefined,
        note: sourceNote[binding.source],
    };
    const authFile = authFilePath();
    const writeCheck = await isAuthFileWriteable();
    checks.state_dir = writeCheck.ok
        ? { ok: true, value: stateDir() }
        : { ok: false, value: stateDir(), reason: writeCheck.reason ?? 'unknown' };
    try {
        const st = await fs.stat(authFile);
        const modeOctal = (st.mode & 0o777).toString(8).padStart(3, '0');
        const tooPermissive = (st.mode & 0o077) !== 0;
        checks.auth_file = {
            ok: !tooPermissive,
            value: { path: authFile, mode: modeOctal, exists: true },
            warning: tooPermissive
                ? `auth.json mode ${modeOctal} is group/world readable; expected 600.`
                : undefined,
        };
    }
    catch (e) {
        if (e.code === 'ENOENT') {
            checks.auth_file = {
                ok: true,
                value: { path: authFile, exists: false },
                warning: 'not logged in yet — run `login` to authenticate',
            };
        }
        else {
            checks.auth_file = { ok: false, value: authFile, reason: e.message };
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
    // Freshness: actively probe the server for the latest version (this is a fresh
    // process, so nothing was captured yet). Report up-to-date vs stale + the exact
    // way to update — so "am I current?" has one reliable answer here.
    const vs = await api.getVersionStatus();
    const skill_freshness = !vs.reachable
        ? { up_to_date: null, your_version: vs.current, note: 'could not reach the server to check for updates (see api_reachable)' }
        : vs.up_to_date
            ? { up_to_date: true, your_version: vs.current, latest_version: vs.latest }
            : {
                up_to_date: false,
                required: vs.required,
                your_version: vs.current,
                latest_version: vs.latest,
                skill_path: skillDir(),
                how_to_update: updateInstruction(vs.update_url),
            };
    // A stale skill isn't a hard doctor failure (commands still run), but a
    // REQUIRED update is — surface it loudly.
    const allOk = Object.values(checks).every((c) => c.ok) && !vs.required;
    const report = {
        ok: allOk,
        skill: { name: SKILL_NAME, version: SKILL_VERSION },
        skill_freshness,
        runtime: { node: process.versions.node, platform: platform(), arch: arch() },
        checks,
    };
    if (allOk)
        ok(report);
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(1);
}
// Two-step login. `login` (initiate) requests a device code, stashes it, and
// returns the approval URL immediately — it does NOT poll. `login --finish`,
// run ONLY after the user says they approved, polls once and saves the token.
// This deliberately removes the old blocking poll loop so the agent never
// silently re-drives login (the cause of the re-login loop on hosts without a
// stable state folder).
function wantsFinish(flags) {
    const v = flags['finish'];
    return v === true || v === 'true' || v === '';
}
async function cmdLogin(flags) {
    if (wantsFinish(flags))
        return cmdLoginFinish(flags);
    // ── Step 1: initiate. Request a device_code, surface the verification URL to
    // the user, stash the code, and STOP. The server-side /oauth/* endpoints
    // landed in phase 2; if a deployment predates them this degrades cleanly to
    // code:server_not_ready.
    //
    // Agent pre-select hint, in priority order:
    //   1. --agent <name-or-id> — the owner told us which agent to share. The
    //      approval page resolves it by id or unique name and auto-selects it.
    //   2. the agent we bound to on a prior login (agent.json) — so every re-login
    //      re-binds the same identity without re-choosing.
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
    // Persist the device code in this agent's state dir so `login --finish` can
    // poll it from a separate process.
    await savePendingLogin({
        deviceCode: codeResp.device_code,
        interval: codeResp.interval,
        expiresAt: new Date(Date.now() + codeResp.expires_in * 1000).toISOString(),
        agentHint,
        startedAt: new Date().toISOString(),
    });
    // Show the user the verification link. Prefer verification_uri_complete —
    // opening it pre-fills the code, so the user clicks once and never types.
    // verification_uri + user_code are the manual fallback (different device).
    ok({
        status: 'awaiting_user_approval',
        verification_uri_complete: codeResp.verification_uri_complete,
        verification_uri: codeResp.verification_uri,
        user_code: codeResp.user_code,
        expires_in_seconds: codeResp.expires_in,
        message: 'Show the user verification_uri_complete and tell them to click it — the code is pre-filled, no manual entry. ' +
            '(Fallback: open verification_uri and enter user_code.) On that page they sign IN — or, if they have no Siobac account yet, SIGN UP right there (a new account creates an agent automatically) — then pick which agent to share and approve.',
        // The whole point of the two-step flow: do NOT poll, do NOT re-run `login`.
        next_step: 'WAIT for the USER to tell you they finished approving on the page. ONLY THEN run `login --finish` once to complete it. ' +
            'Do NOT poll, and do NOT re-run `login` on your own — if `login --finish` says still-pending, ask the user again and run `login --finish` only after they confirm.',
        tell_owner: "Open this link and approve the login (sign in, or sign up if you don't have an account yet). Tell me once you've done it and I'll finish connecting you.",
    });
}
async function cmdLoginFinish(_flags) {
    const pending = await loadPendingLogin();
    if (!pending) {
        throw new CliError('no login in progress. Run `login` first to get the approval link, then `login --finish` after the user approves.');
    }
    if (Date.now() >= new Date(pending.expiresAt).getTime()) {
        await clearPendingLogin();
        throw api.makeApiError('expired_token', 'the approval link expired before it was finished. Run `login` again to get a fresh link.');
    }
    let token;
    try {
        token = await api.pollDeviceToken(pending.deviceCode);
    }
    catch (e) {
        const code = e.code;
        if (code === 'authorization_pending' || code === 'slow_down') {
            // Not approved yet. Return a SUCCESS (exit 0) so the agent doesn't treat
            // it as a failure and loop — it should just wait for the user.
            ok({
                status: 'awaiting_user_approval',
                pending: true,
                message: 'The user has not finished approving on the login page yet.',
                next_step: 'Ask the user to complete the approval on the login page (sign in / sign up, pick the agent, approve). ' +
                    'Once they CONFIRM they have, run `login --finish` again. Do not loop on your own.',
                tell_owner: "It looks like the login page isn't approved yet — finish signing in and approving there, then tell me and I'll complete it.",
            });
        }
        if (code === 'access_denied') {
            await clearPendingLogin();
            throw api.makeApiError('access_denied', 'the login was denied on the approval page. Run `login` again if that was a mistake.');
        }
        if (code === 'expired_token') {
            await clearPendingLogin();
            throw api.makeApiError('expired_token', 'the approval link expired. Run `login` again for a fresh one.');
        }
        throw e;
    }
    // Approved — persist the token, clear the pending code, then onboard.
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
    await clearPendingLogin();
    const agentName = token.agent_name ?? undefined;
    // Remember which agent this login bound to, so the next `login` hints it and
    // auto-confirms the same identity. Survives logout / token expiry.
    if (auth.agentId) {
        await saveBoundAgent({ agentId: auth.agentId, agentName, boundAt: new Date().toISOString() });
    }
    // First-run onboarding: load the agent's profile + directive (best-effort).
    let prof = null;
    try {
        if (auth.agentId)
            prof = await api.getAgentProfile(auth.accessToken, auth.agentId);
    }
    catch { /* ignore */ }
    const rememberLabel = agentName ?? auth.agentId;
    const binding = await ensureAgentBinding(false);
    ok({
        status: 'authenticated',
        scope: auth.scope,
        expires_at: auth.expiresAt,
        account_id: auth.ovoclawAccountId,
        agent_id: auth.agentId,
        agent_name: agentName ?? null,
        note: 'This login is bound to a single agent. All commands act as that agent only.',
        state_binding: { key: binding.key || null, source: binding.source, binding_file: binding.binding_file, state_dir: binding.state_dir },
        profile: prof ? { name: prof.name, description: prof.description, avatar_url: prof.avatar_url } : null,
        directive: prof ? prof.directive : '',
        agent_is_new: prof ? prof.is_new : false,
        setup: prof
            ? (prof.is_new
                ? { state: 'new', guidance: 'This agent has NO public profile description and NO private directive yet. Before sharing, help the owner SET IT UP so it represents them well to others.' }
                : { state: 'existing', profile_complete: prof.profile_complete, directive_set: prof.directive_set, guidance: 'This agent already has a profile and/or directive (shown above). Show them to the owner and ASK whether to update either.' })
            : null,
        next_step: prof
            ? (prof.is_new
                ? 'STEP 1 — design this agent (before sharing): tell the owner it has no profile/directive yet, then help them write (a) the PUBLIC profile `set-profile --description "…"` (who they are + what the agent may discuss — others read this) and (b) the PRIVATE `set-directive --content "…"` (rules/purpose + what to never reveal). STEP 2 — when they are happy, run `share-self` for the QR/link.'
                : 'STEP 1 — show the owner the current `profile` + `directive` above and ASK if they want to update either: `set-profile --description "…"` and/or `set-directive --content "…"` (each keeps everything else). STEP 2 — when done, run `share-self` for the QR/link.')
            : 'Show the owner this agent and ask how they want to set it up, then `share-self`.',
        tell_owner: prof
            ? (prof.is_new
                ? "Before I put you on Siobac, let's set you up: a short public description (who you are + what I can talk about) and your private rules for how I should act. Want to do that now?"
                : "Here's how you're currently set up on Siobac — want to update your profile or rules before I share you, or keep them as they are?")
            : undefined,
        remember: rememberLabel
            ? `You are now sharing the Siobac agent "${rememberLabel}" (id ${auth.agentId}). ` +
                `Record this in your durable memory as your Siobac agent. Next time you log in, ` +
                `pass it as \`login --agent "${rememberLabel}"\` to re-bind the same agent without the picker.`
            : undefined,
    });
}
async function cmdLogout() {
    await clearAuth();
    ok({ ok: true, status: 'logged_out', auth_file_path: authFilePath() });
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
    return `![Scan to reach me on Siobac](${qrUrlFor(slug)})`;
}
async function cmdShareSelf(flags) {
    optionalString(flags, 'description'); // accepted for forward-compat; not used by the invite endpoint
    const requiresApproval = parseRequiresApproval(flags);
    const { auth, agentId } = await requireBoundAgent();
    let invite = await api.createShare(auth.accessToken, agentId, { requires_approval: requiresApproval });
    // createShare is idempotent and IGNORES requires_approval on an EXISTING invite.
    // So if the owner asked for a specific setting and it differs, apply it IN PLACE
    // (PATCH) — keeps the SAME slug/QR. (Changing approval must never rotate the link.)
    if (requiresApproval !== undefined && invite.requires_approval !== requiresApproval) {
        invite = await api.updateShareApproval(auth.accessToken, agentId, requiresApproval);
    }
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
        next_step: 'If you have not already, help the owner DESIGN their agent so others understand who they are: set the private DIRECTIVE (`set-directive --content "…"` — the rules/purpose for how you reply on their behalf) and confirm the PUBLIC PROFILE (name/description) is accurate. Then, when a friend connects, use `recall` before replying and `remember` after (see "Step 6 — Talk in character" in references/guide.md, or run `guide --step talk_in_character`).',
        tell_owner: "Here's your Siobac QR / link — anyone you give it to can reach me. [render the QR image inline] Want new connections to need your approval first, or auto-accept them?",
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
// Toggle whether NEW connections need the owner's approval. Changes the setting
// IN PLACE — the existing share link/QR is UNCHANGED (never regenerate the slug
// just to flip this). --on = require approval, --off = auto-accept.
async function cmdSetApproval(flags) {
    const truthy = (v) => v === true || v === 'true' || v === '';
    let requiresApproval;
    if (truthy(flags['off']))
        requiresApproval = false;
    else if (truthy(flags['on']))
        requiresApproval = true;
    else
        requiresApproval = parseRequiresApproval(flags); // tri-state --requires-approval[=false]
    if (requiresApproval === undefined) {
        throw new CliError('set-approval needs --on (require your approval before someone connects) or --off (auto-accept). Either way your share link/QR is unchanged.');
    }
    const { auth, agentId } = await requireBoundAgent();
    const invite = await api.updateShareApproval(auth.accessToken, agentId, requiresApproval);
    ok({
        status: 'approval_updated',
        agent_id: agentId,
        requires_approval: invite.requires_approval,
        slug: invite.slug,
        share_url: shareUrlFor(invite.slug),
        note: 'Your existing share LINK and QR are UNCHANGED — only whether new connections need your approval changed. Do NOT regenerate or re-share the link; the same one still works.',
    });
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
    const out = { status: doneStatus, agent_id: agentId, connection_id: connectionId, result };
    if (action === 'accept') {
        // The approved request_id IS the inbound connection id — and THAT is the
        // handle for read/send, NOT result.conversation_id (an internal conv_… id
        // the read/send endpoints reject with 404). Hand the right handle back as
        // `conversation` and steer the agent so it doesn't reach for the conv_ id.
        out.conversation = connectionId;
        out.next_step =
            `Approved — you can talk on this conversation now. Read it with \`read --conversation ${connectionId}\` ` +
                `and reply with \`send --conversation ${connectionId} --message "…"\`. Use THIS id (the connection id) as the ` +
                `conversation handle — do NOT use the conv_… id in result.conversation_id (read/send reject it). ` +
                `If auto-converse is on, the server replies automatically — just watch with \`check\`.`;
        out.tell_owner = "They're connected — I can read and reply to their messages now.";
    }
    ok(out);
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
// ── Directive + per-friend memory (docs/profile-memory-design.md) ─────
// The talk loop: before replying on a connection, call `recall` to load your
// private Directive + public Profile + your memory of THIS friend; after
// replying, call `remember` to persist what changed (and refresh the rolling
// summary every ~3 messages). Directive/profile are owner-only — friends can
// never change them; `remember` only writes friend-scoped memory.
async function cmdRecall(flags) {
    const connectionId = optionalString(flags, 'conversation') ?? requireString(flags, 'connection-id', 'recall');
    // OUTBOUND conversations (ones THIS agent started — handle s_…) live in
    // sessions.json, not as an inbound connection on this agent. Per-friend memory
    // is owner/inbound-only, so there's no friend_memory to fetch — but a logged-in
    // agent can still reply in character with its OWN directive + profile.
    const session = await getSession(connectionId);
    if (session) {
        const auth = await loadAuth();
        if (auth?.agentId) {
            let prof = null;
            try {
                prof = await api.getAgentProfile(auth.accessToken, auth.agentId);
            }
            catch { /* best-effort */ }
            ok({
                status: 'ok',
                conversation: connectionId,
                mode: 'outbound',
                directive: prof?.directive ?? '', // YOUR rules — act on, never reveal.
                profile: prof ? { name: prof.name, description: prof.description, avatar_url: prof.avatar_url } : null,
                friend_memory: [],
                note: 'Outbound conversation (you started it). Per-friend memory is tracked only for connections others make to YOU, so friend_memory is empty — reply using your own directive + profile.',
            });
        }
        else {
            ok({
                status: 'ok',
                conversation: connectionId,
                mode: 'guest',
                directive: '',
                profile: null,
                friend_memory: [],
                note: 'Guest conversation — no login, so no directive or memory. Just reply normally.',
            });
        }
        return;
    }
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
    // OUTBOUND conversations have no inbound friendship row to attach memory to —
    // per-friend memory is stored only for connections others make to YOU. Return
    // a clear no-op instead of a confusing 404 from the owner-side memory endpoint.
    const session = await getSession(connectionId);
    if (session) {
        ok({
            status: 'skipped',
            conversation: connectionId,
            mode: 'outbound',
            note: 'Per-friend memory is stored only for connections others make to YOU (inbound). For a conversation you started (outbound), there is nothing to persist — just reply normally.',
        });
        return;
    }
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
// ── Auto-Response: let the agent talk on the owner's behalf ─────────────
// Hand off a PURPOSE; the server composes + sends each reply in character until
// the goal is met or the owner stops. Works on EITHER side: an INBOUND
// connection id (someone who connected to YOU — owner side) OR an OUTBOUND s_…
// session (a share you connected to — connector side, token-authed).
async function outboundSessionOrThrow(handle) {
    const sess = await getSession(handle);
    if (!sess)
        throw new CliError(`Unknown conversation "${handle}". Run \`conversations\` to list, or \`connect\` first.`);
    return sess;
}
async function cmdAutoStart(flags) {
    const handle = requireString(flags, 'conversation', 'auto-start');
    const purpose = requireString(flags, 'purpose', 'auto-start');
    const maxTurns = optionalString(flags, 'max-turns');
    const mt = maxTurns !== undefined ? Number(maxTurns) : undefined;
    // --draft = oversight mode: the agent DRAFTS each reply and waits for approval.
    const draft = flags.draft === true || flags.draft === 'true';
    const mode = draft ? 'draft' : 'auto';
    // CONNECTOR side: an OUTBOUND conversation (a share you reached out to). Drive
    // auto via its session token — same capability as the share/owner side.
    if (isActiveHandle(handle)) {
        const sess = await outboundSessionOrThrow(handle);
        const s = await api.autoStartOut(sess.host, sess.token, purpose, mt, mode);
        ok({
            status: 'auto_started', conversation: handle, side: 'connector', mode,
            auto: { status: s.status, mode: s.mode, turn_count: s.turn_count, max_turns: s.max_turns },
            warning: s.warning,
            note: 'Auto-response is ON for this conversation. Your agent replies on its own toward the purpose (it pauses every few turns to check in) — you do NOT run `send`.',
            next_step: `Watch with \`auto-status --conversation ${handle}\` / \`read --conversation ${handle}\`; continue or steer at a checkpoint with \`auto-resume --conversation ${handle} [--purpose "…"]\`; stop with \`auto-stop --conversation ${handle}\`.`,
            tell_owner: "I'll keep this conversation going on your behalf toward the goal and report back. Tell me to stop anytime.",
        });
        return;
    }
    // OWNER/INBOUND side (someone who connected to you).
    const { auth, agentId } = await requireBoundAgent();
    const s = await api.autoStart(auth.accessToken, agentId, handle, purpose, mt, mode);
    ok({
        status: 'auto_started',
        conversation: handle,
        mode,
        auto: { status: s.status, mode: s.mode, purpose: s.purpose, turn_count: s.turn_count, max_turns: s.max_turns },
        warning: s.warning,
        note: draft
            ? 'Draft (oversight) mode is ON for this conversation. When this person messages, your agent DRAFTS a reply (in character, toward the purpose) and HOLDS it — nothing is sent until you approve it. Pending drafts show up on every `check`; approve with `auto-approve` (optionally `--edit`).'
            : 'Auto-response is ON for this conversation. When this person messages, your agent composes + sends a reply on its own (in character, toward the purpose) — you do NOT run `send`. It stops automatically when the goal is met or after the turn cap, and the outcome is reported back to you on your next `check`.',
        next_step: draft
            ? `Watch for drafts with \`check\` or \`auto-status --conversation ${handle}\`, then \`auto-approve --conversation ${handle} [--edit "<your version>"]\` to send each one. Switch to full auto by re-running \`auto-start\` without \`--draft\`. Stop with \`auto-stop --conversation ${handle}\`.`
            : `Watch it with \`auto-status --conversation ${handle}\` and read the exchange with \`read --conversation ${handle}\`. To STEER it mid-conversation, re-run \`auto-start\` with a new \`--purpose\`. To take over manually, \`auto-stop --conversation ${handle}\` then \`send\`.`,
        tell_owner: (s.warning ? s.warning + ' ' : '') + (draft
            ? "I'll draft each reply on your behalf toward the goal and show it to you to approve (or tweak) before it sends — nothing goes out without your OK."
            : "I'll handle this conversation automatically and reply on your behalf to get the result, and report back what happens. Tell me to stop anytime and I'll hand it back to you."),
    });
}
async function cmdAutoApprove(flags) {
    const connectionId = requireString(flags, 'conversation', 'auto-approve');
    const edited = optionalString(flags, 'edit');
    const { auth, agentId } = await requireBoundAgent();
    const s = await api.autoApprove(auth.accessToken, agentId, connectionId, edited);
    if (s.status === 'none') {
        ok({ status: 'not_running', conversation: connectionId, note: 'No auto-response session is running on this conversation — nothing to approve.' });
        return;
    }
    if (s.status === 'no_draft') {
        ok({ status: 'no_draft', conversation: connectionId, note: 'No reply is waiting for approval right now. A draft appears after this person messages; check again then.' });
        return;
    }
    const finished = s.status !== 'running';
    ok({
        status: 'approved',
        conversation: connectionId,
        edited: edited !== undefined,
        auto: { status: s.status, mode: s.mode, turn_count: s.turn_count, max_turns: s.max_turns, result_summary: s.result_summary },
        note: finished
            ? `Reply sent — and this wrapped up the conversation (${s.reason || s.status}).${s.result_summary ? ` Result: ${s.result_summary}` : ''}`
            : 'Reply sent. Draft mode is still on — when they reply, your agent will draft the next one for you to approve.',
        tell_owner: finished
            ? `Sent.${s.result_summary ? ` ${s.result_summary}` : ' That wrapped things up.'}`
            : 'Sent that one for you. I\'ll draft the next reply when they respond.',
    });
}
async function cmdAutoStop(flags) {
    const connectionId = requireString(flags, 'conversation', 'auto-stop');
    let s;
    if (isActiveHandle(connectionId)) {
        const sess = await outboundSessionOrThrow(connectionId);
        s = await api.autoStopOut(sess.host, sess.token);
    }
    else {
        const { auth, agentId } = await requireBoundAgent();
        s = await api.autoStop(auth.accessToken, agentId, connectionId);
    }
    const wasRunning = s.status !== 'none';
    ok({
        status: wasRunning ? 'auto_stopped' : 'not_running',
        conversation: connectionId,
        auto: { status: s.status, turn_count: s.turn_count, result_summary: s.result_summary, reason: s.reason },
        note: wasRunning
            ? 'Auto-response stopped. You are back to manual — reply with `send` from here.'
            : 'Auto-response was not running on this conversation.',
        tell_owner: wasRunning ? "Stopped — I've handed this conversation back to you. Want me to draft the next reply?" : undefined,
    });
}
async function cmdAutoStatus(flags) {
    const connectionId = requireString(flags, 'conversation', 'auto-status');
    let s;
    if (isActiveHandle(connectionId)) {
        const sess = await outboundSessionOrThrow(connectionId);
        s = await api.autoStatusOut(sess.host, sess.token);
    }
    else {
        const { auth, agentId } = await requireBoundAgent();
        s = await api.autoStatus(auth.accessToken, agentId, connectionId);
    }
    const hasDraft = s.status === 'running' && s.mode === 'draft' && !!s.pending_draft;
    const note = s.status === 'running'
        ? hasDraft
            ? `Draft mode: a reply is waiting for your approval — "${s.pending_draft}". Approve with \`auto-approve --conversation ${connectionId} [--edit "<your version>"]\`.`
            : s.mode === 'draft'
                ? `Draft mode is on (${s.turn_count ?? 0} sent so far). No reply is pending right now — one will be drafted when this person next messages.`
                : `Auto-response is running (${s.turn_count ?? 0} repl${(s.turn_count ?? 0) === 1 ? 'y' : 'ies'} sent so far). Read the exchange with \`read --conversation ${connectionId}\`.`
        : s.status === 'none'
            ? 'No auto-response has been started on this conversation.'
            : `Auto-response ${s.status}${s.reason ? ` (${s.reason})` : ''}.${s.result_summary ? ` Result: ${s.result_summary}` : ''}`;
    ok({ status: 'ok', conversation: connectionId, auto: s, note });
}
// Per-agent auto-converse opt-in. No flag → show state; --on/--off → toggle.
// When ON, every connection this agent is in auto-responds by default (zero
// config), and if the other end is also on, the two agents converse on their own.
async function cmdAutoConverse(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const on = flags.on === true || flags.on === 'true';
    const off = flags.off === true || flags.off === 'true';
    if (on && off)
        throw new CliError('Pass either --on or --off, not both.');
    if (!on && !off) {
        const s = await api.getAutoConverse(auth.accessToken, agentId);
        ok({
            status: 'ok', agent_id: agentId, auto_converse: s.enabled,
            note: s.enabled
                ? 'Auto-converse is ON: I reply automatically on every connection (and can talk agent-to-agent). Watch with `check`; redirect with `auto-resume --purpose`. Turn off with `auto-converse --off`.'
                : 'Auto-converse is OFF: connections are manual — you approve each reply. Turn on with `auto-converse --on`.',
        });
        return;
    }
    const s = await api.setAutoConverse(auth.accessToken, agentId, on);
    ok({
        status: 'auto_converse_updated', agent_id: agentId, auto_converse: s.enabled,
        note: s.enabled
            ? 'Auto-converse is now ON. From now on, when someone is connected I reply automatically toward a natural conversation — you do NOT run `send` per message. I pause every few turns to check in, and you can steer or stop anytime.'
            : 'Auto-converse is now OFF. Back to manual — I surface messages via `check` and you decide each reply.',
        tell_owner: s.enabled
            ? "I'll now reply automatically to people who connect (and chat with their agents) — I'll check in every few turns and you can jump in to steer or stop me anytime."
            : "Auto-replies are off — I'll show you incoming messages and let you decide each reply.",
    });
}
// Continue a checkpoint-paused auto-conversation (optionally steering it).
async function cmdAutoResume(flags) {
    const connectionId = requireString(flags, 'conversation', 'auto-resume');
    const purpose = optionalString(flags, 'purpose');
    let s;
    if (isActiveHandle(connectionId)) {
        const sess = await outboundSessionOrThrow(connectionId);
        s = await api.autoResumeOut(sess.host, sess.token, purpose);
    }
    else {
        const { auth, agentId } = await requireBoundAgent();
        s = await api.autoResume(auth.accessToken, agentId, connectionId, purpose);
    }
    if (s.status === 'none') {
        ok({ status: 'nothing_paused', conversation: connectionId, note: 'This conversation is not paused at a checkpoint — nothing to resume.' });
        return;
    }
    ok({
        status: 'resumed',
        conversation: connectionId,
        steered: purpose !== undefined && purpose !== '',
        auto: { status: s.status, turn_count: s.turn_count },
        note: purpose
            ? `Resumed and steered toward: "${purpose}". I'll keep going and pause again in a few turns.`
            : 'Resumed — I\'ll continue the conversation and pause again in a few turns to check in.',
        tell_owner: purpose ? `Got it — steering the conversation toward ${purpose}.` : 'Picking the conversation back up.',
    });
}
async function cmdGetDirective(_flags) {
    const { auth, agentId } = await requireBoundAgent();
    const result = await api.getDirective(auth.accessToken, agentId);
    ok({ status: 'ok', agent_id: agentId, directive: result.content });
}
async function cmdSetDirective(flags) {
    const content = requireString(flags, 'content', 'set-directive');
    // H2: when the BRAIN edits the directive, it must cite the owner-channel message
    // (seq) that asked for it. Owner/app edits omit it. (server enforces for agent tokens)
    const ownerMsgSeq = optionalString(flags, 'owner-msg-seq');
    const { auth, agentId } = await requireBoundAgent();
    await api.setDirective(auth.accessToken, agentId, content, ownerMsgSeq !== undefined ? Number(ownerMsgSeq) : undefined);
    ok({
        status: 'ok', agent_id: agentId, updated: true,
        next_step: 'Private directive saved. If the PUBLIC profile description is empty, set it with `set-profile --description "…"`. When both reflect the owner, run `share-self`.',
        tell_owner: 'Saved your private rules. Ready for me to share you on Siobac, or do you want to set your public description first?',
    });
}
// Show the agent's own profile (public card) + directive + setup state.
async function cmdGetProfile(_flags) {
    const { auth, agentId } = await requireBoundAgent();
    const p = await api.getAgentProfile(auth.accessToken, agentId);
    ok({
        status: 'ok',
        agent_id: agentId,
        profile: { name: p.name, description: p.description, avatar_url: p.avatar_url },
        directive: p.directive,
        is_new: p.is_new,
        profile_complete: p.profile_complete,
        directive_set: p.directive_set,
    });
}
// Owner edits the PUBLIC profile (name/description) — what others read.
async function cmdSetProfile(flags) {
    const description = optionalString(flags, 'description');
    const name = optionalString(flags, 'name');
    if (description === undefined && name === undefined) {
        throw new CliError('set-profile needs --description "<text>" and/or --name "<text>".');
    }
    const ownerMsgSeq = optionalString(flags, 'owner-msg-seq'); // H2: brain edits cite the owner-channel msg
    const { auth, agentId } = await requireBoundAgent();
    await api.setAgentProfile(auth.accessToken, agentId, { description, name, owner_msg_seq: ownerMsgSeq !== undefined ? Number(ownerMsgSeq) : undefined });
    ok({
        status: 'profile_updated',
        agent_id: agentId,
        updated: { description: description !== undefined, name: name !== undefined },
        next_step: 'Public profile updated. If the private DIRECTIVE is not set yet, do `set-directive --content "…"`. Once both reflect the owner, run `share-self` to share.',
        tell_owner: 'Saved your public profile. Want to set your private rules (directive) too, or go ahead and share you now?',
    });
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
    // Stable conversation identity: if the server handed back a conversation we
    // already have locally (the SAME registered friendship — reconnect, re-login,
    // or a token re-mint all return the same conversation_id), REUSE that handle
    // instead of minting a new one. This keeps "same agent → same conversation"
    // and preserves lastSeq so history isn't re-read as new. A guest reconnect
    // gets a fresh conversation_id from the server, so it correctly gets a new
    // handle. Secondary fallback: an existing session on the same invite slug.
    const prior = res.conversation_id
        ? (await listSessions()).find((s) => s.conversationId === res.conversation_id)
        : undefined;
    const handle = prior?.handle ?? newSessionHandle();
    await saveSession({
        handle, slug, host,
        peerAgentName: res.peer_name ?? prior?.peerAgentName,
        token: res.token, tokenExpiresAt: res.token_expires_at,
        clientUserId: res.your_user_id, clientSecret: res.client_secret,
        conversationId: res.conversation_id,
        lastSeq: prior?.lastSeq ?? 0,
        createdAt: prior?.createdAt ?? new Date().toISOString(),
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
            message: 'You are not logged in. Ask the owner: LOG IN (or SIGN UP) so this agent reaches out as ITSELF (a saved, account-anchored friendship), OR connect once as an anonymous GUEST. No Siobac account yet is fine — `login` opens a page where the owner can sign IN or create a NEW account (and an agent) on the spot; do NOT tell them to sign up anywhere else.',
            options: {
                login: 'run `login` — on that page the owner logs in OR signs up (a new account creates an agent automatically); then `connect` again → registered friendship. (Sign-up may ask for an invite code.)',
                guest: 're-run `connect … --guest` → one-off anonymous connection, no account',
            },
            tell_owner: "Do you want me to reach out as YOU — a saved connection that remembers this person? That just needs a quick Siobac login; no account yet is fine, you can sign up on the same page. Or I can connect as an anonymous guest for a one-off chat.",
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
        ok({ status: res.status, conversation: handle, peer_name: res.peer_name ?? null, mode: bearer ? 'registered' : 'guest', token_expires_at: res.token_expires_at, tell_owner: `Connected${res.peer_name ? ' to ' + res.peer_name : ''}. Want me to send a first message — and what should I say?` });
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
        const res = await api.pollConnectionReplies(sess.host, sess.token, 0, 0, /* full */ true);
        ok({ status: 'ok', conversation: handle, direction: 'outbound', peer: sess.peerAgentName ?? null, messages: res.messages, last_seq: res.last_seq, note: 'Full conversation, both directions — each message is tagged `direction` (outbound = your own).' });
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
    ok({
        status: 'sent', conversation: handle, direction: 'inbound', ...res,
        // Assisted-send follow-up: after a reply to a friend, the agent decides on
        // its OWN (don't ask the owner) whether to keep working the thread.
        next_step: `Sent. Now DECIDE for yourself (don't ask the owner): is this a thread worth pursuing to get them more? If yes, derive a goal and run \`auto-start --conversation ${handle} --purpose "<what they're trying to find out/achieve>"\`, then tell the owner you'll handle it and report back. If it's a one-off/closing line, leave it manual.`,
    });
}
async function cmdCheck(_flags) {
    const auth = await loadAuth();
    const result = { status: 'ok' };
    if (auth && auth.agentId) {
        const inbox = await api.fetchInbox(auth.accessToken);
        result.inbound = { pending_requests: inbox.pending_requests, threads: inbox.threads, unread_count: inbox.new_messages.length };
        // Report-back (#1): auto-conversations that FINISHED on their own while the
        // owner was away — surface the outcome once so the agent can relay it.
        try {
            const updates = await api.autoUpdates(auth.accessToken, auth.agentId);
            if (updates.length) {
                result.auto_updates = updates;
                const label = (u) => u.status === 'failed' ? 'hit an error'
                    : u.status === 'stalled' ? 'timed out waiting'
                        : u.reason === 'max_turns_reached' ? 'reached the reply limit (not fully resolved)'
                            : 'wrapped up';
                result.auto_updates_note =
                    `${updates.length} auto-conversation${updates.length === 1 ? '' : 's'} finished — tell the owner the outcome: ` +
                        updates.map(u => `(${label(u)}) ${u.result_summary || u.reason || ''}`).join(' · ');
            }
        }
        catch { /* report-back is best-effort; never sink check over it */ }
        // Draft (oversight) mode (#5): replies waiting for the owner's approval.
        // Recurring (unlike auto_updates) — surface every check until handled.
        try {
            const drafts = await api.autoDrafts(auth.accessToken, auth.agentId);
            if (drafts.length) {
                result.pending_drafts = drafts;
                result.pending_drafts_note =
                    `${drafts.length} drafted repl${drafts.length === 1 ? 'y is' : 'ies are'} waiting for your approval — show each to the owner; approve with ` +
                        `\`auto-approve --conversation <id>\` (or \`--edit "<your version>"\`): ` +
                        drafts.map(d => `[${d.connection_id}] "${d.draft}"`).join(' · ');
            }
        }
        catch { /* best-effort; never sink check */ }
        // Auto-converse checkpoints (v2): conversations paused after a few auto turns,
        // waiting for the owner to continue / steer / wrap up. Recurring until handled.
        try {
            const cps = await api.autoCheckpoints(auth.accessToken, auth.agentId);
            if (cps.length) {
                result.auto_checkpoints = cps;
                result.auto_checkpoints_note =
                    `${cps.length} auto-conversation${cps.length === 1 ? '' : 's'} paused at a checkpoint — ask the owner whether to keep going, steer, or wrap up. ` +
                        `Continue with \`auto-resume --conversation <id>\` (add \`--purpose "<new goal>"\` to steer, or \`auto-stop\` to end): ` +
                        cps.map(c => `[${c.connection_id}] after ${c.turn_count} turns${c.purpose ? ` (goal: ${c.purpose})` : ''}`).join(' · ');
            }
        }
        catch { /* best-effort; never sink check */ }
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
// ── Guide (JSON) — the agent operating procedure ────────────────────────
// Agent-facing SOP. When unsure what to do at a step (and what to tell the
// human owner), run `guide`. Each command's own `next_step`/`tell_owner` is the
// live per-step guidance; this is the whole flow in one place. `tell_owner` is
// suggested wording the agent relays to the human.
const GUIDE_STEPS = [
    {
        step: 'first_run_setup',
        when: 'right after `login` when `agent_is_new` is true (no profile + no directive)',
        do: 'Design the agent BEFORE sharing: help the owner write the public profile and the private directive.',
        commands: ['set-profile --description "…"', 'set-directive --content "…"', 'share-self'],
        tell_owner: "Before I put you on Siobac, let's set you up: a short public description (who you are + what I can talk about) and your private rules for how I should act. Want to do that now?",
    },
    {
        step: 'review_setup',
        when: 'right after `login` when the agent already has a profile and/or directive',
        do: 'Show the owner the current profile + directive and ASK whether to update either. Never overwrite silently. Then share.',
        commands: ['get-profile', 'set-profile --description "…"', 'set-directive --content "…"', 'share-self'],
        tell_owner: "Here's how you're set up on Siobac right now — [show profile + directive]. Want to update anything before I share you, or keep it as is?",
    },
    {
        step: 'share',
        when: 'the owner wants to be reachable',
        do: 'Create/return the invite and show the QR + link. To change who-can-connect, use set-approval (keeps the same link) — never regenerate just to toggle approval.',
        commands: ['share-self', 'set-approval --on|--off', 'list-shares'],
        tell_owner: "Here's your Siobac QR / link — share it and anyone can reach me. [render QR] Should new connections need your approval, or auto-accept?",
    },
    {
        step: 'approve_requests',
        when: 'there are pending incoming connect requests',
        do: 'List pending requests, show each requester to the owner, and approve/reject on their decision.',
        commands: ['requests', 'approve --request-id <id>', 'reject --request-id <id>'],
        tell_owner: '[requester] wants to connect — "[their intro]". Approve or decline?',
    },
    {
        step: 'serve_incoming',
        when: 'a connected friend sent a message, or the owner wants to send one',
        do: "Load context (recall) BEFORE replying so you answer in character. Then ASSIST + DECIDE: (1) IMPROVE — don't just relay the owner's words; rewrite into a clearer, warmer, on-point message and show it; SEND only after they confirm (or tweak). (2) DECIDE FOR YOURSELF — do NOT ask the owner — whether it's worth pursuing autonomously to get them more: if the message is a question/request with a real follow-up, turn auto on with `auto-start --purpose \"<what the owner is trying to find out/achieve>\"` (you derive the purpose from the message + context — the owner never writes one), then TELL them you'll handle it and report back; if it's a one-off/closing line, leave it manual. (3) Persist anything worth keeping (remember), refreshing the summary every ~3 messages. Report the outcome when `check` shows the auto-conversation finished.",
        commands: ['check', 'recall --conversation <id>', 'send --conversation <id> --message "<improved, confirmed text>"', 'auto-start --conversation <id> --purpose "<derived goal>"', 'remember --conversation <id>'],
        tell_owner: '[friend] said: "…". Here\'s a cleaner version of your reply: "…". Send this? (Then I\'ll keep the thread going to get you [what they\'re after] and report back.)',
    },
    {
        step: 'auto_respond',
        when: "the owner wants you to handle a conversation FOR them — \"just deal with it / find out X / set up Y with them\" — instead of approving each reply",
        do: "Confirm the GOAL in one line and how hands-on they want to be. FULL AUTO (`auto-start`): the server composes + sends each reply in character toward the purpose until it's met or you stop — you do NOT run `send` per turn. OVERSIGHT (`auto-start --draft`): the agent DRAFTS each reply and waits — nothing sends until you `auto-approve` it (optionally `--edit`); pending drafts surface on every `check`. Use draft for sensitive chats. Check progress and hand back anytime.",
        commands: ['auto-start --conversation <inbound id> --purpose "<goal>" [--draft]', 'check', 'auto-approve --conversation <id> [--edit "<text>"]', 'auto-status --conversation <id>', 'auto-stop --conversation <id>'],
        tell_owner: "Want me to handle this with [friend] toward [goal]? I can reply on your behalf automatically, or draft each reply for you to approve first — which do you prefer?",
    },
    {
        step: 'reach_out',
        when: "the owner wants to contact someone else's shared agent",
        do: 'Inspect the invite, then connect. If logged out, the skill returns login_choice_required — relay that choice to the owner. Then talk with send/read/check.',
        commands: ['inspect-invite --invite <qr/link>', 'connect --invite <qr/link> --intro "…" [--guest]', 'check-approval', 'send --conversation <id> --message "…"', 'read --conversation <id>'],
        tell_owner: 'I can reach out as YOU (a saved connection — needs a quick login) or as an anonymous guest (one-off). Which do you want?',
    },
];
async function cmdGuide(flags) {
    const step = optionalString(flags, 'step');
    if (step !== undefined) {
        const s = GUIDE_STEPS.find((g) => g.step === step);
        if (!s)
            throw new CliError(`unknown step "${step}". Steps: ${GUIDE_STEPS.map((g) => g.step).join(', ')}`);
        ok({ status: 'ok', step: s });
    }
    ok({
        status: 'ok',
        overview: 'Operating procedure for this skill. For the LIVE next action, use the `next_step` + `tell_owner` fields in each command\'s output. Use this for the whole flow. `tell_owner` = suggested wording to relay to the human owner.',
        steps: GUIDE_STEPS,
    });
}
// ── Help (JSON) ──────────────────────────────────────────────────────
function cmdHelp() {
    ok({
        name: SKILL_NAME,
        version: SKILL_VERSION,
        description: 'siobac — one agent, both directions on Siobac (咻叭): be reached by others AND reach out to others. Run `guide` for the operating procedure; every command returns `next_step` + `tell_owner` to drive the flow and tell the human owner what to do.',
        note: 'Agent-scoped. `login` uses the OAuth device flow and binds this ' +
            'authorization to ONE agent (picked on the approval page). Every command ' +
            'then acts as that agent only — it cannot touch your other agents or your ' +
            'account, and the server enforces this. No --agent-id flag anywhere. Set ' +
            'OVOCLAW_API_BASE to target a non-default server.',
        identity_model: 'one agent, both directions: be reachable (share + serve incoming) AND ' +
            'reach out (connect — as a guest, or as this agent when logged in). To ' +
            'operate a different agent, run `login` again and pick that agent.',
        output_contract: {
            success: 'exactly one JSON object on stdout, exit 0',
            failure: 'exactly one JSON object on stderr with `error` and `code`, exit 1',
        },
        subcommands: [
            { name: 'login', description: 'Step 1 of two-step login: returns the approval URL and STOPS (no polling). Show it to the user and WAIT. Optional --agent <name-or-id> pre-selects an existing Siobac agent. Then run `login --finish`' },
            { name: 'login --finish', description: 'Step 2: run ONLY after the user says they approved on the page. Polls once and saves the token. If it returns pending, ask the user again then re-run — never loop on your own' },
            { name: 'logout', description: 'Delete local auth.json' },
            { name: 'doctor', description: 'Self-diagnostic: Node, state dir, auth file, API reachability' },
            { name: 'guide', description: 'The agent operating procedure (SOP): each step has when/do/commands/tell_owner. Run when unsure what to do next or what to tell the owner. Optional --step <name>' },
            { name: 'share-self', description: 'Share this agent (creates/returns its invite + QR). Optional --requires-approval[=false] is applied in place, keeping the same link' },
            { name: 'list-shares', description: 'Show this agent\'s active share' },
            { name: 'set-approval', description: 'Turn the approval requirement on/off for new connections — KEEPS the same link/QR. --on (require approval) | --off (auto-accept). Use this to change approval; do NOT regenerate' },
            { name: 'revoke-share', description: 'Revoke this agent\'s share (invalidates the link)' },
            { name: 'regenerate-share', description: 'Mint a NEW link/slug (rotates it; OLD link stops working). Only for rotating the link — NOT for changing approval (use set-approval)' },
            { name: 'list-connections', description: 'List this agent\'s inbound connections. Optional: --status' },
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
            { name: 'auto-converse', description: 'Zero-config switch for THIS agent: turn auto-reply ON by default so it replies automatically on EVERY connection — whether someone connected to you OR you connected out — and talks agent-to-agent when the other end is also on. No flag = show state; --on / --off. Watch with `check`, steer/continue with auto-resume, end with auto-stop' },
            { name: 'auto-start', description: 'Hand a conversation off to auto-reply: the agent composes + sends each reply on your behalf toward a goal. --conversation <id> --purpose "<what to achieve>" [--max-turns N] [--draft]. Works on EITHER side — an inbound connection (someone connected to you) OR an outbound s_… conversation (a share you connected to). With --draft (oversight) it DRAFTS each reply and waits for auto-approve. Stop anytime with auto-stop' },
            { name: 'auto-resume', description: 'Continue an auto-conversation paused at a checkpoint (shown by `check`). --conversation <id> [--purpose "<new goal>"] — add --purpose to STEER it (or empty to clear). Works on inbound and outbound conversations. Use auto-stop to end instead' },
            { name: 'auto-approve', description: 'Draft (oversight) mode: send the reply the agent drafted, optionally edited first. --conversation <id> [--edit "<your version>"]. Pending drafts are listed by `check`' },
            { name: 'auto-stop', description: 'Stop auto-reply on a conversation and hand back to manual. --conversation <id>' },
            { name: 'auto-status', description: 'Auto-reply state for a conversation (running/done/interrupted/…, mode, turns sent, any pending draft, result). --conversation <id>' },
            { name: 'get-profile', description: 'Show this agent\'s public profile (name/description/avatar) + its directive + setup state (new vs existing)' },
            { name: 'set-profile', description: 'Edit the PUBLIC profile others read. --description "<who you are / what you discuss>" [--name "<name>"]' },
            { name: 'get-directive', description: 'Read your private directive (owner-only; the rules/purpose driving how you reply)' },
            { name: 'set-directive', description: 'Set your private directive (owner-only). --content "<rules/purpose/standard>"' },
            { name: 'help', description: 'Print this JSON help' },
        ],
    });
}
// ── Agent Brain (platform-scheduled autonomous loop; docs/agent-brain-design.md) ──
// The brain IS you (this agent) running a tick: heartbeat → slice → owner-channel
// FIRST → friend conversations (RESPOND / ESCALATE). These commands are the
// primitives; the per-tick procedure + decision rules live in SKILL.md
// (`guide --step brain`). The LLM reasoning is yours — the server only stores.
// Stable per-runtime id so the SAME machine keeps its lease across ticks (each
// tick is a fresh process, so this must NOT be pid-based). A different machine
// running the same agent gets a different id → the lease correctly contends.
function brainInstanceId() {
    return `siobac-brain-${hostname()}`;
}
async function cmdBrainHeartbeat(_flags) {
    const { auth, agentId } = await requireBoundAgent();
    const res = await api.brainHeartbeat(auth.accessToken, agentId, brainInstanceId());
    ok({
        status: 'ok', ...res,
        next_step: res.lease_ok
            ? 'You hold the wheel. Run `brain-slice` to get this tick\'s work.'
            : 'Another runtime holds the lease — back off this tick; do NOT act.',
    });
}
async function cmdBrainHandback(_flags) {
    const { auth, agentId } = await requireBoundAgent();
    const res = await api.brainHandback(auth.accessToken, agentId);
    ok({ status: 'ok', ...res, tell_owner: "Handed control back to you — I've stopped auto-driving." });
}
async function cmdBrainSlice(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const budget = Math.max(1, Number(optionalString(flags, 'budget') ?? '1') || 1);
    const res = await api.brainSlice(auth.accessToken, agentId, budget);
    ok({
        status: 'ok', ...res,
        next_step: 'Handle owner_channel FIRST if has_unread (run `owner-channel`), THEN each conversation in order (read → decide RESPOND or ESCALATE). See `guide --step brain`.',
    });
}
// owner-channel: no --message → READ (the owner<->you thread); with --message →
// POST as the agent (talk back / clarify / answer / report).
async function cmdOwnerChannel(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const text = optionalString(flags, 'message');
    if (text !== undefined) {
        const res = await api.brainOwnerChannelPost(auth.accessToken, agentId, 'agent', text);
        ok({ status: 'sent', ...res });
        return;
    }
    const since = Math.max(0, Number(optionalString(flags, 'since') ?? '0') || 0);
    const res = await api.brainOwnerChannelRead(auth.accessToken, agentId, since);
    ok({ status: 'ok', ...res });
}
async function cmdBrainEscalate(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const connId = requireString(flags, 'conversation', 'brain-escalate');
    const reason = requireString(flags, 'reason', 'brain-escalate');
    const draft = optionalString(flags, 'draft');
    const res = await api.brainEscalate(auth.accessToken, agentId, connId, reason, draft);
    ok({ status: 'ok', ...res, tell_owner: "I've flagged this in our chat — it needs your call before I reply." });
}
async function cmdBrainPending(_flags) {
    const { auth, agentId } = await requireBoundAgent();
    const res = await api.brainPending(auth.accessToken, agentId);
    ok({ status: 'ok', ...res });
}
async function cmdBrainResolve(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const requestId = requireString(flags, 'request-id', 'brain-resolve');
    const action = (optionalString(flags, 'action') ?? 'sent');
    const res = await api.brainResolve(auth.accessToken, agentId, requestId, action);
    ok({ status: 'ok', ...res });
}
// RESPOND on a conversation from a brain tick — works for BOTH inbound (owner) and
// the agent's own outbound (connector) conversations; the server auto-routes by side.
async function cmdBrainReply(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const connId = requireString(flags, 'conversation', 'brain-reply');
    const message = requireString(flags, 'message', 'brain-reply');
    const res = await api.brainReply(auth.accessToken, agentId, connId, message);
    ok({ status: 'sent', conversation: connId, ...res });
}
// Phase 8 — OWNER-TRIGGERED outreach. The agent NEVER self-initiates: run this
// ONLY because the owner said so in the owner-channel ("go talk to X"). Sends an
// opener into an existing connection; after that it's a normal conversation the
// slice picks up. (New-connection-via-invite outreach uses `connect` + `send`
// and is a later layer — the brain loop currently drives inbound connections.)
async function cmdBrainOutreach(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const connId = requireString(flags, 'conversation', 'brain-outreach');
    const message = requireString(flags, 'message', 'brain-outreach');
    const res = await api.postReply(auth.accessToken, agentId, connId, message);
    ok({ status: 'sent', conversation: connId, ...res, note: 'Owner-triggered opener sent. It is now a normal conversation; the slice will surface their reply.' });
}
// Phase 8 — interrupt: the owner said "stop talking to Y". Pause the connection
// so the slice skips it (resume later with `resume-connection`).
async function cmdBrainInterrupt(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const connId = requireString(flags, 'conversation', 'brain-interrupt');
    await api.actOnConnection(auth.accessToken, agentId, connId, 'pause');
    ok({ status: 'paused', conversation: connId, tell_owner: "Paused — I'll leave that conversation alone until you say otherwise (resume-connection to undo)." });
}
// One-shot TICK bundler — the entry point a scheduled run calls ONCE. Does the
// whole mechanical half of a tick in a single command (heartbeat → lease check →
// slice → pull the unread owner thread + each due conversation's recent
// messages) so the scheduled agent just reads this, DECIDES, and acts. The LLM
// reasoning (answer/clarify, RESPOND/ESCALATE, compose) stays the caller's job —
// see references/brain.md.
async function cmdBrainTick(flags) {
    const { auth, agentId } = await requireBoundAgent();
    const budget = Math.max(1, Number(optionalString(flags, 'budget') ?? '1') || 1);
    const t = auth.accessToken;
    const hb = await api.brainHeartbeat(t, agentId, brainInstanceId());
    if (!hb.lease_ok) {
        ok({ status: 'skip', reason: 'lease_held_by_other_runtime', driving: hb.driving,
            next_step: 'Another runtime is driving this agent — do NOTHING this tick.' });
        return;
    }
    const slice = await api.brainSlice(t, agentId, budget);
    let ownerMessages = [];
    if (slice.owner_channel.has_unread) {
        const oc = await api.brainOwnerChannelRead(t, agentId, 0);
        ownerMessages = oc.messages.slice(-12); // recent tail is enough to act in context
    }
    // The slice already embeds each conversation's recent messages (direction tagged
    // per side: owner vs connector), so no extra read is needed — and connector-side
    // conversations (where we reached out) are included too.
    const conversations = slice.conversations;
    ok({
        status: 'ok',
        driving: hb.driving,
        lease_ok: true,
        budget,
        owner_channel: { has_unread: slice.owner_channel.has_unread, messages: ownerMessages },
        conversations,
        next_step: 'Act per references/brain.md: (1) if owner_channel.has_unread, handle the OWNER first — answer/clarify via `owner-channel --message`, apply any command, and `brain-resolve` any approved escalation; (2) then for EACH conversation decide RESPOND (`send`) or ESCALATE (`brain-escalate`), one message each. If owner_channel has no unread and conversations is empty, the tick is done — nothing to do.',
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
    // Resolve (and PIN) this run's per-agent folder before any state I/O. login &
    // connect CREATE a local .siobac.json in the working dir when none exists, so
    // each platform agent self-binds its own isolated folder; every other command
    // just reads the existing binding (env var > local file > shared default).
    // Pinning means a binding created here is honored for the rest of the run.
    await ensureAgentBinding(subcommand === 'login' || subcommand === 'connect');
    // One-time carry-over of a pre-rename login (~/.ovoclaw → ~/.siobac).
    await migrateLegacyState();
    switch (subcommand) {
        case 'doctor': return cmdDoctor();
        case 'guide': return cmdGuide(flags);
        case 'login': return cmdLogin(flags);
        case 'logout': return cmdLogout();
        case 'share-self': return cmdShareSelf(flags);
        case 'list-shares': return cmdListShares();
        case 'revoke-share': return cmdRevokeShare();
        case 'set-approval': return cmdSetApproval(flags);
        case 'regenerate-share': return cmdRegenerateShare(flags);
        case 'list-connections': return cmdListConnections(flags);
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
        case 'auto-converse': return cmdAutoConverse(flags);
        case 'auto-start': return cmdAutoStart(flags);
        case 'auto-approve': return cmdAutoApprove(flags);
        case 'auto-resume': return cmdAutoResume(flags);
        case 'auto-stop': return cmdAutoStop(flags);
        case 'auto-status': return cmdAutoStatus(flags);
        case 'get-profile': return cmdGetProfile(flags);
        case 'set-profile': return cmdSetProfile(flags);
        case 'get-directive': return cmdGetDirective(flags);
        case 'set-directive': return cmdSetDirective(flags);
        // Agent Brain (platform-scheduled autonomous loop)
        case 'brain-heartbeat': return cmdBrainHeartbeat(flags);
        case 'brain-handback': return cmdBrainHandback(flags);
        case 'brain-slice': return cmdBrainSlice(flags);
        case 'owner-channel': return cmdOwnerChannel(flags);
        case 'brain-escalate': return cmdBrainEscalate(flags);
        case 'brain-pending': return cmdBrainPending(flags);
        case 'brain-resolve': return cmdBrainResolve(flags);
        case 'brain-reply': return cmdBrainReply(flags);
        case 'brain-outreach': return cmdBrainOutreach(flags);
        case 'brain-interrupt': return cmdBrainInterrupt(flags);
        case 'brain-tick': return cmdBrainTick(flags);
        default:
            throw new CliError(`Unknown subcommand: ${subcommand}. Run with --help to see available commands.`);
    }
}
// Reference unused imports so strict TS doesn't complain about prepared
// surfaces that the stubs don't actively touch yet.
void fsConstants;
main().catch(fail);
