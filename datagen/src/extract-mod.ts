// Reads the replay tables out of an MCSR Ranked mod jar (its classes are not obfuscated) and
// produces the JSON document the parser loads (data/mcsrranked.json).
import * as fs from 'node:fs';
import { readZip } from './zip.ts';
import * as C from './classfile.ts';
import type { ClassFile, Effect, SimValue } from './classfile.ts';

/** Mod enums the parser's decoders index by ordinal -> the jar classes that define them (must agree). */
const ENUM_CLASSES: Readonly<Record<string, readonly string[]>> = {
  BlockEventType: ['timelines/block/BlockUpdateTimeLineV2$EventType', 'timelines/block/BlockUpdateTimeLineV1$EventType'],
  DragonDamageSource: ['timelines/dragon/DragonDamageTimeLine$Source'],
  AttackSound: ['timelines/entity/EntityDamageTimeLine$AttackSound'],
  PiglinState: ['timelines/entity/PiglinStateTimeLine$State'],
  SoundPlayType: ['timelines/item/ProjectileEntityTimeLine$SoundPlayType'],
};

const BUFFER_OPS: ReadonlySet<string> = new Set(['get', 'getShort', 'getInt', 'getLong', 'getFloat', 'getDouble']);

export interface TimelineType {
  id: number;
  name: string;
  /** Factory reference, e.g. "PlayerSpawnTimeLine.PlayerSpawn" (see factoryRef). */
  factory: string;
  /** Canonical type this (delta) type is reported as; omitted when it is its own canonical type. */
  storedAs?: string;
}

export interface LegacyType {
  id: number;
  name: string;
  /** TimeLineType it maps to. */
  canonical: string;
  /** Special factory; omitted when the canonical type's factory is used. */
  factory?: string;
}

/** The contents of data/mcsrranked.json. */
export interface ModData {
  modVersion: string;
  /** AntiCheatConfig.REPLAY_PUBLIC_KEY_STRING (base64 X.509 RSA key for pre-v40 replays). */
  replayPublicKey: string;
  /** WorldTypes, in ordinal order. */
  worlds: string[];
  timelineTypes: TimelineType[];
  legacyTypes: LegacyType[];
  /** Enum constant names in ordinal order. */
  enums: Record<string, string[]>;
  /** PieChartNames.NAMES. */
  pieChartNames: string[];
  /** Factory reference -> java.nio.ByteBuffer reads its getFromBytes makes, in class-file order. */
  factoryReads: Record<string, string[]>;
}

/** "pkg/PlayerSpawnTimeLine$PlayerSpawnTimeLineFactory" -> "PlayerSpawnTimeLine.PlayerSpawn". */
export function factoryRef(internalName: string): string {
  const [outer, inner = ''] = internalName.slice(internalName.lastIndexOf('/') + 1).split('$');
  return `${outer}.${inner.replace(/Time[Ll]ineFactory$/, '')}`;
}

interface Jar {
  zip: Map<string, () => Buffer>;
  load(internalName: string): ClassFile | null;
  find(suffix: string): ClassFile;
}

function openJar(jar: string | URL | Buffer): Jar {
  const zip = readZip(Buffer.isBuffer(jar) ? jar : fs.readFileSync(jar));
  const cache = new Map<string, ClassFile | null>();
  const names = [...zip.keys()];
  const load = (internalName: string): ClassFile | null => {
    if (!cache.has(internalName)) {
      const get = zip.get(`${internalName}.class`);
      cache.set(internalName, get ? C.parseClass(get()) : null);
    }
    return cache.get(internalName)!;
  };
  /** Finds the single class whose path ends with "/<suffix>.class". */
  const find = (suffix: string): ClassFile => {
    const hits = names.filter((n) => n.endsWith(`/${suffix}.class`));
    if (hits.length !== 1) throw new Error(`expected one class matching ${suffix}, found ${hits.length}`);
    return load(hits[0]!.slice(0, -6))!;
  };
  return { zip, load, find };
}

const clinitEffects = (cls: ClassFile): Effect[] => {
  const m = C.findMethod(cls, '<clinit>');
  return m ? C.simulate(cls, m) : [];
};

