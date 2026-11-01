import native from './native';
import { JLink, TIF_SWD } from './jlink';
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
  ended(reason: string): void;
}

/** One debug session: open probe -> SWD connect -> find RTT -> poll loop. */
export class Session {
  private running = true;
  private txq: Uint8Array[] = [];

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
      const devs = native.listDevices();
      if (devs.length === 0) throw new Error('No J-Link found (OTG cable? phone must act as USB host)');
      const name = devs[0].name;
      if (!(await native.requestPermission(name))) throw new Error('USB permission denied');
      await native.open(name);

      const jl = new JLink();
      this.ui.status('Probe: ' + (await jl.getVersion()));
      const avail = await jl.getAvailableInterfaces();
      if (avail !== null && (avail & (1 << TIF_SWD)) === 0) throw new Error('This probe does not offer SWD');
      await jl.selectInterface(TIF_SWD);
      await jl.setSpeedKhz(this.cfg.speedKhz);
      if (this.cfg.targetPower) {
        await jl.setTargetPower(true);
        await sleep(150);
      }
      const mv = await jl.getTargetVoltageMv();
      if (mv !== null && mv < 1000) this.ui.status('Warning: VTref only ' + mv + ' mV - target powered?');

      const dap = new SwdDap(jl);
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
    } catch (e) {
      reason = 'Error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      try {
        native.close();
      } catch {
        /* ignore */
      }
      this.ui.ended(reason);
    }
  }

  private async connectLoop(dap: SwdDap): Promise<void> {
    let tries = 0;
    while (this.running) {
      try {
        await dap.connect();
        return;
      } catch (e) {
        if (!(e instanceof SwdError) || ++tries >= 5) throw e;
        this.ui.status('SWD connect failed: ' + e.message);
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
