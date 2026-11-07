import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/internals.ts';
import { MC_DATA as MC } from '../src/mc-data.ts';
import { w, buildChunk, dataOf, must } from './helpers.ts';

const UUID_A = '0123abcd-4567-89ef-8000-00000000000a';
const T = (name: string): number => must(P.TYPE_BY_NAME.get(name), name).id;

// Decoder output is checked field by field against untyped expectations.
function decodeOne(typeName: string, payload: Buffer, deltas = new P.DeltaPositions()): any {
  const def = must(P.TYPE_BY_NAME.get(typeName), typeName);
  const r = new P.Reader(payload);
  const out = P.DECODERS[def.factory](r, deltas);
  assert.equal(r.remaining, 0, `${typeName}: ${r.remaining} byte(s) left over`);
  return out;
}

// ------------------------------------------------------------------ Reader / numerics

test('Reader is big-endian and sign-aware', () => {
  const r = new P.Reader(Buffer.from([0xFF, 0xFF, 0x80, 0x00, 0xFF, 0xFF, 0xFF, 0xFE, 0x3F, 0x80, 0x00, 0x00, 0xFF]));
  assert.equal(r.peekI8(), -1);
  assert.equal(r.i8(), -1);
  assert.equal(r.u8(), 255);
  assert.equal(r.i16(), -32768);
  assert.equal(r.i32(), -2);
  assert.equal(r.f32(), 1);
  assert.equal(r.bool(), true);
  assert.throws(() => r.u8(), /underflow/);
  const r2 = new P.Reader(w().i64(-1n).u16(0xFFFE).i64(0x0123456789ABCDEFn).i64(-2n).bytes());
  assert.equal(r2.i64(), -1n);
  assert.equal(r2.u16(), 0xFFFE);
  assert.equal(r2.uuid(), '01234567-89ab-cdef-ffff-fffffffffffe');
});

test('rotation helpers follow Java float semantics', () => {
  assert.equal(P.convertValue(9000), Math.fround(90));
  assert.equal(P.convertValue(-18000), -180);
  assert.equal(P.convertRotation(190), P.convertRotation(-170));
  assert.equal(P.convertRotation(Number.NaN), 0);
  for (const raw of [0, 1, -1, 4500, -4500, 17999, -17999, 12345]) {
    assert.equal(P.convertRotation(P.convertValue(raw)), raw, `round trip ${raw}`);
  }
  // angleToByte only accepts shorts exactly representable as a byte angle.
  let accepted = 0;
  for (let b = -128; b <= 127; b++) {
    const enc = P.convertRotation(P.byteToAngle(b));
    const back = P.angleToByte(enc);
    assert.notEqual(back, null);
    assert.equal(P.convertRotation(P.byteToAngle(back!)), enc);
    accepted++;
  }
  assert.equal(accepted, 256);
  assert.equal(P.angleToByte(1), null);
});

test('BlockPos packing matches MC 1.16.1 layout', () => {
  for (const [x, y, z] of [[0, 0, 0], [1, 2, 3], [-1, -1, -1], [-30000000, 255, 29999999], [123456, -64, -654321]]) {
    const l = P.blockPosAsLong(x, y, z);
    assert.deepEqual(P.blockPosFromLong(l), { x, y, z });
  }
  assert.equal(P.blockPosAsLong(1, 0, 0), 1n << 38n);
  assert.equal(P.blockPosAsLong(0, 0, 1), 1n << 12n);
  assert.equal(P.blockPosAsLong(0, 1, 0), 1n);
});

// ------------------------------------------------------------------ format / ticks

test('format marker: 0x83 -> 3 (consumed), non-negative -> 0 (not consumed)', () => {
  const r = new P.Reader(Buffer.from([0x83, 0x05]));
  assert.equal(P.readFormat(r), 3);
  assert.equal(r.pos, 1);
  const r0 = new P.Reader(Buffer.from([0x05]));
  assert.equal(P.readFormat(r0), 0);
  assert.equal(r0.pos, 0);
  assert.equal(P.readFormat(new P.Reader(Buffer.alloc(0))), 0);
  const r7 = new P.Reader(Buffer.from([0x87, 0x00]));
  assert.equal(P.readFormat(r7), 7);
});

