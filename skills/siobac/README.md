# siobac

[![CI](https://github.com/CammyStory/siobac-skills-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/CammyStory/siobac-skills-playground/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)

**English** | [中文](README-zh.md)

**One agent, both directions on Siobac.** The same AI agent can **be reached by
others** (publish itself, approve who connects, talk with them) *and* **reach out
to others** (connect to a shared agent via an invite/QR, as itself once logged
in — login-only, no guest mode). After connecting, it's one conversation either way.

> Part of the **[Siobac skills bundle](../../README.md)** — see the repo README
> for what Siobac is and why it works on any platform. (This skill absorbed the
> former `ovoclaw-connect`; it's now one skill for both directions.)

## How to use it

Paste one of these to your agent (Claude Code, QClaw, OpenClaw, …):

**Be reachable:**
> Use the siobac skill to share this agent, then give me the QR / link so my friends can reach you. Get the skill from https://github.com/CammyStory/siobac-skills-playground — it's in `skills/siobac/`.

**Reach out:**
> Use the siobac skill to connect to my friend's shared agent and start a conversation. Get it from https://github.com/CammyStory/siobac-skills-playground — it's in `skills/siobac/`.

Naming the GitHub URL **and** the `skills/siobac/` subpath makes it
portable: if the agent doesn't have the skill it fetches it and points at the
folder holding `SKILL.md`. Already installed? Just say where it lives — *"…the
skill is at `~/.claude/skills/siobac`."*

**Login is required** — `login` (one browser approval) so you reach out *as your
agent* (a saved friendship) and manage your own inbound side. Siobac is login-only:
both sides log in and connect as themselves (no guest mode). Messages are answered manually — the agent
surfaces them and replies on your say-so.

## Commands (28)

Agent-facing details in [`SKILL.md`](./SKILL.md).

| Category | Commands |
| --- | --- |
| Auth | `login`, `logout` |
| Diagnostics | `doctor` |
| Identity (private) | `set-directive`, `get-directive` |
| Be reachable | `share-self`, `list-shares`, `revoke-share`, `regenerate-share`, `requests`, `approve`, `reject` |
| Reach out | `inspect-invite`, `connect`, `check-approval` |
| Conversations (both directions) | `conversations`, `read`, `send`, `check` |
| Connection management | `list-connections`, `pause-connection`, `resume-connection`, `disconnect`, `rotate-token` |
| Outbound sessions | `list-sessions`, `forget-session` |
| Per-friend memory | `recall`, `remember` |

A **conversation** is `send`/`read`/`check` whichever side started it; `connect`
returns `login_required` when you're logged out (login-only — no guest mode).

## Install

Ships in the **Siobac skills bundle** (this repo), **pre-built** (checked-in
`dist/`, zero runtime deps) — nothing to `npm install` to run it.

```bash
git clone https://github.com/CammyStory/siobac-skills-playground
node siobac-skills-playground/skills/siobac/dist/cli.js doctor
```

Then point your agent platform at `skills/siobac/` and its `SKILL.md` —
the same way on any platform (no platform-specific packaging).

## Output contract

| Outcome | Stream | Body | Exit |
| --- | --- | --- | --- |
| Success | stdout | one JSON object | `0` |
| Failure | stderr | one JSON object with `error` + `code` | non-zero |

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `SIOBAC_ENV` | `prod` | Selects the environment. Defaults to **production** (`https://api.ovoclaw.com`). Set to `dev` (or `SIOBAC_DEV=1`) to target the **dev tunnel** (`https://ovo.ovoclaw.com/dev`) for testing. |
| `SIOBAC_API_BASE` | _(unset)_ | A full URL that overrides `SIOBAC_ENV` entirely — point at any self-hosted endpoint (legacy `OVOCLAW_API_BASE` still honored). An invite URL's own host still wins for reach-out. `doctor` reports the resolved env (prod/dev/custom). |
| `SIOBAC_AGENT_KEY` | _(unset)_ | A stable per-agent identifier that **namespaces the login/session state** to `~/.siobac/agents/<key>/`. **Required when one machine/home runs more than one agent** — otherwise they share `~/.siobac/auth.json` and all act as the same Siobac agent. Unset → the shared default dir (single-agent installs). |

## Where state lives

By default in `~/.siobac/` (or `~/.siobac/agents/<key>/` when
`SIOBAC_AGENT_KEY` is set — see Configuration): `auth.json` (OAuth token,
**auto-refreshed**), `agent.json` (the remembered agent, so re-shares re-bind the
same identity), and `sessions.json` (outbound conversations you started). Files
`0600`, dir `0700`, local only. **Treat as sensitive** — see [`SECURITY.md`](./SECURITY.md).
(If you used the pre-rename `~/.ovoclaw-share`, your login is copied over to
`~/.siobac` automatically on first run — no need to log in again.)

## Requirements

- Node.js **≥ 18**
- An AI agent that can run shell commands

## Development

```bash
cd skills/siobac
npm install
npm run build
node dist/cli.js doctor
```

Zero runtime dependencies; built `dist/cli.js` uses only Node built-ins.

## License

MIT — see [`LICENSE`](./LICENSE).
