// Writer-side helpers for building synthetic replay chunks and .rrf archives in tests.
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import type { RecordDataMap, RecordType, ReplayRecord } from '../src/types.ts';

/** Asserts a value is present. */
export function must<T>(v: T | null | undefined, what = 'value'): T {
  assert.ok(v != null, `${what} missing`);
  return v;
}

/** Asserts a record's type and returns its (narrowed) data. */
export function dataOf<T extends RecordType>(rec: ReplayRecord | undefined, type: T): RecordDataMap[T] {
  assert.ok(rec, 'record missing');
  assert.equal(rec.type, type);
  return (rec as ReplayRecord<T>).data;
}

export class ByteWriter {
  parts: Buffer[] = [];

  push(size: number, fn: (b: Buffer) => void): this {
    const b = Buffer.alloc(size);
    fn(b);
    this.parts.push(b);
    return this;
  }

  i8(v: number) { return this.push(1, (b) => b.writeInt8(v)); }
  u8(v: number) { return this.push(1, (b) => b.writeUInt8(v)); }
  i16(v: number) { return this.push(2, (b) => b.writeInt16BE(v)); }
  u16(v: number) { return this.push(2, (b) => b.writeUInt16BE(v)); }
  i32(v: number) { return this.push(4, (b) => b.writeInt32BE(v)); }
  i64(v: number | bigint | string) { return this.push(8, (b) => b.writeBigInt64BE(BigInt.asIntN(64, BigInt(v)))); }
  f32(v: number) { return this.push(4, (b) => b.writeFloatBE(v)); }
  f64(v: number) { return this.push(8, (b) => b.writeDoubleBE(v)); }
  raw(buf: Buffer | Uint8Array | readonly number[]) { this.parts.push(Buffer.from(buf)); return this; }
  uuid(s: string) {
    const hex = s.replace(/-/g, '');
    return this.i64(BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`))).i64(BigInt.asIntN(64, BigInt(`0x${hex.slice(16)}`)));
  }

  bytes(): Buffer { return Buffer.concat(this.parts); }
}

export const w = (): ByteWriter => new ByteWriter();

export interface ChunkRecord {
  type: number;
  tick: number;
  payload: Buffer | Uint8Array | readonly number[];
  /** Always use the 0xFF absolute-tick escape. */
  forceAbsolute?: boolean;
}

/**
 * Builds a decoded chunk: uuid, optional format marker, records.
 * With format 3, tick is the absolute tick (encoded as delta or 0xFF escape like
 * PersonalPlayerTracker.encodeTick); with format 0 it's written as int32.
 */
export function buildChunk(uuid: string, records: readonly ChunkRecord[], { format = 3 }: { format?: number } = {}): Buffer {
  const out = w().uuid(uuid);
  if (format !== 0) out.u8(0x80 | format);
  let last = 0;
  for (const r of records) {
    out.u8(r.type & 0xFF);
    if (format === 0) {
      out.i32(r.tick);
    } else {
      const delta = r.tick - last;
      if (!r.forceAbsolute && delta >= 0 && delta < 255) out.u8(delta);
      else out.u8(255).i32(r.tick);
    }
    last = r.tick;
    out.raw(r.payload);
  }
  return out.bytes();
}

/** Raw Snappy block made only of literals (valid input for Snappy.uncompress). */
export function snappyLiteral(buf: Buffer): Buffer {
  const head: number[] = [];
  let n = buf.length;
  do {
    head.push((n & 0x7F) | (n > 0x7F ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n > 0);
  const parts: Buffer[] = [Buffer.from(head)];
  for (let p = 0; p < buf.length; p += 65536) {
    const piece = buf.subarray(p, Math.min(buf.length, p + 65536));
    const len = piece.length - 1;
    if (len < 60) parts.push(Buffer.from([len << 2]));
    else if (len < 256) parts.push(Buffer.from([60 << 2, len]));
    else parts.push(Buffer.from([61 << 2, len & 0xFF, len >> 8]));
    parts.push(piece);
  }
  return Buffer.concat(parts);
}

/** Minimal ZIP writer. Deflated entries use a data descriptor (sizes 0 in the local header). */
export function buildZip(entries: Record<string, string | Buffer>, { deflate = true }: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const comp: Buffer = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const flags = (deflate ? 0x08 : 0) | 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(deflate ? 0 : crc, 14);
    local.writeUInt32LE(deflate ? 0 : comp.length, 18);
    local.writeUInt32LE(deflate ? 0 : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const parts = [local, nameBuf, comp];
    if (deflate) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(comp.length, 8);
      dd.writeUInt32LE(data.length, 12);
      parts.push(dd);
    }
    const localBuf = Buffer.concat(parts);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    locals.push(localBuf);
    offset += localBuf.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** replay.rpd for version >= 32: [int32 length][bytes]... */
export function lengthPrefixed(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat(chunks.flatMap((c) => [w().i32(c.length).bytes(), c]));
}
