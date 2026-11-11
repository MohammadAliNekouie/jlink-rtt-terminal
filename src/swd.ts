import { JLink } from './jlink';
import { BitVec, popcount32, sleep } from './util';

/** Link-level problem (no ACK, FAULT, retries exhausted). The session may recover by reconnecting. */
export class SwdError extends Error {}

export const ACK_OK = 1;
export const ACK_WAIT = 2;
export const ACK_FAULT = 4;

const DP_DPIDR = 0x0;
const DP_ABORT = 0x0;
const DP_CTRLSTAT = 0x4;
const DP_SELECT = 0x8;
const DP_RDBUFF = 0xc;
const AP_CSW = 0x0;
const AP_TAR = 0x4;
const AP_DRW = 0xc;
// 32-bit, single auto-increment, DbgSwEnable | Master type | HProt
const CSW_VALUE = 0xa2000012;
// same, but 16-bit transfers (for flash controllers that only accept halfword programming, e.g. STM32F1)
const CSW_HALF = 0xa2000011;

const IDLE_BITS = 8;
const MAX_BITS = 2048;
const MAX_READ_WORDS = 16;
const MAX_WRITE_WORDS = 16;

interface Result {
  ack: number[];
  data: number[];
  parityOk: boolean[];
}

class Batch {
  dir = new BitVec(MAX_BITS);
  out = new BitVec(MAX_BITS);
  txns: { start: number; read: boolean }[] = [];

  constructor(private dap: SwdDap) {}

  private dirBit(hostDrives: boolean): number {
    return hostDrives === (this.dap.hostDriveBit === 1) ? 1 : 0;
  }

  /** Phase of n (<= 32) bits. Input phases put zeros on the wire (ignored by the probe). */
  private phase(hostDrives: boolean, value: number, n: number): void {
    this.dir.fill(this.dirBit(hostDrives), n);
    if (hostDrives) this.out.put(value, n);
    else this.out.fill(0, n);
  }

  private ones(n: number): void {
    this.dir.fill(this.dirBit(true), n);
    this.out.fill(1, n);
  }

  /** Extra idle clocks (host drives low), e.g. to give a slow flash controller time between writes. */
  pad(bits: number): void {
    let left = bits;
    while (left > 0) {
      const n = Math.min(left, 32);
      this.phase(true, 0, n);
      left -= n;
    }
  }

  /**
   * Longer startup used by SEGGER's own software on an on-board J-Link (seen in a capture):
   * reset, JTAG->SWD (0xE79E), reset, 0xEDB6, reset, 16 idle clocks. Tried as a fallback when the standard one gets no answer.
   */
  lineResetAndSwitchLong(): void {
    this.ones(56);
    this.phase(true, 0xe79e, 16);
    this.ones(56);
    this.phase(true, 0xedb6, 16);
    this.ones(56);
    this.phase(true, 0, 16);
  }

  lineResetAndSwitch(): void {
    this.ones(56);              // >= 50 clocks high
    this.phase(true, 0xe79e, 16); // JTAG -> SWD select sequence
    this.ones(56);              // line reset
    this.phase(true, 0, IDLE_BITS);
  }

  private request(ap: boolean, read: boolean, reg: number): number {
    const apBit = ap ? 1 : 0;
    const rw = read ? 1 : 0;
    const a2 = (reg >> 2) & 1;
    const a3 = (reg >> 3) & 1;
    const parity = (apBit + rw + a2 + a3) & 1;
    return 1 | (apBit << 1) | (rw << 2) | (a2 << 3) | (a3 << 4) | (parity << 5) | (1 << 7);
  }

  read(ap: boolean, reg: number): number {
    const idx = this.txns.length;
    this.txns.push({ start: this.out.size, read: true });
    this.phase(true, this.request(ap, true, reg), 8);
    this.phase(false, 0, 1);  // turnaround
    this.phase(false, 0, 3);  // ACK
    this.phase(false, 0, 32); // data
    this.phase(false, 0, 1);  // parity
    this.phase(false, 0, 1);  // turnaround
    this.phase(true, 0, IDLE_BITS);
    return idx;
  }

  write(ap: boolean, reg: number, value: number): void {
    this.txns.push({ start: this.out.size, read: false });
    this.phase(true, this.request(ap, false, reg), 8);
    this.phase(false, 0, 1);  // turnaround
    this.phase(false, 0, 3);  // ACK
    this.phase(false, 0, 1);  // turnaround
    this.phase(true, value >>> 0, 32);
    this.phase(true, popcount32(value) & 1, 1);
    this.phase(true, 0, IDLE_BITS);
  }