test('tick decoding: deltas, 0xFF escapes (incl. going backwards) and per-chunk reset', () => {
  const held = (slot: number) => w().i8(slot).bytes();
  const state = new P.TrackerState();
  const c1 = buildChunk(UUID_A, [
    { type: T('PLAYER_HELD_SLOT'), tick: 0, payload: held(0) },
    { type: T('PLAYER_HELD_SLOT'), tick: 10, payload: held(1) },
    { type: T('PLAYER_HELD_SLOT'), tick: 1000, payload: held(2) },
    { type: T('PLAYER_HELD_SLOT'), tick: 1001, payload: held(3) },
    { type: T('PLAYER_HELD_SLOT'), tick: 990, payload: held(4) },
    { type: T('PLAYER_HELD_SLOT'), tick: 991, payload: held(5) },
  ]);
  const a = P.decodeChunk(c1, state);
  assert.equal(a.uuid, UUID_A);
  assert.deepEqual(a.records.map((r) => r.tick), [0, 10, 1000, 1001, 990, 991]);
  // Next chunk starts at decodedTick = 0 again: a plain delta of 5 means tick 5.
  const c2 = Buffer.concat([w().uuid(UUID_A).u8(0x83).u8(T('PLAYER_HELD_SLOT')).u8(5).i8(0).bytes()]);
  assert.deepEqual(P.decodeChunk(c2, state).records.map((r) => r.tick), [5]);
});

test('legacy format 0 records: int32 tick and LegacyTimeLineType ids', () => {
  const chunk = buildChunk(UUID_A, [
    { type: 30, tick: 77, payload: w().i8(1).bytes() }, // legacy PLAYER_PAUSE
    { type: 25, tick: 78, payload: w().u8(0).bytes() }, // DEBUG_DRAGON_REFRESH -> EMPTY
  ], { format: 0 });
  const { records } = P.decodeChunk(chunk, new P.TrackerState());
  assert.deepEqual(records.map((r) => [r.tick, r.type, r.wireType, r.legacy]), [
    [77, 'PLAYER_PAUSE', 'PLAYER_PAUSE', true],
    [78, 'EMPTY', 'DEBUG_DRAGON_REFRESH', true],
  ]);
});

test('unknown type id and unsupported format raise descriptive errors', () => {
  const bad = w().uuid(UUID_A).u8(0x83).u8(T('PLAYER_HELD_SLOT')).u8(0).i8(1).u8(99).u8(0).bytes();
  assert.throws(() => P.decodeChunk(bad, new P.TrackerState()), (e: any) => e.offset === 20 && e.typeId === 99 && /Unknown replay timeline id 99/.test(e.message));
  const fmt = w().uuid(UUID_A).u8(0x81).u8(0).u8(0).bytes();
  assert.throws(() => P.decodeChunk(fmt, new P.TrackerState()), /Unsupported replay record format 1/);
});

// ------------------------------------------------------------------ DeltaPositions

test('DeltaPositions encode/decode round trip (int16 deltas)', () => {
  const enc = new P.DeltaPositions();
  const dec = new P.DeltaPositions();
  const path: [number, number, number][] = [[100.25, 64, -200.5], [100.5, 64.1, -200.25], [107.9, 63.0, -199], [100, 70, -205]];
  enc.store(P.PLAYER_KEY, 1, ...path[0]);
  dec.store(P.PLAYER_KEY, 1, ...path[0]);
  for (const p of path.slice(1)) {
    const d = enc.encode(P.PLAYER_KEY, 1, ...p);
    assert.ok(d, `encodable ${p}`);
    const got = dec.decode(P.PLAYER_KEY, dec.getWorld(P.PLAYER_KEY), ...d!);
    assert.deepEqual([got.x, got.y, got.z], p.map((v) => P.dequantize(P.quantize(v))));
  }
  assert.equal(enc.encode(P.PLAYER_KEY, 1, 10000, 0, 0), null, 'out of int16 range');
  assert.equal(enc.encode(P.PLAYER_KEY, 2, 100, 70, -210), null, 'world change');
  assert.equal(new P.DeltaPositions().encode(5, 0, 0, 0, 0), null, 'no previous');
});

