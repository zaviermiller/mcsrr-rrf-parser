// Public types. The record type and mod enum names below mirror data/mcsrranked.json (which datagen
// generates from the mod jar); test/mod_data.test.ts fails when they drift apart.
import type { KeyObject } from 'node:crypto';
import type { PlayerReplay } from './replay.ts';

// ---------------------------------------------------------------- names

/** WorldTypes. */
export type World = 'OVERWORLD' | 'NETHER' | 'END';
/** Canonical record type (`record.type`). Delta/compact and legacy wire types are folded into these. */
export type RecordType = keyof RecordDataMap;
/** Delta/compact wire types; each is reported as the canonical type it is stored as. */
export type DeltaRecordType =
  | 'PLAYER_POSITION_DELTA' | 'PLAYER_POSITION_POS_DELTA' | 'BLOCK_UPDATE_DELTA' | 'BLOCK_BREAK_DELTA'
  | 'BLOCK_REMOVE_DELTA' | 'BLOCK_PROGRESS_DELTA' | 'ENTITY_MOVE_DELTA' | 'ENTITY_MOVE_POS_DELTA'
  | 'ENTITY_MOVE_SMALL_DELTA' | 'ENTITY_MOVE_POS_SMALL_DELTA' | 'DRAGON_MOVE_DELTA';
/** Every TimeLineType name that can appear on the wire in current (format 3) replays. */
export type WireRecordType = RecordType | DeltaRecordType;
/** LegacyTimeLineType names (format 0 records, replays older than version 30). */
export type LegacyRecordType =
  | 'EMPTY' | 'PLAYER_POSITION' | 'PLAYER_POSITION_LOOK' | 'PLAYER_POSITION_POS' | 'PLAYER_SPAWN' | 'BLOCK_UPDATE_V1'
  | 'BLOCK_BREAK' | 'BLOCK_REMOVE' | 'ENTITY_ADD' | 'ENTITY_REMOVE' | 'ENTITY_MOVE' | 'ENTITY_MOVE_LOOK'
  | 'ENTITY_MOVE_POS' | 'ENTITY_DAMAGE' | 'PROJECTILE_ENTITY' | 'ITEM_EQUIP' | 'PLAYER_POSE' | 'PLAYER_REMOVE'
  | 'BLOCK_PROGRESS' | 'PLAYER_RIDE' | 'ITEM_ENTITY' | 'DRAGON_HEALTH_UPDATE' | 'DRAGON_CRYSTAL_UPDATE'
  | 'DRAGON_MOVE' | 'DRAGON_DEATH' | 'DEBUG_DRAGON_REFRESH' | 'DEBUG_PLAYER_FOLLOW' | 'DEBUG_ENTITIES_REFRESH'
  | 'BLOCK_UPDATE_V2' | 'EXPLOSION_EFFECT' | 'PLAYER_PAUSE' | 'CHEST_ANIMATION';
/** Any name that can appear in `record.wireType`. */
export type AnyRecordType = WireRecordType | LegacyRecordType;

export type BlockEventType = 'PLACE' | 'UPDATE';
export type DragonDamageSource = 'PLAYER' | 'ARROW' | 'BED_ANCHOR' | 'EXPLOSION' | 'OTHER';
export type AttackSound = 'SWEEP' | 'CRITICAL' | 'STRONG' | 'WEAK';
export type PiglinState = 'ROAMING' | 'SEEKING' | 'ADMIRING' | 'ANGRY' | 'BARTERING' | 'AGGRO_LIGHT' | 'AGGRO_HEAVY';
export type SoundPlayType =
  | 'EMPTY' | 'GHAST_FIREBALL' | 'BLAZE_FIREBALL' | 'ENTITY_TRIDENT' | 'SHULKER_BULLET' | 'DRAGON_FIREBALL'
  | 'WITHER_SKULL' | 'ENTITY_SHOT_CROSSBOW' | 'SHOOT_SNOWBALL' | 'FIREWORK_FIRE' | 'PLAYER_PEARL_THROW'
  | 'ENTITY_POTION_THROW' | 'SHOOT_ARROW';
