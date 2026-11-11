import { Soc } from './jlink';
export class Base implements Soc {
  mem = new Map<number, number>(); resetSeen = false; after = 0; halted = false; running = false; log: string[] = []; stuck = -1;
  flash(a: number) { return false; }
  rawGet(a: number) { return this.mem.has(a) ? this.mem.get(a)! : (this.flash(a) ? 0xffffffff : 0); }
  dbg(a: number, v?: number) {
    if (a === 0xe000edf0) { if (v === undefined) return this.halted ? 1 << 17 : 0; if ((v & 3) === 3) this.halted = true; if (v === 0xa05f0000) { this.halted = false; this.running = true; } return 0; }
    if (a === 0xe000ed0c && v === 0x05fa0004) { this.log.push('reset'); this.resetSeen = true; return 0; }
    return undefined;
  }
  read(a: number): number { if (a === 0xe000ed00) return 0x411fc231; /* Cortex-M3 CPUID */ const d = this.dbg(a); return (d !== undefined ? d : this.rawGet(a)) >>> 0; }
  write(a: number, v: number, size: number): void { if (this.dbg(a, v) === undefined) this.mem.set(a, v >>> 0); }
}
export class F1 extends Base {
  locked = true; cr = 0; sr = 0; ks = 0; ar = 0; idcode = 0x20036410; kb = 128; rccCr = 0x83; bad: string[] = [];
  optwre = false; oks = 0; failOb = false; rdpActive = false;
  constructor() {
    super();
    // option bytes (value | complement<<8 per halfword): RDP 0xA5, USER 0xFE (hardware watchdog), Data 0xFF, WRP0 0xFE, WRP1-3 0xFF
    this.mem.set(0x1ffff800, 0x01fe5aa5 >>> 0); // RDP/nRDP, USER/nUSER
    this.mem.set(0x1ffff804, 0x00ff00ff); this.mem.set(0x1ffff808, 0x00ff01fe); this.mem.set(0x1ffff80c, 0x00ff00ff);
  }
  ob(i: number) { const w = this.rawGet(0x1ffff800 + 4 * (i >> 1)); return (w >>> ((i & 1) * 16)) & 0xff; } // value byte of option halfword i
  obPair(i: number) { const w = this.rawGet(0x1ffff800 + 4 * (i >> 1)); return (w >>> ((i & 1) * 16)) & 0xffff; }
  flash(a: number) { return a >= 0x08000000 && a < 0x08000000 + this.kb * 1024; }
  read(a: number): number {
    if (this.resetSeen) this.after++;
    if (a === 0xe0042000) return this.idcode;
    if (a === 0x1ffff7e0) { if (this.rdpActive) throw new Error('bus fault (read-out protection)'); return this.kb; }
    if (a === 0x40022010) return (this.cr | (this.locked ? 0x80 : 0) | (this.optwre ? 0x200 : 0)) >>> 0; if (a === 0x4002200c) return this.sr; if (a === 0x40021000) return this.rccCr;
    if (a === 0x40015800) throw new Error('no such address');
    return super.read(a);
  }
  write(a: number, v: number, size: number): void {
    if (this.resetSeen) this.after++;
    if (a === 0x40022008) { if (this.locked) { this.bad.push('OPTKEYR while flash locked'); return; } if (this.oks === 0 && v === 0x45670123) this.oks = 1; else if (this.oks === 1 && v === 0xcdef89ab) { this.optwre = true; this.oks = 0; } else this.oks = 0; return; }
    if (a >= 0x1ffff800 && a < 0x1ffff810) { // option byte halfword programming
      const h = (a - 0x1ffff800) >> 1;
      if (size !== 2) { this.bad.push('option byte write size=' + size); this.sr |= 4; return; }
      if (this.locked || !this.optwre || !(this.cr & 0x10)) { this.bad.push('option byte write without unlock/OPTPG'); this.sr |= 4; return; }
      if (this.obPair(h) !== 0xffff) { this.bad.push('option byte not erased'); this.sr |= 4; return; }
      if (this.failOb) { this.sr |= 4; return; }
      const low = v & 0xff; const pair = low | ((~low & 0xff) << 8);
      const wa = 0x1ffff800 + 4 * (h >> 1); const sh = (h & 1) * 16; const w = this.rawGet(wa);
      this.mem.set(wa, ((w & ~(0xffff << sh)) | (pair << sh)) >>> 0); this.log.push('obprog ' + h); return;
    }
    if (a === 0x40022004) { if (this.ks === 0 && v === 0x45670123) this.ks = 1; else if (this.ks === 1 && v === 0xcdef89ab) { this.locked = false; this.ks = 0; } else this.ks = 0; return; }
    if (a === 0x4002200c) { this.sr &= ~v; return; }
    if (a === 0x40021000) { this.rccCr = v | (v & 1 ? 2 : 0); return; }
    if (a === 0x40022014) { this.ar = v; return; }
    if (a === 0x40022010) {
      if (v & 0x80) { this.locked = true; this.optwre = false; this.cr = 0; return; }
      if (this.locked) { this.bad.push('CR while locked'); return; }
      this.optwre = this.optwre && !!(v & 0x200); // software can only clear OPTWRE
      this.cr = v & ~0x200;
      if ((v & 0x60) === 0x60) { // option byte erase
        if (!this.optwre) { this.bad.push('option erase without OPTWRE'); this.sr |= 4; this.cr &= ~0x40; return; }
        for (const x of [0x1ffff800, 0x1ffff804, 0x1ffff808, 0x1ffff80c]) this.mem.set(x, 0xffffffff);
        this.log.push('oberase'); this.cr &= ~0x40; return;
      }
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
  locked = true; cr = 0; sr = 0; ks = 0; kb = 512; optcr = 0x0fffaaed; oks = 0; rdpActive = false;
  flash(a: number) { return a >= 0x08000000 && a < 0x08000000 + this.kb * 1024; }
  read(a: number): number {
    if (this.resetSeen) this.after++;
    if (a === 0xe0042000) return 0x10006431;
    if (a === 0x1fff7a20) { if (this.rdpActive) throw new Error('bus fault (read-out protection)'); return (this.kb << 16) >>> 0; }
    if (a === 0x40023c14) return this.optcr >>> 0;
    if (a === 0x40023c10) return (this.cr | (this.locked ? 0x80000000 : 0)) >>> 0; if (a === 0x40023c0c) return this.sr;
    if (a === 0x40015800 || a === 0x1ffff7e0) return 0;
    return super.read(a);
  }
  write(a: number, v: number, size: number): void {
    if (this.resetSeen) this.after++;
    if (a === 0x40023c08) { if (this.oks === 0 && v === 0x08192a3b) this.oks = 1; else if (this.oks === 1 && v === 0x4c5d6e7f) { this.optcr &= ~1; this.oks = 0; } else this.oks = 0; return; }
    if (a === 0x40023c14) { if (this.optcr & 1 && !(v & 1 && (v & ~3) === (this.optcr & ~3))) { this.log.push('optcr write while locked'); return; } this.optcr = (v & ~2) >>> 0; if (v & 2) this.log.push('optstrt'); return; }
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

export class Nrf extends Base {
  config = 0; pages = 256;
  flash(a: number) { return a >= 0 && a < this.pages * 4096; }
  read(a: number): number {
    if (this.resetSeen) this.after++;
    if (a === 0xe0042000 || a === 0x40015800) throw new Error('no such address');
    if (a === 0x10000100) return 0x52840; if (a === 0x10000010) return 4096; if (a === 0x10000014) return this.pages;
    if (a === 0x4001e400) return 1; if (a === 0x4001e504) return this.config;
    return super.read(a);
  }
  write(a: number, v: number, size: number): void {
    if (this.resetSeen) this.after++;
    if (a === 0x4001e504) { this.config = v; return; }
    if (a === 0x4001e508) { for (let x = v; x < v + 4096; x += 4) this.mem.set(x, 0xffffffff); this.log.push('erase ' + v.toString(16)); return; }
    if (this.flash(a)) { this.mem.set(a, (this.rawGet(a) & v) >>> 0); return; }
    super.write(a, v, size);
  }
}
