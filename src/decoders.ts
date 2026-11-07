// Ports of every *Factory.getFromBytes(ByteBuffer[, DeltaPositions]) under
// anticheat/replay/format/timelines/**. Java evaluates constructor arguments left to right, so
// reads happen in the order written here. Each decoder returns { world, data } where world is
// a WorldTypes ordinal (or null when the timeline has none). The data shapes are documented as
// RecordDataMap in types.ts.
import { DecodeError, convertValue, convertRotation, byteToAngle, blockPosFromLong, longOut } from './binary.ts';
import type { Reader } from './binary.ts';
import { PLAYER_KEY, DRAGON_KEY } from './deltas.ts';
import type { DeltaPositions } from './deltas.ts';
import { WORLDS, ENUMS, PIE_CHART_NAMES } from './lookup.ts';
import type { BlockPos, Rotation, Vec3 } from './types.ts';

export interface Decoded {
  /** WorldTypes ordinal, or null when the timeline has none. */
  world: number | null;
  data: object;
}
export type Decoder = (r: Reader, d: DeltaPositions) => Decoded;
type Extra = ((r: Reader) => object) | null;

function enumAt<T>(values: readonly T[], index: number, what: string): T {
  if (index < 0 || index >= values.length) {
    throw new DecodeError(`${what} ordinal ${index} out of range (0..${values.length - 1})`);
  }
  return values[index];
}

/** WorldTypes.values()[buffer.get()] */
function world(r: Reader): number {
  const w = r.i8();
  enumAt(WORLDS, w, 'WorldTypes');
  return w;
}

const vec3f = (r: Reader): Vec3 => ({ x: r.f32(), y: r.f32(), z: r.f32() });
const vec3d = (r: Reader): Vec3 => ({ x: r.f64(), y: r.f64(), z: r.f64() });
const rotation = (yawRaw: number, pitchRaw: number): Rotation => ({ yaw: convertValue(yawRaw), pitch: convertValue(pitchRaw), yawRaw, pitchRaw });
const blockPos = (packed: bigint): BlockPos => blockPosFromLong(packed);

/** RotationTimeLine(float yaw, float pitch) constructor path. */
const rotationFromFloats = (yaw: number, pitch: number): Rotation => rotation(convertRotation(yaw), convertRotation(pitch));

/** PieChartNames.read */
export function pieChartName(r: Reader): string {
  const first = r.u8();
  const id = first < 128 ? first : ((first & 127) << 8) | r.u8();
  if (id !== 0) {
    if (id - 1 >= PIE_CHART_NAMES.length) throw new DecodeError(`pie chart name id ${id} out of range`);
    return PIE_CHART_NAMES[id - 1];
  }
  return r.bytes(r.u8()).toString('utf8');
}

function attacker(attackerId: number): { attacker: 'NONE' | 'PLAYER' | 'ENTITY'; attackSound?: string; knockback?: boolean } {
  if (attackerId === -1) return { attacker: 'NONE' };
  if (attackerId === -2) return { attacker: 'PLAYER' };
  const code = -3 - attackerId;
  if (code >= 0 && code < ENUMS.AttackSound.length * 2) {
    return { attacker: 'PLAYER', attackSound: ENUMS.AttackSound[code >> 1], knockback: (code & 1) !== 0 };
  }
  return { attacker: 'ENTITY' };
}

// Absolute block timelines seed DeltaPositions with storeBlock (ChestAnimation does not).
function absBlock(extra: Extra): Decoder {
  return (r, d) => {
    const w = world(r);
    const packed = r.i64();
    const data = { ...blockPos(packed), ...(extra ? extra(r) : {}) };
    d.storeBlock(w, data);
    return { world: w, data };
  };
}

