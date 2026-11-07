# Replay events reference

This document describes what each record type in an MCSR Ranked replay means: when the mod emits it, what each
`record.data` field holds (including units and special values), and how it relates to other records. It applies to
MCSR Ranked on **Minecraft 1.16.1** (mod version 6.0.4). You don't need the mod source or the mod jar to use it.

For the byte layout, see [FORMAT.md](FORMAT.md). For the TypeScript shapes, see `src/types.ts`; every `data` field
listed here appears there under the same name.

## 1. General rules

### Streams and ticks

- A replay contains one **record stream per player** (`replay.players`). Each stream is recorded on that player's own
  game (client plus integrated server). Everything in a stream is from that player's point of view: the entities,
  blocks and dragon it contains are the ones that player could see.
- `tick` counts 20 per second from when that player's recording started. It is **not** the Minecraft world time. Ticks
  are normally non-decreasing. If a recording was paused and resumed (for example after a reconnect), the tick
  jumps forward by the wall-clock time that passed, and a few records can occasionally go backwards
  (`PlayerStats.tickRegressions` counts these).
- To line up streams with real time or with `timelines.json`, use `ms = tick * 50`.
- Most records are **emitted on change**, not every tick. A value holds until the next record of the same type
  (and, for per-entity or per-slot records, the same `entityId` or `slot`).

### Worlds and coordinates

- `record.world` is the dimension (`OVERWORLD`, `NETHER` or `END`). It is `null` on records that are not tied to a
  world (stats, inventory, effects, dragon records and so on). Use the most recent position record to tell where the
  player was.
- Positions are absolute world coordinates in blocks. Player and entity positions are the feet position. Block
  positions are integer block coordinates.
- Rotations are in degrees: `yaw` follows Minecraft's convention (0 = south, 90 = west, −90 / 270 = east, 180 =
  north) and `pitch` runs from −90 (looking up) to 90 (looking down). `yawRaw` and `pitchRaw` are the stored values.
- `*_DELTA` and `*_SMALL_DELTA` wire types are a storage optimisation only. The parser decodes them to absolute
  positions and reports them as the canonical type (for example `ENTITY_MOVE`). `record.wireType` shows what was
  stored, and `data.delta` / `data.smallDelta` keep the raw offsets.

### Entities

- Other entities (mobs, items, projectiles, vehicles) are recorded only while they are **in range** of the recording
  player and in the same dimension. The range is chosen by the server for each match. Two exceptions extend it:
  blazes in the Nether are tracked up to at least 50 blocks, and piglins inside a bastion are tracked while the
  player is near that bastion.
- `entityId` is the Minecraft entity id. It identifies an entity only for as long as that entity exists: ids can be
  reused, and they are only meaningful within one player's stream.
- An entity's life in a stream is: `ENTITY_ADD` (or `ITEM_ENTITY` / `PROJECTILE_ENTITY`), then any number of
  `ENTITY_MOVE*`, `ENTITY_DAMAGE`, `MOB_STATE` and `PIGLIN_STATE` records, then `ENTITY_REMOVE`. To find an entity's
  type, look at the add record with the same `entityId` that comes before it. With `names` enabled (the default) the
  parser does this for you and fills in `names.entityType`.
- An entity that leaves range and comes back gets a new `ENTITY_ADD`.

### Registry ids and `names`

Items, blocks, entity types, effects, enchantments, potions and menus are stored as **raw Minecraft 1.16.1 registry
ids**. With the default `names: true`, the parser adds a `record.names` object with readable names for the ids in that
record (for example `names.item = "diamond_sword"`). You can also call `registryName(registry, id)` and
`blockStateName(id)`. The sections below say which `names` fields each record gets.

## 2. Player records

These describe the recording player.

### PLAYER_SPAWN

The player was added to a world: at the start of the match, on respawn, and on every dimension change.

| Field | Meaning |
|---|---|
| `x`, `y`, `z`, `yaw`, `pitch` | Spawn position and rotation. |

### PLAYER_POSITION, PLAYER_POSITION_POS, PLAYER_POSITION_LOOK

The player moved or turned. `PLAYER_POSITION` means both changed, `PLAYER_POSITION_POS` means only the position
changed, and `PLAYER_POSITION_LOOK` means only the rotation changed. To track the player, keep the last position and
the last rotation, and update each one from whichever record carries it.

### PLAYER_POSE

`pose` is the player's pose. `names.pose` gives the name: `STANDING`, `FALL_FLYING`, `SLEEPING`, `SWIMMING`,
`SPIN_ATTACK`, `CROUCHING` or `DYING`. Emitted on change.

