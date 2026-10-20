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

export class JLink {
  private async tx(bytes: number[] | Uint8Array, expect: number): Promise<Uint8Array> {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const r = await native.transact(b64encode(data), expect);
    return expect === 0 ? new Uint8Array(0) : b64decode(r);
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
