// .rrf container: ZIP reading, meta.json (with ReplayMetaUnder30 migration), the chunk stream of
// replay.rpd, and the ReplayCodec / legacy AES layers.
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import { DecodeError } from './binary.ts';
import { REPLAY_PUBLIC_KEY } from './mod-data.ts';
import type { MetaPlayer, ReplayMeta } from './types.ts';

// ---------------------------------------------------------------- limits

/** Default cap on one decompressed ZIP entry. Real replays stay under 4 MiB. */
export const DEFAULT_MAX_ENTRY_SIZE = 64 * 1024 * 1024;
/** Default cap on one decompressed replay.rpd chunk. Real chunks stay under 64 KiB. */
export const DEFAULT_MAX_CHUNK_SIZE = 16 * 1024 * 1024;

// ---------------------------------------------------------------- ZIP

/**
 * Reads all entries via the central directory (sizes in local headers may be data descriptors).
 * Entries larger than maxEntrySize are rejected before inflating, so a crafted archive can't exhaust memory.
 */
export function readZip(buf: Buffer, maxEntrySize = DEFAULT_MAX_ENTRY_SIZE): Map<string, () => Buffer> {
  const min = Math.max(0, buf.length - 22 - 0xFFFF);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DecodeError('not a ZIP archive (end of central directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, () => Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new DecodeError(`bad ZIP central directory entry at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, () => {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new DecodeError(`bad ZIP local header for ${name}`);
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(start, start + compSize);
      if (size > maxEntrySize) throw new DecodeError(`ZIP entry ${name} is ${size} bytes, over the ${maxEntrySize} byte limit`);
      let data: Buffer;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateCapped(raw, size, name);
      else throw new DecodeError(`unsupported ZIP compression method ${method} for ${name}`);
      if (data.length !== size) throw new DecodeError(`ZIP size mismatch for ${name}`);
      if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== crc) throw new DecodeError(`ZIP CRC mismatch for ${name}`);
      return data;
    });
  }
  return entries;
}

