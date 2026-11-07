# MCSR Ranked `.rrf` replay format

This is the byte-level description that `mcsrr-rrf-parser` implements, for MCSR Ranked on **Minecraft 1.16.1**
(currently mod version 6.0.4). It was worked out from the mod's classes. Class names in this document refer to classes in the mod jar, under
`com/mcsrranked/client/anticheat/replay/`. The parser does not need the mod jar at runtime: the mod data lives in
`data/mcsrranked.json`, and the Minecraft 1.16.1 data lives in `data/mc_1_16_1.json` (see §7).

For what each record means, when it is emitted, and its units and special values, see [EVENTS.md](EVENTS.md).

All integers are **big-endian** (`java.nio.ByteBuffer` default) and **signed** unless marked `u8` or `u16`, which
correspond to Java's `& 0xFF` and `& 0xFFFF`. `f32` and `f64` are IEEE-754. There are no per-record lengths, so every
payload must be decoded exactly.

## 1. Layers

```
.rrf (ZIP)                                        ReplayManager
 ├─ meta.json        JSON (Gson)                  ReplayMeta, ReplayMetaUnder30
 ├─ timelines.json   JSON array (optional)        server-side events
 └─ replay.rpd       chunk stream
      chunk → [AES-128/ECB/PKCS5 if version < 40] → [codec] → decoded chunk
                                                  ReplayCodec, ReplayManager.readChunks
      decoded chunk = UUID + [format marker] + records…
                                                  TimeLinePackage
```

### 1.1 meta.json

| Field | Notes |
|---|---|
| `version` | Selects framing, encryption and codec. |
| `matchId`, `date`, `matchType` | |
| `overworldSeed`, `netherSeed`, `theEndSeed` | Java `long`. The parser reads them losslessly and exposes them as decimal strings. |
| `symmetricKey` | Base64 (`Base64.getDecoder()`). Present when `version < 40`. |
| `players[]` | `{uuid, nickname, roleType, eloRate, eloRank, country}`. |
| `result` | `{uuid, time}`. |

When `version < 30`, Java reads the file as `ReplayMetaUnder30` and calls `convert()`, which maps `time→date`,
`seed→all three seeds`, `finalTimes[0]→result`, `badge→roleType` and `elo_rate→eloRate`. The converted object never
sets `version`, so **the effective version becomes 0**. Everything below uses this effective version. The parser
reports both values, as `meta.version` and `meta.fileVersion`.

### 1.2 replay.rpd framing (`ReplayManager.readChunks`)

| Effective version | Framing |
|---|---|
| `>= 32` | Repeated `[i32 length][length bytes]` until EOF. Java stops silently on an `EOFException`; the parser does the same and records a **warning** for a truncated tail. |
| `< 32` | Text, read with `BufferedReader.readLine()` (splits on `\n`, `\r`, `\r\n`). Each non-empty line is one chunk in standard Base64 (`Base64.getDecoder()`, padding optional). |

### 1.3 Encryption (`version < 40`)

- The AES key is `RSA/ECB/PKCS1Padding`-decrypt(`base64(symmetricKey)`) using the **public** key
  `AntiCheatConfig.REPLAY_PUBLIC_KEY_STRING`, an X.509 SubjectPublicKeyInfo for RSA-2048.
- Each chunk is then decrypted with `AES/ECB/PKCS5Padding`.
- The parser does this automatically using the key embedded as `replayPublicKey` in `data/mcsrranked.json`. Library
  callers can override it with `legacyPublicKey`.
- Decryption happens **before** decompression.

### 1.4 Codec (`ReplayCodec.detect(bytes, compressed)`)

`compressed` is `version >= 32`.

| Condition | Codec |
|---|---|
| `!compressed` | NONE: the bytes are used as-is. |
| Starts with `28 B5 2F FD` and the zstd frame content size is in `1..Integer.MAX_VALUE` | ZSTD. The writer uses level 6. |
| Otherwise | SNAPPY: raw block format, with no framing and no CRC. |

