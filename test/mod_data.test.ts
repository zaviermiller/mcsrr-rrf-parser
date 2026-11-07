// Checks data/mcsrranked.json against the hand-written names in src/types.ts and the decoders in
// src/decoders.ts. The JSON's factoryReads (read from the mod jar by datagen) are replayed through
// each decoder, so a decoder that reads a different layout than the mod writes fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/internals.ts';
import { MC_DATA as MC } from '../src/mc-data.ts';
import type {
  AttackSound, BlockEventType, DeltaRecordType, DragonDamageSource, LegacyRecordType, PiglinState, RecordType,
  SoundPlayType, World,
} from '../src/types.ts';

// `satisfies Record<Union, true>` makes the compiler check these lists are exactly the unions.
const RECORD_TYPES = Object.keys({
  EMPTY: true, PLAYER_SPAWN: true, PLAYER_POSITION: true, PLAYER_POSITION_LOOK: true, PLAYER_POSITION_POS: true,
  PLAYER_POSE: true, PLAYER_RIDE: true, PLAYER_PAUSE: true, PLAYER_REMOVE: true, PLAYER_PERSPECTIVE: true,
  PLAYER_STATS: true, PLAYER_USE: true, PLAYER_EFFECT: true, PLAYER_HELD_SLOT: true, PLAYER_CONTAINER: true,
  PLAYER_PORTAL: true, PLAYER_SWING: true, PLAYER_RENDER_DISTANCE: true, PLAYER_ATTACK_RESET: true,
  PLAYER_PIE_CHART: true, BLOCK_UPDATE: true, BLOCK_BREAK: true, BLOCK_REMOVE: true, BLOCK_PROGRESS: true,
  CHEST_ANIMATION: true, ENTITY_ADD: true, ENTITY_MOVE: true, ENTITY_MOVE_LOOK: true, ENTITY_MOVE_POS: true,
  ENTITY_DAMAGE: true, ENTITY_REMOVE: true, PIGLIN_STATE: true, MOB_STATE: true, ITEM_ENTITY: true,
  ITEM_PICKUP: true, PROJECTILE_ENTITY: true, INVENTORY_SLOT: true, DRAGON_MOVE: true, DRAGON_PHASE: true,
  DRAGON_HEALTH_UPDATE: true, DRAGON_CRYSTAL_UPDATE: true, DRAGON_DEATH: true, DRAGON_DEATH_PROGRESS: true,
  DRAGON_NODES: true, DRAGON_ZERO: true, DRAGON_DAMAGE: true, DRAGON_TARGET: true, DRAGON_PATH: true,
  EXPLOSION_EFFECT: true, AREA_EFFECT_CLOUD: true, WORLD_TIME: true, PIGLIN_BARTER: true,
} satisfies Record<RecordType, true>);
const DELTA_TYPES = Object.keys({
  PLAYER_POSITION_DELTA: true, PLAYER_POSITION_POS_DELTA: true, BLOCK_UPDATE_DELTA: true, BLOCK_BREAK_DELTA: true,
  BLOCK_REMOVE_DELTA: true, BLOCK_PROGRESS_DELTA: true, ENTITY_MOVE_DELTA: true, ENTITY_MOVE_POS_DELTA: true,
  ENTITY_MOVE_SMALL_DELTA: true, ENTITY_MOVE_POS_SMALL_DELTA: true, DRAGON_MOVE_DELTA: true,
} satisfies Record<DeltaRecordType, true>);
const LEGACY_TYPES = Object.keys({
  EMPTY: true, PLAYER_POSITION: true, PLAYER_POSITION_LOOK: true, PLAYER_POSITION_POS: true, PLAYER_SPAWN: true,
  BLOCK_UPDATE_V1: true, BLOCK_BREAK: true, BLOCK_REMOVE: true, ENTITY_ADD: true, ENTITY_REMOVE: true,
  ENTITY_MOVE: true, ENTITY_MOVE_LOOK: true, ENTITY_MOVE_POS: true, ENTITY_DAMAGE: true, PROJECTILE_ENTITY: true,
  ITEM_EQUIP: true, PLAYER_POSE: true, PLAYER_REMOVE: true, BLOCK_PROGRESS: true, PLAYER_RIDE: true,
  ITEM_ENTITY: true, DRAGON_HEALTH_UPDATE: true, DRAGON_CRYSTAL_UPDATE: true, DRAGON_MOVE: true, DRAGON_DEATH: true,
  DEBUG_DRAGON_REFRESH: true, DEBUG_PLAYER_FOLLOW: true, DEBUG_ENTITIES_REFRESH: true, BLOCK_UPDATE_V2: true,
  EXPLOSION_EFFECT: true, PLAYER_PAUSE: true, CHEST_ANIMATION: true,
} satisfies Record<LegacyRecordType, true>);
const ENUM_NAMES: Record<keyof P.ModEnums, string[]> = {
  BlockEventType: Object.keys({ PLACE: true, UPDATE: true } satisfies Record<BlockEventType, true>),
  DragonDamageSource: Object.keys({ PLAYER: true, ARROW: true, BED_ANCHOR: true, EXPLOSION: true, OTHER: true } satisfies Record<DragonDamageSource, true>),
  AttackSound: Object.keys({ SWEEP: true, CRITICAL: true, STRONG: true, WEAK: true } satisfies Record<AttackSound, true>),
  PiglinState: Object.keys({
    ROAMING: true, SEEKING: true, ADMIRING: true, ANGRY: true, BARTERING: true, AGGRO_LIGHT: true, AGGRO_HEAVY: true,
  } satisfies Record<PiglinState, true>),
  SoundPlayType: Object.keys({
    EMPTY: true, GHAST_FIREBALL: true, BLAZE_FIREBALL: true, ENTITY_TRIDENT: true, SHULKER_BULLET: true,
    DRAGON_FIREBALL: true, WITHER_SKULL: true, ENTITY_SHOT_CROSSBOW: true, SHOOT_SNOWBALL: true, FIREWORK_FIRE: true,
    PLAYER_PEARL_THROW: true, ENTITY_POTION_THROW: true, SHOOT_ARROW: true,
  } satisfies Record<SoundPlayType, true>),
};
const WORLDS = Object.keys({ OVERWORLD: true, NETHER: true, END: true } satisfies Record<World, true>);

