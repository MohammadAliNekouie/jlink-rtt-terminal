/**
 * Diagnostic only: when SWD gets no answer, try to read the JTAG IDCODE through the same J-Link bit-bang command.
 * If the target answers on JTAG but not on SWD, the board is JTAG-only (or SWD is not wired / disabled).
 */
export interface BitProbe {
  selectInterface(tif: number): Promise<void>;
  /** Same frame as SWD I/O: [cmd, 0, bits, tms[], tdi[]] -> tdo[] in JTAG mode. */
  swdIo(tms: Uint8Array, tdi: Uint8Array, bits: number): Promise<Uint8Array>;
}

const TIF_JTAG = 0;

function pack(bitsArr: number[]): Uint8Array {
  const b = new Uint8Array((bitsArr.length + 7) >> 3);
  bitsArr.forEach((v, i) => {
    if (v) b[i >> 3] |= 1 << (i & 7);
  });
  return b;
}

function getBits(b: Uint8Array, pos: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const p = pos + i;
    if (p >= 0 && p >> 3 < b.length && ((b[p >> 3] >> (p & 7)) & 1) !== 0) v += 2 ** i;
  }
  return v;
}

const hex8 = (v: number): string => '0x' + v.toString(16).toUpperCase().padStart(8, '0');

/** Reads the 32-bit JTAG IDCODE (TAP reset -> Shift-DR). Returns a one-line report for the log. */
export async function probeJtagIdcode(jl: BitProbe): Promise<string> {
  // TMS: 5x1 (Test-Logic-Reset), 0 (Run-Test/Idle), 1 (Select-DR), 0 (Capture-DR), 0 (Shift-DR),
  //      then 32 shift clocks (last one with TMS=1), then 1,0 back to Run-Test/Idle.
  const tms: number[] = [1, 1, 1, 1, 1, 0, 1, 0, 0];
  for (let i = 0; i < 31; i++) tms.push(0);
  tms.push(1, 1, 0);
  const bits = tms.length;
  await jl.selectInterface(TIF_JTAG);
  const tdo = await jl.swdIo(pack(tms), pack(new Array(bits).fill(0)), bits);
  let raw = '';
  for (let i = 0; i < Math.min(tdo.length, 8); i++) raw += tdo[i].toString(16).padStart(2, '0') + ' ';
  for (const off of [0, 1, -1, 2, -2]) {
    const id = getBits(tdo, 9 + off, 32);
    // A real IDCODE has bit0 = 1 and a non-trivial manufacturer field.
    if ((id & 1) === 1 && id !== 0xffffffff && ((id >>> 1) & 0x7ff) !== 0 && ((id >>> 1) & 0x7ff) !== 0x7ff) {
      return 'JTAG IDCODE ' + hex8(id) + ' (sample offset ' + off + ') - the target answers on JTAG, so SWD is probably not wired/enabled on this board';
    }
  }
  return 'no JTAG answer either (TDO raw: ' + raw.trim() + ') - check wiring, GND and VTref';
}
