import native from './native';
import { b64decode, b64encode } from './util';

/**
 * Minimal J-Link USB protocol client (command bytes/framing follow libjaylink).
 * The native module does the raw bulk transfers.
 */
const CMD_GET_VERSION = 0x01;
const CMD_SET_SPEED = 0x05;
const CMD_GET_HW_STATUS = 0x07;
const CMD_SET_TARGET_POWER = 0x08;
const CMD_SELECT_TIF = 0xc7;
const CMD_SWD_IO = 0xcf;

export const TIF_SWD = 1;

/** The USB layer failed (probe reset, unplugged, endpoint stalled, power dip...). */
export class UsbError extends Error {}

/** Year from "J-Link ... compiled Aug 22 2012 19:52:04", or null if not found. */
/** On-board probes ("J-Link ARM-OB STM32", "J-Link OB-STM32F072" ...) share the board's USB power. */
export function isObProbe(version: string): boolean {
  return /(^|[^A-Za-z])OB([^A-Za-z]|$)/.test(version.split('compiled')[0]);
}

export function firmwareYear(version: string): number | null {
  const m = /compiled\s+\w+\s+\d+\s+(\d{4})/.exec(version);
  return m ? parseInt(m[1], 10) : null;
}

const hexs = (b: Uint8Array, max: number): string => {
  let s = '';
  for (let i = 0; i < Math.min(b.length, max); i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16) + ' ';
  return s.trim() + (b.length > max ? ' ...' : '');
};

export class JLink {
  /** If set, the first `traceLeft` exchanges are reported (for diagnosing odd probes). */
  onTrace: ((line: string) => void) | null = null;
  traceLeft = 40;

  // Connection registration (CMD_REGISTER): SEGGER's software registers with the probe and re-sends the registration
  // about every 3 s; a probe drops idle connections. Only used for on-board probes (see registerConnection()).
  private regFrame: number[] | null = null;
  private lastBeat = 0;
  private beating = false;

  private async tx(bytes: number[] | Uint8Array, expect: number): Promise<Uint8Array> {
    // Heartbeat only before a new command (data.length > 0), never between a command and its continuation read.
    if (bytes.length > 0) await this.maybeBeat();
    return this.txRaw(bytes, expect);
  }

