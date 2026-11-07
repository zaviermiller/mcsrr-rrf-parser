import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as api from '../src/index.ts';
import * as internals from '../src/internals.ts';
import { w, buildChunk, snappyLiteral, buildZip, lengthPrefixed, dataOf, must } from './helpers.ts';

const ALICE = '11111111-2222-4333-8444-555555555555';
const BOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const id = (name: string): number => must(api.RECORD_TYPES.find((t) => t.name === name), name).id;
const zombie = (): number => {
  for (let i = 0; ; i++) if (api.registryName('entity_type', i) === 'zombie') return i;
};

function replayFile() {
  const alice = buildChunk(ALICE, [
    { type: id('PLAYER_POSITION_POS'), tick: 0, payload: w().i8(0).f32(0.5).f32(64).f32(0.5).bytes() },
    { type: id('ENTITY_ADD'), tick: 5, payload: w().i8(0).f32(1).f32(64).f32(1).i16(0).i16(0).i32(77).i32(zombie()).i32(0).bytes() },
    { type: id('ENTITY_REMOVE'), tick: 9, payload: w().i8(0).i32(77).i8(1).bytes() },
  ]);
  const bob = buildChunk(BOB, [{ type: id('PLAYER_HELD_SLOT'), tick: 2, payload: w().i8(1).bytes() }]);
  const meta = `{"version": 40, "matchId": 7, "date": 1700000000000, "matchType": 2, "overworldSeed": -1234567890123456789,
    "players": [{"uuid": "${ALICE}", "nickname": "Alice"}, {"uuid": "${BOB}", "nickname": "Bob"}],
    "result": {"uuid": "${ALICE}", "time": 1000}}`;
  return buildZip({ 'meta.json': meta, 'replay.rpd': lengthPrefixed([internals.zstdCompress(alice), snappyLiteral(bob)]) });
}

test('maxEntrySize and maxChunkSize limit decompression', () => {
  const buf = replayFile();
  assert.throws(() => api.parseReplay(buf, { maxEntrySize: 16 }), /byte limit/);
  const rep = api.parseReplay(buf, { maxChunkSize: 8 });
  assert.equal(rep.errors.length, 2);
  assert.ok(rep.errors.every((e) => e.stage === 'decompress'));
  assert.throws(() => api.parseReplay(buf, { maxChunkSize: -1 }), TypeError);
});

