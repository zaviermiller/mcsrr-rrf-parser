// MCSR Ranked mod data (record type ids, factories, enums, ...) from data/mcsrranked.json. That file
// is generated from the mod jar by datagen (see README.md); nothing here needs the jar.
import { readFileSync } from 'node:fs';
import type {
  AttackSound, BlockEventType, DragonDamageSource, LegacyRecordType, PiglinState, RecordType, SoundPlayType, WireRecordType, World,
} from './types.ts';

export interface TimelineTypeRow {
  id: number;
  name: WireRecordType;
  /** Decoder key in DECODERS, e.g. "PlayerSpawnTimeLine.PlayerSpawn" (<outer class>.<factory class prefix>). */
  factory: string;
  /** Canonical type a delta/compact type is reported as; absent when the type is canonical. */
  storedAs?: RecordType;
}

export interface LegacyTypeRow {
  id: number;
  name: LegacyRecordType;
  /** TimeLineType it maps to. */
  canonical: WireRecordType;
  /** Special decoder; absent when the canonical type's decoder is used. */
  factory?: string;
}

export interface ModEnums {
  BlockEventType: readonly BlockEventType[];
  DragonDamageSource: readonly DragonDamageSource[];
  AttackSound: readonly AttackSound[];
  PiglinState: readonly PiglinState[];
  SoundPlayType: readonly SoundPlayType[];
}

/** Shape of data/mcsrranked.json. */
export interface ModData {
  modVersion: string;
  /** AntiCheatConfig.REPLAY_PUBLIC_KEY_STRING (base64 X.509 RSA key that signs pre-v40 replays). */
  replayPublicKey: string;
  worlds: readonly World[];
  timelineTypes: readonly TimelineTypeRow[];
  legacyTypes: readonly LegacyTypeRow[];
  /** Enum constant names in ordinal order. */
  enums: ModEnums;
  /** PieChartNames.NAMES (PLAYER_PIE_CHART name ids, 1-based). */
  pieChartNames: readonly string[];
  /** Factory -> java.nio.ByteBuffer reads the mod's getFromBytes makes; the tests check the decoders against these. */
  factoryReads: Readonly<Record<string, readonly string[]>>;
}

function load(): ModData {
  const file = new URL('../data/mcsrranked.json', import.meta.url);
  const data = JSON.parse(readFileSync(file, 'utf8')) as ModData;
  for (const key of ['modVersion', 'replayPublicKey', 'worlds', 'timelineTypes', 'legacyTypes', 'enums', 'pieChartNames', 'factoryReads'] as const) {
    if (data[key] === undefined) throw new Error(`${file.pathname}: missing "${key}"`);
  }
  return data;
}

export const MOD_DATA: ModData = load();
/** MCSR Ranked version the mod data was generated from. */
export const MOD_VERSION: string = MOD_DATA.modVersion;
export const REPLAY_PUBLIC_KEY: string = MOD_DATA.replayPublicKey;
export const WORLDS: readonly World[] = MOD_DATA.worlds;
export const TIMELINE_TYPES: readonly TimelineTypeRow[] = MOD_DATA.timelineTypes;
export const LEGACY_TYPES: readonly LegacyTypeRow[] = MOD_DATA.legacyTypes;
export const MOD_ENUMS: ModEnums = MOD_DATA.enums;
export const PIE_CHART_NAMES: readonly string[] = MOD_DATA.pieChartNames;
export const FACTORY_READS: Readonly<Record<string, readonly string[]>> = MOD_DATA.factoryReads;
