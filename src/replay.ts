// Record decoding (ReplayProcessor.loadChunk / OpponentPlayerTracker.convertTimeLines /
// TimeLinePackage.fromBytes) and the file-level parseRrf / iterRecords.
import * as fs from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { Reader, DecodeError, normalizeUuid } from './binary.ts';
import { DeltaPositions } from './deltas.ts';
import { WORLDS, TYPE_BY_ID, LEGACY_BY_ID } from './lookup.ts';
import type { TypeDef } from './lookup.ts';
import { DECODERS } from './decoders.ts';
import { NameAnnotator } from './names.ts';
import * as container from './container.ts';
import type { RawMeta } from './container.ts';
import type { DecodeErrorInfo, ReplayMeta, ReplayRecord, TimelineEntry } from './types.ts';

/** Per-UUID decoding state, mirroring the OpponentPlayerTracker fields loadChunk touches. */
export class TrackerState {
  deltas = new DeltaPositions();
  decodedTick = 0;
  legacyFormat = false;
  names = new NameAnnotator();
}

/** Normalized options used by the decoding functions (see toOptions in index.ts). */
export interface DecodeOptions {
  names?: boolean;
  /** Upper-case canonical or wire names to keep. */
  types?: ReadonlySet<string>;
  legacyPublicKey?: KeyObject;
  maxEntrySize?: number;
  maxChunkSize?: number;
  onRecord?: (player: PlayerReplay, record: ReplayRecord) => void;
}

/** Adds rec.names (MC 1.16.1 names for raw ids) unless opts.names === false. */
function annotate(records: ReplayRecord[], state: TrackerState, opts: DecodeOptions): void {
  if (opts.names === false) return;
  for (const rec of records) {
    const names = state.names.annotate(rec);
    if (names) rec.names = names;
  }
}

const keep = (rec: ReplayRecord, types: ReadonlySet<string> | undefined) =>
  !types || types.has(rec.type) || types.has(rec.wireType);

/** OpponentPlayerTracker.readFormat: a leading negative byte is a format marker (b & 127). */
export function readFormat(r: Reader): number {
  if (!r.hasRemaining()) return 0;
  if (r.peekI8() >= 0) return 0;
  return r.i8() & 127;
}

/**
 * TimeLinePackage.fromBytes; returns a plain record object. `chunk` is filled in by the
 * file-level functions (parseRrf / iterRecords).
 */
export function readRecord(r: Reader, state: TrackerState, format: number): ReplayRecord {
  const typeId = r.i8();
  let tick: number;
  let def: TypeDef | undefined;
  let legacy = false;
  if (format === 0) {
    tick = state.decodedTick = r.i32();
    state.legacyFormat = true;
    def = LEGACY_BY_ID.get(typeId);
    if (!def) throw new DecodeError(`Unknown legacy replay timeline id ${typeId}`);
    legacy = true;
  } else {
    if (format !== 3) throw new DecodeError(`Unsupported replay record format ${format}`);
    const enc = r.u8();
    tick = state.decodedTick = enc === 255 ? r.i32() : (state.decodedTick + enc) | 0;
    def = TYPE_BY_ID.get(typeId);
    if (!def) throw new DecodeError(`Unknown replay timeline id ${typeId}`);
  }
  const decode = DECODERS[def.factory];
  if (!decode) throw new DecodeError(`no decoder for factory ${def.factory}`);
  const { world, data } = decode(r, state.deltas);
  const rec: Record<string, unknown> = {
    tick,
    type: def.storedAs,
    wireType: def.name,
    wireTypeId: typeId,
    world: world === null || world === undefined ? null : WORLDS[world],
    data,
  };
  if (legacy) rec.legacy = true;
  return rec as unknown as ReplayRecord;
}

/**
 * Decodes one decompressed chunk. Throws on the first bad record with .offset/.typeId/.recordsDecoded
 * attached (the records decoded so far are discarded by callers, like Java's aborted loadChunk).
 */
export function decodeChunk(buf: Buffer, state: TrackerState): { uuid: string; records: ReplayRecord[] } {
  const r = new Reader(buf);
  const uuid = r.uuid();
  return { uuid, records: decodeChunkBody(r, state) };
}

