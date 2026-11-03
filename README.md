# J-Link RTT Terminal

**Turn an Android phone or tablet into a SEGGER RTT terminal and firmware updater for J-Link probes. No PC, no SEGGER software, no drivers.**

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Android 7+](https://img.shields.io/badge/platform-Android%207%2B-3ddc84.svg)
![Expo SDK 53](https://img.shields.io/badge/Expo-SDK%2053-000020.svg)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)

Plug a J-Link into your Android device with a USB-OTG cable, connect it to your target's SWD pins, and read your firmware's
`SEGGER_RTT` output live. The whole stack — USB transport, J-Link command framing, SWD, ARM debug access and the RTT protocol —
is implemented in TypeScript on top of a small Kotlin module that does raw USB bulk transfers.
It can also program flash (erase, program, verify, run) on a few chip families.

> **Not affiliated with SEGGER.** "J-Link" and "SEGGER" are trademarks of SEGGER Microcontroller GmbH. This is an independent,
> community project. See [Trademarks and assets](#trademarks-and-assets).

<!-- Add screenshots to docs/screenshots/ and show them here:
![RTT page](docs/screenshots/rtt.png) ![Firmware update](docs/screenshots/firmware-update.png) -->

## Contents

- [Features](#features)
- [Project status](#project-status)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using the app](#using-the-app)
- [Firmware update](#firmware-update)
- [How it works](#how-it-works)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Features

- **RTT terminal.** Reads RTT up-channel 0 and sends text to down-channel 0, with selectable line ending (LF / CR / CRLF / none).
  Finds the control block automatically by scanning a RAM window, or jumps straight to a fixed address.
- **Two message pages.** **RTT messages** (shown first) holds only your target's output; **USB messages** holds probe,
  SWD and firmware-update diagnostics. Tabs sit below the message area, with a dot for unseen lines.
- **Firmware update.** Pick a `.hex` or `.bin`, inspect it in a built-in **hex viewer** (address, 16 bytes per row, ASCII),
  then erase → program → verify → reset and run. Direct flash-controller drivers, no RAM flash algorithm.
- **Robust SWD link.** Retries at slower speeds, auto-detects the probe's direction-bit polarity and input-bit offset,
  recovers from sticky errors, and reopens the probe after a USB failure.
- **Probe diagnostics.** USB descriptors, probe firmware version, a trace of the first exchanges and the raw SWD reply
  are shown when something fails, so problems can be reported with real data.
- **Pure TypeScript protocol stack** with an offline simulation test suite that runs without hardware.

## Project status

This is **experimental software written for one person's bench**. Please read this table before relying on it.

| Area | Status |
|---|---|
| RTT terminal with **J-Link V9** (firmware 2021) | Works. Tested on a Samsung Galaxy Tab S7 with an STM32 target. |
| Old on-board probe **J-Link ARM-OB STM32** (firmware Aug 2012) | **Not working yet.** The probe locks up on USB or the target's SWD reply is not decoded. The 5V switch is ignored on OB probes because it browned out the probe. |
| Other J-Link models (EDU, EDU Mini, Plus, newer OB) | Untested. Expected to work if they use the standard vendor USB interface and the `0xCF` SWD I/O command. |
| Firmware update | Verified **only in simulation** (`npm run test:sim`). Not yet confirmed on real hardware. Try it on a spare board first. |
| RTT targets | 32-bit Cortex-M over SWD. JTAG-only targets are not supported. |
| Platforms | Android only (needs USB host mode). No iOS, no emulator. |

Hardware reports (working or not) are very welcome — see [Contributing](#contributing).

## Requirements

- An **Android 7.0+ device with USB host (OTG) support** and a USB-OTG cable or adapter. Emulators do not work.
- A **SEGGER J-Link** probe (USB vendor ID `0x1366`).
- A target with **SWD** wired: SWDIO, SWCLK, GND, and VTref (the target must be powered).
- Firmware that uses [SEGGER RTT](https://www.segger.com/products/debug-probes/j-link/technology/about-real-time-transfer/) for output.
- To build: Node.js 18+ and npm, plus either an [Expo EAS](https://expo.dev) account (cloud build) or the Android SDK and JDK 17 (local build).

## Quick start

```bash
git clone https://github.com/MohammadAliNekouie/jlink-rtt-terminal.git
cd jlink-rtt-terminal
npm install
npx expo install --fix        # aligns Expo package versions with the SDK
npm run check                 # static project checks
npm run typecheck
npm run test:sim              # offline simulation of the flashing stack
```

**Build an installable APK in the cloud (EAS):**

```bash
npm install -g eas-cli
eas login
eas build --platform android --profile preview     # produces an APK you can sideload
```

**Or build and run locally** (needs the Android SDK, JDK 17 and a device attached over adb):

```bash
npx expo prebuild --platform android --clean
npx expo run:android
```

> **Forking?** `app.json` contains the original author's Android package name (`com.nikohost.jlinkrtt`) and EAS project ID.
> Change `expo.android.package`, remove `expo.extra.eas.projectId` and run `eas init` to attach your own EAS project.
>
> **`npm ci` lockfile errors:** run `npm install` once to refresh `package-lock.json` after changing dependencies.

## Using the app

1. Install the APK, plug the J-Link into the device through an OTG adapter, and connect the probe to the target's SWD header.
2. Open the app and set the fields at the top:

   | Field | Default | Meaning |
   |---|---|---|
   | SWD kHz | `4000` | SWD clock. Lower it (e.g. `400`) for long wires; the app also retries slower automatically. |
   | RAM start / size | `0x20000000` / `0x20000` | Window scanned for the RTT control block. Set it to your chip's RAM. |
   | RTT CB addr | empty | Optional fixed address of `_SEGGER_RTT` (find it in your linker `.map`). Skips the scan. |
   | 5V switch | off | Makes the probe supply 5V on its target-power pin. **Ignored on on-board (OB) probes.** |

3. Tap **Connect** and grant the USB permission prompt. The status line shows the probe version and `SWD up, DPIDR=…`.
4. Watch output on the **RTT messages** page. Type a command and tap **Send** to write to the target's down-channel.
5. Switch to **USB messages** for diagnostics. `Clr` clears the page you are viewing.

The app version is shown at the right of the **Firmware update…** button.

## Firmware update

Open **Firmware update…**, then:

1. **Choose file** — `.hex` (Intel HEX) or `.bin`. ELF is not supported; export a `.hex` or `.bin` from your toolchain.
2. For a `.bin`, enter its **base address**. The field is pre-filled with `08000000` as an example: the start of the
   STM32F103CBT6 flash (128 KB, up to `0801FFFF`). A `.hex` file carries its own addresses.
3. Check the **hex viewer**. Toggle between *flash image* (what will be written, by address) and *file bytes* (the raw file).
4. Tap **Flash** and confirm. The app halts the core, detects the chip, erases only the pages/sectors the image touches,
   programs, **verifies by read-back**, then resets into the new firmware. Progress and details go to the **USB messages** page.

Supported chips:

| Family | Flash controller | Notes |
|---|---|---|
| STM32F0 / F1 / F3 | FPEC, 16-bit programming | 1 KB or 2 KB pages by device. F1 XL-density (dual bank) is refused. |
| STM32F2 / F4 | Sector controller, 32-bit programming | Needs VDD ≥ 2.7 V. Dual-bank 2 MB parts supported. |
| nRF52 (52805/810/811/820/832/833/840) | NVMC | 4 KB pages. UICR is not touched. |

STM32 F7, L0, L1, L4/L4+, L5, G0, G4, H7 and WB are **recognised** (you get a clear message) but have **no driver yet**.

**Safety.** Erasing works on whole pages/sectors, so anything else in the first or last page the image touches is lost
(for example a bootloader sharing that page). Cancelling or unplugging mid-update can leave incomplete firmware — just
run the update again. Read-out protection / debug lock is detected but **cannot** be removed by this app.
You use the firmware updater at your own risk; see the [license](LICENSE).

## How it works

```
   RTT text / hex viewer / firmware update          App.tsx  (React Native UI)
              │
   Session (RTT)   FlashJob (programming)           src/session.ts, src/flasher.ts
              │                │
        Rtt (control block,     flash drivers       src/rtt.ts, src/flash/*
        up/down buffers)        (STM32, nRF52)
              └───────┬────────┘
                  SwdDap — SWD + ARM DAP + MEM-AP   src/swd.ts
                      │
                  JLink — J-Link command framing    src/jlink.ts
                      │   (base64 over the native bridge)
                  JLinkUsb — raw USB bulk I/O       modules/jlink-usb (Kotlin, Expo module)
                      │
                  USB-OTG ──► J-Link ──► target SWD
```

- **Native module (`modules/jlink-usb`).** Finds SEGGER devices, requests USB permission, claims the vendor interface and
  moves bytes over the bulk IN/OUT endpoints. All protocol logic is in TypeScript.
- **J-Link commands used** (`src/jlink.ts`):

  | Command | Purpose |
  |---|---|
  | `0x01` | Get version string |
  | `0xC7` | Select / query target interface (SWD) |
  | `0x05` | Set speed (kHz) |
  | `0x07` | Hardware status (VTref in mV, reset line) |
  | `0x08` | Target power (5V) on/off |
  | `0xCF` | SWD I/O: `[0xCF, 0x00, bitCount(LE16), dir[], out[]]` → `in[]` + status byte |

- **SWD (`src/swd.ts`).** Line reset and JTAG→SWD switch, DPIDR read, debug power-up, MEM-AP word access, posted reads,
  WAIT/FAULT handling. It auto-detects the direction-bit polarity and a small input-bit offset, because probes differ.
  Flash drivers can also request 16-bit transfers and paced writes for slow flash controllers.
- **RTT (`src/rtt.ts`).** Scans RAM for the `"SEGGER RTT"` ID, validates the control block, then polls the up-buffer ring
  and writes into the down-buffer ring.
- **Flash drivers (`src/flash/`).** Each driver programs the chip's own flash controller registers directly over SWD.
- **Config plugin (`plugins/withUsbHost.js`).** Declares `android.hardware.usb.host` as required in the manifest.

## Development

| Script | What it does |
|---|---|
| `npm run check` | Static checks: config, files, versions, icons, dependency wiring. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test:sim` | Runs the real SWD + flasher + drivers against **fake STM32F1/F4 chips** behind a fake J-Link. |
| `npm start` | Expo dev server (a physical device with the native module needs a dev build, not Expo Go). |
| `npm run build:android:preview` | EAS cloud build of an APK. |

```
App.tsx                  UI: connect form, RTT/USB pages, firmware update, hex viewer
src/                     protocol stack and application logic (TypeScript)
  flash/                 flash drivers + chip detection
modules/jlink-usb/       Kotlin Expo module for raw USB access
plugins/withUsbHost.js   Expo config plugin (USB host feature)
tests/sim/               fake J-Link and fake SoCs for the offline tests
scripts/                 static-check.mjs, sim-test.sh
TESTING.md               hardware test plan
CHANGELOG.md             release notes
```

The simulation tests exercise the real bit-level SWD code, but **they are not a substitute for hardware**.
Before flashing real boards, follow [TESTING.md](TESTING.md).

## Troubleshooting

| Symptom | What to try |
|---|---|
| "No J-Link found" | Use a data-capable OTG cable. Only SEGGER devices (VID `0x1366`) are listed. Check the device supports USB host. |
| Permission prompt never appears or was denied | Unplug and replug the probe, then tap Connect again. |
| `No SWD response (ack=…)` | Check SWDIO, SWCLK, GND and **VTref**; make sure the target is powered. Lower the speed. The raw reply is on the **USB messages** page — include it in bug reports. |
| `RTT control block not found` | Set RAM start/size to your chip's RAM, or enter the `_SEGGER_RTT` address from the `.map` file. The firmware must have initialised RTT. |
| `USB write failed` / probe stops answering | Unplug and replug the probe (a wedged probe only recovers after a power cycle). Keep the 5V switch off with on-board probes. |
| Old OB probe (2012 firmware) fails | Known limitation. Try a newer J-Link, or update the probe firmware with SEGGER's tools if your board vendor allows it. |
| `Verify FAILED at 0x…` | Re-run the update. Check the supply voltage and that the image range is correct. |
| `npm ci` fails with lockfile errors | Run `npm install` to refresh `package-lock.json`. |

## Contributing

Issues and pull requests are welcome. The most valuable contributions right now:

- **Hardware reports:** probe model + firmware date, target chip, what worked, and the **USB messages** page text.
- **New chip drivers.** A driver is a `Probe` that reads a chip's ID registers and returns a `FlashChip`:

  ```ts
  // src/flash/mychip.ts
  export const probeMyChip: Probe = async (mem, ctx) => {
    const id = (await mem.readWords(0xe0042000, 1))[0] & 0xfff; // chip ID register
    if (id !== 0x123) return null;                              // not this family
    return { name: 'MyChip', flashStart, flashEnd, sectorAt, unlock, eraseSector,
             beginProgram, program, endProgram, prepareVerify, lock };
  };
  ```

  Register it in `PROBES` in `src/flash/index.ts`, add a fake chip to `tests/sim/socs.ts`, and cover it in `tests/sim/test.ts`.
- Support for more probes, ELF input, more STM32 families (G0/G4/L4/H7), and a cleaner UI.

Before opening a pull request run `npm run check && npm run typecheck && npm run test:sim`.

## License

[MIT](LICENSE). Flashing firmware can erase or damage devices; the software is provided **as is**, without warranty.

### Trademarks and assets

"J-Link" and "SEGGER" are trademarks of SEGGER Microcontroller GmbH, used here only to describe compatibility.
The app icon in `assets/` imitates the J-Link icon and is a placeholder: replace it with your own artwork before
redistributing the app (for example on an app store).

### Acknowledgements

Built with [Expo](https://expo.dev) and React Native. The J-Link USB protocol is documented by open-source projects such as
[libjaylink](https://gitlab.zapb.de/libjaylink/libjaylink) and [OpenOCD](https://openocd.org); the SWD and
debug-access behaviour follows the Arm Debug Interface specification; RTT is SEGGER's real-time transfer technology.