## 2. Decoded chunk (`TimeLinePackage.fromBytes`, `PersonalPlayerTracker` writer)

```
i64 uuidMost, i64 uuidLeast       player UUID
[u8 0x80|format]                  present iff first byte is negative (high bit set); format = byte & 0x7F
records… until the buffer is exhausted
```

If the byte after the UUID is non-negative, no marker is present and the format is **0**. Only formats 0 and 3 are
accepted; anything else throws `Unsupported replay record format N`.

### 2.1 Record

| Format | Layout | Type table |
|---|---|---|
| 3 | `i8 typeId`, `u8 tickDelta`, [`i32 absoluteTick` if `tickDelta == 255`], payload | `TimeLineType` (§4) |
| 0 | `i8 typeId`, `i32 tick`, payload | `LegacyTimeLineType` (§5) |

- **Ticks (format 3).** `decodedTick` starts at 0 for each chunk. A `tickDelta` of 0–254 adds to it, and 255 replaces
  it with the absolute tick. The writer escapes whenever the delta is negative or ≥ 255, so ticks **may go backwards**
  inside a chunk. The parser flags this in `--summary`.
- **Unknown ids** throw `Unknown replay timeline id N` or `Unknown legacy replay timeline id N`. The parser drops that
  chunk, records `{chunk, uuid, offset, typeId, message, recordsDiscarded}` in `errors` and continues with the next chunk.
- **Output type.** Records are reported under the type's `storedAs`: a delta wire type maps to its absolute type. The
  parser also keeps `wireType` and `wireTypeId`, and sets `legacy: true` for format-0 records.

### 2.2 Per-player state

Each UUID has its own `PersonalPlayerTracker` state: `decodedTick` and a `DeltaPositions`. **Both are reset at the
start of every chunk** (`TimeLinePackage.fromBytes` → `deltas.reset()`).

`DeltaPositions.reset()` (`DeltaPositions`) only clears the per-key position map and `hasBlock`. **The last
block world and coordinates survive the reset**, so a `BLOCK_*_DELTA` at the start of a chunk is relative to the last
block of the previous chunk for the same UUID. The parser reproduces this Java behaviour.

## 3. Shared encodings

### 3.1 Positions and blocks

- **Quantized position.** `q = Math.round(v * 4096.0)` (long), decoded as `(float)(q / 4096.0)`.
- **DeltaPositions keys.** The player uses key `-2147483647`, the dragon uses `Integer.MIN_VALUE` (always END), and
  entities use their entity id.

| Operation | Behaviour |
|---|---|
| `store(key, world, x, y, z)` | Set by absolute records. |
| `decode(key, world, dx, dy, dz)` | i16 quantized deltas. When the key is missing, it starts from 0 with the given world. |
| `decodeSmall(key, sx, sy, sz)` | i8 steps of 16 quantized units (1/256 block). A missing key starts from 0 in OVERWORLD. `getWorld(key)` defaults to OVERWORLD. |
| `storeBlock(world, pos)` | Called after `BLOCK_UPDATE` (V2), `BLOCK_BREAK`, `BLOCK_REMOVE` and `BLOCK_PROGRESS`. **Not** called after `CHEST_ANIMATION` or the legacy V1 update. |
| `decodeBlock(dx, dy, dz)` | i8 deltas added to the last block position. The world is the last block world. |

- **BlockPos (`i64`).** MC 1.16.1 packing: `x = l >> 38`, `y = (l << 52) >> 52`, `z = (l << 26) >> 38`.
  That is 26 bits for X, 12 bits for Y and 26 bits for Z.

### 3.2 Angles and enums

- **Rotation `i16`** (`RotationTimeLine`) is degrees × 100: `yaw = wrapDegrees((float)raw * 0.01f)`. The parser emits
  `yaw` and `pitch` along with `yawRaw` and `pitchRaw`.