  private async txRaw(bytes: number[] | Uint8Array, expect: number): Promise<Uint8Array> {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const t0 = Date.now();
    const tr = this.onTrace !== null && this.traceLeft > 0;
    if (tr) this.traceLeft--;
    try {
      const r = await native.transact(b64encode(data), expect);
      const out = expect === 0 ? new Uint8Array(0) : b64decode(r);
      if (tr) {
        this.onTrace!('> ' + hexs(data, 10) + ' (' + data.length + ' B)  < ' + hexs(out, 26) + ' (' + out.length + ' B)  ' + (Date.now() - t0) + ' ms');
      }
      return out;
    } catch (e) {
      const what = data.length > 0 ? 'cmd 0x' + data[0].toString(16) + ' (' + data.length + ' B out)' : 'read';
      throw new UsbError('J-Link ' + what + ', expecting ' + expect + ' B, after ' + (Date.now() - t0) + ' ms: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** Send one REGISTER frame and read its variable-length reply (12 + 16 * maxConnections bytes). */
  private async registerCall(frame: number[]): Promise<number | null> {
    const head = await this.txRaw(frame, 4);
    const max = head[2] | (head[3] << 8);
    if (max < 1 || max > 32) throw new Error('unexpected REGISTER reply (max connections ' + max + ')');
    const rest = await this.txRaw([], 8 + 16 * max);
    const all = new Uint8Array(head.length + rest.length);
    all.set(head, 0);
    all.set(rest, head.length);
    // Entries start at byte 8, 16 bytes each: pid(4) hid(4) iid(1) cid(1) handle(2) timestamp(4).
    for (let i = 0; i < max; i++) {
      const o = 8 + 16 * i;
      if (o + 12 <= all.length && all[o] === frame[2] && all[o + 1] === frame[3] && all[o + 2] === frame[4] && all[o + 3] === frame[5]) {
        return all[o + 10] | (all[o + 11] << 8);
      }
    }
    return null;
  }

  private async maybeBeat(): Promise<void> {
    if (this.regFrame === null || this.beating || Date.now() - this.lastBeat < 2500) return;
    this.beating = true;
    try {
      await this.registerCall(this.regFrame);
      this.lastBeat = Date.now();
    } finally {
      this.beating = false;
    }
  }

  /** The read-only queries SEGGER's software sends before registering (replayed byte for byte from a capture). */
  async seggerQueries(): Promise<void> {
    await this.txRaw([0xe8], 4); // capabilities
    await this.txRaw([0xed], 32); // extended capabilities
    await this.txRaw([0xe6], 256);
    await this.txRaw([0xf2], 256); // configuration
    await this.txRaw([0xf0], 4); // hardware version
    await this.txRaw([0x0d, 0x35, 0x3d, 0x01, 0x00], 4);
  }

  /**
   * Register this connection like SEGGER's software does: `09 64 pid(4) hid(4) iid cid handle(2)`, first with handle 0,
   * then again with the handle the probe assigned. The registration is then refreshed automatically every ~3 s.
   */
  async registerConnection(): Promise<void> {
    const pid = (((Math.floor(Math.random() * 0xfffe) << 16) | 0x6054) >>> 0);
    const frame = (handle: number): number[] => [
      0x09, 0x64, pid & 255, (pid >>> 8) & 255, (pid >>> 16) & 255, (pid >>> 24) & 255,
      0, 0, 0, 0, 0, 0, handle & 255, (handle >> 8) & 255,
    ];
    const handle = (await this.registerCall(frame(0))) ?? 1;
    await this.registerCall(frame(handle));
    this.regFrame = frame(handle);
    this.lastBeat = Date.now();
  }

  async getVersion(): Promise<string> {
    const l = await this.tx([CMD_GET_VERSION], 2);
    const len = l[0] | (l[1] << 8);
    if (len > 0x1000) throw new Error('bad version length ' + len);
    const s = await this.tx([], len);
    let str = '';
    for (let i = 0; i < s.length; i++) str += String.fromCharCode(s[i]);
    return str.replace(/[\u0000\r\n]+$/g, '');
  }

  /** VTref in mV, or null if the query failed. */
  async getTargetVoltageMv(): Promise<number | null> {
    try {
      const r = await this.tx([CMD_GET_HW_STATUS], 8);
      return r[0] | (r[1] << 8);
    } catch {
      return null;
    }
  }

  /** Bit mask of target interfaces (bit 1 = SWD), or null on old firmware. */
  async getAvailableInterfaces(): Promise<number | null> {
    try {
      const r = await this.tx([CMD_SELECT_TIF, 0xff], 4);
      return (r[0] | (r[1] << 8) | (r[2] << 16) | (r[3] << 24)) >>> 0;
    } catch {
      return null;
    }
  }

  async selectInterface(tif: number): Promise<void> {
    await this.tx([CMD_SELECT_TIF, tif], 4);
  }

  async setSpeedKhz(khz: number): Promise<void> {
    if (khz < 1 || khz > 0xfffe) throw new Error('bad speed');
    await this.tx([CMD_SET_SPEED, khz & 0xff, (khz >> 8) & 0xff], 0);
  }

  async setTargetPower(on: boolean): Promise<void> {
    await this.tx([CMD_SET_TARGET_POWER, on ? 1 : 0], 0);
  }

  /** Raw SWD bit I/O. Returns the sampled bits (LSB first). */
  async swdIo(dir: Uint8Array, out: Uint8Array, bits: number): Promise<Uint8Array> {
    if (bits < 1 || bits > 0xffff) throw new Error('bad bit count');
    const n = (bits + 7) >> 3;
    const msg = new Uint8Array(4 + 2 * n);
    msg[0] = CMD_SWD_IO;
    msg[1] = 0;
    msg[2] = bits & 0xff;
    msg[3] = (bits >> 8) & 0xff;
    msg.set(dir.subarray(0, n), 4);
    msg.set(out.subarray(0, n), 4 + n);
    const r = await this.tx(msg, n + 1);
    const status = r[n];
    if (status === 0x06) throw new Error('Probe out of memory for SWD batch');
    if (status !== 0) throw new Error('SWD I/O failed, status 0x' + status.toString(16));
    return r.subarray(0, n);
  }
}