test('DeltaPositions encodeSmall/decodeSmall round trip (int8 steps of 16)', () => {
  const enc = new P.DeltaPositions();
  const dec = new P.DeltaPositions();
  enc.store(42, 0, 10, 20, 30);
  dec.store(42, 0, 10, 20, 30);
  for (const p of [[10.1, 20, 30.2], [10.3, 19.8, 30.21], [10.0, 19.9, 30]] as [number, number, number][]) {
    const s = enc.encodeSmall(42, 0, ...p);
    assert.ok(s);
    const got = dec.decodeSmall(42, ...s!);
    assert.deepEqual([got.x, got.y, got.z], must(enc.positions.get(42)).slice(1).map(P.dequantize));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs([got.x, got.y, got.z][i] - p[i]) <= 9 / 4096);
  }
  assert.equal(enc.encodeSmall(42, 0, 20, 20, 30), null);
  // decodeSmall with no previous entry starts at 0 in OVERWORLD.
  const fresh = new P.DeltaPositions();
  assert.deepEqual(fresh.decodeSmall(7, 1, 2, 3), { x: 16 / 4096, y: 32 / 4096, z: 48 / 4096 });
  assert.equal(fresh.getWorld(7), 0);
});

test('DeltaPositions block deltas and reset semantics', () => {
  const enc = new P.DeltaPositions();
  const dec = new P.DeltaPositions();
  assert.equal(enc.encodeBlock(0, { x: 1, y: 2, z: 3 }), null);
  enc.storeBlock(1, { x: 100, y: 64, z: -100 });
  dec.storeBlock(1, { x: 100, y: 64, z: -100 });
  const d = enc.encodeBlock(1, { x: 101, y: 60, z: -227 });
  assert.deepEqual(d, [1, -4, -127]);
  assert.deepEqual(P.blockPosFromLong(dec.decodeBlock(...d)), { x: 101, y: 60, z: -227 });
  assert.equal(enc.encodeBlock(1, { x: 300, y: 60, z: -227 }), null);
  dec.store(5, 0, 1, 2, 3);
  dec.reset();
  assert.equal(dec.positions.size, 0);
  assert.equal(dec.hasBlock, false);
  // Like Java, reset() keeps the last block world/position.
  assert.equal(dec.getBlockWorld(), 1);
  assert.deepEqual(P.blockPosFromLong(dec.decodeBlock(0, 0, 0)), { x: 101, y: 60, z: -227 });
});