export function decodeChunkBody(r: Reader, state: TrackerState): ReplayRecord[] {
  // OpponentPlayerTracker.convertTimeLines: deltas.reset(); decodedTick = 0; then the format byte.
  state.deltas.reset();
  state.decodedTick = 0;
  const format = readFormat(r);
  const records: ReplayRecord[] = [];
  while (r.hasRemaining()) {
    const start = r.pos;
    try {
      records.push(readRecord(r, state, format));
    } catch (e) {
      const err = e instanceof DecodeError ? e : new DecodeError((e as Error).message);
      err.offset = start;
      if (r.buf.length > start) err.typeId = r.view.getInt8(start);
      err.format = format;
      err.recordsDecoded = records.length;
      throw err;
    }
  }
  return records;
}

// ---------------------------------------------------------------- file level

export interface OpenedRrf {
  meta: ReplayMeta;
  rawMeta: unknown;
  timelines: TimelineEntry[];
  /** Raw (still encrypted/compressed) chunks of replay.rpd. */
  chunks: Buffer[];
  compressed: boolean;
  aesKey: Buffer | null;
  maxChunkSize: number;
  warnings: string[];
}

export function openRrf(file: string | URL | Buffer, opts: DecodeOptions = {}): OpenedRrf {
  const buf = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  const zip = container.readZip(buf, opts.maxEntrySize);
  const need = (name: string) => {
    const get = zip.get(name);
    if (!get) throw new DecodeError(`${name} missing from archive`);
    return get();
  };
  const rawMeta = container.parseJsonLossless(need('meta.json').toString('utf8'));
  if (rawMeta === null || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) throw new DecodeError('meta.json is not a JSON object');
  const meta = container.normalizeMeta(rawMeta as RawMeta);
  let timelines: TimelineEntry[] = [];
  if (zip.has('timelines.json')) {
    const arr = container.parseJsonLossless(need('timelines.json').toString('utf8'));
    if (Array.isArray(arr)) timelines = arr.filter((e): e is TimelineEntry => e !== null && typeof e === 'object' && !Array.isArray(e));
  }
  const warnings: string[] = [];
  const rpd = need('replay.rpd');
  const compressed = meta.version >= 32;
  const chunks = container.splitChunks(rpd, meta.version, warnings);
  let aesKey: Buffer | null = null;
  if (meta.version < 40) {
    aesKey = container.deriveAesKey(meta.symmetricKey, opts.legacyPublicKey || container.loadPublicKey());
  }
  const maxChunkSize = opts.maxChunkSize ?? container.DEFAULT_MAX_CHUNK_SIZE;
  return { meta, rawMeta, timelines, chunks, compressed, aesKey, maxChunkSize, warnings };
}

export type ChunkResult = { index: number; data: Buffer; error?: undefined } | { index: number; data?: undefined; error: Error };

/** Yields { index, data } for each decrypted + decompressed chunk, or { index, error }. */
export function* iterChunks(opened: OpenedRrf): Generator<ChunkResult, void, undefined> {
  for (let index = 0; index < opened.chunks.length; index++) {
    let data = opened.chunks[index]!;
    try {
      if (opened.aesKey) data = container.aesDecrypt(data, opened.aesKey);
      data = container.decompressChunk(data, opened.compressed, opened.maxChunkSize);
      yield { index, data };
    } catch (e) {
      yield { index, error: e as Error };
    }
  }
}

function decompressError(index: number, error: Error): DecodeErrorInfo {
  return { uuid: null, chunk: index, stage: 'decompress', offset: null, typeId: null, message: error.message, recordsDiscarded: 0 };
}

function decodeError(uuid: string | null, index: number, e: unknown): DecodeErrorInfo {
  const err = e as Partial<DecodeError>;
  return {
    uuid,
    chunk: index,
    stage: 'decode',
    offset: err.offset ?? null,
    typeId: err.typeId ?? null,
    message: String(err.message ?? e),
    recordsDiscarded: err.recordsDecoded ?? 0,
  };
}

export interface IterRecordsOptions extends DecodeOptions {
  /** Already opened file (then `file` is ignored). */
  opened?: OpenedRrf;
  /** Receives chunk-level failures. */
  errors?: DecodeErrorInfo[];
}

/**
 * Generator over every decoded record: { uuid, chunk, record }. Chunk-level failures are pushed
 * to opts.errors (the failing chunk's records are not yielded) and decoding moves on.
 * opts.types filters what is yielded; every record is still decoded so delta state stays correct.
 */
