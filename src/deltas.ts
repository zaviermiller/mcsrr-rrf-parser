// Port of com.mcsrranked.client.anticheat.replay.format.DeltaPositions.
import { blockPosAsLong } from './binary.ts';
import type { BlockPos, Vec3 } from './types.ts';

export const PLAYER_KEY = -2147483647;
export const DRAGON_KEY = -2147483648;
const SCALE = 4096.0;
const SMALL_STEP = 16;

/** [world, qx, qy, qz] */
type Entry = [number, number, number, number];
export type Delta3 = [number, number, number];

/** Math.round(float * 4096.0); the float is widened to double first. */
export function quantize(value: number): number {
  return Math.round(value * SCALE);
}

export function dequantize(q: number): number {
  return Math.fround(q / SCALE);
}

const inShort = (v: number) => v >= -32768 && v <= 32767;
const inByte = (v: number) => v >= -128 && v <= 127;

export class DeltaPositions {
  readonly positions = new Map<number, Entry>();
  hasBlock = false;
  // Like the Java fields, the block world and coordinates are not cleared by reset().
  blockWorld = 0;
  blockX = 0;
  blockY = 0;
  blockZ = 0;

  reset(): void {
    this.positions.clear();
    this.hasBlock = false;
  }

  store(key: number, world: number, x: number, y: number, z: number): void {
    this.positions.set(key, [world, quantize(x), quantize(y), quantize(z)]);
  }

  getWorld(key: number): number {
    const prev = this.positions.get(key);
    return prev === undefined ? 0 : prev[0];
  }

  decode(key: number, world: number, dx: number, dy: number, dz: number): Vec3 {
    let prev = this.positions.get(key);
    if (prev === undefined) {
      prev = [world, 0, 0, 0];
      this.positions.set(key, prev);
    }
    prev[0] = world;
    prev[1] += dx;
    prev[2] += dy;
    prev[3] += dz;
    return { x: dequantize(prev[1]), y: dequantize(prev[2]), z: dequantize(prev[3]) };
  }

  decodeSmall(key: number, sx: number, sy: number, sz: number): Vec3 {
    let prev = this.positions.get(key);
    if (prev === undefined) {
      prev = [0, 0, 0, 0];
      this.positions.set(key, prev);
    }
    prev[1] += sx * SMALL_STEP;
    prev[2] += sy * SMALL_STEP;
    prev[3] += sz * SMALL_STEP;
    return { x: dequantize(prev[1]), y: dequantize(prev[2]), z: dequantize(prev[3]) };
  }

  storeBlock(world: number, pos: BlockPos): void {
    this.hasBlock = true;
    this.blockWorld = world;
    this.blockX = pos.x;
    this.blockY = pos.y;
    this.blockZ = pos.z;
  }

  /** Returns the packed BlockPos. */
  decodeBlock(dx: number, dy: number, dz: number): bigint {
    this.blockX = (this.blockX + dx) | 0;
    this.blockY = (this.blockY + dy) | 0;
    this.blockZ = (this.blockZ + dz) | 0;
    return blockPosAsLong(this.blockX, this.blockY, this.blockZ);
  }

  getBlockWorld(): number {
    return this.blockWorld;
  }

  // ---- writer side (PersonalPlayerTracker), ported for round-trip tests ----

  encode(key: number, world: number, x: number, y: number, z: number): Delta3 | null {
    const prev = this.positions.get(key);
    if (prev === undefined || prev[0] !== world) return null;
    const dx = quantize(x) - prev[1];
    const dy = quantize(y) - prev[2];
    const dz = quantize(z) - prev[3];
    if (!inShort(dx) || !inShort(dy) || !inShort(dz)) return null;
    prev[1] += dx;
    prev[2] += dy;
    prev[3] += dz;
    return [dx, dy, dz];
  }

  encodeSmall(key: number, world: number, x: number, y: number, z: number): Delta3 | null {
    const prev = this.positions.get(key);
    if (prev === undefined || prev[0] !== world) return null;
    const sx = Math.round((quantize(x) - prev[1]) / 16.0);
    const sy = Math.round((quantize(y) - prev[2]) / 16.0);
    const sz = Math.round((quantize(z) - prev[3]) / 16.0);
    if (!inByte(sx) || !inByte(sy) || !inByte(sz)) return null;
    prev[1] += sx * SMALL_STEP;
    prev[2] += sy * SMALL_STEP;
    prev[3] += sz * SMALL_STEP;
    return [sx, sy, sz];
  }

  encodeBlock(world: number, pos: BlockPos): Delta3 | null {
    if (!this.hasBlock || this.blockWorld !== world) return null;
    const dx = pos.x - this.blockX;
    const dy = pos.y - this.blockY;
    const dz = pos.z - this.blockZ;
    if (!inByte(dx) || !inByte(dy) || !inByte(dz)) return null;
    this.storeBlock(world, pos);
    return [dx, dy, dz];
  }
}