test('delta records chain within a chunk and use the per-UUID DeltaPositions', () => {
  const chunk = buildChunk(UUID_A, [
    { type: T('PLAYER_POSITION_POS'), tick: 1, payload: w().i8(1).f32(8).f32(70).f32(-8).bytes() },
    { type: T('PLAYER_POSITION_POS_DELTA'), tick: 2, payload: w().i16(4096).i16(-2048).i16(1).bytes() },
    { type: T('PLAYER_POSITION_DELTA'), tick: 3, payload: w().i16(4096).i16(0).i16(0).i16(9000).i16(-4500).bytes() },
    { type: T('BLOCK_BREAK'), tick: 4, payload: w().i8(1).i64(P.blockPosAsLong(5, 6, 7)).bytes() },
    { type: T('BLOCK_PROGRESS_DELTA'), tick: 5, payload: w().i8(1).i8(-1).i8(0).i8(3).bytes() },
    { type: T('BLOCK_UPDATE_DELTA'), tick: 6, payload: w().i8(0).i8(0).i8(1).u16(0xFFFF).i8(0).bytes() },
  ]);
  const { records } = P.decodeChunk(chunk, new P.TrackerState());
  assert.deepEqual(records.map((r) => r.type), ['PLAYER_POSITION_POS', 'PLAYER_POSITION_POS', 'PLAYER_POSITION', 'BLOCK_BREAK', 'BLOCK_PROGRESS', 'BLOCK_UPDATE']);
  assert.deepEqual(records.map((r) => r.wireType).slice(1, 3), ['PLAYER_POSITION_POS_DELTA', 'PLAYER_POSITION_DELTA']);
  assert.deepEqual(records[1].data, { x: 9, y: 69.5, z: P.dequantize(-8 * 4096 + 1), delta: [4096, -2048, 1] });
  assert.equal(records[1].world, 'NETHER');
  const look = dataOf(records[2], 'PLAYER_POSITION');
  assert.deepEqual([look.x, look.yaw, look.pitch], [10, 90, -45]);
  const progress = dataOf(records[4], 'BLOCK_PROGRESS');
  assert.deepEqual([progress.x, progress.y, progress.z, progress.progress, records[4]!.world], [6, 5, 7, 3, 'NETHER']);
  const update = dataOf(records[5], 'BLOCK_UPDATE');
  assert.deepEqual([update.x, update.y, update.z, update.rawBlockState, update.eventType], [6, 5, 8, 65535, 'PLACE']);
});

// ------------------------------------------------------------------ per-type payloads

