# ovoclaw — errors & output contract

## Output contract

- Every **success** → **one JSON object on stdout**, exit 0. Parse it before
  reasoning; act on internal fields (`note`, `next_step`, `hint`) but don't echo
  them to the owner (see the table standard in `references/guide.md`).
- Every **failure** → **one JSON object on stderr**, exit non-zero, always with
  `error` + `code`. **Branch on `code`, never on the English message.**
- `login` is the only multi-line command (it prints two JSON lines — see Step 0 in
  `references/guide.md`).
- **Don't retry** on `rate_limited`, `access_denied`, `forbidden`,
  `not_implemented_yet`, or `server_not_ready`.

## Error codes

| code | Meaning | What to do |
| --- | --- | --- |
| `not_authenticated` | No auth.json present | Run `login` (or surface to user) |
| `session_expired` | Token expired or revoked | Run `login` |
| `authorization_pending` | Device flow: user hasn't approved yet | `login` handles this internally |
| `slow_down` | Device flow: polling too fast | `login` handles this internally |
| `access_denied` | Device flow: user denied | Stop; user must initiate again |
| `expired_token` | Device flow: user_code expired | Run `login` again |
| `server_not_ready` | Server has no device-flow endpoints | Check `OVOCLAW_API_BASE` |
| `forbidden` | Token lacks scope, or not the owner | Tell user; cannot retry |
| `not_found` | Agent / connection / invite gone | Tell user |
| `rate_limited` | Too many requests | Wait; don't retry aggressively |
| `network_error` | fetch failed | Retry later; check `OVOCLAW_API_BASE` |
| `server_error` | OvOclaw returned 5xx | Retry later |
| `not_implemented_yet` | Skill-side command not built | Shouldn't occur (all wired); treat as a bug |
| `cli_error` | Local CLI input error | Read `error`; fix and retry |
| `unknown` | Catch-all | Treat as `server_error` |

## `skill_update` — tell the user to update

Any output may include a `skill_update` block when the server reports a newer
version:

```json
"skill_update": { "current": "0.9.0", "latest": "0.9.27", "required": false,
                  "update_url": "https://github.com/CammyStory/ovoclaw-skills-playground",
                  "message": "..." }
```

After handling the owner's request, **briefly** mention it: `required: false` →
soft heads-up (update from `update_url` when convenient); `required: true` →
recommend updating before relying on it. Once per session is enough.
