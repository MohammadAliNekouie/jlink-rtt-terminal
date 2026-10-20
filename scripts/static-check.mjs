// Static sanity checks runnable with plain node (no npm install needed).
// Usage: node scripts/static-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg); if (!cond) failures++; };

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

// 1. All JSON files parse.
for (const p of ['package.json', 'app.json', 'eas.json',
                 'modules/jlink-usb/package.json', 'modules/jlink-usb/expo-module.config.json']) {
  try { readJson(p); ok(true, p + ' parses as JSON'); }
  catch (e) { ok(false, p + ' JSON parse: ' + e.message); }
}

// 2. Dependency wiring.
const pkg = readJson('package.json');
ok(pkg.dependencies.expo.startsWith('~53'), 'expo ~53');
ok(pkg.dependencies['react-native'] === '0.79.6', 'react-native 0.79.6');
ok(pkg.dependencies.react === '19.0.0', 'react 19.0.0');
ok(pkg.dependencies['jlink-usb'] === 'file:./modules/jlink-usb', 'local module file dep');
ok(pkg.main === 'node_modules/expo/AppEntry.js', 'entry expo/AppEntry');

// 3. Module export shape matches src/native.ts usage (default export of requireNativeModule('JLinkUsb')).
const modIndex = fs.readFileSync(path.join(root, 'modules/jlink-usb/index.js'), 'utf8');
ok(/requireNativeModule\(['\"]JLinkUsb['\"]\)/.test(modIndex), "module index requires 'JLinkUsb'");
ok(/export default/.test(modIndex), 'module index default export');
const nativeTs = fs.readFileSync(path.join(root, 'src/native.ts'), 'utf8');
ok(nativeTs.includes("requireNativeModule<JLinkUsbNative>('JLinkUsb')"), 'src/native.ts matches module name');

// 4. Config plugin registered and forces required=true.
const appJson = readJson('app.json');
ok(appJson.expo.plugins.includes('./plugins/withUsbHost'), 'plugin registered in app.json');
ok((appJson.expo.android?.package ?? '').includes('.'), 'android package set');
const plugin = fs.readFileSync(path.join(root, 'plugins/withUsbHost.js'), 'utf8');
ok(plugin.includes("'android:required': 'true'"), 'plugin sets usb host required=true');
ok(plugin.includes('android.hardware.usb.host'), 'plugin names usb host feature');

// 5. Library manifest declares the feature too.
const libManifest = fs.readFileSync(
  path.join(root, 'modules/jlink-usb/android/src/main/AndroidManifest.xml'), 'utf8');
ok(libManifest.includes('android.hardware.usb.host'), 'library manifest declares usb host');
ok(libManifest.includes('android:required="true"'), 'library manifest required=true');

// 6. Gradle basics.
const gradle = fs.readFileSync(path.join(root, 'modules/jlink-usb/android/build.gradle'), 'utf8');
ok(gradle.includes("namespace 'expo.modules.jlinkusb'"), 'gradle namespace');
ok(/minSdkVersion|safeExtGet\('minSdkVersion'/.test(gradle), 'gradle minSdk 24 pattern');
ok(gradle.includes('expo-modules-core'), 'gradle depends on expo-modules-core');
ok(gradle.includes('kotlin-android'), 'gradle kotlin plugin');

// 7. expo-module.config.json module class matches Kotlin package/class.
const emc = readJson('modules/jlink-usb/expo-module.config.json');
ok(emc.android?.modules?.[0] === 'expo.modules.jlinkusb.JLinkUsbModule', 'expo-module.config module class');
const ktPath = 'modules/jlink-usb/android/src/main/java/expo/modules/jlinkusb/JLinkUsbModule.kt';
ok(fs.existsSync(path.join(root, ktPath)), 'Kotlin module file exists');
const kt = fs.readFileSync(path.join(root, ktPath), 'utf8');
ok(kt.includes('package expo.modules.jlinkusb'), 'kotlin package matches config');

// 8. App entry file exists and imports local src (no expo-status-bar requirement).
ok(fs.existsSync(path.join(root, 'App.tsx')), 'App.tsx exists');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
