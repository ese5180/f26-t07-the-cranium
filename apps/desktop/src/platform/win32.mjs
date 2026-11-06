/**
 * What the desktop app does on Windows only (docs/desktop-windows.md), over platform/default.mjs.
 *
 * The app's own id, the one its installer gives its Start menu entry (electron-builder's appId): Windows
 * groups the app's windows and its notifications under it, and not under Electron's.
 */

export function beforeReady({ app }) {
  app.setAppUserModelId('com.craniumiot.cranium.desktop');
}
