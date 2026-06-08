// Shared runtime — the output contract, consent gate, auth helpers, and the
// share-URL / verify helpers used across the command modules. Imports nothing
// from command modules or cli.ts, so it can be imported anywhere (no cycle).
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CliError } from './argparse.js'
import * as api from './api.js'
import { loadAuth, saveAuth, type AuthState } from './state.js'

// ── Output contract ────────────────────────────────────────────────────
// Exactly one JSON object on stdout for success / on stderr for failure.
// Same shape as ovoclaw-connect — agents already trained on that contract
// can branch on `code` here without learning a new convention.

// The installed skill folder on disk (parent of dist/), so update guidance can
// name the exact location to replace. .../skills/siobac/dist/cli.js → .../skills/siobac
export function skillDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

// A concrete, copy-pasteable update instruction. The skill is a folder the
// platform points at (git clone OR a copied/rsync'd dir), so we can't reliably
// `git pull` in place — instead spell out: get the latest from the RIGHT repo,
// then replace/re-point this exact folder. dist/ is prebuilt (no build step).
export function updateInstruction(repoUrl: string | null): string {
  const repo = repoUrl || 'https://github.com/CammyStory/siobac-skills-playground'
  return [
    `To update: pull the latest from ${repo} (the skill is its \`skills/siobac/\` folder; \`dist/\` is prebuilt, no build step),`,
    `then replace this installed copy at ${skillDir()} with that folder (or re-point this platform at it) and re-run.`,
    `If you cloned the repo, \`git -C <your clone> pull\` then re-sync that folder here.`,
  ].join(' ')
}

// Enrich a raw server update notice with the on-disk path + the how-to.
export function enrichNotice(upd: api.SkillUpdateNotice): api.SkillUpdateNotice {
  return { ...upd, skill_path: skillDir(), how_to_update: updateInstruction(upd.update_url) }
}

// Attach a `skill_update` block when this run heard about a newer skill from
// the server. SKILL.md tells the agent to relay it to the user.
export function withUpdateNotice<T extends object>(body: T): T & { skill_update?: api.SkillUpdateNotice } {
  const upd = api.getSkillUpdateNotice()
  return upd ? { ...body, skill_update: enrichNotice(upd) } : body
}

export function ok(value: unknown): never {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? withUpdateNotice(value as object)
      : value
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  process.exit(0)
}

export function fail(err: unknown, exitCode = 1): never {
  let body: Record<string, unknown>
  if (err instanceof CliError) {
    body = { error: err.message, code: 'cli_error' }
  } else if (err instanceof Error) {
    const apiErr = err as api.ApiError
    body = { error: err.message, code: apiErr.code ?? 'unknown' }
    if (typeof apiErr.status === 'number') body.status = apiErr.status
    if (apiErr.body !== undefined) body.details = apiErr.body
  } else {
    body = { error: String(err), code: 'unknown' }
  }
  process.stderr.write(JSON.stringify(withUpdateNotice(body), null, 2) + '\n')
  process.exit(exitCode)
}

// ── Consent gate (outward-facing actions) ─────────────────────────────
// Publishing the agent (`share-self`), messaging out (`send`), and admitting
// someone (`approve`) are outward-facing — they need the owner's explicit OK.
// Consent is made STRUCTURAL here: the command refuses to act unless `--confirmed`
// is passed, so "the agent should confirm first" becomes "the command will not
// fire without it" — the same notify→confirm→execute guardrail, enforced in the
// CLI so it holds on ANY platform (not via Claude-Code-only hooks).
export function isConfirmed(flags: Record<string, string | true>): boolean {
  const v = flags['confirmed']
  return v === true || v === 'true' || v === '' || v === 'yes'
}

// First call (no --confirmed): return a needs_confirmation object — exit 0 (NOT an
// error, so the agent doesn't treat it as a failure), previewing exactly what will
// happen, and telling the agent to get the owner's yes then re-run with --confirmed.
export function needsConfirmation(
  action: string,
  preview: Record<string, unknown>,
  tellOwner: string,
  rerun: string,
): never {
  ok({
    status: 'needs_confirmation',
    action,
    ...preview,
    next_step:
      `This is an outward-facing action — it does NOT run yet. Show the owner what it will do, ` +
      `get a clear yes, then re-run the SAME command with \`--confirmed\` added: ${rerun}. ` +
      `If the owner wants changes, adjust and ask again. Do not pass --confirmed on your own.`,
    tell_owner: tellOwner,
  })
}

// Refresh once the access token has less than this much life left, so a
// command never starts with a token about to expire mid-request.
export const TOKEN_REFRESH_SKEW_MS = 60_000