/** Constructor calls `X = new Enum("X", ordinal, ...args)` from an enum's <clinit>. */
function enumConstructions(cls: ClassFile): { name: string; args: SimValue[] }[] {
  const out: { name: string; args: SimValue[] }[] = [];
  for (const e of clinitEffects(cls)) {
    if (e.kind === 'putstatic' && e.field.owner === cls.name && C.has(e.value, 'newOf') && e.value.newOf === cls.name && e.value.args) {
      out.push({ name: e.field.name, args: e.value.args.slice(2) });
    }
  }
  return out;
}

/** Name of the static field a `getstatic` simulated value refers to. */
const staticName = (v: SimValue): string | null => (C.has(v, 'static') && C.has(v.static, 'name') ? v.static.name : null);

/** ByteBuffer read calls in a class's own (non-bridge) methods, in class-file order, preceded by its in-jar superclass's. */
function factoryReads(jar: Jar, internalName: string): string[] {
  const cls = jar.load(internalName);
  if (!cls) throw new Error(`class ${internalName} not found in jar`);
  const ops = cls.superClass && jar.load(cls.superClass) ? factoryReads(jar, cls.superClass) : [];
  for (const m of cls.methods) {
    if (!m.code || (m.flags & C.ACC_BRIDGE) || m.name === '<init>' || m.name === '<clinit>') continue;
    for (const ins of C.instructions(m.code)) {
      if (ins.op < 182 || ins.op > 185) continue;
      const ref = C.constant(cls, ins.operands.readUInt16BE(0)) as C.MemberRef;
      if (ref.owner === 'java/nio/ByteBuffer' && BUFFER_OPS.has(ref.name) && ref.desc.startsWith('()')) ops.push(ref.name);
      else if (ref.owner.endsWith('/PieChartNames') && ref.name === 'read') ops.push('PieChartNames.read');
    }
  }
  return ops;
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`could not read ${what} from the jar`);
  return value;
}

/** Extracts everything the parser needs from a mod jar (path, URL or bytes). */
export function extractModData(jarFile: string | URL | Buffer): ModData {
  const jar = openJar(jarFile);
  const modJson = jar.zip.get('fabric.mod.json');
  const modVersion = required<string>(modJson ? JSON.parse(modJson().toString('utf8')).version : null, 'fabric.mod.json version');

  const config = jar.find('anticheat/AntiCheatConfig');
  const keyField = config.fields.find((f) => f.name === 'REPLAY_PUBLIC_KEY_STRING');
  const replayPublicKey = required(typeof keyField?.constantValue === 'string' ? keyField.constantValue : null, 'REPLAY_PUBLIC_KEY_STRING');

  const worlds = C.enumConstants(jar.find('replay/format/WorldTypes'));

  const factoryClasses = new Map<string, string>();
  const ref = (getstatic: SimValue, what: string): string => {
    const owner = C.has(getstatic, 'static') && C.has(getstatic.static, 'owner') ? getstatic.static.owner : null;
    const r = factoryRef(required(owner, `the factory of ${what}`));
    factoryClasses.set(r, owner!);
    return r;
  };

  const tlt = jar.find('replay/format/TimeLineType');
  const storedAs: Record<string, string> = {};
  for (const e of clinitEffects(tlt)) {
    if (e.kind !== 'putfield' || e.field.name !== 'storedAs') continue;
    const from = staticName(e.target);
    const to = staticName(e.value);
    if (from && to) storedAs[from] = to;
  }
  const timelineTypes = enumConstructions(tlt).map(({ name, args }): TimelineType => {
    const row: TimelineType = { id: args[0] as number, name, factory: ref(args[1], name) };
    if (storedAs[name]) row.storedAs = storedAs[name];
    return row;
  });

  const legacyTypes = enumConstructions(jar.find('replay/format/LegacyTimeLineType')).map(({ name, args }): LegacyType => {
    const row: LegacyType = { id: args[0] as number, name, canonical: required(staticName(args[1]), `the canonical type of legacy ${name}`) };
    if (args[2]) row.factory = ref(args[2], `legacy ${name}`);
    return row;
  });

  const enums: Record<string, string[]> = {};
  for (const [key, classes] of Object.entries(ENUM_CLASSES)) {
    const lists = classes.map((c) => C.enumConstants(jar.find(c)));
    if (lists.some((l) => JSON.stringify(l) !== JSON.stringify(lists[0]))) {
      throw new Error(`${key}: ${classes.join(' and ')} differ: ${lists.map((l) => l.join(',')).join(' / ')}`);
    }
    enums[key] = lists[0]!;
  }

  const pie = jar.find('replay/format/PieChartNames');
  const names = clinitEffects(pie).find((e) => e.kind === 'putstatic' && e.field.name === 'NAMES');
  const pieChartNames = required(names && C.has(names.value, 'array') ? (names.value.array as string[]) : null, 'PieChartNames.NAMES');

  const reads: Record<string, string[]> = {};
  for (const [r, cls] of [...factoryClasses].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) reads[r] = factoryReads(jar, cls);
  return { modVersion, replayPublicKey, worlds, timelineTypes, legacyTypes, enums, pieChartNames, factoryReads: reads };
}

