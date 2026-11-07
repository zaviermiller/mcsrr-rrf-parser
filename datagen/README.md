# datagen

A maintainer tool that generates the JSON data files the parser loads. It is not published with `mcsrr-rrf-parser`,
and the parser never runs it. You run it by hand when a new mod version (or Minecraft data fix) comes out, and then
commit the JSON it writes.

It needs Node.js 22.18 or newer and has no dependencies beyond the parser's dev dependencies. Run the commands below
from the package root, or use `node src/mod.ts` / `node src/mc.ts` from this folder.

## Mod data: `data/mcsrranked.json`

```sh
npm run datagen:mod -- path/to/mcsrranked-X.Y.Z.jar [--out <file>] [--check]
```

This reads the mod jar's class files directly (the mod's classes are not obfuscated) and writes:

| Field | Read from |
| --- | --- |
| `modVersion` | `fabric.mod.json` |
| `replayPublicKey` | `AntiCheatConfig.REPLAY_PUBLIC_KEY_STRING` |
| `worlds` | the `WorldTypes` enum |
| `timelineTypes` | the `TimeLineType` enum: id, factory, and `storedAs` for delta types |
| `legacyTypes` | the `LegacyTimeLineType` enum: id, canonical type, and a special factory if any |
| `enums` | the mod enums the decoders index by ordinal (`BlockEventType`, `DragonDamageSource`, ...) |
| `pieChartNames` | `PieChartNames.NAMES` |
| `factoryReads` | the `ByteBuffer.get*()` calls in each factory's `getFromBytes`, in order |

A factory is named `<outer class>.<factory class without "TimeLineFactory">`, for example
`PlayerSpawnTimeLine.PlayerSpawn`. These names are the keys of `DECODERS` in the parser's `src/decoders.ts`.

It prints what changed compared with the existing file and then writes it. With `--check` it only compares. The exit
code is `0` when the file was written or is already up to date, `1` when `--check` finds differences, and `2` on a usage
or read error.

After regenerating, run `npm test` in the package root. `test/mod_data.test.ts` checks the new JSON against
`src/types.ts` and `src/decoders.ts` and lists what needs updating.

## Minecraft data: `data/mc_1_16_1.json`

```sh
npm run datagen:mc -- [--java-home <jdk>] [--server-jar <jar>] [--yarn-jar <jar>]
```

This regenerates the vanilla 1.16.1 registries, block states, enum orders and entity kinds. It needs a JDK, the
official 1.16.1 server jar and a yarn-mapped 1.16.1 jar. By default it looks for both jars in Fabric Loom's Gradle
cache (`~/.gradle/caches/fabric-loom`); otherwise pass them explicitly. This data does not change between mod
versions, so you should rarely need it.

## Tests

```sh
npm run datagen:test
```

The jar tests run when `RRF_MOD_JAR` is set or a `mcsrranked-*.jar` is in this folder. They check that extracting
the jar reproduces the committed `data/mcsrranked.json` exactly.
