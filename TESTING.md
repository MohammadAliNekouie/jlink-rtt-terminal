# Test plan - v1.2.6 (firmware update + hex viewer)

Status: the flashing logic is verified **only in simulation** (`npm run test:sim`, 18 checks against fake
STM32F1/F4 chips through the real SwdDap). Nothing has run on real silicon yet. Controller timings, the
STM32F1 HSI handling, the nRF52 FICR addresses and the F4 cache flush come from datasheet knowledge.

## 0. Build

```bash
npm install                          # refreshes package-lock.json for the 3 new dependencies (required!)
npx expo install --fix               # aligns the three new packages to the exact SDK 53 versions
node scripts/static-check.mjs        # expect ALL CHECKS PASSED (and no lockfile NOTE)
npm run test:sim                     # expect SIMULATION PASSED (18 checks)
npx tsc --noEmit                     # real type-check (needs node_modules)
eas build --platform android --profile preview
```
`eas build` runs `npm ci`, which fails if package-lock.json is not in sync - hence `npm install` first.

## 1. Regression (RTT still works) - do this first
1. Connect probe + target, press **Connect**: status shows `SWD up, DPIDR=... offset=N`, RTT text appears.
2. Disconnect, reconnect with the OB probe: if SWD fails, watch for `Retrying SWD at ... kHz` lines.

## 2. Hex viewer (no hardware needed)
1. Firmware update... > Choose file > pick your `.hex`: summary line shows segments / bytes / address range.
2. Scroll the dump; first row should be a header `-- 08000000 .. 0800xxxx (N bytes) --`.
3. Toggle **Show: file bytes** - the dump now shows the raw ASCII of the .hex file from offset 0.
4. Pick a file with a bad checksum (edit one digit): red error, Flash does nothing.
5. Pick a `.bin`: base-address field is required; the dump re-addresses as you type it.

## 3. Flash tests - use a SPARE STM32F103 board (Blue Pill etc.), keep the original firmware file
| # | Test | Expected |
|---|------|----------|
| 3.1 | Flash a small known-good app `.hex` at 0x08000000 | log: `Detected STM32F10x medium-density (DEV_ID 0x410, 128 KB, 1024 B pages)`, erase N pages, `Verify OK`, `Reset done`, app runs |
| 3.2 | Re-flash the same file | still OK (erase + program again) |
| 3.3 | Flash at 100 kHz (SWD kHz field) | OK, slower |
| 3.4 | Reconnect RTT afterwards | RTT output from the new firmware appears |
| 3.5 | Cancel during programming | `Cancelled - flash may contain incomplete firmware...`; re-flash recovers the board |
| 3.6 | Unplug USB during programming | error shown; re-flash recovers (SWD still works with a hardware reset) |
| 3.7 | `.hex` whose addresses are outside 0x08000000..0x0801FFFF | refused *before* erasing, message names the range |
| 3.8 | Chip with read-out protection | `Unsupported or locked chip ...` (app cannot unlock) |
| 3.9 | Wrong-family board (e.g. STM32L4 / G0) | `STM32L4 detected, but its flash controller has no driver yet` |

If verify fails, note the reported address and the `FLASH_SR` value in the message and send them with the
log lines (they are also appended to the terminal as `[flash] ...`).

## 4. Other chips (optional)
STM32F4 (0x413/0x419/0x423/0x431/0x433/0x441...), F0/F3 (FPEC, 16-bit), F2, nRF52: all share the same flow but are
equally unverified on hardware - test on a spare board first.

## Known limits
Erase is by whole page/sector (neighbouring data in the first/last touched page is lost). STM32 families other
than F0/F1/F2/F3/F4 are detected but not programmable. F1 XL-density (dual bank) refused. No ELF support.
No option-byte / read-out-protection handling. Every USB or SWD failure aborts the update (no auto-resume).

## USB errors ("USB write failed/timeout") - v1.2.1
v1.2.1 prints a `[usb] ...` line in the terminal when the probe opens, e.g.
`[usb] VID:PID 0x1366:0x105 | if0 class 0xff/0xff/0xff [0x81 bulk 64] [0x1 bulk 64] | using if0 in=0x81 out=0x1`
and every USB error now names the failing J-Link command and says whether the probe is
"still on USB bus" or "GONE from USB bus (reset, unplugged or USB power dip)".
The app now reopens the probe automatically (up to 3 attempts, `reopening probe (n/3)`).

If it still fails, send me: the `[usb]` descriptor line, the full error text, and what you were doing.
* **"probe GONE"**: the probe reset or lost power. If the OB board is powered *through the probe's USB cable from the
  tablet*, the tablet port may be browning out when the board starts: use a powered OTG hub (or power the board
  separately) and retry.
* **"still on USB bus" but write fails**: endpoint/interface problem - the `[usb]` line tells me which one was used.
* The SWD fallback speeds no longer go below 100 kHz in the RTT session.

