// Regenerates data/mc_1_16_1.json from Minecraft 1.16.1 jars (by default the ones Fabric Loom
// caches in ~/.gradle/caches/fabric-loom; pass them explicitly otherwise). Needs a JDK.
//   * registries.json / blocks.json come from the vanilla data generator (net.minecraft.data.Main
//     --reports) run against the official 1.16.1 server jar, so ids are the real raw registry ids.
//   * enum orders and entity class hierarchies come from javap on the yarn-mapped merged jar.
// Usage: node src/mc.ts [--java-home <jdk>] [--server-jar <jar>] [--yarn-jar <jar>]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

/** Shape of data/mc_1_16_1.json (the parser's src/mc-data.ts declares the same). */
type BlockRow = [name: string, firstId: number, props?: [name: string, values: string[]][]];
interface McData {
  minecraft: string;
  generatedBy: string;
  registries: Record<'item' | 'entity_type' | 'mob_effect' | 'enchantment' | 'potion' | 'menu' | 'villager_type' | 'villager_profession', string[]>;
  blocks: BlockRow[];
  enums: Record<'Hand' | 'EquipmentSlot' | 'EntityPose' | 'DyeColor' | 'BoatType' | 'DragonPhase', string[]>;
  entityKinds: Record<string, string>;
}

interface RegistriesReport { [registry: string]: { entries: Record<string, { protocol_id: number }> } }
interface BlocksReport {
  [block: string]: { properties?: Record<string, string[]>; states: { id: number; properties?: Record<string, string> }[] };
}

const MC = '1.16.1';
const OUT = path.join(import.meta.dirname, '..', '..', 'data', 'mc_1_16_1.json');
const REGISTRIES: (keyof McData['registries'])[] = ['item', 'entity_type', 'mob_effect', 'enchantment', 'potion', 'menu', 'villager_type', 'villager_profession'];
const ENUM_CLASSES: Record<keyof McData['enums'], string> = {
  Hand: 'net.minecraft.util.Hand',
  EquipmentSlot: 'net.minecraft.entity.EquipmentSlot',
  EntityPose: 'net.minecraft.entity.EntityPose',
  DyeColor: 'net.minecraft.util.DyeColor',
  BoatType: 'net.minecraft.entity.vehicle.BoatEntity$Type',
  // Not an enum: ids are assigned in declaration order by PhaseType.register.
  DragonPhase: 'net.minecraft.entity.boss.dragon.phase.PhaseType',
};
// Order matters: mirrors the instanceof chains in EntityAddTimeLine and MobStateTimeLine.
const KIND_CLASSES: [string, string][] = [
  ['slime', 'net.minecraft.entity.mob.SlimeEntity'],
  ['living', 'net.minecraft.entity.LivingEntity'],
  ['tnt', 'net.minecraft.entity.TntEntity'],
  ['falling_block', 'net.minecraft.entity.FallingBlockEntity'],
  ['boat', 'net.minecraft.entity.vehicle.BoatEntity'],
];
const TRAIT_CLASSES: [string, string][] = [
  ['villager', 'net.minecraft.village.VillagerDataContainer'],
  ['sheep', 'net.minecraft.entity.passive.SheepEntity'],
  ['enderman', 'net.minecraft.entity.mob.EndermanEntity'],
];
// Registered via EntityType.Builder.create(SpawnGroup) without a constructor reference.
const NO_FACTORY: Record<string, string> = {
  player: 'net.minecraft.entity.player.PlayerEntity',
  fishing_bobber: 'net.minecraft.entity.projectile.FishingBobberEntity',
};

function findFile(dir: string, test: (p: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, test);
      if (r) return r;
    } else if (test(p)) return p;
  }
  return null;
}

