# v1.2.5 status

- Exact-pixel icon (adaptive: white plate), separate RTT / USB message pages with tabs, default base address 08000000.

# v1.2.4 status

- New app icon (+ adaptive icon), version label next to the Firmware update button, USB trace printed only on failure.

# v1.2.3 status

- 5V switch ignored on OB probes (it browned out the probe), +-8 bit sample-offset search, raw DPIDR bits in terminal.

# v1.2.2 status

- Old-firmware hedges, IN-endpoint flush, endpoint halt state in errors, trace of the first 14 USB exchanges.
  Cause of the J-Link ARM-OB STM32 (2012 firmware) lock-up is NOT confirmed; these are diagnostics + hedges.

# v1.2.1 status

- USB layer: first-endpoint selection, no subclass requirement, CLEAR_HALT on stalls, descriptor dump,
  presence check in errors; Session reopens the probe on USB errors (3 attempts). Kotlin changes are NOT
  compiled/tested here (no Android toolchain) - the EAS build is their first compile.

# v1.2.0 status

- Added: firmware update (STM32F0/F1/F2/F3/F4, nRF52), hex viewer, automatic slower-speed SWD retries,
  one-bit sample-offset calibration in SWD connect.
- Verified here: static checks, `npm run test:sim` (18 checks), App.tsx type-checked against stubs.
- NOT verified: EAS build with the new dependencies, anything on real flash hardware. See TESTING.md.
- Before building: `npm install` (package-lock.json is stale for the 3 new dependencies).

---

# BUILD STATUS — configs corrected (still not compiled here)

This sandbox has no network/Gradle/EAS access, so **no build was run**. All fixes below
are static config corrections verified by JSON parsing and file inspection.

## Fixes applied

1. **app.json (Expo SDK 53 schema)**
   - Removed invalid `android.minSdkVersion` and `android.usesCleartextTraffic`
     (they caused the `expo doctor` schema failure). minSdk is set by the library's
     Gradle config; cleartext was disabled anyway (`false`), so nothing was lost —
     if cleartext is ever truly needed it must go in AndroidManifest via a config
     plugin, not app.json.
   - Added `expo.icon` and `android.adaptiveIcon` (foreground = ./assets/icon.png,
     background #0F1115). The supplied J-Link PNG is installed at `assets/icon.png`.
   - USB host feature (`android.hardware.usb.host`, required) is still enforced by
     `plugins/withUsbHost.js` (now importing `expo/config-plugins`).

2. **package.json**
   - `react-native` 0.79.5 → **0.79.6** (SDK 53 expected version).
   - Added direct dependency `expo-modules-core@~2.3.13` (SDK 53 compatible;
     satisfies jlink-usb peer dependency). Run `npx expo install expo-modules-core`
     locally to re-resolve the exact patch if preferred.
   - Removed direct `@expo/config-plugins@~10.0.0` from devDependencies; the local
     plugin uses the `expo/config-plugins` sub-export instead (resolves to ~10.1.1
     inside expo, fixing both doctor complaints).
   - `jlink-usb` stays as `file:./modules/jlink-usb` and already declares
     `expo-modules-core` in peerDependencies (verified).

3. **eas.json** — `build.preview.android.buildType` was already `"apk"` with a unique
   package `com.nikohost.jlinkrtt`. Preview produces an installable APK (no AAB).
   Production remains `app-bundle`.

4. **CNG vs native folders** — no `android/` folder exists at root, so CNG is the
   consistent workflow. Added `.gitignore` with `/android/`, `/ios/`, `node_modules/`,
   build outputs, caches so EAS always runs prebuild and doctor stays clean.

5. **Icon** — `assets/icon.png` (the supplied generated J-Link PNG, no text added).

## Clean build commands

```bash
rm -rf node_modules android ios
npm install
npx expo-doctor          # expect 17/17
eas build --platform android --profile preview
```

## Verify the download is a real APK (not HTML / not AAB)

PowerShell:
```powershell
$b = [IO.File]::ReadAllBytes("jlink-rtt-preview.apk")[0..3]
[Text.Encoding]::ASCII.GetString($b)   # must print: PK^C (PK\x03\x04) = zip/APK
Rename-Item jlink-rtt-preview.apk jlink.apk.zip; Expand-Archive jlink.apk.zip -Destination .\apkx
# apkx should contain AndroidManifest.xml, classes.dex, res/ — if you instead see HTML text, you downloaded an error page.
```
An AAB would contain `bundletool` metadata / `base/manifest`; an APK contains
`AndroidManifest.xml` and `classes.dex` at the root.

## About the earlier “package appears to be invalid” install failure

Likely causes (unresolved, the old artifact is not available for inspection):
- The failed EAS build produced **no valid APK at all** (expo doctor exited 1, so the
  "download" may have been a log/error page or a stale AAB). The config errors above
  are fixed; rebuild and check the signature with `PK\x03\x04`.
- If a rebuilt APK still fails on the Galaxy Tab S7 (Android 13): check
  `adb install -r app.apk` for the real reason, confirm arm64-v8a ABI support, and
  uninstall any previous build of `com.nikohost.jlinkrtt` first.
- Note: the plugin requires USB host hardware (`required="true"`); that does not block
  Tab S7 (it has USB host) but is intentional.

## Not done / caveats

- No compile, no EAS submission, no Gradle/Kotlin verification in this environment.
- No speculative USB protocol or native code changes were made.
