// Public API of mcsrr-rrf-parser. See README.md for usage and docs/FORMAT.md for the file format.
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as replay from './replay.ts';
import type { DecodeOptions } from './replay.ts';
import * as container from './container.ts';
import * as output from './output.ts';
import * as summary from './summary.ts';
import { LEGACY_BY_ID } from './lookup.ts';
import { TIMELINE_TYPES } from './mod-data.ts';
import { normalizeUuid } from './binary.ts';
import { MC_DATA } from './mc-data.ts';
import type {
  LegacyRecordType, OpenedReplay, ParseOptions, ParseReplayOptions, PlayerOption, RecordTypeInfo, RecordType,
  RegistryName, ReplayInput, ReplaySummary, StreamedRecord,
} from './types.ts';

export type * from './types.ts';
export { DecodeError } from './binary.ts';
export { Replay, PlayerReplay } from './replay.ts';
export { blockState } from './names.ts';
export { MOD_VERSION, WORLDS } from './mod-data.ts';

/** Minecraft version the vanilla tables (and the mod) target. */
export const MINECRAFT_VERSION: string = MC_DATA.minecraft;

/** Every current TimeLineType, in id order. *_DELTA wire types report the canonical type in `storedAs`. */
export const RECORD_TYPES: readonly RecordTypeInfo[] = Object.freeze(TIMELINE_TYPES.map((t) =>
  Object.freeze({ id: t.id, name: t.name, storedAs: t.storedAs ?? (t.name as RecordType) })));

/** LegacyTimeLineType (format 0 records of older replays). */
export const LEGACY_RECORD_TYPES: readonly RecordTypeInfo[] = Object.freeze([...LEGACY_BY_ID.values()].map((t) =>
  Object.freeze({ id: t.id, name: t.name as LegacyRecordType, storedAs: t.storedAs as RecordType })));

const KNOWN_TYPES: ReadonlySet<string> = new Set([...RECORD_TYPES.map((t) => t.name), ...LEGACY_RECORD_TYPES.map((t) => t.name)]);

function toInput(input: ReplayInput): string | URL | Buffer {
  if (typeof input === 'string' || input instanceof URL) return input;
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new TypeError('expected a file path, file URL, Buffer, Uint8Array or ArrayBuffer');
}

/** Normalizes a list/Set/comma-separated string of record type names; throws on unknown names. */
function toTypeSet(list: Iterable<string> | string): Set<string> {
  const items = typeof list === 'string' ? list.split(',') : [...list];
  const set = new Set(items.map((s) => String(s).trim().toUpperCase()).filter(Boolean));
  for (const t of set) if (!KNOWN_TYPES.has(t)) throw new TypeError(`unknown record type: ${t}`);
  return set;
}

function toPublicKey(key: crypto.KeyObject | string): crypto.KeyObject {
  if (key instanceof crypto.KeyObject) return key;
  const s = String(key);
  return s.includes('-----BEGIN') ? crypto.createPublicKey(s) : container.loadPublicKey(s);
}

function toOptions(options: ParseReplayOptions = {}): DecodeOptions {
  const opts: DecodeOptions = { names: options.names !== false };
  if (options.types !== undefined && options.types !== null) opts.types = toTypeSet(options.types);
  if (options.legacyPublicKey) opts.legacyPublicKey = toPublicKey(options.legacyPublicKey);
  if (options.onRecord) opts.onRecord = options.onRecord;
  if (options.maxEntrySize !== undefined) opts.maxEntrySize = toLimit('maxEntrySize', options.maxEntrySize);
  if (options.maxChunkSize !== undefined) opts.maxChunkSize = toLimit('maxChunkSize', options.maxChunkSize);
  return opts;
}

function toLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

/** Parses a whole replay (path, URL or bytes) synchronously into a Replay. */
export function parseReplay(input: ReplayInput, options?: ParseReplayOptions): replay.Replay {
  return replay.parseRrf(toInput(input), toOptions(options));
}

/** Like parseReplay, but reads the file asynchronously. Decoding itself is still synchronous. */
export async function readReplay(input: ReplayInput, options?: ParseReplayOptions): Promise<replay.Replay> {
  const src = toInput(input);
  const buf = Buffer.isBuffer(src) ? src : await fs.promises.readFile(src);
  return parseReplay(buf, options);
}

/**
 * Opens a replay without decoding records. meta/timelines are available immediately and
 * records() streams { uuid, nickname, chunk, record } one at a time (low memory).
 */
export function openReplay(input: ReplayInput, options?: ParseOptions): OpenedReplay {
  const opts = toOptions(options);
  const opened = replay.openRrf(toInput(input), opts);
  const nicknames = new Map<string, string | null>();
  for (const p of opened.meta.players) {
    const u = normalizeUuid(p.uuid);
    if (u) nicknames.set(u, p.nickname);
  }
  const errors: OpenedReplay['errors'] = [];
  return {
    meta: opened.meta,
    rawMeta: opened.rawMeta,
    timelines: opened.timelines,
    warnings: opened.warnings,
    errors,
    chunkCount: opened.chunks.length,
    *records(): Generator<StreamedRecord, void, undefined> {
      errors.length = 0;
      for (const item of replay.iterRecords(null, { ...opts, opened, errors })) {
        yield { uuid: item.uuid, nickname: nicknames.get(item.uuid) ?? null, chunk: item.chunk, record: item.record };
      }
    },
  };
}

/** Structured per-player summary (counts by type, tick range, final position, sanity notes). */
export function summarize(rep: replay.Replay, options: PlayerOption = {}): ReplaySummary {
  return summary.summarize(rep, options.player);
}

/** The text that `mcsrr-rrf --summary` prints. */
export function formatSummary(rep: replay.Replay, options: PlayerOption = {}): string {
  return summary.formatSummary(rep, options.player);
}

/** The JSON document the CLI writes, as a string (int64 values become strings when not exact). */
export function toJSON(rep: replay.Replay, options: PlayerOption = {}): string {
  return output.stringifyReplay(rep, options.player);
}

/** Streams the JSON document to a file path or an open file descriptor (works for very large replays). */
export function writeJSON(rep: replay.Replay, target: string | URL | number, options: PlayerOption = {}): void {
  output.writeJsonFile(rep, target, options.player);
}

/** Vanilla 1.16.1 registry name for a raw id (e.g. registryName('item', 1) === 'stone'), or null. */
export function registryName(registry: RegistryName, id: number): string | null {
  const reg: readonly string[] | undefined = (MC_DATA.registries as Record<string, string[]>)[registry];
  if (!reg) throw new TypeError(`unknown registry: ${registry} (known: ${Object.keys(MC_DATA.registries).join(', ')})`);
  return Number.isInteger(id) && id >= 0 && id < reg.length ? reg[id]! : null;
}
