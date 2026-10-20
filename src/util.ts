const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_REV[B64[i]] = i;

export function b64encode(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i];
    const b = i + 1 < data.length ? data[i + 1] : 0;
    const c = i + 2 < data.length ? data[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < data.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < data.length ? B64[c & 63] : '=';
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = B64_REV[clean[i]];
    const n1 = B64_REV[clean[i + 1]];
    const n2 = i + 2 < clean.length ? B64_REV[clean[i + 2]] : 0;
    const n3 = i + 3 < clean.length ? B64_REV[clean[i + 3]] : 0;
    if (o < out.length) out[o++] = (n0 << 2) | (n1 >> 4);
    if (i + 2 < clean.length && o < out.length) out[o++] = ((n1 & 15) << 4) | (n2 >> 2);
    if (i + 3 < clean.length && o < out.length) out[o++] = ((n2 & 3) << 6) | n3;
  }
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function popcount32(v: number): number {
  let x = v >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

export const hex32 = (v: number): string => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** LSB-first bit vector (the layout J-Link SWD I/O uses). */
export class BitVec {
  bytes: Uint8Array;
  size = 0;

  constructor(arg: number | Uint8Array) {
    this.bytes = typeof arg === 'number' ? new Uint8Array((arg + 7) >> 3) : arg;
  }

  get capacity(): number {
    return this.bytes.length * 8;
  }

  private setBit(): void {
    this.bytes[this.size >> 3] |= 1 << (this.size & 7);
  }

  /** Append the low `count` (<= 32) bits of value. */
  put(value: number, count: number): void {
    if (this.size + count > this.capacity) throw new Error('BitVec overflow');
    for (let i = 0; i < count; i++) {
      if (((value >>> i) & 1) !== 0) this.setBit();
      this.size++;
    }
  }

  fill(bit: number, count: number): void {
    if (this.size + count > this.capacity) throw new Error('BitVec overflow');
    for (let i = 0; i < count; i++) {
      if (bit) this.setBit();
      this.size++;
    }
  }

  /** Read `count` (<= 32) bits at `pos`, unsigned. */
  get(pos: number, count: number): number {
    let v = 0;
    for (let i = 0; i < count; i++) {
      const p = pos + i;
      if (((this.bytes[p >> 3] >> (p & 7)) & 1) !== 0) v |= 1 << i;
    }
    return v >>> 0;
  }
}

/** Incremental UTF-8 decoder (Hermes has no reliable streaming TextDecoder). */
export class Utf8Stream {
  private carry: number[] = [];

  decode(bytes: Uint8Array): string {
    const all = this.carry.concat(Array.from(bytes));
    this.carry = [];
    let out = '';
    let i = 0;
    while (i < all.length) {
      const b = all[i];
      let need = 0;
      let cp = 0;
      if (b < 0x80) {
        out += String.fromCharCode(b);
        i++;
        continue;
      } else if ((b & 0xe0) === 0xc0) {
        need = 1;
        cp = b & 0x1f;
      } else if ((b & 0xf0) === 0xe0) {
        need = 2;
        cp = b & 0x0f;
      } else if ((b & 0xf8) === 0xf0) {
        need = 3;
        cp = b & 0x07;
      } else {
        out += '\uFFFD';
        i++;
        continue;
      }
      if (all.length - 1 - i < need) {
        this.carry = all.slice(i);
        break;
      }
      let ok = true;
      for (let k = 1; k <= need; k++) {
        if ((all[i + k] & 0xc0) !== 0x80) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (all[i + k] & 0x3f);
      }
      if (!ok) {
        out += '\uFFFD';
        i++;
        continue;
      }
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
    return out;
  }
}

export function encodeUtf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}