/** Minecraft 1.16.1 Hand. */
export type Hand = 'MAIN_HAND' | 'OFF_HAND';
/** Minecraft 1.16.1 EquipmentSlot. */
export type EquipmentSlot = 'MAINHAND' | 'OFFHAND' | 'FEET' | 'LEGS' | 'CHEST' | 'HEAD';
/** Vanilla registries available through registryName(). */
export type RegistryName =
  | 'item' | 'entity_type' | 'mob_effect' | 'enchantment' | 'potion' | 'menu' | 'villager_type' | 'villager_profession';

// ---------------------------------------------------------------- shared shapes

export interface Vec3 { x: number; y: number; z: number }
export interface BlockPos { x: number; y: number; z: number }
/** Angles in degrees plus the raw encoded shorts (degrees * 100, wrapped). */
export interface Rotation { yaw: number; pitch: number; yawRaw: number; pitchRaw: number }
/** Raw quantized delta [dx, dy, dz] for records decoded from a *_DELTA wire type. */
export type Delta3 = [number, number, number];

interface WithDelta {
  /** Present when decoded from a *_DELTA wire type: the raw [dx, dy, dz] applied. */
  delta?: Delta3;
}
interface WithSmallDelta extends WithDelta {
  /** Present when decoded from a *_SMALL_DELTA wire type: the raw [dx, dy, dz] steps (1/256 block each). */
  smallDelta?: Delta3;
}
interface EntityRef { entityId: number }

// ---------------------------------------------------------------- per-type data
// What each record means, when it is emitted, units and special values: docs/EVENTS.md.

export type EmptyData = Record<string, never>;
export interface PlayerSpawnData extends Vec3, Rotation {}
export interface PlayerPositionData extends Vec3, Rotation, WithDelta {}
export interface PlayerPositionLookData extends Rotation {}
export interface PlayerPositionPosData extends Vec3, WithDelta {}
/** `pose` is an EntityPose ordinal (see `names.pose`). */
export interface PlayerPoseData { pose: number }
/** vehicleId -1 = not riding, -2 = riding something (legacy files), otherwise the vehicle's entity id. */
export interface PlayerRideData { vehicleId: number; riding: boolean }
export interface PlayerPauseData { paused: boolean }
/** death=false: left the world (dimension change) or recording ended. */
export interface PlayerRemoveData { death: boolean }
/** 0 first person, 1 third person back, 2 third person front. */
export interface PlayerPerspectiveData { perspective: number }
export interface PlayerStatsData {
  /** Half-hearts, rounded up (20 = full). */
  health: number;
  /** Half-hearts, rounded up. */
  absorption: number;
  /** 0-20. */
  food: number;
  /** Air bubbles 0-10; -1 = full and not underwater. */
  air: number;
}
export interface PlayerUseData {
  /** Raw stored byte. */
  state: number;
  /** NONE = stopped using an item. */
  usingHand: 'NONE' | 'MAIN_HAND' | 'OFF_HAND' | 'UNKNOWN';
  /** The use completed (food eaten, potion drunk, ...) on this tick. */
  finished: boolean;
}
export interface PlayerEffectData {
  /** `mob_effect` registry id. */
  effectId: number;
  /** Level - 1. */
  amplifier: number;
  /** Ticks remaining when applied (max 65535); 0 = removed. Not re-sent as it counts down. */
  duration: number;
}
/** Hotbar slot 0-8. */
export interface PlayerHeldSlotData { slot: number }
/** containerType: -1 = closed, -2 = player inventory, otherwise a `menu` registry id. */
export interface PlayerContainerData {
  containerType: number;
  /** Container slots, reported as INVENTORY_SLOT 46 .. 46 + slotCount - 1. */
  slotCount: number;
  /** Backing blocks (two for a double chest, none for entity containers). */
  positions: BlockPos[];
}
export interface PlayerPortalData { inPortal: boolean }
export interface PlayerSwingData { hand: Hand }
/** Chunks. */
export interface PlayerRenderDistanceData { renderDistance: number }
/** One profiler entry. The first entry's name is the path joined with U+001E; parent/total are percent (0-100). */
export interface PieChartTiming { name: string; parent: number; total: number }
export interface PlayerPieChartData { timings: PieChartTiming[] }