### PLAYER_RIDE

The player started or stopped riding something (a boat, horse or strider, for example).

| Field | Meaning |
|---|---|
| `vehicleId` | The vehicle's entity id. `-1` = not riding. `-2` = riding an unknown vehicle (old files only). |
| `riding` | `vehicleId !== -1`. |

### PLAYER_PAUSE

`paused` is true while the player's game is paused (for example, the pause menu is open).

### PLAYER_REMOVE

The player was removed from a world. `death` is true if the player died. When `death` is false, the player left the
world, for example through a portal (a `PLAYER_SPAWN` in the new dimension follows) or because the recording
ended.

### PLAYER_PERSPECTIVE

The camera mode, emitted once at the start and then on change. `perspective`: 0 = first person, 1 = third person
(behind), 2 = third person (front). Also available as `names.perspective`.

### PLAYER_STATS

Emitted when any of these values changes.

| Field | Meaning |
|---|---|
| `health` | Health in half-hearts (20 = full), rounded up. 0 means dead. |
| `absorption` | Absorption (golden hearts) in half-hearts, rounded up. |
| `food` | Hunger bar, 0–20. |
| `air` | `-1` = full air and not underwater. Otherwise the number of air bubbles shown, from 10 down to 0. |

### PLAYER_USE

The player started, stopped or finished using an item: eating, drinking, drawing a bow, charging a crossbow,
blocking with a shield and so on. Use `PLAYER_HELD_SLOT` and `INVENTORY_SLOT` to find out which item it was.

| Field | Meaning |
|---|---|
| `usingHand` | `NONE` (stopped), `MAIN_HAND` or `OFF_HAND`. `UNKNOWN` is reported for unexpected raw values. |
| `finished` | True on the tick the use completed: the food was eaten, the potion drunk, and so on. If the hand stops without `finished`, the use was cancelled (or, for bows, released). |
| `state` | The raw stored byte. |

A new record with the same hand means the player started using an item again.

### PLAYER_EFFECT

A status effect was added, upgraded or removed.

| Field | Meaning |
|---|---|
| `effectId` | Effect registry id. `names.effect` gives the name (for example `fire_resistance`). |
| `amplifier` | Level minus one (0 = level I). |
| `duration` | Remaining duration in ticks when it was applied, capped at 65535. **0 means the effect was removed.** |

Durations are not re-sent as they count down. The effect runs out at `tick + duration` unless another record
replaces it first.

### PLAYER_HELD_SLOT

`slot` is the selected hotbar slot, 0–8. Emitted on change. The item in it is the most recent `INVENTORY_SLOT` for
that slot number.

### PLAYER_CONTAINER

The player opened or closed a screen that holds items.