function main(): void {
  const { values } = parseArgs({
    options: { 'java-home': { type: 'string' }, 'server-jar': { type: 'string' }, 'yarn-jar': { type: 'string' } },
  });
  const loom = path.join(os.homedir(), '.gradle', 'caches', 'fabric-loom');
  const serverJar = values['server-jar'] || path.join(loom, MC, 'minecraft-server.jar');
  const yarnJar = values['yarn-jar'] || findFile(path.join(loom, 'minecraftMaven', 'net', 'minecraft', 'minecraft-merged'),
    (p) => p.endsWith('.jar') && p.includes(`${MC}-net.fabricmc.yarn`) && !p.includes('sources'));
  const javaHome = values['java-home'] || process.env.JAVA_HOME;
  const bin = (n: string) => (javaHome ? path.join(javaHome, 'bin', n) : n);
  for (const [what, p] of [['server jar', serverJar], ['yarn merged jar', yarnJar]] as const) {
    if (!p || !fs.existsSync(p)) throw new Error(`${what} not found (${p}); pass it explicitly`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdata-'));
  try {
    execFileSync(bin('java'), ['-cp', serverJar, 'net.minecraft.data.Main', '--reports', '--output', tmp],
      { cwd: tmp, stdio: ['ignore', 'ignore', 'inherit'] });
    const reports = path.join(tmp, 'reports');
    const regs: RegistriesReport = JSON.parse(fs.readFileSync(path.join(reports, 'registries.json'), 'utf8'));
    const blocks: BlocksReport = JSON.parse(fs.readFileSync(path.join(reports, 'blocks.json'), 'utf8'));
    const javap = (...args: string[]) => execFileSync(bin('javap'), ['-cp', yarnJar!, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 }).replace(/\r/g, '');

    const registries = {} as McData['registries'];
    for (const name of REGISTRIES) {
      const arr: string[] = [];
      for (const [id, { protocol_id: pid }] of Object.entries(regs[`minecraft:${name}`].entries)) {
        if (!id.startsWith('minecraft:')) throw new Error(`non-vanilla id ${id}`);
        arr[pid] = id.slice('minecraft:'.length);
      }
      registries[name] = Array.from(arr, (v) => v ?? null) as string[];
    }

    // Each block's states are the property product with the last property varying fastest;
    // verified state-by-state so the compact table is exact.
    const blockTable: BlockRow[] = [];
    let expectedId = 0;
    for (const [id, blk] of Object.entries(blocks)) {
      const props = Object.entries(blk.properties || {});
      const first = blk.states[0]!.id;
      if (first !== expectedId) throw new Error(`state ids not contiguous at ${id}`);
      blk.states.forEach((s, i) => {
        if (s.id !== first + i) throw new Error(`state ids not contiguous in ${id}`);
        let idx = i;
        for (let p = props.length - 1; p >= 0; p--) {
          const [k, vals] = props[p]!;
          if (s.properties?.[k] !== vals[idx % vals.length]) throw new Error(`state order mismatch in ${id}`);
          idx = Math.floor(idx / vals.length);
        }
      });
      expectedId = first + blk.states.length;
      blockTable.push(props.length ? [id.slice('minecraft:'.length), first, props] : [id.slice('minecraft:'.length), first]);
    }

    const enums = {} as McData['enums'];
    for (const [key, cls] of Object.entries(ENUM_CLASSES) as [keyof McData['enums'], string][]) {
      const self = cls.replace(/\$/g, '\\$');
      enums[key] = [...javap('-p', cls).matchAll(new RegExp(`^\\s+public static final ${self}(?:<[^>]*>)? (\\w+);$`, 'gm'))].map((m) => m[1]!);
      if (!enums[key].length) throw new Error(`no constants found for ${cls}`);
    }

    // EntityType.<clinit>: ldc "name" -> invokedynamic #bsm:create -> ... -> register(name, builder).
    const et = javap('-c', '-v', '-p', 'net.minecraft.entity.EntityType');
    const bsm: Record<string, string> = {};
    const bsText = et.slice(et.indexOf('BootstrapMethods:'));
    for (const m of bsText.matchAll(/^\s+(\d+): #\d+ REF_invokeStatic[^\n]*\n\s+Method arguments:\n((?:\s+#\d+[^\n]*\n)+)/gm)) {
      const c = m[2]!.match(/REF_newInvokeSpecial ([\w/$]+)\."<init>"/);
      if (c) bsm[m[1]!] = c[1]!.replace(/\//g, '.');
    }
    const classOf: Record<string, string | undefined> = {};
    let pending: string | null = null;
    for (const line of et.slice(et.indexOf('static {};')).split('\n')) {
      let m: RegExpMatchArray | null;
      if ((m = line.match(/ldc(?:_w)?\s+#\d+\s+\/\/ String ([a-z_]+)$/))) pending = m[1]!;
      else if (pending && (m = line.match(/invokedynamic #\d+,\s+0\s+\/\/ InvokeDynamic #(\d+):create/))) classOf[pending] = bsm[m[1]!];
      else if (pending && /invokestatic.*Method register:/.test(line)) {
        if (!classOf[pending]) classOf[pending] = NO_FACTORY[pending];
        pending = null;
      }
    }
    const supers: Record<string, string[]> = {};
    let todo = [...new Set(Object.values(classOf))].filter((c): c is string => !!c);
    while (todo.length) {
      const txt = javap(...todo);
      todo = [];
      for (const m of txt.matchAll(/^[\w ]*?(class|interface) ([\w.$]+)(?: extends ([\w.$,]+))?(?: implements ([\w.$,]+))?/gm)) {
        const cls = m[2]!;
        supers[cls] = [...(m[3] ? m[3].split(',') : []), ...(m[4] ? m[4].split(',') : [])];
        for (const s of supers[cls]!) if (s.startsWith('net.minecraft') && !(s in supers) && !todo.includes(s)) todo.push(s);
      }
    }
    const ancestors = (c: string, seen = new Set<string>()): Set<string> => {
      if (!seen.has(c)) { seen.add(c); for (const s of supers[c] || []) ancestors(s, seen); }
      return seen;
    };
    const entityKinds: Record<string, string> = {};
    for (const name of registries.entity_type) {
      if (!classOf[name]) throw new Error(`no class for entity type ${name}`);
      const a = ancestors(classOf[name]!);
      const kind = KIND_CLASSES.find(([, c]) => a.has(c))?.[0] ?? 'other';
      const traits = TRAIT_CLASSES.filter(([, c]) => a.has(c)).map(([t]) => t);
      if (kind !== 'other' || traits.length) entityKinds[name] = traits.length ? [kind, ...traits].join('+') : kind;
    }

    const data: McData = { minecraft: MC, generatedBy: 'datagen/src/mc.ts', registries, blocks: blockTable, enums, entityKinds };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(data) + '\n');
    const counts = Object.fromEntries(Object.entries(registries).map(([k, v]) => [k, v.length]));
    process.stdout.write(`wrote ${OUT}\n${JSON.stringify({ ...counts, blocks: blockTable.length, blockStates: expectedId })}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