- **Byte angle `i8`** (`DeltaPositions.byteToAngle`) is `b / (256/360)` degrees.
- **World `i8`** is the `WorldTypes` ordinal: `0 OVERWORLD`, `1 NETHER`, `2 END`. Out-of-range values throw.

| Enum | Values (by ordinal) |
|---|---|
| `Hand` | `MAIN_HAND`, `OFF_HAND` |
| `EquipmentSlot` | `MAINHAND`, `OFFHAND`, `FEET`, `LEGS`, `CHEST`, `HEAD` |
| `BlockUpdate…EventType` | `PLACE`, `UPDATE` |
| `PiglinStateTimeLine.State` | `ROAMING`, `SEEKING`, `ADMIRING`, `ANGRY`, `BARTERING`, `AGGRO_LIGHT`, `AGGRO_HEAVY` |
| `DragonDamageTimeLine.Source` | `PLAYER`, `ARROW`, `BED_ANCHOR`, `EXPLOSION`, `OTHER` |
| `EntityDamageTimeLine.AttackSound` | `SWEEP`, `CRITICAL`, `STRONG`, `WEAK` |
| `ProjectileEntityTimeLine.SoundPlayType` | `EMPTY`, `GHAST_FIREBALL`, `BLAZE_FIREBALL`, `ENTITY_TRIDENT`, `SHULKER_BULLET`, `DRAGON_FIREBALL`, `WITHER_SKULL`, `ENTITY_SHOT_CROSSBOW`, `SHOOT_SNOWBALL`, `FIREWORK_FIRE`, `PLAYER_PEARL_THROW`, `ENTITY_POTION_THROW`, `SHOOT_ARROW` |

`Hand` and `EquipmentSlot` are Minecraft enums. The others are read from the mod jar into `data/mcsrranked.json` (§7).

- **Pie-chart name** (`PieChartNames.read`): read `u8 b`. If `b < 128`, `id = b`; otherwise
  `id = ((b & 0x7F) << 8) | u8`. If `id == 0`, an inline string follows as `u8 len` plus `len` UTF-8 bytes. Otherwise the
  name is `NAMES[id-1]`, from the 282-entry `pieChartNames` table in `data/mcsrranked.json`.
- **Raw registry ids.** Items, blocks, entity types, effects and enchantments are emitted as raw 1.16.1 registry ids;
  the parser does not map them to names.

## 4. Payloads, format 3 (`TimeLineType`)

Notation: `W` = world `i8`, `pos3f` = `f32 x, f32 y, f32 z`, `rot` = `i16 yaw, i16 pitch` (§3.2), `BP` = `i64` BlockPos.
Payload sizes are in bytes, and `+n×k` means a variable repeat.

