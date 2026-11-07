// Minimal JVM class-file reader: constant pool, fields (with ConstantValue), methods (with Code),
// an instruction walker, and a tiny literal-tracking stack simulator that is enough to recover
// enum constructor arguments, static array initialisers and static field assignments.

export class ClassFormatError extends Error {}

export const ACC_ENUM = 0x4000;
export const ACC_BRIDGE = 0x0040;

export interface CpEntry {
  tag: number;
  value?: string | number | bigint;
  a?: number;
  b?: number;
}

export interface MemberRef { owner: string; name: string; desc: string }
export interface ClassRef { classRef: string }

/** A loadable constant or member reference, resolved to a plain value. */
export type Constant = number | bigint | string | ClassRef | MemberRef | { tag: number };

export interface Member {
  flags: number;
  name: string;
  desc: string;
  attrs: Record<string, Buffer>;
  /** Fields only: the ConstantValue attribute, resolved. */
  constantValue?: Constant;
  /** Methods only: the bytecode of the Code attribute. */
  code?: Buffer;
}

export interface ClassFile {
  access: number;
  name: string;
  superClass: string | null;
  interfaces: string[];
  cp: (CpEntry | null)[];
  fields: Member[];
  methods: Member[];
}

function decodeModifiedUtf8(buf: Buffer): string {
  let s = '';
  for (let i = 0; i < buf.length;) {
    const a = buf[i++]!;
    if (a < 0x80) s += String.fromCharCode(a);
    else if ((a & 0xE0) === 0xC0) s += String.fromCharCode(((a & 0x1F) << 6) | (buf[i++]! & 0x3F));
    else {
      const b = buf[i++]!; const c = buf[i++]!;
      s += String.fromCharCode(((a & 0x0F) << 12) | ((b & 0x3F) << 6) | (c & 0x3F));
    }
  }
  return s;
}

export function parseClass(buf: Buffer): ClassFile {
  let p = 0;
  const u1 = () => buf[p++]!;
  const u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  if (u4() !== 0xCAFEBABE) throw new ClassFormatError('bad class magic');
  p += 4; // minor, major
  const count = u2();
  const cp = new Array<CpEntry | null>(count).fill(null);
  for (let i = 1; i < count; i++) {
    const tag = u1();
    switch (tag) {
      case 1: { const len = u2(); cp[i] = { tag, value: decodeModifiedUtf8(buf.subarray(p, p + len)) }; p += len; break; }
      case 3: cp[i] = { tag, value: buf.readInt32BE(p) }; p += 4; break;
      case 4: cp[i] = { tag, value: buf.readFloatBE(p) }; p += 4; break;
      case 5: cp[i] = { tag, value: buf.readBigInt64BE(p) }; p += 8; i++; break;
      case 6: cp[i] = { tag, value: buf.readDoubleBE(p) }; p += 8; i++; break;
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, a: u2() }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, a: u2(), b: u2() }; break;
      case 15: cp[i] = { tag, a: u1(), b: u2() }; break;
      default: throw new ClassFormatError(`unknown constant pool tag ${tag} at #${i}`);
    }
  }
  const utf = (i: number) => cp[i]!.value as string;
  const className = (i: number) => utf(cp[i]!.a!);
  const readAttributes = () => {
    const attrs: Record<string, Buffer> = {};
    for (let n = u2(); n > 0; n--) {
      const name = utf(u2());
      const len = u4();
      attrs[name] = buf.subarray(p, p + len);
      p += len;
    }
    return attrs;
  };
  const access = u2();
  const thisClass = className(u2());
  const superIdx = u2();
  const superClass = superIdx ? className(superIdx) : null;
  const interfaces: string[] = [];
  for (let n = u2(); n > 0; n--) interfaces.push(className(u2()));
  const members = () => {
    const out: Member[] = [];
    for (let n = u2(); n > 0; n--) {
      const flags = u2(); const name = utf(u2()); const desc = utf(u2());
      out.push({ flags, name, desc, attrs: readAttributes() });
    }
    return out;
  };
  const fields = members();
  const methods = members();
  const cls: ClassFile = { access, name: thisClass, superClass, interfaces, cp, fields, methods };
  for (const f of fields) {
    const cv = f.attrs.ConstantValue;
    if (cv) f.constantValue = constant(cls, cv.readUInt16BE(0));
  }
  for (const m of methods) {
    const c = m.attrs.Code;
    if (c) m.code = c.subarray(8, 8 + c.readUInt32BE(4));
  }
  return cls;
}

/** Resolves a loadable constant / member reference into a plain JS value. */
export function constant(cls: ClassFile, i: number): Constant {
  const e = cls.cp[i]!;
  const utf = (j: number) => cls.cp[j]!.value as string;
  switch (e.tag) {
    case 3: case 4: case 5: case 6: return e.value as number | bigint;
    case 8: return utf(e.a!);
    case 7: return { classRef: utf(e.a!) };
    case 9: case 10: case 11: {
      const nt = cls.cp[e.b!]!;
      return { owner: utf(cls.cp[e.a!]!.a!), name: utf(nt.a!), desc: utf(nt.b!) };
    }
    default: return { tag: e.tag };
  }
}

