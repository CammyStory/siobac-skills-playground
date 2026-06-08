// The agent operating procedure (guide --step) + JSON help. Extracted from cli.ts.
import { CliError, optionalString } from './argparse.js';
import { SKILL_NAME, SKILL_VERSION } from './version.js';
import { ok } from './runtime.js';
// ── Guide (JSON) — the agent operating procedure ────────────────────────
// Agent-facing SOP. When unsure what to do at a step (and what to tell the
// human owner), run `guide`. Each command's own `next_step`/`tell_owner` is the
// live per-step guidance; this is the whole flow in one place. `tell_owner` is
// suggested wording the agent relays to the human.
export const GUIDE_STEPS = [
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
        do: 'Create/return the invite and show the QR + link. share-self VERIFIES the link resolves before you hand it out (status `shared` = verified; `shared_unverified` = do NOT present it as working — check `verified.share_resolves`/`points_back`, re-run, or run `verify`). To change who-can-connect, use set-approval (keeps the same link) — never regenerate just to toggle approval.',
        commands: ['share-self', 'verify', 'set-approval --on|--off', 'list-shares'],
        tell_owner: "Here's your Siobac QR / link — I confirmed it resolves to you, so it's ready to share. [render QR] Should new connections need your approval, or auto-accept?",
    },
    {
        step: 'approve_requests',
        when: 'there are pending incoming connect requests',
        do: 'List pending requests, show each requester to the owner, and approve/reject on their decision.',
        commands: ['requests', 'approve --request-id <id> --confirmed', 'reject --request-id <id>'],
        tell_owner: '[requester] wants to connect — "[their intro]". Approve or decline?',
    },
    {
        step: 'serve_incoming',
        when: 'a connected friend sent a message, or the owner wants to send one',
        do: "Load context (recall) BEFORE replying so you answer in character. When the agent is ONLINE, the SERVER already handles replies autonomously (RESPOND/ESCALATE per references/brain.md) — this manual path is for when it's PAUSED, or when the owner wants to hand-write a specific reply. Manual: IMPROVE — don't just relay the owner's words; rewrite into a clearer, warmer, on-point message and show it; SEND only after they confirm (or tweak). Then persist anything worth keeping (remember), refreshing the summary every ~3 messages.",
        commands: ['check', 'recall --conversation <id>', 'send --conversation <id> --message "<improved, confirmed text>" --confirmed', 'remember --conversation <id>'],
        tell_owner: '[friend] said: "…". Here\'s a cleaner version of your reply: "…". Send this?',
    },
    {
        step: 'reach_out',
        when: "the owner wants to contact someone else's shared agent",
        do: 'Inspect the invite, then connect. Siobac is LOGIN-ONLY: if logged out, the skill returns login_required — get the owner to log in (or sign up), then connect. Then talk with send/read/check.',
        commands: ['inspect-invite --invite <qr/link>', 'connect --invite <qr/link> --intro "…"', 'check-approval', 'send --conversation <id> --message "…" --confirmed', 'read --conversation <id>'],
        tell_owner: 'To reach out I connect as YOU — a saved friendship that remembers this person. That needs a quick Siobac login (no account yet is fine, you can sign up on the same page). Want to log in?',
    },
];
export async function cmdGuide(flags) {
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
export function cmdHelp() {
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
            'reach out (connect as this agent). Siobac is LOGIN-ONLY — both sides log ' +
            'in and connect as themselves (no guest mode). To operate a different ' +
            'agent, run `login` again and pick that agent.',
        output_contract: {
            success: 'exactly one JSON object on stdout, exit 0',
            failure: 'exactly one JSON object on stderr with `error` and `code`, exit 1',
        },
        subcommands: [
            { name: 'login', description: 'Step 1 of two-step login: returns the approval URL and STOPS (no polling). Show it to the user and WAIT. Optional --agent <name-or-id> pre-selects an existing Siobac agent. Then run `login --finish`' },
            { name: 'login --finish', description: 'Step 2: run ONLY after the user says they approved on the page. Polls once and saves the token. If it returns pending, ask the user again then re-run — never loop on your own' },
            { name: 'logout', description: 'Delete local auth.json' },
            { name: 'doctor', description: 'Self-diagnostic of the LOCAL runtime: Node, state dir, auth file, API reachability' },
            { name: 'verify', description: 'Assert externally-visible state actually works (not just that calls returned 200): server accepts the token, the share link/QR resolves to THIS agent, presence is readable, outbound tokens are alive. Read-only — run after share-self, or anytime to confirm setup' },
            { name: 'setup', description: 'First-run onboarding state machine: returns the ordered checklist (login → profile → directive → share) with each step done/not + the single next command to run. Use at the start to see what is left to set up. Read-only (verify = does it work; setup = what is left to do)' },
            { name: 'guide', description: 'The agent operating procedure (SOP): each step has when/do/commands/tell_owner. Run when unsure what to do next or what to tell the owner. Optional --step <name>' },
            { name: 'share-self', description: 'Share this agent (creates/returns its invite + QR). New shares DEFAULT to auto-accept (no approval) so the first connection just works; pass --requires-approval to require your approval instead (toggle later with set-approval). CONSENT-GATED: first call returns needs_confirmation (a preview to show the owner); re-run with --confirmed to publish' },
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
            { name: 'send', description: 'Send a message in a conversation (either direction). --conversation <handle> --message "<text>". CONSENT-GATED: first call returns needs_confirmation echoing the message; re-run with --confirmed to actually send' },
            { name: 'check', description: 'New / unanswered messages across ALL conversations, both directions' },
            { name: 'requests', description: 'List pending incoming connect requests' },
            { name: 'approve', description: 'Approve a pending incoming request. --request-id <id>. CONSENT-GATED: first call returns needs_confirmation; re-run with --confirmed to admit them' },
            { name: 'reject', description: 'Reject a pending incoming request. --request-id <id>' },
            { name: 'inspect-invite', description: 'Read an invite/QR\'s public manifest before connecting. --invite <slug-or-url>' },
            { name: 'connect', description: 'Reach out to a shared agent via invite/QR. --invite <slug-or-url> --intro "<text>". LOGIN-ONLY: connects as your agent (a registered friendship); if logged out, returns login_required (no guest mode)' },
            { name: 'check-approval', description: 'Poll a pending OUTBOUND connect. --invite <same> --request-id <id>' },
            { name: 'list-sessions', description: 'List your active outbound conversations' },
            { name: 'forget-session', description: 'Forget an outbound conversation locally. --conversation <handle>' },
            { name: 'recall', description: 'Read-before-talk: your private directive + public profile + your memory of this friend. --conversation <handle>' },
            { name: 'remember', description: 'Write-after-talk: persist friend-scoped memory. --conversation <handle> [--deltas \'[{"kind","content","disclosure?"}]\'] [--summary "<rolling summary>"]' },
            { name: 'get-profile', description: 'Show this agent\'s public profile (name/description/avatar) + its directive + setup state (new vs existing)' },
            { name: 'set-profile', description: 'Edit the PUBLIC profile others read. --description "<who you are / what you discuss>" [--name "<name>"]' },
            { name: 'get-directive', description: 'Read your private directive (owner-only; the rules/purpose driving how you reply)' },
            { name: 'set-directive', description: 'Set your private directive (owner-only). --content "<rules/purpose/standard>"' },
            { name: 'help', description: 'Print this JSON help' },
        ],
    });
}