// BlockDeltaTimeLine.Factory: decodeBlock(get, get, get) then decode(getBlockWorld(), pos, buffer).
function deltaBlock(extra: Extra): Decoder {
  return (r, d) => {
    const dx = r.i8(); const dy = r.i8(); const dz = r.i8();
    const packed = d.decodeBlock(dx, dy, dz);
    const w = d.getBlockWorld();
    return { world: w, data: { ...blockPos(packed), ...(extra ? extra(r) : {}), delta: [dx, dy, dz] } };
  };
}

const blockUpdateV2Extra = (state: number, placed: number) => ({
  rawBlockState: state,
  eventType: enumAt(ENUMS.BlockEventType, placed, 'BlockUpdateTimeLineV2.EventType'),
});

export const DECODERS: Readonly<Record<string, Decoder>> = {
  // ---- player ----
  'EmptyTimeLine.Empty': (r) => { r.u8(); return { world: null, data: {} }; },
  'PlayerSpawnTimeLine.PlayerSpawn': (r) => {
    const w = world(r); const p = vec3f(r); const yaw = r.i16(); const pitch = r.i16();
    return { world: w, data: { ...p, ...rotation(yaw, pitch) } };
  },
  'PlayerPositionTimeLine.PlayerPosition': (r, d) => {
    const w = world(r); const p = vec3f(r); const yaw = r.i16(); const pitch = r.i16();
    d.store(PLAYER_KEY, w, p.x, p.y, p.z);
    return { world: w, data: { ...p, ...rotation(yaw, pitch) } };
  },
  'PlayerPositionLookTimeLine.PlayerPositionLook': (r) => {
    const w = world(r); const yaw = r.i16(); const pitch = r.i16();
    return { world: w, data: rotation(yaw, pitch) };
  },
  'PlayerPositionPosTimeLine.PlayerPositionPos': (r, d) => {
    const w = world(r); const p = vec3f(r);
    d.store(PLAYER_KEY, w, p.x, p.y, p.z);
    return { world: w, data: p };
  },
  'PlayerPoseTimeLine.PlayerPose': (r) => ({ world: null, data: { pose: r.i8() } }),
  'PlayerRideTimeLine.PlayerRide': (r) => {
    const vehicleId = r.i32();
    return { world: null, data: { vehicleId, riding: vehicleId !== -1 } };
  },
  'PlayerRideTimeLine.LegacyPlayerRide': (r) => {
    const vehicleId = r.i8() !== 0 ? -2 : -1;
    return { world: null, data: { vehicleId, riding: vehicleId !== -1 } };
  },
  'PlayerPauseTimeLine.PlayerPause': (r) => ({ world: null, data: { paused: r.bool() } }),
  'PlayerRemoveTimeLine.PlayerRemove': (r) => {
    const w = world(r);
    return { world: w, data: { death: r.i8() === 1 } };
  },
  'PlayerPerspectiveTimeLine.PlayerPerspective': (r) => ({ world: null, data: { perspective: r.i8() } }),
  'PlayerStatsTimeLine.PlayerStats': (r) => ({
    world: null,
    data: { health: r.u8(), absorption: r.u8(), food: r.u8(), air: r.i8() },
  }),
  'PlayerUseTimeLine.PlayerUse': (r) => {
    const state = r.i8();
    // USE_MAIN_HAND = 1, USE_OFF_HAND = 2, HAND_MASK = 3, finished bit = 4
    const usingHand = ['NONE', 'MAIN_HAND', 'OFF_HAND', 'UNKNOWN'][state & 3];
    return { world: null, data: { state, usingHand, finished: (state & 4) !== 0 } };
  },
  'PlayerEffectTimeLine.PlayerEffect': (r) => ({
    world: null,
    data: { effectId: r.u8(), amplifier: r.u8(), duration: r.u16() },
  }),
  'PlayerHeldSlotTimeLine.PlayerHeldSlot': (r) => ({ world: null, data: { slot: r.i8() } }),
  'PlayerPositionDeltaTimeLine.PlayerPositionDelta': (r, d) => {
    const dx = r.i16(); const dy = r.i16(); const dz = r.i16(); const yaw = r.i16(); const pitch = r.i16();
    const w = d.getWorld(PLAYER_KEY);
    const p = d.decode(PLAYER_KEY, w, dx, dy, dz);
    return { world: w, data: { ...p, ...rotation(yaw, pitch), delta: [dx, dy, dz] } };
  },
  'PlayerPositionPosDeltaTimeLine.PlayerPositionPosDelta': (r, d) => {
    const dx = r.i16(); const dy = r.i16(); const dz = r.i16();
    const w = d.getWorld(PLAYER_KEY);
    const p = d.decode(PLAYER_KEY, w, dx, dy, dz);
    return { world: w, data: { ...p, delta: [dx, dy, dz] } };
  },
  'PlayerContainerTimeLine.PlayerContainer': (r) => {
    const containerType = r.u8(); const slotCount = r.u8(); const packed = r.u8();
    const positions: BlockPos[] = [];
    for (let i = 0; i < (packed & 3); i++) positions.push(blockPos(r.i64()));
    const decoded = containerType === 255 ? -1 : (containerType === 254 ? -2 : containerType);
    const w = packed >> 2;
    enumAt(WORLDS, w, 'WorldTypes');
    return { world: w, data: { containerType: decoded, slotCount, positions } };
  },
  'PlayerPortalTimeLine.PlayerPortal': (r) => ({ world: null, data: { inPortal: r.bool() } }),
  'PlayerSwingTimeLine.PlayerSwing': (r) => ({ world: null, data: { hand: enumAt(ENUMS.Hand, r.i8(), 'Hand') } }),
  'PlayerRenderDistanceTimeLine.PlayerRenderDistance': (r) => ({ world: null, data: { renderDistance: r.i8() } }),
  'PlayerAttackResetTimeLine.PlayerAttackReset': () => ({ world: null, data: {} }),
  'PlayerPieChartTimeLine.PlayerPieChart': (r) => {
    const count = r.u8();
    const timings: { name: string; parent: number; total: number }[] = [];
    for (let i = 0; i < count; i++) {
      let name: string;
      if (i !== 0) {
        name = pieChartName(r);
      } else {
        const segments: string[] = [];
        const n = r.u8();
        for (let s = 0; s < n; s++) segments.push(pieChartName(r));
        name = segments.join('\u001e');
      }
      timings.push({ name, parent: r.u8(), total: r.u8() });
    }
    return { world: null, data: { timings } };
  },

  // ---- blocks ----
  'BlockUpdateTimeLineV2.BlockUpdate': (r, d) => {
    const w = world(r); const packed = r.i64(); const state = r.i32(); const placed = r.i8();
    const data = { ...blockPos(packed), ...blockUpdateV2Extra(state, placed) };
    d.storeBlock(w, data);
    return { world: w, data };
  },
  'BlockUpdateTimeLineV1.BlockUpdate': (r) => {
    // Legacy factory has no DeltaPositions override, so it does not call storeBlock.
    const w = world(r); const packed = r.i64(); const rawBlockState = r.i32(); const eventData = r.i8();
    const eventType = enumAt(ENUMS.BlockEventType, eventData % 2, 'BlockUpdateTimeLineV1.EventType');
    return {
      world: w,
      data: { ...blockPos(packed), rawBlockState, eventType, stateValue: Math.trunc(eventData / 2), eventData },
    };
  },
  'BlockBreakTimeLine.BlockBreak': absBlock(null),
  'BlockRemoveTimeLine.BlockRemove': absBlock(null),
  'BlockProgressTimeLine.BlockProgress': absBlock((r) => ({ progress: r.i8() })),
  'ChestAnimationTimeLine.ChestAnimation': (r) => {
    const w = world(r); const packed = r.i64();
    return { world: w, data: { ...blockPos(packed), open: r.bool() } };
  },
  'BlockDeltaTimeLine.UpdateFactory': deltaBlock((r) => {
    const state = r.u16();
    return blockUpdateV2Extra(state, r.i8());
  }),
  'BlockDeltaTimeLine.BreakFactory': deltaBlock(null),
  'BlockDeltaTimeLine.RemoveFactory': deltaBlock(null),
  'BlockDeltaTimeLine.ProgressFactory': deltaBlock((r) => ({ progress: r.i8() })),

  // ---- entities ----
  'EntityAddTimeLine.EntityAdd': (r) => {
    const w = world(r); const p = vec3f(r); const yaw = r.i16(); const pitch = r.i16();
    const entityId = r.i32(); const entityTypeId = r.i32(); const customData = r.i32();
    return { world: w, data: { entityId, entityTypeId, customData, ...p, ...rotation(yaw, pitch) } };
  },
  'EntityMoveTimeLine.EntityMove': (r, d) => {
    const w = world(r); const p = vec3f(r); const yaw = r.i16(); const pitch = r.i16(); const entityId = r.i32();
    d.store(entityId, w, p.x, p.y, p.z);
    return { world: w, data: { entityId, ...p, ...rotation(yaw, pitch) } };
  },
  'EntityMoveLookTimeLine.EntityMoveLook': (r) => {
    const w = world(r); const yaw = r.i16(); const pitch = r.i16(); const entityId = r.i32();
    return { world: w, data: { entityId, ...rotation(yaw, pitch) } };
  },
  'EntityMovePosTimeLine.EntityMovePos': (r, d) => {
    const w = world(r); const p = vec3f(r); const entityId = r.i32();
    d.store(entityId, w, p.x, p.y, p.z);
    return { world: w, data: { entityId, ...p } };
  },
  'EntityMoveDeltaTimeLine.EntityMoveDelta': (r, d) => {
    const w = world(r);
    const dx = r.i16(); const dy = r.i16(); const dz = r.i16(); const yaw = r.i16(); const pitch = r.i16();
    const entityId = r.i32();
    const p = d.decode(entityId, w, dx, dy, dz);
    return { world: w, data: { entityId, ...p, ...rotation(yaw, pitch), delta: [dx, dy, dz] } };
  },
  'EntityMovePosDeltaTimeLine.EntityMovePosDelta': (r, d) => {
    const w = world(r);
    const dx = r.i16(); const dy = r.i16(); const dz = r.i16(); const entityId = r.i32();
    const p = d.decode(entityId, w, dx, dy, dz);
    return { world: w, data: { entityId, ...p, delta: [dx, dy, dz] } };
  },
  'EntityMoveSmallDeltaTimeLine.EntityMoveSmallDelta': (r, d) => {
    const dx = r.i8(); const dy = r.i8(); const dz = r.i8(); const yaw = r.i8(); const pitch = r.i8();
    const entityId = r.i32();
    const w = d.getWorld(entityId);
    const p = d.decodeSmall(entityId, dx, dy, dz);
    return {
      world: w,
      data: { entityId, ...p, ...rotationFromFloats(byteToAngle(yaw), byteToAngle(pitch)), smallDelta: [dx, dy, dz] },
    };
  },
  'EntityMovePosSmallDeltaTimeLine.EntityMovePosSmallDelta': (r, d) => {
    const dx = r.i8(); const dy = r.i8(); const dz = r.i8(); const entityId = r.i32();
    const w = d.getWorld(entityId);
    const p = d.decodeSmall(entityId, dx, dy, dz);
    return { world: w, data: { entityId, ...p, smallDelta: [dx, dy, dz] } };
  },
  'EntityDamageTimeLine.EntityDamage': (r) => {
    const w = world(r); const entityId = r.i32(); const attackerId = r.i32();
    return { world: w, data: { entityId, attackerId, ...attacker(attackerId) } };
  },
  'EntityRemoveTimeLine.EntityRemove': (r) => {
    const w = world(r); const entityId = r.i32();
    return { world: w, data: { entityId, death: r.i8() === 1 } };
  },
  'PiglinStateTimeLine.PiglinState': (r) => {
    const w = world(r); const entityId = r.i32();
    const state = enumAt(ENUMS.PiglinState, r.i8(), 'PiglinStateTimeLine.State');
    return { world: w, data: { entityId, state, flags: r.i8(), offHand: r.i16(), mainHand: r.i16() } };
  },
  'MobStateTimeLine.MobState': (r) => {
    const w = world(r);
    return { world: w, data: { entityId: r.i32(), state: r.i32() } };
  },

  // ---- items / projectiles ----
  'ItemEntityTimeLine.ItemEntity': (r) => {
    const w = world(r); const p = vec3f(r); const entityId = r.i32();
    const itemRawId = r.u16(); const packedCount = r.u8(); const variant = r.u8();
    const count = Math.max(1, Math.min(packedCount & 0x7F, 127));
    return { world: w, data: { entityId, itemRawId, count, glint: (packedCount & 0x80) !== 0, variant, ...p } };
  },
  'ItemEntityTimeLine.LegacyItemEntity': (r) => {
    const w = world(r); const p = vec3f(r);
    r.i16(); r.i16();
    const entityId = r.i32();
    r.f64(); r.f64(); r.f64();
    const itemRawId = r.i32();
    return { world: w, data: { entityId, itemRawId, count: 1, glint: false, variant: 0, ...p } };
  },
  'ItemPickupTimeLine.ItemPickup': (r) => {
    const w = world(r);
    return { world: w, data: { itemEntityId: r.i32(), collectorId: r.i32(), count: r.i8() } };
  },
  'ProjectileEntityTimeLine.ProjectileEntity': (r) => {
    const w = world(r); const p = vec3f(r); const yaw = r.i16(); const pitch = r.i16(); const entityId = r.i32();
    const velocity = vec3d(r); const packedType = r.i32(); const packedSound = r.u8();
    return {
      world: w,
      data: {
        entityId,
        entityTypeId: packedType & 0xFFFF,
        potion: (packedType >>> 16) & 0xFF,
        lingering: (packedType & 0x1000000) !== 0,
        followsRecord: (packedSound & 0x80) !== 0,
        soundPlayType: enumAt(ENUMS.SoundPlayType, packedSound & ~0x80, 'ProjectileEntityTimeLine.SoundPlayType'),
        ...p,
        ...rotation(yaw, pitch),
        velocity,
      },
    };
  },
  'InventorySlotTimeLine.InventorySlot': (r) => {
    const slot = r.u8(); const itemId = r.u16(); const count = r.u8(); const durability = r.u8(); const variant = r.u8();
    const packed = r.u8();
    const enchantments: { id: number; level: number }[] = [];
    for (let i = 0; i < (packed & 63); i++) {
      const v = (r.u8() << 8) | r.u8();
      enchantments.push({ id: v >> 8, level: v & 0xFF });
    }
    return { world: null, data: { slot, itemId, count, durability, variant, crossbow: packed >> 6, enchantments } };
  },
  'InventorySlotTimeLine.LegacyItemEquip': (r) => {
    // Java builds an ItemStack: count is 0 for AIR (raw id 0) and 1 otherwise; "enchanted" adds
    // Protection I (enchantment raw id 0 in 1.16.1), which ReplayItemSlot.packEntries packs as 0x0001.
    const itemRawId = r.i32();
    const equipmentSlot = enumAt(ENUMS.EquipmentSlot, r.i8(), 'EquipmentSlot');
    const enchanted = r.bool();
    const empty = itemRawId === 0;
    return {
      world: null,
      data: {
        slot: ENUMS.EquipmentInventorySlot[ENUMS.EquipmentSlot.indexOf(equipmentSlot)],
        itemId: itemRawId & 0xFFFF,
        count: empty ? 0 : 1,
        durability: 255,
        variant: 0,
        crossbow: 0,
        enchantments: enchanted && !empty ? [{ id: 0, level: 1 }] : [],
        legacyEquipmentSlot: equipmentSlot,
      },
    };
  },

  // ---- dragon ----
  'DragonPositionTimeLine.DragonPosition': (r, d) => {
    const p = vec3f(r); const yaw = r.i16(); const pitch = r.i16();
    d.store(DRAGON_KEY, 2, p.x, p.y, p.z);
    return { world: 2, data: { ...p, ...rotation(yaw, pitch) } };
  },
  'DragonMoveDeltaTimeLine.DragonMoveDelta': (r, d) => {
    const dx = r.i16(); const dy = r.i16(); const dz = r.i16(); const yaw = r.i16(); const pitch = r.i16();
    const p = d.decode(DRAGON_KEY, 2, dx, dy, dz);
    return { world: 2, data: { ...p, ...rotation(yaw, pitch), delta: [dx, dy, dz] } };
  },
  'DragonPhaseTimeLine.DragonPhase': (r) => ({ world: null, data: { phase: r.i8() } }),
  'DragonHealthTimeLine.DragonHealth': (r) => ({ world: null, data: { health: r.i8() + 128 } }),
  'CrystalDestroyTimeLine.CrystalDestroy': (r) => ({ world: null, data: { crystalIndex: r.i8() } }),
  'DragonDeathTimeLine.DragonDeath': (r) => { r.u8(); return { world: null, data: {} }; },
  'DragonDeathProgressTimeLine.DragonDeathProgress': (r) => ({
    world: null,
    data: { progress: r.i16(), phase: r.i8() },
  }),
  'DragonNodesTimeLine.DragonNodes': (r) => {
    const nodes: BlockPos[] = [];
    const n = r.u8();
    for (let i = 0; i < n; i++) nodes.push(blockPos(r.i64()));
    return { world: null, data: { nodes } };
  },
  'DragonZeroTimeLine.DragonZero': (r) => {
    if (r.i8() === 1) {
      return { world: null, data: { flewAway: true, spawnYaw: 0, node: -1, target: { x: 0, y: 0, z: 0 }, clockwise: false } };
    }
    const spawnYaw = r.f32(); const node = r.i8(); const target = vec3f(r); const clockwise = r.bool();
    return { world: null, data: { flewAway: false, spawnYaw, node, target, clockwise } };
  },
  'DragonDamageTimeLine.DragonDamage': (r) => {
    const source = enumAt(ENUMS.DragonDamageSource, r.i8(), 'DragonDamageTimeLine.Source');
    return { world: null, data: { source, amount: Math.fround(r.u16() / 100) } };
  },
  'DragonTargetTimeLine.DragonTarget': (r) => ({
    world: null,
    data: { target: r.i8() === 0 ? null : vec3f(r) },
  }),
  'DragonPathTimeLine.DragonPath': (r) => {
    const phase = r.i8(); const count = r.u8();
    const nodes: { node: number; pos?: BlockPos }[] = [];
    for (let i = 0; i < count; i++) {
      const node = r.u8();
      nodes.push(node === 255 ? { node, pos: blockPos(r.i64()) } : { node });
    }
    return { world: null, data: { phase, nodes } };
  },

  // ---- world ----
  'ExplosionEffectTimeline.ExplosionEffect': (r) => {
    const w = world(r); const p = vec3f(r);
    return { world: w, data: { ...p, radius: r.f32() } };
  },
  'AreaEffectCloudTimeLine.AreaEffectCloud': (r) => {
    const w = world(r); const p = vec3f(r);
    return { world: w, data: { entityId: r.i32(), ...p, radius: r.f32(), duration: r.i16(), radiusGrowth: r.f32() } };
  },
  'WorldTimeTimeLine.WorldTime': (r) => ({ world: null, data: { timeOfDay: longOut(r.i64()) } }),
  'PiglinBarterTimeLine.PiglinBarter': (r) => {
    const w = world(r); const entityId = r.i32(); const size = r.u8();
    const loot: { itemRawId: number; count: number }[] = [];
    for (let i = 0; i < size; i++) loot.push({ itemRawId: r.u16(), count: r.u8() });
    return { world: w, data: { entityId, loot } };
  },
};

