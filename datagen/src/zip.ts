// Minimal ZIP reader (stored and deflated entries), enough to read class files out of a jar.
import * as zlib from 'node:zlib';

/** Entry name -> lazy reader, via the central directory. */
export function readZip(buf: Buffer): Map<string, () => Buffer> {
  const min = Math.max(0, buf.length - 22 - 0xFFFF);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (end of central directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, () => Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad ZIP central directory entry at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, () => {
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(start, start + compSize);
      const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
      if (!data) throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
      if (data.length !== size) throw new Error(`ZIP size mismatch for ${name}`);
      return data;
    });
  }
  return entries;
}