const PAYLOADS: [type: string, payload: Buffer, expected: unknown, world?: string][] = [
  ['PLAYER_RIDE', w().i32(-2).bytes(), { vehicleId: -2, riding: true }],
  ['PLAYER_USE', w().i8(6).bytes(), { state: 6, usingHand: 'OFF_HAND', finished: true }],
  ['PLAYER_STATS', w().u8(200).u8(4).u8(18).i8(-1).bytes(), { health: 200, absorption: 4, food: 18, air: -1 }],
  ['PLAYER_EFFECT', w().u8(1).u8(255).u16(65535).bytes(), { effectId: 1, amplifier: 255, duration: 65535 }],
  ['PLAYER_CONTAINER', w().u8(255).u8(27).u8((2 << 2) | 2).i64(P.blockPosAsLong(1, 2, 3)).i64(P.blockPosAsLong(-4, 5, -6)).bytes(),
    { containerType: -1, slotCount: 27, positions: [{ x: 1, y: 2, z: 3 }, { x: -4, y: 5, z: -6 }] }, 'END'],
  ['PLAYER_SWING', w().i8(1).bytes(), { hand: 'OFF_HAND' }],
  ['PLAYER_PIE_CHART', w().u8(3).u8(2).u8(1).u8(0x81).u8(0x07).u8(0).u8(100)
    .u8(0).u8(3).raw(Buffer.from('abc')).u8(0).u8(40)
    .u8(4).u8(1).u8(60).bytes(),
  { timings: [{ name: `root\u001e${P.PIE_CHART_NAMES[262]}`, parent: 0, total: 100 }, { name: 'abc', parent: 0, total: 40 }, { name: 'ai', parent: 1, total: 60 }] }],
  ['CHEST_ANIMATION', w().i8(0).i64(P.blockPosAsLong(1, 2, 3)).i8(1).bytes(), { x: 1, y: 2, z: 3, open: true }, 'OVERWORLD'],
  ['ENTITY_DAMAGE', w().i8(0).i32(9).i32(-6).bytes(), { entityId: 9, attackerId: -6, attacker: 'PLAYER', attackSound: 'CRITICAL', knockback: true }],
  ['ENTITY_DAMAGE', w().i8(0).i32(9).i32(1234).bytes(), { entityId: 9, attackerId: 1234, attacker: 'ENTITY' }],
  ['ENTITY_REMOVE', w().i8(1).i32(3).i8(1).bytes(), { entityId: 3, death: true }, 'NETHER'],
  ['PIGLIN_STATE', w().i8(1).i32(3).i8(2).i8(5).i16(-1).i16(700).bytes(), { entityId: 3, state: 'ADMIRING', flags: 5, offHand: -1, mainHand: 700 }],
  ['ITEM_ENTITY', w().i8(0).f32(1.5).f32(2).f32(3).i32(77).u16(600).u8(0x80).u8(4).bytes(),
    { entityId: 77, itemRawId: 600, count: 1, glint: true, variant: 4, x: 1.5, y: 2, z: 3 }],
  ['ITEM_PICKUP', w().i8(0).i32(1).i32(2).i8(16).bytes(), { itemEntityId: 1, collectorId: 2, count: 16 }],
  ['INVENTORY_SLOT', w().u8(99).u16(40000).u8(200).u8(255).u8(0).u8((1 << 6) | 2).u16(0x0103).u16(0x2201).bytes(),
    { slot: 99, itemId: 40000, count: 200, durability: 255, variant: 0, crossbow: 1, enchantments: [{ id: 1, level: 3 }, { id: 0x22, level: 1 }] }],
  ['DRAGON_HEALTH_UPDATE', w().i8(72).bytes(), { health: 200 }],
  ['DRAGON_ZERO', w().i8(1).bytes(), { flewAway: true, spawnYaw: 0, node: -1, target: { x: 0, y: 0, z: 0 }, clockwise: false }],
  ['DRAGON_ZERO', w().i8(0).f32(45).i8(3).f32(1).f32(2).f32(3).i8(1).bytes(), { flewAway: false, spawnYaw: 45, node: 3, target: { x: 1, y: 2, z: 3 }, clockwise: true }],
  ['DRAGON_DAMAGE', w().i8(3).u16(1250).bytes(), { source: 'EXPLOSION', amount: Math.fround(12.5) }],
  ['DRAGON_TARGET', w().i8(0).bytes(), { target: null }],
  ['DRAGON_PATH', w().i8(2).u8(2).u8(4).u8(255).i64(P.blockPosAsLong(0, 70, 0)).bytes(), { phase: 2, nodes: [{ node: 4 }, { node: 255, pos: { x: 0, y: 70, z: 0 } }] }],
  ['DRAGON_DEATH_PROGRESS', w().i16(150).i8(1).bytes(), { progress: 150, phase: 1 }],
  ['WORLD_TIME', w().i64(0x7FFFFFFFFFFFFFFFn).bytes(), { timeOfDay: '9223372036854775807' }],
  ['PIGLIN_BARTER', w().i8(1).i32(8).u8(2).u16(700).u8(1).u16(65535).u8(255).bytes(), { entityId: 8, loot: [{ itemRawId: 700, count: 1 }, { itemRawId: 65535, count: 255 }] }],
];

test('per-type payloads decode exactly', async (t) => {
  for (const [type, payload, expected, world] of PAYLOADS) {
    await t.test(type, () => {
      const out = decodeOne(type, payload);
      assert.deepEqual(out.data, expected);
      if (world) assert.equal(P.WORLDS[out.world], world);
    });
  }
});

test('projectile packed fields', () => {
  const out = decodeOne('PROJECTILE_ENTITY', w().i8(0).f32(0).f32(1).f32(2).i16(100).i16(-100).i32(5)
    .f64(0.5).f64(-0.25).f64(1).i32((1 << 24) | (37 << 16) | 0x1234).u8(0x80 | 10).bytes()).data;
  assert.equal(out.entityTypeId, 0x1234);
  assert.equal(out.potion, 37);
  assert.equal(out.lingering, true);
  assert.equal(out.followsRecord, true);
  assert.equal(out.soundPlayType, 'PLAYER_PEARL_THROW');
  assert.deepEqual(out.velocity, { x: 0.5, y: -0.25, z: 1 });
  assert.throws(() => decodeOne('PROJECTILE_ENTITY', w().i8(0).f32(0).f32(0).f32(0).i16(0).i16(0).i32(0).f64(0).f64(0).f64(0).i32(0).u8(13).bytes()), /SoundPlayType/);
});

