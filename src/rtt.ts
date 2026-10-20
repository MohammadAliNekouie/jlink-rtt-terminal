import { SwdDap, SwdError } from './swd';
import { hex32 } from './util';

/**
 * SEGGER RTT host side (32-bit targets).
 * Control block: char id[16]="SEGGER RTT", i32 maxUp, i32 maxDown, then up-buffers then down-buffers,
 * each {name*, buf*, size, wrOff, rdOff, flags} = 24 bytes.
 */
const W0 = 0x47474553; // "SEGG"
const W1 = 0x52205245; // "ER R"
const W2 = 0x00005454; // "TT\0\0"
const DESC = 24;
const MAX_POLL_BYTES = 4096;
const EMPTY = new Uint8Array(0);

export class Rtt {
  private upAddr = 0;
  private upBuf = 0;
  private upSize = 0;
  private downAddr = 0;
  private downBuf = 0;
  private downSize = 0;

  constructor(private dap: SwdDap) {}

  /** Scan `size` bytes from `start`. `progress` returns false to cancel. */
  async find(start: number, size: number, progress: (offset: number) => boolean): Promise<number | null> {
    const base = start & ~3;
    const words = size >> 2;
    let w = 0;
    while (w < words) {
      if (!progress(w * 4)) return null;
      const n = Math.min(256 + 4, words - w);
      const a = base + w * 4;
      let data: number[];
      try {
        data = await this.dap.readWords(a, n);
      } catch (e) {
        if (e instanceof SwdError) {
          w += 256; // unmapped/faulting region: skip it
          continue;
        }
        throw e;
      }
      for (let i = 0; i + 3 < n; i++) {
        if (data[i] === W0 && data[i + 1] === W1 && data[i + 2] === W2 && data[i + 3] === 0) {
          return a + i * 4;
        }
      }
      w += 256;
    }
    return null;
  }

  async attach(cb: number): Promise<string> {
    const h = await this.dap.readWords(cb, 6);
    if (h[0] !== W0 || h[1] !== W1 || h[2] !== W2) {
      throw new SwdError('No RTT control block at ' + hex32(cb));
    }
    const maxUp = h[4] | 0;
    const maxDown = h[5] | 0;
    if (maxUp < 1 || maxUp > 32 || maxDown < 0 || maxDown > 32) {
      throw new SwdError('RTT control block not initialised yet (up=' + maxUp + ' down=' + maxDown + ')');
    }
    this.upAddr = cb + 24;
    this.downAddr = this.upAddr + maxUp * DESC;
    const u = await this.dap.readWords(this.upAddr, 6);
    this.upBuf = u[1];
    this.upSize = u[2];
    if (this.upSize < 1 || this.upSize > 0x100000 || this.upBuf === 0) {
      throw new SwdError('RTT up buffer 0 not configured yet');
    }
    this.downSize = 0;
    if (maxDown > 0) {
      const d = await this.dap.readWords(this.downAddr, 6);
      if (d[2] >= 1 && d[2] <= 0x100000 && d[1] !== 0) {
        this.downBuf = d[1];
        this.downSize = d[2];
      }
    }
    return (
      'RTT @' + hex32(cb) + ': up0=' + this.upSize + ' B, down0=' +
      (this.downSize > 0 ? this.downSize + ' B' : 'none')
    );
  }

  /** Drain pending bytes from up-buffer 0. */
  async readUp(): Promise<Uint8Array> {
    const [wr, rd] = await this.dap.readWords(this.upAddr + 12, 2);
    if (wr === rd) return EMPTY;
    if (wr >= this.upSize) return EMPTY;
    if (rd >= this.upSize) {
      await this.dap.writeWord(this.upAddr + 16, wr); // resync
      return EMPTY;
    }
    const avail = wr > rd ? wr - rd : this.upSize - rd + wr;
    const take = Math.min(avail, MAX_POLL_BYTES);
    const first = Math.min(take, this.upSize - rd);
    const out = new Uint8Array(take);
    out.set(await this.dap.readBytes(this.upBuf + rd, first), 0);
    if (take > first) out.set(await this.dap.readBytes(this.upBuf, take - first), first);
    await this.dap.writeWord(this.upAddr + 16, (rd + take) % this.upSize);
    return out;
  }

  /** Write as much of data[off..] as fits into down-buffer 0; returns bytes consumed. */
  async writeDown(data: Uint8Array, off: number): Promise<number> {
    if (this.downSize === 0) return data.length - off; // no down channel: drop
    const [wr, rd] = await this.dap.readWords(this.downAddr + 12, 2);
    if (wr >= this.downSize || rd >= this.downSize) return 0;
    const free = rd > wr ? rd - wr - 1 : this.downSize - (wr - rd) - 1;
    const n = Math.min(free, data.length - off);
    if (n <= 0) return 0;
    const first = Math.min(n, this.downSize - wr);
    await this.dap.writeBytes(this.downBuf + wr, data.subarray(off, off + first));
    if (n > first) await this.dap.writeBytes(this.downBuf, data.subarray(off + first, off + n));
    await this.dap.writeWord(this.downAddr + 12, (wr + n) % this.downSize);
    return n;
  }
}