export interface BlockUpdateData extends BlockPos, WithDelta {
  /** Raw 1.16.1 block-state id (see `names.block`). */
  rawBlockState: number;
  /** PLACE = placed by the recording player; UPDATE = any other recorded change. */
  eventType: BlockEventType;
  /** Legacy BLOCK_UPDATE_V1 only. */
  stateValue?: number;
  /** Legacy BLOCK_UPDATE_V1 only. */
  eventData?: number;
}
export interface BlockBreakData extends BlockPos, WithDelta {}
export interface BlockRemoveData extends BlockPos, WithDelta {}
/** progress: 0-9 crack stage, 10 = started (no crack yet), -1 = stopped. */
export interface BlockProgressData extends BlockPos, WithDelta { progress: number }
export interface ChestAnimationData extends BlockPos { open: boolean }

export interface EntityAddData extends EntityRef, Vec3, Rotation {
  /** `entity_type` registry id. */
  entityTypeId: number;
  /** Type-specific (slime size, TNT fuse, falling block state, boat type, mob main-hand item; negative = baby). Decoded into `names`. */
  customData: number;
}
export interface EntityMoveData extends EntityRef, Vec3, Rotation, WithSmallDelta {}
export interface EntityMoveLookData extends EntityRef, Rotation {}
export interface EntityMovePosData extends EntityRef, Vec3, WithSmallDelta {}
/** entityId -2 = the recording player. The damage amount is not recorded. */
export interface EntityDamageData extends EntityRef {
  /** Raw stored value; an entity id when attacker is ENTITY. */
  attackerId: number;
  attacker: 'NONE' | 'PLAYER' | 'ENTITY';
  /** Set when the attacker is the player and the hit carried attack info. */
  attackSound?: AttackSound;
  knockback?: boolean;
}
/** death=false: left range, despawned, picked up, etc. */
export interface EntityRemoveData extends EntityRef { death: boolean }
/** flags: bit 0 = attacking, bit 1 = charging crossbow. offHand/mainHand are item raw ids. */
export interface PiglinStateData extends EntityRef { state: PiglinState; flags: number; offHand: number; mainHand: number }
/** Packed per-entity state (villager type/profession/level, sheep colour, enderman anger); see `names`. */
export interface MobStateData extends EntityRef { state: number }

/** count 1-127; glint = enchanted; variant = potion id (0 = none). */
export interface ItemEntityData extends EntityRef, Vec3 { itemRawId: number; count: number; glint: boolean; variant: number }
/** collectorId -2 = the recording player, otherwise a mob's entity id. */
export interface ItemPickupData { itemEntityId: number; collectorId: number; count: number }
export interface ProjectileEntityData extends EntityRef, Vec3, Rotation {
  entityTypeId: number;
  /** Potion registry id (0 = none). */
  potion: number;
  lingering: boolean;
  /** Later ENTITY_MOVE* records describe the flight. */
  followsRecord: boolean;
  soundPlayType: SoundPlayType;
  /** Blocks per tick. */
  velocity: Vec3;
}
/** `id`/`level` are enchantment raw id and level (for suspicious stew: effect raw id and seconds). */
export interface Enchantment { id: number; level: number }
export interface InventorySlotData {
  /** 0-8 hotbar, 9-35 main, 36-39 armour (feet..head), 40 offhand, 41-44 crafting grid, 45 crafting result, 46-99 open container. */
  slot: number;
  /** `item` registry id; 0 = empty. */
  itemId: number;
  count: number;
  /** Remaining durability out of 255; 255 = full, not damageable, or empty. */
  durability: number;
  /** Potion id for potions and tipped arrows; 0 otherwise. */
  variant: number;
  /** 0 = not charged, 1 = arrow, 2 = firework rocket. */
  crossbow: number;
  enchantments: Enchantment[];
  /** Legacy ITEM_EQUIP only. */
  legacyEquipmentSlot?: EquipmentSlot;
}

