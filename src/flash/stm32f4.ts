import { sleep, hex32 } from '../util';
import { FlashChip, Mem, Probe, Sector, padBitsFor } from './types';

const DBGMCU_IDCODE = 0xe0042000;
const DBGMCU_APB1_FZ = 0xe0042008;
const FLASH_SIZE_WORD = 0x1fff7a20; // FLASH_SIZE is the upper halfword (0x1FFF7A22), in KB

const FLASH = 0x40023c00;
const ACR = FLASH + 0x00;
const KEYR = FLASH + 0x04;
const SR = FLASH + 0x0c;
const CR = FLASH + 0x10;

const KEY1 = 0x45670123;
const KEY2 = 0xcdef89ab;
const SR_BSY = 1 << 16;
const SR_ERR = 0xf2; // OPERR | WRPERR | PGAERR | PGPERR | PGSERR
const SR_CLEAR = 0xf3;
const CR_PG = 1 << 0;
const CR_SER = 1 << 1;
const CR_STRT = 1 << 16;
const CR_LOCK = 0x80000000;
const PSIZE_X32 = 2 << 8;

/** F2xx and F401/F405/F407/F410/F411/F412/F413/F423/F427/F429/F437/F439/F446/F469/F479. */
const DEV_IDS: Record<number, string> = {
  0x411: 'F2xx',
  0x413: 'F405/407/415/417',
  0x419: 'F42x/43x',
  0x421: 'F446',
  0x423: 'F401xB/C',
  0x431: 'F411',
  0x433: 'F401xD/E',
  0x434: 'F469/479',
  0x441: 'F412',
  0x458: 'F410',
  0x463: 'F413/423',
};

const BANK_PATTERN_KB = [16, 16, 16, 16, 64, 128, 128, 128, 128, 128, 128, 128];

export function stm32f4Sectors(flashKb: number): Sector[] {
  const out: Sector[] = [];
  const dual = flashKb === 2048;
  const perBank = dual ? 12 : Infinity;
  let addr = 0x08000000;
  let remaining = flashKb * 1024;
  let n = 0;
  while (remaining > 0) {
    let size: number;
    let id: number;
    if (dual && n >= perBank) {
      const k = n - perBank;
      size = BANK_PATTERN_KB[k] * 1024;
      id = 16 + k; // SNB bit 4 selects bank 2
      if (k === 0) addr = 0x08100000;
    } else {
      size = (n < BANK_PATTERN_KB.length ? BANK_PATTERN_KB[n] : 128) * 1024;
      id = n;
    }
    if (size > remaining) size = remaining;
    out.push({ start: addr, size, id });
    addr += size;
    remaining -= size;
    n++;
  }
  return out;
}

async function waitNotBusy(mem: Mem, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const sr = (await mem.readWords(SR, 1))[0];
    if ((sr & SR_BSY) === 0) return sr;
    if (Date.now() - t0 > timeoutMs) throw new Error('Flash controller stayed busy (SR=' + hex32(sr) + ')');
    await sleep(3);
  }
}

function checkErr(sr: number, what: string): void {
  if ((sr & SR_ERR) !== 0) throw new Error(what + ' error, FLASH_SR=' + hex32(sr) + ' (write-protected or bad sequence?)');
}

export const probeStm32f4: Probe = async (mem, ctx) => {
  let id: number;
  try {
    id = (await mem.readWords(DBGMCU_IDCODE, 1))[0] & 0xfff;
  } catch {
    return null;
  }
  const family = DEV_IDS[id];
  if (!family) return null;
  const kb = ((await mem.readWords(FLASH_SIZE_WORD, 1))[0] >>> 16) & 0xffff;
  if (kb === 0 || kb > 2048) throw new Error('STM32F4: implausible flash size register (' + kb + ' KB)');
  const sectors = stm32f4Sectors(kb);
  const padBits = padBitsFor(60, ctx.speedKhz);

  const chip: FlashChip = {
    name: 'STM32' + family + ' (DEV_ID 0x' + id.toString(16) + ', ' + kb + ' KB)',
    flashStart: 0x08000000,
    flashEnd: 0x08000000 + kb * 1024,
    sectorAt(addr) {
      for (const s of sectors) if (addr >= s.start && addr < s.start + s.size) return s;
      throw new Error('Address ' + hex32(addr) + ' is not in flash');
    },
    async unlock(m) {
      if (ctx.vtrefMv !== null && ctx.vtrefMv > 500 && ctx.vtrefMv < 2700) {
        throw new Error('STM32F4 word programming needs VDD >= 2.7 V (probe reports ' + ctx.vtrefMv + ' mV)');
      }
      // Stop the watchdogs while halted so the chip does not reset in the middle of programming.
      const fz = (await m.readWords(DBGMCU_APB1_FZ, 1))[0];
      await m.writeWord(DBGMCU_APB1_FZ, (fz | (1 << 12) | (1 << 11)) >>> 0);
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
      const base = PSIZE_X32 | CR_SER | (s.id << 3);
      await m.writeWord(CR, base >>> 0);
      await m.writeWord(CR, (base | CR_STRT) >>> 0);
      const sr = await waitNotBusy(m, 20000);
      await m.writeWord(CR, 0);
      checkErr(sr, 'Sector erase');
    },
    async beginProgram(m) {
      await waitNotBusy(m, 2000);
      await m.writeWord(SR, SR_CLEAR);
      await m.writeWord(CR, (PSIZE_X32 | CR_PG) >>> 0);
    },
    async program(m, addr, words) {
      await m.writeWordsPaced(addr, words, padBits);
      const sr = await waitNotBusy(m, 2000);
      checkErr(sr, 'Programming');
    },
    async endProgram(m) {
      await m.writeWord(CR, 0);
    },
    async prepareVerify(m) {
      // Flush the ART accelerator caches so reads return what is really in flash.
      const acr = (await m.readWords(ACR, 1))[0];
      await m.writeWord(ACR, (acr & ~0x600) >>> 0);
      await m.writeWord(ACR, ((acr & ~0x600) | 0x1800) >>> 0);
      await m.writeWord(ACR, (acr & ~0x1e00) >>> 0);
    },
    async lock(m) {
      await m.writeWord(CR, CR_LOCK);
    },
  };
  return chip;
};
