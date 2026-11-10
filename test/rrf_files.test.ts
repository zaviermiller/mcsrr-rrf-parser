import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as P from '../src/internals.ts';
import { w, buildChunk, snappyLiteral, buildZip, lengthPrefixed, dataOf, must } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'bin', 'mcsrr-rrf.ts');
const ALICE = '11111111-2222-4333-8444-555555555555';
const BOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GHOST = 'deadbeef-0000-4000-8000-000000000001';
const T = (name: string): number => must(P.TYPE_BY_NAME.get(name), name).id;

const pos = (world: number, x: number, y: number, z: number) => w().i8(world).f32(x).f32(y).f32(z).bytes();
const held = (slot: number) => w().i8(slot).bytes();

function metaJson(version: number, extra = ''): string {
  return `{"version": ${version}, "matchId": 4242, "date": 1700000000000, "matchType": 2,
    "overworldSeed": -1234567890123456789, "netherSeed": 42, "theEndSeed": 9007199254740993,
    "players": [{"uuid": "${ALICE.replace(/-/g, '')}", "nickname": "Alice", "roleType": 1, "eloRate": 1500},
                {"uuid": "${BOB}", "nickname": "Bob"}],
    "result": {"uuid": "${BOB}", "time": 612345}${extra}}`;
}

function aliceChunks() {
  return [
    buildChunk(ALICE, [
      { type: T('PLAYER_POSITION_POS'), tick: 0, payload: pos(0, 0.5, 64, 0.5) },
      { type: T('PLAYER_POSITION_POS_DELTA'), tick: 1, payload: w().i16(4096).i16(0).i16(-4096).bytes() },
      { type: T('PLAYER_HELD_SLOT'), tick: 300, payload: held(4) },
    ]),
    buildChunk(ALICE, [
      { type: T('PLAYER_POSITION_POS'), tick: 400, payload: pos(1, 10, 70, 10) },
    ]),
  ];
}

function bobChunk() {
  return buildChunk(BOB, [
    { type: T('PLAYER_HELD_SLOT'), tick: 2, payload: held(1) },
    { type: T('PLAYER_PAUSE'), tick: 3, payload: w().i8(1).bytes() },
  ]);
}

function v40File({ extraChunks = [], tail = Buffer.alloc(0), deflate = true }: { extraChunks?: Buffer[]; tail?: Buffer; deflate?: boolean } = {}): Buffer {
  const [a1, a2] = aliceChunks();
  const rpd = Buffer.concat([
    lengthPrefixed([P.zstdCompress(a1), snappyLiteral(bobChunk()), P.zstdCompress(a2), ...extraChunks]),
    tail,
  ]);
  return buildZip({
    'meta.json': metaJson(40),
    'timelines.json': '[{"uuid": "x", "type": "nether_enter", "time": 1234}, null, 5]',
    'replay.rpd': rpd,
  }, { deflate });
}

function aesEcb(key: Buffer, buf: Buffer): Buffer {
  const c = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([c.update(buf), c.final()]);
}

let rsa: crypto.KeyPairKeyObjectResult | undefined;
function legacyKeys() {
  if (!rsa) rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aesKey = crypto.randomBytes(16);
  const symmetricKey = crypto.privateEncrypt({ key: rsa.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString('base64');
  return { aesKey, symmetricKey, publicKey: rsa.publicKey };
}

// ------------------------------------------------------------------ codecs / container

test('snappy decoder handles literal, copy1, copy2 and overlapping copies', () => {
  const src = Buffer.from([11, (1 << 2) | 0, 0x61, 0x62, ((6 - 4) << 2) | 1, 2, ((3 - 1) << 2) | 2, 1, 0]);
  assert.equal(P.snappyDecompress(src).toString(), 'ababababbbb');
  const big = crypto.randomBytes(70000);
  assert.deepEqual(P.snappyDecompress(snappyLiteral(big)), big);
  assert.throws(() => P.snappyDecompress(Buffer.from([4, (3 << 2) | 0, 1, 2])), /snappy/);
  assert.throws(() => P.snappyDecompress(Buffer.from([4, 1, 9])), /bad copy offset/);
});

test('codec detection: zstd by magic + content size, otherwise snappy; NONE below v32', () => {
  const data = Buffer.from('hello replay '.repeat(50));
  const z = P.zstdCompress(data);
  assert.equal(P.zstdContentSize(z), data.length);
  assert.deepEqual(P.decompressChunk(z), data);
  assert.deepEqual(P.decompressChunk(snappyLiteral(data)), data);
  // zstd magic but no frame content size -> Java falls back to Snappy (and fails here).
  assert.throws(() => P.decompressChunk(Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x00, 0x00, 0x00])), /snappy/);
  assert.deepEqual(P.decompressChunk(z, false), z);
});