const sorted = (xs: Iterable<string>) => [...xs].sort();
const D = P.MOD_DATA;

test('mod data names match the types in src/types.ts', () => {
  assert.deepEqual(sorted(D.timelineTypes.filter((t) => !t.storedAs).map((t) => t.name)), sorted(RECORD_TYPES));
  assert.deepEqual(sorted(D.timelineTypes.filter((t) => t.storedAs).map((t) => t.name)), sorted(DELTA_TYPES));
  assert.deepEqual(sorted(D.legacyTypes.map((t) => t.name)), sorted(LEGACY_TYPES));
  assert.deepEqual(sorted(Object.keys(D.enums)), sorted(Object.keys(ENUM_NAMES)));
  for (const [k, names] of Object.entries(ENUM_NAMES)) assert.deepEqual(sorted(D.enums[k as keyof P.ModEnums]), sorted(names), k);
  assert.deepEqual(sorted(D.worlds), sorted(WORLDS));
});

test('mod data is self-consistent and every factory has a decoder', () => {
  assert.match(D.modVersion, /^\d+\.\d+/);
  assert.equal(new Set(D.timelineTypes.map((t) => t.id)).size, D.timelineTypes.length);
  assert.equal(new Set(D.legacyTypes.map((t) => t.id)).size, D.legacyTypes.length);
  const canonical = new Set(D.timelineTypes.filter((t) => !t.storedAs).map((t) => t.name));
  const all = new Set(D.timelineTypes.map((t) => t.name));
  for (const t of D.timelineTypes) {
    assert.ok(P.DECODERS[t.factory], `${t.name}: no decoder ${t.factory}`);
    if (t.storedAs) assert.ok(canonical.has(t.storedAs), `${t.name} -> ${t.storedAs}`);
  }
  for (const t of D.legacyTypes) {
    assert.ok(all.has(t.canonical), `${t.name} -> ${t.canonical}`);
    if (t.factory) assert.ok(P.DECODERS[t.factory], `${t.name}: no decoder ${t.factory}`);
  }
  const used = new Set([...D.timelineTypes.map((t) => t.factory), ...D.legacyTypes.flatMap((t) => (t.factory ? [t.factory] : []))]);
  assert.deepEqual(sorted(Object.keys(D.factoryReads)), sorted(used));
  assert.ok(D.pieChartNames.length > 0);
  assert.deepEqual(P.ENUMS.Hand, MC.enums.Hand);
  assert.deepEqual(P.ENUMS.EquipmentSlot, MC.enums.EquipmentSlot);
});

