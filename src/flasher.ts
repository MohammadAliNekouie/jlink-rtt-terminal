import native from './native';
import { JLink, TIF_SWD, firmwareYear, isObProbe } from './jlink';
import { SwdDap, SwdError } from './swd';
import { detectChip } from './flash';
import type { FlashChip, Mem, Sector } from './flash';
import { Segment, imageSize } from './image';
import { haltCore, resetAndRun } from './target';
import { hex32, sleep } from './util';

export interface FlashConfig {
  speedKhz: number;
  targetPower: boolean;
  segments: Segment[];
  /** Reset and start the new firmware when done. */
  runAfter: boolean;
}

export interface FlashListener {
  log(line: string): void;
  /** fraction 0..1 and a short label */
  progress(fraction: number, label: string): void;
  ended(ok: boolean, message: string): void;
}

class Cancelled extends Error {}

const CHUNK_WORDS = 256; // 1 KB
const VERIFY_BYTES = 1024;
// Share of the progress bar for each phase.
const W_ERASE = 0.25;
const W_PROGRAM = 0.5;
const W_VERIFY = 0.25;

function wordsOf(d: Uint8Array, off: number, count: number): number[] {
  const w: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = off + i * 4;
    w[i] = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
  }
  return w;
}

/** Erase -> program -> verify -> run, using a direct flash-controller driver for the detected chip. */
export class FlashJob {
  private cancelled = false;
  private trace: string[] = [];

  constructor(private cfg: FlashConfig, private ui: FlashListener) {}

  cancel(): void {
    this.cancelled = true;
  }

  private check(): void {
    if (this.cancelled) throw new Cancelled('Cancelled by user');
  }

