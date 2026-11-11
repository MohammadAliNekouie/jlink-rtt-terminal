/** Word-level memory access (implemented by SwdDap; faked in tests). */
export interface Mem {
  readWords(addr: number, count: number): Promise<number[]>;
  writeWord(addr: number, value: number): Promise<void>;
  writeWords(addr: number, words: number[]): Promise<void>;
  writeWordsPaced(addr: number, words: number[], padBits: number): Promise<void>;
  writeHalfwordsPaced(addr: number, hws: number[], padBits: number): Promise<void>;
  readBytes(addr: number, len: number): Promise<Uint8Array>;
}

export interface Ctx {
  /** Target voltage seen by the probe in mV, or null if unknown / not reported. */
  vtrefMv: number | null;
  speedKhz: number;
}

export interface Sector {
  start: number;
  size: number;
  /** Chip-specific sector id (e.g. STM32 SNB). */
  id: number;
}

/** A direct flash-controller driver for one chip family (no RAM flash algorithm). */
export interface FlashChip {
  name: string;
  flashStart: number;
  /** Exclusive. */
  flashEnd: number;
  sectorAt(addr: number): Sector;
  unlock(mem: Mem): Promise<void>;
  eraseSector(mem: Mem, s: Sector): Promise<void>;
  beginProgram(mem: Mem): Promise<void>;
  /** Program word-aligned data; returns when the controller is idle again. */
  program(mem: Mem, addr: number, words: number[]): Promise<void>;
  endProgram(mem: Mem): Promise<void>;
  /** Make reads see the new flash content (e.g. flush caches). */
  prepareVerify(mem: Mem): Promise<void>;
  lock(mem: Mem): Promise<void>;
}

/** Read-out protection (RDP level 1) for one chip family. Level 2 (permanent) is never used. */
export interface Protector {
  name: string;
  /** True if protection is already programmed in the option bytes (it may only become active after a reset). */
  isProgrammed(mem: Mem): Promise<boolean>;
  /** Program RDP level 1 (keeping the other option bytes) and read it back. */
  protect(mem: Mem, ctx: Ctx): Promise<void>;
}
export type ProtectProbe = (mem: Mem) => Promise<Protector | null>;

export type Probe = (mem: Mem, ctx: Ctx) => Promise<FlashChip | null>;

export function padBitsFor(wordTimeUs: number, speedKhz: number): number {
  return Math.ceil((wordTimeUs * speedKhz) / 1000) + 8;
}
