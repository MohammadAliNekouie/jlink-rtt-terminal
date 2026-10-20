# J-Link RTT Terminal (Expo / React Native)

An Expo (SDK 53) Android app that talks to SEGGER J-Link probes over raw USB,
implements SWD + the RTT control-block protocol in TypeScript (`src/`), and
renders a serial-terminal-style RTT console.

## Requirements

- Node.js (npm) and the Expo CLI / EAS CLI.
- A **physical Android device** with a working USB-OTG host port. The app cannot
  run on an emulator: it opens the probe's USB bulk endpoints directly
  (`UsbManager` / `UsbDeviceConnection`), which emulators do not expose.
- A SEGGER J-Link probe (e.g. J-Link OB / EDU Mini) with a debug-connector cable
  to the **target MCU**. The target must be powered and its SWD pins wired
  (SWCLK, SWDIO, GND; VTref as applicable).
- No vendor driver is required on the phone; the module claims the probe's bulk
  IN/OUT endpoints directly.

## Install & run locally

```bash
npm install
npx expo prebuild --platform android --clean   # generates android/ with config plugin applied
npx expo run:android                            # needs Android SDK + device via OTG
```

## Build an APK with EAS (preview, side-loadable)

```bash
npm install -g eas-cli
eas login
eas build:configure              # uses the bundled eas.json
eas build --platform android --profile preview
# or locally, if you have Android SDK/NDK + JDK 17:
eas build --platform android --profile preview --local --output ./jlink-rtt-preview.apk
```

The `preview` profile builds an **APK** (`buildType: "apk"`) for internal
distribution — install it directly on the phone, attach the J-Link through an
OTG adapter/cable, and grant the USB permission dialog when prompted.

## USB protocol disclosure (experimental)

The native module (`modules/jlink-usb`, Kotlin, Expo Modules Core) performs
**raw USB bulk transfers only**. It does not use the SEGGER JNI/DLL. All
protocol logic lives in TypeScript:

- `src/swd.ts` — bit-banged SWD over bulk OUT/IN frames.
- `src/jlink.ts` — J-Link command framing (connect, SWD speed, target power, halt).
- `src/rtt.ts` — RTT control-block search in target RAM and ring-buffer polling.
- `src/session.ts` — session orchestration; `App.tsx` — terminal UI.

The default transact pattern is: write base64 payload to the probe's bulk OUT
endpoint, then read exactly `expect` bytes from bulk IN. Default interface
endpoints follow standard J-Link bulk descriptors. This is **experimental**:
behavior varies across probe firmware, and a bad transfer sequence can leave the
probe needing a power cycle. Default RTT scan window is `0x20000000 + 0x20000`
(adjustable in the UI).

## Layout

```
App.tsx                 terminal UI (entry: expo/AppEntry via package.json main)
src/                    TS protocol engine (rtt, swd, jlink, session, util, native)
modules/jlink-usb/      local Expo module (file dependency)
  index.js              exports requireNativeModule('JLinkUsb')
  expo-module.config.json
  android/build.gradle   library Gradle (namespace expo.modules.jlinkusb, minSdk 24)
  android/src/main/...   Kotlin module + manifest declaring USB host feature
plugins/withUsbHost.js  @expo/config-plugins plugin: adds
                        <uses-feature android:name="android.hardware.usb.host"
                                      android:required="true"/> to the app manifest
scripts/static-check.mjs  node-only structural sanity checks
```

## Status

See [BUILD_STATUS.md](./BUILD_STATUS.md) — this project's build has **not** been
verified (see that file for the exact toolchain gaps).
