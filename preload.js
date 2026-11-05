// Ponte entre a tela e o app: só canais com prefixo conhecido passam.
const { contextBridge, ipcRenderer } = require('electron');
const OK = /^(app|twitch|kick|poke):[A-Za-z:]+$/;

contextBridge.exposeInMainWorld('idle', {
  invoke: (channel, ...args) => (OK.test(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('canal bloqueado'))),
  on: (channel, cb) => { if (OK.test(channel)) ipcRenderer.on(channel, (_e, payload) => cb(payload)); },
});
