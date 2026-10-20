const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Ensures the generated AndroidManifest.xml declares USB host support as REQUIRED.
 * Without this the Play Store / package manager may install the APK on devices
 * that lack an OTG-capable USB host controller, where USB serial probes are useless.
 */
module.exports = function withUsbHost(config) {
  return withAndroidManifest((config ?? {}), (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest['uses-feature']) {
      manifest['uses-feature'] = [];
    }
    const NAME = 'android.hardware.usb.host';
    const existing = manifest['uses-feature'].filter(
      (f) => f && f.$ && f.$['android:name'] === NAME,
    );
    if (existing.length === 0) {
      manifest['uses-feature'].push({
        $: { 'android:name': NAME, 'android:required': 'true' },
      });
    } else {
      existing[0].$['android:required'] = 'true';
    }
    return cfg;
  });
};