// ------------------------------------------------------------------ decoder read sequences

type BufferOp = 'get' | 'getShort' | 'getInt' | 'getLong' | 'getFloat' | 'getDouble';
const OP_SIZES: Readonly<Record<BufferOp, number>> = { get: 1, getShort: 2, getInt: 4, getLong: 8, getFloat: 4, getDouble: 8 };
const READER_OPS = {
  i8: 'get', u8: 'get', i16: 'getShort', u16: 'getShort', i32: 'getInt', u32: 'getInt', i64: 'getLong', f32: 'getFloat', f64: 'getDouble',
} as const satisfies Partial<Record<keyof P.Reader, BufferOp>>;
// Leading bytes that make loops run once / take the long branch, so every read in the Java method runs.
const OP_SAMPLES: Readonly<Record<string, readonly number[]>> = {
  'PlayerContainerTimeLine.PlayerContainer': [0, 0, 1],
  'DragonNodesTimeLine.DragonNodes': [1],
  'DragonTargetTimeLine.DragonTarget': [1],
  'DragonPathTimeLine.DragonPath': [0, 1, 255],
  'PiglinBarterTimeLine.PiglinBarter': [0, 0, 0, 0, 0, 1],
  'InventorySlotTimeLine.InventorySlot': [0, 0, 0, 0, 0, 0, 1],
};
// PieChartNames.read is variable length, so this factory can't be replayed through its decoder; its
// sequence is pinned instead (decoders.ts pieChartName = PieChartNames.read).
const FIXED_READS: Readonly<Record<string, readonly string[]>> = {
  'PlayerPieChartTimeLine.PlayerPieChart': ['get', 'get', 'PieChartNames.read', 'PieChartNames.read', 'get', 'get'],
};

/** Runs a decoder on a buffer sized for `expected` and logs which ByteBuffer-equivalent reads it makes. */
function decoderReads(decoders: Readonly<Record<string, P.Decoder>>, ref: string, expected: readonly string[]): string[] {
  const buf = Buffer.alloc(expected.reduce((n, op) => n + (OP_SIZES[op as BufferOp] || 0), 0));
  Buffer.from(OP_SAMPLES[ref] || []).copy(buf);
  const r = new P.Reader(buf);
  const log: string[] = [];
  const methods = r as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const [k, op] of Object.entries(READER_OPS)) {
    const f = methods[k]!.bind(r);
    methods[k] = (...a) => { log.push(op); return f(...a); };
  }
  try {
    decoders[ref]!(r, new P.DeltaPositions());
  } catch (e) {
    log.push(`error: ${(e as Error).message}`);
  }
  if (r.remaining) log.push(`${r.remaining} byte(s) left unread`);
  return log;
}

function readMismatches(decoders: Readonly<Record<string, P.Decoder>>): string[] {
  const out: string[] = [];
  for (const [ref, expected] of Object.entries(D.factoryReads)) {
    const fixed = FIXED_READS[ref];
    const got = fixed ?? decoderReads(decoders, ref, expected);
    if (JSON.stringify(got) !== JSON.stringify(expected)) out.push(`${ref}: mod [${expected.join(' ')}] vs decoder [${got.join(' ')}]`);
  }
  return out;
}

test('every decoder reads exactly what the mod writes (factoryReads)', () => {
  assert.deepEqual(readMismatches(P.DECODERS), []);
});

test('the read check catches a decoder with the wrong layout', () => {
  const broken = { ...P.DECODERS, 'MobStateTimeLine.MobState': ((r: P.Reader) => { r.i8(); r.i32(); return {}; }) as unknown as P.Decoder };
  const diffs = readMismatches(broken);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0]!, /^MobStateTimeLine\.MobState: /);
});