test('small-delta entity move uses byte angles and the stored entity world', () => {
  const d = new P.DeltaPositions();
  decodeOne('ENTITY_MOVE_POS', w().i8(2).f32(1).f32(2).f32(3).i32(11).bytes(), d);
  const out = decodeOne('ENTITY_MOVE_SMALL_DELTA', w().i8(16).i8(0).i8(-16).i8(64).i8(-32).i32(11).bytes(), d);
  assert.equal(P.WORLDS[out.world], 'END');
  assert.deepEqual([out.data.x, out.data.y, out.data.z], [1.0625, 2, 2.9375]);
  assert.equal(out.data.yawRaw, P.convertRotation(P.byteToAngle(64)));
  assert.equal(Math.round(out.data.yaw), 90);
  assert.equal(Math.round(out.data.pitch), -45);
});

test('legacy factories', () => {
  const run = (legacyId: number, payload: Buffer): any => {
    const def = must(P.LEGACY_BY_ID.get(legacyId));
    const r = new P.Reader(payload);
    const out = P.DECODERS[must(def.factory)]!(r, new P.DeltaPositions());
    assert.equal(r.remaining, 0);
    return out;
  };
  assert.deepEqual(run(19, w().i8(1).bytes()).data, { vehicleId: -2, riding: true });
  const v1 = run(5, w().i8(1).i64(P.blockPosAsLong(1, 2, 3)).i32(99).i8(7).bytes());
  assert.deepEqual(v1.data, { x: 1, y: 2, z: 3, rawBlockState: 99, eventType: 'UPDATE', stateValue: 3, eventData: 7 });
  assert.throws(() => run(5, w().i8(1).i64(0).i32(0).i8(-1).bytes()), /EventType/);
  const equip = run(15, w().i32(0x10001).i8(5).i8(1).bytes());
  assert.deepEqual(equip.data, { slot: 39, itemId: 1, count: 1, durability: 255, variant: 0, crossbow: 0, enchantments: [{ id: 0, level: 1 }], legacyEquipmentSlot: 'HEAD' });
  assert.equal(run(15, w().i32(0).i8(0).i8(1).bytes()).data.count, 0);
  const item = run(20, w().i8(0).f32(1).f32(2).f32(3).i16(5).i16(6).i32(42).f64(0).f64(0).f64(0).i32(800).bytes());
  assert.deepEqual(item.data, { entityId: 42, itemRawId: 800, count: 1, glint: false, variant: 0, x: 1, y: 2, z: 3 });
});

test('out-of-range world ordinal throws', () => {
  assert.throws(() => decodeOne('PLAYER_POSITION_LOOK', w().i8(3).i16(0).i16(0).bytes()), /WorldTypes ordinal 3/);
});

// ------------------------------------------------------------------ MC 1.16.1 data / names

test('MC 1.16.1 data: registries and block states', () => {
  assert.equal(MC.minecraft, '1.16.1');
  assert.equal(MC.registries.item[0], 'air');
  assert.equal(MC.registries.mob_effect[1], 'speed');
  assert.equal(MC.registries.enchantment[0], 'protection');
  assert.equal(P.STATE_COUNT, 17104);
  assert.equal(P.blockState(0), 'air');
  assert.equal(P.blockState(1), 'stone');
  assert.equal(P.blockState(8), 'grass_block[snowy=true]');
  assert.equal(P.blockState(9), 'grass_block[snowy=false]');
  assert.equal(P.blockState(-1), null);
  assert.equal(P.blockState(17104), null);
  const [name, first, props] = must(MC.blocks.find((b) => b[0] === 'oak_stairs'));
  assert.deepEqual(must(props).map((p) => p[0]), ['facing', 'half', 'shape', 'waterlogged']);
  assert.equal(P.blockState(first), 'oak_stairs[facing=north,half=top,shape=straight,waterlogged=true]');
  assert.equal(P.blockState(first + 1), 'oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]');
  assert.equal(P.blockState(first + 2), 'oak_stairs[facing=north,half=top,shape=inner_left,waterlogged=true]');
  assert.equal(name, 'oak_stairs');
});

