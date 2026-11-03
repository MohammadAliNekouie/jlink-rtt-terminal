# Test plan - v1.2.5 (firmware update + hex viewer)

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
* **Pages**: tabs below the message area - **RTT messages** (default on start) and **USB messages** (probe/USB
  diagnostics, SWD failures and the firmware-update log). A dot on a tab means unseen new lines. `Clr` clears the
  page you are looking at. The command line is shown on the RTT page only. Starting a firmware update switches to the
  USB page automatically.
* **Base address** field starts with `08000000` (STM32F103CBT6 flash, 128 KB up to `0801FFFF`) as an example; it is
  only used for `.bin` files. Change it for other chips (e.g. nRF52 uses `00000000`).

Check: start the app (RTT tab selected, base address filled), connect (RTT text on RTT tab, `[usb]` lines only on the USB
tab), start a flash (jumps to USB tab), tap back to RTT.