export interface DragonMoveData extends Vec3, Rotation, WithDelta {}
/** Vanilla PhaseType id (0 holding pattern ... 9 dying, 10 hover); see `names.phase`. */
export interface DragonPhaseData { phase: number }
/** Health points, rounded up (200 = full). */
export interface DragonHealthUpdateData { health: number }
/** Destroyed crystal's pillar index 0-9 (by angle around the centre). */
export interface DragonCrystalUpdateData { crystalIndex: number }
/** progress = ticks since death (animation lasts 200). */
export interface DragonDeathProgressData { progress: number; phase: number }
export interface DragonNodesData { nodes: BlockPos[] }
/** Zero-cycle opportunity; flewAway=true means it was lost (other fields absent). */
export interface DragonZeroData { flewAway: boolean; spawnYaw: number; node: number; target: Vec3; clockwise: boolean }
/** amount = health points lost. */
export interface DragonDamageData { source: DragonDamageSource; amount: number }
export interface DragonTargetData { target: Vec3 | null }
/** node indexes DRAGON_NODES; 255 = a one-off point given in `pos`. */
export interface DragonPathNode { node: number; pos?: BlockPos }
export interface DragonPathData { phase: number; nodes: DragonPathNode[] }

/** radius = explosion power (4 TNT, 5 bed/anchor, ...). */
export interface ExplosionEffectData extends Vec3 { radius: number }
/** radius in blocks, duration in ticks, radiusGrowth in blocks per tick. */
export interface AreaEffectCloudData extends EntityRef, Vec3 { radius: number; duration: number; radiusGrowth: number }
/** Overworld day time in ticks after a jump (e.g. sleeping); `% 24000` = time of day. int64; a decimal string when it does not fit a double exactly. */
export interface WorldTimeData { timeOfDay: number | string }
export interface BarterLoot { itemRawId: number; count: number }
export interface PiglinBarterData extends EntityRef { loot: BarterLoot[] }

/** Canonical record type -> shape of `record.data`. Semantics: docs/EVENTS.md; byte layout: docs/FORMAT.md §4. */
export interface RecordDataMap {
  EMPTY: EmptyData;
  PLAYER_SPAWN: PlayerSpawnData;
  PLAYER_POSITION: PlayerPositionData;
  PLAYER_POSITION_LOOK: PlayerPositionLookData;
  PLAYER_POSITION_POS: PlayerPositionPosData;
  PLAYER_POSE: PlayerPoseData;
  PLAYER_RIDE: PlayerRideData;
  PLAYER_PAUSE: PlayerPauseData;
  PLAYER_REMOVE: PlayerRemoveData;
  PLAYER_PERSPECTIVE: PlayerPerspectiveData;
  PLAYER_STATS: PlayerStatsData;
  PLAYER_USE: PlayerUseData;
  PLAYER_EFFECT: PlayerEffectData;
  PLAYER_HELD_SLOT: PlayerHeldSlotData;
  PLAYER_CONTAINER: PlayerContainerData;
  PLAYER_PORTAL: PlayerPortalData;
  PLAYER_SWING: PlayerSwingData;
  PLAYER_RENDER_DISTANCE: PlayerRenderDistanceData;
  PLAYER_ATTACK_RESET: EmptyData;
  PLAYER_PIE_CHART: PlayerPieChartData;
  BLOCK_UPDATE: BlockUpdateData;
  BLOCK_BREAK: BlockBreakData;
  BLOCK_REMOVE: BlockRemoveData;
  BLOCK_PROGRESS: BlockProgressData;
  CHEST_ANIMATION: ChestAnimationData;
  ENTITY_ADD: EntityAddData;
  ENTITY_MOVE: EntityMoveData;
  ENTITY_MOVE_LOOK: EntityMoveLookData;
  ENTITY_MOVE_POS: EntityMovePosData;
  ENTITY_DAMAGE: EntityDamageData;
  ENTITY_REMOVE: EntityRemoveData;
  PIGLIN_STATE: PiglinStateData;
  MOB_STATE: MobStateData;
  ITEM_ENTITY: ItemEntityData;
  ITEM_PICKUP: ItemPickupData;
  PROJECTILE_ENTITY: ProjectileEntityData;
  INVENTORY_SLOT: InventorySlotData;
  DRAGON_MOVE: DragonMoveData;
  DRAGON_PHASE: DragonPhaseData;
  DRAGON_HEALTH_UPDATE: DragonHealthUpdateData;
  DRAGON_CRYSTAL_UPDATE: DragonCrystalUpdateData;
  DRAGON_DEATH: EmptyData;
  DRAGON_DEATH_PROGRESS: DragonDeathProgressData;
  DRAGON_NODES: DragonNodesData;
  DRAGON_ZERO: DragonZeroData;
  DRAGON_DAMAGE: DragonDamageData;
  DRAGON_TARGET: DragonTargetData;
  DRAGON_PATH: DragonPathData;
  EXPLOSION_EFFECT: ExplosionEffectData;
  AREA_EFFECT_CLOUD: AreaEffectCloudData;
  WORLD_TIME: WorldTimeData;
  PIGLIN_BARTER: PiglinBarterData;
}