test('Java Base64.getDecoder semantics', () => {
  assert.deepEqual(P.decodeBase64Strict('YWJj'), Buffer.from('abc'));
  assert.deepEqual(P.decodeBase64Strict('YWI'), Buffer.from('ab'));
  assert.deepEqual(P.decodeBase64Strict('YWI='), Buffer.from('ab'));
  assert.throws(() => P.decodeBase64Strict('YW J'), /Illegal base64 character/);
  assert.throws(() => P.decodeBase64Strict('YWJjZ'), /Illegal base64/);
  assert.throws(() => P.decodeBase64Strict('YWJj='), /Illegal base64/);
});

test('ZIP reader: stored and deflated entries, CRC check', () => {
  for (const deflate of [false, true]) {
    const zip = P.readZip(buildZip({ a: 'alpha', 'dir/b.bin': Buffer.from([1, 2, 3]) }, { deflate }));
    assert.equal(must(zip.get('a'))().toString(), 'alpha');
    assert.deepEqual(must(zip.get('dir/b.bin'))(), Buffer.from([1, 2, 3]));
  }
  const bad = buildZip({ a: 'alpha' }, { deflate: false });
  bad[30 + 1] ^= 0xFF;
  assert.throws(() => must(P.readZip(bad).get('a'))(), /CRC/);
  assert.throws(() => P.readZip(Buffer.from('nope')), /not a ZIP/);
});

test('ZIP reader: size limits stop decompression bombs', () => {
  const big = Buffer.alloc(1 << 20);
  const zip = buildZip({ a: big });
  assert.throws(() => must(P.readZip(zip, 1000).get('a'))(), /over the 1000 byte limit/);
  assert.equal(must(P.readZip(zip, big.length).get('a'))().length, big.length);
  // A central directory that understates the inflated size must not inflate past it.
  const lying = Buffer.from(zip);
  const cd = lying.readUInt32LE(lying.length - 22 + 16);
  lying.writeUInt32LE(10, cd + 24);
  assert.throws(() => must(P.readZip(lying).get('a'))(), /size mismatch/);
});

test('chunk decompression honours maxSize', () => {
  const data = Buffer.alloc(5000, 7);
  assert.throws(() => P.decompressChunk(P.zstdCompress(data), true, 4999), /over the 4999 byte limit/);
  assert.throws(() => P.decompressChunk(snappyLiteral(data), true, 4999), /too large/);
  assert.deepEqual(P.decompressChunk(P.zstdCompress(data), true, 5000), data);
});

test('meta: lossless big integers and <30 migration', () => {
  const m = P.normalizeMeta(P.parseJsonLossless(metaJson(40)) as P.RawMeta);
  assert.equal(m.overworldSeed, '-1234567890123456789');
  assert.equal(m.theEndSeed, '9007199254740993');
  assert.equal(m.netherSeed, '42');
  const old = P.normalizeMeta({ version: 20, time: 5, seed: 7, finalTimes: [{ uuid: BOB, finalTime: 99 }], players: [{ uuid: BOB, nickname: 'Bob', badge: 3, elo_rate: 1200 }] });
  assert.equal(old.version, 0);
  assert.equal(old.fileVersion, 20);
  assert.deepEqual(old.result, { uuid: BOB, time: 99 });
  assert.equal(old.theEndSeed, '7');
  assert.deepEqual(old.players[0], { uuid: BOB, nickname: 'Bob', roleType: 3, eloRate: 1200, eloRank: null, country: null });
});

// ------------------------------------------------------------------ whole files