| Field | Meaning |
|---|---|
| `containerType` | `-1` = closed. `-2` = the player's own inventory screen. Otherwise a `menu` registry id: `names.container` gives the name (for example `generic_9x3` for a chest or `furnace`). |
| `slotCount` | How many container slots the screen has (not counting the player's inventory). These slots appear as `INVENTORY_SLOT` 46 to `46 + slotCount − 1`. |
| `positions` | The block(s) backing the container: none for entity containers, one for a chest, two for a double chest. |

### PLAYER_PORTAL

`inPortal` is true while the player is standing in a nether portal. Emitted on change.

### PLAYER_SWING

The player swung an arm (attacking, mining, placing or using). `hand` is `MAIN_HAND` or `OFF_HAND`.

### PLAYER_RENDER_DISTANCE

`renderDistance` is the player's render distance setting, in chunks. Emitted on change.

### PLAYER_ATTACK_RESET

The player's attack cooldown (the attack-strength meter under the crosshair) was reset. In 1.16 this happens on every
attack or swing at the air, and when the held item changes. There is at most one per tick, and the record has no data.

### PLAYER_PIE_CHART

A snapshot of the F3 debug profiler pie chart (`Shift+F3`), emitted when it changes while open.

| Field | Meaning |
|---|---|
| `timings[0].name` | The profiler path being viewed, with segments joined by `\u001e`. |
| `timings[i].name` | The entry name, for example `entities` or `blockEntities`. |
| `parent`, `total` | Percent (0–100) of the parent section and of the whole frame. |

## 3. Inventory

### INVENTORY_SLOT

One slot's contents. Every player slot is emitted once when recording starts, and then whenever a slot changes.
Keep a map of `slot → last record` to rebuild the inventory at any tick.

| `slot` | Meaning |
|---|---|
| 0–8 | Hotbar. |
| 9–35 | Main inventory. |
| 36–39 | Armour: 36 feet, 37 legs, 38 chest, 39 head. |
| 40 | Off hand. |
| 41–44 | 2×2 crafting grid. |
| 45 | Crafting result. |
| 46–99 | The open container's slots (`46 + container slot index`), see `PLAYER_CONTAINER`. |

Container slots (46+) are only emitted while a container is open. When a container opens, its non-empty slots are
emitted. When it closes (`PLAYER_CONTAINER` with `-1`), treat all of slots 46–99 as cleared.

| Field | Meaning |
|---|---|
| `itemId` | Item registry id. `0` = empty slot. `names.item` gives the name. |
| `count` | Stack size. 0 when empty. |
| `durability` | Remaining durability as a fraction of 255: `remaining ≈ durability / 255 × maxDurability`. **255 = full durability, not damageable, or empty.** |
| `variant` | Potion registry id for potions, splash/lingering potions and tipped arrows (`names.potion`). 0 otherwise. |
| `crossbow` | 0 = not charged, 1 = charged with an arrow, 2 = charged with a firework rocket. |
| `enchantments` | Up to 63 `{ id, level }` entries (`names.enchantments`). **For `suspicious_stew` they are stew effects instead:** `id` = effect id and `level` = duration in seconds. |
| `legacyEquipmentSlot` | Only on records converted from old files (see below). |

Records converted from the old `ITEM_EQUIP` type (replays older than version 30) only cover armour and hand slots, have
`count` 1, `durability` 255, and at most a placeholder enchantment (Protection I) meaning "was enchanted".

## 4. Blocks and world

### BLOCK_UPDATE

A block changed state.

| Field | Meaning |
|---|---|
| `x`, `y`, `z` | Block position. |
| `rawBlockState` | Block-state id of the new state. `names.block` gives the full state, for example `oak_stairs[facing=north,…]`. |
| `eventType` | `PLACE` = the recording player placed it. `UPDATE` = any other change the mod records. |

`UPDATE` is not every block change in the world. The mod records changes that matter for a replay: fire, portals,
beds and respawn anchors, falling blocks, obsidian, and general changes close to the player. Changes to air are
reported as `BLOCK_REMOVE` instead.

### BLOCK_BREAK

The recording player mined the block at `x, y, z`.

### BLOCK_REMOVE

The block at `x, y, z` became air for any reason other than the player mining it: an explosion, burning, a piston, a
bed or anchor being destroyed and so on.

### BLOCK_PROGRESS

The recording player's mining progress on the block at `x, y, z`. Emitted when the stage or the block changes.

| `progress` | Meaning |
|---|---|
| `10` | Started mining, no crack visible yet. |
| `0`–`9` | Crack stage (9 = about to break). |
| `-1` | Stopped mining without breaking it (or a screen was opened). |

A successful break is followed by `BLOCK_BREAK` at the same position.

### CHEST_ANIMATION

A chest (or similar) lid at `x, y, z` opened (`open: true`) or closed.

### EXPLOSION_EFFECT

An explosion happened at `x, y, z`. `radius` is the explosion power (4 for TNT, 5 for beds and respawn anchors, 6 for
charged creepers). The blocks it destroyed come as `BLOCK_REMOVE` records.

### AREA_EFFECT_CLOUD

A lingering-potion (or dragon-breath) cloud appeared.

| Field | Meaning |
|---|---|
| `entityId` | The cloud's entity id. |
| `x`, `y`, `z` | Position. |
| `radius` | Starting radius in blocks. |
| `duration` | Lifetime in ticks. |
| `radiusGrowth` | Radius change per tick, in blocks (usually negative). |

### WORLD_TIME

The overworld time was set to a new value instead of advancing normally, for example when the player slept through
the night. `timeOfDay` is the world's day time in ticks, and `timeOfDay % 24000` is the time of day (0 = sunrise, 6000 =
noon, 13000 = night). It is a decimal string if it is too large to fit in a JavaScript number.

### PIGLIN_BARTER

The piglin `entityId` finished bartering and dropped `loot`, a list of `{ itemRawId, count }`. `names.loot` gives the
item names. Any potion in the loot is a fire resistance potion.

## 5. Entities

### ENTITY_ADD

An entity came into range (or spawned in range).