  async run(): Promise<void> {
    let ok = false;
    let msg = '';
    let chip: FlashChip | null = null;
    let mem: SwdDap | null = null;
    let touched = false; // flash was modified (or may have been)
    try {
      const devs = native.listDevices();
      if (devs.length === 0) throw new Error('No J-Link found (OTG cable? phone must act as USB host)');
      const name = devs[0].name;
      if (!(await native.requestPermission(name))) throw new Error('USB permission denied');
      await native.open(name);
      this.ui.log('USB: ' + native.describe());

      const dropped = native.flush();
      if (dropped > 0) this.ui.log('dropped ' + dropped + ' stale bytes from the probe');
      const jl = new JLink();
      jl.onTrace = (l) => this.trace.push(l);
      const version = await jl.getVersion();
      this.ui.log('Probe: ' + version);
      const ob = isObProbe(version);
      const year = firmwareYear(version);
      const oldFw = year !== null && year <= 2013;
      if (oldFw) this.ui.log('old probe firmware (' + year + '): skipping optional queries, limiting SWD to 1000 kHz');
      const avail = oldFw ? null : await jl.getAvailableInterfaces();
      if (avail !== null && (avail & (1 << TIF_SWD)) === 0) throw new Error('This probe does not offer SWD');
      await jl.selectInterface(TIF_SWD);
      let speed = oldFw ? Math.min(this.cfg.speedKhz, 1000) : this.cfg.speedKhz;
      await jl.setSpeedKhz(speed);
      if (this.cfg.targetPower && ob) {
        this.ui.log('on-board probe: 5V target power switch ignored (board is powered through the probe USB cable)');
      } else if (this.cfg.targetPower) {
        await jl.setTargetPower(true);
        await sleep(150);
      }
      const mv = await jl.getTargetVoltageMv();
      if (mv !== null) this.ui.log('VTref: ' + mv + ' mV');

      const dap = new SwdDap(jl);
      mem = dap;
      const speeds = [speed, 1000, 400, 100].filter((v, i, a) => v <= speed && a.indexOf(v) === i);
      for (let i = 0; i < speeds.length; i++) {
        this.check();
        try {
          if (i > 0) {
            speed = speeds[i];
            await jl.setSpeedKhz(speed);
            this.ui.log('Retrying SWD at ' + speed + ' kHz');
          }
          await dap.connect();
          break;
        } catch (e) {
          if (!(e instanceof SwdError) || i === speeds.length - 1) throw e;
          this.ui.log('SWD connect failed: ' + e.message);
        }
      }
      this.ui.log('SWD up, DPIDR=' + hex32(dap.dpidr) + ' at ' + speed + ' kHz');

      await haltCore(dap);
      this.ui.log('Core halted');

      chip = await detectChip(dap, { vtrefMv: mv, speedKhz: speed });
      this.ui.log('Detected ' + chip.name);

      const segs = this.cfg.segments;
      for (const s of segs) {
        if (s.addr < chip.flashStart || s.addr + s.data.length > chip.flashEnd) {
          throw new Error(
            'Image range ' + hex32(s.addr) + '..' + hex32(s.addr + s.data.length - 1) +
              ' is outside this chip\'s flash (' + hex32(chip.flashStart) + '..' + hex32(chip.flashEnd - 1) + ')',
          );
        }
      }

      // Unique sectors touched by the image.
      const sectors: Sector[] = [];
      const seen = new Set<number>();
      for (const s of segs) {
        let a = s.addr;
        const end = s.addr + s.data.length;
        while (a < end) {
          const sec = chip.sectorAt(a);
          if (!seen.has(sec.start)) {
            seen.add(sec.start);
            sectors.push(sec);
          }
          a = sec.start + sec.size;
        }
      }
      const eraseBytes = sectors.reduce((n, s) => n + s.size, 0);
      this.ui.log(
        'Image ' + imageSize(segs) + ' bytes in ' + segs.length + ' segment(s); erasing ' +
          sectors.length + ' sector(s), ' + eraseBytes + ' bytes',
      );

      await chip.unlock(dap);
      this.check();

      // ---- erase ----
      touched = true;
      let erased = 0;
      for (const sec of sectors) {
        this.check();
        this.ui.progress((erased / eraseBytes) * W_ERASE, 'Erasing ' + hex32(sec.start));
        await chip.eraseSector(dap, sec);
        erased += sec.size;
      }
      this.ui.progress(W_ERASE, 'Erase done');

      // ---- program ----
      const total = imageSize(segs);
      let written = 0;
      await chip.beginProgram(dap);
      try {
        for (const s of segs) {
          for (let off = 0; off < s.data.length; off += CHUNK_WORDS * 4) {
            this.check();
            const n = Math.min(CHUNK_WORDS, (s.data.length - off) >> 2);
            const words = wordsOf(s.data, off, n);
            if (!words.every((w) => w === 0xffffffff)) {
              await chip.program(dap, s.addr + off, words);
            }
            written += n * 4;
            this.ui.progress(W_ERASE + (written / total) * W_PROGRAM, 'Programming ' + hex32(s.addr + off));
          }
        }
      } finally {
        try {
          await chip.endProgram(dap);
        } catch {
          /* reported by the main error path if it matters */
        }
      }

      // ---- verify ----
      await chip.prepareVerify(dap);
      let verified = 0;
      for (const s of segs) {
        for (let off = 0; off < s.data.length; off += VERIFY_BYTES) {
          this.check();
          const len = Math.min(VERIFY_BYTES, s.data.length - off);
          const got = await dap.readBytes(s.addr + off, len);
          for (let i = 0; i < len; i++) {
            if (got[i] !== s.data[off + i]) {
              throw new Error(
                'Verify FAILED at ' + hex32(s.addr + off + i) + ': expected 0x' +
                  s.data[off + i].toString(16) + ', read 0x' + got[i].toString(16),
              );
            }
          }
          verified += len;
          this.ui.progress(W_ERASE + W_PROGRAM + (verified / total) * W_VERIFY, 'Verifying ' + hex32(s.addr + off));
        }
      }
      this.ui.log('Verify OK (' + total + ' bytes)');

      await chip.lock(dap);
      if (this.cfg.runAfter) {
        const started = await resetAndRun(dap, async () => {
          await dap.connect();
        });
        this.ui.log(started ? 'Reset done, new firmware running' : 'Reset sent (could not confirm run state)');
      } else {
        this.ui.log('Done (core left halted)');
      }
      this.ui.progress(1, 'Done');
      ok = true;
      msg = 'Firmware updated and verified';
    } catch (e) {
      for (const l of this.trace) this.ui.log('usb ' + l);
      const text = e instanceof Error ? e.message : String(e);
      msg = e instanceof Cancelled ? 'Cancelled' : 'Error: ' + text;
      if (touched) {
        msg += ' - flash may contain incomplete firmware; run the update again before using the board';
        if (chip && mem) {
          try {
            await chip.lock(mem);
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      try {
        native.close();
      } catch {
        /* ignore */
      }
      this.ui.ended(ok, msg);
    }
  }
}
