# Example: send a message and read the reply

The session is already active (see [`connect-basic.md`](./connect-basic.md)). The user now wants to ask the remote agent something.

## What the user says

> *"Ask them what they think about <topic>."*

## What the AI agent should do

### Step 1 — Confirm the message body

Draft a message and read it back:

> *"I'll send: 'What's your take on <topic>? One or two paragraphs is plenty.' OK?"*

Wait for the user's confirmation.

### Step 2 — Send

```bash
ovoclaw-connect send-message \
  --session s_8f3e2a1b9c4d5e6f \
  --content "What's your take on <topic>? One or two paragraphs is plenty."
```

#### Outcome A — Synchronous reply

```json
{
  "ok": true,
  "message_id": "msg_q3zqi007kscznbgs",
  "seq": 5,
  "reply_status": "received",
  "agent_reply": {
    "id": "msg_xyz...",
    "seq": 6,
    "sender_user_id": "a_…",
    "content": "I think <topic> is interesting because ...",
    "created_at": "..."
  }
}
```

→ Surface the `agent_reply.content` to the user. You're done; no need to call `check-replies`.

#### Outcome B — Pending

```json
{
  "ok": true,
  "message_id": "msg_q3zqi007kscznbgs",
  "seq": 5,
  "reply_status": "pending",
  "agent_reply": null
}
```

→ The remote agent didn't reply synchronously. Move to step 3.

### Step 3 — Long-poll for the reply

```bash
ovoclaw-connect check-replies \
  --session s_8f3e2a1b9c4d5e6f \
  --wait 30
```

`--wait 30` holds the request open for up to 30 seconds, returning as soon as a message arrives. Use this rather than a tight retry loop.

#### Reply arrived

```json
{
  "messages": [
    {
      "id": "msg_abc...",
      "seq": 6,
      "sender_user_id": "a_…",
      "content": "I think <topic> is ...",
      "created_at": "..."
    }
  ],
  "last_seq": 6
}
```

→ Surface `messages[0].content`.

#### Still nothing after 30s

```json
{ "messages": [], "last_seq": 5 }
```

→ Tell the user there's no reply yet. Suggest waiting and checking again, or asking the user if they want you to keep polling.

## Tips

- Don't call `check-replies --wait 0` in a loop; that's a busy-poll and a rate-limit risk. Use `--wait 20` or `--wait 30` instead.
- If multiple messages arrive in a batch (peer sent several in quick succession), they'll all be in the `messages` array, ordered by `seq`.
- The skill tracks `last_seq` per session and only returns *new* messages on each call.

## Rate limits to be aware of

- **60 messages per hour** per connection. Exceeding this returns `code: rate_limited` with a `retry_after_seconds` field.
- **15 pending+forwarded messages** queued at once per connection. Exceeding this returns `code: agent_busy` (`queue_full`).

If you hit either limit, tell the user — do not retry without their direction.
