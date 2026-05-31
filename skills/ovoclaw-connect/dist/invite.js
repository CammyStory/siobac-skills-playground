// Accept either a raw slug or any of:
//   https://ovo.ovoclaw.com/share/<slug>
//   https://ovo.ovoclaw.com/manifest/<slug>
//   https://ovo.ovoclaw.com/connect/<slug>
//   https://ovo.ovoclaw.com/dev/share/<slug>           (dev tunnel)
//   https://api.ovoclaw.com/external/share/<slug>      (legacy /external mount)
//
// Path segments before "share" / "manifest" / "connect" are preserved as part
// of the host base, so the skill works with dev tunnels, /external legacy
// mounts, or any other reverse-proxy prefix the ovoclaw server is hosted under.
// TEST/playground build: default to the dev environment (the /dev tunnel to the
// local server) so testing never touches public production. The public release
// points at https://ovo.ovoclaw.com. A real invite link's own host/prefix always
// wins over this default; OVOCLAW_API_BASE overrides it for bare-slug input.
const DEFAULT_HOST = 'https://ovo.ovoclaw.com/dev';
const ROUTE_SEGMENTS = new Set(['share', 'manifest', 'connect']);
// Errors thrown from this module are user-input shaped. Attach a stable
// `code` so the CLI's `fail()` surfaces it as `invalid_request` to agents
// (which branch on `code`, not the English message).
function inviteError(message) {
    const err = new Error(message);
    err.code = 'invalid_request';
    return err;
}
export function parseInvite(input) {
    const trimmed = input.trim();
    if (!trimmed)
        throw inviteError('invite is empty');
    if (!trimmed.includes('/') && !trimmed.includes(':')) {
        return { slug: trimmed, host: defaultHost() };
    }
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw inviteError(`Could not parse invite: ${input}`);
    }
    // Defense in depth: reject non-http(s) schemes at the parse boundary so a
    // pasted `file:`, `javascript:`, or `data:` URL can't reach fetch().
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw inviteError(`Invite must be http(s); got "${url.protocol}" in ${input}`);
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0)
        throw inviteError(`No slug found in URL: ${input}`);
    // Find the route-marker segment ("share" / "manifest" / "connect"). Anything
    // before it is host-prefix; the segment immediately after is the slug.
    let routeIdx = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
        if (ROUTE_SEGMENTS.has(segments[i])) {
            routeIdx = i;
            break;
        }
    }
    let slug;
    let basePath;
    if (routeIdx >= 0 && routeIdx < segments.length - 1) {
        slug = segments[routeIdx + 1];
        basePath = segments.slice(0, routeIdx).join('/');
    }
    else {
        // No recognised route marker — fall back to "last segment is slug".
        slug = segments[segments.length - 1];
        basePath = segments.slice(0, -1).join('/');
    }
    if (!slug)
        throw inviteError(`No slug found in URL: ${input}`);
    const host = basePath
        ? `${url.protocol}//${url.host}/${basePath}`
        : `${url.protocol}//${url.host}`;
    return { slug, host };
}
function defaultHost() {
    return process.env.OVOCLAW_API_BASE ?? DEFAULT_HOST;
}