| Id | Type | storedAs | Payload (in read order) | Size | Factory |
|---|---|---|---|---|---|
| 0 | EMPTY | | `u8` (ignored) | 1 | `EmptyTimeLine.Empty` |
| 1 | PLAYER_SPAWN | | `W`, `pos3f`, `rot` | 17 | `PlayerSpawnTimeLine.PlayerSpawn` |
| 2 | PLAYER_POSITION | | `W`, `pos3f`, `rot`; then `store(player)` | 17 | `PlayerPositionTimeLine.PlayerPosition` |
| 3 | PLAYER_POSITION_LOOK | | `W`, `rot` | 5 | `PlayerPositionLookTimeLine.PlayerPositionLook` |
| 4 | PLAYER_POSITION_POS | | `W`, `pos3f`; then `store(player)` | 13 | `PlayerPositionPosTimeLine.PlayerPositionPos` |
| 5 | PLAYER_POSE | | `i8 pose` (EntityPose ordinal) | 1 | `PlayerPoseTimeLine.PlayerPose` |
| 6 | PLAYER_RIDE | | `i32 vehicleId` (`-1` = not riding) | 4 | `PlayerRideTimeLine.PlayerRide` |
| 7 | PLAYER_PAUSE | | `i8 paused` (≠0) | 1 | `PlayerPauseTimeLine.PlayerPause` |
| 8 | PLAYER_REMOVE | | `W`, `i8 death` (`==1`) | 2 | `PlayerRemoveTimeLine.PlayerRemove` |
| 9 | PLAYER_PERSPECTIVE | | `i8 perspective` | 1 | `PlayerPerspectiveTimeLine.PlayerPerspective` |
| 10 | PLAYER_STATS | | `u8 health`, `u8 absorption`, `u8 food`, `i8 air` | 4 | `PlayerStatsTimeLine.PlayerStats` |
| 11 | PLAYER_USE | | `i8 state`: bits 0–1 = hand (1 main, 2 off), bit 2 = finished | 1 | `PlayerUseTimeLine.PlayerUse` |
| 12 | PLAYER_EFFECT | | `u8 effectId`, `u8 amplifier`, `u16 duration` | 4 | `PlayerEffectTimeLine.PlayerEffect` |
| 13 | PLAYER_HELD_SLOT | | `i8 slot` | 1 | `PlayerHeldSlotTimeLine.PlayerHeldSlot` |
| 14 | PLAYER_POSITION_DELTA | PLAYER_POSITION | `i16 dx, dy, dz`, `rot`; world = `getWorld(player)` | 10 | `PlayerPositionDeltaTimeLine.PlayerPositionDelta` |
| 15 | PLAYER_POSITION_POS_DELTA | PLAYER_POSITION_POS | `i16 dx, dy, dz`; world = `getWorld(player)` | 6 | `PlayerPositionPosDeltaTimeLine.PlayerPositionPosDelta` |
| 16 | PLAYER_CONTAINER | | `u8 type` (255 → −1, 254 → −2), `u8 slotCount`, `u8 packed` (bits 0–1 = n, bits 2+ = world), `n × BP` | 3+8n | `PlayerContainerTimeLine.PlayerContainer` |
| 17 | PLAYER_PORTAL | | `i8 inPortal` (≠0) | 1 | `PlayerPortalTimeLine.PlayerPortal` |
| 18 | PLAYER_SWING | | `i8 hand` (`Hand`) | 1 | `PlayerSwingTimeLine.PlayerSwing` |
| 19 | PLAYER_RENDER_DISTANCE | | `i8 renderDistance` | 1 | `PlayerRenderDistanceTimeLine.PlayerRenderDistance` |
| 20 | PLAYER_ATTACK_RESET | | none | 0 | `PlayerAttackResetTimeLine.PlayerAttackReset` |
| 21 | PLAYER_PIE_CHART | | `u8 count`; per entry: entry 0 = `u8 n` + `n ×` name (joined with `\u001e`), others = name; then `u8 parent`, `u8 total` | var | `PlayerPieChartTimeLine.PlayerPieChart` (+ `PieChartNames.read`) |
| 25 | BLOCK_UPDATE | | `W`, `BP`, `i32 rawBlockState`, `i8 eventType` (`PLACE`, `UPDATE`); `storeBlock` | 14 | `BlockUpdateTimeLineV2.BlockUpdate` |
| 26 | BLOCK_BREAK | | `W`, `BP`; `storeBlock` | 9 | `BlockBreakTimeLine.BlockBreak` |
| 27 | BLOCK_REMOVE | | `W`, `BP`; `storeBlock` | 9 | `BlockRemoveTimeLine.BlockRemove` |
| 28 | BLOCK_PROGRESS | | `W`, `BP`, `i8 progress`; `storeBlock` | 10 | `BlockProgressTimeLine.BlockProgress` |
| 29 | CHEST_ANIMATION | | `W`, `BP`, `i8 open` (≠0) | 10 | `ChestAnimationTimeLine.ChestAnimation` |
| 30 | BLOCK_UPDATE_DELTA | BLOCK_UPDATE | `i8 dx, dy, dz` (`decodeBlock`), `u16 rawBlockState`, `i8 eventType` | 6 | `BlockDeltaTimeLine.UpdateFactory` |
| 31 | BLOCK_BREAK_DELTA | BLOCK_BREAK | `i8 dx, dy, dz` | 3 | `BlockDeltaTimeLine.BreakFactory` |
| 32 | BLOCK_REMOVE_DELTA | BLOCK_REMOVE | `i8 dx, dy, dz` | 3 | `BlockDeltaTimeLine.RemoveFactory` |
| 33 | BLOCK_PROGRESS_DELTA | BLOCK_PROGRESS | `i8 dx, dy, dz`, `i8 progress` | 4 | `BlockDeltaTimeLine.ProgressFactory` |
| 40 | ENTITY_ADD | | `W`, `pos3f`, `rot`, `i32 entityId`, `i32 entityTypeId`, `i32 customData` | 29 | `EntityAddTimeLine.EntityAdd` |
| 41 | ENTITY_MOVE | | `W`, `pos3f`, `rot`, `i32 entityId`; `store(entityId)` | 21 | `EntityMoveTimeLine.EntityMove` |
| 42 | ENTITY_MOVE_LOOK | | `W`, `rot`, `i32 entityId` | 9 | `EntityMoveLookTimeLine.EntityMoveLook` |
| 43 | ENTITY_MOVE_POS | | `W`, `pos3f`, `i32 entityId`; `store(entityId)` | 17 | `EntityMovePosTimeLine.EntityMovePos` |
| 44 | ENTITY_MOVE_DELTA | ENTITY_MOVE | `W`, `i16 dx, dy, dz`, `rot`, `i32 entityId` | 15 | `EntityMoveDeltaTimeLine.EntityMoveDelta` |
| 45 | ENTITY_MOVE_POS_DELTA | ENTITY_MOVE_POS | `W`, `i16 dx, dy, dz`, `i32 entityId` | 11 | `EntityMovePosDeltaTimeLine.EntityMovePosDelta` |
| 46 | ENTITY_DAMAGE | | `W`, `i32 entityId`, `i32 attackerId` (see below) | 9 | `EntityDamageTimeLine.EntityDamage` |
| 47 | ENTITY_REMOVE | | `W`, `i32 entityId`, `i8 death` (`==1`) | 6 | `EntityRemoveTimeLine.EntityRemove` |
| 48 | ENTITY_MOVE_SMALL_DELTA | ENTITY_MOVE | `i8 sx, sy, sz`, `i8 yaw`, `i8 pitch` (byte angles), `i32 entityId`; world = `getWorld(entityId)` | 9 | `EntityMoveSmallDeltaTimeLine.EntityMoveSmallDelta` |
| 49 | ENTITY_MOVE_POS_SMALL_DELTA | ENTITY_MOVE_POS | `i8 sx, sy, sz`, `i32 entityId`; world = `getWorld(entityId)` | 7 | `EntityMovePosSmallDeltaTimeLine.EntityMovePosSmallDelta` |
| 50 | PIGLIN_STATE | | `W`, `i32 entityId`, `i8 state` (`State`), `i8 flags`, `i16 offHand`, `i16 mainHand` (item raw ids) | 11 | `PiglinStateTimeLine.PiglinState` |
| 51 | MOB_STATE | | `W`, `i32 entityId`, `i32 state` | 9 | `MobStateTimeLine.MobState` |
| 61 | ITEM_ENTITY | | `W`, `pos3f`, `i32 entityId`, `u16 itemRawId`, `u8 packed` (bit 7 = glint, bits 0–6 = count, clamped to 1..127), `u8 variant` | 21 | `ItemEntityTimeLine.ItemEntity` |
| 62 | ITEM_PICKUP | | `W`, `i32 itemEntityId`, `i32 collectorId`, `i8 count` | 10 | `ItemPickupTimeLine.ItemPickup` |
| 63 | PROJECTILE_ENTITY | | `W`, `pos3f`, `rot`, `i32 entityId`, `f64 vx, vy, vz`, `i32 packedType` (see below), `u8 packedSound` (bit 7 = followsRecord, rest = `SoundPlayType`) | 50 | `ProjectileEntityTimeLine.ProjectileEntity` |
| 64 | INVENTORY_SLOT | | `u8 slot`, `u16 itemId`, `u8 count`, `u8 durability`, `u8 variant`, `u8 packed` (bits 0–5 = n, bits 6–7 = crossbow), `n × u16` enchant (`id << 8 \| level`) | 7+2n | `InventorySlotTimeLine.InventorySlot` |
| 80 | DRAGON_MOVE | | `pos3f`, `rot`; `store(dragon, END)` | 16 | `DragonPositionTimeLine.DragonPosition` |
| 81 | DRAGON_MOVE_DELTA | DRAGON_MOVE | `i16 dx, dy, dz`, `rot`; `decode(dragon, END)` | 10 | `DragonMoveDeltaTimeLine.DragonMoveDelta` |
| 82 | DRAGON_PHASE | | `i8 phase` | 1 | `DragonPhaseTimeLine.DragonPhase` |
| 83 | DRAGON_HEALTH_UPDATE | | `i8 h`, where health = `h + 128` | 1 | `DragonHealthTimeLine.DragonHealth` |
| 84 | DRAGON_CRYSTAL_UPDATE | | `i8 crystalIndex` | 1 | `CrystalDestroyTimeLine.CrystalDestroy` |
| 85 | DRAGON_DEATH | | `u8` (ignored) | 1 | `DragonDeathTimeLine.DragonDeath` |
| 86 | DRAGON_DEATH_PROGRESS | | `i16 progress`, `i8 phase` | 3 | `DragonDeathProgressTimeLine.DragonDeathProgress` |
| 87 | DRAGON_NODES | | `u8 n`, `n × BP` | 1+8n | `DragonNodesTimeLine.DragonNodes` |
| 88 | DRAGON_ZERO | | `i8 flewAway`; if `!= 1`: `f32 spawnYaw`, `i8 node`, `pos3f target`, `i8 clockwise` | 1 or 19 | `DragonZeroTimeLine.DragonZero` |
| 89 | DRAGON_DAMAGE | | `i8 source` (`Source`), `u16 amount×100` | 3 | `DragonDamageTimeLine.DragonDamage` |
| 90 | DRAGON_TARGET | | `i8 has`; if `≠ 0`: `pos3f` | 1 or 13 | `DragonTargetTimeLine.DragonTarget` |
| 91 | DRAGON_PATH | | `i8 phase`, `u8 n`, `n ×` (`u8 node`; if `node == 255`: `BP`) | var | `DragonPathTimeLine.DragonPath` |
| 100 | EXPLOSION_EFFECT | | `W`, `pos3f`, `f32 radius` | 17 | `ExplosionEffectTimeline.ExplosionEffect` |
| 101 | AREA_EFFECT_CLOUD | | `W`, `pos3f`, `i32 entityId`, `f32 radius`, `i16 duration`, `f32 radiusGrowth` | 27 | `AreaEffectCloudTimeLine.AreaEffectCloud` |
| 102 | WORLD_TIME | | `i64 timeOfDay` | 8 | `WorldTimeTimeLine.WorldTime` |
| 103 | PIGLIN_BARTER | | `W`, `i32 entityId`, `u8 n`, `n × (u16 itemRawId, u8 count)` | 6+3n | `PiglinBarterTimeLine.PiglinBarter` |

