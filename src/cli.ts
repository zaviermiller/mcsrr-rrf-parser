// Command-line interface: mcsrr-rrf <file.rrf> [-o out.json] [--summary] [--player <uuid|nickname>] [--types A,B] [--no-names]
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import * as api from './index.ts';
import { writeJson, JsonSink } from './output.ts';

export const USAGE = `usage: mcsrr-rrf <file.rrf> [options]

  -o, --output <file>       write to a file instead of stdout
      --summary             print a per-player summary instead of JSON
      --player <name|uuid>  only output this player
      --types <A,B,...>     only output these record types (e.g. PLAYER_POSITION,BLOCK_UPDATE)
      --no-names            omit the readable "names" field on records
  -h, --help                show this help
  -v, --version             show the parser, mod and Minecraft versions

exit codes: 0 ok, 1 fatal error, 2 usage error, 3 parsed with chunk decode errors
`;

export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

/** Runs the CLI and returns the exit code. JSON output without -o goes straight to fd 1. */
export function main(argv: string[] = process.argv.slice(2), io: CliIo = { stdout: process.stdout, stderr: process.stderr }): number {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        summary: { type: 'boolean', default: false },
        player: { type: 'string' },
        types: { type: 'string' },
        'no-names': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.version) {
    // ../package.json from both src/cli.ts and dist/cli.js.
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    io.stdout.write(`${pkg.name} ${pkg.version} (MCSR Ranked ${api.MOD_VERSION}, Minecraft ${api.MINECRAFT_VERSION})\n`);
    return 0;
  }
  if (values.help || positionals.length !== 1) {
    (values.help ? io.stdout : io.stderr).write(USAGE);
    return values.help ? 0 : 2;
  }
  let types: string[] | undefined;
  if (values.types) {
    const known = new Set<string>([...api.RECORD_TYPES, ...api.LEGACY_RECORD_TYPES].map((t) => t.name));
    types = values.types.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    for (const t of types) if (!known.has(t)) io.stderr.write(`warning: unknown type in --types: ${t}\n`);
    types = types.filter((t) => known.has(t));
  }
  let rep: api.Replay;
  try {
    rep = api.parseReplay(positionals[0]!, { types, names: !values['no-names'] });
  } catch (e) {
    io.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
  try {
    if (values.summary) {
      const text = api.formatSummary(rep, { player: values.player });
      if (values.output) fs.writeFileSync(values.output, text);
      else io.stdout.write(text);
    } else if (values.output) {
      api.writeJSON(rep, values.output, { player: values.player });
    } else {
      writeJson(rep, new JsonSink(1), values.player);
    }
  } catch (e) {
    io.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
  return rep.errors.length > 0 ? 3 : 0;
}
