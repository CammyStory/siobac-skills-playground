// Tiny no-dep argv parser. Handles:
//   --flag value
//   --flag=value
//   --boolean (when next token is missing or another flag)
//   positional args (any token not preceded by an unconsumed --flag)
//
// Kept deliberately small because we don't want to reintroduce a runtime
// dep. Anything more sophisticated (yargs, commander) would force every
// consumer of the skill to npm install before use.

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | true>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next
      i++
    } else {
      flags[body] = true
    }
  }

  return { positional, flags }
}

export function requireString(
  flags: Record<string, string | true>,
  key: string,
  cmd: string,
): string {
  const v = flags[key]
  if (v === undefined) throw new CliError(`${cmd}: missing required --${key}`)
  if (v === true) throw new CliError(`${cmd}: --${key} requires a value`)
  return v
}

export function optionalString(
  flags: Record<string, string | true>,
  key: string,
): string | undefined {
  const v = flags[key]
  if (v === undefined) return undefined
  if (v === true) return undefined
  return v
}

export function optionalInt(
  flags: Record<string, string | true>,
  key: string,
  cmd: string,
): number | undefined {
  const v = optionalString(flags, key)
  if (v === undefined) return undefined
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) throw new CliError(`${cmd}: --${key} must be an integer, got ${JSON.stringify(v)}`)
  return n
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}