  async run(jl: JLink): Promise<Result> {
    const bits = this.out.size;
    const inBytes = await jl.swdIo(this.dir.bytes, this.out.bytes, bits);
    const inv = new BitVec(inBytes);
    const off = this.dap.sampleOffset;
    const ack: number[] = [];
    const data: number[] = [];
    const parityOk: boolean[] = [];
    for (const t of this.txns) {
      ack.push(inv.get(t.start + 9 + off, 3));
      if (t.read) {
        const d = inv.get(t.start + 12 + off, 32);
        const p = inv.get(t.start + 44 + off, 1);
        data.push(d);
        parityOk.push((popcount32(d) & 1) === p);
      } else {
        data.push(0);
        parityOk.push(true);
      }
    }
    return { ack, data, parityOk };
  }
}

/** Minimal ADIv5 over SWD: DP power-up and MEM-AP 0 word access (Cortex-M), batched. */
export class SwdDap {
  /** Value of a "direction" bit meaning "host drives SWDIO". Auto-detected in connect(). */
  /**
   * Largest raw SWD_IO frame (bits) used for memory access. 2048 is fine for current probes; an old on-board probe is
   * only known to handle 34-byte frames (272 bits) - set this lower for it.
   */
  maxBits = MAX_BITS;
  hostDriveBit = 1;
  /** Shift (in bits) between where the request/ACK/data are expected in the J-Link input stream and where they
   *  actually arrive. Auto-calibrated in connect(). */
  sampleOffset = 0;
  dpidr = 0;

  constructor(private jl: JLink) {}

  private async clearSticky(): Promise<void> {
    const b = new Batch(this);
    b.write(false, DP_ABORT, 0x1e);
    await b.run(this.jl);
  }

