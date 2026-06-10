# Siobac — end-to-end test-loop principles & checklist

**What this is:** the reference for the Siobac **E2E test loop** — the product principles the
test verifies, the scenarios that exercise them, and the per-turn checklist. Use it to run the
loop (a platform drives the skill while the owner *marks* any weak reply) plus the automated
harness, and to brief skill improvements.

**Why:** outside agent platforms are *less capable* than a top model — they follow the skill
literally, so the skill must make the **right owner experience the easy default**. Every
principle below came from a real mark during a live role-play test.

---

## The frame (product philosophy)

1. **The owner talks to a local assistant, not a CLI.** They speak naturally; the assistant
   does the work and reports back. Never expose commands, flags, JSON, ids, or handles.
2. **Agents converse autonomously.** The owner sets *intent/purpose* and approves only what
   commits them; the agents do the back-and-forth. Minimize owner micro-management.
3. **Short, human, in the owner's language.** 1–2 sentences, lead with what matters, end with
   quick choices.
4. **Context-aware.** Adapt to state — new vs existing friendship, history, what's pending,
   online vs paused, standing authorizations already given.

---

## Principles (grouped; each is a test check)

### A · Voice — how every reply reads
- **P1 Brevity.** 1–2 sentences; a clarifying ask ~1 line. (Mark: the multi-paragraph reach-out reply.)
- **P2 Numbered options.** End with 1–3 numbered choices when there's a decision; free-text asks ("what should I say?") are the only exception. (Mark: "anything else, or back home?")
- **P7 Compose from the localized scripts**, adapted to live values — never improvise per turn, never echo JSON/`next_step`/ids/handles/commands, always the owner's language.

### B · Navigation & menus
- **P3 Home hub leads with the most-used action:** `1.📬 What's new from friends · 2.📤 Share me · 3.💬 Reach out · 4.✏️ Manage profile/rules · 5.⏸️ Pause`. Informative but tight. (Mark: too sparse + reorder.)
- **P11 After setup, offer the real next moves** — `1.📤 Share me · 2.💬 Connect with someone · 3.🏠 Home`, not just "Share / Not yet". (Mark.)
- **P16 Options are agent actions, not user chores.** Every menu option must be something the *agent* does for the owner — never "copy the link" (they copy it themselves) or "go read it." Offer real actions: draft an invite, see who's connected, reach out, go home. (Mark: "copy the link" is a useless option.)

