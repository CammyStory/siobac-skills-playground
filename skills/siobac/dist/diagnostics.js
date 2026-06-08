// Diagnostics & onboarding commands: doctor (local runtime), verify (live
// product state), setup (first-run checklist). Extracted from cli.ts.
import { promises as fs } from 'node:fs';
import { platform, arch } from 'node:os';
import * as api from './api.js';
import { stateDir, authFilePath, ensureAgentBinding, loadAuth, isAuthFileWriteable, listSessions, } from './state.js';
import { SKILL_NAME, SKILL_VERSION } from './version.js';
import { ok, withUpdateNotice, skillDir, updateInstruction, requireBoundAgent, shareUrlFor, verifyShareResolves } from './runtime.js';
export async function cmdDoctor() {
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
    // API base + reachability. Surface WHICH environment resolved — prod is the
    // default; dev/custom is an explicit opt-in worth flagging so it's never a
    // silent surprise (e.g. an install accidentally left pointed at the dev tunnel).
    const apiBase = api.getApiBase();
    const apiEnv = api.getApiEnv();
    const envNote = apiEnv === 'dev' ? 'using the DEV tunnel (SIOBAC_ENV=dev) — NOT production'
        : apiEnv === 'custom' ? 'using a custom base from SIOBAC_API_BASE/OVOCLAW_API_BASE'
            : undefined;
    try {
        const u = new URL(apiBase);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            checks.api_base = { ok: false, value: { base: apiBase, env: apiEnv }, reason: `must be http or https; got ${u.protocol}` };
        }
        else {
            checks.api_base = { ok: true, value: { base: apiBase, env: apiEnv }, warning: envNote, note: envNote };
        }
    }
    catch {
        checks.api_base = { ok: false, value: { base: apiBase, env: apiEnv }, reason: 'invalid URL' };
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
export async function cmdVerify(_flags) {
    const checks = {};
    // 1. A login bound to an agent exists locally (else nothing else can pass).
    const auth0 = await loadAuth();
    if (!auth0 || !auth0.agentId) {
        checks.login = { ok: false, asserted: 'a login bound to an agent exists', reason: 'not_authenticated — run `login` first' };
        const f0 = { ok: false, skill: { name: SKILL_NAME, version: SKILL_VERSION }, checks, summary: 'Not logged in — run `login`, then `verify` again.' };
        process.stderr.write(JSON.stringify(withUpdateNotice(f0), null, 2) + '\n');
        process.exit(1);
    }
    checks.login = { ok: true, asserted: 'a login bound to an agent exists', value: { agent_id: auth0.agentId } };
    // 2. The server actually ACCEPTS the token and resolves this agent.
    let agentId = auth0.agentId;
    let profile = null;
    try {
        const { auth, agentId: aid } = await requireBoundAgent(); // refreshes if near expiry
        agentId = aid;
        profile = await api.getAgentProfile(auth.accessToken, aid);
        checks.token_accepted = { ok: true, asserted: 'the server accepts the token and resolves this agent', value: { agent_id: aid, name: profile.name } };
    }
    catch (e) {
        checks.token_accepted = { ok: false, asserted: 'the server accepts the token and resolves this agent', reason: e.code ?? e.message };
    }
    // 3. The agent is presentable — public profile + private directive set. Not
    //    fatal, but sharing a blank agent is a real footgun, so warn.
    if (profile) {
        const ready = profile.profile_complete && profile.directive_set;
        checks.profile_ready = {
            ok: true,
            asserted: 'public profile + private directive are set, so the agent represents the owner',
            value: { profile_complete: profile.profile_complete, directive_set: profile.directive_set, is_new: profile.is_new },
            warning: ready ? undefined : 'this agent is missing its profile and/or directive — set them before sharing so friends meet a real persona, not a blank one',
        };
    }
    else {
        checks.profile_ready = { ok: true, skipped: true, asserted: 'public profile + private directive are set', reason: 'skipped — token not accepted' };
    }
    // 4. THE key product assertion: the share link the owner hands out actually
    //    resolves to THIS agent (round-trip the public manifest a friend hits).
    const authNow = await loadAuth();
    if (authNow) {
        try {
            const shares = await api.listShares(authNow.accessToken);
            const mine = shares.find((s) => s.agent_id === agentId);
            if (!mine) {
                checks.share_resolves = { ok: true, skipped: true, asserted: 'the share link resolves to this agent', reason: 'not shared yet — run `share-self` when ready (nothing to verify)' };
            }
            else {
                const v = await verifyShareResolves(mine.invite.slug, mine.agent_name);
                const works = v.resolves && v.points_back;
                checks.share_resolves = {
                    ok: works,
                    asserted: 'the share link/QR resolves to THIS agent (what a friend scans)',
                    value: { slug: mine.invite.slug, share_url: shareUrlFor(mine.invite.slug), resolves: v.resolves, points_back: v.points_back },
                    reason: works ? undefined : (v.reason ?? 'the share did not resolve to this agent'),
                };
            }
        }
        catch (e) {
            checks.share_resolves = { ok: false, asserted: 'the share link resolves to this agent', reason: e.code ?? e.message };
        }
    }
    // 5. Presence reachable (online vs paused). Informational — never fatal.
    if (authNow) {
        try {
            const p = await api.brainPresence(authNow.accessToken, agentId);
            checks.presence = { ok: true, asserted: 'the server reports this agent autonomous-reply mode', value: { mode: p.mode, online: p.online } };
        }
        catch (e) {
            checks.presence = { ok: true, asserted: 'the server reports this agent autonomous-reply mode', warning: `could not read presence: ${e.code ?? e.message}` };
        }
    }
    // 6. Outbound conversation tokens still work (each is a separate per-connection
    //    bearer that can expire/revoke). Warn on any dead one; not fatal overall.
    const sessions = await listSessions();
    if (sessions.length) {
        const dead = [];
        for (const s of sessions) {
            try {
                await api.pollConnectionReplies(s.host, s.token, s.lastSeq, 0);
            }
            catch {
                dead.push(s.handle);
            }
        }
        checks.outbound_sessions = {
            ok: true,
            asserted: 'each outbound conversation token still works',
            value: { total: sessions.length, working: sessions.length - dead.length, dead },
            warning: dead.length ? `${dead.length} outbound conversation(s) no longer reachable (expired/revoked token): ${dead.join(', ')} — \`forget-session\` or reconnect` : undefined,
        };
    }
    const allOk = Object.values(checks).every((c) => c.ok);
    const warnings = Object.entries(checks).filter(([, c]) => c.warning).map(([k, c]) => `${k}: ${c.warning}`);
    const report = {
        ok: allOk,
        skill: { name: SKILL_NAME, version: SKILL_VERSION },
        checks,
        summary: allOk
            ? (warnings.length ? `All critical checks passed; ${warnings.length} warning(s) to mention to the owner.` : 'All checks passed — the agent is set up and reachable.')
            : 'One or more critical checks FAILED — fix these before relying on the agent (see each check\'s reason).',
        warnings: warnings.length ? warnings : undefined,
        tell_owner: allOk
            ? 'I checked your Siobac setup end-to-end — login, profile, and your share link are all working.'
            : "I ran a health check and something isn't working yet — let me fix it before we rely on it.",
    };
    if (allOk)
        ok(report);
    process.stderr.write(JSON.stringify(withUpdateNotice(report), null, 2) + '\n');
    process.exit(1);
}
// ── Setup — the first-run onboarding state machine ───────────────────────
// One explicit entry point for "where am I in setup, what's next" — instead of
// the agent inferring readiness from scattered login/share output. Returns an
// ordered checklist (login → profile → directive → share) with each step's done
// state and the single next command. The agent gathers the missing content from
// the owner (e.g. via AskUserQuestion) and runs that command. Read-only.
export async function cmdSetup(_flags) {
    const auth = await loadAuth();
    if (!auth || !auth.agentId) {
        ok({
            status: 'setup_incomplete',
            logged_in: false,
            complete: false,
            steps: [
                { step: 'login', done: false, label: 'Log in (bind this skill to your Siobac agent)', command: 'login' },
                { step: 'profile', done: false, label: 'Public profile (what others see)', command: 'set-profile --description "…"' },
                { step: 'directive', done: false, label: 'Private directive (how you act on their behalf)', command: 'set-directive --content "…"' },
                { step: 'share', done: false, label: 'Share (become reachable via QR/link)', command: 'share-self --confirmed' },
            ],
            next_action: 'login',
            next_step: 'Start with `login` (two-step: `login`, then `login --finish` after the owner approves). Then profile + directive, then `share-self`.',
            tell_owner: "Let's get you set up on Siobac — it starts with a quick login. Want to begin?",
        });
        return;
    }
    // Refresh the session like every other command — don't read state with the raw
    // stored access token, which may be expired-but-refreshable (that produced a
    // false `setup_unknown` even though the login was fine).
    let agentId = auth.agentId;
    let token = auth.accessToken;
    try {
        const bound = await requireBoundAgent();
        agentId = bound.agentId;
        token = bound.auth.accessToken;
    }
    catch (e) {
        ok({
            status: 'setup_unknown', logged_in: true, agent_id: agentId,
            reason: `logged in, but could not refresh the session to read setup state (${e.code ?? e.message})`,
            next_step: 'Run `doctor` to check connectivity, or `login` again if the session expired, then `setup`.',
            tell_owner: "You're logged in, but I couldn't refresh your session to check setup — let me retry, or you may need a quick re-login.",
        });
        return;
    }
    // Best-effort reads — if the server is unreachable, say so rather than guess.
    let profile = null;
    let shared = false;
    let reachErr;
    try {
        profile = await api.getAgentProfile(token, agentId);
        const shares = await api.listShares(token);
        shared = shares.some((s) => s.agent_id === agentId);
    }
    catch (e) {
        reachErr = e.code ?? e.message;
    }
    if (!profile) {
        ok({
            status: 'setup_unknown', logged_in: true, agent_id: agentId,
            reason: `logged in, but could not reach the server to read setup state (${reachErr})`,
            next_step: 'Run `doctor` to check connectivity, then `setup` again.',
            tell_owner: "You're logged in, but I can't reach Siobac right now to check your setup — let me retry shortly.",
        });
        return;
    }
    const steps = [
        { step: 'login', done: true, label: 'Logged in' },
        { step: 'profile', done: profile.profile_complete, label: 'Public profile (what others see)', command: 'set-profile --description "…"' },
        { step: 'directive', done: profile.directive_set, label: 'Private directive (how you act on their behalf)', command: 'set-directive --content "…"' },
        { step: 'share', done: shared, label: 'Shared (reachable via QR/link)', command: 'share-self --confirmed' },
    ];
    const next = steps.find((s) => !s.done);
    const ownerLine = {
        profile: "Next let's write your public profile — a short line on who you are and what I can talk about. Want to set it now?",
        directive: "Next let's set your private directive — your rules for how I act on your behalf. Want to set it now?",
        share: "You're designed and ready — shall I publish your QR/link so people can reach you?",
    };
    ok({
        status: next ? 'setup_incomplete' : 'setup_complete',
        logged_in: true, agent_id: agentId, complete: !next,
        steps,
        next_action: next?.command ?? null,
        next_step: next
            ? `Next step — ${next.label}. Ask the owner for the content (AskUserQuestion is good for structured choices), then run \`${next.command}\`. Remaining steps follow in order; re-run \`setup\` to recheck.`
            : 'Setup complete — logged in, profile + directive set, and shared. Run `verify` anytime to confirm it all still works end-to-end.',
        tell_owner: next ? ownerLine[next.step] : "You're all set up on Siobac — profile, rules, and your share link are ready.",
    });
}
