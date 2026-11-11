# Changelog

## 1.2.14
- **Read-out protection (RDP level 1) after programming** for STM32 F0/F1/F2/F3/F4, as an opt-in switch in the firmware panel
  (off by default, with a strongly worded confirmation). It runs only after the flash verified OK; a failed verify leaves the chip
  unprotected. F0/F1/F3: unlock flash and option bytes, erase the option bytes, program RDP = 0xBB, restore USER/Data/WRP.
  F2/F4: unlock `FLASH_OPTCR`, set RDP[15:8] = 0xBB, start, read back. **Level 2 (0xCC, permanent) is never written and a
  level-2 chip is never touched.** A chip family without a protector (e.g. nRF52) is refused before anything is erased.
- After protecting, the app leaves debug state, resets and powers the debug port down, then stops: a protected chip faults when a
  debugger is connected (by design), so RTT and re-flashing with this app no longer work until the protection is removed
  (STM32CubeProgrammer, RDP level 0 - this erases the chip). Power-cycle the board.
- A chip whose flash info cannot be read because RDP is active now gets a clear message instead of a raw bus fault.

## 1.2.13
- **Default SWD speed at startup is now 1000 kHz** (was 4000).
- **Firmware update uses the speed selected in the drop-down**, also on on-board (OB) probes: they still connect at 100 kHz (the
  only speed proven to start them), then the app switches to the selected speed, checks it with repeated CPUID reads and steps
  down (selected, 1000, 400, 200 kHz) if a speed is not reliable.
- **Much fewer USB round trips for OB probes.** Raw frames used to be capped at 34 bytes, which allowed one 16-bit flash word per
  round trip. Before erasing anything the app now reads the same flash words with larger frames (544, then 972 bits) and keeps a
  size only if the data is identical; otherwise it stays at 34 bytes. In simulation a 20 KB image needs about 4.7x fewer round trips.
- 16-bit access mode is now set once per programming call instead of twice per batch.

## 1.2.12
- UI: the speed drop-down is smaller and shows just the value (`4000 kHz`, no "SWD" prefix).
- UI: **Clr** now clears both message pages (RTT and USB) and the command field.
- Removed the **Rst** (connect under reset) switch and the code behind it; it was not needed.
- The on-board J-Link ARM-OB STM32 connects since 1.2.11 (SEGGER-style startup with registration and heartbeat).

## 1.2.11
- **SEGGER-style startup for on-board (OB) probes.** USB captures showed that SEGGER's software, before its first SWD frame,
  queries the probe (`e8 ed e6 f2 f0 0d`), **registers a connection** (`09 64 pid hid iid cid handle`, twice) and then refreshes
  that registration about every 3 s. The app did none of this; a bit-identical SWD frame at 100 kHz still got no answer from the
  OB in the field. The app now replays that startup for OB probes (other probes are unchanged), sets 200 then 100 kHz and reads
  the status twice like SEGGER, and the transport sends the heartbeat automatically before any command once 2.5 s have passed.
- **SWD speed is now a drop-down list** of standard values (5 kHz to 12 MHz) instead of a text field.
- The USB trace now keeps the first 40 exchanges (the longer startup would otherwise fill the old 14).

## 1.2.10
- Verified against real USB captures of SEGGER's software talking to a J-Link ARM-OB STM32 (2012) and a J-Link V9:
  the app's long startup frame equals SEGGER's frame bit for bit (preamble and DPIDR request), and SEGGER's real DPIDR reply
  decodes to `0x1BA01477` at input offset -1 with host-drive polarity 1. Both are now regression tests.
- **On-board probes get frames of at most 34 bytes (272 bits)**, the largest raw frame seen in the capture (the PC uses the
  probe's own `0xC5` memory commands for everything bigger). Memory reads/writes are chunked accordingly (slower, safer).
- The unexplained second byte of the `0xCF` header is not significant: it takes 9 different values in the OB capture
  (`00 1d 1f 03 6f 72 aa b5 d1`, i.e. padding) and is always `00` on the V9, so the app keeps sending `00`.

## 1.2.9
- **On-board (OB) probes now start SWD at 100 kHz** (what SEGGER's own software does in a capture), instead of 1000 kHz.
- **Alternate SWD startup as a fallback:** if the standard startup (reset, `0xE79E`, reset, idle) gets no answer, the app now
  also tries the longer sequence seen in a capture of SEGGER software on an OB probe (reset, `0xE79E`, reset, `0xEDB6`,
  reset, 16 idle clocks). Order: standard, long, then both again with the opposite direction polarity. The raw reply of
  the first two attempts is shown on the USB page.
- Removed the "old firmware" hedges (skipping the interface query, 1000 kHz cap): the capture shows this probe supports
  the query, and the 5V switch was the real cause of the earlier lock-ups.

## 1.2.8
- **Connect under reset:** new **Rst** switch next to 5V. It holds the target's nRESET low while connecting, then releases it and
  reconnects (for firmware that disables the SWD pins or goes to sleep). nRESET is always released on exit or error.
  Used by the RTT session only; not yet by the firmware updater.
- Regression test built from a real capture of a J-Link ARM-OB STM32 (2012) with a silent target.

## 1.2.7
- App icon: big, full-bleed adaptive icon with **no white area** (the exact artwork fills the whole icon; the legacy/store
  icon is unchanged). Round launcher masks trim the corners of the square artwork.

## 1.2.6
- **Fix:** SWD connect could report a bogus success when the target did not answer at all: the widened offset search
  (1.2.3) could read the probe's echo of the host's own request bits as a valid DPIDR. The reply window now has to start
  after the request, and far offsets need the Arm DPIDR signature.
- A silent target is now reported as *"Target not answering on SWD: SWDIO stays high after the request"* (with raw bits).
- After repeated SWD failures the app reads the **JTAG IDCODE** once as a diagnostic and logs whether the target answers
  on JTAG (then SWD is probably not wired/enabled), then switches back to SWD.

## 1.2.5
- App icon is now pixel-identical to the supplied artwork (adaptive icon on a white plate).
- Two message pages with tabs below the messages: **RTT messages** (default) and **USB messages**.
- Firmware-update base address pre-filled with `08000000` (STM32F103CBT6) as an example.

## 1.2.4
- Version label next to the *Firmware update* button.
- USB exchange trace is printed only when something fails.

## 1.2.3
- On-board (OB) probes: the 5V target-power switch is ignored (it browned out the probe).
- Wider SWD input-offset search (±8 bits); raw DPIDR reply printed on connect failure.

## 1.2.2
- Hedges for old probe firmware (2013 or older): skip optional queries, start at ≤ 1000 kHz.
- Flush stale USB bytes on open; endpoint halt state in error messages; trace of the first exchanges.

## 1.2.1
- USB layer: first-endpoint selection, no interface-subclass requirement, CLEAR_HALT on stalls, descriptor dump.
- Session reopens the probe automatically on USB errors (3 attempts).

## 1.2.0
- **Firmware update** for STM32F0/F1/F2/F3/F4 and nRF52 (erase, program, verify, run), with a hex viewer.
- Automatic slower-speed SWD retries; SWD input-bit offset calibration; 16-bit and paced flash writes.
- Offline simulation test suite (`npm run test:sim`).

## 1.1.x
- First working RTT terminal; build and configuration fixes (Expo SDK 53, native USB module, USB host config plugin).
