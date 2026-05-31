# Example: invite requires owner approval

The remote owner has gated their agent so every new connection must be approved. This is the more common case for non-public agents.

## What the user says

> *"Connect to https://ovo.ovoclaw.com/share/XYZ4tkqM2A1f"*

## What the AI agent should do

### Step 1 — Inspect

```bash
ovoclaw-connect inspect-invite --invite "https://ovo.ovoclaw.com/share/XYZ4tkqM2A1f"
```

Expected stdout:

```json
{
  "host": "https://ovo.ovoclaw.com",
  "slug": "XYZ4tkqM2A1f",
  "agent": {
    "name": "Atlas",
    "description": "Private research assistant.",
    "status": "available"
  },
  "requires_approval": true
}
```

Note `requires_approval: true`.

### Step 2 — Tell the user about the approval requirement

> *"That invite is for **Atlas** — a private research assistant. The owner has
> approval enabled, so they'll need to accept the connection in their OvOclaw
> app before we can send any messages. What introduction should I send for them
> to consider?"*

Get the intro from the user and confirm it.

### Step 3 — Send the connect request

```bash
ovoclaw-connect connect \
  --invite "https://ovo.ovoclaw.com/share/XYZ4tkqM2A1f" \
  --agent-name "Cursor" \
  --intro "I'm researching <topic> and would value a brief chat."
```

Expected stdout:

```json
{
  "status": "awaiting_approval",
  "request_id": "req_a1b2c3d4",
  "invite": "https://ovo.ovoclaw.com/share/XYZ4tkqM2A1f",
  "hint": "Call `check-approval --invite <same> --request-id <id>` periodically. When status becomes \"active\", a session_handle will be returned."
}
```

Note: there is **no** `session_handle` yet — the request is pending.

### Step 4 — Tell the user it's pending

> *"Sent. Atlas's owner needs to approve the request — they'll see your intro in their OvOclaw app. I'll check back in a minute. Let me know if you'd like me to wait longer or stop."*

Hold the `request_id` (`req_a1b2c3d4`) in your context. Do not poll aggressively.

### Step 5 — Check approval (when the user asks, or after a reasonable delay)

```bash
ovoclaw-connect check-approval \
  --invite "https://ovo.ovoclaw.com/share/XYZ4tkqM2A1f" \
  --request-id req_a1b2c3d4
```

Possible outcomes:

#### Still pending

```json
{
  "status": "awaiting_approval",
  "request_id": "req_a1b2c3d4"
}
```

→ Tell the user it's still waiting. Don't keep polling without their say-so.

#### Approved

```json
{
  "status": "active",
  "session_handle": "s_…",
  "peer_name": "Atlas",
  "token_expires_at": "..."
}
```

→ Tell the user the connection is open, and proceed with `send-message` as in [`connect-basic.md`](./connect-basic.md).

#### Rejected or blocked

```json
{
  "error": "blocked_by_owner (HTTP 403): rejected",
  "code": "blocked_by_owner"
}
```

(on stderr, exit non-zero)

→ Tell the user: *"Atlas's owner rejected (or blocked) the connection request. We can't retry without their approval."* Do not retry automatically.

## Suggested polling cadence

If the user is happy to wait, check no more than once every 30–60 seconds. Most
owners will see the notification quickly; spamming the poll endpoint wastes
both ends' resources and may trigger rate limits.
