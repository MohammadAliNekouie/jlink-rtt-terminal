# BUILD STATUS — NOT VERIFIED

**This project has never been compiled, built, or run.** The workspace where the
sources were authored had only `node` available. Everything below is
static/structural work only.

## Toolchain availability at authoring time

| Tool | Status |
|---|---|
| node | available (used for JSON parsing + static checks) |
| npm | NOT available |
| typescript (tsc) | NOT available — `npm run typecheck` has never run |
| Gradle | NOT available |
| Java / JDK | NOT available |
| Android SDK / NDK | NOT available |
| EAS CLI | NOT available — no EAS build has been attempted |

Consequences:

- `npm install` has never run; `node_modules/` is absent.
- TypeScript in `App.tsx` and `src/*.ts` is **not type-checked**.
- The Kotlin module was **never compiled**; Kotlin/Gradle errors are possible.
- `expo prebuild` was never run, so the config plugin output is unverified.
- No APK was ever produced; no EAS build was submitted.

## What was actually verified

- All JSON files (`package.json`, `app.json`, `eas.json`,
  `modules/jlink-usb/package.json`, `expo-module.config.json`) parse with `node`.
- `node scripts/static-check.mjs` passes: dependency pins (Expo SDK 53 /
  react-native 0.79.5 / react 19.0.0), `file:./modules/jlink-usb` wiring,
  `requireNativeModule('JLinkUsb')` export shape matching `src/native.ts`,
  plugin registration in `app.json`, USB-host `required="true"` in both the
  plugin and the library manifest, Gradle namespace/minSdk/expo-modules-core
  references, and the Kotlin class path matching `expo-module.config.json`.
- The zip archive contents were verified with Python `zipfile`.

## First real build steps

1. `npm install` (Node >= 18, npm available).
2. `npm run typecheck` — fix any TS errors.
3. `npx expo prebuild --platform android --clean` and inspect
   `android/app/src/main/AndroidManifest.xml` for the `uses-feature` element.
4. `npx expo run:android` on a real device with an attached probe.
5. Then attempt the EAS preview APK per README.
