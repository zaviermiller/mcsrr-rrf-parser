// Big-endian reader mirroring java.nio.ByteBuffer, plus the float32 / BlockPos / UUID helpers
// the replay format depends on.
import type { BlockPos } from './types.ts';

export class DecodeError extends Error {
  /** Byte offset inside the decrypted chunk where decoding failed, when known. */
  offset?: number;
  /** Raw record type id being decoded, when known. */
  typeId?: number;
  /** Record format of the chunk being decoded, when known. */
  format?: number;
  /** Number of records decoded from the chunk before the failure, when known. */
  recordsDecoded?: number;
}

export class Reader {
  readonly buf: Buffer;
  readonly view: DataView;
  pos: number;

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  hasRemaining(): boolean {
    return this.pos < this.buf.length;
  }

  need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new DecodeError(`buffer underflow: need ${n} byte(s) at offset ${this.pos}, ${this.remaining} left`);
    }
  }

  peekI8(): number {
    this.need(1);
    return this.view.getInt8(this.pos);
  }

  i8(): number { this.need(1); return this.view.getInt8(this.pos++); }
  u8(): number { this.need(1); return this.view.getUint8(this.pos++); }
  bool(): boolean { return this.i8() !== 0; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  /** Signed 64-bit. */
  i64(): bigint { this.need(8); const v = this.view.getBigInt64(this.pos); this.pos += 8; return v; }
  f32(): number { this.need(4); const v = this.view.getFloat32(this.pos); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }
  bytes(n: number): Buffer { this.need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }

  uuid(): string {
    return formatUuid(this.i64(), this.i64());
  }
}

export function formatUuid(most: bigint, least: bigint): string {
  const hex = BigInt.asUintN(64, most).toString(16).padStart(16, '0') +
    BigInt.asUintN(64, least).toString(16).padStart(16, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeUuid(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const hex = s.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- float32 semantics (Java float arithmetic) ----
const fround = Math.fround;
const F_001 = fround(0.01);
export const ANGLE_STEPS = 0.7111111111111111;

/** MC 1.16.1 MathHelper.wrapDegrees(float). */
export function wrapDegrees(value: number): number {
  let f = fround(value % 360);
  if (f >= 180) f = fround(f - 360);
  if (f < -180) f = fround(f + 360);
  return f;
}

/** Java (int) cast of a float/double: truncation with saturation, NaN -> 0. */
export function toJavaInt(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= -2147483648) return -2147483648;
  return Math.trunc(v);
}

export const toJavaShort = (v: number): number => (toJavaInt(v) << 16) >> 16;
export const toJavaByte = (v: number): number => (toJavaInt(v) << 24) >> 24;

/** RotationTimeLine.convertValue(short) -> degrees. */
export function convertValue(raw: number): number {
  return wrapDegrees(fround(raw * F_001));
}

/** RotationTimeLine.convertRotation(float) -> short. */
export function convertRotation(degrees: number): number {
  return toJavaShort(fround(wrapDegrees(degrees) / F_001));
}

/** DeltaPositions.byteToAngle(byte). */
export function byteToAngle(b: number): number {
  return fround(b / ANGLE_STEPS);
}

/** DeltaPositions.angleToByte(short) (writer side, used by tests). */
export function angleToByte(encoded: number): number | null {
  let steps = Math.round(convertValue(encoded) * ANGLE_STEPS);
  if (steps === 128) steps = -128;
  if (steps < -128 || steps > 127) return null;
  return convertRotation(byteToAngle(steps)) === encoded ? steps : null;
}

// ---- MC 1.16.1 BlockPos packing (26 bits X, 12 bits Y, 26 bits Z) ----
export function blockPosFromLong(packed: bigint | number): BlockPos {
  const l = BigInt.asIntN(64, BigInt(packed));
  return {
    x: Number(BigInt.asIntN(64, l) >> 38n),
    y: Number(BigInt.asIntN(64, l << 52n) >> 52n),
    z: Number(BigInt.asIntN(64, l << 26n) >> 38n),
  };
}

export function blockPosAsLong(x: number, y: number, z: number): bigint {
  const l = ((BigInt(x) & 0x3FFFFFFn) << 38n) | ((BigInt(z) & 0x3FFFFFFn) << 12n) | (BigInt(y) & 0xFFFn);
  return BigInt.asIntN(64, l);
}

/** Emit int64 values as JSON numbers when exact, otherwise as decimal strings. */
export function longOut(v: bigint): number | string {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v.toString();
}
