# Changelog

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
