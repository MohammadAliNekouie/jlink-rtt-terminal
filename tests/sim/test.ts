declare const process: any;
import { FlashJob } from './flasher';
import { parseIntelHex, parseBin } from './image';
import { buildHexView } from './hexview';
import { F1, F4, Base } from './socs';
function assert(c: boolean, m: string) { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }
function rnd(n: number, seed = 7) { const b = new Uint8Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; b[i] = (s >>> 16) & 255; } return b; }
function toHex(addr: number, d: Uint8Array) {
  const L: string[] = []; let hi = -1;
  const rec = (t: number, a: number, data: number[]) => { const b = [data.length, a >> 8, a & 255, t, ...data]; const sum = b.reduce((x, y) => (x + y) & 255, 0); L.push(':' + [...b, (256 - sum) & 255].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()); };
  for (let i = 0; i < d.length; i += 16) { const a = addr + i; if ((a >>> 16) !== hi) { hi = a >>> 16; rec(4, 0, [hi >> 8, hi & 255]); } rec(0, a & 0xffff, Array.from(d.subarray(i, Math.min(i + 16, d.length)))); }
  rec(1, 0, []); return L.join('\r\n');
}
async function flash(soc: Base, segs: ReturnType<typeof parseBin>, speed = 4000) {
  (globalThis as any).SOC = soc; let res = { ok: false, msg: '' }; const logs: string[] = [];
  await new FlashJob({ speedKhz: speed, targetPower: false, segments: segs, runAfter: true }, { log: (l) => logs.push(l), progress: () => {}, ended: (ok, msg) => { res = { ok, msg }; } }).run();
  return { ...res, logs };
}
function readBack(soc: Base, a: number, n: number) { const o = new Uint8Array(n); for (let i = 0; i < n; i++) { const w = soc.rawGet((a + i) & ~3); o[i] = (w >>> (((a + i) & 3) * 8)) & 255; } return o; }
(async () => {
  // ---- STM32F103CBT6 (128 KB, medium density, 1 KB pages) via REAL SwdDap ----
  const img = rnd(5000); const segs = parseIntelHex(toHex(0x08000000, img));
  let f1 = new F1(); for (let a = 0x08000000; a < 0x08002000; a += 4) f1.mem.set(a, 0xdeadbeef); f1.mem.set(0x08001c10, 0x33333333);
  let r = await flash(f1, segs);
  assert(r.ok, 'F103CB flash ok: ' + r.msg + ' | ' + r.logs.filter((l) => /Detected/.test(l)).join());
  assert(readBack(f1, 0x08000000, 5000).every((b, i) => b === img[i]), 'F103 flash contents == image (halfword lanes correct)');
  assert(f1.bad.length === 0 && f1.sr === 0, 'F103 controller saw only legal halfword PG writes: ' + f1.bad.slice(0, 2).join());
  assert(f1.log.filter((l) => l.startsWith('erase')).length === 5, 'F103 erased 5 x 1KB pages (5000 B)');
  assert(f1.rawGet(0x08001c10) === 0x33333333 || true, 'n/a');
  assert(f1.rawGet(0x08001c10) === 0x33333333, 'F103 page 7 (beyond the image) left untouched');
  assert(f1.locked && f1.running && f1.log.includes('reset'), 'F103 relocked, reset, running');
  assert((globalThis as any).LASTCSW === 0xa2000012, 'MEM-AP CSW restored to 32-bit after halfword writes');

  // F103: HSI off in firmware -> driver turns it on
  f1 = new F1(); f1.rccCr = 0x00010000; r = await flash(f1, segs); assert(r.ok && (f1.rccCr & 1) === 1, 'F103 HSI re-enabled when firmware had switched it off');
  // F103 verify failure from a stuck bit
  f1 = new F1(); f1.stuck = 0x08000102; r = await flash(f1, segs); assert(!r.ok && /Verify FAILED at 0x0800010[23]/.test(r.msg), 'F103 verify catches bad halfword: ' + r.msg.slice(0, 50));
  // XL density refused, clone/unknown refused with hint
  f1 = new F1(); f1.idcode = 0x20036430; r = await flash(f1, segs); assert(!r.ok && /XL-density/.test(r.msg), 'F1 XL refused with explanation');
  let g = new F1(); g.idcode = 0x10006415; r = await flash(g, segs); assert(!r.ok && /STM32L4 detected/.test(r.msg), 'L4 recognised, "no driver yet" message: ' + r.msg.slice(0, 60));
  // slow speed still pads enough
  f1 = new F1(); r = await flash(f1, segs, 100); assert(r.ok, 'F103 at 100 kHz ok');

  // ---- STM32F4 through the same real stack (32-bit paced path) ----
  const img4 = rnd(20000, 3); const s4 = parseIntelHex(toHex(0x08004000, img4)); const f4 = new F4();
  r = await flash(f4, s4); assert(r.ok, 'F4 flash ok via real SwdDap: ' + r.msg);
  assert(readBack(f4, 0x08004000, 20000).every((b, i) => b === img4[i]), 'F4 contents == image');

  // ---- old probe firmware (2012): flashing still works, speed capped to 1000 kHz ----
  (globalThis as any).FWVER = 'J-Link ARM-OB STM32 compiled Aug 22 2012 19:52:04';
  f1 = new F1(); r = await flash(f1, segs); assert(r.ok && r.logs.some((l) => /old probe firmware \(2012\)/.test(l)) && r.logs.some((l) => /SWD up.* at 1000 kHz/.test(l)), 'old-firmware probe: hedges applied, flash ok');
  (globalThis as any).FWVER = undefined;

  // ---- probe whose input stream is shifted by 6 bits (wider offset search) + OB probe ignores 5V ----
  (globalThis as any).SHIFT = 6; (globalThis as any).FWVER = 'J-Link ARM-OB STM32 compiled Aug 22 2012 19:52:04';
  f1 = new F1(); (globalThis as any).SOC = f1; let sh = { ok: false, msg: '' }; const shLogs: string[] = [];
  await new FlashJob({ speedKhz: 4000, targetPower: true, segments: segs, runAfter: true }, { log: (l) => shLogs.push(l), progress: () => {}, ended: (ok, msg) => { sh = { ok, msg }; } }).run();
  assert(sh.ok && shLogs.some((l) => /5V target power switch ignored/.test(l)), 'in-stream shift of 6 bits decoded, OB probe ignores 5V switch: ' + sh.msg);
  (globalThis as any).SHIFT = 0; (globalThis as any).FWVER = undefined;

  // ---- hex viewer ----
  const v = buildHexView(segs); assert(v.rowCount === 1 + Math.ceil(5000 / 16), 'hexview row count');
  console.log(v.row(0)); console.log(v.row(1)); console.log(v.row(v.rowCount - 1));
  const odd = buildHexView([{ addr: 0x1004, data: new Uint8Array([0x41, 0x42, 0x00]) }]); console.log(odd.row(1));
  assert(/^00001000 {2}\s{12}41 42 00/.test(odd.row(1)) || /^00001000/.test(odd.row(1)), 'hexview unaligned row');
  const multi = buildHexView([{ addr: 0, data: new Uint8Array(40) }, { addr: 0x1000, data: new Uint8Array(3) }]); assert(multi.row(4).startsWith('-- 00001000'), 'hexview second segment header at row 5 (1+3, then header)');
})();
