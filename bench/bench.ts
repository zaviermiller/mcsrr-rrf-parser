// Times parseReplay() and measures its memory on every replay in a folder, against the file size.
// usage: node bench/bench.ts [runs=5] [--dir bench/replays] [--limit N] [--jobs N]
// Writes bench/results.csv, bench/parse-time.svg and bench/memory.svg.
// --jobs runs the memory measurements in N worker processes. Parse times are always measured afterwards, one file at
// a time, because concurrent parses slow each other down (about 25% with 4 workers).
//
// Memory per replay:
// - retained: heap + ArrayBuffer bytes still held by the returned Replay (measured after a forced GC).
// - peak RSS: how much one parse raised the process's peak RSS, measured in a fresh child process
//   (bench/mem-child.ts) so earlier files don't hide it. This includes garbage created during the parse.
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { parseReplay, toJSON } from '../src/index.ts';
import { readZip } from '../src/container.ts';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: 'string' }, limit: { type: 'string' }, jobs: { type: 'string' }, shard: { type: 'string' } },
});
const jobs = Math.max(1, Number(args.jobs ?? 1));
// Set on worker processes spawned by --jobs: measure every jobs-th file starting at this index.
const shard = args.shard === undefined ? null : Number(args.shard);
const runs = Number(positionals[0] ?? 5);
const dir = args.dir ? resolve(args.dir) : fileURLToPath(new URL('./replays/', import.meta.url));
const limit = args.limit ? Number(args.limit) : Infinity;
const files = readdirSync(dir).filter((f) => f.endsWith('.rrf')).sort().slice(0, limit);
if (!files.length) throw new Error(`no replays in ${dir}; run bench/download.ts first or pass --dir`);
const childScript = fileURLToPath(new URL('./mem-child.ts', import.meta.url));

// Expose gc() without requiring --expose-gc on the command line.
const gc: () => void = (globalThis as { gc?: () => void }).gc
  ?? (setFlagsFromString('--expose-gc'), runInNewContext('gc') as () => void);

interface Row {
  file: string; rrfBytes: number; rpdBytes: number; records: number; jsonBytes: number; ms: number; msNoNames: number;
  retainedMB: number; retainedMBNoNames: number; peakRssMB: number;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs: number[], p: number) => [...xs].sort((u, v) => u - v)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}
const heapBytes = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
let sink: unknown;
/** Bytes still reachable from the parsed Replay after a full GC. */
function retainedMB(buf: Buffer, names: boolean): number {
  sink = undefined;
  gc(); gc();
  const before = heapBytes();
  const replay = parseReplay(buf, { names });
  gc(); gc();
  const after = heapBytes();
  sink = replay;
  return (after - before) / 1e6;
}
function peakRssMB(path: string): number {
  const out = execFileSync(process.execPath, [childScript, path], { encoding: 'utf8' });
  return JSON.parse(out).peakRssKB / 1024;
}
/** Least-squares fit y = a + b·x. */
function fit(xs: number[], ys: number[]) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
  return { a: my - b * mx, b };
}

/** Median parse times for one file, with and without names. */
function timeFile(buf: Buffer): { ms: number; msNoNames: number } {
  return {
    ms: median(Array.from({ length: runs }, () => time(() => parseReplay(buf)))),
    msNoNames: median(Array.from({ length: runs }, () => time(() => parseReplay(buf, { names: false })))),
  };
}

