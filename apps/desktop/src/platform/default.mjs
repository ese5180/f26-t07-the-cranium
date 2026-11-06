/**
 * What the app does the same on every system, where a system's own module (win32.mjs or linux.mjs, each
 * added with its platform's packaging) does not say otherwise. main.mjs takes this module,
 * then the system's over it: a platform changes only its own file.
 *
 *   beforeReady({ app })              before Electron is ready: command-line switches
 *   windowOptions()                   more BrowserWindow options
 *   menuTemplate(context)             the application menu
 *   quitWhenAllClosed                 true: closing the last window quits
 *   afterReady({ app, open })         once ready; `open()` opens the window again
 */

export function beforeReady() {}

export function windowOptions() {
  return {};
}

export const quitWhenAllClosed = true;

export function afterReady() {}

/**
 * @param {{ name: string, isPackaged: boolean, settings(): void, reloadPages(): void, about(): void }} context
 */
export function menuTemplate({ name, isPackaged, settings, reloadPages, about }) {
  return [
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: settings },
        { label: 'Reload the pages', accelerator: 'CmdOrCtrl+R', click: reloadPages },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${name}` },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: `About ${name}`, click: about }] },
  ];
}