Ids 22–24, 34–39, 52–60, 65–79, 92–99 and anything above 103 are unassigned.

### Field details

**ENTITY_DAMAGE `attackerId`:**

| Value | Meaning |
|---|---|
| `-1` | No attacker. |
| `-2` | The player, plain hit. |
| `≤ -3` | The player, with `code = -3 - id`: `AttackSound[code >> 1]`, knockback = `code & 1`. |
| `≥ 0` | An entity id. |

**PROJECTILE_ENTITY `packedType`:**

| Bits | Meaning |
|---|---|
| 0–15 | Entity type raw id. |
| 16–23 | Potion id. |
| 24 | Lingering flag. |

## 5. Legacy payloads, format 0 (`LegacyTimeLineType`)

A legacy id maps to a canonical `TimeLineType` and uses that type's factory, unless a special factory is listed.

| Id | Legacy name | Canonical | Special factory: payload |
|---|---|---|---|
| 0 | EMPTY | EMPTY | |
| 1 | PLAYER_POSITION | PLAYER_POSITION | |
| 2 | PLAYER_POSITION_LOOK | PLAYER_POSITION_LOOK | |
| 3 | PLAYER_POSITION_POS | PLAYER_POSITION_POS | |
| 4 | PLAYER_SPAWN | PLAYER_SPAWN | |
| 5 | BLOCK_UPDATE_V1 | BLOCK_UPDATE | `BlockUpdateTimeLineV1.BlockUpdateTimeLineFactory`: `W`, `BP`, `i32 rawBlockState`, `i8 data`; eventType = `EventType[data % 2]`, stateValue = `data / 2`; no `storeBlock` |
| 6 | BLOCK_BREAK | BLOCK_BREAK | |
| 7 | BLOCK_REMOVE | BLOCK_REMOVE | |
| 8 | ENTITY_ADD | ENTITY_ADD | |
| 9 | ENTITY_REMOVE | ENTITY_REMOVE | |
| 10 | ENTITY_MOVE | ENTITY_MOVE | |
| 11 | ENTITY_MOVE_LOOK | ENTITY_MOVE_LOOK | |
| 12 | ENTITY_MOVE_POS | ENTITY_MOVE_POS | |
| 13 | ENTITY_DAMAGE | ENTITY_DAMAGE | |
| 14 | PROJECTILE_ENTITY | PROJECTILE_ENTITY | |
| 15 | ITEM_EQUIP | INVENTORY_SLOT | `InventorySlotTimeLine.LegacyItemEquipTimeLineFactory`: `i32 itemRawId`, `i8 EquipmentSlot`, `i8 enchanted`. Output: slot = MAINHAND 0, OFFHAND 40, FEET 36, LEGS 37, CHEST 38, HEAD 39; count = 0 if AIR, else 1; enchanted adds Protection I, packed as `0x0001` |
| 16 | PLAYER_POSE | PLAYER_POSE | |
| 17 | PLAYER_REMOVE | PLAYER_REMOVE | |
| 18 | BLOCK_PROGRESS | BLOCK_PROGRESS | |
| 19 | PLAYER_RIDE | PLAYER_RIDE | `PlayerRideTimeLine.LegacyPlayerRideTimeLineFactory`: `i8 riding`; vehicleId = `riding ? -2 : -1` |
| 20 | ITEM_ENTITY | ITEM_ENTITY | `ItemEntityTimeLine.LegacyItemEntityTimeLineFactory`: `W`, `pos3f`, `i16`, `i16` (ignored), `i32 entityId`, `f64 × 3` (ignored), `i32 itemRawId`; count = 1 |
| 21 | DRAGON_HEALTH_UPDATE | DRAGON_HEALTH_UPDATE | |
| 22 | DRAGON_CRYSTAL_UPDATE | DRAGON_CRYSTAL_UPDATE | |
| 23 | DRAGON_MOVE | DRAGON_MOVE | |
| 24 | DRAGON_DEATH | DRAGON_DEATH | |
| 25 | DEBUG_DRAGON_REFRESH | EMPTY | |
| 26 | DEBUG_PLAYER_FOLLOW | EMPTY | |
| 27 | DEBUG_ENTITIES_REFRESH | EMPTY | |
| 28 | BLOCK_UPDATE_V2 | BLOCK_UPDATE | |
| 29 | EXPLOSION_EFFECT | EXPLOSION_EFFECT | |
| 30 | PLAYER_PAUSE | PLAYER_PAUSE | |
| 31 | CHEST_ANIMATION | CHEST_ANIMATION | |

