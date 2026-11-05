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
    // O placar da sessão que o próprio jogo grava (o mesmo do painel do modo Economia).
    sess: (() => { try { const n = txt('#tr-nick'); const o = n && JSON.parse(localStorage.getItem('sessao-hunt:' + n.toLowerCase()) || 'null');
      return o && o.ms > 0 ? { ms: o.ms, xpTreinador: +o.xpTreinador || 0, xpPokemon: +o.xpPokemon || 0, gold: +o.gold || 0, abates: +o.abates || 0, capturas: +o.capturas || 0, shVistos: +o.shiniesVistos || 0, shCapt: +o.shinies || 0, lucroH: txt('#sessao-lucro-h') } : null; } catch { return null; } })(),
    evento: (() => { const f = q('#evento-faixa'); return f && !f.classList.contains('hidden') ? { texto: txt('#evento-texto'), tempo: txt('#evento-tempo') } : null; })(),
    bonusXp: (() => { try { return window.__idleterinoMercado ? window.__idleterinoMercado.bonusXp() : null; } catch { return null; } })(),
    hunts: (() => { try { return window.__idleterinoMercado ? window.__idleterinoMercado.hunts() : null; } catch { return null; } })(),
    canais: (() => { try { return window.__idleterinoMercado ? window.__idleterinoMercado.canais() : null; } catch { return null; } })(),
    mercado: (() => { try { const r = window.__idleterinoMercado && window.__idleterinoMercado.ler(); if (!r) return null;
      const out = {};
      if (r.meus) out.meus = { at: r.meus.at, linhas: (r.meus.m.linhas || []).slice(0, 40).map((a) => ({ id: a.id, tipo: a.tipo, nome: (a.ficha && (a.ficha.nome || (a.ficha.casaId ? 'Casa' : a.ficha.caixaId ? 'Caixa' : ''))) || a.nome || '—', level: a.ficha && a.ficha.level, shiny: !!(a.ficha && a.ficha.shiny), qtd: a.qtd || 1, preco: a.preco, moeda: a.moeda, retidoAte: a.compravelEm || 0, favoritos: a.favoritos })) };
      const hist = (m) => (m.linhas || []).slice(0, 30).map((l) => ({ em: l.em, tipo: l.tipo, descricao: l.descricao, shiny: !!(l.ficha && l.ficha.shiny), bruto: l.bruto, moeda: l.moeda, vendedor: l.vendedor, comprador: l.comprador }));
      if (r.historico) out.vendas = { at: r.historico.at, linhas: hist(r.historico.m) };
      const g = Object.keys(r).filter((k) => k.indexOf('historicoGlobal:') === 0).map((k) => r[k]);
      if (g.length) out.global = { at: Math.max(...g.map((x) => x.at)), linhas: g.flatMap((x) => hist(x.m)) };
      return out; } catch { return null; } })(),
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
  // Contas na tela: só a escolhida, ou várias lado a lado ("Ver juntas": a tela manda um retângulo por conta).
  let tiles = null; // { id: {x,y,width,height} } no modo juntas
  const isShown = (id) => visible && (tiles ? !!tiles[id] : config.selected === id);
  function effectiveMode(a) {
    const inFront = isShown(a.id);
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
    const v = new WebContentsView({ webPreferences: { partition: partitionOf(a.id), preload: path.join(__dirname, 'poke-preload.js'), backgroundThrottling: false, spellcheck: false } });
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
      const rect = tiles ? tiles[id] : (config.selected === id ? bounds : null);
      const show = visible && rect && !frozen.has(id);
      const attached = cv.children.includes(v);
      if (show) { if (!attached) cv.addChildView(v); v.setBounds(rect); lastSeen.set(id, Date.now()); }
      else if (attached) cv.removeChildView(v);
    }
  }

  let huntLevels = []; // [{ nome, nivel }] do jogo, em ordem de nível
  async function readOne(id) {
    setTimeout(() => readHunt(id).catch(() => {}), 1500);
    const v = views.get(id);
    const acc = account(id);
    if (!v || v.webContents.isDestroyed() || !acc || !isPokeIdle(urlOf(acc))) return;
    const r = await v.webContents.executeJavaScript(READ_SCRIPT).catch(() => null);
    if (r) {
      const canais = r.canais; delete r.canais;
      if (Array.isArray(r.hunts) && r.hunts.length) huntLevels = r.hunts;
      delete r.hunts;
      const prev = info.get(id);
      info.set(id, { ...r, at: Date.now(), huntRank: prev ? prev.huntRank : null });
      if (canais && ctx.onOfficial) { try { ctx.onOfficial(canais, id); } catch {} }
      send('status', snapshot());
    }
  }
  async function readAll() { for (const id of views.keys()) await readOne(id); autoFreeze(); }

  // Sugestão de hunt de cada conta (AoE, bicicleta, efetividade e as contas do jogo), a cada 2 min.
  const lastHunt = new Map();
  async function readHunt(id) {
    const v = views.get(id);
    const acc = account(id);
    if (!v || v.webContents.isDestroyed() || !acc || !isPokeIdle(urlOf(acc))) return;
    if (Date.now() - (lastHunt.get(id) || 0) < 2 * 60 * 1000) return;
    const r = await v.webContents.executeJavaScript('window.__idleterinoMercado ? window.__idleterinoMercado.huntRank() : null').catch(() => null);
    if (r && r.pronto) lastHunt.set(id, Date.now());
    if (r && r.pronto) { const cur = info.get(id); if (cur) { cur.huntRank = r; send('status', snapshot()); } }
  }

  // ---------- PvP: meta do top 50, lida pela conta principal uma vez por dia ----------
  // Só as consultas que o jogo faz na tela de PvP (a tabela) e no perfil público de um jogador, uma a
  // cada 5 s. O resultado fica salvo neste PC (pvp-meta.json) e a aba PvP mostra sem esperar.
  const PVP_N = 50;
  const PVP_EVERY = 24 * 60 * 60 * 1000;
  const pvpPath = () => path.join(app.getPath('userData'), 'pvp-meta.json');
  let pvpMeta = null;
  try { pvpMeta = JSON.parse(fs.readFileSync(pvpPath(), 'utf8')); } catch {}
  let pvpRunning = false;
  const mainAccId = () => (account(config.mainId) ? config.mainId : (config.accounts.find((a) => isPokeIdle(urlOf(a))) || {}).id);
  async function pvpCollect(force = false) {
    if (pvpRunning) return false;
    if (!force && pvpMeta && Date.now() - pvpMeta.at < PVP_EVERY) return false;
    const id = mainAccId();
    const v = id && views.get(id);
    if (!v || v.webContents.isDestroyed()) return false;
    pvpRunning = true;
    send('status', snapshot());
    try {
      const r = await v.webContents.executeJavaScript(`window.__idleterinoMercado ? window.__idleterinoMercado.pvpColetar(${PVP_N}, 5000) : { ok: false }`).catch(() => null);
      if (!r || !r.ok) return false;
      const d = await v.webContents.executeJavaScript('window.__idleterinoMercado.pvpLer()').catch(() => null);
      if (!d || !d.linhas || !d.linhas.length) return false;
      pvpMeta = { at: Date.now(), linhas: d.linhas.slice(0, PVP_N), perfis: d.perfis, info: d.info, tabelaTipos: d.tabelaTipos };
      fs.writeFileSync(pvpPath(), JSON.stringify(pvpMeta));
      return true;
    } finally { pvpRunning = false; send('status', snapshot()); }
  }
  // Dados ao vivo da conta (os pokémon dela, o PvP dela) + o meta salvo.
  async function pvpGet(accId) {
    const id = account(accId) ? accId : mainAccId();
    const v = id && views.get(id);
    let live = null, prog = null;
    if (v && !v.webContents.isDestroyed()) {
      const ids = pvpMeta ? [...new Set(Object.values(pvpMeta.perfis || {}).flatMap((p) => (p.time || []).map((k) => k.speciesId)))] : [];
      live = await v.webContents.executeJavaScript(`window.__idleterinoMercado ? window.__idleterinoMercado.pvpLer(${JSON.stringify(ids)}) : null`).catch(() => null);
      const mv = views.get(mainAccId());
      if (pvpRunning && mv && !mv.webContents.isDestroyed()) prog = await mv.webContents.executeJavaScript('window.__idleterinoMercado.pvpEstado()').catch(() => null);
    }
    return { meta: pvpMeta, running: pvpRunning, prog, accountId: id, live: live && !live.erro ? { meus: live.meus, info: live.info, euPvp: live.euPvp, nick: live.nick, nivel: live.nivel, tabelaTipos: live.tabelaTipos } : null };
  }

  // Mercado no Início: as mesmas consultas dos botões do mercado do jogo, pela conexão da própria
  // conta, a cada 10 min (bem menos do que abrir o mercado na mão). "Meus anúncios" e "Histórico de
  // vendas" de cada conta; a Tabela de preços (3 páginas) só pela principal.
  const MARKET_MS = 10 * 60 * 1000;
  let lastMarket = 0;
  const ask = (v, t, pagina) => v.webContents.executeJavaScript(`!!(window.__idleterinoMercado && window.__idleterinoMercado.pedir(${JSON.stringify(t)}, ${Number(pagina) || 0}))`).catch(() => false);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function askMarket() {
    lastMarket = Date.now();
    const mainId = account(config.mainId) ? config.mainId : (config.accounts[0] || {}).id;
    for (const a of config.accounts) {
      const v = views.get(a.id);
      if (!v || v.webContents.isDestroyed() || !isPokeIdle(urlOf(a))) continue;
      await ask(v, 'market.meus'); await wait(1500);
      await ask(v, 'market.historico', 0); await wait(1500);
      if (a.id === mainId) for (const p of [0, 1, 2]) { await ask(v, 'market.historicoGlobal', p); await wait(1500); }
    }
    setTimeout(readAll, 3000);
  }

  // Voto no TopIdle: o jogo abre o link de votar no navegador (main.js). Guardamos quando cada conta
  // abriu o voto, para o Início avisar quando liberar de novo (25h).
  const VOTE_MS = 25 * 60 * 60 * 1000;
  function noteOutside(partition, url) {
    let u; try { u = new URL(url); } catch { return; }
    if (!/(^|\.)topidle\.com$/.test(u.hostname)) return;
    const a = config.accounts.find((x) => partitionOf(x.id) === partition);
    if (!a) return;
    config.votes = { ...(config.votes || {}), [a.id]: { at: Date.now(), url: u.href } };
    saveConfig(); send('status', snapshot());
  }

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
      if (frozen.has(a.id) || isShown(a.id)) continue;
      if (Date.now() - (lastSeen.get(a.id) || 0) > limit) frozen.set(a.id, '');
    }
  }

  function snapshot() {
    return {
      max: MAX_ACCOUNTS, selected: config.selected,
      mainId: account(config.mainId) ? config.mainId : (config.accounts[0] ? config.accounts[0].id : null), autoBackgroundUltra: config.autoBackgroundUltra, autoFreezeMin: config.autoFreezeMin,
      pokeCount: config.accounts.filter((a) => isPokeIdle(urlOf(a))).length, maxWindows: MAX_WINDOWS, defaultUrl: GAME,
      voteMs: VOTE_MS, marketAt: lastMarket, hunts: huntLevels, pvpAt: pvpMeta ? pvpMeta.at : 0, pvpRunning,
      accounts: config.accounts.map((a) => ({ ...a, vote: (config.votes || {})[a.id] || null, url: urlOf(a), isPoke: isPokeIdle(urlOf(a)), host: hostOf(urlOf(a)), effectiveMode: effectiveMode(a), zoom: a.zoom || 1, info: info.get(a.id) || null, frozen: frozen.has(a.id), frozenImg: frozen.get(a.id) || null })),
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
  // Conta principal: a pessoa escolhe; sem escolha, é a primeira conta adicionada.
  ipcMain.handle('poke:main', (_e, id) => { if (account(id)) { config.mainId = id; saveConfig(); } return snapshot(); });
  ipcMain.handle('poke:zoom', (_e, id, z) => { setZoom(id, z); return snapshot(); });
  ipcMain.handle('poke:mute', (_e, id, muted) => { const a = account(id); const v = views.get(id); if (a) { a.muted = !!muted; saveConfig(); if (v) v.webContents.setAudioMuted(a.muted); } return snapshot(); });
  ipcMain.handle('poke:autoBackgroundUltra', (_e, on) => { config.autoBackgroundUltra = !!on; saveConfig(); for (const a of config.accounts) applyMode(a.id); return snapshot(); });
  ipcMain.handle('poke:autoFreezeMin', (_e, n) => { config.autoFreezeMin = Math.max(0, Math.min(120, Number(n) || 0)); saveConfig(); return snapshot(); });
  ipcMain.handle('poke:freeze', (_e, id) => freeze(id).then(snapshot));
  ipcMain.handle('poke:unfreeze', (_e, id) => { unfreeze(id); return snapshot(); });
  ipcMain.handle('poke:reload', (_e, id) => { const v = views.get(id); if (v) v.webContents.reload(); return snapshot(); });
  // A tela diz onde a conta aparece e se a página PokeIdle está aberta.
  const toRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
  ipcMain.handle('poke:market:refresh', () => { if (Date.now() - lastMarket > 60 * 1000) askMarket(); return snapshot(); });
  ipcMain.handle('poke:vote', (_e, id) => {
    const v = (config.votes || {})[id];
    if (v && ctx.openOutside) { ctx.openOutside(v.url); config.votes[id] = { ...v, at: Date.now() }; saveConfig(); }
    return snapshot();
  });
  ipcMain.handle('poke:pvp:get', (_e, accId) => pvpGet(accId));
  ipcMain.handle('poke:pvp:refresh', () => {
    if (pvpRunning) return { ok: true, running: true };
    if (pvpMeta && Date.now() - pvpMeta.at < 30 * 60 * 1000) return { ok: false, error: 'O meta foi atualizado há pouco. Dá para pedir de novo 30 min depois da última leitura.' };
    pvpCollect(true).catch(() => {});
    return { ok: true, running: true };
  });
  ipcMain.handle('poke:view', (_e, isVisible, rect, tileRects) => {
    const before = config.accounts.map((a) => isShown(a.id)).join();
    visible = !!isVisible;
    bounds = rect ? toRect(rect) : bounds;
    tiles = null;
    if (tileRects && typeof tileRects === 'object') {
      tiles = {};
      for (const [id, r] of Object.entries(tileRects)) if (account(id) && r && r.width > 0 && r.height > 0) tiles[id] = toRect(r);
    }
    layout();
    // Quem entrou ou saiu da tela troca de modo (se "ULTRA automático no fundo" estiver ligado).
    if (config.autoBackgroundUltra && before !== config.accounts.map((a) => isShown(a.id)).join()) for (const a of config.accounts) applyMode(a.id);
    return true;
  });

  const timers = [];
  function start() {
    loadConfig();
    for (const a of config.accounts) createView(a);
    timers.push(setInterval(readAll, READ_MS));
    setTimeout(askMarket, 60 * 1000);
    // PvP: confere de hora em hora se o meta tem mais de um dia; a primeira, 3 min depois de abrir.
    setTimeout(() => pvpCollect().catch(() => {}), 3 * 60 * 1000);
    timers.push(setInterval(() => pvpCollect().catch(() => {}), 60 * 60 * 1000));
    timers.push(setInterval(askMarket, MARKET_MS));
  }
  return {
    partitions: () => config.accounts.map((a) => partitionOf(a.id)),
    reloadAll: () => { for (const v of views.values()) if (!v.webContents.isDestroyed()) v.webContents.reload(); },
    start, snapshot, setMain: (w) => { mainWin = w; mainWin.on('resize', () => send('relayout', true)); },
    trayInfo: () => ({ accounts: config.accounts.length }),
    noteOutside,
  };
};
