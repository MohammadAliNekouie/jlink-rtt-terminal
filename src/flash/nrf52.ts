import { sleep, hex32 } from '../util';
import { FlashChip, Mem, Probe, Sector, padBitsFor } from './types';

const FICR_CODEPAGESIZE = 0x10000010;
const FICR_CODESIZE = 0x10000014;
const FICR_INFO_PART = 0x10000100;

const NVMC = 0x4001e000;
const READY = NVMC + 0x400;
const CONFIG = NVMC + 0x504;
const ERASEPAGE = NVMC + 0x508;

const CFG_REN = 0;
const CFG_WEN = 1;
const CFG_EEN = 2;

const PARTS: Record<number, string> = {
  0x52805: 'nRF52805',
  0x52810: 'nRF52810',
  0x52811: 'nRF52811',
  0x52820: 'nRF52820',
  0x52832: 'nRF52832',
  0x52833: 'nRF52833',
  0x52840: 'nRF52840',
};

async function waitReady(mem: Mem, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const r = (await mem.readWords(READY, 1))[0];
    if ((r & 1) !== 0) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('NVMC stayed busy (READY=' + hex32(r) + ')');
    await sleep(2);
  }
}

export const probeNrf52: Probe = async (mem, ctx) => {
  let part: number;
  try {
    part = (await mem.readWords(FICR_INFO_PART, 1))[0] >>> 0;
  } catch {
    return null;
  }
  const name = PARTS[part];
  if (!name) return null;
  const pageSize = (await mem.readWords(FICR_CODEPAGESIZE, 1))[0] >>> 0;
  const pages = (await mem.readWords(FICR_CODESIZE, 1))[0] >>> 0;
  if (pageSize < 1024 || pageSize > 8192 || (pageSize & (pageSize - 1)) !== 0 || pages === 0 || pages > 1024) {
    throw new Error(name + ': implausible FICR flash geometry (page ' + pageSize + ' B x ' + pages + ')');
  }
  const size = pageSize * pages;
  const padBits = padBitsFor(100, ctx.speedKhz);

  const chip: FlashChip = {
    name: name + ' (' + size / 1024 + ' KB, ' + pageSize + ' B pages)',
    flashStart: 0,
    flashEnd: size,
    sectorAt(addr) {
      if (addr < 0 || addr >= size) throw new Error('Address ' + hex32(addr) + ' is not in flash');
      const start = addr - (addr % pageSize);
      const s: Sector = { start, size: pageSize, id: start / pageSize };
      return s;
    },
    async unlock(m) {
      await waitReady(m, 1000);
      await m.writeWord(CONFIG, CFG_REN);
    },
    async eraseSector(m, s) {
      await waitReady(m, 1000);
      await m.writeWord(CONFIG, CFG_EEN);
      await m.writeWord(ERASEPAGE, s.start);
      await waitReady(m, 1000);
      await m.writeWord(CONFIG, CFG_REN);
    },
    async beginProgram(m) {
      await waitReady(m, 1000);
      await m.writeWord(CONFIG, CFG_WEN);
    },
    async program(m, addr, words) {
      await m.writeWordsPaced(addr, words, padBits);
      await waitReady(m, 2000);
    },
    async endProgram(m) {
      await m.writeWord(CONFIG, CFG_REN);
    },
    async prepareVerify() {
      /* nothing to flush */
    },
    async lock(m) {
      await m.writeWord(CONFIG, CFG_REN);
    },
  };
  return chip;
};
