// Agent-brain owner surface (the brain itself runs on the SERVER). Extracted from cli.ts.
import * as api from './api.js'
import { requireString, optionalString } from './argparse.js'
import { ok, requireBoundAgent } from './runtime.js'

// ── Agent Brain — owner surface (the brain itself runs on the SERVER) ──
// docs/agent-brain-design.md, references/brain.md. The server composes + sends
// autonomous replies and escalates owner-committing asks; this skill only lets
// the owner toggle autonomous mode (pause/go-online), read presence, and handle
// escalations (owner-channel, brain-pending/brain-resolve) plus owner-triggered
// outreach/interrupt. There is NO client tick/loop here — see brain.md.

// Go online — resume autonomous mode (the server auto-replies again) after a pause.
// Autonomous is the DEFAULT once shared, so this is only needed to undo a pause.
export async function cmdGoOnline(_flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const res = await api.brainGoOnline(auth.accessToken, agentId)
  ok({ status: 'ok', ...res, tell_owner: "I'm online — I answer your friends automatically and flag anything that needs you." })
}

// Pause — switch to manual: the server stops auto-replying; messages wait for you.
export async function cmdBrainHandback(_flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const res = await api.brainHandback(auth.accessToken, agentId)
  ok({ status: 'ok', ...res, tell_owner: "Paused — I've stopped auto-replying; messages will wait for you. Say 'go online' to resume." })
}

// Online check: am I auto-replying (online) or paused (manual)? The SERVER is the
// responder — there's no client task to keep alive.
export async function cmdBrainStatus(_flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const res = await api.brainPresence(auth.accessToken, agentId)
  ok({
    status: 'ok', ...res,
    next_step: res.online
      ? 'ONLINE — the server auto-replies for this agent and escalates anything that needs the owner. Nothing to arm or keep alive.'
      : 'PAUSED (manual) — the server is NOT auto-replying; messages wait for the owner. Run `go-online` to resume autonomous replies.',
  })
}

// owner-channel: no --message → READ (the owner<->you thread); with --message →
// POST as the agent (talk back / clarify / answer / report).
export async function cmdOwnerChannel(flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const text = optionalString(flags, 'message')
  if (text !== undefined) {
    const res = await api.brainOwnerChannelPost(auth.accessToken, agentId, 'agent', text)
    ok({ status: 'sent', ...res })
    return
  }
  const since = Math.max(0, Number(optionalString(flags, 'since') ?? '0') || 0)
  const res = await api.brainOwnerChannelRead(auth.accessToken, agentId, since)
  ok({ status: 'ok', ...res })
}

export async function cmdBrainPending(_flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const res = await api.brainPending(auth.accessToken, agentId)
  ok({ status: 'ok', ...res })
}

export async function cmdBrainResolve(flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const requestId = requireString(flags, 'request-id', 'brain-resolve')
  const action = (optionalString(flags, 'action') ?? 'sent') as 'sent' | 'handed_off' | 'declined'
  // action 'sent' DELIVERS the held reply. Pass --message to send the owner's
  // edited/approved text (sent scan-bypassed, since the owner approved it); omit
  // to send the held draft as-is. This is how an approved escalation goes out —
  // do NOT also run a separate `send` for it (that would double-send + re-scan).
  const message = optionalString(flags, 'message')
  const res = await api.brainResolve(auth.accessToken, agentId, requestId, action, action === 'sent' ? message : undefined)
  ok({
    status: 'ok', ...res,
    note: action === 'sent'
      ? (res.sent ? 'Approved reply delivered to the conversation.' : 'Resolved. (No text to send — nothing was delivered.)')
      : undefined,
    tell_owner: action === 'sent' && res.sent ? 'Sent your approved reply.' : undefined,
  })
}

// OWNER-TRIGGERED outreach. The agent NEVER self-initiates: run this ONLY because
// the owner said so in the owner-channel ("go talk to X"). Sends an opener into an
// existing connection; after that it's a normal conversation the server handles.
// (New-connection-via-invite outreach uses `connect` + `send`.)
export async function cmdBrainOutreach(flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const connId = requireString(flags, 'conversation', 'brain-outreach')
  const message = requireString(flags, 'message', 'brain-outreach')
  const res = await api.postReply(auth.accessToken, agentId, connId, message)
  ok({ status: 'sent', conversation: connId, ...res, note: 'Owner-triggered opener sent. It is now a normal conversation; their reply shows up on `check`.' })
}

// Interrupt: the owner said "stop talking to Y". Pause the connection so the
// server leaves it alone (resume later with `resume-connection`).
export async function cmdBrainInterrupt(flags: Record<string, string | true>) {
  const { auth, agentId } = await requireBoundAgent()
  const connId = requireString(flags, 'conversation', 'brain-interrupt')
  await api.actOnConnection(auth.accessToken, agentId, connId, 'pause')
  ok({ status: 'paused', conversation: connId, tell_owner: "Paused — I'll leave that conversation alone until you say otherwise (resume-connection to undo)." })
}
