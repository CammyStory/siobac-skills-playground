#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { parseArgs, requireString, optionalString, optionalNonNegInt, CliError, } from './argparse.js';
import * as api from './api.js';
import { authFilePath, ensureAgentBinding, loadAuth, saveAuth, clearAuth, loadBoundAgent, saveBoundAgent, markNameConfirmed, savePendingLogin, loadPendingLogin, clearPendingLogin, saveSession, getSession, listSessions, deleteSession, updateSession, newSessionHandle, migrateLegacyState, } from './state.js';
import { parseInvite } from './invite.js';
import { cmdDoctor, cmdVerify, cmdSetup } from './diagnostics.js';
import { cmdGuide, cmdHelp } from './guide.js';
import { cmdGoOnline, cmdBrainHandback, cmdBrainStatus, cmdOwnerChannel, cmdBrainPending, cmdBrainResolve, cmdBrainOutreach, cmdBrainInterrupt, } from './brain.js';
import { ok, fail, requireAuth, requireBoundAgent, isConfirmed, needsConfirmation, shareUrlFor, qrUrlFor, qrMarkdownFor, verifyShareResolves, } from './runtime.js';
// ── Real commands ────────────────────────────────────────────────────
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
    // An already-DESIGNED (non-new) agent has a confirmed name — record that locally so a
    // fresh state dir on another machine doesn't re-prompt the name step for it.
    if (prof && !prof.is_new)
        await markNameConfirmed(agentName);
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
        auto_go_online: true,
        next_step: prof
            ? (prof.is_new
                ? 'This agent is NEW — not shared, and not designed yet, so NO ONE can reach it and there is nothing live to relay. Do NOT tell the owner they are "online". Lead with DESIGN, in THREE ordered steps (scripts → Step 1), adapting every example to the owner (never save a sample verbatim): (1) NAME — confirm or change the auto-assigned name via `set-profile --name "…"`; (2) PUBLIC profile — `set-profile --description "…"`; (3) PRIVATE directive (how it acts on their behalf) — `set-directive --content "…"`. THEN `share-self` for the QR/link. Only once SHARED does the server answer friends automatically and ESCALATE anything that commits the owner (meeting/money/scheduling/sensitive/off-directive/impersonation) — nothing to arm, it is server-driven (references/brain.md); after sharing, `pause` halts auto-replies and `go-online` resumes.'
                : 'This agent is already designed and online by default — the SERVER answers friends automatically and ESCALATES anything that commits the owner (meeting/money/scheduling/sensitive/off-directive/impersonation) for approval. Nothing to arm — server-driven (references/brain.md). Relay the hub showing the current `profile`/`directive`; the owner can update them (`set-profile`/`set-directive`), `share-self`, `pause` (manual), or `go-online` (resume). Escalations surface in the inbox (`owner-channel` / `brain-pending`) to approve or decline.')
            : 'Logged in. Relay the hub; if this is a new agent, lead with design (name → profile → directive) before sharing.',
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
async function cmdShareSelf(flags) {
    optionalString(flags, 'description'); // accepted for forward-compat; not used by the invite endpoint
    // Approval policy. `explicit` is the owner's EXPLICIT choice (undefined if no
    // flag passed). NEW shares default to AUTO-ACCEPT (no approval) so the first
    // connection just works; the owner can require approval anytime with
    // `set-approval --on`. An existing invite's setting is never changed here
    // unless the owner explicitly chose one.
    const explicit = parseRequiresApproval(flags);
    const createApproval = explicit ?? false; // default: auto-accept
    const { auth, agentId } = await requireBoundAgent();
    // ONBOARDING GATE (design-before-share): don't let an UNDESIGNED agent go live
    // silently — a friend would otherwise reach an agent that doesn't know who it is.
    // Detect a missing public profile and/or private rules and surface it for the owner.
    const design = await api.getAgentProfile(auth.accessToken, agentId).catch(() => null);
    const needsProfile = design ? !design.profile_complete : false;
    const needsRules = design ? !design.directive_set : false;
    const undesigned = needsProfile || needsRules;
    const missing = [needsProfile ? 'a profile' : '', needsRules ? 'rules for how it acts' : ''].filter(Boolean).join(' and ');
    // CONSENT GATE — publishing the agent is outward-facing; confirm before it fires.
    if (!isConfirmed(flags)) {
        const policy = createApproval === false
            ? 'AUTO-ACCEPT — anyone with the link connects without your review (default; turn on with `set-approval --on`)'
            : 'approval required — you approve each new connection';
        needsConfirmation('share-self', { will: 'Publish this agent and produce a shareable QR/link anyone you give it to can use to reach you.', approval_policy: policy,
            design_warning: undesigned ? `Not designed yet — missing ${missing}. Friends would reach an agent that doesn't know who it is. Recommend designing first (set-profile / set-directive).` : undefined }, undesigned
            ? `Before I share you — you haven't set ${missing} yet, so friends would reach an agent that doesn't know who you are. Set ${needsProfile && needsRules ? 'those' : 'that'} up first, or share anyway?`
            : `I'll publish you on Siobac and make a QR/link people can use to reach you (${createApproval === false ? 'auto-accepting new connections — you can switch to approval-required anytime with set-approval --on' : 'with your approval for each new connection'}). Want me to go ahead?`, undesigned
            ? 'Design first: help the owner set the profile (set-profile --description "…") and rules (set-directive --content "…"). Only share anyway on a clear owner yes: share-self --confirmed'
            : 'share-self --confirmed (add --requires-approval if you want to approve each connection instead)');
    }
    let invite = await api.createShare(auth.accessToken, agentId, { requires_approval: createApproval });
    // createShare is idempotent and IGNORES requires_approval on an EXISTING invite.
    // Only change an existing invite's setting when the owner EXPLICITLY chose one
    // (PATCH in place — keeps the SAME slug/QR; changing approval never rotates the link).
    if (explicit !== undefined && invite.requires_approval !== explicit) {
        invite = await api.updateShareApproval(auth.accessToken, agentId, explicit);
    }
    // VERIFY before claiming success: round-trip the new slug through the public
    // manifest so we KNOW the QR/link actually resolves to this agent before
    // handing it to the owner. A created-but-unresolvable share is exactly the
    // "looks done but isn't" failure to catch here, not after the owner shares it.
    const verified = await verifyShareResolves(invite.slug);
    const linkWorks = verified.resolves && verified.points_back;
    ok({
        status: linkWorks ? 'shared' : 'shared_unverified',
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
        // Programmatic proof the link resolves (not just that create returned 200).
        verified: { share_resolves: verified.resolves, points_back: verified.points_back, reason: verified.reason },
        note: linkWorks
            ? 'DISPLAY THE QR INLINE: render it as an image so the user sees a scannable QR, not a link — drop the ready-made `qr_markdown` straight into your reply (it is `![](qr_url)`). Also give `share_url` as a copyable link. Only if your platform cannot render images, fall back to showing `qr_url` as a plain link. (createInvite is idempotent — an already-shared agent returns its existing invite.) The link was VERIFIED to resolve to this agent.'
            : `CAUTION: the share was created but did NOT verify — the link did not resolve back to this agent (${verified.reason ?? 'unknown'}). Do NOT tell the owner it is ready. Re-run \`share-self\`, check connectivity with \`doctor\`, or run \`verify\` for detail before handing out the QR.`,
        next_step: linkWorks
            ? 'If you have not already, help the owner DESIGN their agent so others understand who they are, in order: (1) confirm the NAME (`set-profile --name "…"`); (2) PUBLIC profile (`set-profile --description "…"`); (3) PRIVATE directive (`set-directive --content "…"` — the rules/purpose for how you reply on their behalf). Then, when a friend connects, use `recall` before replying and `remember` after (see Step 6 in references/guide.md, or run `guide --step serve_incoming`).'
            : 'Share verification FAILED — resolve that first. Run `verify` for the full check, or `doctor` for connectivity, then `share-self` again. Do not surface the QR as working until `verified.share_resolves` and `verified.points_back` are both true.',
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
        next_step: withQr.length === 0
            ? 'No active shares. Tell the owner (in their language) they are not shared yet; run `share-self` to publish a QR/link.'
            : "To show a share to the owner, render its `qr_markdown` inline as an IMAGE (it is `![](qr_url)`) so they see a scannable QR, plus `share_url` as a copyable link — never just the raw URL. To change who-can-connect use `set-approval` (same link); to replace it use `regenerate-share`.",
    });
}
async function cmdRevokeShare(flags) {
    // CONSENT GATE — revoking kills the link/QR the owner already handed out; confirm.
    if (!isConfirmed(flags)) {
        needsConfirmation('revoke-share', { will: 'Revoke this agent\'s share. The current link/QR stops working for anyone who has it. People ALREADY connected stay connected. To be reachable again you\'d run `share-self` for a NEW link.' }, 'Revoke your share link so the current QR/link stops working? (people already connected stay connected)', 'revoke-share --confirmed');
    }
    const { auth, agentId } = await requireBoundAgent();
    const result = await api.revokeShare(auth.accessToken, agentId);
    ok({
        status: 'revoked', agent_id: agentId, ...result,
        next_step: 'Share revoked — tell the owner (in their language) their old link/QR no longer works; people already connected are unaffected. To become reachable again, run `share-self` for a fresh link.',
    });
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
        next_step: invite.requires_approval
            ? "Tell the owner (in their language) that NEW connection requests now need their OK before anyone can talk to the agent — they'll appear via `requests` / `check`. Their existing share link/QR is UNCHANGED; don't re-share or regenerate it."
            : "Tell the owner (in their language) that new connections now AUTO-ACCEPT (no approval needed). Their existing share link/QR is UNCHANGED; don't re-share or regenerate it.",
    });
}
async function cmdRegenerateShare(flags) {
    // CONSENT GATE — regenerating rotates the slug and REVOKES every old link/QR.
    if (!isConfirmed(flags)) {
        needsConfirmation('regenerate-share', { will: 'Mint a NEW share link/QR and REVOKE the old one — every link/QR you already handed out STOPS working. People already connected are unaffected. (To change who-can-connect WITHOUT a new link, use `set-approval` instead.)' }, 'Replace your share link with a new one? Every old QR/link will stop working (existing connections stay).', 'regenerate-share --confirmed');
    }
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
        next_step: conns.length === 0
            ? 'No connections yet. Tell the owner (in their language) nobody has connected on this list.'
            : "These are the people connected to the owner's agent. Summarize for the owner BY NAME in their language (never raw ids). To read or reply to one, use its `id` as the conversation handle: `read --conversation <id>` / `send --conversation <id> --message \"<text>\"`. Manage with `pause-connection` / `resume-connection` / `disconnect`.",
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
        // VERIFY the approval actually took: re-read the connection and assert it is
        // now `active`, rather than trust the accept call's return. Best-effort — a
        // transient list failure shouldn't undo a real approval, just leave it
        // unverified so the agent re-checks instead of over-claiming.
        let active = null;
        try {
            const conns = await api.listConnections(auth.accessToken, agentId);
            const c = conns.find((x) => x.id === connectionId);
            active = c ? c.status === 'active' : null;
        }
        catch { /* leave active=null → unverified */ }
        out.verified = { active };
        out.next_step =
            `Approved — you can talk on this conversation now. Read it with \`read --conversation ${connectionId}\` ` +
                `and reply with \`send --conversation ${connectionId} --message "…"\`. Use THIS id (the connection id) as the ` +
                `conversation handle — do NOT use the conv_… id in result.conversation_id (read/send reject it). ` +
                (active === false
                    ? 'NOTE: the connection did NOT read back as active yet — re-check with `list-connections` before telling the owner it is live. '
                    : '') +
                `When the agent is online, the SERVER handles this conversation automatically (RESPOND/ESCALATE) — just watch with \`check\`.`;
    }
    else {
        // Plain-language outcome for the owner on the other connection actions, so the
        // agent always has something to relay (never a bare status).
        const nextByAction = {
            disconnect: 'Disconnected — tell the owner (in their language) that connection is closed: that person can no longer message this agent. They would need a fresh invite/QR to reconnect.',
            'rotate-token': 'Connection key refreshed — tell the owner (in their language) it was a routine SECURITY reset, NOT a disconnect: the friend stays connected and their app re-authenticates automatically on its next message. Nothing else to do.',
            pause: 'Paused — tell the owner (in their language) that connection is on hold: incoming messages won\'t be auto-answered until they `resume-connection --connection-id <id>`.',
            resume: 'Resumed — tell the owner (in their language) that connection is active again; the server auto-answers when the agent is online.',
            reject: 'Request rejected — tell the owner (in their language) you declined it; that requester was NOT admitted and cannot message the agent.',
        };
        if (nextByAction[action])
            out.next_step = nextByAction[action];
    }
    ok(out);
}
// Best-effort: resolve a connection id to the friend's display name for a consent
// preview, so the gate can name WHO instead of a raw id. Falls back to a neutral label.
async function connectionWho(connectionId) {
    const auth = await loadAuth();
    if (!auth?.agentId)
        return 'this connection';
    const conns = await api.listConnections(auth.accessToken, auth.agentId).catch(() => []);
    const c = conns.find((x) => x.id === connectionId);
    return c?.shadow_name || 'this connection';
}
async function cmdAcceptPending(flags) {
    // CONSENT GATE — approving admits someone to talk to the agent; confirm first.
    if (!isConfirmed(flags)) {
        const requestId = requireString(flags, 'request-id', 'approve');
        // P9 — name WHO is being admitted in the preview, so the owner can decide from
        // the gate alone (don't make them run `requests` first). Best-effort lookup.
        const auth = await loadAuth();
        let requester = 'this requester';
        let intro = '';
        if (auth?.agentId) {
            const inbox = await api.fetchInbox(auth.accessToken).catch(() => null);
            const r = inbox?.pending_requests?.find((p) => (p.id ?? p.request_id) === requestId);
            if (r) {
                requester = r.from?.agent_name || requester;
                intro = r.intro_text || '';
            }
        }
        needsConfirmation('approve', { request_id: requestId, requester, intro, will: `Admit ${requester} — they can then exchange messages with your agent.` }, 'Approve this connection request so they can talk to me?', `approve --request-id ${requestId} --confirmed`);
    }
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
    // CONSENT GATE — disconnecting permanently cuts someone off; confirm first.
    if (!isConfirmed(flags)) {
        const connectionId = requireString(flags, 'connection-id', 'disconnect');
        const who = await connectionWho(connectionId);
        needsConfirmation('disconnect', { connection_id: connectionId, who, will: `Permanently disconnect ${who}. They can no longer message this agent and the conversation closes. They would need a fresh invite/QR to reconnect.` }, `Disconnect ${who}? They won't be able to message you anymore.`, `disconnect --connection-id ${connectionId} --confirmed`);
    }
    return actOnConnectionCmd(flags, 'disconnect', 'connection-id', 'disconnect', 'disconnected');
}
async function cmdRotateToken(flags) {
    // CONSENT GATE — rotating the key forces the friend's app to re-authenticate.
    // It's jargon, so the preview explains it in plain terms: a security reset, NOT a
    // disconnect (they stay connected).
    if (!isConfirmed(flags)) {
        const connectionId = requireString(flags, 'connection-id', 'rotate-token');
        const who = await connectionWho(connectionId);
        needsConfirmation('rotate-token', { connection_id: connectionId, who, will: `Refresh the security key for ${who}'s connection. They STAY connected — their app just re-authenticates automatically on its next message. A security refresh, not a disconnect.` }, `Refresh the connection key for ${who}? (a security reset — they stay connected)`, `rotate-token --connection-id ${connectionId} --confirmed`);
    }
    return actOnConnectionCmd(flags, 'rotate-token', 'connection-id', 'rotate-token', 'token_rotated');
}
// ── Directive + per-friend memory (docs/profile-memory-design.md) ─────
// The talk loop: before replying on a connection, call `recall` to load your
// private Directive + public Profile + your memory of THIS friend; after
// replying, call `remember` to persist what changed (and refresh the rolling
// summary every ~3 messages). Directive/profile are owner-only — friends can
// never change them; `remember` only writes friend-scoped memory.
async function cmdRecall(flags) {
    const connectionId = optionalString(flags, 'conversation') ?? optionalString(flags, 'connection-id')
        ?? (() => { throw new CliError('recall needs a conversation — pass `--conversation <id>`. Get the id from `check` or `list-connections` (a connection) / `conversations` (the `conversation` value). recall loads your memory of that friend so you reply in character.'); })();
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
                mode: 'logged_out',
                directive: '',
                profile: null,
                friend_memory: [],
                note: 'Not logged in — no agent directive/profile to load. Log in (`login`) to reply as your agent; Siobac connections are login-only.',
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
        // never say; 'friend_shared' = ok to reference WITH this friend. Empty until
        // there's memory recorded for this friend.
        friend_memory: ctx.friend_memory,
    });
}
async function cmdRemember(flags) {
    const connectionId = optionalString(flags, 'conversation') ?? optionalString(flags, 'connection-id')
        ?? (() => { throw new CliError('remember needs a conversation — pass `--conversation <id>` (from `check` / `list-connections` / `conversations`), plus what to save (`--summary "<text>"` and/or `--deltas <json>`). It records what you learned about that friend for next time.'); })();
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
        next_step: 'Private directive saved — tell the owner (in their language) their rules are saved. Design order is NAME → profile → rules → share: if the name isn\'t confirmed yet, do `set-profile --name "…"`; if the PUBLIC profile description is empty, set it with `set-profile --description "…"`. When all reflect the owner, run `share-self`.',
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
        next_step: p.is_new
            ? "This agent is NEW. Tell the owner (in their language) it's online by default once shared, then DESIGN it in THREE steps (scripts → Step 1): (1) NAME — confirm or change the auto-name via `set-profile --name \"…\"`; (2) public profile `set-profile --description \"…\"`; (3) private directive `set-directive --content \"…\"`. If you show an example, ADAPT it to the owner — never save the sample as-is. Then `share-self` for the QR/link."
            : "Show the owner (in their language) their current NAME + profile + directive and ask if they want to change any (`set-profile --name` / `set-profile --description` / `set-directive`) — never overwrite silently. The server already auto-replies in character from these; they can `share-self`, `pause`, or `go-online`.",
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
    // Setting the NAME confirms it — record that locally so the setup checklist's name
    // step reads as done (the server has no name-confirmed flag for a new auto-named agent),
    // and refresh the remembered display name so re-login doesn't pre-select a stale one.
    if (name !== undefined)
        await markNameConfirmed(name);
    ok({
        status: 'profile_updated',
        agent_id: agentId,
        updated: { description: description !== undefined, name: name !== undefined },
        // Design order is NAME → PUBLIC profile → PRIVATE directive → share. Point at the
        // next unfinished step so set-profile keeps the same flow as login/setup/guide.
        next_step: (name !== undefined && description === undefined)
            ? 'Name confirmed — tell the owner (in their language) their agent\'s name is set. Next, the PUBLIC profile: `set-profile --description "…"` (who they are / what they discuss). Then the PRIVATE directive `set-directive --content "…"`, and finally `share-self`.'
            : 'Public profile updated — tell the owner (in their language) their profile is saved. Design order is NAME → profile → rules → share: if the name isn\'t confirmed yet, do `set-profile --name "…"`; if the private DIRECTIVE isn\'t set, do `set-directive --content "…"`. Once all reflect the owner, run `share-self`.',
    });
}
// ── Reach out + unified conversations (merged from ovoclaw-connect) ──────
// One agent is symmetric: it can be reached (passive) AND reach out (active).
// A conversation handle disambiguates the transport: `s_…` = one I started
// (connection bearer); anything else = a connection id I own (login token).
function isActiveHandle(h) { return /^s_[0-9a-f]{16}$/.test(h); }
// Active-handle connection tokens (`xext_…`) rotate on a short server TTL (~1h);
// the connection/conversation itself is PERMANENT. On a 401 `session_expired` we
// silently re-mint the token with the saved `client_secret` (the documented
// Step-4 refresh — same shadow user, same conversation, no owner approval) and
// retry the op ONCE, so the agent never sees an "expiry". The refreshed token is
// persisted AND written back onto the in-memory `sess` so a caller looping over
// the session (e.g. paged `read`) picks it up on the next iteration. Only if the
// reauth itself can't mint a fresh token (secret revoked, connection gone) does
// the ORIGINAL 401 surface — its message already guides re-connect / re-login.
async function withSessionReauth(sess, op) {
    try {
        return await op(sess.token);
    }
    catch (e) {
        if (e?.code !== 'session_expired')
            throw e;
        const re = await api.connectToInvite(sess.host, sess.slug, {
            // The reauth path keys on (client_user_id, client_secret) and ignores the
            // introduction — but the connect endpoint still requires it (min length 1),
            // so send a short placeholder rather than an empty string.
            introduction: '(token refresh)',
            client_user_id: sess.clientUserId,
            client_secret: sess.clientSecret,
        });
        if (re.status !== 'reauthorized' || !re.token)
            throw e;
        sess.token = re.token;
        if (re.token_expires_at)
            sess.tokenExpiresAt = re.token_expires_at;
        await updateSession(sess.handle, {
            token: re.token,
            tokenExpiresAt: re.token_expires_at ?? sess.tokenExpiresAt,
            conversationId: re.conversation_id ?? sess.conversationId,
        });
        return await op(re.token);
    }
}
async function persistSession(res, slug, host) {
    if (!res.token || !res.token_expires_at || !res.your_user_id || !res.client_secret) {
        throw new CliError(`connect succeeded but the response is missing token fields (status ${res.status}).`);
    }
    // Stable conversation identity: if the server handed back a conversation we
    // already have locally (the SAME registered friendship — reconnect, re-login,
    // or a token re-mint all return the same conversation_id), REUSE that handle
    // instead of minting a new one. This keeps "same agent → same conversation"
    // and preserves lastSeq so history isn't re-read as new. Secondary fallback:
    // an existing session on the same invite slug.
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
// A fetch against the INVITE's own host (connect / inspect-invite). If the host
// itself doesn't answer, that's a bad/incomplete LINK, not a Siobac outage — remap
// network_error so the owner gets "check the link", not "run doctor" (which probes a
// different, healthy server). Established-session fetches (send/poll) keep network_error.
async function inviteHostCall(fn) {
    try {
        return await fn();
    }
    catch (e) {
        if (e.code === 'network_error') {
            throw api.makeApiError('invite_unreachable', `invite_unreachable: ${e.message}`);
        }
        throw e;
    }
}
async function cmdInspectInvite(flags) {
    const invite = requireString(flags, 'invite', 'inspect-invite');
    const { slug, host } = parseInvite(invite);
    const m = await inviteHostCall(() => api.getManifest(host, slug));
    const auth = await loadAuth();
    ok({
        status: 'ok', host, slug, agent: m.agent,
        requires_approval: m.requires_approval ?? false,
        your_login_state: auth?.agentId ? 'logged_in' : 'logged_out',
    });
}
async function cmdConnect(flags) {
    const invite = requireString(flags, 'invite', 'connect');
    // --intro is OPTIONAL. The owner just pastes a link/QR; the share page never tells
    // them to write an intro, so requiring one dead-ended first contact. Default to a
    // neutral opener (the agent can still pass --intro to personalize). The peer's brain
    // answers this first line, so a plain greeting works fine.
    const introduction = optionalString(flags, 'intro') ?? "Hi! I'd like to connect.";
    const { slug, host } = parseInvite(invite);
    const auth = await loadAuth();
    const loggedIn = !!(auth && auth.agentId);
    // LOGIN-ONLY: every Siobac connection is a registered, account-anchored
    // friendship — both sides log in and connect as themselves. There is no guest
    // mode. If the owner isn't logged in, they must log in (or sign up) first.
    if (!loggedIn) {
        ok({
            status: 'login_required',
            message: 'You must log in to connect — Siobac connections are between two logged-in agents (no guest mode). `login` opens a page where the owner signs IN, or creates a NEW account (and an agent) on the spot; then run `connect` again.',
            next_step: "Tell the owner (in their language) that reaching out needs a quick Siobac login first (no account yet is fine — they can sign up on the same page). Then run `login` (two-step: `login`, then `login --finish` after the owner approves on the page) and re-run this `connect`.",
        });
    }
    const res = await inviteHostCall(() => api.connectToInvite(host, slug, {
        your_agent_name: optionalString(flags, 'agent-name'),
        your_owner_name: optionalString(flags, 'owner-name'),
        introduction,
        purpose_hint: optionalString(flags, 'purpose'),
    }, auth.accessToken));
    if (res.status === 'active' || res.status === 'reauthorized' || res.status === 'already_connected') {
        // Surface the friend's NAME so the owner can be told WHO they connected to. The
        // connect response sometimes omits peer_name; the public manifest always has it.
        if (!res.peer_name) {
            const m = await api.getManifest(host, slug).catch(() => null);
            if (m?.agent?.name)
                res.peer_name = m.agent.name;
        }
        const handle = await persistSession(res, slug, host);
        ok({
            status: res.status, conversation: handle, peer_name: res.peer_name ?? null, mode: 'registered', token_expires_at: res.token_expires_at,
            next_step: `Connected${res.peer_name ? ` to ${res.peer_name}` : ''}. FIRST check whether this is an existing friendship: \`read --conversation ${handle}\` — if there are prior messages, summarize where things stand for the owner and respond IN CONTEXT (do NOT offer to "break the ice"); if it's brand-new, offer to introduce them. Tell the owner in their language; never show the \`conversation\` handle. If the owner has a GOAL, treat it as the conversation's PURPOSE — confirm it, re-run \`connect\` with \`--purpose "<the goal>"\`, and let the agents auto-converse toward it (the server pursues it and escalates what needs the owner); don't just translate one message. To send a specific line: \`send --conversation ${handle} --message "<text>"\`.`,
        });
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
    const loggedIn = !!(auth && auth.agentId);
    ok({
        status: 'ok', logged_in: loggedIn, count: conversations.length, conversations,
        next_step: loggedIn
            ? "These are the owner's conversations: `direction: inbound` = someone connected to them, `outbound` = they reached out. Summarize for the owner BY PEER NAME in their language (never show the `conversation` handle). To see messages in one, `read --conversation <its conversation value>`; to reply, `send --conversation <that> --message \"<text>\"`."
            // LOGGED OUT: only local OUTBOUND sessions are listed; inbound is hidden. Don't imply this is the full picture.
            : "NOT LOGGED IN — this lists only the owner's OUTBOUND conversations; their INBOUND ones are hidden until they log in. Tell the owner (in their language) you need a quick login to see who's connected to them, then run `login` → `login --finish`. Summarize any `outbound` entries meanwhile.",
    });
}
async function cmdRead(flags) {
    const handle = requireString(flags, 'conversation', 'read');
    if (isActiveHandle(handle)) {
        const sess = await getSession(handle);
        if (!sess)
            throw new CliError(`Unknown conversation "${handle}". Run \`conversations\` to list, or \`connect\` first.`);
        const sinceFlag = optionalNonNegInt(flags, 'since');
        if (sinceFlag !== undefined) {
            // Explicit forward page from <since> (the server's /poll returns one capped
            // window of messages with seq > since, oldest-first).
            const res = await withSessionReauth(sess, (tok) => api.pollConnectionReplies(sess.host, tok, sinceFlag, 0, /* full */ true));
            const earliest = res.messages[0]?.seq;
            ok({
                status: 'ok', conversation: handle, direction: 'outbound', peer: sess.peerAgentName ?? null,
                messages: res.messages, last_seq: res.last_seq, has_more_before: typeof earliest === 'number' && earliest > 1,
                next_step: 'Forward page from `--since` (both directions; `outbound` = the owner\'s own). Summarize anything new for the owner in their language — never echo raw messages or the handle. Page again with the returned `last_seq`. To reply, `send --conversation ' + handle + ' --message "<text>"`.',
            });
        }
        // Default: the server caps each /poll window and reports `last_seq` as the
        // window's max (NOT the conversation's), so a single poll from 0 returns the
        // OLDEST window. Page forward to the end, then show the most RECENT window so
        // `read` shows recent messages on a long conversation.
        const bySeq = new Map();
        let cursor = 0;
        for (let guard = 0; guard < 20; guard++) {
            const r = await withSessionReauth(sess, (tok) => api.pollConnectionReplies(sess.host, tok, cursor, 0, true));
            if (!r.messages.length)
                break;
            for (const m of r.messages)
                bySeq.set(m.seq, m);
            if (r.last_seq <= cursor)
                break;
            cursor = r.last_seq;
        }
        const all = [...bySeq.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        const recent = all.slice(-50);
        const earliest = recent[0]?.seq;
        ok({
            status: 'ok', conversation: handle, direction: 'outbound', peer: sess.peerAgentName ?? null,
            messages: recent, last_seq: all.length ? all[all.length - 1].seq : 0,
            has_more_before: typeof earliest === 'number' && earliest > 1,
            next_step: 'Most recent window (both directions; `outbound` = the owner\'s own). Summarize for the owner in their language — never echo raw messages or the handle. If `has_more_before`, older messages exist (page with `--since <seq>`). To reply, `send --conversation ' + handle + ' --message "<text>"` (the server usually auto-replies when online, so only send if the owner wants to).',
        });
    }
    const { auth, agentId } = await requireBoundAgent();
    const since = optionalNonNegInt(flags, 'since');
    const hist = await api.readConversation(auth.accessToken, agentId, handle, { since });
    ok({
        status: 'ok', conversation: handle, direction: 'inbound', conversation_id: hist.conversation_id, message_count: hist.messages.length, last_seq: hist.last_seq, has_more: hist.has_more, messages: hist.messages,
        next_step: 'Messages in this inbound conversation. Summarize for the owner in their language — never echo raw messages or ids. The server usually auto-replies when online; only `send --conversation ' + handle + ' --message "<text>"` if the owner wants to reply manually (it confirms first).',
    });
}
async function cmdSend(flags) {
    const handle = requireString(flags, 'conversation', 'send');
    const message = requireString(flags, 'message', 'send');
    // CONSENT GATE — a message goes out under the owner's identity; confirm the
    // exact text first. (The server's own autonomous replies don't pass through
    // here — this gate is for the manual/owner-driven send path.)
    if (!isConfirmed(flags)) {
        needsConfirmation('send', { conversation: handle, message }, `Send this to ${handle}: "${message}" — okay, or want to change it?`, `send --conversation ${handle} --message "<the confirmed text>" --confirmed`);
    }
    if (isActiveHandle(handle)) {
        const sess = await getSession(handle);
        if (!sess)
            throw new CliError(`Unknown conversation "${handle}". Run \`conversations\` to list, or \`connect\` first.`);
        const res = await withSessionReauth(sess, (tok) => api.sendToConnection(sess.host, tok, message));
        // Server backstop: even on a direct/outbound send, the server HOLDS anything that looks
        // like it would share private info and escalates it — surface that (NOT as a failure).
        if (res.held || res.status === 'held') {
            const kind = res.kind;
            ok({
                status: 'held_for_review', conversation: handle, direction: 'outbound', kind,
                next_step: `The server HELD this — it looked like it would share ${kind ?? 'sensitive info'} — and escalated it to the owner; it was NOT sent. Tell the owner (in their language) you held it because it looks like it shares ${kind ?? 'private info'}, and offer: send as-is / edit / skip. See it via \`brain-pending\`; if they approve, deliver with \`brain-resolve --action sent --message "<approved text>"\` (do not retry \`send\`).`,
            });
        }
        // Assert the server actually persisted it (assigned a seq + id) before
        // reporting "sent" — a 200 with no seq means it did NOT land.
        const persisted = typeof res.message?.seq === 'number' && !!res.message?.id;
        ok({
            status: persisted ? 'sent' : 'send_unconfirmed',
            conversation: handle, direction: 'outbound',
            message_id: res.message?.id, seq: res.message?.seq, reply_status: res.reply_status,
            verified: { persisted, seq: res.message?.seq ?? null },
            next_step: persisted
                ? `Delivered. Tell the owner (in their language) you'll talk with their friend's agent to move things along — it runs on its own and takes a little time, and you'll surface anything worth their attention. Offer quick options like "What's new?" / "Back home" — do NOT nag them to "check for a reply".`
                : `The send returned WITHOUT a sequence number — it may NOT have been delivered. Do NOT tell the owner it sent; re-\`read --conversation ${handle}\` to confirm before retrying.`,
        });
    }
    const { auth, agentId } = await requireBoundAgent();
    const res = await api.postReply(auth.accessToken, agentId, handle, message);
    // The server HOLDS a reply that looks like it would disclose sensitive info — it
    // escalates to the owner instead of sending. Surface that clearly (NOT as a fail).
    if (res.status === 'blocked') {
        const kind = res.kind;
        ok({
            status: 'held_for_review', conversation: handle, direction: 'inbound', kind,
            next_step: `This message looked like it would share ${kind ?? 'sensitive info'}, so the server HELD it and escalated it to the owner — it was NOT sent. Tell the owner (in their language) you held it because it looks like it shares ${kind ?? 'private info'}, and offer: send as-is / edit / skip. See it via \`brain-pending\`; if they approve, deliver with \`brain-resolve --action sent --message "<approved text>"\` (do not retry \`send\`).`,
        });
    }
    // Assert persistence: the server returns the assigned seq + message_id only
    // when the reply actually landed in the conversation.
    const persisted = typeof res.seq === 'number' && !!res.message_id;
    ok({
        status: persisted ? 'sent' : 'send_unconfirmed',
        conversation: handle, direction: 'inbound', ...res,
        verified: { persisted, seq: res.seq ?? null },
        // Manual send (owner paused/offline, or hand-writing this one). Autonomous
        // replying is the brain's job when online, not a per-send toggle.
        next_step: persisted
            ? `Sent (server confirmed seq ${res.seq}). Persist anything worth keeping with \`remember --conversation ${handle}\`. (Autonomous follow-up is the brain's job — you don't turn anything on here.)`
            : `The send did NOT come back with a sequence number — it may not have landed. Do NOT tell the owner it sent; \`read --conversation ${handle}\` to confirm, then retry if missing.`,
    });
}
async function cmdCheck(_flags) {
    const auth = await loadAuth();
    const result = { status: 'ok' };
    if (auth && auth.agentId) {
        const inbox = await api.fetchInbox(auth.accessToken);
        result.inbound = { pending_requests: inbox.pending_requests, threads: inbox.threads, unread_count: inbox.new_messages.length };
    }
    else {
        result.inbound = { note: 'not logged in — log in to see your conversations (Siobac is login-only)' };
    }
    const loggedIn = !!(auth && auth.agentId);
    result.logged_in = loggedIn;
    const outbound = [];
    for (const s of await listSessions()) {
        try {
            const res = await withSessionReauth(s, (tok) => api.pollConnectionReplies(s.host, tok, s.lastSeq, 0));
            if (res.last_seq > s.lastSeq)
                await updateSession(s.handle, { lastSeq: res.last_seq });
            if (res.messages.length)
                outbound.push({ conversation: s.handle, peer: s.peerAgentName ?? null, new_messages: res.messages, last_seq: res.last_seq });
        }
        catch { /* a dead session shouldn't sink the whole check */ }
    }
    result.outbound = outbound;
    result.next_step = loggedIn
        ? "One scan of everything needing the owner. In `inbound.threads`: `held: true` (has a `request_id`) = the server already escalated a reply for the owner's approval — surface it ONCE as \"needs your OK\" and resolve via `brain-pending`/`brain-resolve` (never also as a normal new message). `held: false` with `unread_count` > 0 = new messages the server is handling or that need a look — `read --conversation <connection_id>`. `inbound.pending_requests` = people asking to connect (approve/reject). `outbound[].new_messages` = replies on conversations the owner started. Give the owner ONE short digest in their language (by friend name, never raw ids/handles); if nothing is held/unread/pending, tell them their queue is clear."
        // LOGGED OUT: do NOT say "queue is clear" — inbound is invisible. Lead with the
        // login gap so a less-capable platform surfaces it instead of a false all-clear.
        : "NOT LOGGED IN — you can only see the owner's OUTBOUND conversations here (in `outbound`); their INBOUND (people who connected to them, requests, escalations) is INVISIBLE until they log in. Do NOT tell the owner their queue is clear. Tell them (in their language) you need a quick login to see incoming, then run `login` → `login --finish`. Still summarize anything in `outbound` if present.";
    ok(result);
}
async function cmdRequests(_flags) {
    const auth = await requireAuth();
    const inbox = await api.fetchInbox(auth.accessToken);
    ok({
        status: 'ok', count: inbox.pending_requests.length, pending_requests: inbox.pending_requests,
        next_step: inbox.pending_requests.length === 0
            ? 'No one is waiting to connect. Tell the owner (in their language) there are no pending requests.'
            : "People asking to connect to the owner's agent. Show each requester to the owner BY NAME in their language (never raw ids) and ask whether to admit them. On their decision: `approve --request-id <id>` (asks for confirmation) or `reject --request-id <id>`.",
    });
}
async function cmdListSessions() {
    const all = await listSessions();
    ok({
        status: 'ok',
        sessions: all.map((s) => ({ conversation: s.handle, peer: s.peerAgentName ?? null, slug: s.slug, host: s.host, expires_at: s.tokenExpiresAt, last_seq: s.lastSeq, created_at: s.createdAt })),
        next_step: all.length === 0
            ? 'No outbound conversations the owner started. Tell them (in their language) there are none; use `connect --invite <link>` to reach out.'
            : "Conversations the owner started (reached out). Summarize BY PEER NAME in their language (never the handle). `read --conversation <conversation>` to see one; `send` to reply. `expires_at` is just the rotating session key (auto-refreshed) — never tell the owner a conversation 'expired'.",
    });
}
async function cmdForgetSession(flags) {
    const handle = requireString(flags, 'conversation', 'forget-session');
    await deleteSession(handle);
    ok({ status: 'ok', forgot: handle });
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
        case 'verify': return cmdVerify(flags);
        case 'setup': return cmdSetup(flags);
        case 'guide': return cmdGuide(flags);
        case 'login': return cmdLogin(flags);
        case 'logout': return cmdLogout();
        case 'share-self': return cmdShareSelf(flags);
        case 'list-shares': return cmdListShares();
        case 'revoke-share': return cmdRevokeShare(flags);
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
        case 'get-profile': return cmdGetProfile(flags);
        case 'set-profile': return cmdSetProfile(flags);
        case 'get-directive': return cmdGetDirective(flags);
        case 'set-directive': return cmdSetDirective(flags);
        // Agent Brain (platform-scheduled autonomous loop)
        // Server-brain model: the SERVER auto-replies + escalates. The skill only
        // toggles autonomous mode and lets the owner handle escalations.
        case 'go-online': return cmdGoOnline(flags); // resume autonomous (after pause)
        case 'pause': return cmdBrainHandback(flags); // manual mode
        case 'brain-handback': return cmdBrainHandback(flags); // alias of pause
        case 'brain-status': return cmdBrainStatus(flags); // online vs paused
        case 'owner-channel': return cmdOwnerChannel(flags);
        case 'brain-pending': return cmdBrainPending(flags); // open escalations
        case 'brain-resolve': return cmdBrainResolve(flags); // approve/decline
        case 'brain-outreach': return cmdBrainOutreach(flags); // owner-initiated reach-out
        case 'brain-interrupt': return cmdBrainInterrupt(flags); // pause one conversation
        default:
            throw new CliError(`Unknown subcommand: ${subcommand}. Run with --help to see available commands.`);
    }
}
// Reference unused imports so strict TS doesn't complain about prepared
// surfaces that the stubs don't actively touch yet.
void fsConstants;
main().catch(fail);