export function* iterRecords(
  file: string | URL | Buffer | null,
  opts: IterRecordsOptions = {},
): Generator<{ uuid: string; chunk: number; record: ReplayRecord }, void, undefined> {
  const opened = opts.opened || openRrf(file!, opts);
  const errors = opts.errors || [];
  const states = new Map<string, TrackerState>();
  for (const { index, data, error } of iterChunks(opened)) {
    if (error) {
      errors.push(decompressError(index, error));
      continue;
    }
    const r = new Reader(data);
    let uuid: string | null = null;
    let records: ReplayRecord[];
    try {
      uuid = r.uuid();
      let state = states.get(uuid);
      if (!state) states.set(uuid, (state = new TrackerState()));
      records = decodeChunkBody(r, state);
      annotate(records, state, opts);
    } catch (e) {
      errors.push(decodeError(uuid, index, e));
      continue;
    }
    for (const record of records) {
      record.chunk = index;
      if (!keep(record, opts.types)) continue;
      yield { uuid, chunk: index, record };
    }
  }
}

/** All records of one player (one UUID in replay.rpd). */
export class PlayerReplay {
  /** Dashed lowercase UUID. */
  readonly uuid: string;
  readonly nickname: string | null;
  /** Whether the UUID is listed in meta.players. */
  readonly inMeta: boolean;
  /** Number of chunks decoded for this player. */
  chunks = 0;
  records: ReplayRecord[] = [];

  constructor(uuid: string, nickname: string | null) {
    this.uuid = uuid;
    this.nickname = nickname;
    this.inMeta = nickname !== null;
  }
}

/** A fully parsed replay. */
export class Replay {
  readonly meta: ReplayMeta;
  /** Entries from timelines.json (split events such as nether enter), if present. */
  readonly timelines: TimelineEntry[];
  readonly warnings: string[];
  /** Chunks that failed to decode. Other chunks are still returned. */
  readonly errors: DecodeErrorInfo[];
  /** Keyed by dashed lowercase UUID; meta players first, in meta order. */
  readonly players = new Map<string, PlayerReplay>();

  constructor(meta: ReplayMeta, timelines: TimelineEntry[], warnings: string[], errors: DecodeErrorInfo[]) {
    this.meta = meta;
    this.timelines = timelines;
    this.warnings = warnings;
    this.errors = errors;
  }

  /** Lookup by UUID (dashed or not) or nickname (case-insensitive). */
  findPlayer(key: string): PlayerReplay | null {
    const u = normalizeUuid(key);
    if (u && this.players.has(u)) return this.players.get(u)!;
    const lower = String(key).toLowerCase();
    for (const p of this.players.values()) if (p.nickname && p.nickname.toLowerCase() === lower) return p;
    return null;
  }
}

/** Parses a whole .rrf. */
export function parseRrf(file: string | URL | Buffer, opts: DecodeOptions = {}): Replay {
  const opened = openRrf(file, opts);
  const errors: DecodeErrorInfo[] = [];
  const replay = new Replay(opened.meta, opened.timelines, opened.warnings, errors);
  const nickByUuid = new Map<string, string | null>();
  for (const p of opened.meta.players) {
    const u = normalizeUuid(p.uuid);
    if (u) nickByUuid.set(u, p.nickname);
  }
  const getPlayer = (uuid: string) => {
    let p = replay.players.get(uuid);
    if (!p) {
      p = new PlayerReplay(uuid, nickByUuid.has(uuid) ? nickByUuid.get(uuid)! : null);
      replay.players.set(uuid, p);
    }
    return p;
  };
  // Pre-create meta players so they appear (in meta order) even without chunks.
  for (const u of nickByUuid.keys()) getPlayer(u);

  const states = new Map<string, TrackerState>();
  for (const { index, data, error } of iterChunks(opened)) {
    if (error) {
      errors.push(decompressError(index, error));
      continue;
    }
    const r = new Reader(data);
    let uuid: string | null = null;
    try {
      uuid = r.uuid();
      let state = states.get(uuid);
      if (!state) states.set(uuid, (state = new TrackerState()));
      const records = decodeChunkBody(r, state);
      annotate(records, state, opts);
      const player = getPlayer(uuid);
      player.chunks++;
      for (const rec of records) {
        rec.chunk = index;
        if (!keep(rec, opts.types)) continue;
        if (opts.onRecord) opts.onRecord(player, rec);
        else player.records.push(rec);
      }
    } catch (e) {
      errors.push(decodeError(uuid, index, e));
    }
  }
  return replay;
}
