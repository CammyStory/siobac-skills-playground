// Tiny no-dep argv parser. Handles:
//   --flag value
//   --flag=value
//   --boolean (when next token is missing or another flag)
//   positional args (any token not preceded by an unconsumed --flag)
//
// Kept deliberately small because we don't want to reintroduce a runtime
// dep. Anything more sophisticated (yargs, commander) would force every
// consumer of the skill to npm install before use.
export function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const body = arg.slice(2);
        const eq = body.indexOf('=');
        if (eq >= 0) {
            flags[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[body] = next;
            i++;
        }
        else {
            flags[body] = true;
        }
    }
    return { positional, flags };
}
export function requireString(flags, key, cmd) {
    const v = flags[key];
    if (v === undefined)
        throw new CliError(`${cmd}: missing required --${key}`);
    if (v === true)
        throw new CliError(`${cmd}: --${key} requires a value`);
    return v;
}
export function optionalString(flags, key) {
    const v = flags[key];
    if (v === undefined)
        return undefined;
    if (v === true)
        return undefined;
    return v;
}
export function optionalInt(flags, key, cmd) {
    const v = optionalString(flags, key);
    if (v === undefined)
        return undefined;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n))
        throw new CliError(`${cmd}: --${key} must be an integer, got ${JSON.stringify(v)}`);
    return n;
}
export class CliError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CliError';
    }
}
