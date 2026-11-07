// Downloads replays into bench/replays/. Only matches with a replay are fetched.
// usage: node bench/download.ts [count]                 recent ranked matches (default 100)
//        node bench/download.ts --user <name> [count]   that player's matches (default all)
// The replay host rate-limits, so files are fetched one at a time and 429s wait for Retry-After.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const RANKED = 2;
const args = process.argv.slice(2);
const userAt = args.indexOf('--user');
const user = userAt >= 0 ? args.splice(userAt, 2)[1] : null;
if (userAt >= 0 && !user) throw new Error('--user needs a nickname or UUID');
const count = Number(args[0] ?? (user ? Infinity : 100));
const dir = new URL('./replays/', import.meta.url);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Match { id: number; type: number; replayExists: number }
const listUrl = user
  ? `https://api.mcsrranked.com/users/${encodeURIComponent(user)}/matches?count=100`
  : `https://api.mcsrranked.com/matches?count=100&type=${RANKED}`;
const ids: number[] = [];
for (let before: number | undefined; ids.length < count;) {
  const res = await fetch(listUrl + (before ? `&before=${before}` : ''));
  if (!res.ok) throw new Error(`match list: HTTP ${res.status}`);
  const page = ((await res.json()) as { data: Match[] }).data;
  for (const m of page) if (m.replayExists === 1 && (user || m.type === RANKED) && ids.length < count) ids.push(m.id);
  if (page.length < 100) break;
  before = page[page.length - 1].id;
}

let ok = 0, skipped = 0;
const failed: string[] = [];
for (const [i, id] of ids.entries()) {
  const file = new URL(`${id}.rrf`, dir);
  if (existsSync(file)) { skipped++; continue; }
  for (let attempt = 1; ; attempt++) {
    let r: Response, body: ArrayBuffer;
    try {
      r = await fetch(`https://replay.mcsrranked.com/matches/${id}.rrf`);
      body = await r.arrayBuffer();
    } catch (e) {
      if (attempt >= 5) { failed.push(`${id} (${(e as Error).message})`); break; }
      console.log(`[${i + 1}/${ids.length}] ${(e as Error).message}; retrying in ${10 * attempt}s`);
      await sleep(10_000 * attempt);
      continue;
    }
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after') ?? 60) + 1;
      console.log(`[${i + 1}/${ids.length}] rate limited; waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) { failed.push(`${id} (HTTP ${r.status})`); break; }
    writeFileSync(file, Buffer.from(body));
    ok++;
    console.log(`[${i + 1}/${ids.length}] ${id}.rrf`);
    break;
  }
  await sleep(250);
}
console.log(`${ids.length} matches: ${ok} downloaded, ${skipped} already present, ${failed.length} failed`);
if (failed.length) console.log(`failed: ${failed.join(', ')}`);