test('v40 file: zstd + snappy chunks, players grouped with nicknames, per-UUID delta state', () => {
  const rep = P.parseRrf(v40File());
  assert.deepEqual(rep.errors, []);
  assert.deepEqual(rep.warnings, []);
  assert.equal(rep.meta.version, 40);
  assert.equal(rep.timelines.length, 1);
  assert.deepEqual([...rep.players.keys()], [ALICE, BOB]);
  const alice = rep.findPlayer('alice')!;
  assert.equal(alice, rep.findPlayer(ALICE.replace(/-/g, '').toUpperCase())!);
  assert.equal(alice.chunks, 2);
  assert.deepEqual(alice.records.map((r) => [r.chunk, r.tick, r.type]), [
    [0, 0, 'PLAYER_POSITION_POS'], [0, 1, 'PLAYER_POSITION_POS'], [0, 300, 'PLAYER_HELD_SLOT'], [2, 400, 'PLAYER_POSITION_POS'],
  ]);
  const moved = dataOf(alice.records[1], 'PLAYER_POSITION_POS');
  assert.deepEqual([moved.x, moved.z], [1.5, -0.5]);
  const bob = rep.findPlayer('Bob')!;
  assert.deepEqual(bob.records.map((r) => [r.tick, r.type, r.data]), [[2, 'PLAYER_HELD_SLOT', { slot: 1 }], [3, 'PLAYER_PAUSE', { paused: true }]]);
  const s = P.summarizePlayer(alice);
  assert.deepEqual([s.minTick, s.maxTick, s.finalPosition?.world], [0, 400, 'NETHER']);
  assert.deepEqual(s.issues, []);
});

test('v40 files from mod 6.0.0-6.0.4 and 6.0.9+ both parse (same version number, different DRAGON_ZERO layout)', () => {
  const reached = w().i8(0).f32(45).i8(3).f32(1).f32(2).f32(3).i8(1).bytes();
  const file = (flewAway: Buffer, metaExtra: string) => buildZip({
    'meta.json': metaJson(40, metaExtra),
    'replay.rpd': lengthPrefixed([P.zstdCompress(buildChunk(ALICE, [
      { type: T('DRAGON_ZERO'), tick: 10, payload: reached },
      { type: T('DRAGON_ZERO'), tick: 20, payload: flewAway },
      { type: T('PLAYER_HELD_SLOT'), tick: 30, payload: held(2) },
    ]))]),
  });
  const zeros = (rep: P.Replay) => rep.findPlayer(ALICE)!.records.map((r) => [r.type, (r.data as { flyAwayHeight?: number | null }).flyAwayHeight]);

  const old = P.parseRrf(file(w().i8(1).bytes(), ''));
  assert.deepEqual([old.errors, old.warnings, old.meta.version, old.meta.raceId], [[], [], 40, null]);
  assert.deepEqual(zeros(old), [['DRAGON_ZERO', null], ['DRAGON_ZERO', null], ['PLAYER_HELD_SLOT', undefined]]);

  const cur = P.parseRrf(file(w().i8(2).f32(68.25).bytes(), ', "raceId": 77'));
  assert.deepEqual([cur.errors, cur.warnings, cur.meta.version, cur.meta.raceId], [[], [], 40, 77]);
  assert.deepEqual(zeros(cur), [['DRAGON_ZERO', null], ['DRAGON_ZERO', 68.25], ['PLAYER_HELD_SLOT', undefined]]);
});

test('type filter and onRecord streaming', () => {
  const rep = P.parseRrf(v40File({ deflate: false }), { types: new Set(['PLAYER_POSITION_POS_DELTA', 'PLAYER_PAUSE']) });
  assert.deepEqual(rep.findPlayer('Alice')!.records.map((r) => r.wireType), ['PLAYER_POSITION_POS_DELTA']);
  assert.deepEqual(rep.findPlayer('Bob')!.records.map((r) => r.type), ['PLAYER_PAUSE']);
  let n = 0;
  const streamed = P.parseRrf(v40File(), { onRecord: () => { n++; } });
  assert.equal(n, 6);
  assert.equal(streamed.findPlayer('Alice')!.records.length, 0);
  const viaIter = [...P.iterRecords(v40File())];
  assert.equal(viaIter.length, 6);
  assert.equal(viaIter[0].uuid, ALICE);
});