// ---------------------------------------------------------------- diff / output

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffKeyed<R>(label: string, before: readonly R[], after: readonly R[], key: (r: R) => string): string[] {
  const out: string[] = [];
  const a = new Map(before.map((r) => [key(r), r]));
  const b = new Map(after.map((r) => [key(r), r]));
  for (const [k, r] of b) {
    if (!a.has(k)) out.push(`${label}: added ${JSON.stringify(r)}`);
    else if (!same(r, a.get(k))) out.push(`${label}: changed ${JSON.stringify(a.get(k))} -> ${JSON.stringify(r)}`);
  }
  for (const [k, r] of a) if (!b.has(k)) out.push(`${label}: removed ${JSON.stringify(r)}`);
  return out;
}

function diffList(label: string, before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
  if (same(before, after)) return [];
  if (!before || !after) return [`${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
  const out: string[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) out.push(`${label}[${i}]: ${JSON.stringify(before[i] ?? null)} -> ${JSON.stringify(after[i] ?? null)}`);
  }
  return out;
}

/** Human-readable differences between two ModData documents (empty when equal). */
export function diffModData(before: ModData, after: ModData): string[] {
  const d: string[] = [];
  if (before.modVersion !== after.modVersion) d.push(`modVersion: ${before.modVersion} -> ${after.modVersion}`);
  if (before.replayPublicKey !== after.replayPublicKey) d.push('replayPublicKey: changed');
  d.push(...diffList('worlds', before.worlds, after.worlds));
  d.push(...diffKeyed('timelineTypes', before.timelineTypes ?? [], after.timelineTypes, (r) => r.name));
  d.push(...diffKeyed('legacyTypes', before.legacyTypes ?? [], after.legacyTypes, (r) => r.name));
  for (const k of new Set([...Object.keys(before.enums ?? {}), ...Object.keys(after.enums)])) {
    d.push(...diffList(`enums.${k}`, before.enums?.[k], after.enums[k]));
  }
  d.push(...diffList('pieChartNames', before.pieChartNames, after.pieChartNames));
  for (const k of new Set([...Object.keys(before.factoryReads ?? {}), ...Object.keys(after.factoryReads)])) {
    const a = before.factoryReads?.[k];
    const b = after.factoryReads[k];
    if (!same(a, b)) d.push(`factoryReads.${k}: ${a ? `[${a.join(' ')}]` : 'none'} -> ${b ? `[${b.join(' ')}]` : 'none'}`);
  }
  return d;
}

/** JSON with every array/object that fits on one line (at its indent) kept on one line. */
export function formatJson(value: unknown, width = 120): string {
  const fmt = (v: unknown, indent: string, prefix = 0): string => {
    const flat = JSON.stringify(v);
    if (v === null || typeof v !== 'object' || indent.length + prefix + flat.length + 1 <= width) return flat;
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== 'object')) {
        // Pack primitives into lines instead of one per line.
        const lines: string[] = [];
        let line = '';
        for (const s of v.map((x) => JSON.stringify(x))) {
          if (line && inner.length + line.length + s.length + 2 > width) { lines.push(line); line = ''; }
          line += line ? ` ${s},` : `${s},`;
        }
        lines.push(line.slice(0, -1));
        return `[\n${lines.map((l) => inner + l).join('\n')}\n${indent}]`;
      }
      return `[\n${v.map((x) => inner + fmt(x, inner)).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${fmt(x, inner, JSON.stringify(k).length + 2)}`);
    return `{\n${entries.join(',\n')}\n${indent}}`;
  };
  return `${fmt(value, '')}\n`;
}