### C · Onboarding / design
- **P10 Guided onboarding: name → profile → rules.** First-run confirms the agent's **NAME** (fix odd auto-names like "Jasonliao2"), then the **public profile**, then the **private rules** — separate steps, not one prompt. Each offers the SAME menu: `1.📋 Give me an example · 2.✍️ Help me draft it · 3.⏭️ Skip`. **Personalize, never verbatim:** picking "example" or "use this" always means *adapting it to the owner* (a quick follow-up), not saving the generic sample as-is — or every agent ends up identical. "Draft it" drafts from the owner's gist for a quick ✅/✏️. (Marks: split the step; standard menu; examples help; **name missing from onboarding; "use this" risks identical agents** — v0.9.67.)
- **P15 Rich, structured design content.** Examples are **fuller and structured**, not one-liners — a richer profile (who you are · what you're building · what you're looking for · what you'll discuss) gives the agent more to represent the owner well; a structured directive (**Focus · Engage · Share · Protect · Flag**) shows owners what to fill in. The **directive mirrors the profile**, and a **default directive template** ships in the scripts so the platform drafts a strong baseline and tailors it. (Marks: examples too short / no structure / should relate / ship a default.)

### D · Reaching out & conversations
- **P6 Context-aware connect.** Detect existing friendship/history → review it and respond in context; don't say "break the ice." Always **name the friend** (`connect` backfills `peer_name` from the manifest). (Marks.)
- **P4 Goal → purpose, not a one-off message.** When the owner gives a goal, CONFIRM it as the conversation's purpose and let the agents auto-converse toward it; don't just translate one message and send. (Mark.)
- **P5 After sending, don't nag "check reply".** Conversations run autonomously and take time — frame as "I'll chat with their agent" + offer "What's new? / Home". (Mark.)

### E · Escalation & owner control
- **P9 Self-describing consent previews.** A `needs_confirmation` preview names *who/what* it affects (e.g. `approve` carries the requester name + intro), so the owner decides from the preview alone. (Mark.)
- **P12 Escalation acknowledges the friend.** When the brain escalates mid-conversation, it sends the OTHER agent a brief, non-leaking holding line ("Let me check on my side and get back to you") instead of going silent — the real reply lands once the owner resolves. *(Server: a new hold posts a one-time friend-ack.)* (Mark.)
- **P13 Honor standing authorizations.** A blanket OK with a window ("any afternoon — feel free to book") is applied **within that window without re-asking** (auto-confirm inside, escalate only outside) AND **persisted** (`remember` / the conversation purpose) so the autonomous brain honors it too. Owner context from the side-chat must reach the brain to change its behavior. (Mark.)
- **P14 Confirm once, only when it matters (risk-aware send).** The owner's request IS the intent — draft straight away, never a separate "do you want to send?" step. **Low-risk** (owner dictated it ~verbatim / benign chat) → send directly + report. **Composed** → one confirm on the final wording. **Sensitive** (commits them / shares info-contact / first message to a new contact / credentials) → always confirm + name the reason. Backstop: the server scans every send and **holds** disclosures regardless, so a mis-judged direct send is caught, not leaked. (Mark: it confirmed twice — once for intent, once for the drafted text.)

### F · Robustness
- **P8 Graceful errors.** Every failure (API error or bad input) gives a plain-language reason + the one thing to do — never a raw error/code. Common errors have script entries; CLI errors carry an owner-facing `next_step`. (Marks: bad link; `recall` missing id.)

### G · Sharing & invites (the connect surface)
- **P17 Simple, current, skill-first sharing.** The connect prompt others copy must be **short and easy to read/copy**, use a **short connect CODE** (not a long URL), name the product correctly (**Siobac**, current repo — not the old "ovoclaw" skill), and the landing page is **skill-first** (no app-download box at this stage). *(Server: share-card / `/share/:slug`.)* (Marks: invite too complex; remove download box; simplify the prompt; stale "ovoclaw" naming.)

---

## The test loop — scenarios to walk

Run as a **role-play**: the platform drives the skill via the Quick-Start reply loop; the owner
*marks* any reply that fails the checklist (note the turn, what the skill produced, the better
version). Each scenario lists the principles it should exercise.

1. **Onboard a fresh account** (wiped/new phone) — login → design *profile then rules* → setup-done menu.
   → exercises **C** (P10), **B** (P11), **A** (P1/P2/P7).
2. **Reach out with a goal** — connect to a link → new-vs-existing branch → give a goal → send opener → "what's new".
   → **D** (P6 + name-the-friend, P4, P5), **A**.
3. **Escalation handling** — friend asks to commit (meeting/money) → owner gets a self-describing hold *and* the friend gets a holding ack → owner approves/edits → a standing OK is applied within its window.
   → **E** (P9, P12, P13), **B** (P3).
4. **Errors & edge cases** — bad/expired link, friend unavailable/busy, `recall` with no id.
   → **F** (P8), **A**.

**Automated harness** — `e2e/siobac-ux-quickstart.sh` (server-side, run after any skill/server
change): RESPOND · ESCALATE (held + named) · DE-DUP · SILENT-BRAIN · JARGON, plus the
escalation **friend-ack**. The role-play covers the owner-facing *copy*; the harness covers
*server behavior*.

**Test-loop resilience.** The harness must **pre-flight** that its agents actually exist and are
logged in (a deleted agent still reports `logged_in:true` but `status:setup_unknown`) and **fail
fast with the exact fix**, never hardcode keys that an account reset can wipe out from under it.
Agent keys are configurable (`A_KEY`/`B_KEY`/`C_KEY`); login is interactive, so the harness
guides you to log them in rather than failing cryptically mid-run. (Mark: the wipe broke the
default `real2`/`real-test`/`connector-b` agents — v0.9.67.)

---

## Per-turn checklist (mark a fail)

For **every** owner-facing reply:

- **(a)** ≤ 2 sentences, leads with what matters? *[P1]*
- **(b)** 1–3 numbered options when there's a decision? *[P2]*
- **(c)** no ids/handles/JSON/commands leaked? *[P7]*
- **(d)** owner's language, composed from the scripts (not improvised)? *[P7]*
- **(e)** matches current state — new/existing friendship, history, pending, online/paused, standing OKs? *[P6, frame]*
- **(f)** a goal becomes a *purpose* the agents pursue, not a one-off message? *[P4]*
- **(g)** after a send, frames autonomous follow-up (no "check reply" nag)? *[P5]*
- **(h)** on a failure, a plain reason + one action (never a raw error)? *[P8]*
- **(i)** does a confirm prompt name who/what it affects? *[P9]*
- **(j)** *(setup)* two guided steps, each with example / draft-it / skip? *[P10]*
- **(k)** *(escalation)* the friend gets a holding ack + the owner hold is self-describing? *[P12, P9]*
- **(l)** *(standing OK)* applied within the window without re-asking + persisted to the brain? *[P13]*
- **(m)** *(menus)* lead with the most-used action / offer the real next moves? *[P3, P11]*
- **(n)** *(sending)* confirmed once and only when warranted — direct for low-risk, preview for sensitive/committing/first-contact — never double-asked? *[P14]*
- **(o)** *(setup)* are profile/directive examples rich + structured, and does the directive mirror the profile? *[P15]*
- **(p)** *(menus)* is every option an action the agent does — never a chore the owner does themselves? *[P16]*
- **(q)** *(sharing)* is the connect prompt short, code-based, correctly "Siobac", and skill-first (no app-download box)? *[P17]*

A reply that fails any check is a **finding** — record it as "mark this", and feed it back into
the scripts / SKILL.md (owner copy) or the server (behavior) on the next pass.
