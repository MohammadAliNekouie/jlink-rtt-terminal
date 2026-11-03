import { hex32 } from '../util';
import { probeNrf52 } from './nrf52';
import { probeStm32f4 } from './stm32f4';
import { probeStm32Fpec } from './stm32fpec';
import { UNSUPPORTED_STM32 } from './stm32ids';
import { Ctx, FlashChip, Mem, Probe } from './types';

export * from './types';

/** Add new chip families here: write a `Probe` that returns a FlashChip when the ID registers match. */
const PROBES: Probe[] = [probeStm32Fpec, probeStm32f4, probeNrf52];

export async function detectChip(mem: Mem, ctx: Ctx): Promise<FlashChip> {
  for (const p of PROBES) {
    const chip = await p(mem, ctx);
    if (chip) return chip;
  }
  let ids = '';
  let family = '';
  for (const a of [0xe0042000, 0x40015800]) {
    try {
      const v = (await mem.readWords(a, 1))[0];
      ids += ' IDCODE@' + hex32(a) + '=' + hex32(v);
      const f = UNSUPPORTED_STM32[v & 0xfff];
      if (f && !family) family = f;
    } catch {
      /* not present */
    }
  }
  try {
    ids += ' FICR.PART=' + hex32((await mem.readWords(0x10000100, 1))[0]);
  } catch {
    /* not present */
  }
  if (family) {
    throw new Error(family + ' detected, but its flash controller has no driver in this app yet.' + ids);
  }
  throw new Error(
    'Unsupported or locked chip (supported: STM32F0/F1/F2/F3/F4, nRF52).' + ids +
      ' If the chip is supported, read-out protection may be on.',
  );
}