function inflateCapped(raw: Buffer, size: number, name: string): Buffer {
  try {
    // One byte of headroom so an oversized stream reports a size mismatch instead of truncating silently.
    return zlib.inflateRawSync(raw, { maxOutputLength: size + 1 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new DecodeError(`ZIP size mismatch for ${name}`);
    throw e;
  }
}

// ---------------------------------------------------------------- JSON / meta

/** JSON.parse that keeps integers beyond 2^53 exact (as BigInt) like Gson's long fields. */
export function parseJsonLossless(text: string): unknown {
  // The reviver's third argument (source text access) exists since Node 21; older lib typings lack it.
  const reviver = (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  };
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

type JsonLong = number | bigint | string;

interface RawPlayer {
  uuid?: string;
  nickname?: string;
  roleType?: number;
  eloRate?: number;
  eloRank?: number;
  country?: string;
  // ReplayMetaUnder30 names
  badge?: number;
  elo_rate?: number;
  elo_rank?: number;
}

/** meta.json as written by any mod version (current ReplayMeta or ReplayMetaUnder30). */
export interface RawMeta {
  version?: number;
  matchId?: number;
  date?: number;
  matchType?: number;
  overworldSeed?: JsonLong;
  netherSeed?: JsonLong;
  theEndSeed?: JsonLong;
  symmetricKey?: string;
  result?: { uuid?: string; time?: number };
  players?: RawPlayer[];
  // ReplayMetaUnder30
  time?: number;
  seed?: JsonLong;
  finalTimes?: Array<{ uuid?: string; finalTime?: number }>;
}

function basePlayer(p: RawPlayer): MetaPlayer {
  return {
    uuid: p.uuid ?? null,
    nickname: p.nickname ?? null,
    roleType: p.roleType ?? 0,
    eloRate: p.eloRate ?? null,
    eloRank: p.eloRank ?? null,
    country: p.country ?? null,
  };
}

/** int64 seeds are reported as decimal strings so they survive JSON and JS numbers losslessly. */
const seed = (v: JsonLong | null | undefined): string | null => (v == null ? null : String(v));

/** ReplayManager meta loading: version < 30 goes through ReplayMetaUnder30.convert(). */
export function normalizeMeta(raw: RawMeta): ReplayMeta {
  const fileVersion = raw.version ?? 0;
  if (fileVersion < 30) {
    const ft = Array.isArray(raw.finalTimes) && raw.finalTimes.length > 0 ? raw.finalTimes[0] : null;
    return {
      // The converted ReplayMeta never sets version, so Gson's default (0) is what Java sees.
      version: 0,
      fileVersion,
      migratedFromUnder30: true,
      matchId: null,
      date: raw.time ?? 0,
      matchType: raw.matchType ?? 0,
      overworldSeed: seed(raw.seed),
      netherSeed: seed(raw.seed),
      theEndSeed: seed(raw.seed),
      symmetricKey: raw.symmetricKey ?? null,
      result: ft ? { uuid: ft.uuid ?? null, time: ft.finalTime ?? 0 } : { uuid: null, time: 0 },
      players: (raw.players || []).map((p) => basePlayer({
        uuid: p.uuid, nickname: p.nickname, roleType: p.badge, eloRate: p.elo_rate, eloRank: p.elo_rank,
      })),
    };
  }
  return {
    version: fileVersion,
    fileVersion,
    migratedFromUnder30: false,
    matchId: raw.matchId ?? null,
    date: raw.date ?? 0,
    matchType: raw.matchType ?? 0,
    overworldSeed: seed(raw.overworldSeed),
    netherSeed: seed(raw.netherSeed),
    theEndSeed: seed(raw.theEndSeed ?? raw.overworldSeed),
    symmetricKey: raw.symmetricKey ?? null,
    result: raw.result ? { uuid: raw.result.uuid ?? null, time: raw.result.time ?? 0 } : { uuid: null, time: 0 },
    players: (raw.players || []).map(basePlayer),
  };
}

// ---------------------------------------------------------------- chunk stream

/**
 * ReplayManager.readChunks. version >= 32: [int32 BE length][bytes]..., a truncated tail ends
 * the stream (Java swallows the EOFException). Older: one base64 chunk per non-empty line.
 */
export function splitChunks(data: Buffer, version: number, warnings: string[] = []): Buffer[] {
  const chunks: Buffer[] = [];
  if (version >= 32) {
    let p = 0;
    while (p < data.length) {
      if (p + 4 > data.length) {
        warnings.push(`replay.rpd: ${data.length - p} trailing byte(s) too short for a chunk length; ignored`);
        break;
      }
      const len = data.readInt32BE(p);
      if (len < 0) throw new DecodeError(`negative chunk length ${len} at offset ${p}`);
      if (p + 4 + len > data.length) {
        warnings.push(`replay.rpd: chunk at offset ${p} declares ${len} bytes but only ${data.length - p - 4} remain; ignored`);
        break;
      }
      chunks.push(data.subarray(p + 4, p + 4 + len));
      p += 4 + len;
    }
    return chunks;
  }
  // BufferedReader.readLine splits on \n, \r or \r\n; a malformed line throws out of readChunks in Java.
  const lines = data.toString('utf8').split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    if (line.length === 0) return;
    try {
      chunks.push(decodeBase64Strict(line));
    } catch (e) {
      throw new DecodeError(`replay.rpd line ${i + 1}: ${(e as Error).message}`);
    }
  });
  return chunks;
}

// ---------------------------------------------------------------- codecs

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

/** Frame_Content_Size from a zstd frame header, or null if absent/unknown. */
export function zstdContentSize(buf: Buffer): number | null {
  if (buf.length < 5) return null;
  const fhd = buf[4]!;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const didSize = [0, 1, 2, 4][fhd & 3]!;
  const fcsSize = [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]!;
  if (fcsSize === 0) return null;
  const off = 5 + (singleSegment ? 0 : 1) + didSize;
  if (off + fcsSize > buf.length) return null;
  switch (fcsSize) {
    case 1: return buf[off]!;
    case 2: return buf.readUInt16LE(off) + 256;
    case 4: return buf.readUInt32LE(off);
    default: return Number(buf.readBigUInt64LE(off));
  }
}

/** Raw (unframed) Snappy block decompressor. */
export function snappyDecompress(src: Buffer, maxSize = 0x7FFFFFFF): Buffer {
  let p = 0;
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    if (p >= src.length || shift > 28) throw new DecodeError('snappy: bad uncompressed length varint');
    const b = src[p++]!;
    length += (b & 0x7F) * 2 ** shift;
    if ((b & 0x80) === 0) break;
  }
  if (length > 0x7FFFFFFF || length > maxSize) throw new DecodeError('snappy: uncompressed length too large');
  const out = Buffer.allocUnsafe(length);
  let o = 0;
  const need = (n: number) => { if (p + n > src.length) throw new DecodeError('snappy: truncated input'); };
  while (p < src.length) {
    const tag = src[p++]!;
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const nb = len - 59;
        need(nb);
        len = 0;
        for (let i = 0; i < nb; i++) len += src[p + i]! * 2 ** (8 * i);
        p += nb;
      }
      len += 1;
      need(len);
      if (o + len > length) throw new DecodeError('snappy: literal overruns output');
      src.copy(out, o, p, p + len);
      p += len;
      o += len;
      continue;
    }
    let len: number;
    let offset: number;
    if (kind === 1) {
      need(1);
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[p++]!;
    } else if (kind === 2) {
      need(2);
      len = (tag >> 2) + 1;
      offset = src.readUInt16LE(p);
      p += 2;
    } else {
      need(4);
      len = (tag >> 2) + 1;
      offset = src.readUInt32LE(p);
      p += 4;
    }
    if (offset === 0 || offset > o) throw new DecodeError(`snappy: bad copy offset ${offset}`);
    if (o + len > length) throw new DecodeError('snappy: copy overruns output');
    for (let i = 0; i < len; i++, o++) out[o] = out[o - offset]!;
  }
  if (o !== length) throw new DecodeError(`snappy: produced ${o} bytes, expected ${length}`);
  return out;
}