| Field | Meaning |
|---|---|
| `entityId` | Entity id. |
| `entityTypeId` | Entity type registry id. `names.entityType` gives the name. |
| `x`, `y`, `z`, `yaw`, `pitch` | Position and rotation. |
| `customData` | Type-specific value, decoded into `names`. See the table below. |

| Entity | `customData` | `names` fields |
|---|---|---|
| Slime, magma cube | Size (1, 2 or 4). | `size` |
| TNT | Fuse in ticks. | `fuse` |
| Falling block | Block-state id. | `block` |
| Boat | Wood type (0 oak, 1 spruce, 2 birch, 3 jungle, 4 acacia, 5 dark oak). | `boatType` |
| Other mobs | Item id in the main hand, negated for babies. `-2147483648` = baby holding nothing. | `mainHand`, `baby` |
| Anything else | 0. | |

### ENTITY_MOVE, ENTITY_MOVE_POS, ENTITY_MOVE_LOOK

The entity `entityId` moved or turned. These work like the player position records: `_POS` means position only,
`_LOOK` means rotation only. They are emitted on change. Entities that are far away or slow-moving may update less often
than every tick, so interpolate between records.

### ENTITY_DAMAGE

The entity `entityId` took damage. The amount is not recorded.

| Field | Meaning |
|---|---|
| `entityId` | The victim. **`-2` = the recording player.** |
| `attacker` | `NONE`, `PLAYER` (the recording player) or `ENTITY`. |
| `attackerId` | The raw stored value. When `attacker` is `ENTITY`, this is the attacker's entity id. |
| `attackSound` | Only when the player made a melee hit: `SWEEP`, `CRITICAL`, `STRONG` (fully charged) or `WEAK`. |
| `knockback` | Only when the player made a melee hit: whether it was a knockback (sprint) hit. |

### ENTITY_REMOVE

The entity `entityId` is gone. `death: true` means it died. `false` means it was removed for some other reason: it went out
of range, despawned, was picked up (items), hit something (projectiles) and so on.

### MOB_STATE

Extra state for some mobs, emitted when the entity is added and whenever the state changes. `state` is packed, and the
parser decodes it into `names`:

| Entity | `state` | `names` fields |
|---|---|---|
| Villager, zombie villager | byte 0 = biome type, byte 1 = profession, byte 2 = level. | `villagerType`, `profession`, `level` |
| Sheep | Wool colour (0–15). `+0x100` if sheared. | `color`, `sheared` |
| Enderman | Bit 0 = angry. | `angry` |
| (none) | `-2147483648` = nothing to report. | |

### PIGLIN_STATE

A piglin's behaviour, emitted when it is added and on any change.

| Field | Meaning |
|---|---|
| `state` | `ROAMING`, `SEEKING` (going for an item it wants), `ADMIRING` (holding an item in its off hand), `BARTERING` (holding gold in its off hand), `ANGRY`, `AGGRO_LIGHT` (targeting a player who isn't wearing gold) or `AGGRO_HEAVY` (angry, and won't be distracted by gold). |
| `flags` | Bit 0 = attacking, bit 1 = charging a crossbow. |
| `offHand`, `mainHand` | Item ids in each hand (`names.offHand`, `names.mainHand`). |

### ITEM_ENTITY

A dropped item within 32 blocks. It is emitted when the item first appears, and again whenever its count, glint or variant changes.
Movement comes as `ENTITY_MOVE*` records and removal as `ENTITY_REMOVE`.

| Field | Meaning |
|---|---|
| `entityId`, `x`, `y`, `z` | Entity id and position. |
| `itemRawId` | Item id (`names.item`). |
| `count` | Stack size, 1–127. |
| `glint` | True if the item is enchanted. |
| `variant` | Potion id for potions and tipped arrows (`names.potion`). 0 otherwise. |

### ITEM_PICKUP

An item entity was picked up.

| Field | Meaning |
|---|---|
| `itemEntityId` | The item entity (see `ITEM_ENTITY`). `names.itemEntityType` gives its type. |
| `collectorId` | Who picked it up. **`-2` = the recording player.** Otherwise a mob's entity id (`names.collectorType`). |
| `count` | How many items were picked up. |

### PROJECTILE_ENTITY

A projectile was launched: an arrow, ender pearl, thrown potion, snowball, fireball, trident and so on.

