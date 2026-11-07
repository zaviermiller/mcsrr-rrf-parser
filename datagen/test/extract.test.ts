import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { descriptorArgCount } from '../src/classfile.ts';
import { diffModData, extractModData, factoryRef, formatJson } from '../src/extract-mod.ts';
import type { ModData } from '../src/extract-mod.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = path.join(ROOT, '..', 'data', 'mcsrranked.json');
const CLI = path.join(ROOT, 'src', 'mod.ts');
// Optional: a mod jar (RRF_MOD_JAR, or any mcsrranked-*.jar in datagen/).
const MOD_JAR = process.env.RRF_MOD_JAR || fs.readdirSync(ROOT).filter((n) => /^mcsrranked-.*\.jar$/.test(n)).map((n) => path.join(ROOT, n))[0];
const jarSkip = !MOD_JAR && 'no mod jar (set RRF_MOD_JAR=path/to/mcsrranked-X.Y.Z.jar)';

const sample = (): ModData => ({
  modVersion: '1.0.0',
  replayPublicKey: 'AAAA',
  worlds: ['OVERWORLD', 'NETHER', 'END'],
  timelineTypes: [
    { id: 0, name: 'EMPTY', factory: 'EmptyTimeLine.Empty' },
    { id: 1, name: 'MOVE_DELTA', factory: 'MoveDeltaTimeLine.MoveDelta', storedAs: 'EMPTY' },
  ],
  legacyTypes: [{ id: 0, name: 'EMPTY', canonical: 'EMPTY' }],
  enums: { AttackSound: ['SWEEP', 'CRITICAL'] },
  pieChartNames: ['root', 'root.tick'],
  factoryReads: { 'EmptyTimeLine.Empty': [], 'MoveDeltaTimeLine.MoveDelta': ['get', 'getInt'] },
});

test('factoryRef and descriptorArgCount', () => {
  const pkg = 'com/mcsrranked/client/anticheat/replay/format/timelines/';
  assert.equal(factoryRef(`${pkg}player/PlayerSpawnTimeLine$PlayerSpawnTimeLineFactory`), 'PlayerSpawnTimeLine.PlayerSpawn');
  assert.equal(factoryRef(`${pkg}world/ExplosionEffectTimeline$ExplosionEffectTimelineFactory`), 'ExplosionEffectTimeline.ExplosionEffect');
  assert.equal(factoryRef(`${pkg}block/BlockDeltaTimeLine$UpdateFactory`), 'BlockDeltaTimeLine.UpdateFactory');
  assert.equal(descriptorArgCount('(Ljava/lang/String;I[[JLjava/util/List;D)V'), 5);
});

test('formatJson round-trips and keeps short rows on one line', () => {
  const data = sample();
  const text = formatJson(data);
  assert.deepEqual(JSON.parse(text), data);
  assert.ok(text.endsWith('}\n'));
  assert.match(text, /^ {4}\{"id":0,"name":"EMPTY","factory":"EmptyTimeLine\.Empty"\},?$/m);
});

test('diffModData reports every kind of change', () => {
  const a = sample();
  assert.deepEqual(diffModData(a, sample()), []);
  const b = sample();
  b.modVersion = '1.1.0';
  b.replayPublicKey = 'BBBB';
  b.timelineTypes.push({ id: 2, name: 'WORLD_TIME', factory: 'WorldTimeTimeLine.WorldTime' });
  delete b.timelineTypes[1]!.storedAs;
  b.legacyTypes = [];
  b.enums.AttackSound = ['CRITICAL', 'SWEEP'];
  b.pieChartNames[1] = 'changed';
  b.factoryReads['MoveDeltaTimeLine.MoveDelta'] = ['get'];
  const d = diffModData(a, b);
  for (const re of [/^modVersion: 1\.0\.0 -> 1\.1\.0$/, /^replayPublicKey: changed$/, /^timelineTypes: added .*WORLD_TIME/,
    /^timelineTypes: changed .*MOVE_DELTA/, /^legacyTypes: removed .*EMPTY/, /^enums\.AttackSound\[0\]: "SWEEP" -> "CRITICAL"$/,
    /^pieChartNames\[1\]/, /^factoryReads\.MoveDeltaTimeLine\.MoveDelta: \[get getInt\] -> \[get\]$/]) {
    assert.ok(d.some((x) => re.test(x)), `${re} in\n${d.join('\n')}`);
  }
});

test('CLI usage errors exit 2', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, path.join(os.tmpdir(), 'no-such.jar')], { encoding: 'utf8' }).status, 2);
});

test('extraction from the mod jar equals the committed data/mcsrranked.json', { skip: jarSkip }, () => {
  const data = extractModData(MOD_JAR!);
  assert.deepEqual(diffModData(JSON.parse(fs.readFileSync(DATA, 'utf8')), data), []);
  assert.equal(formatJson(data), fs.readFileSync(DATA, 'utf8'));
});

test('CLI --check: 0 when up to date, 1 with differences; writes otherwise', { skip: jarSkip }, () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, MOD_JAR!, ...args], { encoding: 'utf8' });
  const ok = run('--check', '--out', DATA);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /up to date/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrf-datagen-'));
  try {
    const out = path.join(dir, 'mod.json');
    const stale = JSON.parse(fs.readFileSync(DATA, 'utf8')) as ModData;
    stale.timelineTypes = stale.timelineTypes.filter((t) => t.name !== 'WORLD_TIME');
    fs.writeFileSync(out, JSON.stringify(stale));
    const check = run('--check', '--out', out);
    assert.equal(check.status, 1, check.stdout + check.stderr);
    assert.match(check.stdout, /timelineTypes: added .*WORLD_TIME/);
    assert.equal(fs.readFileSync(out, 'utf8'), JSON.stringify(stale));

    const write = run('--out', out);
    assert.equal(write.status, 0, write.stdout + write.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(DATA, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
