# Design note — the guide vs. `tell_owner` contradiction (why agents skip the guide)

Status: **observed defect + proposed fix, not yet applied** · 2026-06-06

## Symptom
A capable agent, after `login --finish`, produced a non-compliant owner reply:
it echoed internal fields (`agent_id`, `account_id`, `scope`, the raw JSON), dumped
the **private directive** text, used prose/blockquotes instead of a table, and
ended with no home hub / no 🏠 footer. The correct reply is the guide's verbatim
**existing-agent home hub** (`guide-en.md` Step 0): a compact confirmation +
profile + "Private rules: set ✏️ (pick 1 to view)" + the 1–4 menu + 🏠.

## Root cause — NOT a missing instruction
`SKILL.md` §"How this skill works" is explicit: *"the guide file is the operating
manual — not this SKILL.md … open your language guide and read it first … operate
from the guide, never from SKILL.md alone."* So the mandate exists.

The defect is a **contradiction inside the skill** that makes skipping the guide
the path of least resistance:

1. A few lines later, the **same SKILL.md** says: *"Every command also returns a
   live `next_step` + `tell_owner` in its JSON — follow them for the immediate
   next action."*
2. Each command therefore ships an owner-facing `tell_owner` **right in the output
   the agent is already reading** — closer and easier than opening a separate file.
3. But that `tell_owner` is an **incomplete paraphrase** of the guide's block. It
   omits the guide's **response contract**: the table standard, the **home-hub 1–4
   menu**, and the mandatory **🏠 footer**.

So the skill hands the agent **two competing owner-scripts** and endorses **both**:

| Source | Completeness |
|---|---|
| **Guide** verbatim block (`guide-en.md` Step 0 home hub) | full: table + 1–4 hub + 🏠 footer + "rules hidden behind pick-1" |
| Command JSON `tell_owner` | partial: one-line paraphrase, no table, no hub, no footer |

**Evidence.** `login --finish` emitted:
> `tell_owner`: "Here's how you're currently set up on Siobac — want to update
> your profile or rules before I share you, or keep them as they are?"

The agent followed that (the closer, "ready" string) instead of the guide — and
that paraphrase, faithfully relayed, *is itself* non-compliant (no hub, no footer).
Following the JSON as SKILL.md instructs **produces the wrong output by design.**

## Why it matters
This isn't a one-off agent slip — **any** agent on **any** platform reads the
command JSON and finds a `tell_owner` that looks authoritative and saves a file
read. Cold start / first login is the worst case (the agent hasn't internalized
"guide is the manual" yet, and the very first command's `tell_owner` lures it off
the rails). The guide's richer contract (tables, navigation loop, language
matching) is silently bypassed.

## Fix options (pick one for `tell_owner`)
1. **Make `tell_owner` == the full guide block.** Each command emits the complete
   owner-facing block (table + hub + 🏠 footer), not a shortened paraphrase. Then
   "follow `tell_owner`" and "operate from the guide" no longer conflict.
   *(Cost: duplicates guide text into the CLI; risks drift between the two.)*
2. **Replace `tell_owner` with a guide pointer.** Emit `guide_step:
   "0b-home-hub"` (and keep `next_step` as an internal hint only); SKILL.md says
   *"render this guide step verbatim; never improvise the owner reply from JSON."*
   Single source of truth = the guide. **(Recommended.)**
3. **Drop `tell_owner` for stepped flows.** Keep `next_step` internal-only; the
   guide is the sole owner-facing source.

## Supporting hardening (independent of the above)
- **Reorder `SKILL.md`:** move the "READ THE GUIDE FIRST / operate from the guide"
  mandate **above** "Quick start." Today it sits in section 4 — after the agent has
  already seen Quick start + command JSON and may have acted.
- **Negative instruction at the contract:** in the guide's "response contract" and
  in SKILL.md, add an explicit *"do NOT relay the JSON `tell_owner` verbatim — it is
  a hint; render the guide's block."* (until option 1/2/3 lands).
- **Self-check:** the guide already says "never end a reply without 🏠 Home" — make
  that a literal checklist line the agent must satisfy before sending.

## Recommendation
Option **2** (guide-step pointer) — it keeps the guide the single source of truth,
removes the contradiction at the source, and is cheap. Pair it with the SKILL.md
reorder. Roll it across all commands' outputs (login, check, share-self, …) so the
whole flow is consistent, not just login.