| Field | Meaning |
|---|---|
| `entityId`, `entityTypeId` | Entity id and type (`names.entityType`). |
| `x`, `y`, `z`, `yaw`, `pitch` | Launch position and rotation. |
| `velocity` | Launch velocity in blocks per tick. |
| `potion`, `lingering` | For thrown potions: the potion id (`names.potion`) and whether it is lingering. Otherwise 0 / false. |
| `followsRecord` | True if later `ENTITY_MOVE*` records for this id describe its flight. False if the flight is meant to be simulated from the launch velocity. |
| `soundPlayType` | The launch sound (`SHOOT_ARROW`, `PLAYER_PEARL_THROW`, `GHAST_FIREBALL` and so on). `EMPTY` = none. |

## 6. Ender dragon

Dragon records only appear in the End, in the stream of the player recording the fight.

| Record | Meaning |
|---|---|
| `DRAGON_MOVE` | Dragon position and rotation, every tick. |
| `DRAGON_PHASE` | The AI phase changed. `phase`: 0 holding pattern, 1 strafe player, 2 landing approach, 3 landing, 4 takeoff, 5 sitting/flaming, 6 sitting/scanning, 7 sitting/attacking, 8 charging player, 9 dying, 10 hover. `names.phase` gives the name. |
| `DRAGON_HEALTH_UPDATE` | `health` in health points (200 = full), rounded up. |
| `DRAGON_DAMAGE` | The dragon lost health. `amount` = health points lost (2 decimals). `source`: `PLAYER` (melee), `ARROW`, `BED_ANCHOR` (bed or respawn anchor explosion), `EXPLOSION` (other explosions) or `OTHER`. Hits that did no damage are not recorded. |
| `DRAGON_CRYSTAL_UPDATE` | An end crystal was destroyed. `crystalIndex` (0–9) is the obsidian pillar, numbered by angle around the centre: pillar `i` is at about `x = 42·cos(2·(−π + i·π/10))`, `z = 42·sin(2·(−π + i·π/10))`. |
| `DRAGON_NODES` | Emitted once: the dragon's pathfinding graph, an array of block positions. Indexes into it are used by `DRAGON_PATH` and `DRAGON_ZERO`. |
| `DRAGON_PATH` | The dragon picked a new flight path. `phase` = the current phase id. `nodes` = node indexes into `DRAGON_NODES`, in order. A node of 255 is a one-off point given in `pos`. |
| `DRAGON_TARGET` | The point the dragon's AI is flying towards (`target`), or `null` if it has none. |
| `DRAGON_ZERO` | A "zero cycle" chance (the dragon heading to perch from one of the nodes next to the fountain). The first record has `flewAway: false`, and gives `node` (15, 19, 20 or 22), `target`, `clockwise` (holding-pattern direction) and `spawnYaw` (the dragon's yaw when first seen, in degrees). A later record with `flewAway: true` means the chance was lost; its other fields are absent. |
| `DRAGON_DEATH` | The dragon died. |
| `DRAGON_DEATH_PROGRESS` | Death animation progress. `progress` = ticks since death (the animation lasts 200), `phase` = phase id. |

## 7. meta.json and timelines.json

`replay.meta` (from `meta.json`):

| Field | Meaning |
|---|---|
| `matchId` | MCSR Ranked match id. |
| `date` | Match start, epoch milliseconds. |
| `matchType` | 1 casual, 2 ranked, 3 private, 4 event, 5 rush. |
| `overworldSeed`, `netherSeed`, `theEndSeed` | Seeds as decimal strings. |
| `result.uuid`, `result.time` | The winner's UUID (`null` if there was no winner) and their time in **milliseconds**. |
| `players[]` | `uuid`, `nickname`, `eloRate`, `eloRank`, `country` and `roleType` (see §8). |

`replay.timelines` (from `timelines.json`) is a list of match events recorded by the server, separate from the record
streams:

| Field | Meaning |
|---|---|
| `uuid` | The player it applies to. |
| `type` | A vanilla advancement id (for example `story.enter_the_nether` or `nether.find_bastion`), or a match event `projectelo.timeline.*`: `reset`, `death`, `death_spawnpoint`, `blind_travel`, `disconnect`, `forfeit`, `eliminate` or `complete`. |
| `time` | Milliseconds since the match started. The matching record tick is about `Math.ceil(time / 50)`. |
| `data` | Usually the player's block position `[x, y, z]` when the event happened. Empty for events such as `forfeit`. |

## 8. Known gaps

These have not been confirmed and may change:

- `players[].roleType` in `meta.json`: its values are not documented.
- The exact range used for entity tracking varies by match and isn't stored in the replay.
- The full list of `projectelo.timeline.*` event types, and what `blind_travel` and `death_spawnpoint` mark exactly.
