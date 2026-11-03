import { BitVec } from './util';
export const TIF_SWD = 1;
export class UsbError extends Error {}
export function isObProbe(v: string): boolean { return /(^|[^A-Za-z])OB([^A-Za-z]|$)/.test(v.split('compiled')[0]); }
export function firmwareYear(v: string): number | null { const m = /compiled\s+\w+\s+\d+\s+(\d{4})/.exec(v); return m ? parseInt(m[1], 10) : null; }
export interface Soc { read(a: number): number; write(a: number, v: number, size: number): void; }
/** Fake probe: decodes the real SWD bit stream produced by SwdDap and drives a memory model through a MEM-AP. */
export class JLink {
  stats = { words: 0, halfs: 0 };
  onTrace: ((line: string) => void) | null = null;
  traceLeft = 14;
  ctrl = 0; select = 0; csw = 0xa2000012; tar = 0; buf = 0;
  async getVersion() { return (globalThis as any).FWVER ?? 'J-Link fake compiled Jan 1 2020'; }
  async getAvailableInterfaces(): Promise<number | null> { return null; }
  async selectInterface(_: number) {}
  async setSpeedKhz(_: number) {}
  async setTargetPower(_: boolean) {}
  async getTargetVoltageMv(): Promise<number | null> { return (globalThis as any).VT ?? 3300; }
  async swdIo(_dir: Uint8Array, out: Uint8Array, bits: number): Promise<Uint8Array> {
    const soc: Soc = (globalThis as any).SOC;
    const o = new BitVec(out); const res = new BitVec(new Uint8Array(out.length));
    const S: number = (globalThis as any).SHIFT ?? 0; // emulate a probe whose input stream is delayed/advanced by S bits
    const putAt = (pos: number, v: number, n: number) => { for (let i = 0; i < n; i++) { const p = pos + i; if (p >= 0 && p < bits && ((v >>> i) & 1)) res.bytes[p >> 3] |= 1 << (p & 7); } };
    let pos = 0;
    if (o.get(0, 32) === 0xffffffff) pos = 136; // line reset + JTAG->SWD + line reset + idle
    while (pos < bits) {
      if (o.get(pos, 1) === 0) { pos++; continue; }
      const req = o.get(pos, 8); const ap = (req >> 1) & 1, rd = (req >> 2) & 1, reg = (((req >> 3) & 1) << 2) | (((req >> 4) & 1) << 3);
      putAt(pos + 9 + S, 1, 3); // ACK = OK
      if (rd) {
        let v = 0;
        if (!ap) v = reg === 0 ? 0x1ba01477 : reg === 4 ? ((this.ctrl & 0x50000000) ? 0xf0000000 : 0) : reg === 0xc ? this.buf : 0;
        else if (reg === 0xc) { v = this.buf; const size = this.csw & 7; this.buf = this.rd(soc, this.tar, size); this.tar += size === 1 ? 2 : 4; this.stats.words++; }
        v >>>= 0; putAt(pos + 12 + S, v, 32);
        let p = 0; for (let i = 0; i < 32; i++) p ^= (v >>> i) & 1; putAt(pos + 44 + S, p, 1);
        pos += 54;
      } else {
        const data = o.get(pos + 13, 32);
        if (!ap) { if (reg === 4) this.ctrl = data; else if (reg === 8) this.select = data; }
        else if (reg === 0) this.csw = data; else if (reg === 4) this.tar = data;
        else if (reg === 0xc) {
          const size = this.csw & 7;
          if (size === 2) { soc.write(this.tar, data, 4); this.tar += 4; this.stats.words++; }
          else if (size === 1) { soc.write(this.tar, (data >>> ((this.tar & 2) * 8)) & 0xffff, 2); this.tar += 2; this.stats.halfs++; }
          else throw new Error('unexpected CSW size ' + size);
        }
        pos += 54;
      }
    }
    (globalThis as any).LASTCSW = this.csw;
    return res.bytes;
  }
  private rd(soc: Soc, a: number, size: number) { return size === 1 ? (soc.read(a & ~3) >>> ((a & 2) * 8)) & 0xffff : soc.read(a); }
}