  private async runChecked(b: Batch): Promise<Result> {
    let last = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await b.run(this.jl);
      let bad = -1;
      for (let i = 0; i < r.ack.length; i++) {
        if (r.ack[i] !== ACK_OK || !r.parityOk[i]) {
          bad = i;
          break;
        }
      }
      if (bad < 0) return r;
      const ack = r.ack[bad];
      if (ack === ACK_WAIT) {
        last = 'WAIT';
        await sleep(2);
      } else if (ack === ACK_FAULT) {
        await this.clearSticky();
        throw new SwdError('SWD FAULT (bus error / invalid address / debug domain off)');
      } else if (ack === ACK_OK) {
        last = 'parity error';
      } else {
        throw new SwdError(
          'No SWD ACK (0x' + ack.toString(16) + '): check wiring, VTref and target power',
        );
      }
    }
    await this.clearSticky();
    throw new SwdError('SWD retries exhausted (' + last + ')');
  }

  /** Line reset, read DPIDR, power up the debug domain, set up MEM-AP 0. */
  async connect(): Promise<number> {
    let ok = false;
    let lastAck = 0;
    const dumps: string[] = [];
    let silent = false;
    const OFFSETS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8];
    // Attempts: 0 standard startup, 1 long startup (host-drive bit = 1), then both again with the opposite polarity.
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      const long = (attempt & 1) === 1;
      this.hostDriveBit = attempt < 2 ? 1 : 0;
      const b = new Batch(this);
      if (long) b.lineResetAndSwitchLong();
      else b.lineResetAndSwitch();
      const i = b.read(false, DP_DPIDR);
      const start = b.txns[i].start;
      const bits = b.out.size;
      const inBytes = await this.jl.swdIo(b.dir.bytes, b.out.bytes, bits);
      const inv = new BitVec(inBytes);
      if (dumps.length < 2) {
        // The DPIDR transaction as sampled: request(8) TRN ACK(3) data(32) parity ... (LSB first, 16-bit groups)
        const raw = inv.get(start, 16).toString(16).padStart(4, '0') + ' ' +
          inv.get(start + 16, 16).toString(16).padStart(4, '0') + ' ' +
          inv.get(start + 32, 16).toString(16).padStart(4, '0') + ' ' +
          inv.get(start + 48 > bits - 8 ? bits - 8 : start + 48, 8).toString(16).padStart(2, '0');
        dumps.push((long ? 'long' : 'std') + '/drive' + this.hostDriveBit + ': ' + raw);
      }
      // The line stayed high after the request: the target is simply not driving SWDIO.
      if (inv.get(start + 9, 3) === 7 && inv.get(start + 12, 32) === 0xffffffff) silent = true;
      // The target's DPIDR must come back as: ACK=OK, data with bit0 = 1 (RAO), valid parity.
      // The window must start after the request (some probes echo the host-driven bits, which can fake an answer).
      for (const off of OFFSETS) {
        if (off < -1) continue;
        const a0 = start + 9 + off;
        if (a0 < 0 || start + 45 + off >= bits) continue;
        const ack = inv.get(a0, 3);
        lastAck = lastAck || ack;
        if (ack !== ACK_OK) continue;
        const d = inv.get(start + 12 + off, 32);
        const p = inv.get(start + 44 + off, 1);
        if ((popcount32(d) & 1) !== p) continue;
        if ((d & 1) !== 1 || d === 0xffffffff) continue;
        // Far offsets need the unmistakable Arm DPIDR signature (designer 0x23B -> low 12 bits 0x477).
        if (off > 3 && (d & 0xfff) !== 0x477) continue;
        this.sampleOffset = off;
        this.dpidr = d;
        ok = true;
        break;
      }
    }
    if (!ok) {
      this.hostDriveBit = 1;
      throw new SwdError(
        (silent
          ? 'Target not answering on SWD: SWDIO stays high after the request'
          : 'No SWD response (ack=0x' + lastAck.toString(16) + ')') +
          '. Raw in-bits: ' + dumps.join(' ; ') +
          '. Check SWDIO/SWCLK/GND, VTref and target power, and that the target really has SWD wired/enabled (JTAG-only boards do not answer).',
      );
    }

    const init = new Batch(this);
    init.write(false, DP_ABORT, 0x1e);          // clear sticky flags
    init.write(false, DP_SELECT, 0);            // APSEL 0, bank 0
    init.write(false, DP_CTRLSTAT, 0x50000000); // CDBGPWRUPREQ | CSYSPWRUPREQ
    await this.runChecked(init);

    let powered = false;
    for (let k = 0; k < 50; k++) {
      const b = new Batch(this);
      const i = b.read(false, DP_CTRLSTAT);
      const r = await this.runChecked(b);
      if (((r.data[i] & 0xa0000000) >>> 0) === 0xa0000000) {
        powered = true;
        break;
      }
      await sleep(5);
    }
    if (!powered) throw new SwdError('Debug domain did not power up');

    const csw = new Batch(this);
    csw.write(true, AP_CSW, CSW_VALUE);
    await this.runChecked(csw);
    return this.dpidr;
  }

  /** Words per read/write batch that fit in maxBits (TAR write + RDBUFF flush + one 54-bit transaction per word). */
  private wordsPerBatch(): number {
    return Math.max(1, Math.floor((this.maxBits - 2 * 54) / 54));
  }

  async readWords(addr: number, count: number): Promise<number[]> {
    const result: number[] = new Array(count).fill(0);
    let done = 0;
    while (done < count) {
      const a = addr + done * 4;
      const toBoundary = (0x400 - (a & 0x3ff)) >> 2; // TAR auto-increment only guaranteed within 1 KB
      const n = Math.min(count - done, MAX_READ_WORDS, this.wordsPerBatch(), toBoundary);
      const b = new Batch(this);
      b.write(true, AP_TAR, a);
      const idx: number[] = [];
      for (let k = 0; k < n; k++) idx.push(b.read(true, AP_DRW));
      const last = b.read(false, DP_RDBUFF);
      const r = await this.runChecked(b);
      // AP reads are posted: read k returns word k-1; RDBUFF returns the final word.
      for (let k = 0; k < n - 1; k++) result[done + k] = r.data[idx[k + 1]];
      result[done + n - 1] = r.data[last];
      done += n;
    }
    return result;
  }

  async writeWords(addr: number, words: number[]): Promise<void> {
    let done = 0;
    while (done < words.length) {
      const a = addr + done * 4;
      const toBoundary = (0x400 - (a & 0x3ff)) >> 2;
      const n = Math.min(words.length - done, MAX_WRITE_WORDS, this.wordsPerBatch(), toBoundary);
      const b = new Batch(this);
      b.write(true, AP_TAR, a);
      for (let k = 0; k < n; k++) b.write(true, AP_DRW, words[done + k]);
      b.read(false, DP_RDBUFF); // flush + surface errors
      await this.runChecked(b);
      done += n;
    }
  }

  /**
   * Like writeWords(), but inserts `padBits` idle clocks after every word and does no posted-read flush.
   * Used for flash controllers that stall the bus while programming: the pad keeps the DP from answering
   * WAIT in the middle of a batch (a retried batch would otherwise reprogram words).
   */
  async writeWordsPaced(addr: number, words: number[], padBits: number): Promise<void> {
    const pad = Math.max(0, Math.min(Math.floor(padBits), 1500));
    const perWord = 54 + pad; // 8 req + 1 trn + 3 ack + 1 trn + 32 data + 1 parity + IDLE_BITS + pad
    const maxWords = Math.max(1, Math.floor((this.maxBits - 54) / perWord));
    let done = 0;
    while (done < words.length) {
      const a = addr + done * 4;
      const toBoundary = (0x400 - (a & 0x3ff)) >> 2;
      const n = Math.min(words.length - done, maxWords, toBoundary);
      const b = new Batch(this);
      b.write(true, AP_TAR, a);
      for (let k = 0; k < n; k++) {
        b.write(true, AP_DRW, words[done + k]);
        b.pad(pad);
      }
      await this.runChecked(b);
      done += n;
    }
  }

  /**
   * Paced 16-bit writes (STM32F0/F1/F3 flash programs one halfword at a time). Switches the MEM-AP to
   * halfword transfers for the duration of each batch and always puts it back to 32-bit.
   */
  async writeHalfwordsPaced(addr: number, hws: number[], padBits: number): Promise<void> {
    if ((addr & 1) !== 0) throw new SwdError('Unaligned halfword write');
    const pad = Math.max(0, Math.min(Math.floor(padBits), 1500));
    const perHw = 54 + pad;
    const maxN = Math.max(1, Math.floor((this.maxBits - 3 * 54) / perHw)); // CSW, TAR, CSW restore
    let done = 0;
    let first = true;
    while (done < hws.length) {
      const a = addr + done * 2;
      const toBoundary = (0x400 - (a & 0x3ff)) >> 1;
      const n = Math.min(hws.length - done, maxN, toBoundary);
      const last = done + n >= hws.length;
      const b = new Batch(this);
      if (first) b.write(true, AP_CSW, CSW_HALF); // 16-bit mode is set once per call ...
      b.write(true, AP_TAR, a);
      for (let k = 0; k < n; k++) {
        const lane = ((a + 2 * k) & 2) * 8; // halfword rides on byte lanes 0-1 or 2-3
        b.write(true, AP_DRW, ((hws[done + k] & 0xffff) << lane) >>> 0);
        b.pad(pad);
      }
      if (last) b.write(true, AP_CSW, CSW_VALUE); // ... and restored once at the end
      try {
        await this.runChecked(b);
      } catch (e) {
        try {
          const r = new Batch(this);
          r.write(true, AP_CSW, CSW_VALUE);
          await this.runChecked(r);
        } catch {
          /* link is gone; connect() restores CSW */
        }
        throw e;
      }
      first = false;
      done += n;
    }
  }

  /** Drop the debug power-up request so the chip no longer sees a connected debugger. Errors are ignored. */
  async powerDown(): Promise<void> {
    try {
      const b = new Batch(this);
      b.write(false, DP_CTRLSTAT, 0);
      await this.runChecked(b);
    } catch {
      /* the chip may already have reset */
    }
  }

  writeWord(addr: number, value: number): Promise<void> {
    return this.writeWords(addr, [value]);
  }

  private static wordsToBytes(w: number[]): Uint8Array {
    const out = new Uint8Array(w.length * 4);
    for (let i = 0; i < w.length; i++) {
      out[i * 4] = w[i] & 0xff;
      out[i * 4 + 1] = (w[i] >>> 8) & 0xff;
      out[i * 4 + 2] = (w[i] >>> 16) & 0xff;
      out[i * 4 + 3] = (w[i] >>> 24) & 0xff;
    }
    return out;
  }

  async readBytes(addr: number, len: number): Promise<Uint8Array> {
    if (len <= 0) return new Uint8Array(0);
    const start = addr & ~3;
    const end = (addr + len + 3) & ~3;
    const w = await this.readWords(start, (end - start) >> 2);
    return SwdDap.wordsToBytes(w).slice(addr - start, addr - start + len);
  }

  /** Byte write via aligned read-modify-write of the covering words. */
  async writeBytes(addr: number, data: Uint8Array): Promise<void> {
    if (data.length === 0) return;
    const start = addr & ~3;
    const end = (addr + data.length + 3) & ~3;
    const w = await this.readWords(start, (end - start) >> 2);
    const buf = SwdDap.wordsToBytes(w);
    buf.set(data, addr - start);
    const out: number[] = [];
    for (let i = 0; i < buf.length; i += 4) {
      out.push((buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0);
    }
    await this.writeWords(start, out);
  }
}