test('names annotator: entities, mob state, items, enchantments, containers, phases', () => {
  const R = MC.registries;
  const id = (reg: keyof typeof R, n: string) => { const i = R[reg].indexOf(n); assert.ok(i >= 0, n); return i; };
  const a = new P.NameAnnotator();
  const rec = (type: string, data: object) => a.annotate({ type, data } as any);

  assert.deepEqual(rec('ENTITY_ADD', { entityId: 1, entityTypeId: id('entity_type', 'zombie'), customData: -id('item', 'iron_sword') }),
    { entityType: 'zombie', baby: true, mainHand: 'iron_sword' });
  assert.deepEqual(rec('ENTITY_ADD', { entityId: 2, entityTypeId: id('entity_type', 'zombie'), customData: -2147483648 }),
    { entityType: 'zombie', baby: true, mainHand: 'air' });
  assert.deepEqual(rec('ENTITY_ADD', { entityId: 3, entityTypeId: id('entity_type', 'slime'), customData: 4 }), { entityType: 'slime', size: 4 });
  assert.deepEqual(rec('ENTITY_ADD', { entityId: 4, entityTypeId: id('entity_type', 'tnt'), customData: 80 }), { entityType: 'tnt', fuse: 80 });
  assert.deepEqual(rec('ENTITY_ADD', { entityId: 5, entityTypeId: id('entity_type', 'falling_block'), customData: 1 }), { entityType: 'falling_block', block: 'stone' });
  assert.deepEqual(rec('ENTITY_ADD', { entityId: 6, entityTypeId: id('entity_type', 'boat'), customData: 2 }), { entityType: 'boat', boatType: 'BIRCH' });
  rec('ENTITY_ADD', { entityId: 7, entityTypeId: id('entity_type', 'villager'), customData: 0 });
  rec('ENTITY_ADD', { entityId: 8, entityTypeId: id('entity_type', 'sheep'), customData: 0 });
  rec('ENTITY_ADD', { entityId: 9, entityTypeId: id('entity_type', 'enderman'), customData: 0 });

  const villager = id('villager_type', 'plains') | (id('villager_profession', 'farmer') << 8) | (3 << 16);
  assert.deepEqual(rec('MOB_STATE', { entityId: 7, state: villager }), { entityType: 'villager', villagerType: 'plains', profession: 'farmer', level: 3 });
  assert.deepEqual(rec('MOB_STATE', { entityId: 8, state: 14 | 0x100 }), { entityType: 'sheep', color: 'RED', sheared: true });
  assert.deepEqual(rec('MOB_STATE', { entityId: 9, state: 1 }), { entityType: 'enderman', angry: true });
  assert.deepEqual(rec('MOB_STATE', { entityId: 9, state: -2147483648 }), { entityType: 'enderman' });
  assert.deepEqual(rec('ENTITY_REMOVE', { entityId: 1, death: true }), { entityType: 'zombie' });
  assert.equal(rec('ENTITY_REMOVE', { entityId: 999, death: true }), null);

  assert.deepEqual(rec('INVENTORY_SLOT', { itemId: id('item', 'diamond_sword'), variant: 0, enchantments: [{ id: id('enchantment', 'sharpness'), level: 5 }] }),
    { item: 'diamond_sword', enchantments: [{ enchantment: 'sharpness', level: 5 }] });
  assert.deepEqual(rec('INVENTORY_SLOT', { itemId: id('item', 'suspicious_stew'), variant: 0, enchantments: [{ id: 1, level: 8 }] }),
    { item: 'suspicious_stew', enchantments: [{ effect: 'speed', seconds: 8 }] });
  assert.deepEqual(rec('INVENTORY_SLOT', { itemId: id('item', 'potion'), variant: id('potion', 'fire_resistance'), enchantments: [] }),
    { item: 'potion', potion: 'fire_resistance' });
  assert.deepEqual(rec('ITEM_ENTITY', { entityId: 20, itemRawId: id('item', 'ender_pearl'), variant: 0 }), { item: 'ender_pearl', entityType: 'item' });
  assert.deepEqual(rec('ITEM_PICKUP', { itemEntityId: 20, collectorId: 1, count: 1 }), { itemEntityType: 'item', collectorType: 'zombie' });
  assert.deepEqual(rec('PROJECTILE_ENTITY', { entityId: 21, entityTypeId: id('entity_type', 'potion'), potion: id('potion', 'healing') }),
    { entityType: 'potion', potion: 'healing' });
  assert.deepEqual(rec('PIGLIN_BARTER', { entityId: 30, loot: [{ itemRawId: id('item', 'obsidian'), count: 1 }] }), { loot: ['obsidian'] });
  assert.deepEqual(rec('PIGLIN_STATE', { entityId: 30, offHand: id('item', 'gold_ingot'), mainHand: id('item', 'golden_sword') }),
    { offHand: 'gold_ingot', mainHand: 'golden_sword' });

  assert.deepEqual(rec('PLAYER_CONTAINER', { containerType: -2 }), { container: 'inventory' });
  assert.deepEqual(rec('PLAYER_CONTAINER', { containerType: -1 }), { container: 'closed' });
  assert.deepEqual(rec('PLAYER_CONTAINER', { containerType: id('menu', 'generic_9x3') }), { container: 'generic_9x3' });
  assert.deepEqual(rec('PLAYER_EFFECT', { effectId: 1 }), { effect: 'speed' });
  assert.deepEqual(rec('PLAYER_POSE', { pose: 5 }), { pose: 'CROUCHING' });
  assert.deepEqual(rec('PLAYER_PERSPECTIVE', { perspective: 1 }), { perspective: 'THIRD_PERSON_BACK' });
  assert.deepEqual(rec('BLOCK_UPDATE', { rawBlockState: 9 }), { block: 'grass_block[snowy=false]' });
  assert.deepEqual(rec('DRAGON_PHASE', { phase: 3 }), { phase: 'LANDING' });
  assert.deepEqual(rec('DRAGON_PATH', { phase: 0, nodes: [] }), { phase: 'HOLDING_PATTERN' });
  assert.equal(rec('PLAYER_HELD_SLOT', { slot: 1 }), null);
  assert.deepEqual(rec('ITEM_ENTITY', { entityId: 22, itemRawId: 60000, variant: 0 }), { item: null, entityType: 'item' });
});

test('records get names during decoding unless names: false; type filter keeps entity tracking', () => {
  const zombie = MC.registries.entity_type.indexOf('zombie');
  const chunk = buildChunk(UUID_A, [
    { type: T('ENTITY_ADD'), tick: 1, payload: w().i8(0).f32(0).f32(0).f32(0).i16(0).i16(0).i32(77).i32(zombie).i32(0).bytes() },
    { type: T('ENTITY_REMOVE'), tick: 2, payload: w().i8(0).i32(77).i8(1).bytes() },
  ]);
  const state = new P.TrackerState();
  const recs = [...P.iterRecords(null, { opened: { chunks: [chunk], compressed: false, aesKey: null } as any })].map((x) => x.record);
  assert.deepEqual(recs.map((r) => r.names), [{ entityType: 'zombie', baby: false, mainHand: 'air' }, { entityType: 'zombie' }]);
  const plain = [...P.iterRecords(null, { names: false, opened: { chunks: [chunk], compressed: false, aesKey: null } as any })].map((x) => x.record);
  assert.ok(plain.every((r) => !('names' in r)));
  assert.ok(state.names instanceof P.NameAnnotator);
});
