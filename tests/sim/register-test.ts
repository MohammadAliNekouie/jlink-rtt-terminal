declare const process: any;
// Real src/jlink.ts (copied as jlink-real.ts) against a fake probe that answers like the captured J-Link ARM-OB STM32.
import { JLink } from './jlink-real';
import { b64decode, b64encode } from './util';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }
const hex = (b: ArrayLike<number>) => Array.from(b as number[]).map((x) => x.toString(16).padStart(2, '0')).join(' ');

(async () => {
  const seen: string[] = [];
  let pending = new Uint8Array(0);
  const MAXC = 4; let stamp = 0xb9fc;
  (globalThis as any).TRANSACT = async (b64: string, expect: number) => {
    const d = b64decode(b64);
    if (d.length > 0) {
      seen.push(hex(d));
      const reply = (n: number, fill = 0) => new Uint8Array(n).fill(fill);
      switch (d[0]) {
        case 0xe8: pending = Uint8Array.from([0x33, 0x58, 0xea, 0x88]); break;
        case 0xed: pending = reply(32); break;
        case 0xe6: case 0xf2: pending = reply(256); break;
        case 0xf0: pending = Uint8Array.from([0x70, 0x11, 0x01, 0x00]); break;
        case 0x0d: pending = Uint8Array.from([0x10, 0x47, 0x04, 0x00]); break;
        case 0x07: pending = Uint8Array.from([0xe4, 0x0c, 0, 0, 1, 1, 1, 1]); break;
        case 0x09: { // 12 + 16*max bytes: header, then our entry (pid, hid, iid, cid, handle=1, timestamp)
          pending = reply(12 + 16 * MAXC);
          pending.set([0x01, 0x00, MAXC, 0x00, 0x10, 0x00, 0x04, 0x00], 0);
          pending.set(d.subarray(2, 6), 8); pending.set([0, 0, 0, 0, 0, 0, 0x01, 0x00], 12); stamp += 0x100;
          pending.set([stamp & 255, stamp >> 8, 0, 0], 20); break;
        }
        default: pending = reply(expect);
      }
    }
    const out = pending.slice(0, expect); pending = pending.slice(expect);
    return b64encode(out);
  };
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;

  const jl = new JLink();
  await jl.seggerQueries();
  await jl.registerConnection();
  const ops = seen.map((s) => s.split(' ')[0]);
  assert(ops.join(',') === 'e8,ed,e6,f2,f0,0d,09,09', 'startup order like the capture: e8 ed e6 f2 f0 0d 09 09 (got ' + ops.join(',') + ')');
  const reg0 = seen[6].split(' '), reg1 = seen[7].split(' ');
  assert(reg0.length === 14 && reg0[1] === '64' && reg0.slice(6).join(' ') === '00 00 00 00 00 00 00 00', 'REGISTER #1: 09 64 pid(4) hid(4) iid cid handle=0000 (' + seen[6] + ')');
  assert(reg1.slice(0, 6).join(' ') === reg0.slice(0, 6).join(' ') && reg1.slice(12).join(' ') === '01 00', 'REGISTER #2: same pid, handle 0001 taken from the probe reply (' + seen[7] + ')');
  assert(reg0[2] === '54' && reg0[3] === '60', 'pid low half is 0x6054 like SEGGER (' + reg0.slice(2, 6).join(' ') + ')');

  const n0 = seen.length;
  await jl.getTargetVoltageMv();
  assert(seen.length - n0 === 1 && seen[n0].startsWith('07'), 'no heartbeat before 2.5 s');
  skew += 3000;
  const n1 = seen.length;
  await jl.getTargetVoltageMv();
  assert(seen.length - n1 === 2 && seen[n1].startsWith('09 64') && seen[n1].endsWith('01 00') && seen[n1 + 1].startsWith('07'), 'heartbeat 09 64 ... 01 00 sent before the next command after 3 s');
  await jl.getTargetVoltageMv();
  assert(seen.length - n1 === 3, 'and only one heartbeat per interval');
  Date.now = realNow;
})();