export async function requireAuth(): Promise<AuthState> {
  const auth = await loadAuth()
  if (!auth) {
    throw api.makeApiError(
      'not_authenticated',
      'no auth.json found. Run `login` first to authenticate via device flow.',
    )
  }
  // Token still has comfortable life left — use it as-is.
  if (new Date(auth.expiresAt).getTime() - Date.now() > TOKEN_REFRESH_SKEW_MS) {
    return auth
  }
  // Access token expired (or about to). Before forcing a full device-flow
  // re-login, try to swap the stored refresh token (valid ~30 days, rotated
  // each use) for a fresh access token — silent, no browser. Only when the
  // refresh token itself is missing/expired/revoked do we ask for a re-login.
  if (!auth.refreshToken) {
    throw api.makeApiError(
      'session_expired',
      'access token expired and no refresh token is stored. Run `login` to re-authenticate.',
    )
  }
  let token: api.DeviceTokenResponse
  try {
    token = await api.refreshAccessToken(auth.refreshToken)
  } catch (e) {
    const code = (e as api.ApiError).code
    // 401 (invalid_grant) → the refresh token is expired/revoked: the 30-day
    // window lapsed, the user logged out elsewhere, or a rotated token leaked.
    // A fresh login is the only way forward. network_error / server_error /
    // server_not_ready propagate unchanged so the caller can retry.
    if (code === 'session_expired') {
      throw api.makeApiError(
        'session_expired',
        'refresh token expired or revoked (idle 30+ days, logged out, or revoked). Run `login` to re-authenticate.',
      )
    }
    throw e
  }
  // Persist the rotated pair so the next command keeps the chain alive. The
  // server preserves the agent binding across refreshes; keep it (and the
  // original login time) if the response omits anything.
  const refreshed: AuthState = {
    accessToken: token.access_token,
    tokenType: token.token_type,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    refreshToken: token.refresh_token ?? auth.refreshToken,
    scope: token.scope ?? auth.scope,
    ovoclawAccountId: token.account_id ?? auth.ovoclawAccountId,
    agentId: token.agent_id ?? auth.agentId,
    loggedInAt: auth.loggedInAt,
  }
  await saveAuth(refreshed)
  return refreshed
}

// Every owner-side command acts as the ONE agent this login is bound to. The
// agent_id is baked into the access token at login (the approval page's agent
// picker), so the skill never takes an --agent-id — it can't act as any other
// agent, and the server enforces that too. A token from before agent-scoping
// (no agentId) is treated as stale → re-login.
export async function requireBoundAgent(): Promise<{ auth: AuthState; agentId: string }> {
  const auth = await requireAuth()
  if (!auth.agentId) {
    throw api.makeApiError(
      'not_authenticated',
      'this login is not bound to an agent (old token). Run `login` again and pick the agent to authorize.',
    )
  }
  return { auth, agentId: auth.agentId }
}

export function shareUrlFor(slug: string): string {
  // The legacy /external/share/:slug landing page is served on the same host
  // the owner API lives on, so this resolves without needing the protocol
  // subdomain. The server's list-shares builds the same shape host-aware.
  return `${api.getApiBase()}/external/share/${encodeURIComponent(slug)}`
}

// A scannable PNG QR of the share landing URL — surface this so the agent can
// SHOW a QR (not just a link) to its owner after sharing.
export function qrUrlFor(slug: string): string {
  return `${shareUrlFor(slug)}/qr.png`
}

// A ready-to-render inline image embed for the QR. On image-capable platforms
// the agent drops this straight into its reply so the user sees a scannable QR
// image, not a bare URL. SKILL.md tells the agent to prefer this over the link.
export function qrMarkdownFor(slug: string): string {
  return `![Scan to reach me on Siobac](${qrUrlFor(slug)})`
}

// VERIFY a share by round-tripping its slug through the PUBLIC manifest endpoint
// — exactly the request a connecting friend's client makes (parseInvite maps a
// bare slug to getApiBase()). This proves the link the owner is about to hand out
// actually RESOLVES to a live agent, instead of trusting that "create returned
// 200" means "the QR works." `resolves` = the manifest loaded and named a live
// agent. `points_back` = when we know the expected NAME, the manifest's agent
// matches it. NOTE: the public manifest deliberately does NOT expose the internal
// agent id, so we verify by name (the human-facing identity it DOES return); with
// no expected name, "resolves to a live agent" is the available signal — the slug
// is already server-bound to this agent (it came from an authenticated call).
// Best-effort: never throws, so a caller can attach the verdict safely.
export async function verifyShareResolves(
  slug: string,
  expectedName?: string,
): Promise<{ resolves: boolean; points_back: boolean; reason?: string }> {
  try {
    const m = await api.getManifest(api.getApiBase(), slug)
    const agent = (m.agent ?? {}) as { id?: string; name?: string; status?: string }
    if (!agent.name && !agent.id) {
      return { resolves: false, points_back: false, reason: 'manifest returned no agent' }
    }
    const points_back = expectedName ? agent.name === expectedName : true
    return {
      resolves: true,
      points_back,
      reason: expectedName && !points_back ? `the link resolves to "${agent.name}", not "${expectedName}"` : undefined,
    }
  } catch (e) {
    const code = (e as api.ApiError).code
    return { resolves: false, points_back: false, reason: code ?? (e as Error).message }
  }
}
