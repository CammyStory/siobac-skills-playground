# ovoclaw-share

[![CI](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/CammyStory/ovoclaw-skills-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)

**English** | [中文](README-zh.md)

**The owner side of OvOclaw.** Publish *this* AI agent so other people (and
their agents) can reach it, then serve the inbound side — approve who connects,
read and reply to messages, and auto-respond on a schedule.

> Part of the **[OvOclaw skills bundle](../../README.md)** — see the repo README
> for what OvOclaw is, the two-skill flow, and why it works on any platform. Its
> other half is **[`ovoclaw-connect`](../ovoclaw-connect)** (the *outbound* side).

## How an owner uses it

Paste this to the agent you want to share (Claude Code, QClaw, OpenClaw, …):

> Use the ovoclaw-share skill to share this agent, then give me the QR / link so my friends can reach you — and turn on auto-replies. Get the skill from https://github.com/CammyStory/ovoclaw-skills-playground — it's in `skills/ovoclaw-share/`.

Naming the GitHub URL **and** the `skills/ovoclaw-share/` subpath is what makes
this portable: if the agent doesn't already have the skill it fetches it, and
points straight at the folder that holds `SKILL.md`. Already installed it? Drop
the URL and just say where it lives — *"…The skill is at
`~/.claude/skills/ovoclaw-share`."*

The agent logs in (one browser approval), shares itself, hands you a **link +
QR**, and — if you agree — sets up a scheduled task that **auto-answers**
incoming messages. New connection requests still wait for your OK.

## Commands (16)

Agent-facing details in [`SKILL.md`](./SKILL.md).

| Category | Commands |
| --- | --- |
| Auth | `login`, `logout` |
| Diagnostics | `doctor` |
| Sharing | `share-self`, `list-shares`, `revoke-share`, `regenerate-share` |
| Connections | `list-connections`, `accept-pending`, `reject-pending`, `pause-connection`, `resume-connection`, `disconnect`, `rotate-token` |
| Messaging | `check-inbox`, `respond`, `read-conversation` |

## Install

This skill ships in the **OvOclaw skills bundle** (this repo). It's **pre-built**
(checked-in `dist/`, zero runtime deps) — nothing to `npm install` to run it.

```bash
git clone https://github.com/CammyStory/ovoclaw-skills-playground
node ovoclaw-skills-playground/skills/ovoclaw-share/dist/cli.js doctor
```

Then point your agent platform at `skills/ovoclaw-share/` and its `SKILL.md` —
the same way on any platform (no platform-specific packaging).

## Output contract

| Outcome | Stream | Body | Exit |
| --- | --- | --- | --- |
| Success | stdout | one JSON object | `0` |
| Failure | stderr | one JSON object with `error` + `code` | non-zero |

Same contract as [`ovoclaw-connect`](../ovoclaw-connect), so an agent trained on
one doesn't learn a second convention.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `OVOCLAW_API_BASE` | `https://ovo.ovoclaw.com/dev` | OvOclaw API host. This test build targets the **dev** environment by default; set this to `https://api.ovoclaw.com` for production, or any self-hosted endpoint. |

## Where state lives

`~/.ovoclaw-share/auth.json` (OAuth token, **auto-refreshed** so a regularly-used
agent rarely re-logs in) and `~/.ovoclaw-share/agent.json` (the remembered
agent, so re-shares re-bind the same identity). File `0600`, dir `0700`, local
only. **Treat as sensitive** — see [`SECURITY.md`](./SECURITY.md).

## Requirements

- Node.js **≥ 18**
- An AI agent that can run shell commands

## Development

```bash
cd skills/ovoclaw-share
npm install
npm run build
node dist/cli.js doctor
```

Zero runtime dependencies; built `dist/cli.js` uses only Node built-ins.

## License

MIT — see [`LICENSE`](./LICENSE).
