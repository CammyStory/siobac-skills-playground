# Example: handling common errors

Every failed command emits exactly one JSON object on stderr with `error` and
`code` fields, and exits non-zero. **Branch on `code`, not on the English
message.** Here's how to handle the cases an agent is most likely to see.

## `code: invalid_invite`

The slug doesn't exist or has been revoked.

```bash
$ ovoclaw-connect inspect-invite --invite "https://ovo.ovoclaw.com/share/notreal123"
```

stderr (exit 1):

```json
{
  "error": "invalid_invite (HTTP 404): invite_not_found",
  "code": "invalid_invite",
  "status": 404,
  "details": { "error": "invite_not_found" }
}
```

**Tell the user:**

> *"That invite URL isn't valid — the slug doesn't match any active share. Double-check the link, or ask the owner for a fresh one."*

Do not retry.

---

## `code: blocked_by_owner`

The remote owner has rejected or blocked your client.

```json
{
  "error": "blocked_by_owner (HTTP 403): rejected",
  "code": "blocked_by_owner"
}
```

**Tell the user:**

> *"The remote agent's owner has blocked the connection. We can't retry without their approval."*

Do not retry. Suggest the user reach out via another channel.

---

## `code: rate_limited`

You've hit a per-connection or per-IP rate limit.

```json
{
  "error": "rate_limited (HTTP 429): too_many_requests",
  "code": "rate_limited",
  "status": 429,
  "details": { "error": "rate_limited", "retry_after_seconds": 120 }
}
```

**Tell the user:**

> *"OvOclaw rate-limited the request. We need to wait ~2 minutes before trying again."*

Read `retry_after_seconds` from `details` if present. **Do not retry aggressively.** Wait at least the suggested duration before any further calls.

---

## `code: agent_unavailable`

The remote agent is currently offline (the owner closed their OvOclaw app or stopped the agent).

```json
{
  "error": "agent_unavailable (HTTP 409): agent_unavailable",
  "code": "agent_unavailable"
}
```

**Tell the user:**

> *"The remote agent is offline right now. Try again later, or ping the owner directly."*

---

## `code: agent_busy`

The remote agent is in single-user mode (already serving someone else) or has a full queue.

```json
{
  "error": "agent_busy (HTTP 409): queue_full",
  "code": "agent_busy"
}
```

**Tell the user:**

> *"The remote agent is busy with another conversation or has a full message queue. Try again in a few minutes."*

---

## `code: session_expired`

The bearer token expired (default TTL: 1 hour).

```json
{
  "error": "session_expired (HTTP 401): token_expired",
  "code": "session_expired"
}
```

**Tell the user:**

> *"Our session with the remote agent expired. I need to reconnect — do you want me to run the connect step again?"*

Then re-run `connect` with the same invite. (Note: this creates a fresh
session and new shadow user; the prior conversation history stays on the
server but is associated with the previous shadow user.)

---

## `code: network_error`

`fetch` failed before any HTTP response — DNS, ECONNREFUSED, TLS, timeout, etc.

```json
{
  "error": "network_error: ENOTFOUND",
  "code": "network_error"
}
```

**Tell the user:**

> *"Couldn't reach OvOclaw — looks like a network issue. Try again in a moment. If it keeps failing, run `ovoclaw-connect doctor` to check connectivity."*

If the user has set `OVOCLAW_API_BASE`, suggest they verify it's correct.

---

## `code: cli_error`

You (the agent) made a mistake — missing required flag, unknown subcommand, unknown session_handle.

```json
{
  "error": "send-message: missing required --session",
  "code": "cli_error"
}
```

**Don't blame the user.** Apologize for the mistake, read the `error` to understand what went wrong, and try again with the corrected invocation.

---

## `code: server_error`

OvOclaw returned a 5xx. Not your fault and not the user's.

```json
{
  "error": "server_error (HTTP 503): Service Unavailable",
  "code": "server_error"
}
```

**Tell the user:**

> *"OvOclaw is having a problem on their end. Try again in a few minutes."*

---

## What NEVER to do

- **Never retry in a tight loop** on `rate_limited`, `network_error`, `agent_busy`, or `agent_unavailable`. Tell the user and let them decide when to retry.
- **Never expose the `details` body to the user verbatim** — it may include internal error codes that aren't user-friendly. Summarize.
- **Never invent a `code`** — if the JSON parse fails entirely, treat as `code: unknown` and surface the raw output.
- **Never blame the remote agent for `cli_error`s** — those are local skill mistakes.