test('bad chunks are reported and decoding continues; truncated tail is a warning', () => {
  const unknown = P.zstdCompress(Buffer.concat([buildChunk(BOB, [{ type: T('PLAYER_HELD_SLOT'), tick: 9, payload: held(2) }]), Buffer.from([99, 0])]));
  const truncated = snappyLiteral(buildChunk(GHOST, [{ type: T('PLAYER_RIDE'), tick: 1, payload: Buffer.from([0, 0]) }]));
  const garbage = Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 0xFF, 0xFF]);
  const later = P.zstdCompress(buildChunk(GHOST, [{ type: T('PLAYER_HELD_SLOT'), tick: 50, payload: held(8) }]));
  const rep = P.parseRrf(v40File({ extraChunks: [unknown, truncated, garbage, later], tail: Buffer.from([0, 0, 0, 50, 1, 2]) }));
  assert.equal(rep.errors.length, 3);
  assert.deepEqual(rep.errors.map((e) => [e.chunk, e.stage, e.typeId]), [[3, 'decode', 99], [4, 'decode', T('PLAYER_RIDE')], [5, 'decompress', null]]);
  assert.equal(rep.errors[0].uuid, BOB);
  assert.equal(rep.errors[0].recordsDiscarded, 1);
  assert.equal(rep.errors[0].offset, 20);
  assert.match(rep.errors[1].message, /underflow/);
  assert.equal(rep.warnings.length, 1);
  assert.match(rep.warnings[0], /declares 50 bytes/);
  const ghost = rep.findPlayer(GHOST)!;
  assert.equal(ghost.inMeta, false);
  assert.deepEqual(ghost.records.map((r) => r.tick), [50]);
  assert.ok(P.summarizePlayer(ghost).issues.includes('UUID not present in meta.players'));
});

test('v35 legacy encrypted file (AES before codec)', () => {
  const { aesKey, symmetricKey, publicKey } = legacyKeys();
  const [a1, a2] = aliceChunks();
  const rpd = lengthPrefixed([aesEcb(aesKey, P.zstdCompress(a1)), aesEcb(aesKey, snappyLiteral(a2)), aesEcb(aesKey, P.zstdCompress(bobChunk()))]);
  const file = buildZip({ 'meta.json': metaJson(35, `, "symmetricKey": "${symmetricKey}"`), 'replay.rpd': rpd });
  // The default (embedded mod) key can't decrypt a symmetricKey made with the test keypair.
  assert.throws(() => P.parseRrf(file), /could not decrypt meta.symmetricKey/);
  const rep = P.parseRrf(file, { legacyPublicKey: publicKey });
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.findPlayer('Alice')!.records.length, 4);
  assert.equal(rep.findPlayer('Bob')!.records.length, 2);
  const noKey = buildZip({ 'meta.json': metaJson(35), 'replay.rpd': rpd });
  assert.throws(() => P.parseRrf(noKey, { legacyPublicKey: publicKey }), /no symmetricKey/);
});

test('v31 file: base64 lines, AES, no codec', () => {
  const { aesKey, symmetricKey, publicKey } = legacyKeys();
  const lines = aesEcb(aesKey, bobChunk()).toString('base64');
  const rep = P.parseRrf(buildZip({ 'meta.json': metaJson(31, `, "symmetricKey": "${symmetricKey}"`), 'replay.rpd': lines }), { legacyPublicKey: publicKey });
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.findPlayer('Bob')!.records.length, 2);
});