## Old probe firmware ("J-Link ARM-OB STM32 compiled Aug 22 2012") - v1.2.2
A real log from this probe showed: version query OK, then the probe stopped accepting USB writes at the first
SWD data command (`cmd 0xcf`, 52 B), and stayed dead across reopen attempts until it was power-cycled.
So the probe firmware itself locks up (or does not support SWD I/O); the USB layer is not the culprit.

v1.2.2 hedges for firmware from 2013 or older: it skips the optional "available interfaces" query and starts at
<= 1000 kHz, flushes stale bytes on open, clears endpoint halts (also `setInterface`), and prints a trace of the
first 14 exchanges: `[usb] > <bytes out>  < <bytes in>  N ms`. Failed writes now say how long they took and whether the
endpoint is `halted`. Please send me the whole `[usb]` block from a freshly power-cycled probe (unplug it first - a
wedged probe only recovers after power-cycling).

What to try if it still locks up:
1. Power-cycle the probe, then connect once (do not press Connect repeatedly - each retry hits a dead probe).
2. Connect it to a PC and run SEGGER J-Link Commander: it shows the firmware date and may offer to update the
   probe (some OB probes can be updated, some are locked to the board vendor - check SEGGER's licence terms).
   A 2012 firmware may simply not support SWD I/O the way this app drives it.
3. Use your newer J-Link (V9) on the same board's SWD header - that combination is known to work.

## What the OB log showed (v1.2.3)
* USB-level SWD works on the "J-Link ARM-OB STM32" (SWD_IO exchanges answer in 1-2 ms, VTref 3300 mV, nRESET high).
* **Switching the 5V target-power option on killed the probe** (`08 01`, then every write failed until replug). The OB
  board is powered through the probe's USB cable from the tablet, so v1.2.3 ignores the 5V switch for OB probes
  (logged as `5V target power switch ignored`). Keep the switch OFF for on-board probes.
* The remaining problem is decoding the target's answer. v1.2.3 searches +-8 bit offsets (was +-3) and prints the raw
  DPIDR reply for both drive polarities into the terminal: `SWD connect failed: ... Raw in-bits: drive1: ... ; drive0: ...`.
  Please send that line (plus the `[usb]` block) if the target is still not found.

## v1.2.4: icon, version label, quieter log
* App icon = your J-Link icon (48 px source, smooth-upscaled to 1024 px). Android gets an adaptive icon (safe-zone
  foreground + gradient background) so round/squircle masks do not crop "Link". Check it on the home screen after install.
* The version (`v1.2.4 (build 7)`) shows at the right of the **Firmware update...** button; it is read from app.json.
* The `[usb]` exchange trace is now only printed when something fails (USB error or SWD connect failure); the
  descriptor line and probe version are always printed.
* Verified with your J-Link V9 log: SWD + RTT work, 5V switch fine on the V9 (`08 01` accepted).
* Store note: the icon is SEGGER's J-Link look. Fine for testing; for a public store release use your own artwork
  (trademark), as with the "J-Link" name.

## v1.2.5: exact icon, two message pages, default base address
* **Icon** is now pixel-identical to the supplied 48x48 picture, enlarged with nearest-neighbour scaling (no smoothing,
  no redraw). On Android, adaptive launchers mask icons into circles/squircles, so the exact square picture sits on a
  white plate (the whole picture stays visible). Older launchers show the plain square icon.
* **v1.2.7:** the white plate is gone. The adaptive icon is now full-bleed: the exact picture fills Android's whole visible
  area (opaque, no transparency). Round launcher masks trim the bottom corners of "Link"; rounded-square masks show it fully.
  Check it on the home screen after install.
* **Pages**: tabs below the message area - **RTT messages** (default on start) and **USB messages** (probe/USB
  diagnostics, SWD failures and the firmware-update log). A dot on a tab means unseen new lines. `Clr` clears the
  page you are looking at. The command line is shown on the RTT page only. Starting a firmware update switches to the
  USB page automatically.
* **Base address** field starts with `08000000` (STM32F103CBT6 flash, 128 KB up to `0801FFFF`) as an example; it is
  only used for `.bin` files. Change it for other chips (e.g. nRF52 uses `00000000`).

Check: start the app (RTT tab selected, base address filled), connect (RTT text on RTT tab, `[usb]` lines only on the USB
tab), start a flash (jumps to USB tab), tap back to RTT.

## v1.2.6: OB probe log analysis
The "J-Link ARM-OB STM32" log showed the target **not answering at all** (SWDIO high after the request). v1.2.3-1.2.5
could fake a DPIDR from the probe's echo of the request bits, which produced the misleading `No SWD ACK (0x0)`; fixed.
Expected log now on that board: `Target not answering on SWD: SWDIO stays high ...` followed by one line
`JTAG IDCODE 0x........ ...` or `no JTAG answer either (TDO raw: ...)`. Please send both lines, plus the chip on the board
and whether the J-Link V8 works on the *same* board/header.

## v1.2.9: OB startup like SEGGER's software (from your captures)
What the captures (as analysed) say about the 2012 OB probe: raw SWD I/O (`0xCF`) is supported, the PC connects at 100 kHz
with a longer startup bitstream (`0xE79E`, then `0xEDB6`), host-drive bit = 1, and the DPIDR reply is read one bit earlier
than the app's default (offset -1, which the app already tries). The captures were later uploaded and verified (see v1.2.10).

Test on the OB: Connect. On the USB page expect `on-board probe: SWD starts at 100 kHz` and either
`SWD up, DPIDR=0x1BA01477 ...` or `SWD connect failed: ... Raw in-bits: std/drive1: ... ; long/drive1: ...`. Send me that
line: it shows what the target answered to the standard and to the long startup.
Not implemented (only if connect works but later steps fail): the PC splits request/ACK and data into separate `0xCF` calls,
the app batches them; the 2nd header byte of `0xCF` varies in the captures (1f/00/6f/72) and is not understood, so it stays 0.

## v1.2.10: what the real captures proved (and did not)
Proved: SEGGER's software starts SWD on **both** probes with the same 267-bit frame (56 ones, `0xE79E`, 56 ones, `0xEDB6`,
56 ones, 16 zeros, DPIDR read `0xA5`) at 100 kHz, host-drive bit 1, and reads the reply one bit early (our offset -1). The OB
only ever receives raw frames up to 34 bytes; after startup SEGGER switches to the probe's own `0xC5` memory commands.
Not proved: that the app now connects to the OB. Test: Connect. Expect `on-board probe: SWD starts at 100 kHz`,
then `SWD up, DPIDR=0x1BA01477 ... offset=-1`. If it fails, the USB page shows `Raw in-bits: std/drive1: ... ; long/drive1: ...`.
Note: at 100 kHz scanning a big RAM window for the RTT block is slow (about 20 s for 128 KB even without USB overhead):
set RAM size to your chip's real RAM (e.g. 5000 for 20 KB) or enter the `_SEGGER_RTT` address.

