// Skill identity. Bump SKILL_VERSION on every published build — the server
// compares it (sent as X-Ovoclaw-Connect-Version) against the latest it knows
// and the skill surfaces an update notice when this is behind. Keep in sync
// with package.json's "version".
export const SKILL_NAME = 'ovoclaw-connect'
export const SKILL_VERSION = '0.9.2'
