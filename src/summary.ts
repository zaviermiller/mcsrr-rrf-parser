// Per-player statistics and sanity checks (used by --summary and the summarize() API).
import { selectPlayers } from './output.ts';
import type { PlayerReplay, Replay } from './replay.ts';
import type { FinalPosition, PlayerStats, RecordType, ReplaySummary } from './types.ts';

const JUMP_RESET_TYPES: ReadonlySet<RecordType> = new Set<RecordType>(['PLAYER_PORTAL', 'PLAYER_SPAWN', 'PLAYER_REMOVE']);
const JUMP_LIMIT = 200;
const MAX_LISTED_REGRESSIONS = 5;

function dist(a: FinalPosition, b: FinalPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Record counts, tick range, final position and sanity notes for one player. */
export function summarizePlayer(p: PlayerReplay): PlayerStats {
  const counts: Partial<Record<RecordType, number>> = {};
  let minTick: number | null = null;
  let maxTick: number | null = null;
  let finalPosition: FinalPosition | null = null;
  const issues: string[] = [];
  let lastChunk = -1;
  let lastTick: number | null = null;
  let lastPos: FinalPosition | null = null;
  let regressions = 0;
  for (const r of p.records) {
    counts[r.type] = (counts[r.type] || 0) + 1;
    if (minTick === null || r.tick < minTick) minTick = r.tick;
    if (maxTick === null || r.tick > maxTick) maxTick = r.tick;
    if (r.chunk === lastChunk && lastTick !== null && r.tick < lastTick) {
      regressions++;
      if (regressions <= MAX_LISTED_REGRESSIONS) issues.push(`tick went backwards in chunk ${r.chunk}: ${lastTick} -> ${r.tick}`);
    }
    lastChunk = r.chunk;
    lastTick = r.tick;
    if (JUMP_RESET_TYPES.has(r.type)) lastPos = null;
    if (r.type === 'PLAYER_POSITION' || r.type === 'PLAYER_POSITION_POS' || r.type === 'PLAYER_SPAWN') {
      const pos: FinalPosition = { world: r.world, x: r.data.x, y: r.data.y, z: r.data.z, tick: r.tick };
      if (lastPos && lastPos.world === pos.world && r.type !== 'PLAYER_SPAWN') {
        const d = dist(lastPos, pos);
        if (d > JUMP_LIMIT) issues.push(`position jump of ${d.toFixed(1)} blocks at tick ${r.tick} (${pos.world})`);
      }
      lastPos = pos;
      finalPosition = pos;
    }
  }
  if (regressions > MAX_LISTED_REGRESSIONS) issues.push(`... ${regressions - MAX_LISTED_REGRESSIONS} more tick regression(s)`);
  if (!p.inMeta) issues.push('UUID not present in meta.players');
  return { counts, minTick, maxTick, finalPosition, tickRegressions: regressions, issues };
}

/** Structured summary of a parsed replay. */
export function summarize(rep: Replay, playerKey?: string | null): ReplaySummary {
  const m = rep.meta;
  const winner = m.result.uuid ? rep.findPlayer(m.result.uuid) : null;
  return {
    version: m.fileVersion,
    migratedFromUnder30: m.migratedFromUnder30,
    matchId: m.matchId,
    matchType: m.matchType ?? null,
    date: m.date ? new Date(m.date).toISOString() : null,
    seeds: { overworld: m.overworldSeed, nether: m.netherSeed, theEnd: m.theEndSeed },
    result: { uuid: m.result.uuid, nickname: winner ? winner.nickname : null, timeMs: m.result.time },
    timelines: rep.timelines.length,
    warnings: rep.warnings,
    errors: rep.errors,
    players: selectPlayers(rep, playerKey).map((p) => ({
      uuid: p.uuid,
      nickname: p.nickname,
      inMeta: p.inMeta,
      chunks: p.chunks,
      records: p.records.length,
      ...summarizePlayer(p),
    })),
  };
}

function fmtTicks(t: number | null): string {
  return t === null ? '-' : `${t} (${(t / 20).toFixed(2)}s)`;
}

/** Human-readable summary text (what `mcsrr-rrf --summary` prints). */
export function formatSummary(rep: Replay, playerKey?: string | null): string {
  const s = summarize(rep, playerKey);
  const lines: string[] = [];
  lines.push(`version: ${s.version}${s.migratedFromUnder30 ? ' (migrated from <30, effective version 0)' : ''}`);
  lines.push(`matchId: ${s.matchId ?? '-'}   matchType: ${s.matchType}   date: ${s.date ?? '-'}`);
  lines.push(`seeds: overworld=${s.seeds.overworld} nether=${s.seeds.nether} end=${s.seeds.theEnd}`);
  lines.push(`result: ${s.result.uuid ?? '-'}${s.result.nickname ? ` (${s.result.nickname})` : ''} time=${s.result.timeMs}ms`);
  lines.push(`timelines: ${s.timelines}   decode errors: ${s.errors.length}   warnings: ${s.warnings.length}`);
  for (const w of s.warnings) lines.push(`  warning: ${w}`);
  for (const e of s.errors.slice(0, 20)) {
    lines.push(`  error: chunk ${e.chunk} [${e.stage}] uuid=${e.uuid ?? '-'} offset=${e.offset ?? '-'} typeId=${e.typeId ?? '-'}: ${e.message}`);
  }
  if (s.errors.length > 20) lines.push(`  ... ${s.errors.length - 20} more error(s)`);
  for (const p of s.players) {
    lines.push('');
    lines.push(`player ${p.nickname ?? '(unknown)'} ${p.uuid}`);
    lines.push(`  chunks: ${p.chunks}   records: ${p.records}`);
    lines.push(`  ticks: ${fmtTicks(p.minTick)} .. ${fmtTicks(p.maxTick)}`);
    const fp = p.finalPosition;
    lines.push(`  final position: ${fp ? `${fp.world} ${fp.x.toFixed(3)} ${fp.y.toFixed(3)} ${fp.z.toFixed(3)} @ tick ${fp.tick}` : '-'}`);
    lines.push('  types:');
    for (const [t, n] of Object.entries(p.counts).sort((a, b) => b[1] - a[1])) lines.push(`    ${t.padEnd(28)} ${n}`);
    for (const issue of p.issues) lines.push(`  sanity: ${issue}`);
  }
  return `${lines.join('\n')}\n`;
}
