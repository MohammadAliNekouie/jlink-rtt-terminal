import { sleep } from './util';
import type { Mem } from './flash/types';

export const DHCSR = 0xe000edf0;
export const DEMCR = 0xe000edfc;
export const AIRCR = 0xe000ed0c;

const DBGKEY = 0xa05f0000;
const C_DEBUGEN = 1;
const C_HALT = 2;
const S_HALT = 1 << 17;

/** Halt the Cortex-M core (needed so the running firmware does not fight the flash controller). */
export async function haltCore(mem: Mem, timeoutMs = 1500): Promise<void> {
  await mem.writeWord(DHCSR, (DBGKEY | C_DEBUGEN) >>> 0);
  await mem.writeWord(DHCSR, (DBGKEY | C_DEBUGEN | C_HALT) >>> 0);
  const t0 = Date.now();
  for (;;) {
    const v = (await mem.readWords(DHCSR, 1))[0];
    if ((v & S_HALT) !== 0) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('Core did not halt (debug locked or core in reset?)');
    await sleep(5);
  }
}

/**
 * System reset, then let the core run. The reset can briefly upset the SWD link, so errors after the
 * AIRCR write are tolerated and the "resume" write is retried via `reconnect`.
 */
export async function resetAndRun(mem: Mem, reconnect: () => Promise<void>): Promise<boolean> {
  await mem.writeWord(DEMCR, 0); // no vector catch -> core runs after reset
  try {
    await mem.writeWord(AIRCR, 0x05fa0004); // SYSRESETREQ
  } catch {
    /* link may drop during reset */
  }
  await sleep(150);
  for (let i = 0; i < 2; i++) {
    try {
      await mem.writeWord(DHCSR, DBGKEY >>> 0); // C_DEBUGEN=0, C_HALT=0 -> run
      return true;
    } catch {
      try {
        await reconnect();
      } catch {
        /* try again */
      }
    }
  }
  return false;
}