export type CodecName = 'NONE' | 'ZSTD' | 'SNAPPY';

/** Name of the ReplayCodec that ReplayCodec.detect(bytes, compressed) would pick. */
export function detectCodec(buf: Buffer, compressed: boolean): CodecName {
  if (!compressed) return 'NONE';
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC) ? 'ZSTD' : 'SNAPPY';
}

/** ReplayCodec.detect(bytes, compressed).decompress(bytes). */
export function decompressChunk(buf: Buffer, compressed = true, maxSize = DEFAULT_MAX_CHUNK_SIZE): Buffer {
  const codec = detectCodec(buf, compressed);
  if (codec === 'NONE') return buf;
  if (codec === 'ZSTD') {
    const size = zstdContentSize(buf);
    // Zstd.getFrameContentSize > 0 && <= Integer.MAX_VALUE, otherwise Java falls back to Snappy.
    if (size !== null && size > 0 && size <= 0x7FFFFFFF) {
      if (typeof zlib.zstdDecompressSync !== 'function') {
        throw new DecodeError('zstd chunk found but this Node.js lacks zlib.zstdDecompressSync (need >= 22.15 / 23.8)');
      }
      if (size > maxSize) throw new DecodeError(`zstd chunk declares ${size} bytes, over the ${maxSize} byte limit`);
      let out: Buffer;
      try {
        out = zlib.zstdDecompressSync(buf, { maxOutputLength: size + 1 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new DecodeError(`zstd output exceeds frame content size ${size}`);
        throw e;
      }
      if (out.length > size) throw new DecodeError(`zstd output (${out.length}) exceeds frame content size ${size}`);
      return out;
    }
  }
  return snappyDecompress(buf, maxSize);
}

/** java.util.Base64.getDecoder() (basic, padding optional, no whitespace). */
export function decodeBase64Strict(s: string): Buffer {
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(s);
  if (!m) throw new DecodeError('Illegal base64 character');
  const body = m[1]!.length;
  const pad = m[2]!.length;
  if (pad > 0 ? (body + pad) % 4 !== 0 || body % 4 === 0 : body % 4 === 1) {
    throw new DecodeError('Illegal base64 length/padding');
  }
  return Buffer.from(s, 'base64');
}

/** ReplayCodec.compress equivalent (zstd level 6), for tests. */
export function zstdCompress(buf: Buffer): Buffer {
  return zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 6 } });
}

// ---------------------------------------------------------------- legacy AES (version < 40)

/** Parses a base64 X.509/SPKI public key (defaults to the mod's AntiCheatConfig key from data/mcsrranked.json). */
export function loadPublicKey(b64: string = REPLAY_PUBLIC_KEY): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

/** ReplayManager.generateSecretKey: RSA/ECB/PKCS1Padding decrypt of meta.symmetricKey with the public key. */
export function deriveAesKey(symmetricKey: string | null | undefined, publicKey: crypto.KeyObject): Buffer {
  if (!symmetricKey) throw new DecodeError('legacy encrypted replay has no symmetricKey in meta.json');
  let key: Buffer;
  try {
    key = crypto.publicDecrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, decodeBase64Strict(symmetricKey));
  } catch (e) {
    throw new DecodeError(`could not decrypt meta.symmetricKey with the replay public key (${(e as Error).message})`);
  }
  if (![16, 24, 32].includes(key.length)) throw new DecodeError(`unexpected AES key length ${key.length}`);
  return key;
}

export function aesDecrypt(buf: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}
