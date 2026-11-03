import { Soc } from './jlink';
export class Base implements Soc {
  mem = new Map<number, number>(); halted = false; running = false; log: string[] = []; stuck = -1;
  flash(a: number) { return false; }
  rawGet(a: number) { return this.mem.has(a) ? this.mem.get(a)! : (this.flash(a) ? 0xffffffff : 0); }
  dbg(a: number, v?: number) {
    if (a === 0xe000edf0) { if (v === undefined) return this.halted ? 1 << 17 : 0; if ((v & 3) === 3) this.halted = true; if (v === 0xa05f0000) { this.halted = false; this.running = true; } return 0; }
    if (a === 0xe000ed0c && v === 0x05fa0004) { this.log.push('reset'); return 0; }
    return undefined;
  }
  read(a: number): number { const d = this.dbg(a); return (d !== undefined ? d : this.rawGet(a)) >>> 0; }
  write(a: number, v: number, size: number): void { if (this.dbg(a, v) === undefined) this.mem.set(a, v >>> 0); }
}
export class F1 extends Base {
  locked = true; cr = 0; sr = 0; ks = 0; ar = 0; idcode = 0x20036410; kb = 128; rccCr = 0x83; bad: string[] = [];
  flash(a: number) { return a >= 0x08000000 && a < 0x08000000 + this.kb * 1024; }
  read(a: number): number {
    if (a === 0xe0042000) return this.idcode; if (a === 0x1ffff7e0) return this.kb;
    if (a === 0x40022010) return (this.cr | (this.locked ? 0x80 : 0)) >>> 0; if (a === 0x4002200c) return this.sr; if (a === 0x40021000) return this.rccCr;
    if (a === 0x40015800) throw new Error('no such address');
    return super.read(a);
  }
  write(a: number, v: number, size: number): void {
    if (a === 0x40022004) { if (this.ks === 0 && v === 0x45670123) this.ks = 1; else if (this.ks === 1 && v === 0xcdef89ab) { this.locked = false; this.ks = 0; } else this.ks = 0; return; }
    if (a === 0x4002200c) { this.sr &= ~v; return; }
    if (a === 0x40021000) { this.rccCr = v | (v & 1 ? 2 : 0); return; }
    if (a === 0x40022014) { this.ar = v; return; }
    if (a === 0x40022010) {
      if (v & 0x80) { this.locked = true; this.cr = 0; return; }
      if (this.locked) { this.bad.push('CR while locked'); return; }
      this.cr = v;
      if ((v & 0x42) === 0x42) { const base = this.ar & ~1023; for (let x = base; x < base + 1024; x += 4) this.mem.set(x, 0xffffffff); this.log.push('erase ' + base.toString(16)); this.cr &= ~0x40; }
      return;
    }
    if (this.flash(a)) {
      if (size !== 2) { this.bad.push('non-halfword flash write size=' + size); this.sr |= 4; return; }
      if (this.locked || !(this.cr & 1)) { this.sr |= 4; this.bad.push('write without PG'); return; }
      const w = this.rawGet(a & ~3); const sh = (a & 2) * 8; const old = (w >>> sh) & 0xffff;
      if (old !== 0xffff) { this.sr |= 4; this.bad.push('write to non-erased halfword'); return; }
      let hw = v & 0xffff; if (a === this.stuck) hw ^= 1;
      this.mem.set(a & ~3, ((w & ~(0xffff << sh)) | (hw << sh)) >>> 0); this.log.push('hw'); return;
    }
    super.write(a, v, size);
  }
}
export class F4 extends Base {
  locked = true; cr = 0; sr = 0; ks = 0; kb = 512;
  flash(a: number) { return a >= 0x08000000 && a < 0x08000000 + this.kb * 1024; }
  read(a: number): number {
    if (a === 0xe0042000) return 0x10006431; if (a === 0x1fff7a20) return (this.kb << 16) >>> 0;
    if (a === 0x40023c10) return (this.cr | (this.locked ? 0x80000000 : 0)) >>> 0; if (a === 0x40023c0c) return this.sr;
    if (a === 0x40015800 || a === 0x1ffff7e0) return 0;
    return super.read(a);
  }
  write(a: number, v: number, size: number): void {
    if (a === 0x40023c04) { if (this.ks === 0 && v === 0x45670123) this.ks = 1; else if (this.ks === 1 && v === 0xcdef89ab) { this.locked = false; this.ks = 0; } else this.ks = 0; return; }
    if (a === 0x40023c0c) { this.sr &= ~v; return; }
    if (a === 0x40023c10) {
      if (v === 0x80000000) { this.locked = true; this.cr = 0; return; }
      this.cr = v & 0x7fffffff;
      if (v & (1 << 16)) { const snb = (v >> 3) & 31; const sizes = [16,16,16,16,64,128,128,128]; const s = snb; let st = 0x08000000; for (let i = 0; i < s; i++) st += sizes[i] * 1024; for (let x = st; x < st + sizes[s] * 1024; x += 4) this.mem.set(x, 0xffffffff); this.log.push('erase ' + st.toString(16)); this.cr &= ~(1 << 16); }
      return;
    }
    if (this.flash(a)) { if (size !== 4 || this.locked || !(this.cr & 1)) { this.sr |= 0x80; return; } if (this.rawGet(a) !== 0xffffffff) { this.sr |= 0x40; return; } this.mem.set(a, v); this.log.push('prog'); return; }
    super.write(a, v, size);
  }
}