// Operand byte counts for fixed-length opcodes (index = opcode); -1 = variable length.
const OPERAND_LEN = new Int8Array(256).fill(0);
for (const [from, to, len] of [
  [16, 16, 1], [17, 17, 2], [18, 18, 1], [19, 20, 2], [21, 25, 1], [54, 58, 1], [132, 132, 2],
  [153, 168, 2], [169, 169, 1], [170, 171, -1], [178, 184, 2], [185, 186, 4], [187, 187, 2],
  [188, 188, 1], [189, 189, 2], [192, 193, 2], [196, 196, -1], [197, 197, 3], [198, 199, 2], [200, 201, 4],
] as const) for (let o = from; o <= to; o++) OPERAND_LEN[o] = len;

export interface Instruction { pc: number; op: number; operands: Buffer }

/** Yields { pc, op, operands } for every instruction in a Code array. */
export function* instructions(code: Buffer): Generator<Instruction, void, undefined> {
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc]!;
    let len = OPERAND_LEN[op]!;
    if (op === 170 || op === 171) {
      const base = (pc + 4) & ~3;
      if (op === 170) {
        const lo = code.readInt32BE(base + 4); const hi = code.readInt32BE(base + 8);
        len = base - pc - 1 + 12 + (hi - lo + 1) * 4;
      } else {
        len = base - pc - 1 + 8 + code.readInt32BE(base + 4) * 8;
      }
    } else if (op === 196) {
      len = code[pc + 1] === 132 ? 5 : 3;
    } else if (op > 201) {
      throw new Error(`unknown opcode ${op} at pc ${pc}`);
    }
    yield { pc, op, operands: code.subarray(pc + 1, pc + 1 + len) };
    pc += 1 + len;
  }
}

/** Number of argument slots-as-values in a method descriptor (each argument counts once). */
export function descriptorArgCount(desc: string): number {
  let n = 0;
  for (let i = 1; desc[i] !== ')'; i++) {
    while (desc[i] === '[') i++;
    if (desc[i] === 'L') i = desc.indexOf(';', i);
    n++;
  }
  return n;
}

/** Values tracked on the simulated operand stack. */
export type SimValue =
  | Constant
  | null
  | undefined
  | { static: Constant }
  | { newOf: string; args: SimValue[] | null }
  | { array: SimValue[] }
  | { call: MemberRef; target: SimValue; args: SimValue[] };

export type Effect =
  | { kind: 'putstatic'; field: MemberRef; value: SimValue }
  | { kind: 'putfield'; target: SimValue; field: MemberRef; value: SimValue };

/** Narrows a simulated value to an object with the given key. */
export function has<K extends string>(v: SimValue, key: K): v is Extract<SimValue, Record<K, unknown>> {
  return typeof v === 'object' && v !== null && key in v;
}

/**
 * Simulates a method (normally <clinit>) tracking literal values only. Returns the ordered list of
 * observed effects: { kind: 'putstatic', field, value } and { kind: 'putfield', target, field, value }.
 * Objects created with `new` record their constructor arguments in `.args`; arrays record elements.
 * Any opcode it does not model clears the stack, so unrelated code cannot leak stale values.
 */
export function simulate(cls: ClassFile, method: Member): Effect[] {
  const effects: Effect[] = [];
  let stack: SimValue[] = [];
  const pop = (): SimValue => (stack.length ? stack.pop() : undefined);
  for (const { op, operands } of instructions(method.code!)) {
    const u2 = () => operands.readUInt16BE(0);
    if (op === 1) stack.push(null);
    else if (op >= 2 && op <= 8) stack.push(op - 3);
    else if (op === 16) stack.push(operands.readInt8(0));
    else if (op === 17) stack.push(operands.readInt16BE(0));
    else if (op === 18) stack.push(constant(cls, operands[0]!));
    else if (op === 19 || op === 20) stack.push(constant(cls, u2()));
    else if (op === 178) stack.push({ static: constant(cls, u2()) });
    else if (op === 187) stack.push({ newOf: (constant(cls, u2()) as ClassRef).classRef, args: null });
    else if (op === 89) stack.push(stack[stack.length - 1]);
    else if (op === 87) pop();
    else if (op === 192) { /* checkcast */ }
    else if (op === 189 || op === 188) { const n = pop(); stack.push({ array: new Array<SimValue>(typeof n === 'number' ? n : 0).fill(undefined) }); }
    else if (op === 83 || op === 79) {
      const v = pop(); const idx = pop(); const arr = pop();
      if (has(arr, 'array') && typeof idx === 'number') arr.array[idx] = v;
    } else if (op >= 182 && op <= 185) {
      const ref = constant(cls, u2()) as MemberRef;
      const args: SimValue[] = [];
      for (let n = descriptorArgCount(ref.desc); n > 0; n--) args.unshift(pop());
      const target = op === 184 ? null : pop();
      if (op === 183 && ref.name === '<init>' && has(target, 'newOf')) target.args = args;
      else if (!ref.desc.endsWith(')V')) stack.push({ call: ref, target, args });
    } else if (op === 179) {
      effects.push({ kind: 'putstatic', field: constant(cls, u2()) as MemberRef, value: pop() });
    } else if (op === 181) {
      const value = pop(); const target = pop();
      effects.push({ kind: 'putfield', target, field: constant(cls, u2()) as MemberRef, value });
    } else {
      stack = [];
    }
  }
  return effects;
}

/** Enum constant names in declaration (= ordinal) order. */
export function enumConstants(cls: ClassFile): string[] {
  return cls.fields.filter((f) => (f.flags & ACC_ENUM) !== 0).map((f) => f.name);
}

export const findMethod = (cls: ClassFile, name: string): Member | undefined => cls.methods.find((m) => m.name === name && m.code);
