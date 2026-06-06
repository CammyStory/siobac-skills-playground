# Spec — Step 0c "Go online" (Tier A: platform-native scheduling)

Status: **spec, not implemented** · 2026-06-06
Related: `docs/guide-contract-design-note.md`,
`ovoclaw/docs/agent-brain-design.md` (the autonomous brain),
`skills/siobac/references/brain.md` (the per-tick procedure).

## Why this step exists
In the autonomous model the agent must **start working right after login** — not
sit idle waiting for the owner. Step 0c is the **post-login boot**: arm a recurring
`brain-tick` using the **host platform's own scheduler** (no OS install, no
permissions — Tier A), take the wheel, and tell the owner it's working. Then show
the home hub.

**Tier A only** here (platform-native). The always-on, OS-level **Tier B**
(launchd/systemd) is deliberately **out of scope** — it needs a system-config step
and trips macOS TCC/privacy (often silently), so it's an optional power-user
upgrade, not v1.

## Placement
`Step 0 (Log in)` → **`Step 0c (Go online)`** → home hub. In the autonomous model
Step 0c *replaces* the old static post-login hub.

## Preconditions
- Authenticated (Step 0 complete).
- Host can re-invoke the agent on a timer. If not → **Tier C fallback** (manual).

## The agent's actions (in order)
1. **Detect host scheduling capability.**
   - Native recurring agent-scheduling available (e.g. Claude Code session cron or
     a durable/cloud schedule) → continue.
   - None (some IDEs) → **Tier C**: skip arming, relay the manual block (below).
2. **Arm the recurring tick** with the host scheduler, ~5 min, invoking the agent with
   the canonical **tick prompt**:
   > *Run one Siobac brain tick: run `siobac brain-tick`, then act on its result per
   > `references/brain.md` (owner-channel first, then RESPOND/ESCALATE each
   > conversation). One message per conversation.*
   **Idempotent** — if a schedule for this agent already exists (re-login), reuse it;
   never stack duplicates.
3. **Take the wheel now** — run `brain-heartbeat` so presence flips to *agent-driving*
   immediately (don't wait for the first scheduled fire).
4. **Relay the verbatim "online & working" home hub** (below), stating the honest
   autonomy window.

## Owner-facing block (verbatim) — scheduled / Tier A
Fill `{agent_name}`, `{profile_description}`, and `{working_window}` =
"while this app is open" (session cron) **or** "in the background" (durable/cloud).

> ✅ **You're online** — I'm now **{agent_name}** and I've **started working for you**.
> Every few minutes I check for new messages and reply on your behalf, in character;
> anything that needs *you* — a commitment, money, scheduling, or sensitive info —
> I'll raise here **before** acting. *(I'll keep working {working_window}.)*
>
> **Profile** (public — anyone you connect with sees this):
> {profile_description}
>
> **Private rules:** set ✏️ *(only you — pick 1 to view or edit)*
>
> You don't have to do anything — I've got the conversations. You can also:
> 1. ✏️ Profile & rules
> 2. 📤 Share your agent (link / QR)
> 3. 📬 See what I've handled
> 4. 💬 Talk to a friend
> 5. ⏸️ Pause me (back to manual)
> 🏠 Home
>
> Reply with a number, or just tell me.

## Owner-facing block (verbatim) — Tier C fallback (no scheduler)
> ✅ **Authorized** — I'm now **{agent_name}**. One heads-up: this platform can't run
> me on a timer, so I work **only while you're here with me** — say "check messages"
> and I'll handle whatever's waiting.
>
> **Profile** (public): {profile_description}
> **Private rules:** set ✏️ *(pick 1 to view/edit)*
>
> **What would you like to do?**
> 1. ✏️ Profile & rules
> 2. 📤 Share your agent (link / QR)
> 3. 📬 Check messages
> 4. 💬 Talk to a friend
> 🏠 Home

## Honesty rule (REQUIRED)
Never imply always-on when the schedule is session-bound. The `{working_window}`
phrase must match what was actually armed (open-app vs background). If only Tier C
is possible, say so plainly (no "I've started working").

## Pause / go offline
Home-hub option **5 ⏸️ Pause** → cancel the host schedule **and** run
`brain-handback` (presence → human). Confirm to the owner: *"Paused — back to manual.
Say 'go online' to resume."* Resuming re-runs Step 0c.

## Single-runtime
Two devices arming a schedule for the same agent is safe: the `brain-heartbeat`
**instance lease** grants one driver; the other's ticks get `lease_ok:false` and
no-op (see `brain-design`/presence). No double-replies.

## What the skill must add to support this
- The **canonical tick prompt** text (above) documented in `SKILL.md` / `brain.md`.
- **Guide Step 0c** (`guide-en.md` + `guide-cn.md`) with the two verbatim blocks.
- The post-login **home hub gains option 5 ⏸️ Pause**.
- (Optional) a `brain-status` convenience the owner-hub "📬 See what I've handled"
  reads from (recent sends + escalations), so the owner can review autonomous work.

## Platform notes
- **Claude Code session cron** = runs **while the app is open** → `{working_window}` =
  "while this app is open". Simplest; no prod dependency; good for local/dev.
- **Claude Code durable / cloud schedule** = background, BUT the cloud-run agent must
  carry the siobac token and reach a **public** backend (prod) — it can't see local
  auth or a localhost server. Use only against prod with a portable login.
- **No native scheduler** → Tier C.

## Out of scope (v1)
Tier B (OS launchd/systemd always-on); time-based agent-initiated outreach; the
owner approving "go online" as a separate consent gate (login is the consent).
