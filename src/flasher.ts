import native from './native';
import { JLink, TIF_SWD, UsbError, firmwareYear, isObProbe } from './jlink';
import { SwdDap, SwdError } from './swd';
import { detectChip, detectProtector } from './flash';
import type { FlashChip, Mem, Protector, Sector } from './flash';
import { Segment, imageSize } from './image';
import { haltCore, resetAndRelease, resetAndRun } from './target';
import { hex32, sleep } from './util';

export interface FlashConfig {
  speedKhz: number;
  targetPower: boolean;
  segments: Segment[];
  /** Reset and start the new firmware when done. */
  runAfter: boolean;
  /** After a verified write, set read-out protection level 1 (the chip then refuses debuggers until it is mass-erased). */
  protect?: boolean;
}

export interface FlashListener {
  log(line: string): void;
  /** fraction 0..1 and a short label */
  progress(fraction: number, label: string): void;
  ended(ok: boolean, message: string): void;
}

class Cancelled extends Error {}

/** Things learned about the attached probe during this app run (so a retry does not repeat a failing experiment). */
export const probeQuirks = { bigFramesBad: false };

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

  /** After a slow connect, try the selected speed (then slower steps) and keep the first that reads reliably. */
  private async raiseSpeed(jl: JLink, dap: SwdDap, from: number, want: number): Promise<number> {
    const ladder = [want, 1000, 400, 200].filter((v, i, a) => v > from && v <= want && a.indexOf(v) === i);
    for (const khz of ladder) {
      this.check();
      try {
        await jl.setSpeedKhz(khz);
        let first: number | null = null;
        for (let k = 0; k < 3; k++) {
          const cpuid = (await dap.readWords(0xe000ed00, 1))[0]; // CPUID: constant, never 0 or all ones
          if (cpuid === 0 || cpuid === 0xffffffff || (first !== null && cpuid !== first)) throw new SwdError('unstable read');
          first = cpuid;
        }
        this.ui.log('SWD speed raised to ' + khz + ' kHz');
        return khz;
      } catch (e) {
        if (e instanceof UsbError) throw e;
        this.ui.log('SWD at ' + khz + ' kHz is not reliable (' + (e instanceof Error ? e.message : String(e)) + ')');
        await jl.setSpeedKhz(from); // back to the speed that connected, and bring the link back in sync
        await dap.connect();
      }
    }
    this.ui.log('staying at ' + from + ' kHz');
    return from;
  }

  /**
   * An on-board probe is only known to take 34-byte frames. Before erasing anything, read the same flash words with
   * larger frames and keep a size only if the data is identical.
   */
  private async growFrames(dap: SwdDap, addr: number): Promise<void> {
    if (probeQuirks.bigFramesBad) return;
    const n = 48;
    const small = await dap.readWords(addr, n);
    for (const bits of [544, 972]) {
      const prev = dap.maxBits;
      dap.maxBits = bits;
      try {
        const big = await dap.readWords(addr, n);
        if (big.some((w, i) => w !== small[i])) throw new SwdError('read-back differs');
        this.ui.log('USB frames raised to ' + bits + ' bits');
      } catch (e) {
        dap.maxBits = prev;
        probeQuirks.bigFramesBad = true;
        if (e instanceof UsbError) throw e; // the probe may need a replug; do not keep experimenting
        this.ui.log('larger frames are not reliable (' + (e instanceof Error ? e.message : String(e)) + '), staying at ' + prev + ' bits');
        await dap.connect();
        return;
      }
    }
  }

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
    let protector: Protector | null = null;
    let protectStarted = false; // option bytes may be half-written
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
      if (ob) {
        try {
          await jl.seggerQueries();
          await jl.registerConnection();
          this.ui.log('on-board probe: registered like SEGGER software (heartbeat every ~3 s)');
        } catch (e) {
          this.ui.log('SEGGER-style registration failed: ' + (e instanceof Error ? e.message : String(e)));
          native.flush();
          if (e instanceof UsbError) throw e;
        }
      }
      const year = firmwareYear(version);
      if (year !== null && year <= 2013) this.ui.log('note: old probe firmware (' + year + ')');
      const avail = await jl.getAvailableInterfaces();
      if (avail !== null && (avail & (1 << TIF_SWD)) === 0) throw new Error('This probe does not offer SWD');
      await jl.selectInterface(TIF_SWD);
      let speed = ob ? Math.min(this.cfg.speedKhz, 100) : this.cfg.speedKhz;
      if (ob && speed < this.cfg.speedKhz) this.ui.log('on-board probe: SWD starts at ' + speed + ' kHz');
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
      if (ob) dap.maxBits = 272; // the largest raw frame (34 bytes) SEGGER's software is seen sending to this probe
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

      // An on-board probe has to connect at 100 kHz; for programming use the speed selected in the app.
      if (ob && speed < this.cfg.speedKhz) speed = await this.raiseSpeed(jl, dap, speed, this.cfg.speedKhz);

      await haltCore(dap);
      this.ui.log('Core halted');

      chip = await detectChip(dap, { vtrefMv: mv, speedKhz: speed });
      this.ui.log('Detected ' + chip.name);
      if (ob) await this.growFrames(dap, chip.flashStart);
      if (this.cfg.protect) {
        // Decide before anything is erased: refuse if this chip family cannot be protected.
        protector = await detectProtector(dap);
        if (!protector) {
          throw new Error('Read-out protection is only supported for STM32 F0/F1/F2/F3/F4 here - switch "Protect" off for this chip');
        }
        if (await protector.isProgrammed(dap)) this.ui.log('note: read-out protection is already programmed on this chip');
        this.ui.log('Read-out protection (RDP level 1) will be set after programming: ' + protector.name);
      }

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
      if (protector) {
        this.ui.log('Setting read-out protection (RDP level 1) ...');
        protectStarted = true;
        await protector.protect(dap, { vtrefMv: mv, speedKhz: speed });
        protectStarted = false;
        this.ui.log('RDP level 1 programmed and read back. It becomes active after the next reset / power cycle.');
        await resetAndRelease(dap, () => dap.powerDown());
        this.ui.log('Debug port released. Power-cycle the board now. Do NOT attach a debugger afterwards: a protected chip faults when one connects (by design).');
        this.ui.progress(1, 'Done');
        ok = true;
        msg = 'Firmware updated, verified and read-out protected (RDP 1) - power-cycle the board';
      } else if (this.cfg.runAfter) {
        const started = await resetAndRun(dap, async () => {
          await dap.connect();
        });
        this.ui.log(started ? 'Reset done, new firmware running' : 'Reset sent (could not confirm run state)');
      } else {
        this.ui.log('Done (core left halted)');
      }
      if (!protector) {
        this.ui.progress(1, 'Done');
        ok = true;
        msg = 'Firmware updated and verified';
      }
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
      if (protectStarted) {
        msg += ' - the option bytes may be half-written: the chip can be read-protected without your settings. ' +
          'Remove protection with STM32CubeProgrammer (RDP level 0, erases the chip) and flash again';
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