## v1.2.11: registration + heartbeat for the OB (the likely missing piece)
The v1.2.10 field log showed the OB still silent although our SWD frame equals SEGGER's bit for bit. The captures show what is
different *before* that frame: SEGGER queries the probe, registers a connection and refreshes it every ~3 s (`09 64 ...`).
v1.2.11 replays that for OB probes. Expected USB-page lines: `on-board probe: registered like SEGGER software (heartbeat every ~3 s)`
then `SWD up, DPIDR=0x1BA01477 ...`. If it still says `Target not answering`, send me the whole USB page (the trace now holds the
first 40 exchanges). If you see `SEGGER-style registration failed: ...`, send that line.
Speed is now chosen from a drop-down (tap it to open the list); it is locked while connected or flashing.

## v1.2.12: UI tidy-up
Check: the speed drop-down is narrow and reads e.g. `4000 kHz`; the **Rst** switch is gone; **Clr** empties the RTT page, the USB page
and the command line in one tap.

## v1.2.13: flashing speed
Default SWD speed is now 1000 kHz. On the OB, flashing connects at 100 kHz, then raises the speed. Expected USB-page lines:
`SWD up, DPIDR=... at 100 kHz`, `SWD speed raised to 1000 kHz` (or `SWD at N kHz is not reliable ...` then a lower step),
`Detected ...`, `USB frames raised to 544 bits`, `USB frames raised to 972 bits` (or `larger frames are not reliable ..., staying at 272 bits`).
Time a 20-60 KB image at 1000 kHz and at 400 kHz and send me the times plus the USB page. If a `USB frames` step makes the probe
stop answering, unplug/replug it: the app will not repeat that experiment until it is restarted.
Reference (simulation only): a 20 KB image needs ~2500 USB round trips on the OB now vs ~11900 before; a V9 needs ~1300.

## v1.2.14: read-out protection (RDP 1) - hardware-UNVERIFIED, use a spare chip
Simulation (fake F1/F4 with ST's unlock rules, 60 checks) passes; nothing here has run on real silicon. Procedures follow ST's
PM0075 / community-confirmed sequences. Test only on a board you can afford to erase.
1. Flash a known-good image with the switch **off** first (regression).
2. Switch **Read-out protect** on, flash. Expected USB-page lines: `Read-out protection (RDP level 1) will be set after programming: STM32...`,
   normal erase/program/verify, `Setting read-out protection (RDP level 1) ...`, `RDP level 1 programmed and read back ...`,
   `Debug port released. Power-cycle the board now.`
3. Power-cycle the board **without** attaching the app/debugger: the firmware should run normally.
4. Then try Connect in the app: on a protected chip this is expected to fail or fault the chip (that is the protection working).
5. To get the chip back: STM32CubeProgrammer, connect under reset, set RDP level 0 (full erase). On F1, an active RDP also
   write-protects the first flash pages until it is removed.
If step 2 fails after "Setting read-out protection" the message says the option bytes may be half-written: remove protection with
STM32CubeProgrammer and flash again. Please send me the whole USB page of any failure.
