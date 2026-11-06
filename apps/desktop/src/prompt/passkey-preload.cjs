// The passkey box's one way out: its answer, once (main.mjs, the pairing handler).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let answered = false;
contextBridge.exposeInMainWorld('passkey', {
  answer(pin) {
    if (answered) return;
    answered = true;
    ipcRenderer.send('cranium-passkey', typeof pin === 'string' && /^[0-9]{6}$/.test(pin) ? pin : null);
  },
});