## 6. Parser output (`mcsrr-rrf file.rrf`)

```json
{ "meta": {...normalized meta, version, fileVersion, migratedFromUnder30},
  "timelines": [...],
  "players": { "<uuid>": { "nickname": "...", "inMeta": true, "chunks": 12,
      "records": [ { "tick": 0, "type": "PLAYER_POSITION", "wireType": "PLAYER_POSITION_DELTA",
                     "wireTypeId": 14, "world": "OVERWORLD", "data": {...}, "names": {...}, "chunk": 0 } ] } },
  "warnings": [...],
  "errors": [ { "uuid", "chunk", "stage": "decompress|decode", "offset", "typeId", "message", "recordsDiscarded" } ] }
```

- **64-bit values.** Values that don't fit in a double (seeds, `WORLD_TIME`) are emitted as decimal strings.
- **Options.** `--summary`, `--player <name|uuid>`, `--types a,b`, `-o out.json`, and `--no-names`. `--types` only
  filters the output; every record is still decoded, so delta and entity state stay correct.
- **Exit codes.** `0` OK, `3` decoded with chunk errors, `1` fatal, `2` usage.

### 6.1 `names`

`data` always holds the raw wire values. `names` adds readable 1.16.1 names alongside them. It is omitted when nothing
applies, and with `--no-names` / `{ names: false }`. Ids that are out of range become `null`.

