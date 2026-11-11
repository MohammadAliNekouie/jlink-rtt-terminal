declare const process: any;
import { Session } from './session';
import { F1 } from './socs';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(silent: boolean) {
  (globalThis as any).SOC = new F1(); (globalThis as any).SILENT = silent;
  const status: string[] = []; const logs: string[] = []; let ended = '';
  const s = new Session({ speedKhz: 100, searchStart: 0x20000000, searchSize: 0x1000, fixedAddr: null, targetPower: false },
    { status: (t) => status.push(t), data: () => {}, log: (l) => logs.push(l), ended: (r) => { ended = r; } });
  const done = s.run();
  for (let i = 0; i < 100 && !silent && !status.some((x) => /SWD up/.test(x)); i++) await sleepMs(50);
  if (!silent) s.stop();
  await done;
  return { status, logs, ended };
}

(async () => {
  let r = await run(false);
  assert(r.status.some((x) => /SWD up, DPIDR=0x1BA01477/i.test(x)), 'normal connect: SWD up');
  (globalThis as any).COMPAT = []; (globalThis as any).FWVER = 'J-Link ARM-OB STM32 compiled Aug 22 2012 19:52:04';
  r = await run(false);
  assert((globalThis as any).COMPAT.join() === 'queries,register' && r.logs.some((l) => /registered like SEGGER software/.test(l)), 'OB probe: SEGGER-style queries + registration before SWD (' + (globalThis as any).COMPAT.join() + ')');
  (globalThis as any).COMPAT = []; (globalThis as any).FWVER = undefined;
  r = await run(false);
  assert((globalThis as any).COMPAT.length === 0, 'other probes: no registration (unchanged behaviour)');
  r = await run(true);
  assert(/^Error:/.test(r.ended), 'silent target: the session ends with an error message instead of hanging');
})();
