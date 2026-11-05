// Idleterino — contas do PokeIdle.
// Cada conta é uma página do jogo (pokeidle.io/app) com sessão própria ("persist:poke-<id>"), num
// WebContentsView. Só a conta aberta na tela é desenhada; as outras seguem conectadas e caçando
// sem aparecer (o jogo precisa da página ligada: a caça roda no servidor, mas pelo socket dela).
//
// Modo de tela por conta, escolha do usuário (as mesmas opções do jogo, gravadas nas preferências
// do próprio jogo antes de a página carregar): Cena ligada, Otimizado, Economia ou ULTRA Economia.
// Medido em 05/11/2026: ULTRA usa ~30% menos memória e quase nada de CPU.
//
// Regra do jogo: no máximo 4 contas por pessoa (identificadas por IP). O app trava em 4 e nunca
// oferece forma de burlar isso.
const { BrowserWindow, WebContentsView, ipcMain, session, app } = require('electron');
const path = require('path');
const fs = require('fs');

const GAME = 'https://pokeidle.io/app';
const MAX_ACCOUNTS = 4;   // regra do PokeIdle: até 4 contas por pessoa
const MAX_WINDOWS = 8;    // contas de outros sites também cabem, mas o total fica em 8 para não pesar
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const isPokeIdle = (url) => /(^|\.)pokeidle\.io$/.test(hostOf(url));
const urlOf = (a) => a.url || GAME;
const MODES = {
  cena: { 'cfg-otimizado': '0', 'cfg-economia': '0', 'cfg-ultra': '0' },
  otimizado: { 'cfg-otimizado': '1', 'cfg-economia': '0', 'cfg-ultra': '0' },
  economia: { 'cfg-otimizado': '0', 'cfg-economia': '1', 'cfg-ultra': '0' },
  ultra: { 'cfg-otimizado': '0', 'cfg-economia': '0', 'cfg-ultra': '1' },
};
const READ_MS = 30 * 1000;

// Identificação por endereço: o login do Google só aceita a identificação original do app (com
// "Electron"); o Cloudflare do jogo (verificação "Confirme que é humano") desconfia dela e falha.
// Então: páginas do Google com a original; o jogo e o resto como o Chrome que o app é.
const GOOGLE_LOGIN = /(^|\.)(google\.com|google\.[a-z.]{2,6}|youtube\.com|gstatic\.com|googleusercontent\.com)$/;
const wantsOriginalUA = (url) => GOOGLE_LOGIN.test(hostOf(url));
const sessionsWithUA = new WeakSet();

// Só o jogo e as páginas de login que ele usa abrem nas sessões das contas.
// twitch.tv e kick.com: o jogo leva para o login delas ao vincular o Bônus Twitch/Kick da conta.
const TRUSTED = ['pokeidle.io', 'challenges.cloudflare.com', 'google.com', 'accounts.google.com', 'discord.com', 'twitch.tv', 'kick.com'];
function isTrustedUrl(url) {
  if (url === 'about:blank') return true;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && TRUSTED.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch { return false; }
}

