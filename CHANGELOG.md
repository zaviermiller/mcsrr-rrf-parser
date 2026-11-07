# Changelog

## 1.0.0

First release.

- Parses MCSR Ranked `.rrf` replays from format version 20 through 40 (mod 6.0.4, Minecraft 1.16.1), including
  legacy encrypted replays.
- `parseReplay`, `readReplay` and the streaming `openReplay` API, with typed records and readable 1.16.1 names.
- `mcsrr-rrf` CLI for JSON output and per-player summaries.
- `maxEntrySize` and `maxChunkSize` cap decompressed sizes so untrusted files can't exhaust memory.
