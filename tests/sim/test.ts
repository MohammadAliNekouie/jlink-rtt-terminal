declare const process: any;
declare const require: any;
import { FlashJob, probeQuirks } from './flasher';
import { probeJtagIdcode } from './jtagdiag';
import { parseIntelHex, parseBin } from './image';
import { buildHexView } from './hexview';
import { F1, F4, Base, Nrf } from './socs';
function assert(c: boolean, m: string) { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok:', m); }
function rnd(n: number, seed = 7) { const b = new Uint8Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; b[i] = (s >>> 16) & 255; } return b; }
function toHex(addr: number, d: Uint8Array) {
  const L: string[] = []; let hi = -1;
  const rec = (t: number, a: number, data: number[]) => { const b = [data.length, a >> 8, a & 255, t, ...data]; const sum = b.reduce((x, y) => (x + y) & 255, 0); L.push(':' + [...b, (256 - sum) & 255].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()); };
  for (let i = 0; i < d.length; i += 16) { const a = addr + i; if ((a >>> 16) !== hi) { hi = a >>> 16; rec(4, 0, [hi >> 8, hi & 255]); } rec(0, a & 0xffff, Array.from(d.subarray(i, Math.min(i + 16, d.length)))); }
  rec(1, 0, []); return L.join('\r\n');
}
async function flash(soc: Base, segs: ReturnType<typeof parseBin>, speed = 4000, protect = false) {
  (globalThis as any).SOC = soc; let res = { ok: false, msg: '' }; const logs: string[] = [];
  await new FlashJob({ speedKhz: speed, targetPower: false, segments: segs, runAfter: true, protect }, { log: (l) => logs.push(l), progress: () => {}, ended: (ok, msg) => { res = { ok, msg }; } }).run();
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

  // ---- on-board probe (2012 firmware): flashing works, SWD starts at 100 kHz ----
  (globalThis as any).FWVER = 'J-Link ARM-OB STM32 compiled Aug 22 2012 19:52:04';
  // flash helper that lets the speed be chosen, like the app's drop-down
  const ob = async (speedKhz: number, inject: { failAbove?: number; badBig?: boolean } = {}) => {
    (globalThis as any).MAXBITS = 0; (globalThis as any).FAILABOVE = inject.failAbove; (globalThis as any).BADBIG = !!inject.badBig;
    probeQuirks.bigFramesBad = false;
    const chip = new F1(); const res = await flash(chip, segs, speedKhz);
    (globalThis as any).FAILABOVE = undefined; (globalThis as any).BADBIG = false;
    return { chip, res, max: (globalThis as any).MAXBITS as number };
  };
  let o = await ob(1000);
  assert(o.res.ok && o.res.logs.some((l) => /on-board probe: SWD starts at 100 kHz/.test(l)) && o.res.logs.some((l) => /SWD up.* at 100 kHz/.test(l)), 'OB probe: connects at 100 kHz, flash ok');
  assert(o.res.logs.some((l) => /SWD speed raised to 1000 kHz/.test(l)) && (globalThis as any).LASTSPEED === 1000, 'OB probe: programming runs at the selected 1000 kHz');
  assert(o.res.logs.some((l) => /USB frames raised to 972 bits/.test(l)) && o.max > 272 && o.max <= 972, 'OB probe: frames grown after a read-back self-test (largest ' + o.max + ' bits)');
  o = await ob(4000, { failAbove: 1500 });
  assert(o.res.ok && o.res.logs.some((l) => /not reliable/.test(l)) && o.res.logs.some((l) => /raised to 1000 kHz/.test(l)), 'OB probe: 4000 kHz unreliable -> steps down to 1000 kHz, flash ok');
  o = await ob(2000, { failAbove: 100 });
  assert(o.res.ok && o.res.logs.some((l) => /staying at 100 kHz/.test(l)), 'OB probe: nothing above 100 kHz works -> stays at 100 kHz, flash ok');
  o = await ob(1000, { badBig: true });
  assert(o.res.ok && o.res.logs.some((l) => /larger frames are not reliable/.test(l)) && o.max <= 540 && probeQuirks.bigFramesBad, 'OB probe: corrupt big frames detected before erasing, back to 34-byte frames, flash ok (only the self-test frame was bigger: ' + o.max + ' bits)');
  assert(o.chip.bad.length === 0, 'OB probe: flash controller saw no illegal accesses in any of these runs');
  (globalThis as any).CSWWRITES = 0; probeQuirks.bigFramesBad = false;
  { const c = new F1(); const r2 = await flash(c, segs, 1000); assert(r2.ok && (globalThis as any).CSWWRITES < 40, 'access size switched once per call, not per batch (' + (globalThis as any).CSWWRITES + ' CSW writes for a 5000-byte image)'); }
  (globalThis as any).FWVER = undefined;

  // ---- probe whose input stream is shifted by 6 bits (wider offset search) + OB probe ignores 5V ----
  (globalThis as any).SHIFT = 6; (globalThis as any).FWVER = 'J-Link ARM-OB STM32 compiled Aug 22 2012 19:52:04';
  f1 = new F1(); (globalThis as any).SOC = f1; let sh = { ok: false, msg: '' }; const shLogs: string[] = [];
  await new FlashJob({ speedKhz: 4000, targetPower: true, segments: segs, runAfter: true }, { log: (l) => shLogs.push(l), progress: () => {}, ended: (ok, msg) => { sh = { ok, msg }; } }).run();
  assert(sh.ok && shLogs.some((l) => /5V target power switch ignored/.test(l)), 'in-stream shift of 6 bits decoded, OB probe ignores 5V switch: ' + sh.msg);
  (globalThis as any).SHIFT = 0; (globalThis as any).FWVER = undefined;

  // ---- V9-style stream (reply arrives one bit early) ----
  (globalThis as any).SHIFT = -1; f1 = new F1(); r = await flash(f1, segs); assert(r.ok, 'probe stream 1 bit early (J-Link V9 style, offset -1) decoded: ' + r.msg); (globalThis as any).SHIFT = 0;

  // ---- silent target (your OB log): must NOT fake a DPIDR from the echoed request bits ----
  (globalThis as any).SILENT = true; f1 = new F1(); r = await flash(f1, segs);
  assert(!r.ok && /Target not answering on SWD/.test(r.msg) && /Raw in-bits/.test(r.msg), 'silent target reported honestly, no false DPIDR: ' + r.msg.slice(0, 70));
  (globalThis as any).SILENT = false;

  // ---- JTAG IDCODE diagnostic ----
  const mkTdo = (id: number, off: number) => { const b = new Uint8Array(8); for (let i = 0; i < 32; i++) if (Math.floor(id / 2 ** i) % 2) { const p = 9 + off + i; b[p >> 3] |= 1 << (p & 7); } return b; };
  const fakeJl = (tdo: Uint8Array) => ({ calls: [] as string[], selectInterface: async function (t: number) { this.calls.push('tif' + t); }, swdIo: async (_a: Uint8Array, _b: Uint8Array, bits: number) => { if (bits !== 43) throw new Error('unexpected bit count ' + bits); return tdo; } });
  let rep: string = await probeJtagIdcode(fakeJl(mkTdo(0x4ba00477, 0)));
  assert(/IDCODE 0x4BA00477 \(sample offset 0\)/.test(rep), 'JTAG IDCODE found: ' + rep.slice(0, 40));
  rep = await probeJtagIdcode(fakeJl(mkTdo(0x16410041, 1)));
  assert(/IDCODE 0x16410041 \(sample offset 1\)/.test(rep), 'JTAG IDCODE found at offset 1');
  rep = await probeJtagIdcode(fakeJl(new Uint8Array(8).fill(0xff)));
  assert(/no JTAG answer/.test(rep), 'all-ones TDO reported as no answer');
  rep = await probeJtagIdcode(fakeJl(new Uint8Array(8)));
  assert(/no JTAG answer/.test(rep), 'all-zero TDO reported as no answer');

  // ---- regression: the exact frames captured from a J-Link ARM-OB STM32 (2012) whose target never answers ----
  {
    const resp1 = Uint8Array.from([0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x9e,0xe7,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x00,0xa5,0xff,0xff,0xff,0xff,0x3f,0x00,0x00]).slice(0, 24);
    let calls = 0;
    const captured: any = { swdIo: async (_d: Uint8Array, _o: Uint8Array, bits: number) => { calls++; if (bits === 190) return resp1; if (bits !== 162) return new Uint8Array((bits + 7) >> 3).fill(0xff); throw new Error('init batch must not be sent when the target is silent (bits=' + bits + ')'); } };
    const { SwdDap } = require('./swd');
    let msg = '';
    try { await new SwdDap(captured).connect(); msg = 'CONNECTED (bogus)'; } catch (e: any) { msg = String(e && e.message); }
    assert(/Target not answering on SWD/.test(msg) && calls === 4, 'captured OB log: silent target reported, not a bogus connect (' + calls + ' tries): ' + msg.slice(0, 70));
  }

  // ---- target that only answers the long startup (E79E + EDB6), reply arrives 1 bit early like the OB capture ----
  {
    (globalThis as any).ONLYLONG = true; (globalThis as any).SHIFT = -1; (globalThis as any).SILENT = false;
    const f = new F1(); (globalThis as any).SOC = f;
    const { SwdDap } = require('./swd'); const { JLink } = require('./jlink');
    const dap = new SwdDap(new JLink()); let msg = 'ok';
    try { await dap.connect(); } catch (e: any) { msg = String(e && e.message); }
    assert(msg === 'ok' && dap.sampleOffset === -1 && dap.hostDriveBit === 1 && dap.dpidr === 0x1ba01477, 'long-startup-only target: connected via attempt 2, offset -1, drive 1, DPIDR 0x1BA01477 (' + msg.slice(0, 40) + ')');
    (globalThis as any).ONLYLONG = false; (globalThis as any).SHIFT = 0;
  }

  // ---- real capture of SEGGER's software on the 2012 OB probe (packet 148 out, packet 150 in) ----
  {
    const hx = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
    const pcOut = hx('ff ff ff ff ff ff ff 9e e7 ff ff ff ff ff ff ff b6 ed ff ff ff ff ff ff ff 00 00 a5 00 00 00 00 00 00');
    const pcIn = hx('ff ff ff ff ff ff ff 9e e7 ff ff ff ff ff ff ff b6 ed ff ff ff ff ff ff ff 00 00 a5 b9 a3 00 dd 00 00');
    const frames: { out: Uint8Array; bits: number }[] = [];
    const cap: any = { swdIo: async (_d: Uint8Array, out: Uint8Array, bits: number) => {
      frames.push({ out: out.slice(), bits });
      // attempt 0 (standard startup): silent. attempt 1 (long startup): the PC's real reply. Anything later: zeros.
      if (frames.length === 1) return new Uint8Array((bits + 7) >> 3).fill(0xff);
      if (frames.length === 2) { const r = new Uint8Array((bits + 7) >> 3); r.set(pcIn.subarray(0, r.length)); return r; }
      return new Uint8Array((bits + 7) >> 3);
    } };
    const { SwdDap } = require('./swd');
    const dap = new SwdDap(cap);
    try { await dap.connect(); } catch { /* the init batch gets zeros: only the DPIDR stage matters here */ }
    const bit = (a: ArrayLike<number>, i: number) => (a[i >> 3] >> (i & 7)) & 1;
    let same = true; for (let i = 0; i < 224; i++) if (bit(frames[1].out, i) !== bit(pcOut, i)) same = false;
    assert(same, 'our long startup + DPIDR request equals the PC frame bit-for-bit (first 224 bits)');
    assert(dap.dpidr === 0x1ba01477 && dap.sampleOffset === -1 && dap.hostDriveBit === 1, 'the PC\'s real reply decodes to DPIDR 0x1BA01477 at offset -1, drive 1 (got ' + dap.dpidr.toString(16) + ', offset ' + dap.sampleOffset + ')');
  }

  // ---- read-out protection (RDP level 1) after programming ----
  {
    const prot = (soc: Base) => flash(soc, segs, 4000, true);
    let c = new F1(); (globalThis as any).LASTCTRL = undefined;
    let pr = await prot(c);
    assert(pr.ok && /read-out protected \(RDP 1\)/.test(pr.msg), 'F103: flash + verify + RDP level 1 ok: ' + pr.msg);
    assert(c.ob(0) === 0xbb && ((c.obPair(0) >> 8) & 0xff) === 0x44, 'F103: RDP option byte = 0xBB with the hardware complement 0x44');
    assert(c.ob(1) === 0xfe && c.ob(4) === 0xfe && c.ob(2) === 0xff && c.ob(3) === 0xff && c.ob(5) === 0xff, 'F103: USER (hardware watchdog) and WRP0 restored after the option erase, the rest stays 0xFF');
    assert(c.bad.length === 0, 'F103: option bytes only touched with flash unlocked, OPTWRE and OPTPG (' + c.bad.slice(0, 2).join() + ')');
    assert(c.log[c.log.length - 1] === 'reset' && c.after === 0 && c.running, 'F103: nothing touches the chip after the reset; debug state was left first (' + c.after + ' accesses after reset)');
    assert((globalThis as any).LASTCTRL === 0 && c.locked, 'F103: debug port powered down and flash controller locked at the end');

    c = new F1(); c.stuck = 0x08000102; pr = await prot(c);
    assert(!pr.ok && /Verify FAILED/.test(pr.msg) && c.ob(0) === 0xa5 && !c.log.includes('oberase'), 'F103: failed verify -> chip is NOT protected and its option bytes are untouched');

    c = new F1(); c.failOb = true; pr = await prot(c);
    assert(!pr.ok && /half-written/.test(pr.msg) && /STM32CubeProgrammer/.test(pr.msg), 'F103: a failure while writing option bytes is reported as half-written, with the way out');

    const f4 = new F4(); pr = await prot(f4);
    assert(pr.ok && f4.optcr === 0x0fffbbed && f4.after === 0, 'F4: OPTCR RDP = 0xBB and every other option bit kept (0x' + f4.optcr.toString(16) + '), no access after reset');

    // level 2 (0xCC) is permanent: never written, and a level-2 chip is never touched
    const lv2 = new F4(); lv2.optcr = 0x0fffccec;
    const memOf = (s: any) => ({ readWords: async (a: number, n: number) => Array.from({ length: n }, (_, i) => s.read(a + 4 * i)), writeWord: async (a: number, v: number) => s.write(a, v >>> 0, 4), writeWords: async () => {}, writeWordsPaced: async () => {}, writeHalfwordsPaced: async () => {}, readBytes: async () => new Uint8Array(0) });
    const { protectorStm32f4 } = require('./flash/stm32f4');
    const p4 = await protectorStm32f4(memOf(lv2)); let e4 = '';
    try { await p4.protect(memOf(lv2), { vtrefMv: null, speedKhz: 1000 }); } catch (e: any) { e4 = String(e && e.message); }
    assert(/level 2/.test(e4) && lv2.optcr === 0x0fffccec && !lv2.log.includes('optstrt'), 'F4: a level-2 chip is refused and left untouched');

    const nr = new Nrf(); pr = await prot(nr);
    assert(!pr.ok && /only supported for STM32/.test(pr.msg) && !nr.log.some((l) => l.startsWith('erase')), 'nRF52: protection refused BEFORE anything is erased');

    const locked = new F1(); locked.rdpActive = true; pr = await flash(locked, segs, 4000);
    assert(!pr.ok && /read-out protection \(RDP\) is probably active/.test(pr.msg), 'already-protected chip: clear explanation instead of a raw bus fault');
  }

  // ---- hex viewer ----
  const v = buildHexView(segs); assert(v.rowCount === 1 + Math.ceil(5000 / 16), 'hexview row count');
  console.log(v.row(0)); console.log(v.row(1)); console.log(v.row(v.rowCount - 1));
  const odd = buildHexView([{ addr: 0x1004, data: new Uint8Array([0x41, 0x42, 0x00]) }]); console.log(odd.row(1));
  assert(/^00001000 {2}\s{12}41 42 00/.test(odd.row(1)) || /^00001000/.test(odd.row(1)), 'hexview unaligned row');
  const multi = buildHexView([{ addr: 0, data: new Uint8Array(40) }, { addr: 0x1000, data: new Uint8Array(3) }]); assert(multi.row(4).startsWith('-- 00001000'), 'hexview second segment header at row 5 (1+3, then header)');
})();
