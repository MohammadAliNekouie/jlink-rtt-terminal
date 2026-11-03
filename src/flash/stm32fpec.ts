import { sleep, hex32 } from '../util';
import { FlashChip, Mem, Probe, Sector, padBitsFor } from './types';

/** STM32F0 / F1 / F3: "FPEC" flash controller, 16-bit programming, uniform pages. */
const FPEC = 0x40022000;
const KEYR = FPEC + 0x04;
const SR = FPEC + 0x0c;
const CR = FPEC + 0x10;
const AR = FPEC + 0x14;
const RCC_CR = 0x40021000;

const KEY1 = 0x45670123;
const KEY2 = 0xcdef89ab;
const SR_BSY = 1 << 0;
const SR_ERR = (1 << 2) | (1 << 4); // PGERR | WRPRTERR
const SR_CLEAR = 0x34; // EOP | WRPRTERR | PGERR
const CR_PG = 1 << 0;
const CR_PER = 1 << 1;
const CR_STRT = 1 << 6;
const CR_LOCK = 1 << 7;

interface Fam {
  name: string;
  page: number;
  sizeReg: number; // flash size register (KB, halfword)
}

const F1_SIZE = 0x1ffff7e0;
const F03_SIZE = 0x1ffff7cc;

const FAMILIES: Record<number, Fam> = {
  // F1
  0x412: { name: 'F10x low-density', page: 1024, sizeReg: F1_SIZE },
  0x410: { name: 'F10x medium-density', page: 1024, sizeReg: F1_SIZE },
  0x414: { name: 'F10x high-density', page: 2048, sizeReg: F1_SIZE },
  0x418: { name: 'F10x connectivity', page: 2048, sizeReg: F1_SIZE },
  0x420: { name: 'F100 value line', page: 1024, sizeReg: F1_SIZE },
  0x428: { name: 'F100 value line (high)', page: 2048, sizeReg: F1_SIZE },
  // F0
  0x440: { name: 'F05x', page: 1024, sizeReg: F03_SIZE },
  0x444: { name: 'F03x', page: 1024, sizeReg: F03_SIZE },
  0x445: { name: 'F04x/F070x6', page: 1024, sizeReg: F03_SIZE },
  0x448: { name: 'F07x', page: 2048, sizeReg: F03_SIZE },
  0x442: { name: 'F09x', page: 2048, sizeReg: F03_SIZE },
  // F3
  0x422: { name: 'F302/F303 (B/C)', page: 2048, sizeReg: F03_SIZE },
  0x432: { name: 'F373/F378', page: 2048, sizeReg: F03_SIZE },
  0x438: { name: 'F303x6/8', page: 2048, sizeReg: F03_SIZE },
  0x439: { name: 'F301/F302x6/8', page: 2048, sizeReg: F03_SIZE },
  0x446: { name: 'F302/F303 (D/E)', page: 2048, sizeReg: F03_SIZE },
};

async function waitNotBusy(mem: Mem, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const sr = (await mem.readWords(SR, 1))[0];
    if ((sr & SR_BSY) === 0) return sr;
    if (Date.now() - t0 > timeoutMs) throw new Error('Flash controller stayed busy (SR=' + hex32(sr) + ')');
    await sleep(2);
  }
}

function checkErr(sr: number, what: string): void {
  if ((sr & SR_ERR) !== 0) {
    throw new Error(what + ' error, FLASH_SR=' + hex32(sr) + ((sr & 0x10) ? ' (page is write-protected)' : ''));
  }
}

async function readId(mem: Mem): Promise<number | null> {
  for (const a of [0xe0042000, 0x40015800]) {
    try {
      const id = (await mem.readWords(a, 1))[0] & 0xfff;
      if (FAMILIES[id] || id === 0x430) return id;
    } catch {
      /* address not present on this core */
    }
  }
  return null;
}

export const probeStm32Fpec: Probe = async (mem, ctx) => {
  const id = await readId(mem);
  if (id === null) return null;
  if (id === 0x430) throw new Error('STM32F10x XL-density (dual-bank flash) is not supported yet');
  const fam = FAMILIES[id];
  const kb = (await mem.readWords(fam.sizeReg, 1))[0] & 0xffff;
  if (kb < 4 || kb > 1024) throw new Error('STM32' + fam.name + ': implausible flash size register (' + kb + ' KB)');
  const size = kb * 1024;
  const base = 0x08000000;
  const padBits = padBitsFor(80, ctx.speedKhz); // ~53 us typ per halfword

  const chip: FlashChip = {
    name: 'STM32' + fam.name + ' (DEV_ID 0x' + id.toString(16) + ', ' + kb + ' KB, ' + fam.page + ' B pages)',
    flashStart: base,
    flashEnd: base + size,
    sectorAt(addr) {
      if (addr < base || addr >= base + size) throw new Error('Address ' + hex32(addr) + ' is not in flash');
      const idx = Math.floor((addr - base) / fam.page);
      const s: Sector = { start: base + idx * fam.page, size: fam.page, id: idx };
      return s;
    },
    async unlock(m) {
      // The flash controller runs from the internal RC oscillator, which must be on.
      const rcc = (await m.readWords(RCC_CR, 1))[0];
      if ((rcc & 1) === 0) {
        await m.writeWord(RCC_CR, (rcc | 1) >>> 0);
        const t0 = Date.now();
        while (((await m.readWords(RCC_CR, 1))[0] & 2) === 0) {
          if (Date.now() - t0 > 200) throw new Error('Internal RC oscillator (HSI) did not start');
          await sleep(2);
        }
      }
      await waitNotBusy(m, 2000);
      let cr = (await m.readWords(CR, 1))[0];
      if ((cr & CR_LOCK) !== 0) {
        await m.writeWord(KEYR, KEY1);
        await m.writeWord(KEYR, KEY2);
        cr = (await m.readWords(CR, 1))[0];
        if ((cr & CR_LOCK) !== 0) throw new Error('Flash controller refused the unlock keys');
      }
      await m.writeWord(SR, SR_CLEAR);
    },
    async eraseSector(m, s) {
      await waitNotBusy(m, 2000);
      await m.writeWord(SR, SR_CLEAR);
      await m.writeWord(CR, CR_PER);
      await m.writeWord(AR, s.start);
      await m.writeWord(CR, CR_PER | CR_STRT);
      const sr = await waitNotBusy(m, 5000);
      await m.writeWord(CR, 0);
      checkErr(sr, 'Page erase');
    },
    async beginProgram(m) {
      await waitNotBusy(m, 2000);
      await m.writeWord(SR, SR_CLEAR);
      await m.writeWord(CR, CR_PG);
    },
    async program(m, addr, words) {
      const hws: number[] = new Array(words.length * 2);
      for (let i = 0; i < words.length; i++) {
        hws[2 * i] = words[i] & 0xffff;
        hws[2 * i + 1] = words[i] >>> 16;
      }
      await m.writeHalfwordsPaced(addr, hws, padBits);
      const sr = await waitNotBusy(m, 2000);
      checkErr(sr, 'Programming');
    },
    async endProgram(m) {
      await m.writeWord(CR, 0);
    },
    async prepareVerify() {
      /* nothing to flush */
    },
    async lock(m) {
      await m.writeWord(CR, CR_LOCK);
    },
  };
  return chip;
};
