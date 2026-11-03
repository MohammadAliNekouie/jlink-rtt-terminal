/** Firmware image handling: .bin / Intel HEX -> word-aligned, merged segments. */

export interface Segment {
  addr: number;
  data: Uint8Array;
}

export class ImageError extends Error {}

interface Run {
  addr: number;
  end: number;
  parts: Uint8Array[];
}

function flatten(r: Run): Uint8Array {
  if (r.parts.length === 1) return r.parts[0];
  const out = new Uint8Array(r.end - r.addr);
  let o = 0;
  for (const p of r.parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Sort + merge segments. Overlapping bytes are combined with AND (flash semantics: 0xFF = "nothing here").
 * Adjacent segments are joined.
 */
export function mergeSegments(segs: Segment[]): Segment[] {
  const sorted = segs.filter((s) => s.data.length > 0).sort((a, b) => a.addr - b.addr);
  const runs: Run[] = [];
  for (const s of sorted) {
    const end = s.addr + s.data.length;
    const last = runs[runs.length - 1];
    if (last && s.addr === last.end) {
      last.parts.push(s.data);
      last.end = end;
    } else if (last && s.addr < last.end) {
      const merged = new Uint8Array(Math.max(last.end, end) - last.addr).fill(0xff);
      merged.set(flatten(last), 0);
      const off = s.addr - last.addr;
      for (let i = 0; i < s.data.length; i++) merged[off + i] &= s.data[i];
      last.parts = [merged];
      last.end = last.addr + merged.length;
    } else {
      runs.push({ addr: s.addr, end, parts: [s.data] });
    }
  }
  return runs.map((r) => ({ addr: r.addr, data: flatten(r) }));
}

/** Pad every segment to 4-byte boundaries with 0xFF, then merge (words shared by two segments get combined). */
export function toWordAligned(segs: Segment[]): Segment[] {
  const aligned = segs
    .filter((s) => s.data.length > 0)
    .map((s) => {
      const start = s.addr & ~3;
      const end = (s.addr + s.data.length + 3) & ~3;
      const d = new Uint8Array(end - start).fill(0xff);
      d.set(s.data, s.addr - start);
      return { addr: start >>> 0, data: d };
    });
  return mergeSegments(aligned);
}

export function parseBin(data: Uint8Array, base: number): Segment[] {
  if (data.length === 0) throw new ImageError('File is empty');
  return toWordAligned([{ addr: base >>> 0, data }]);
}

function hexByte(s: string, i: number): number {
  const v = parseInt(s.substr(i, 2), 16);
  if (Number.isNaN(v)) throw new ImageError('Bad hex digit in HEX file');
  return v;
}

export function parseIntelHex(text: string): Segment[] {
  const recs: Segment[] = [];
  let base = 0;
  let sawEof = false;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (line === '') continue;
    if (line[0] !== ':') throw new ImageError('HEX line ' + (ln + 1) + ': missing ":"');
    if (line.length < 11 || (line.length & 1) === 0) throw new ImageError('HEX line ' + (ln + 1) + ': bad length');
    const len = hexByte(line, 1);
    if (line.length !== 11 + len * 2) throw new ImageError('HEX line ' + (ln + 1) + ': length mismatch');
    const addr16 = (hexByte(line, 3) << 8) | hexByte(line, 5);
    const type = hexByte(line, 7);
    let sum = 0;
    for (let i = 1; i < line.length; i += 2) sum = (sum + hexByte(line, i)) & 0xff;
    if (sum !== 0) throw new ImageError('HEX line ' + (ln + 1) + ': checksum error');
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = hexByte(line, 9 + i * 2);
    if (type === 0x00) {
      recs.push({ addr: (base + addr16) >>> 0, data });
    } else if (type === 0x01) {
      sawEof = true;
      break;
    } else if (type === 0x02) {
      if (len !== 2) throw new ImageError('HEX line ' + (ln + 1) + ': bad extended segment record');
      base = ((data[0] << 8) | data[1]) * 16;
    } else if (type === 0x04) {
      if (len !== 2) throw new ImageError('HEX line ' + (ln + 1) + ': bad extended linear record');
      base = ((data[0] << 8) | data[1]) * 65536;
    } // 0x03 / 0x05 (start address) are ignored
  }
  if (!sawEof) throw new ImageError('HEX file has no end-of-file record (truncated?)');
  if (recs.length === 0) throw new ImageError('HEX file contains no data');
  return toWordAligned(recs);
}

function bytesToAscii(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 8192)));
  return s;
}

/** Choose the parser from the file name / content. `binBase` is only needed for raw .bin files. */
export function parseFirmware(name: string, bytes: Uint8Array, binBase: number | null): Segment[] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.elf') || lower.endsWith('.axf') || (bytes[0] === 0x7f && bytes[1] === 0x45)) {
    throw new ImageError('ELF files are not supported yet - export a .hex or .bin from your toolchain');
  }
  if (lower.endsWith('.hex') || lower.endsWith('.ihex') || bytes[0] === 0x3a) {
    return parseIntelHex(bytesToAscii(bytes));
  }
  if (binBase === null) throw new ImageError('Enter the flash base address for a raw .bin file (e.g. 08000000)');
  return parseBin(bytes, binBase);
}

export function imageSize(segs: Segment[]): number {
  return segs.reduce((n, s) => n + s.data.length, 0);
}
