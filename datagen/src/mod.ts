// Usage: node src/mod.ts <mcsrranked-x.y.z.jar> [--out <file>] [--check]
// Reads the replay tables from a mod jar and writes data/mcsrranked.json (or with --check, only
// reports whether it is up to date). Exit codes: 0 written / up to date, 1 out of date (--check),
// 2 usage or read error.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { diffModData, extractModData, formatJson } from './extract-mod.ts';
import type { ModData } from './extract-mod.ts';

const DEFAULT_OUT = path.join(import.meta.dirname, '..', '..', 'data', 'mcsrranked.json');

function main(): number {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, check: { type: 'boolean' } } });
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const [jar] = args.positionals;
  if (!jar || args.positionals.length > 1) {
    console.error('usage: node src/mod.ts <mcsrranked-x.y.z.jar> [--out <file>] [--check]');
    return 2;
  }
  const out = path.resolve(args.values.out ?? DEFAULT_OUT);

  let data: ModData;
  try {
    data = extractModData(jar);
  } catch (e) {
    console.error(`${jar}: ${(e as Error).message}`);
    return 2;
  }
  const text = formatJson(data);
  const existing = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (existing === text) {
    console.log(`${path.relative(process.cwd(), out)} is up to date (mod ${data.modVersion})`);
    return 0;
  }

  let diffs: string[];
  try {
    diffs = existing ? diffModData(JSON.parse(existing) as ModData, data) : ['(new file)'];
  } catch {
    diffs = ['(existing file is not valid JSON)'];
  }
  if (!diffs.length) diffs = ['(formatting only)'];
  console.log(`${path.relative(process.cwd(), out)} vs ${path.basename(jar)} (mod ${data.modVersion}):`);
  for (const d of diffs) console.log(`  ${d}`);
  if (args.values.check) return 1;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}`);
  console.log('next: update src/types.ts / src/decoders.ts for any new or changed types, then run npm test in the parser');
  return 0;
}

process.exitCode = main();