/** Sizes and memory for one file, plus parse times unless `timed` is false (filled in later by the parent). */
function measure(file: string, label: string, timed = true): Row | null {
  const path = join(dir, file);
  const buf = readFileSync(path);
  const rpd = readZip(buf).get('replay.rpd');
  if (!rpd) { console.error(`${file}: no replay.rpd, skipped`); return null; }
  let rep;
  try { rep = parseReplay(buf); } catch (e) { console.error(`${file}: ${(e as Error).message}, skipped`); return null; }
  let records = 0;
  for (const p of rep.players.values()) records += p.records.length;
  const jsonBytes = Buffer.byteLength(toJSON(rep));
  rep = undefined;
  const { ms, msNoNames } = timed ? timeFile(buf) : { ms: NaN, msNoNames: NaN };
  const row: Row = {
    file, rrfBytes: buf.length, rpdBytes: rpd().length, records, jsonBytes, ms, msNoNames,
    retainedMB: retainedMB(buf, true), retainedMBNoNames: retainedMB(buf, false), peakRssMB: peakRssMB(path),
  };
  console.error(`${label} ${file.padEnd(14)} rrf ${(row.rrfBytes / 1e6).toFixed(2).padStart(5)} MB  ` +
    `rpd ${(row.rpdBytes / 1e6).toFixed(2).padStart(6)} MB  ${timed ? `${ms.toFixed(1).padStart(6)} ms  ` : ''}` +
    `retained ${row.retainedMB.toFixed(1).padStart(6)} MB  peak +${row.peakRssMB.toFixed(0).padStart(4)} MB  ${records} records`);
  return row;
}

function warmUp() {
  // Warm up the JIT so the first file isn't penalised.
  const warm = readFileSync(join(dir, files[0]));
  for (let i = 0; i < 3; i++) parseReplay(warm);
}

if (shard !== null) {
  warmUp();
  const mine = files.filter((_, i) => i % jobs === shard);
  for (const [i, file] of mine.entries()) {
    const row = measure(file, `[w${shard} ${i + 1}/${mine.length}]`, false);
    if (row) process.stdout.write(JSON.stringify(row) + '\n');
  }
  process.exit(0);
}

function runWorker(k: number): Promise<Row[]> {
  const argv = [fileURLToPath(import.meta.url), String(runs), '--dir', dir, '--jobs', String(jobs), '--shard', String(k)];
  if (args.limit) argv.push('--limit', args.limit);
  return new Promise((resolveRows, reject) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0
      ? resolveRows(out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row))
      : reject(new Error(`bench worker ${k} exited with ${code}`)));
  });
}

const started = performance.now();
let rows: Row[] = [];
if (jobs > 1) {
  rows = (await Promise.all(Array.from({ length: jobs }, (_, k) => runWorker(k)))).flat();
  rows.sort((a, b) => a.file.localeCompare(b.file));
  warmUp();
  for (const [i, row] of rows.entries()) {
    Object.assign(row, timeFile(readFileSync(join(dir, row.file))));
    console.error(`[time ${i + 1}/${rows.length}] ${row.file.padEnd(14)} ${row.ms.toFixed(1).padStart(6)} ms`);
  }
} else {
  warmUp();
  for (const [i, file] of files.entries()) {
    const row = measure(file, `[${i + 1}/${files.length}]`);
    if (row) rows.push(row);
  }
}
sink = undefined;

const outDir = new URL('./', import.meta.url);
writeFileSync(new URL('results.csv', outDir),
  'file,rrf_bytes,rpd_bytes,records,json_bytes,parse_ms,parse_ms_no_names,retained_mb,retained_mb_no_names,peak_rss_mb\n' +
  rows.map((r) => [r.file, r.rrfBytes, r.rpdBytes, r.records, r.jsonBytes, r.ms.toFixed(2), r.msNoNames.toFixed(2),
    r.retainedMB.toFixed(2), r.retainedMBNoNames.toFixed(2), r.peakRssMB.toFixed(2)].join(',')).join('\n') + '\n');