test('v20 file: migrated meta, base64 lines (CRLF), AES, legacy format-0 records', () => {
  const { aesKey, symmetricKey, publicKey } = legacyKeys();
  const chunk = buildChunk(BOB, [
    { type: 30, tick: 5, payload: w().i8(1).bytes() },
    { type: 15, tick: 6, payload: w().i32(7).i8(2).i8(1).bytes() },
  ], { format: 0 });
  const rpd = `${aesEcb(aesKey, chunk).toString('base64')}\r\n\r\n${aesEcb(aesKey, buildChunk(BOB, [{ type: T('PLAYER_HELD_SLOT'), tick: 7, payload: held(3) }])).toString('base64').replace(/=+$/, '')}\r\n`;
  const meta = JSON.stringify({ version: 20, time: 1600000000000, seed: 77, symmetricKey, finalTimes: [{ uuid: BOB, finalTime: 1000 }], players: [{ uuid: BOB, nickname: 'Bob', badge: 0, elo_rate: 1000 }] });
  const rep = P.parseRrf(buildZip({ 'meta.json': meta, 'replay.rpd': rpd }), { legacyPublicKey: publicKey });
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.meta.migratedFromUnder30, true);
  const recs = rep.findPlayer('bob')!.records;
  assert.deepEqual(recs.map((r) => [r.tick, r.type, r.legacy === true]), [[5, 'PLAYER_PAUSE', true], [6, 'INVENTORY_SLOT', true], [7, 'PLAYER_HELD_SLOT', false]]);
  const slot = dataOf(recs[1], 'INVENTORY_SLOT');
  assert.equal(slot.slot, 36); // EquipmentSlot.FEET
  assert.equal(slot.legacyEquipmentSlot, 'FEET');
  assert.equal(slot.count, 1);
  assert.deepEqual(slot.enchantments, [{ id: 0, level: 1 }]);
});

test('embedded replay public key (data/mcsrranked.json) loads as RSA-2048', () => {
  const key = P.loadPublicKey();
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048);
});

test('legacy key derivation: RSA private-encrypt / public-decrypt round trip, also via a base64 SPKI key', () => {
  // Same flow the mod uses: symmetricKey = RSA_private_encrypt(aesKey); the reader public-decrypts it.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aesKey = crypto.randomBytes(16);
  const symmetricKey = crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString('base64');
  assert.deepEqual(P.deriveAesKey(symmetricKey, publicKey), aesKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.deepEqual(P.deriveAesKey(symmetricKey, P.loadPublicKey(spki)), aesKey);
});

test('missing archive entries are fatal', () => {
  assert.throws(() => P.parseRrf(buildZip({ 'meta.json': metaJson(40) })), /replay.rpd missing/);
  assert.throws(() => P.parseRrf(buildZip({ 'replay.rpd': '' })), /meta.json missing/);
});

// ------------------------------------------------------------------ CLI

test('CLI: JSON, --summary, --player, --types and exit codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrf-test-'));
  try {
    const file = path.join(dir, 'match.rrf');
    fs.writeFileSync(file, v40File());
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

    const out = path.join(dir, 'out.json');
    let r = run(file, '-o', out);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(json.meta.overworldSeed, '-1234567890123456789');
    assert.deepEqual(Object.keys(json.players), [ALICE, BOB]);
    assert.equal(json.players[ALICE].records.length, 4);

    r = run(file, '--player', 'bob', '--types', 'player_pause');
    assert.equal(r.status, 0, r.stderr);
    const bobOnly = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(bobOnly.players), [BOB]);
    assert.deepEqual(bobOnly.players[BOB].records.map((x: { type: string }) => x.type), ['PLAYER_PAUSE']);

    r = run(file, '--player', 'alice', '--types', 'player_position_pos', '--no-names');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).players[ALICE].records.every((x: object) => !('names' in x)));

    r = run(file, '--summary');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /player Alice 11111111-2222-4333-8444-555555555555/);
    assert.match(r.stdout, /final position: NETHER 10\.000 70\.000 10\.000 @ tick 400/);
    assert.match(r.stdout, /result: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee \(Bob\)/);

    const bad = path.join(dir, 'bad.rrf');
    fs.writeFileSync(bad, v40File({ extraChunks: [Buffer.from([1, 2, 3])] }));
    r = run(bad, '--summary');
    assert.equal(r.status, 3);
    assert.match(r.stdout, /decode errors: 1/);

    assert.equal(run(file, '--player', 'nobody').status, 1);
    assert.equal(run(path.join(dir, 'missing.rrf')).status, 1);
    assert.equal(run().status, 2);
    assert.equal(run(file, '--bogus').status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