| Record | `names` |
|---|---|
| any record with a known `entityId` | `entityType` (from that player's earlier `ENTITY_ADD` / `ITEM_ENTITY` / `PROJECTILE_ENTITY`) |
| ENTITY_ADD | `entityType` plus a decoded `customData`. **living:** `baby` and `mainHand` (`< 0` = baby, `\|value\|` = item, `INT_MIN` = baby holding air). **slime/magma_cube:** `size`. **tnt:** `fuse`. **falling_block:** `block`. **boat:** `boatType` |
| MOB_STATE | **villager:** `villagerType`, `profession`, `level` (bytes 0, 1, 2). **sheep:** `color` and `sheared` (bit 8). **enderman:** `angry`. `INT_MIN` = no state |
| BLOCK_UPDATE | `block` as `name[prop=value,…]` (block-state id) |
| INVENTORY_SLOT | `item`, `potion`, `enchantments` (`{enchantment, level}`, or `{effect, seconds}` for `suspicious_stew`) |
| ITEM_ENTITY / PROJECTILE_ENTITY / PIGLIN_BARTER / PIGLIN_STATE | `item` / `potion` / `loot` / `offHand`, `mainHand` |
| ITEM_PICKUP | `itemEntityType`, `collectorType` |
| PLAYER_POSE / PLAYER_PERSPECTIVE / PLAYER_EFFECT / PLAYER_CONTAINER | `pose` / `perspective` / `effect` / `container` (`-1` closed, `-2` inventory, else menu id) |
| DRAGON_PHASE / DRAGON_DEATH_PROGRESS / DRAGON_PATH | `phase` |

Registry ids are vanilla 1.16.1 raw ids. A modded registry entry, if there is any, would fall past the end and become `null`.

## 7. Keeping the data current

- **`data/mcsrranked.json`** holds all mod data: the `TimeLineType` ids, factories and `storedAs`, `LegacyTimeLineType`,
  the mod enums, `PieChartNames`, the replay public key and the mod version. It also lists the `ByteBuffer.get*()`
  calls each factory's `getFromBytes` makes (`factoryReads`).
- It is generated from the mod jar by the `datagen` tool in the repository (`npm run datagen:mod -- <jar>`), which reads
  the jar's class files directly. `datagen` is not part of the published package.
- **Tests.** `npm test` checks the JSON against the record type and enum names in `src/types.ts`, checks that every
  factory has a decoder in `src/decoders.ts`, and replays each decoder against `factoryReads`, so a changed byte layout
  fails the tests until the decoder is updated. None of this needs the jar.
- **`data/mc_1_16_1.json`** is generated by `npm run datagen:mc` from the vanilla 1.16.1 server's data report. This is
  only needed if the Minecraft version changes.
