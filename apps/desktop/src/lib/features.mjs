/**
 * What the desktop app offers of the bridge (apps/shared/bridge.json), and so which methods it answers.
 * main.mjs builds its handlers to exactly this list, and test/bridge.test.mjs holds the list to the
 * contract: every method of an offered feature, and the ones of no feature, and nothing else.
 *
 *   auth, clipboard, share, open, keepAwake, settings, ble   on Windows and Linux alike
 *   biometric                                                 no: Electron reaches neither Windows Hello
 *                                                             nor a Linux fingerprint reader
 *   haptics, appUpdate                                        no: no motor, and the app does not replace
 *                                                             itself (lib/updates.mjs)
 *   usb                                                       no: the window has Web Serial itself, which
 *                                                             the Serial console and Board setup use
 *   storage                                                   no: the pages' own storage lasts here (the
 *                                                             bundle's scheme is a standard one, kept in the
 *                                                             app's profile), so they keep the journal there
 *   camera                                                    no: a computer scans no board's QR code; its
 *                                                             label is printed from here, and the Devices
 *                                                             page lists the boards to open
 */

export const FEATURES = Object.freeze(['auth', 'clipboard', 'share', 'open', 'keepAwake', 'settings', 'ble']);
export const NOT_OFFERED = Object.freeze(['biometric', 'haptics', 'appUpdate', 'storage', 'usb', 'camera']);

export const METHODS = Object.freeze([
  'app.config',
  'app.hello',
  'app.keepAwake',
  'app.open',
  'app.ready',
  'app.reload',
  'app.settings',
  'auth.session',
  'auth.signOut',
  'auth.store',
  'ble.cancel',
  'ble.connect',
  'ble.disconnect',
  'ble.images',
  'ble.scan',
  'ble.state',
  'ble.status',
  'ble.upload',
  'ble.watch',
  'clipboard.write',
  'file.share',
]);

/** The word app.hello gives for the system: windows or linux, and Node's own word elsewhere (a checkout only). */
export function platformWord(platform) {
  return { win32: 'windows', linux: 'linux' }[platform] ?? platform;
}
