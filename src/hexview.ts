import type { Segment } from './image';

/** Lazy, virtualisable hex-editor style rows: ADDRESS  16 hex bytes  |ASCII|. */
export interface HexView {
  rowCount: number;
  row(i: number): string;
}

const BYTES = 16;
const H = '0123456789ABCDEF';

function h2(v: number): string {
  return H[(v >> 4) & 15] + H[v & 15];
}

function h8(v: number): string {
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function buildHexView(segs: Segment[]): HexView {
  // Per segment: 1 header row + data rows aligned to 16-byte addresses.
  const starts: number[] = [];
  const dataRows: number[] = [];
  let total = 0;
  for (const s of segs) {
    const first = s.addr - (s.addr % BYTES);
    const last = s.addr + s.data.length;
    const rows = Math.ceil((last - first) / BYTES);
    starts.push(total);
    dataRows.push(rows);
    total += 1 + rows;
  }

  const row = (i: number): string => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    const r = i - starts[lo];
    if (r === 0) {
      const end = s.addr + s.data.length - 1;
      return '-- ' + h8(s.addr) + ' .. ' + h8(end) + '  (' + s.data.length + ' bytes) --';
    }
    const base = s.addr - (s.addr % BYTES) + (r - 1) * BYTES;
    let hex = '';
    let asc = '';
    for (let k = 0; k < BYTES; k++) {
      const a = base + k;
      const idx = a - s.addr;
      if (idx >= 0 && idx < s.data.length) {
        const b = s.data[idx];
        hex += h2(b) + ' ';
        asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else {
        hex += '   ';
        asc += ' ';
      }
      if (k === 7) hex += ' ';
    }
    return h8(base) + '  ' + hex + ' |' + asc + '|';
  };

  return { rowCount: total, row };
}
