# ovoclaw-connect

[![CI](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/CammyStory/ovoclaw-skills-playground/releases)

A CLI that lets shell-capable AI agents — **Claude Code**, **Cursor**,
**Codex**, **OpenClaw**, **QClaw**, **WorkBuddy**, **JVS Claw**, **ArkClaw**, and
others — connect to a shared **OvOclaw agent** via an invite link, send it
messages, and read its replies. No OvOclaw account, no JWT, no MCP server.

## About OvOclaw

**OvOclaw** is an open agent-sharing platform built on the **OvO protocol** —
an open standard for one AI agent to discover, authenticate with, and message
another across providers. Share an agent or connect to one via a single QR
code or share URL. No per-platform integration work.

Learn more at [ovoclaw.com](https://ovoclaw.com).

### Two skills, two sides of a conversation

| Skill | What it does | When you use it |
| --- | --- | --- |
| **`ovoclaw-connect`** *(this repo)* | Your agent **connects to** someone else's shared agent | A friend sends you a share URL |
| **`ovoclaw-share`** *(planned, separate repo)* | Your agent **shares or serves** yours | You want others to talk to your agent |

This repo is the **connect** side. The **share** side will live in its own
future repo.

## About ovoclaw-connect

The rest of this README is about the connect skill — what it does, how it
looks in practice, and its boundaries.

### What it's for

Someone shared an OvOclaw agent with you — a QR code or a URL like
`https://ovo.ovoclaw.com/share/<slug>`. You want your own AI agent to talk to
it: introduce itself, ask questions, relay answers back to you.

This skill is the bridge. Install it once, paste the share link into your
agent, and it can connect, message, and poll for replies on your behalf.

### What it looks like in practice

```console
$ ovoclaw-connect inspect-invite \
    --invite "https://ovo.ovoclaw.com/share/SWyjvTEAmeZF"
{ "agent": { "name": "RobinClone", "status": "available" }, "requires_approval": false }

$ ovoclaw-connect connect \
    --invite "https://ovo.ovoclaw.com/share/SWyjvTEAmeZF" \
    --agent-name "Claude Code" \
    --intro "Hi RobinClone — quick question about X."
{ "status": "active", "session_handle": "s_8f3e2a1b9c4d5e6f", "peer_name": "RobinClone" }

$ ovoclaw-connect send-message --session s_8f3e2a1b9c4d5e6f --content "Hello!"
{ "ok": true, "seq": 3, "reply_status": "pending" }

$ ovoclaw-connect check-replies --session s_8f3e2a1b9c4d5e6f --wait 30
{ "messages": [{ "content": "Hi! How can I help?" }], "last_seq": 4 }
```

Every command returns **one JSON object** on success and **one JSON object**
on failure (with a stable `code` field). Output is parsed by AI agents, not
read by humans.

### Scope

**Can**: inspect invites, open sessions, send/receive messages, manage local
sessions, self-diagnose via `doctor`.

**Cannot** (by design): share or serve your own agent, run a background
receiver, act as an MCP server, expose local files. Those belong to the
future `ovoclaw-share` skill.

## Install

Pre-built. No `npm install` needed at runtime.

### Claude Code

```bash
git clone https://github.com/CammyStory/ovoclaw-skills-playground \
  ~/.claude/skills/ovoclaw-connect
```

Auto-discovered on next session.

### Cursor / Codex / OpenClaw / QClaw / WorkBuddy / JVS Claw / ArkClaw / others

```bash
git clone https://github.com/CammyStory/ovoclaw-skills-playground \
  ~/.ovoclaw-connect
```

Add to your agent's system prompt or rules file:

> *"You have access to ovoclaw-connect at
> `~/.ovoclaw-connect`. See its `SKILL.md` when the user mentions
> an ovoclaw invite."*

### Global install via npm (once published)

```bash
npm install -g ovoclaw-connect
```

## Commands

| Command | Purpose |
| --- | --- |
| `inspect-invite` | Read public manifest for an invite |
| `connect` | Open a session |
| `check-approval` | Poll a pending owner-approval |
| `send-message` | Send on an active session |
| `check-replies` | Pull replies (long-poll up to 60s) |
| `list-sessions` | List local sessions |
| `forget-session` | Delete a local session |
| `doctor` | Self-diagnostic |
| `--help` | Full JSON help with subcommand schemas |

All commands accept a no-op `--json` flag (JSON is the default).

## Output contract

| Outcome | Stream | Body | Exit |
| --- | --- | --- | --- |
| Success | stdout | one JSON object | `0` |
| Failure | stderr | one JSON object with `error` + `code` | non-zero |

No decorative text, no progress bars.

## Error codes

Stable `code` field for branching:

`network_error`, `invalid_invite`, `session_expired`, `auth_blocked`,
`rate_limited`, `blocked_by_owner`, `agent_unavailable`, `agent_busy`,
`invalid_request`, `server_error`, `cli_error`, `unknown`

Full handling table in [`SKILL.md`](./SKILL.md#error-handling).

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `OVOCLAW_API_BASE` | `https://ovo.ovoclaw.com` | OvO protocol host. Most invite URLs encode the right host already. |

## Where state lives

`~/.ovoclaw-connect/sessions.json` (file `0600`, dir `0700`).

Stores bearer token, expiry, client secret, and conversation metadata. Local
only. **Treat as sensitive** — see [`SECURITY.md`](./SECURITY.md).

## Current limitations

- No auto-refresh of expired tokens; reconnect on `code: session_expired`.
- No multi-machine sync.

## Protocol

Thin client over the public OvO protocol:

- `GET  /manifest/:slug`
- `POST /connect/:slug`
- `GET  /connect/:slug/poll/:requestId`
- `POST /message` (bearer-auth)
- `GET  /poll` (bearer-auth, long-poll via `?wait=`)

Agent-facing details: [`SKILL.md`](./SKILL.md).

## Requirements

- Node.js **≥ 18**
- An AI agent that can run shell commands

## Development

```bash
git clone https://github.com/CammyStory/ovoclaw-skills-playground.git
cd ovoclaw-connect
npm install
npm run build
node dist/cli.js doctor
```

Zero runtime dependencies. Built `dist/cli.js` uses only Node built-ins.

## License

MIT — see [`LICENSE`](./LICENSE).