const n = rows.length;
const rpdMB = rows.map((r) => r.rpdBytes / 1e6), rrfMB = rows.map((r) => r.rrfBytes / 1e6);
const ys = rows.map((r) => r.ms), ret = rows.map((r) => r.retainedMB), peak = rows.map((r) => r.peakRssMB);
const timeFit = fit(rpdMB, ys), retFit = fit(rrfMB, ret), peakFit = fit(rrfMB, peak);
const totalS = ys.reduce((s, y) => s + y, 0) / 1000;
const stats = {
  replays: n,
  medianRrfMB: median(rrfMB), medianRpdMB: median(rpdMB),
  medianMs: median(ys), p95Ms: pct(ys, 0.95), maxMs: Math.max(...ys),
  medianMsNoNames: median(rows.map((r) => r.msNoNames)),
  rpdMBPerSecond: rpdMB.reduce((s, x) => s + x, 0) / totalS,
  timeFit: `ms ≈ ${timeFit.a.toFixed(1)} + ${timeFit.b.toFixed(1)} × rpd MB`,
  medianRetainedMB: median(ret), p95RetainedMB: pct(ret, 0.95), maxRetainedMB: Math.max(...ret),
  medianRetainedMBNoNames: median(rows.map((r) => r.retainedMBNoNames)),
  medianRetainedPerRrfMB: median(rows.map((r) => r.retainedMB / (r.rrfBytes / 1e6))),
  retainedFit: `MB ≈ ${retFit.a.toFixed(1)} + ${retFit.b.toFixed(1)} × rrf MB`,
  medianPeakRssMB: median(peak), p95PeakRssMB: pct(peak, 0.95), maxPeakRssMB: Math.max(...peak),
  peakRssFit: `MB ≈ ${peakFit.a.toFixed(1)} + ${peakFit.b.toFixed(1)} × rrf MB`,
  medianJsonToRrf: median(rows.map((r) => r.jsonBytes / r.rrfBytes)),
  benchSeconds: Math.round((performance.now() - started) / 1000),
};
console.log(stats);

