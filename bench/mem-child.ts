// Run by bench.ts in a fresh process: parses one replay and prints how much the parse raised the peak RSS.
// usage: node bench/mem-child.ts <file.rrf> [no-names]
import { readFileSync } from 'node:fs';
import { parseReplay } from '../src/index.ts';

const buf = readFileSync(process.argv[2]);
const before = process.resourceUsage().maxRSS;
const replay = parseReplay(buf, { names: process.argv[3] !== 'no-names' });
const after = process.resourceUsage().maxRSS;
process.stdout.write(JSON.stringify({ peakRssKB: after - before, totalPeakRssKB: after, players: replay.players.size }));