/**
 * Readable Minecraft 1.16.1 names for ids in `data`. Which fields are present depends on the
 * record type; ids outside the vanilla tables resolve to null.
 */
export interface RecordNames {
  pose?: string | null;
  perspective?: 'FIRST_PERSON' | 'THIRD_PERSON_BACK' | 'THIRD_PERSON_FRONT' | null;
  effect?: string | null;
  /** 'closed', 'inventory' or a `menu` registry name. */
  container?: string | null;
  /** Block state, e.g. `oak_stairs[facing=north,half=top,shape=straight,waterlogged=true]`. */
  block?: string | null;
  /** Entity type of `data.entityId` (remembered from ENTITY_ADD / ITEM_ENTITY / PROJECTILE_ENTITY). */
  entityType?: string | null;
  baby?: boolean;
  mainHand?: string | null;
  offHand?: string | null;
  fuse?: number;
  size?: number;
  boatType?: string | null;
  villagerType?: string | null;
  profession?: string | null;
  level?: number;
  color?: string | null;
  sheared?: boolean;
  angry?: boolean;
  item?: string | null;
  potion?: string | null;
  enchantments?: Array<{ enchantment: string | null; level: number } | { effect: string | null; seconds: number }>;
  loot?: Array<string | null>;
  phase?: string | null;
  itemEntityType?: string | null;
  collectorType?: string | null;
}

interface RecordBase {
  /** 20 per second from the start of this player's recording (not world time). */
  tick: number;
  /** Type as stored in the file (e.g. a *_DELTA variant or a legacy name). */
  wireType: AnyRecordType;
  wireTypeId: number;
  world: World | null;
  /** Readable names for ids in `data`. Omitted when nothing applies or with `names: false`. */
  names?: RecordNames;
  /** Index of the chunk in replay.rpd this record came from. */
  chunk: number;
  /** Set on records decoded from the legacy (format 0) layout. */
  legacy?: true;
}

/**
 * One decoded record. A discriminated union on `type`: checking `record.type` narrows `record.data`.
 * `ReplayRecord<'PLAYER_POSITION'>` is the record type for a single canonical type.
 */
export type ReplayRecord<T extends RecordType = RecordType> = {
  [K in T]: RecordBase & { type: K; data: RecordDataMap[K] };
}[T];

// ---------------------------------------------------------------- meta / results

