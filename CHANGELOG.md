# Changelog

## 1.1.0

- Updated mod data for MCSR Ranked 6.0.11.
- `DRAGON_ZERO` reads the flew-away-with-height variant added in mod 6.0.9 and exposes it as `flyAwayHeight`. Mod 6.0.9 did
  not bump the format version, so v40 replays from 6.0.0–6.0.4 and 6.0.9+ are both read.
- `meta.raceId` holds the weekly race id of race replays (mod 6.0.9+).

## 1.0.0

First release.

- Parses MCSR Ranked `.rrf` replays from format version 20 through 40 (mod 6.0.4, Minecraft 1.16.1), including
  legacy encrypted replays.
- `parseReplay`, `readReplay` and the streaming `openReplay` API, with typed records and readable 1.16.1 names.
- `mcsrr-rrf` CLI for JSON output and per-player summaries.
- `maxEntrySize` and `maxChunkSize` cap decompressed sizes so untrusted files can't exhaust memory.