// ---------------------------------------------------------------- SVG scatter plots
interface Series { label: string; color: string; r: number; points: { x: number; y: number; title: string }[] }
function scatter(o: { title: string; subtitle: string; xLabel: string; yLabel: string; series: Series[]; fit: { a: number; b: number; label: string } }): string {
  const W = 900, H = 560, L = 80, R = 30, T = 70, B = 70;
  const niceMax = (v: number) => { const p = 10 ** Math.floor(Math.log10(v || 1)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!; };
  const all = o.series.flatMap((s) => s.points);
  const xMax = niceMax(Math.max(...all.map((p) => p.x)) * 1.05), yMax = niceMax(Math.max(...all.map((p) => p.y)) * 1.05);
  const sx = (x: number) => L + (x / xMax) * (W - L - R), sy = (y: number) => H - B - (y / yMax) * (H - T - B);
  const ticks = (max: number) => Array.from({ length: 6 }, (_, i) => (max / 5) * i);
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const legendH = 18 * (o.series.length + 1) + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#fff"/>
<text x="${W / 2}" y="28" text-anchor="middle" font-size="17" font-weight="600">${o.title}</text>
<text x="${W / 2}" y="48" text-anchor="middle" fill="#555">${o.subtitle}</text>
${ticks(xMax).map((t) => `<line x1="${sx(t)}" x2="${sx(t)}" y1="${T}" y2="${H - B}" stroke="#eee"/><text x="${sx(t)}" y="${H - B + 18}" text-anchor="middle">${fmt(t)}</text>`).join('\n')}
${ticks(yMax).map((t) => `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}" stroke="#eee"/><text x="${L - 8}" y="${sy(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('\n')}
<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#333"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#333"/>
<text x="${(L + W - R) / 2}" y="${H - 22}" text-anchor="middle" font-size="13">${o.xLabel}</text>
<text transform="translate(22 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" font-size="13">${o.yLabel}</text>
<line x1="${sx(0)}" y1="${sy(Math.max(0, o.fit.a))}" x2="${sx(xMax)}" y2="${sy(Math.min(yMax, o.fit.a + o.fit.b * xMax))}" stroke="#d62728" stroke-dasharray="6 4"/>
${o.series.map((s) => s.points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${s.r}" fill="${s.color}" fill-opacity="0.6"><title>${p.title}</title></circle>`).join('\n')).join('\n')}
<g transform="translate(${L + 16} ${T + 12})"><rect width="240" height="${legendH}" fill="#fff" stroke="#ccc"/>
${o.series.map((s, i) => `<circle cx="14" cy="${16 + 18 * i}" r="4" fill="${s.color}"/><text x="26" y="${20 + 18 * i}">${s.label}</text>`).join('\n')}
<line x1="6" x2="22" y1="${16 + 18 * o.series.length}" y2="${16 + 18 * o.series.length}" stroke="#d62728" stroke-dasharray="6 4"/><text x="26" y="${20 + 18 * o.series.length}">${o.fit.label}</text></g>
</svg>
`;
}

writeFileSync(new URL('parse-time.svg', outDir), scatter({
  title: 'mcsrr-rrf-parser: parse time vs replay.rpd size',
  subtitle: `${n} replays · median ${stats.medianMs.toFixed(0)} ms · p95 ${stats.p95Ms.toFixed(0)} ms · max ${stats.maxMs.toFixed(0)} ms · ${stats.rpdMBPerSecond.toFixed(1)} MB/s · ${stats.timeFit} · Node ${process.version}`,
  xLabel: 'replay.rpd size (MB)',
  yLabel: `parseReplay() time (ms, median of ${runs})`,
  series: [
    { label: 'names: false', color: '#ff7f0e', r: 3.5, points: rows.map((r) => ({ x: r.rpdBytes / 1e6, y: r.msNoNames, title: `${r.file}: ${r.msNoNames.toFixed(1)} ms (names: false)` })) },
    { label: 'default (with names)', color: '#1f77b4', r: 4, points: rows.map((r) => ({ x: r.rpdBytes / 1e6, y: r.ms, title: `${r.file}: ${(r.rpdBytes / 1e6).toFixed(2)} MB, ${r.ms.toFixed(1)} ms, ${r.records} records` })) },
  ],
  fit: { ...timeFit, label: 'linear fit (default)' },
}));
writeFileSync(new URL('memory.svg', outDir), scatter({
  title: 'mcsrr-rrf-parser: memory vs .rrf file size',
  subtitle: `${n} replays · retained median ${stats.medianRetainedMB.toFixed(0)} MB, max ${stats.maxRetainedMB.toFixed(0)} MB · peak RSS +${stats.medianPeakRssMB.toFixed(0)} MB median, +${stats.maxPeakRssMB.toFixed(0)} MB max · Node ${process.version}`,
  xLabel: '.rrf file size (MB)',
  yLabel: 'memory (MB)',
  series: [
    { label: 'peak RSS increase (fresh process)', color: '#2ca02c', r: 3.5, points: rows.map((r) => ({ x: r.rrfBytes / 1e6, y: r.peakRssMB, title: `${r.file}: peak RSS +${r.peakRssMB.toFixed(1)} MB` })) },
    { label: 'retained, names: false', color: '#ff7f0e', r: 3.5, points: rows.map((r) => ({ x: r.rrfBytes / 1e6, y: r.retainedMBNoNames, title: `${r.file}: ${r.retainedMBNoNames.toFixed(1)} MB retained (names: false)` })) },
    { label: 'retained, default (with names)', color: '#1f77b4', r: 4, points: rows.map((r) => ({ x: r.rrfBytes / 1e6, y: r.retainedMB, title: `${r.file}: ${(r.rrfBytes / 1e6).toFixed(2)} MB, ${r.retainedMB.toFixed(1)} MB retained, ${r.records} records` })) },
  ],
  fit: { ...retFit, label: 'linear fit (retained, default)' },
}));
console.log('wrote bench/results.csv, bench/parse-time.svg and bench/memory.svg');
