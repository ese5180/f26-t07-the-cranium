/**
 * What the desktop app does on Linux only (docs/desktop-linux.md), over platform/default.mjs.
 *
 * Web Bluetooth: Chromium has it on Linux, through BlueZ, but only when asked. Without these switches
 * navigator.bluetooth is missing on Linux, and the console's Bluetooth page says the computer has no
 * Bluetooth. WebBluetooth is the feature; the experimental web platform features are what Chromium's own
 * Linux builds still look for before they offer it. Both must be set before Electron is ready.
 */

export function beforeReady({ app }) {
  app.commandLine.appendSwitch('enable-features', 'WebBluetooth');
  app.commandLine.appendSwitch('enable-experimental-web-platform-features');
}
