// JSON output. int64 values are BigInts internally; they are written as numbers when exact, otherwise as strings.
import * as fs from 'node:fs';
import { longOut } from './binary.ts';
import type { PlayerReplay, Replay } from './replay.ts';

/** Anything JSON text can be streamed to. */
export interface TextSink {
  write(s: string): void;
  flush?(): void;
}

/** JSON.stringify that emits int64 BigInts as numbers when exact, otherwise as decimal strings. */
export function toJson(value: unknown, space?: string | number): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? longOut(v) : v), space);
}

/** Buffered synchronous writer; avoids building one giant string (V8 caps strings at ~512 MB). */
export class JsonSink implements TextSink {
  readonly fd: number;
  private parts: string[] = [];
  private size = 0;

  constructor(fd: number) {
    this.fd = fd;
  }

  write(s: string): void {
    this.parts.push(s);
    this.size += s.length;
    if (this.size >= 1 << 20) this.flush();
  }

  flush(): void {
    if (this.parts.length === 0) return;
    const buf = Buffer.from(this.parts.join(''), 'utf8');
    let off = 0;
    while (off < buf.length) {
      try {
        off += fs.writeSync(this.fd, buf, off);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
      }
    }
    this.parts = [];
    this.size = 0;
  }
}

/** All players, or the one matching playerKey (UUID or nickname); throws if not found. */
export function selectPlayers(rep: Replay, playerKey?: string | null): PlayerReplay[] {
  if (playerKey === undefined || playerKey === null) return [...rep.players.values()];
  const p = rep.findPlayer(playerKey);
  if (!p) throw new Error(`player not found: ${playerKey}`);
  return [p];
}

/** Streams the replay as JSON to anything with write(string) (and optionally flush()). */
export function writeJson(rep: Replay, sink: TextSink, playerKey?: string | null): void {
  sink.write(`{\n"meta": ${toJson(rep.meta)},\n"timelines": ${toJson(rep.timelines)},\n"players": {`);
  selectPlayers(rep, playerKey).forEach((p, i) => {
    sink.write(`${i ? ',' : ''}\n${JSON.stringify(p.uuid)}: {"nickname": ${JSON.stringify(p.nickname)}, "inMeta": ${p.inMeta}, "chunks": ${p.chunks}, "records": [`);
    p.records.forEach((r, j) => sink.write(`${j ? ',' : ''}\n${toJson(r)}`));
    sink.write('\n]}');
  });
  sink.write(`\n},\n"warnings": ${toJson(rep.warnings)},\n"errors": ${toJson(rep.errors)}\n}\n`);
  if (sink.flush) sink.flush();
}

/** The same JSON document as writeJson, as a string. */
export function stringifyReplay(rep: Replay, playerKey?: string | null): string {
  const parts: string[] = [];
  writeJson(rep, { write: (s) => parts.push(s) }, playerKey);
  return parts.join('');
}

/** Writes the JSON document to a file path or an open file descriptor. */
export function writeJsonFile(rep: Replay, target: string | URL | number, playerKey?: string | null): void {
  const fd = typeof target === 'number' ? target : fs.openSync(target, 'w');
  try {
    writeJson(rep, new JsonSink(fd), playerKey);
  } finally {
    if (typeof target !== 'number') fs.closeSync(fd);
  }
}