test('parseReplay accepts paths, URLs, Buffers, Uint8Arrays and ArrayBuffers', () => {
  const buf = replayFile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrf-api-'));
  try {
    const file = path.join(dir, 'm.rrf');
    fs.writeFileSync(file, buf);
    const u8 = new Uint8Array(buf);
    for (const input of [file, new URL(`file:///${file.replace(/\\/g, '/')}`), buf, u8, u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)]) {
      const rep = api.parseReplay(input);
      assert.ok(rep instanceof api.Replay);
      assert.deepEqual(rep.errors, []);
      assert.equal(rep.findPlayer('alice')!.records.length, 3);
    }
    assert.throws(() => api.parseReplay(42 as any), TypeError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseReplay: names, types filter (case-insensitive, validated) and onRecord', () => {
  const rep = api.parseReplay(replayFile());
  const alice = rep.findPlayer(ALICE.replace(/-/g, ''))!;
  assert.equal(alice.nickname, 'Alice');
  assert.deepEqual(alice.records.map((r) => r.names), [undefined, { entityType: 'zombie', baby: false, mainHand: 'air' }, { entityType: 'zombie' }]);
  assert.equal(alice.records[0].chunk, 0);
  assert.ok(api.parseReplay(replayFile(), { names: false }).findPlayer('alice')!.records.every((r) => !('names' in r)));

  const filtered = api.parseReplay(replayFile(), { types: ['entity_remove'] });
  assert.deepEqual(filtered.findPlayer('alice')!.records.map((r) => [r.type, r.names]), [['ENTITY_REMOVE', { entityType: 'zombie' }]]);
  assert.equal(filtered.findPlayer('bob')!.records.length, 0);
  assert.equal(api.parseReplay(replayFile(), { types: 'PLAYER_HELD_SLOT,ENTITY_ADD' }).findPlayer('bob')!.records.length, 1);
  assert.throws(() => api.parseReplay(replayFile(), { types: ['NOPE'] }), /unknown record type: NOPE/);

  const seen: string[] = [];
  const rep2 = api.parseReplay(replayFile(), { onRecord: (p, r) => seen.push(`${p.nickname}:${r.type}`) });
  assert.deepEqual(seen, ['Alice:PLAYER_POSITION_POS', 'Alice:ENTITY_ADD', 'Alice:ENTITY_REMOVE', 'Bob:PLAYER_HELD_SLOT']);
  assert.equal(rep2.findPlayer('alice')!.records.length, 0);
});

test('readReplay reads asynchronously', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrf-api-'));
  try {
    const file = path.join(dir, 'm.rrf');
    fs.writeFileSync(file, replayFile());
    const rep = await api.readReplay(file, { types: ['PLAYER_HELD_SLOT'] });
    assert.equal(dataOf(rep.findPlayer('bob')!.records[0], 'PLAYER_HELD_SLOT').slot, 1);
    await assert.rejects(api.readReplay(path.join(dir, 'missing.rrf')), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openReplay exposes meta before decoding and streams records', () => {
  const opened = api.openReplay(replayFile(), { types: ['ENTITY_ADD', 'PLAYER_HELD_SLOT'] });
  assert.equal(opened.meta.matchId, 7);
  assert.equal(opened.meta.overworldSeed, '-1234567890123456789');
  assert.equal(opened.chunkCount, 2);
  const items = [...opened.records()];
  assert.deepEqual(items.map((i) => [i.nickname, i.chunk, i.record.type]), [['Alice', 0, 'ENTITY_ADD'], ['Bob', 1, 'PLAYER_HELD_SLOT']]);
  assert.equal(items[0]?.record.names?.entityType, 'zombie');
  assert.equal([...opened.records()].length, 2);
  assert.deepEqual(opened.errors, []);
});

test('summarize, formatSummary, toJSON and writeJSON', () => {
  const rep = api.parseReplay(replayFile());
  const s = api.summarize(rep);
  assert.equal(s.matchId, 7);
  assert.deepEqual(s.result, { uuid: ALICE, nickname: 'Alice', timeMs: 1000 });
  assert.deepEqual(s.players.map((p) => [p.nickname, p.records, p.minTick, p.maxTick]), [['Alice', 3, 0, 9], ['Bob', 1, 2, 2]]);
  assert.deepEqual(s.players[0].counts, { PLAYER_POSITION_POS: 1, ENTITY_ADD: 1, ENTITY_REMOVE: 1 });
  assert.deepEqual(api.summarize(rep, { player: 'bob' }).players.map((p) => p.nickname), ['Bob']);
  assert.match(api.formatSummary(rep), /player Alice 11111111-2222-4333-8444-555555555555/);
  assert.throws(() => api.summarize(rep, { player: 'nobody' }), /player not found/);

  const json = JSON.parse(api.toJSON(rep, { player: 'alice' }));
  assert.deepEqual(Object.keys(json.players), [ALICE]);
  assert.equal(json.meta.overworldSeed, '-1234567890123456789');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrf-api-'));
  try {
    const out = path.join(dir, 'out.json');
    api.writeJSON(rep, out);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), JSON.parse(api.toJSON(rep)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lookups and constants', () => {
  assert.equal(api.MINECRAFT_VERSION, '1.16.1');
  assert.match(api.MOD_VERSION, /^\d+\.\d+/);
  assert.deepEqual([...api.WORLDS], ['OVERWORLD', 'NETHER', 'END']);
  assert.deepEqual(api.RECORD_TYPES.find((t) => t.name === 'PLAYER_POSITION_DELTA'), { id: 14, name: 'PLAYER_POSITION_DELTA', storedAs: 'PLAYER_POSITION' });
  assert.ok(Object.isFrozen(api.RECORD_TYPES));
  assert.equal(api.registryName('item', 1), 'stone');
  assert.equal(api.registryName('item', -1), null);
  assert.throws(() => api.registryName('nope' as any, 1), /unknown registry/);
  assert.equal(api.blockState(0), 'air');
  assert.equal(typeof internals.Reader, 'function');
  assert.ok(!('internals' in api));
});

test('legacyPublicKey accepts a KeyObject, PEM or base64 SPKI', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aesKey = crypto.randomBytes(16);
  const symmetricKey = crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString('base64');
  const chunk = buildChunk(BOB, [{ type: id('PLAYER_HELD_SLOT'), tick: 2, payload: w().i8(4).bytes() }]);
  const c = crypto.createCipheriv('aes-128-ecb', aesKey, null);
  const enc = Buffer.concat([c.update(internals.zstdCompress(chunk)), c.final()]);
  const file = buildZip({
    'meta.json': JSON.stringify({ version: 35, symmetricKey, players: [{ uuid: BOB, nickname: 'Bob' }], result: {} }),
    'replay.rpd': lengthPrefixed([enc]),
  });
  for (const key of [publicKey, publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]) {
    assert.equal(dataOf(api.parseReplay(file, { legacyPublicKey: key }).findPlayer('bob')!.records[0], 'PLAYER_HELD_SLOT').slot, 4);
  }
});
