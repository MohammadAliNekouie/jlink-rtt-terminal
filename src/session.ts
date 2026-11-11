import native from './native';
import { JLink, TIF_SWD, UsbError, firmwareYear, isObProbe } from './jlink';
import { probeJtagIdcode } from './jtagdiag';
import { Rtt } from './rtt';
import { SwdDap, SwdError } from './swd';
import { hex32, sleep } from './util';

export interface Config {
  speedKhz: number;
  searchStart: number;
  searchSize: number;
  fixedAddr: number | null;
  targetPower: boolean;
}

export interface Listener {
  status(text: string): void;
  data(bytes: Uint8Array): void;
  /** One line of probe/USB diagnostics (shown on the USB page, not mixed into RTT output). */
  log(line: string): void;
  ended(reason: string): void;
}

/** One debug session: open probe -> SWD connect -> find RTT -> poll loop. */
export class Session {
  private running = true;
  private txq: Uint8Array[] = [];
  private jl: JLink | null = null;
  private startSpeed = 0;
  private jtagTried = false;
  private trace: string[] = [];

  constructor(private cfg: Config, private ui: Listener) {}

  send(bytes: Uint8Array): void {
    this.txq.push(bytes);
  }

  stop(): void {
    this.running = false;
  }

  async run(): Promise<void> {
    let reason = 'Disconnected';
    try {
      // A USB failure (probe reset, stalled endpoint, brown-out) is retried by reopening the probe from scratch.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.runOnce();
          break;
        } catch (e) {
          if (!(e instanceof UsbError) || !this.running || attempt >= 3) throw e;
          this.flushTrace();
          this.ui.status('USB error: ' + e.message + ' - reopening probe (' + attempt + '/3)');
          this.usbLog(e.message);
          this.usbLog('reopening probe (' + attempt + '/3)');
          try {
            native.close();
          } catch {
            /* ignore */
          }
          await sleep(1500);
        }
      }
    } catch (e) {
      reason = 'Error: ' + (e instanceof Error ? e.message : String(e));
      if (e instanceof UsbError) {
        this.flushTrace();
        reason += ' - the probe stopped responding. Unplug and replug it, then try again. If it repeats, see TESTING.md (probe firmware).';
      }
    } finally {
      try {
        native.close();
      } catch {
        /* ignore */
      }
      this.ui.ended(reason);
    }
  }

  /** Print (once) the first J-Link exchanges - only when something went wrong. */
  private flushTrace(): void {
    for (const l of this.trace) this.usbLog(l);
    this.trace = [];
  }

  /** What SEGGER's software does with an on-board probe before the first SWD frame: queries, then registration. */
  private async seggerStartup(jl: JLink): Promise<void> {
    try {
      await jl.seggerQueries();
      await jl.registerConnection();
      this.usbLog('on-board probe: registered like SEGGER software (heartbeat every ~3 s)');
    } catch (e) {
      this.usbLog('SEGGER-style registration failed: ' + (e instanceof Error ? e.message : String(e)));
      native.flush();
      if (e instanceof UsbError) throw e;
    }
  }

  private usbLog(line: string): void {
    this.ui.log('[usb] ' + line);
  }

  private async runOnce(): Promise<void> {
    {
      const devs = native.listDevices();
      if (devs.length === 0) throw new Error('No J-Link found (OTG cable? phone must act as USB host)');
      const name = devs[0].name;
      if (!(await native.requestPermission(name))) throw new Error('USB permission denied');
      await native.open(name);
      this.usbLog(native.describe());
      const dropped = native.flush();
      if (dropped > 0) this.usbLog('dropped ' + dropped + ' stale bytes from the probe');

      const jl = new JLink();
      this.jl = jl;
      this.trace = [];
      jl.onTrace = (l) => this.trace.push(l);
      const version = await jl.getVersion();
      this.ui.status('Probe: ' + version);
      this.usbLog('probe: ' + version);
      const ob = isObProbe(version);
      if (ob) await this.seggerStartup(jl);
      const year = firmwareYear(version);
      if (year !== null && year <= 2013) this.usbLog('note: old probe firmware (' + year + ')');
      const avail = await jl.getAvailableInterfaces();
      if (avail !== null && (avail & (1 << TIF_SWD)) === 0) throw new Error('This probe does not offer SWD');
      await jl.selectInterface(TIF_SWD);
      if (ob) await jl.setSpeedKhz(200); // SEGGER's software sets 200 kHz, then 100 kHz
      // SEGGER's own software connects to this kind of probe at 100 kHz.
      this.startSpeed = ob ? Math.min(this.cfg.speedKhz, 100) : this.cfg.speedKhz;
      if (ob && this.startSpeed < this.cfg.speedKhz) this.usbLog('on-board probe: SWD starts at ' + this.startSpeed + ' kHz');
      await jl.setSpeedKhz(this.startSpeed);
      if (this.cfg.targetPower && ob) {
        this.usbLog('on-board probe: 5V target power switch ignored (the board is powered through the probe USB cable)');
      } else if (this.cfg.targetPower) {
        await jl.setTargetPower(true);
        await sleep(150);
      }
      const mv = await jl.getTargetVoltageMv();
      if (ob) await jl.getTargetVoltageMv(); // SEGGER's software reads the status twice
      if (mv !== null && mv < 1000) this.ui.status('Warning: VTref only ' + mv + ' mV - target powered?');

      const dap = new SwdDap(jl);
      if (ob) dap.maxBits = 272; // the largest raw frame (34 bytes) SEGGER's software is seen sending to this probe
      const rtt = new Rtt(dap);
      await this.connectLoop(dap);
      if (!this.running) return;
      this.ui.status('SWD up, DPIDR=' + hex32(dap.dpidr) + ' (drive-bit=' + dap.hostDriveBit + ', offset=' + dap.sampleOffset + ')');

      let cb: number | null = this.cfg.fixedAddr;
      while (this.running && cb === null) {
        try {
          cb = await rtt.find(this.cfg.searchStart, this.cfg.searchSize, (off) => {
            this.ui.status('Searching RTT block... ' + hex32(this.cfg.searchStart + off));
            return this.running;
          });
        } catch (e) {
          if (!(e instanceof SwdError)) throw e;
          this.ui.status('Search error: ' + e.message);
        }
        if (cb === null && this.running) {
          this.ui.status('RTT control block not found - firmware not started? retrying');
          await sleep(1000);
        }
      }
      if (!this.running || cb === null) return;

      await this.attachLoop(rtt, cb);
      let idle = 0;
      let failures = 0;
      while (this.running) {
        try {
          let busy = false;
          const d = await rtt.readUp();
          if (d.length > 0) {
            this.ui.data(d);
            busy = true;
          }
          const pend = this.txq.shift();
          if (pend) {
            let off = 0;
            let spins = 0;
            while (off < pend.length && this.running && spins < 300) {
              const n = await rtt.writeDown(pend, off);
              if (n === 0) {
                spins++;
                await sleep(10);
              } else off += n;
            }
            if (off < pend.length) this.ui.status('Down buffer full - input dropped');
            busy = true;
          }
          failures = 0;
          if (busy) idle = 0;
          else await sleep(++idle > 50 ? 20 : 5);
        } catch (e) {
          if (!(e instanceof SwdError)) throw e;
          if (++failures > 20) throw e;
          this.ui.status('Link error: ' + e.message + ' - reconnecting (#' + failures + ')');
          await sleep(300);
          await this.connectLoop(dap);
          await this.attachLoop(rtt, cb);
        }
      }
    }
  }

  private async connectLoop(dap: SwdDap): Promise<void> {
    // Try the configured speed first, then progressively slower ones (OB probes / long wires often need this).
    const speeds = [this.startSpeed, 1000, 400, 100].filter(
      (v, i, a) => v <= this.startSpeed && a.indexOf(v) === i,
    );
    let si = 0;
    let tries = 0;
    while (this.running) {
      try {
        await dap.connect();
        return;
      } catch (e) {
        if (!(e instanceof SwdError)) throw e;
        tries++;
        this.ui.status('SWD connect failed: ' + e.message);
        if (tries <= 2) {
          this.flushTrace();
          this.usbLog('SWD connect failed: ' + e.message);
        }
        if (tries === 2 && !this.jtagTried && this.jl) {
          // One-time diagnostic: does the target answer on JTAG? (restores SWD afterwards)
          this.jtagTried = true;
          try {
            this.usbLog(await probeJtagIdcode(this.jl));
          } catch (je) {
            this.usbLog('JTAG probe failed: ' + (je instanceof Error ? je.message : String(je)));
          }
          try {
            await this.jl.selectInterface(TIF_SWD);
          } catch {
            /* ignore */
          }
        }
        if (tries >= speeds.length * 2) throw e;
        if (tries % 2 === 0 && si + 1 < speeds.length && this.jl) {
          si++;
          try {
            await this.jl.setSpeedKhz(speeds[si]);
            this.ui.status('Retrying SWD at ' + speeds[si] + ' kHz');
          } catch {
            /* probe may refuse this speed; keep going */
          }
        }
        await sleep(500);
      }
    }
  }

  private async attachLoop(rtt: Rtt, cb: number): Promise<void> {
    while (this.running) {
      try {
        this.ui.status(await rtt.attach(cb));
        return;
      } catch (e) {
        if (!(e instanceof SwdError)) throw e;
        this.ui.status('Waiting for RTT init: ' + e.message);
        await sleep(500);
      }
    }
  }
}