// O que a tela pede para ler de cada conta (só leitura, nada é clicado).
const READ_SCRIPT = `(() => {
  const q = (s) => document.querySelector(s);
  const txt = (s) => { const e = q(s); return e ? e.textContent.trim().replace(/\\s+/g, ' ') : null; };
  const app = q('#app');
  const logged = !!app && !app.classList.contains('hidden');
  const ativos = [...document.querySelectorAll('#tr-ativos .tr-ativo')].map((e) => ({
    kind: e.classList.contains('twitch') ? 'twitch' : e.classList.contains('kick') ? 'kick' : e.classList.contains('vip') ? 'vip'
      : e.classList.contains('passe-vip') ? 'passe' : e.classList.contains('guild-boost') ? 'guild' : 'item',
    text: e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60), title: (e.title || '').slice(0, 200),
    end: Number(e.dataset.twFim || e.dataset.kkFim) || null,
  }));
  const autos = ['auto-ball-captura', 'auto-ball-sem-parar', 'auto-revive', 'auto-potion', 'auto-voltar-hunt']
    .map((id) => { const c = q('#' + id); return c ? { id, on: !!c.checked } : null; }).filter(Boolean);
  return {
    logged, nick: txt('#tr-nick'), level: txt('#tr-level'), gold: txt('#tr-gold'), gems: txt('#tr-gemas'), diamonds: txt('#tr-diamantes'),
    xp: txt('#tr-xp-txt'), guild: txt('#tr-guild'), xpH: txt('#sessao-xp-treinador-h'), where: txt('#eco-onde'), ativos, autos,
    autoCount: txt('#auto-cnt'),
    mode: document.documentElement.classList.contains('modo-ultra') ? 'ultra'
      : localStorage.getItem('cfg-economia') === '1' ? 'economia' : localStorage.getItem('cfg-otimizado') === '1' ? 'otimizado' : 'cena',
  };
})()`;

