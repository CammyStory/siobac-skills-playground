// Resolve an invite (raw slug or a share/manifest/connect URL) to { slug, host }.
// A bare slug uses this skill's API base (OVOCLAW_API_BASE ?? the dev tunnel);
// a full URL keeps its own host + any reverse-proxy prefix (e.g. /dev, /external)
// so reach-out works against whatever server the invite came from. Ported from
// ovoclaw-connect when the two skills merged.
import { getApiBase } from './api.js'

const ROUTE_SEGMENTS = new Set(['share', 'manifest', 'connect'])

function inviteError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = 'invalid_request'
  return err
}

export function parseInvite(input: string): { slug: string; host: string } {
  const trimmed = input.trim()
  if (!trimmed) throw inviteError('invite is empty')

  // No "/" and no ":" → a bare slug. Use our configured base.
  if (!trimmed.includes('/') && !trimmed.includes(':')) {
    return { slug: trimmed, host: getApiBase() }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw inviteError(`Could not parse invite: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw inviteError(`Invite must be http(s); got "${url.protocol}" in ${input}`)
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length === 0) throw inviteError(`No slug found in URL: ${input}`)

  // Find the route marker ("share"/"manifest"/"connect"); the segment after it
  // is the slug, anything before it is the host prefix.
  let routeIdx = -1
  for (let i = segments.length - 1; i >= 0; i--) {
    if (ROUTE_SEGMENTS.has(segments[i])) { routeIdx = i; break }
  }

  let slug: string
  let basePath: string
  if (routeIdx >= 0 && routeIdx < segments.length - 1) {
    slug = segments[routeIdx + 1]
    basePath = segments.slice(0, routeIdx).join('/')
  } else {
    slug = segments[segments.length - 1]
    basePath = segments.slice(0, -1).join('/')
  }
  if (!slug) throw inviteError(`No slug found in URL: ${input}`)

  const host = basePath ? `${url.protocol}//${url.host}/${basePath}` : `${url.protocol}//${url.host}`
  return { slug, host }
}