export interface MetaPlayer {
  uuid: string | null;
  nickname: string | null;
  roleType: number;
  eloRate: number | null;
  eloRank: number | null;
  country: string | null;
}

export interface ReplayMeta {
  /** Effective version (0 for files migrated from < 30). */
  version: number;
  /** Version written in the file. */
  fileVersion: number;
  migratedFromUnder30: boolean;
  matchId: number | null;
  /** Match start, epoch milliseconds. */
  date: number;
  /** 1 casual, 2 ranked, 3 private, 4 event, 5 rush. */
  matchType: number;
  /** int64 seeds as decimal strings. */
  overworldSeed: string | null;
  netherSeed: string | null;
  theEndSeed: string | null;
  /** Encrypted AES key of pre-v40 replays. */
  symmetricKey: string | null;
  /** Winner and their time in milliseconds. */
  /** Winner and their time in milliseconds. */
  result: { uuid: string | null; time: number };
  players: MetaPlayer[];
}

export interface DecodeErrorInfo {
  uuid: string | null;
  chunk: number;
  stage: 'decompress' | 'decode';
  offset: number | null;
  typeId: number | null;
  message: string;
  recordsDiscarded: number;
}

/** A timelines.json entry: { uuid, type, time (ms), data }; see docs/EVENTS.md §7. */
export type TimelineEntry = Record<string, unknown>;

export type ReplayInput = string | URL | Buffer | Uint8Array | ArrayBuffer;

export interface ParseOptions {
  /** Add readable `names` to records (default true). */
  names?: boolean;
  /** Only keep these types (canonical or wire names, case-insensitive). Everything is still decoded. */
  types?: Iterable<AnyRecordType | (string & {})> | string;
  /** Override the public key used for pre-v40 encrypted replays (KeyObject, PEM, or base64 SPKI). */
  legacyPublicKey?: KeyObject | string;
  /** Reject ZIP entries that inflate past this many bytes (default 64 MiB). */
  maxEntrySize?: number;
  /** Reject replay.rpd chunks that decompress past this many bytes (default 16 MiB). */
  maxChunkSize?: number;
}

export interface ParseReplayOptions extends ParseOptions {
  /** Called for every kept record instead of storing it in player.records. */
  onRecord?: (player: PlayerReplay, record: ReplayRecord) => void;
}

export interface StreamedRecord {
  uuid: string;
  nickname: string | null;
  chunk: number;
  record: ReplayRecord;
}

export interface OpenedReplay {
  meta: ReplayMeta;
  /** meta.json as stored (integers beyond 2^53 are BigInt). */
  rawMeta: unknown;
  timelines: TimelineEntry[];
  warnings: string[];
  /** Filled while iterating records(). */
  errors: DecodeErrorInfo[];
  chunkCount: number;
  /** Decodes and yields records one at a time, in file order. */
  records(): Generator<StreamedRecord, void, undefined>;
}

export interface FinalPosition { world: World | null; x: number; y: number; z: number; tick: number }

export interface PlayerStats {
  counts: Partial<Record<RecordType, number>>;
  minTick: number | null;
  maxTick: number | null;
  finalPosition: FinalPosition | null;
  tickRegressions: number;
  issues: string[];
}

export interface PlayerSummary extends PlayerStats {
  uuid: string;
  nickname: string | null;
  inMeta: boolean;
  chunks: number;
  records: number;
}

export interface ReplaySummary {
  version: number;
  migratedFromUnder30: boolean;
  matchId: number | null;
  matchType: number | null;
  /** ISO 8601. */
  date: string | null;
  seeds: { overworld: string | null; nether: string | null; theEnd: string | null };
  result: { uuid: string | null; nickname: string | null; timeMs: number | null };
  timelines: number;
  warnings: string[];
  errors: DecodeErrorInfo[];
  players: PlayerSummary[];
}

export interface PlayerOption {
  /** Limit output to one player (UUID or nickname). */
  player?: string;
}

export interface RecordTypeInfo {
  id: number;
  name: AnyRecordType;
  storedAs: RecordType;
}