module.exports = function createPokeIdle(ctx) {
  const configPath = () => path.join(app.getPath('userData'), 'pokeidle.json');
  const DEFAULT = { accounts: [], selected: null, autoBackgroundUltra: false, autoFreezeMin: 0 };
  let config = { ...DEFAULT };
  const loadConfig = () => { try { config = { ...DEFAULT, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch {} };
  const saveConfig = () => fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));

  let mainWin = null;
  const views = new Map();   // id -> WebContentsView
  const info = new Map();    // id -> última leitura
  const frozen = new Map();  // id -> imagem (dataURL) da tela congelada
  let visible = false;       // a página PokeIdle está aberta na tela?
  let bounds = null;         // área onde a conta aparece (vem da tela)
  let lastSeen = new Map();  // id -> quando foi vista pela última vez (para congelar sozinho)

  const send = (ch, p) => ctx.send(`poke:${ch}`, p);
  const partitionOf = (id) => `persist:poke-${id}`;
  const account = (id) => config.accounts.find((a) => a.id === id);

  // Modo que vale agora para a conta: o escolhido, ou ULTRA quando ela está no fundo (se a pessoa ligou isso).
  function effectiveMode(a) {
    const inFront = visible && config.selected === a.id;
    if (!inFront && config.autoBackgroundUltra) return 'ultra';
    return a.mode;
  }

  // Grava as preferências do jogo e recarrega quando elas não batem com o modo pedido.
  async function applyMode(id) {
    const a = account(id); const v = views.get(id);
    if (!a || !v || v.webContents.isDestroyed() || !isPokeIdle(urlOf(a))) return;
    const want = MODES[effectiveMode(a)] || MODES.cena;
    const changed = await v.webContents.executeJavaScript(`(() => { const p = ${JSON.stringify(want)}; let c = false;
      for (const k in p) if (localStorage.getItem(k) !== p[k]) { localStorage.setItem(k, p[k]); c = true; } return c; })()`).catch(() => false);
    if (changed) v.webContents.reload();
  }

  function followUA(wc) {
    if (!ctx.originalUA || wc.__idleUA) return;
    wc.__idleUA = true;
    const plain = app.userAgentFallback;
    // Troca só antes de a navegação começar (trocar no meio de um redirecionamento cancela a
    // navegação). O botão "Login com Google" do jogo vai para /auth/google, que redireciona ao Google.
    const toGoogle = (url) => wantsOriginalUA(url) || /^\/auth\/google/i.test((() => { try { return new URL(url).pathname; } catch { return ''; } })());
    const set = (want) => { if (!wc.isDestroyed() && wc.getUserAgent() !== want) wc.setUserAgent(want); };
    wc.on('will-navigate', (e, url) => {
      if (!toGoogle(url) || wc.getUserAgent() === ctx.originalUA) return;
      // Segura a navegação, troca a identificação e abre o mesmo endereço já com ela.
      e.preventDefault();
      set(ctx.originalUA);
      wc.loadURL(url);
    });
    // Voltou do Google para o jogo: as próximas cargas (e o Cloudflare) já vão como Chrome comum.
    wc.on('did-navigate', (_e, url) => { if (!toGoogle(url)) set(plain); });
    set(toGoogle(wc.getURL()) ? ctx.originalUA : plain);
  }
  app.on('web-contents-created', (_e, wc) => {
    const p = config && config.accounts.map((a) => session.fromPartition(partitionOf(a.id)));
    if (p && p.includes(wc.session)) followUA(wc);
  });

  // Zoom de cada conta: menos zoom = o jogo cabe mais coisa (layout largo, com a busca do mercado).
  const ZMIN = 0.5, ZMAX = 1.5;
  function applyZoom(id) { const a = account(id); const v = views.get(id); if (a && v && !v.webContents.isDestroyed()) v.webContents.setZoomFactor(a.zoom || 1); }
  function setZoom(id, z) {
    const a = account(id); if (!a) return;
    a.zoom = Math.round(Math.min(ZMAX, Math.max(ZMIN, Number(z) || 1)) * 100) / 100;
    saveConfig(); applyZoom(id);
  }

  function createView(a) {
    const ses = session.fromPartition(partitionOf(a.id));
    // Identificação original do app, sem mexer: o login com Google (Gmail) funciona assim, como no
    // teste de 05/11/2026; tirar o "Electron" fazia o Google recusar o login.
    if (ctx.originalUA && !sessionsWithUA.has(ses)) {
      sessionsWithUA.add(ses);
      const plain = app.userAgentFallback; // já sem o "Electron" (main.js)
      // Cabeçalho de cada pedido conforme o site de destino.
      ses.webRequest.onBeforeSendHeaders((d, cb) => {
        const h = d.requestHeaders;
        const key = Object.keys(h).find((k) => k.toLowerCase() === 'user-agent') || 'User-Agent';
        h[key] = wantsOriginalUA(d.url) ? ctx.originalUA : plain;
        cb({ requestHeaders: h });
      });
    }
    const ALLOWED = new Set(['clipboard-sanitized-write', 'notifications', 'fullscreen']);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED.has(perm)));
    ses.setPermissionCheckHandler((_wc, perm) => ALLOWED.has(perm));
    // Câmera, microfone, USB, Bluetooth, serial e HID: nunca.
    ses.setDevicePermissionHandler(() => false);
    const gameHost = hostOf(urlOf(a));
    ctx.registerTrust(partitionOf(a.id), (url) => isTrustedUrl(url) || hostOf(url) === gameHost || hostOf(url).endsWith(`.${gameHost}`));
    const v = new WebContentsView({ webPreferences: { partition: partitionOf(a.id), backgroundThrottling: false, spellcheck: false } });
    v.setBackgroundColor('#090a0f');
    followUA(v.webContents);
    v.webContents.setAudioMuted(!!a.muted);
    v.webContents.on('did-finish-load', () => { applyZoom(a.id); applyMode(a.id); setTimeout(() => readOne(a.id), 4000); });
    // Ctrl + rodinha do mouse dentro do jogo também muda o zoom (e fica salvo na conta).
    v.webContents.on('zoom-changed', (_e, dir) => { setZoom(a.id, (account(a.id) || {}).zoom + (dir === 'in' ? 0.1 : -0.1)); send('status', snapshot()); });
    // Caiu ou não carregou: tenta de novo sozinho (a conta precisa ficar conectada).
    const retry = () => setTimeout(() => { if (views.get(a.id) === v && !v.webContents.isDestroyed()) v.webContents.loadURL(urlOf(a)); }, 20 * 1000);
    v.webContents.on('render-process-gone', retry);
    v.webContents.on('did-fail-load', (_e, code, _d, _u, main) => { if (main && code !== -3) retry(); });
    // Primeiro as extensões que o usuário ligou, depois o jogo (para elas valerem desde o começo).
    Promise.resolve(ctx.applyExtensions ? ctx.applyExtensions(partitionOf(a.id)) : null).catch(() => {}).finally(() => { if (!v.webContents.isDestroyed()) v.webContents.loadURL(urlOf(a)); });
    views.set(a.id, v);
    return v;
  }

  // Coloca na janela só a conta aberta (as outras ficam fora, sem desenhar).
  function layout() {
    if (!mainWin || mainWin.isDestroyed()) return;
    const cv = mainWin.contentView;
    for (const [id, v] of views) {
      const show = visible && bounds && config.selected === id && !frozen.has(id);
      const attached = cv.children.includes(v);
      if (show) { if (!attached) cv.addChildView(v); v.setBounds(bounds); lastSeen.set(id, Date.now()); }
      else if (attached) cv.removeChildView(v);
    }
  }

  async function readOne(id) {
    const v = views.get(id);
    const acc = account(id);
    if (!v || v.webContents.isDestroyed() || !acc || !isPokeIdle(urlOf(acc))) return;
    const r = await v.webContents.executeJavaScript(READ_SCRIPT).catch(() => null);
    if (r) { info.set(id, { ...r, at: Date.now() }); send('status', snapshot()); }
  }
  async function readAll() { for (const id of views.keys()) await readOne(id); autoFreeze(); }

  // Congelar: foto da tela no lugar da página, que para de ser desenhada. Um clique volta.
  async function freeze(id) {
    const v = views.get(id);
    if (!v) return;
    let url = null;
    try { url = (await v.webContents.capturePage()).toDataURL(); } catch {}
    frozen.set(id, url || '');
    layout();
    send('status', snapshot());
  }
  function unfreeze(id) { frozen.delete(id); layout(); send('status', snapshot()); }
  function autoFreeze() {
    if (!config.autoFreezeMin) return;
    const limit = config.autoFreezeMin * 60 * 1000;
    for (const a of config.accounts) {
      if (frozen.has(a.id) || (visible && config.selected === a.id)) continue;
      if (Date.now() - (lastSeen.get(a.id) || 0) > limit) frozen.set(a.id, '');
    }
  }

  function snapshot() {
    return {
      max: MAX_ACCOUNTS, selected: config.selected, autoBackgroundUltra: config.autoBackgroundUltra, autoFreezeMin: config.autoFreezeMin,
      pokeCount: config.accounts.filter((a) => isPokeIdle(urlOf(a))).length, maxWindows: MAX_WINDOWS, defaultUrl: GAME,
      accounts: config.accounts.map((a) => ({ ...a, url: urlOf(a), isPoke: isPokeIdle(urlOf(a)), host: hostOf(urlOf(a)), effectiveMode: effectiveMode(a), zoom: a.zoom || 1, info: info.get(a.id) || null, frozen: frozen.has(a.id), frozenImg: frozen.get(a.id) || null })),
    };
  }

  // ---------- IPC ----------
  ipcMain.handle('poke:state', () => snapshot());
  ipcMain.handle('poke:add', (_e, name, rawUrl) => {
    let url = String(rawUrl || GAME).trim();
    // Outro protocolo (ftp:, file:, javascript:…) não entra; sem protocolo, vira https://.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) return { ...snapshot(), error: 'Use um endereço que comece com https://' };
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !/\.[a-z]{2,}$/i.test(u.hostname)) throw 0;
      url = u.href;
    } catch { return { ...snapshot(), error: 'Endereço inválido' }; }
    if (isPokeIdle(url) && config.accounts.filter((a) => isPokeIdle(urlOf(a))).length >= MAX_ACCOUNTS) return { ...snapshot(), error: 'O PokeIdle permite até 4 contas por pessoa.' };
    if (config.accounts.length >= MAX_WINDOWS) return { ...snapshot(), error: `Máximo de ${MAX_WINDOWS} contas no app.` };
    const id = Math.random().toString(36).slice(2, 10);
    const a = { id, url, name: String(name || `Conta ${config.accounts.length + 1}`).slice(0, 24), mode: config.accounts.length ? 'ultra' : 'cena', muted: true };
    config.accounts.push(a);
    config.selected = id;
    saveConfig();
    createView(a);
    layout();
    return snapshot();
  });
  ipcMain.handle('poke:remove', async (_e, id) => {
    const v = views.get(id);
    if (v) { if (mainWin && mainWin.contentView.children.includes(v)) mainWin.contentView.removeChildView(v); v.webContents.close(); views.delete(id); }
    // Apaga o login e os dados desta conta neste PC.
    try { await session.fromPartition(partitionOf(id)).clearStorageData(); } catch {}
    config.accounts = config.accounts.filter((a) => a.id !== id);
    if (config.selected === id) config.selected = config.accounts[0] ? config.accounts[0].id : null;
    info.delete(id); frozen.delete(id);
    saveConfig();
    layout();
    return snapshot();
  });
  ipcMain.handle('poke:rename', (_e, id, name) => { const a = account(id); if (a) { a.name = String(name || a.name).slice(0, 24); saveConfig(); } return snapshot(); });
  ipcMain.handle('poke:select', (_e, id) => {
    const prev = config.selected;
    config.selected = account(id) ? id : config.selected;
    saveConfig();
    layout();
    // Com o "ULTRA no fundo", a que saiu da frente e a que entrou trocam de modo.
    if (config.autoBackgroundUltra) { if (prev && prev !== id) applyMode(prev); applyMode(id); }
    return snapshot();
  });
  ipcMain.handle('poke:mode', (_e, id, mode) => {
    const a = account(id);
    if (a && MODES[mode]) { a.mode = mode; saveConfig(); applyMode(id); }
    return snapshot();
  });
  ipcMain.handle('poke:zoom', (_e, id, z) => { setZoom(id, z); return snapshot(); });
  ipcMain.handle('poke:mute', (_e, id, muted) => { const a = account(id); const v = views.get(id); if (a) { a.muted = !!muted; saveConfig(); if (v) v.webContents.setAudioMuted(a.muted); } return snapshot(); });
  ipcMain.handle('poke:autoBackgroundUltra', (_e, on) => { config.autoBackgroundUltra = !!on; saveConfig(); for (const a of config.accounts) applyMode(a.id); return snapshot(); });
  ipcMain.handle('poke:autoFreezeMin', (_e, n) => { config.autoFreezeMin = Math.max(0, Math.min(120, Number(n) || 0)); saveConfig(); return snapshot(); });
  ipcMain.handle('poke:freeze', (_e, id) => freeze(id).then(snapshot));
  ipcMain.handle('poke:unfreeze', (_e, id) => { unfreeze(id); return snapshot(); });
  ipcMain.handle('poke:reload', (_e, id) => { const v = views.get(id); if (v) v.webContents.reload(); return snapshot(); });
  // A tela diz onde a conta aparece e se a página PokeIdle está aberta.
  ipcMain.handle('poke:view', (_e, isVisible, rect) => {
    const wasVisible = visible;
    visible = !!isVisible;
    bounds = rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : bounds;
    layout();
    if (wasVisible !== visible && config.autoBackgroundUltra && config.selected) applyMode(config.selected);
    return true;
  });

  const timers = [];
  function start() {
    loadConfig();
    for (const a of config.accounts) createView(a);
    timers.push(setInterval(readAll, READ_MS));
  }
  return {
    partitions: () => config.accounts.map((a) => partitionOf(a.id)),
    reloadAll: () => { for (const v of views.values()) if (!v.webContents.isDestroyed()) v.webContents.reload(); },
    start, snapshot, setMain: (w) => { mainWin = w; mainWin.on('resize', () => send('relayout', true)); },
    trayInfo: () => ({ accounts: config.accounts.length }),
  };
};
