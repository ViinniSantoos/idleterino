// Idleterino — módulo Kick (gerado do kickterino/main.js e ajustado para viver dentro do app).
module.exports = function createKick(ctx) {
// Kickterino — processo principal.
// Ideia: uma sessão de navegador persistente (você faz login na Kick uma vez),
// uma janela oculta "api" em kick.com para consultar status/pontos, e uma janela
// oculta e muda por canal AO VIVO tocando o player real — é isso que conta como "assistindo".
const {
  app, BrowserWindow, dialog, ipcMain, session, Tray, Menu, Notification, nativeImage, powerSaveBlocker, powerMonitor, net,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Mantém vídeos rodando mesmo com janelas ocultas/minimizadas.
// Com placa de vídeo, o Chromium congela vídeos de janelas ocultas (o tempo do player parava em 0–1 s).
// O JavaScript de cada página reserva menos memória "jovem".

// Pasta de dados alternativa (testes sem mexer na instalação de verdade).

const PARTITION = 'persist:kick';
const KICK = 'https://kick.com';
const POLL_MS = 60 * 1000;
const PLAYER_CHECK_MS = 30 * 1000;

const configPath = () => path.join(app.getPath('userData'), 'kick.json');
const DEFAULT_CONFIG = {
  channels: [
    'yetz', 'biscoitao', 'surskity', 'tftoddy', 'techzz', 'clovaobengalalol', 'axt', 'yulla', 'faturetosl',
    'cogu', 'rodil', 'patopapao2', 'matta', 'luccatv', 'guaxilol1', 'dersin2k', 'mecmeno',
  ],
  farming: true,
  // Medido em 30/10/2026: a Kick só contou pontos em ~2 lives por vez (12 abertas renderam o
  // mesmo que 2). Mais vagas só gastam memória; o rodízio espalha os pontos entre os canais.
  maxWatchers: 2,
  lowQuality: true,
  rotation: true,
  bonusTarget: '', // '' = automático; ou um pacote da loja: 'xp:1', 'capture:3', 'lure:10'…
  notifyBonus: true,
  notifyChat: true,  // menções ao seu nome e sorteios no chat
  sleepMode: false,  // "antes de dormir": só aparece para quem ligar
  favorites: [],
  gainDisplay: 'watching', // "+X" ao lado do saldo: 'watching' (só nas lives tocando), 'always' ou 'never'
  purchases: [],     // bônus comprados: { t, kind, hours, cost, slug } (cronômetro e relatório)
  daily: {},         // pontos ganhos por dia: { 'AAAA-MM-DD': pts }
};
let config = { ...DEFAULT_CONFIG };
let firstRun = false;

function loadConfig() {
  firstRun = !fs.existsSync(configPath());
  try { config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch {}
  // Canais oficiais novos de uma versão nova entram uma vez; os que a pessoa removeu não voltam.
  const seen = new Set(config.seenDefaults || config.channels);
  for (const slug of DEFAULT_CONFIG.channels) {
    if (!seen.has(slug) && !config.channels.includes(slug)) config.channels.push(slug);
  }
  config.seenDefaults = [...new Set([...seen, ...DEFAULT_CONFIG.channels])];
  // Loja antiga (só 1 h): o alvo era o custo (300/500/1000) e as compras não tinham o tipo.
  if (typeof config.bonusTarget === 'number') config.bonusTarget = config.bonusTarget ? `${(KIND_BY_COST[config.bonusTarget] || 'xp')}:1` : '';
  for (const p of config.purchases || []) if (!p.kind) { p.kind = KIND_BY_COST[p.cost] || 'xp'; p.hours = p.hours || 1; }
  // v2: instalações antigas vinham com 20 lives; passa para o padrão novo (2 + rodízio) uma vez.
  if ((config.configVersion || 1) < 2) {
    config.maxWatchers = DEFAULT_CONFIG.maxWatchers;
    config.rotation = true;
    config.configVersion = 2;
  }
  saveConfig();
}
function saveConfig() {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

let mainWin = null;
let apiWin = null;
let apiReady = null;
const watchers = new Map(); // slug -> BrowserWindow
const status = new Map();   // slug -> { live, viewers, chatroomId, title, points, watchedMs, watchingSince, error }

function send(channel, payload) {
  ctx.send('kick:' + channel, payload);
}

// Anúncios e rastreadores de terceiros: não fazem parte da live e só gastam memória/CPU.
const BLOCKED_HOSTS = [
  'googlesyndication.com', 'doubleclick.net', 'googletagmanager.com', 'google-analytics.com',
  'googleadservices.com', 'adservice.google.com', 'imasdk.googleapis.com', 'amazon-adsystem.com',
  'facebook.net', 'facebook.com/tr', 'quora.com', 'analytics.tiktok.com', 'criteo.com', 'criteo.net',
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'taboola.com', 'hotjar.com', 'clarity.ms',
];

// Lives ocultas não precisam de imagens nem fontes: ninguém está olhando para elas.
const watcherIds = new Set();
const HIDDEN_SKIP = new Set(['image', 'font']);

function isHiddenWatcher(webContents) {
  if (!webContents || !watcherIds.has(webContents.id)) return false;
  const win = BrowserWindow.fromWebContents(webContents);
  return !!win && !userOpened.has(win);
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function setupSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setSpellCheckerEnabled(false);
  // Câmera, microfone, localização e afins: nenhuma página precisa disso aqui.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    const url = details.url;
    cb({
      cancel: BLOCKED_HOSTS.some((h) => url.includes(h)) || url.startsWith('https://static.kick.com/ads/')
        || (HIDDEN_SKIP.has(details.resourceType) && isHiddenWatcher(details.webContents)),
    });
  });
}

// Deixa só a menor qualidade (160p) na lista de qualidades da live — o mesmo que escolher 160p no player.
function lowestQualityOnly(playlist) {
  const lines = playlist.split('\n');
  const head = [];
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) { variants.push([lines[i], lines[i + 1]]); i++; }
    else if (!variants.length) head.push(lines[i]);
  }
  if (variants.length < 2) return null;
  const bandwidth = (l) => Number((l.match(/BANDWIDTH=(\d+)/) || [0, Infinity])[1]);
  variants.sort((a, b) => bandwidth(a[0]) - bandwidth(b[0]));
  return [...head, ...variants[0]].join('\n') + '\n';
}

// Só a Kick e as páginas de login que ela usa abrem no app: nada de site de fora na mesma
// sessão que guarda o login. Pop-ups de login abrem numa janela normal com a mesma sessão.
const TRUSTED_DOMAINS = ['kick.com', 'google.com', 'accounts.youtube.com', 'apple.com', 'discord.com'];
const GOOGLE_REGIONAL = /^accounts\.google\.(com?\.)?[a-z]{2}$/; // o Google passa pelo domínio do país no login

function isTrustedUrl(url) {
  if (url === 'about:blank') return true;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (GOOGLE_REGIONAL.test(hostname)
      || TRUSTED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`)));
  } catch { return false; }
}

ctx.registerTrust(PARTITION, isTrustedUrl);


// Página "vazia" em kick.com: mesma origem e cookies, mas sem carregar o site inteiro.
const LIGHT_URL = `${KICK}/robots.txt`;

const withTimeout = (promise, ms) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
]);

function loadApi(url) {
  apiReady = new Promise((resolve) => apiWin.webContents.once('did-finish-load', resolve));
  apiWin.loadURL(url);
  return apiReady;
}

function createApiWindow() {
  apiWin = new BrowserWindow({
    width: 1100, height: 800, show: false, title: 'Kick — login', autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, backgroundThrottling: false },
  });
  apiWin.webContents.setAudioMuted(true);
  // Sem internet ou com a Kick fora do ar: tenta de novo sozinho. Nunca durante o login.
  const retryApi = () => setTimeout(() => { if (!apiWin.isVisible()) loadApi(LIGHT_URL); }, 30 * 1000);
  apiWin.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) retryApi();
  });
  apiWin.webContents.on('render-process-gone', retryApi);
  loadApi(LIGHT_URL);
  // Fechar a janela de login apenas a esconde e volta para a página leve.
  apiWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    apiWin.hide();
    loadApi(LIGHT_URL).then(poll);
  });
}

// Loja de pontos: o chat popout oficial da Kick, que tem o saldo e as recompensas do canal.
const storeWindows = new Map();
function openStore(slug, title = `Pontos — ${slug}`) {
  let win = storeWindows.get(slug);
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 420, height: 720, title, autoHideMenuBar: true, backgroundColor: '#0b0e0f',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { partition: PARTITION },
  });
  win.loadURL(`${KICK}/popout/${slug}/chat`);
  win.on('page-title-updated', (e) => e.preventDefault()); // mantém o "(2 de 4)" do modo antes de dormir
  win.on('closed', () => {
    storeWindows.delete(slug);
    refreshChannel(slug).then(() => send('status', snapshot()));
    if (storeSequence && storeSequence.current === slug) openNextStore();
  });
  storeWindows.set(slug, win);
}

// Modo antes de dormir: abre as lojas uma de cada vez; a próxima abre quando a pessoa fecha a atual.
let storeSequence = null;
function openNextStore() {
  const seq = storeSequence;
  const slug = seq && seq.queue.shift();
  if (!slug) { storeSequence = null; send('status', snapshot()); return; }
  seq.current = slug;
  seq.done++;
  const name = (status.get(slug) || {}).displayName || slug;
  openStore(slug, `Pontos — ${name} (${seq.done} de ${seq.total})`);
  send('status', snapshot());
}

async function sessionToken() {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ url: KICK, name: 'session_token' });
  return cookies[0] ? decodeURIComponent(cookies[0].value) : '';
}

// Faz um fetch de dentro da página kick.com (mesmos cookies/headers de um navegador normal).
async function kickFetch(apiPath, { method = 'GET', body } = {}) {
  await withTimeout(apiReady, 20 * 1000);
  const token = await sessionToken();
  const code = `(async () => {
    const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    const token = ${JSON.stringify(token)};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
    const r = await fetch(${JSON.stringify(apiPath)}, {
      method: ${JSON.stringify(method)}, headers, credentials: 'include',
      ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
    });
    return { status: r.status, text: await r.text() };
  })()`;
  const res = await withTimeout(apiWin.webContents.executeJavaScript(code, true), 20 * 1000);
  let json = null;
  try { json = JSON.parse(res.text); } catch {}
  return { status: res.status, json };
}

// Na janela de cada live: força 160p enquanto ela está oculta e lê o chat do websocket
// que a própria página da Kick abre (realtime.*.kick.com), repassando mensagens e resgates.
function instrumentWatcher(slug, win) {
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); } catch { return; }
  const seen = new Set();
  dbg.on('message', async (_e, method, p) => {
    if (method === 'Fetch.requestPaused') {
      const pass = () => dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      if (!config.lowQuality || win.isDestroyed() || userOpened.has(win)) return pass();
      try {
        const { body, base64Encoded } = await dbg.sendCommand('Fetch.getResponseBody', { requestId: p.requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString() : body;
        const low = text.includes('#EXT-X-STREAM-INF') ? lowestQualityOnly(text) : null;
        if (!low) return pass();
        await dbg.sendCommand('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: p.responseStatusCode || 200,
          responseHeaders: p.responseHeaders, body: Buffer.from(low).toString('base64'),
        });
      } catch { pass(); }
      return;
    }
    if (method !== 'Network.webSocketFrameReceived') return;
    for (const line of p.response.payloadData.split('\n')) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const pub = frame.push && frame.push.pub && frame.push.pub.data;
      if (!pub || typeof pub.data !== 'string') continue;
      let data;
      try { data = JSON.parse(pub.data); } catch { continue; }
      if (pub.event === 'App\\Events\\ChatMessageEvent') {
        if (seen.has(data.id)) continue;
        seen.add(data.id);
        if (seen.size > 2000) seen.clear();
        send('chat', { slug, kind: 'message', data });
      } else if (pub.event === 'RewardRedeemedEvent') {
        send('chat', { slug, kind: 'reward', data });
      }
    }
  });
  dbg.sendCommand('Network.enable').catch(() => {});
  dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*.m3u8*', requestStage: 'Response' }] }).catch(() => {});
}

// Lives que a pessoa abriu para ver (com imagem, som e qualidade normal).
const userOpened = new WeakSet();

// Janela "invisível": existe para o Windows (o vídeo é desenhado e anda de verdade, ao contrário
// de uma janela oculta, que o Chromium congela), mas é transparente, não recebe cliques e não
// aparece na barra de tarefas nem no Alt+Tab.
// No Linux a transparência não existe (a janela apareceria na tela) e o Chromium não congela
// janela oculta, então lá ela só fica escondida.
const isLinux = process.platform === 'linux';
function makeInvisible(win) {
  userOpened.delete(win);
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);
  win.setSize(480, 270);
  win.setPosition(0, 0);
  if (isLinux) win.hide();
  else win.showInactive();
}

function startWatcher(slug) {
  if (watchers.has(slug)) return;
  const win = new BrowserWindow({
    width: 480, height: 270, x: 0, y: 0, show: false, title: `Kick — ${slug}`, autoHideMenuBar: true,
    type: 'toolbar', skipTaskbar: true, focusable: false, opacity: 0,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { partition: PARTITION, backgroundThrottling: false, spellcheck: false },
  });
  win.webContents.setAudioMuted(true);
  const wcId = win.webContents.id;
  watcherIds.add(wcId);
  win.on('closed', () => watcherIds.delete(wcId));
  instrumentWatcher(slug, win);
  win.loadURL(`${KICK}/${slug}`);
  makeInvisible(win);
  // Fechar a live aberta só a torna invisível de novo: volta para 160p, sem som e sem imagens.
  win.on('close', (e) => {
    if (app.isQuitting || watchers.get(slug) !== win) return;
    e.preventDefault();
    makeInvisible(win);
    win.webContents.setAudioMuted(true);
    win.webContents.reload();
  });
  win.on('closed', () => { if (watchers.get(slug) === win) watchers.delete(slug); });
  // Página que caiu ou não carregou: fecha, e a próxima rodada abre de novo (ou põe outra live).
  const drop = () => setImmediate(() => { if (watchers.get(slug) === win) stopWatcher(slug); });
  win.webContents.on('render-process-gone', drop);
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) drop();
  });
  watchers.set(slug, win);
  const s = status.get(slug) || {};
  s.watchingSince = Date.now();
  status.set(slug, s);
}

function stopWatcher(slug) {
  const win = watchers.get(slug);
  if (!win) return;
  watchers.delete(slug);
  const s = status.get(slug);
  if (s && s.watchingSince) { s.watchedMs = (s.watchedMs || 0) + (Date.now() - s.watchingSince); s.watchingSince = null; }
  if (!win.isDestroyed()) win.destroy();
}

// Avisa quando o saldo do canal alcança um bônus do PokeIdle. O saldo ao abrir o app é a
// referência: só o que for alcançado depois gera aviso.
const BONUSES = [
  { cost: 300, name: '+15% XP' }, { cost: 500, name: '+15% Capture Boost' }, { cost: 1000, name: '+15% Secret Lure' },
];
// Loja da Kick (nov/2026): igual à da Twitch, cada bônus em 1 h, 3 h, 5 h e 10 h, pelo preço de 1 h
// vezes as horas (XP 300/h, Capture Boost 500/h, Secret Lure 1.000/h).
const KINDS = [
  { kind: 'xp', name: '+15% XP', per: 300, game: 'xp' },
  { kind: 'capture', name: '+15% Capture Boost', per: 500, game: 'captura' },
  { kind: 'lure', name: '+15% Secret Lure', per: 1000, game: 'shiny' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k]));
const KIND_BY_COST = { 300: 'xp', 500: 'capture', 1000: 'lure' };
const HOURS = [1, 3, 5, 10];
const PACKS = KINDS.flatMap((k) => HOURS.map((hours) => ({ kind: k.kind, hours, cost: k.per * hours })));
function parseTarget(t = config.bonusTarget) {
  const m = /^(xp|capture|lure):(\d+)$/.exec(String(t || ''));
  return m && HOURS.includes(Number(m[2])) ? { kind: m[1], hours: Number(m[2]) } : null;
}
const targetCost = (t = parseTarget()) => (t ? KIND[t.kind].per * t.hours : null);
const targetName = (t) => `${KIND[t.kind].name}${t.hours > 1 ? ` (${t.hours} h)` : ''}`;
const bonusOptions = () => PACKS.map((p) => ({ value: `${p.kind}:${p.hours}`, kind: p.kind, hours: p.hours, cost: p.cost }));

// Tempo de bônus que o PRÓPRIO JOGO mostra em cada conta do PokeIdle (é o que vale de verdade).
// Cada conta manda o seu; vale o maior de cada tipo, entre leituras dos últimos 10 min.
const gameBonus = new Map(); // id da conta -> { at, bonus: { xp, captura, shiny } }
function setGameBonus(id, bonus) {
  if (!bonus || typeof bonus !== 'object') return;
  gameBonus.set(id, { at: Date.now(), bonus });
}
function gameEnd(kind, now = Date.now()) {
  let end = 0;
  for (const g of gameBonus.values()) if (now - g.at < 10 * 60 * 1000) end = Math.max(end, Number(g.bonus[KIND[kind].game]) || 0);
  return end > now ? end : null;
}
const liveNotifications = new Set(); // sem referência, o Windows perde o clique na notificação

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, '..', 'build', 'icon.png') });
  liveNotifications.add(n);
  n.on('click', () => { liveNotifications.delete(n); if (onClick) onClick(); });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function checkBonus(slug, s) {
  const target = parseTarget();
  if (target) {
    const cost = targetCost(target);
    const n = Math.floor((s.points || 0) / cost);
    if (s.targetTier != null && n > s.targetTier && config.notifyBonus) {
      notify(`${s.displayName || slug}: ${s.points} pontos`, `Já dá para resgatar ${targetName(target)} (${cost} pts). Clique para abrir a loja.`, () => openStore(slug));
    }
    s.targetTier = n; s.bonusTier = null;
    return;
  }
  s.targetTier = null;
  const tier = BONUSES.filter((b) => s.points >= b.cost).length;
  if (s.bonusTier != null && tier > s.bonusTier && config.notifyBonus) {
    notify(`${s.displayName || slug}: ${s.points} pontos`, `Já dá para resgatar ${BONUSES[tier - 1].name}. Clique para abrir a loja.`, () => openStore(slug));
  }
  s.bonusTier = tier;
}

// ---------- Bônus ativos, histórico e relatório ----------
// Cada bônus dura 1 h e as horas compradas se somam. A compra é percebida pela queda do saldo:
// entre duas leituras o saldo pode ter subido até ~25 pts, então vale a menor combinação de
// bônus que explica a queda. Compras que a pessoa registra à mão entram igual.
const BONUS_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_PURCHASES_MS = 10 * DAY_MS;
let configDirty = false;

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function addDaily(n) {
  const k = dayKey(Date.now());
  config.daily[k] = (config.daily[k] || 0) + n;
  configDirty = true;
}

// A menor combinação de pacotes que explica a queda. Preço repetido (1.500 = XP 5 h ou Capture 3 h;
// 3.000 = XP 10 h ou Lure 3 h; 5.000 = Capture 10 h ou Lure 5 h): vale o bônus escolhido em "Bônus";
// e o tempo que o jogo mostra corrige o resto (gameEnd).
function matchPurchase(drop) {
  const want = parseTarget();
  const score = (list) => list.length * 10 - list.filter((p) => want && p.kind === want.kind).length;
  let best = null;
  const walk = (start, picked, sum) => {
    if (picked.length && sum >= drop && sum <= drop + 25) { if (!best || score(picked) < score(best)) best = picked; return; }
    if (picked.length >= 4 || sum > drop + 25) return;
    for (let i = start; i < PACKS.length; i++) walk(i, [...picked, PACKS[i]], sum + PACKS[i].cost);
  };
  walk(0, [], 0);
  return best || [];
}

function registerPurchases(slug, drop) {
  const now = Date.now();
  matchPurchase(drop).forEach((p, i) => config.purchases.push({ t: now + i, kind: p.kind, hours: p.hours, cost: p.cost, slug }));
  config.purchases = config.purchases.filter((p) => now - p.t < KEEP_PURCHASES_MS);
  configDirty = true;
}

// Fim de cada bônus, somando as horas na ordem das compras.
function bonusIntervals(purchases = config.purchases) {
  const byKind = {};
  for (const p of [...purchases].sort((a, b) => a.t - b.t)) {
    const kind = p.kind || KIND_BY_COST[p.cost] || 'xp';
    const list = byKind[kind] || (byKind[kind] = []);
    const last = list[list.length - 1];
    const dur = (p.hours || 1) * BONUS_MS;
    if (last && last.end >= p.t) last.end += dur;
    else list.push({ start: p.t, end: p.t + dur });
  }
  return byKind;
}

function activeBonuses(now = Date.now()) {
  const byKind = bonusIntervals();
  return KINDS.map((k) => {
    const cur = (byKind[k.kind] || []).find((i) => i.start <= now && i.end > now);
    const game = gameEnd(k.kind, now);
    // O jogo sabe o tempo certo; sem conta do PokeIdle aberta, vale a conta do app.
    return { kind: k.kind, cost: k.per, name: k.name, endsAt: game || (cur ? cur.end : null), fromGame: !!game };
  });
}

// Aviso 5 min antes de cada bônus acabar (uma vez por fim de bônus).
const warnedEnds = new Set();
function checkBonusEnding() {
  const now = Date.now();
  for (const b of activeBonuses(now)) {
    if (!b.endsAt || b.endsAt - now > 5 * 60 * 1000 || warnedEnds.has(`${b.cost}:${b.endsAt}`)) continue;
    warnedEnds.add(`${b.cost}:${b.endsAt}`);
    if (!config.notifyBonus) continue;
    // Sugere o canal com mais pontos que ainda paga esse bônus.
    const rich = config.channels.map((slug) => [slug, status.get(slug) || {}])
      .filter(([, s]) => (s.points || 0) >= b.cost).sort((x, y) => y[1].points - x[1].points)[0];
    notify(`Seu ${b.name} acaba em ${Math.max(1, Math.round((b.endsAt - now) / 60000))} min`,
      rich ? `${rich[1].displayName || rich[0]} tem ${rich[1].points} pts. Clique para abrir a loja.` : 'Nenhum canal tem pontos para renovar agora.',
      () => (rich ? openStore(rich[0]) : showMain()));
  }
}

// Relatório dos últimos 7 dias: pontos por dia, compras e tempo com bônus ativo por período.
const PERIODS = [['Madrugada', 0, 6], ['Dia', 6, 18], ['Noite', 18, 24]];
function weeklyReport(now = Date.now()) {
  const from = now - 7 * DAY_MS;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const t = now - i * DAY_MS, k = dayKey(t);
    const bought = config.purchases.filter((p) => dayKey(p.t) === k);
    days.push({ day: k, weekday: new Date(t).toLocaleDateString('pt-BR', { weekday: 'short' }), gained: config.daily[k] || 0,
      bought: KINDS.map((k) => bought.filter((p) => (p.kind || KIND_BY_COST[p.cost]) === k.kind).reduce((h, p) => h + (p.hours || 1), 0)) });
  }
  // Minuto a minuto: há algum bônus ativo? (qualquer um dos três)
  const all = Object.values(bonusIntervals()).flat();
  const isOn = (t) => all.some((i) => i.start <= t && i.end > t);
  const per = PERIODS.map(([name]) => ({ name, on: 0, total: 0 }));
  let on = 0, total = 0;
  for (let t = Math.ceil(from / 60000) * 60000; t < now; t += 60000) {
    const h = new Date(t).getHours();
    const p = per[PERIODS.findIndex(([, a, b]) => h >= a && h < b)];
    const active = isOn(t);
    p.total++; total++;
    if (active) { p.on++; on++; }
  }
  // Últimas 24 h em blocos de 30 min, para a linha do tempo.
  const timeline = [];
  for (let i = 47; i >= 0; i--) timeline.push(isOn(now - i * 30 * 60000 - 15 * 60000));
  const recent = config.purchases.filter((p) => p.t >= from);
  return {
    days, timeline, timelineStart: now - DAY_MS,
    gained: days.reduce((t, d) => t + d.gained, 0),
    bought: KINDS.map((k) => ({ name: k.name, kind: k.kind, cost: k.per, count: recent.filter((p) => (p.kind || KIND_BY_COST[p.cost]) === k.kind).reduce((h, p) => h + (p.hours || 1), 0) })),
    bonusHours: Math.round(on / 60),
    coverage: total ? Math.round((on / total) * 100) : 0,
    periods: per.map((p) => ({ name: p.name, pct: p.total ? Math.round((p.on / p.total) * 100) : 0 })),
    channels: new Set(recent.map((p) => p.slug).filter(Boolean)).size,
  };
}

// Lista de parceiros no site: parceiro novo entra para todos sem precisar de versão nova.
// Quem a pessoa removeu não volta (mesma regra dos canais padrão).
const PARTNERS_URL = 'https://viinnisantoos.github.io/kickterino/parceiros.json';
async function syncPartners() {
  try {
    const res = await net.fetch(PARTNERS_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const list = ((await res.json()).channels || []).map(String).filter((s) => /^[a-z0-9_-]{2,30}$/.test(s)).slice(0, 60);
    const seen = new Set(config.seenDefaults || []);
    const fresh = list.filter((slug) => !seen.has(slug) && !config.channels.includes(slug));
    config.seenDefaults = [...new Set([...seen, ...list])];
    if (fresh.length) { config.channels.push(...fresh); poll(); }
    saveConfig();
  } catch {}
}

async function refreshChannel(slug) {
  const s = status.get(slug) || { watchedMs: 0 };
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}`);
    if (code !== 200 || !json) throw new Error(`HTTP ${code}`);
    s.chatroomId = json.chatroom && json.chatroom.id;
    const wasLive = s.live;
    s.live = !!json.livestream;
    // Favorito que acabou de entrar ao vivo (no primeiro carregamento não avisa).
    if (wasLive === false && s.live && config.favorites.includes(slug)) {
      const name = (json.user && json.user.username) || slug;
      notify(`★ ${name} entrou ao vivo`, json.livestream.session_title || 'Clique para abrir o chat.', () => { showMain(); send('select', slug); });
    }
    s.viewers = json.livestream ? json.livestream.viewer_count : 0;
    s.title = json.livestream ? json.livestream.session_title : '';
    // Miniatura da live (atualizada pela Kick) e foto do canal, para a tela.
    const th = json.livestream && json.livestream.thumbnail;
    s.thumb = th ? (th.url || th.src || null) : null;
    s.avatar = (json.user && json.user.profile_pic) || s.avatar || null;
    s.displayName = (json.user && json.user.username) || slug;
    s.error = null;
  } catch (e) {
    s.error = String(e.message || e);
  }
  // Se a conta segue o canal (só logado) — para conferir se seguir influencia nos pontos.
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}/me`);
    if (code === 200 && json && typeof json.is_following === 'boolean') s.following = json.is_following;
    // Quem é sub ganha o dobro de pontos naquele canal (20 a cada 5 min).
    if (code === 200 && json && 'subscription' in json) s.subscribed = !!json.subscription;
  } catch {}
  // Saldo de pontos — endpoint não documentado; se falhar, só mostramos "—".
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}/points`);
    if (code === 200 && json) {
      const p = json.data ? json.data.points : json.points;
      if (typeof p === 'number') {
        // Ganho de assistir (gastos na loja fazem o saldo cair e não contam).
        if (s.points != null && p > s.points) {
          s.gainedTotal = (s.gainedTotal || 0) + (p - s.points);
          s.gainShown = (s.gainShown || 0) + (p - s.points); // o "+X" da tela
          if (watchers.has(slug)) s.lastGainAt = Date.now();
          addDaily(p - s.points);
        }
        // Gastou pontos (bônus ou outra recompensa): o "+X" daquele canal recomeça do zero.
        if (s.points != null && p < s.points) { s.gainShown = 0; registerPurchases(slug, s.points - p); }
        s.points = p;
        checkBonus(slug, s);
      }
    }
  } catch {}
  status.set(slug, s);
}

// Confere cada live oculta: aviso +18 (só a pessoa pode confirmar) e estado do player, para o
// histórico. O tempo do vídeo NÃO indica se a live conta: no player da Kick ele fica em 0–1 s
// mesmo com os pontos subindo, então quem diz se está valendo é o saldo (ver lastGainAt).
async function checkPlayers() {
  for (const [slug, win] of watchers) {
    const s = status.get(slug);
    if (!s || win.isDestroyed() || userOpened.has(win)) continue;
    const info = await withTimeout(win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      return {
        gate: !!document.querySelector('[data-testid="mature"]'),
        visibility: document.visibilityState,
        video: v ? { paused: v.paused, time: Math.round(v.currentTime), height: v.videoHeight, ready: v.readyState } : null,
      };
    })()`), PLAYER_CHECK_MS).catch((err) => {
      // Página congelada não responde nunca: fecha, e a próxima rodada abre de novo (ou põe outra live).
      if (err.message === 'timeout' && watchers.get(slug) === win) stopWatcher(slug);
      return null;
    });
    if (!info) continue;
    s.ageGate = info.gate;
    s.visibility = info.visibility;
    s.video = info.video;
  }
}

// "Ganhando": o saldo subiu nos últimos minutos enquanto a live tocava. A primeira contagem
// leva ~6–7 min depois que a live abre; depois, +10 a cada ~5–6 min.
const EARN_WINDOW_MS = 13 * 60 * 1000;
function earningState(slug, now) {
  const s = status.get(slug) || {};
  if (!watchers.has(slug)) return null;
  if (s.lastGainAt && now - s.lastGainAt < EARN_WINDOW_MS) return 'earning';
  if (now - (s.watchingSince || now) < EARN_WINDOW_MS) return 'warming';
  return 'idle';
}

// Histórico em points-log.jsonl (pasta de dados do app): uma linha por minuto com pontos e
// estado de cada live. Serve para conferir se os pontos sobem com o app minimizado.
function logHistory() {
  const now = Date.now();
  const channels = {};
  for (const slug of config.channels) {
    const s = status.get(slug) || {};
    if (!s.live && s.points == null) continue;
    channels[slug] = {
      live: !!s.live, watching: watchers.has(slug), points: s.points ?? null, following: s.following ?? null,
      subscribed: !!s.subscribed, earning: earningState(slug, now), video: s.video || null, visibility: s.visibility || null,
      gate: !!s.ageGate, watchedMin: Math.floor(totalWatched(slug, now) / 60000),
    };
  }
  const line = JSON.stringify({
    t: new Date(now).toISOString(), mainMinimized: !!mainWin && mainWin.isMinimized(),
    mainFocused: !!mainWin && mainWin.isFocused(), loggedIn, memoryMB: snapshot().memoryMB,
    maxWatchers: config.maxWatchers, limitTest: limitTestSnapshot(), channels,
  });
  const file = path.join(app.getPath('userData'), 'points-log.jsonl');
  // Troca de arquivo aos 5 MB. Se a troca falhar (Windows), o registro não pode parar: começa um arquivo limpo.
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
      try { fs.rmSync(file + '.old', { force: true }); fs.renameSync(file, file + '.old'); } catch { fs.writeFileSync(file, ''); }
    }
  } catch {}
  try { fs.appendFileSync(file, line + '\n'); } catch {}
}

// Foco em bônus: o saldo é separado por canal, então espalhar pontos atrasa as compras. As vagas
// vão para quem está mais perto do próximo bônus, e todos os canais ao vivo chegam a 300 antes
// de alguém buscar 500, depois 1.000 e cada milhar seguinte. Cada troca perde ~6–7 min até a primeira contagem, por isso só troca
// quando o canal bateu a meta ou quando a diferença compensa (SWITCH_MARGIN).
// Canal com sub rende o dobro: entra na frente de todos e fica enquanto estiver ao vivo, sem meta.
const SWITCH_MARGIN = 50;
const IDLE_COOLDOWN_MS = 30 * 60 * 1000;
const CONTA_SEM_PONTOS_MAX_MS = 60 * 60 * 1000;
let contaSemPontosDesde = 0; // desde quando TODAS as lives do app estão sem render (ver reconcileWatchers)

function goalRank(points) {
  const p = points || 0;
  // Bônus escolhido: junta pontos até o custo dele; quem já chegou cede a vaga para o próximo canal.
  const tc = targetCost();
  if (tc) {
    const tier = Math.floor(p / tc);
    const goal = (tier + 1) * tc;
    return { tier, goal, left: goal - p };
  }
  // Passou de 1.000: cada milhar é uma meta nova, então ninguém dispara na frente dos outros.
  const thousands = Math.floor(p / 1000);
  const tier = thousands ? BONUSES.length - 1 + thousands : BONUSES.filter((b) => p >= b.cost).length;
  const goal = thousands ? (thousands + 1) * 1000 : BONUSES[tier].cost;
  return { tier, goal, left: goal - p };
}

const compareGoal = (a, b) => {
  const ra = goalRank(a.points), rb = goalRank(b.points);
  return !!a.cooling - !!b.cooling || !!b.sub - !!a.sub || ra.tier - rb.tier || ra.left - rb.left;
};

function worthSwitching(candidate, current) {
  if (candidate.cooling || current.sub) return false;
  if (candidate.sub) return true;
  const c = goalRank(candidate.points), w = goalRank(current.points);
  return c.tier < w.tier || (c.tier === w.tier && c.left + SWITCH_MARGIN < w.left);
}

const totalWatched = (slug, now) => {
  const s = status.get(slug) || {};
  return (s.watchedMs || 0) + (s.watchingSince ? now - s.watchingSince : 0);
};
const turnTime = (slug, now) => now - ((status.get(slug) || {}).watchingSince || now);
const isShown = (slug) => { const w = watchers.get(slug); return !!w && !w.isDestroyed() && userOpened.has(w); };

// Rodando direto, a página da Kick vai acumulando memória: renova a live de tempos em tempos.
const RECYCLE_MS = 6 * 60 * 60 * 1000;

const celularAtivo = () => !!(ctx.celularAtivo && ctx.celularAtivo('kick'));
ctx.aoCelular = ctx.aoCelular || {};
ctx.aoCelular.kick = () => { try { reconcileWatchers(); send('status', snapshot()); } catch {} };
function reconcileWatchers() {
  const now = Date.now();
  // Sem login a Kick não dá pontos: abrir live só gastaria memória.
  // Farmando no celular (aviso pelo Wi-Fi de casa): o PC para as lives desta plataforma até o celular sair.
  const canFarm = config.farming && (loggedIn || process.env.KICKTERINO_ALLOW_ANON) && !celularAtivo();
  for (const slug of [...watchers.keys()]) {
    const s = status.get(slug);
    if (isShown(slug)) continue;
    if (!canFarm || !config.channels.includes(slug) || (s && s.live === false)) stopWatcher(slug);
  }
  if (!canFarm) return;

  // Vaga não pode ficar parada: com o limite de 2 lives, quem não rende cede o lugar.
  // Com mais vagas que isso, ficar sem ganhar é esperado, então não mexe.
  // EXCEÇÃO: TODAS as lives do app pararam de render juntas → o problema é a CONTA, não o canal (a Kick só conta ~2
  // lives por conta: se a pessoa assiste em outro lugar — celular, navegador —, as do app ficam sem pontos). Aí não
  // põe ninguém de castigo (senão o canal mais perto da meta some da fila) e avisa na tela. Passada 1 h assim, volta
  // a trocar (pode ser problema dos próprios canais).
  const tocando = [...watchers.keys()].filter((slug) => !isShown(slug));
  const todasParadas = loggedIn && !limitTest && config.maxWatchers <= 2 && tocando.length >= 2
    && tocando.every((slug) => earningState(slug, now) === 'idle');
  if (todasParadas) { if (!contaSemPontosDesde) contaSemPontosDesde = now; } else contaSemPontosDesde = 0;
  const segurar = todasParadas && now - contaSemPontosDesde < CONTA_SEM_PONTOS_MAX_MS;
  for (const slug of [...watchers.keys()]) {
    if (isShown(slug)) continue;
    const idle = !segurar && loggedIn && !limitTest && config.maxWatchers <= 2 && earningState(slug, now) === 'idle';
    const s = status.get(slug);
    if (idle && s) s.cooldownUntil = now + IDLE_COOLDOWN_MS; // senão voltaria na mesma hora
    if (idle || turnTime(slug, now) >= RECYCLE_MS) stopWatcher(slug);
  }

  // Limite reduzido: libera primeiro quem está há mais tempo na vez.
  const rotatable = () => [...watchers.keys()].filter((slug) => !isShown(slug))
    .sort((a, b) => turnTime(b, now) - turnTime(a, now));
  while (watchers.size > config.maxWatchers && rotatable().length) stopWatcher(rotatable()[0]);

  // Sem foco, as vagas seguem a ordem da lista de canais e ninguém troca de lugar.
  const focusInfo = (slug) => {
    const s = status.get(slug) || {};
    const cooling = (s.cooldownUntil || 0) > now;
    return { points: s.points, cooling, sub: !!s.subscribed && !cooling };
  };
  const byGoal = (a, b) => compareGoal(focusInfo(a), focusInfo(b));
  const waiting = config.channels.filter((slug) => !watchers.has(slug) && (status.get(slug) || {}).live);
  if (config.rotation) waiting.sort(byGoal);
  while (watchers.size < config.maxWatchers && waiting.length) startWatcher(waiting.shift());
  if (!config.rotation) return;

  for (const slug of rotatable().sort((a, b) => byGoal(b, a))) {
    if (!waiting.length || !worthSwitching(focusInfo(waiting[0]), focusInfo(slug))) break;
    stopWatcher(slug);
    startWatcher(waiting.shift());
  }
}

// Teste de limite: descobre quantas lives a Kick conta ao mesmo tempo. Em cada etapa abre N
// lives (sem rodízio), ignora o aquecimento e mede quantos pontos entraram no resto da etapa.
// Uma live no ritmo cheio rende 10 pts a cada 5 min, então "lives contando" ≈ pts / (min × 2).
// A 1ª etapa abre TODAS as lives ao vivo: se todas contarem, acaba ali. Senão, testa só os
// números até um pouco acima do que contou, para achar o menor que rende o máximo.
const LIMIT_LADDER = [2, 3, 4, 6, 8, 10, 13, 16, 20];
const LIMIT_STEP_MS = (Number(process.env.KICKTERINO_LIMIT_STEP_MIN) || 20) * 60 * 1000;
const LIMIT_WARMUP_MS = (Number(process.env.KICKTERINO_LIMIT_WARMUP_MIN) || 8) * 60 * 1000;
let limitTest = null;

const sumGained = () => [...status.values()].reduce((t, s) => t + (s.gainedTotal || 0), 0);
const liveCount = () => config.channels.filter((slug) => (status.get(slug) || {}).live).length;

function startLimitTest() {
  const all = Math.max(2, liveCount());
  limitTest = {
    i: 0, steps: [all, ...LIMIT_LADDER.filter((n) => n < all)],
    stepStart: Date.now(), baseline: null, results: [],
    prev: { maxWatchers: config.maxWatchers, rotation: config.rotation },
  };
  config.maxWatchers = all;
  config.rotation = false;
}

function stopLimitTest() {
  if (!limitTest) return;
  config.maxWatchers = limitTest.prev.maxWatchers;
  config.rotation = limitTest.prev.rotation;
  limitTest = null;
  saveConfig();
}

function advanceLimitTest() {
  if (!limitTest) return;
  const now = Date.now();
  const elapsed = now - limitTest.stepStart;
  if (limitTest.baseline == null && elapsed >= LIMIT_WARMUP_MS) {
    limitTest.baseline = sumGained();
    limitTest.baselineAt = now;
  }
  if (elapsed < LIMIT_STEP_MS || limitTest.baseline == null) return;

  const minutes = (now - limitTest.baselineAt) / 60000;
  const pts = sumGained() - limitTest.baseline;
  const result = {
    lives: limitTest.steps[limitTest.i], playing: watchers.size, minutes: Math.round(minutes),
    pts, counting: Math.round((pts / (minutes * 2)) * 10) / 10,
  };
  limitTest.results.push(result);
  if (limitTest.i === 0) {
    // Todas contaram (≥ 85%)? Então não há limite para achar. Senão, só testa até um pouco
    // acima do que contou.
    const cap = result.counting >= result.playing * 0.85 ? 0 : Math.ceil(result.counting) + 2;
    limitTest.steps = [limitTest.steps[0], ...limitTest.steps.slice(1).filter((n) => n <= Math.max(cap, 3) && cap > 0)];
  }
  limitTest.i++;
  if (limitTest.i < limitTest.steps.length) {
    Object.assign(limitTest, { stepStart: now, baseline: null });
    config.maxWatchers = limitTest.steps[limitTest.i];
    return;
  }
  // Fim: fica com o menor número de lives que rendeu pelo menos 90% do melhor resultado.
  const best = Math.max(...limitTest.results.map((r) => r.pts));
  const chosen = [...limitTest.results].sort((a, b) => a.lives - b.lives).find((r) => r.pts >= best * 0.9)
    || limitTest.results[0];
  config.limitResult = { at: new Date(now).toISOString(), results: limitTest.results, chosen: chosen.lives };
  config.maxWatchers = chosen.lives;
  config.rotation = true;
  limitTest = null;
  saveConfig();
}

function limitTestSnapshot() {
  if (!limitTest) return null;
  const elapsed = Date.now() - limitTest.stepStart;
  return {
    step: limitTest.i + 1, steps: limitTest.steps.length, lives: limitTest.steps[limitTest.i],
    warming: limitTest.baseline == null, leftMin: Math.max(0, Math.ceil((LIMIT_STEP_MS - elapsed) / 60000)),
    totalLeftMin: Math.ceil(((limitTest.steps.length - limitTest.i) * LIMIT_STEP_MS - elapsed) / 60000),
    results: limitTest.results,
  };
}

function snapshot() {
  const now = Date.now();
  return {
    noCelular: celularAtivo(),
    farming: config.farming,
    maxWatchers: config.maxWatchers,
    lowQuality: config.lowQuality,
    rotation: config.rotation,
    bonusTarget: config.bonusTarget, bonusOptions: bonusOptions(), targetCost: targetCost(),
    limitTest: limitTestSnapshot(),
    limitResult: config.limitResult || null,
    openAtLogin: isOpenAtLogin(),
    platform: process.platform,
    notifyBonus: config.notifyBonus,
    notifyChat: config.notifyChat,
    sleepMode: config.sleepMode,
    favorites: config.favorites,
    username,
    version: app.getVersion(),
    intro: config.lastSeenVersion === app.getVersion() ? null : (firstRun ? 'welcome' : 'news'),
    bonuses: activeBonuses(now),
    gainDisplay: config.gainDisplay,
    purchases: [...config.purchases].sort((a, b) => b.t - a.t).slice(0, 6),
    storeSequence: storeSequence ? { done: storeSequence.done, total: storeSequence.total } : null,
    channels: config.channels.map((slug) => {
      const s = status.get(slug) || {};
      const watchedMs = (s.watchedMs || 0) + (s.watchingSince ? now - s.watchingSince : 0);
      return {
        slug, displayName: s.displayName || slug, live: !!s.live, viewers: s.viewers || 0,
        title: s.title || '', chatroomId: s.chatroomId || null, points: s.points ?? null,
        watching: watchers.has(slug), ageGate: !!s.ageGate, earning: earningState(slug, now),
        following: s.following ?? null, subscribed: !!s.subscribed,
        gained: s.gainShown || 0,
        goal: s.points != null ? goalRank(s.points).goal : null,
        goalLeft: s.points != null ? goalRank(s.points).left : null,
        watchedMin: Math.floor(watchedMs / 60000), error: s.error || null,
        turnMin: s.watchingSince ? Math.floor((now - s.watchingSince) / 60000) : null,
        lastGainAt: s.lastGainAt || null, thumb: s.thumb || null, avatar: s.avatar || null,
        // De castigo (tocou 13 min sem o saldo subir): fica fora da fila por um tempo. A tela mostra em vez de "na fila".
        coolMin: !watchers.has(slug) && (s.cooldownUntil || 0) > now ? Math.ceil((s.cooldownUntil - now) / 60000) : 0,
      };
    }),
    // Todas as lives do app sem render ao mesmo tempo (a conta, não os canais): a tela avisa.
    contaSemPontosMin: contaSemPontosDesde ? Math.floor((now - contaSemPontosDesde) / 60000) : 0,
    memoryMB: Math.round(app.getAppMetrics().reduce((t, m) => t + m.memory.workingSetSize, 0) / 1024),
    loggedIn,
  };
}

// Uma rodada presa não pode parar o app: passado esse tempo, a seguinte começa mesmo assim.
const POLL_STUCK_MS = 5 * 60 * 1000;
let polling = false;
let pollStartedAt = 0;
let loggedIn = false;
// Nome da conta logada: o chat destaca quando alguém menciona você.
let username = null;
async function fetchUsername() {
  for (const p of ['/api/v1/user', '/api/v2/user']) {
    try {
      const { status: code, json } = await kickFetch(p);
      const name = code === 200 && json && (json.username || (json.user && json.user.username));
      if (name) return String(name);
    } catch {}
  }
  return null;
}
let gainDay = null;
function resetGainsOnNewDay() {
  const today = new Date().toDateString();
  if (gainDay && gainDay !== today) for (const s of status.values()) s.gainShown = 0;
  gainDay = today;
}
let pollFailures = 0;
async function poll() {
  if (polling && Date.now() - pollStartedAt < POLL_STUCK_MS) return;
  const startedAt = Date.now();
  polling = true;
  pollStartedAt = startedAt;
  try {
    loggedIn = !!(await sessionToken());
    await withTimeout(apiReady, 5 * 1000); // sem a página da Kick não há o que consultar agora
    if (!loggedIn) username = null;
    else if (!username) username = await fetchUsername();
    for (const slug of config.channels) await refreshChannel(slug);
    if (configDirty) { configDirty = false; saveConfig(); }
    // Nenhum canal respondeu: a página de consulta pode ter ficado velha, então renova.
    if (config.channels.length && config.channels.every((slug) => (status.get(slug) || {}).error) && !apiWin.isVisible()) {
      loadApi(LIGHT_URL);
    }
    resetGainsOnNewDay();
    advanceLimitTest();
    reconcileWatchers();
    await checkPlayers();
    logHistory();
    pollFailures = 0;
    send('status', snapshot());
    updateTray();
    if (process.env.KICKTERINO_DEBUG) {
      console.log(JSON.stringify(snapshot()));
      for (const [slug, win] of watchers) {
        const h = await win.webContents.executeJavaScript(`(document.querySelector('video') || {}).videoHeight`).catch(() => '?');
        const mem = app.getAppMetrics().find((m) => m.pid === win.webContents.getOSProcessId());
        console.log(`VIDEO ${slug} ${h}p ${mem ? Math.round(mem.memory.workingSetSize / 1024) : '?'}MB`);
      }
      for (const m of app.getAppMetrics()) console.log(`PROC ${m.type} ${Math.round(m.memory.workingSetSize / 1024)}MB`);
    }
  } catch (e) {
    if (process.env.KICKTERINO_DEBUG) console.log('POLL ERROR', e && e.stack);
    // Kick ou internet fora do ar: a próxima rodada tenta de novo. Mas se a página de consulta
    // morreu sem avisar (PC suspendeu, rede caiu), ela nunca mais responde e toda rodada pararia
    // aqui: depois de 2 falhas seguidas, recarrega a página.
    pollFailures++;
    if (pollFailures >= 2 && apiWin && !apiWin.isDestroyed() && !apiWin.isVisible()) { pollFailures = 0; loadApi(LIGHT_URL); }
  } finally { if (pollStartedAt === startedAt) polling = false; }
}

// ---------- Modo 24/7 ----------
// Impede o PC de suspender enquanto farma. O monitor pode apagar normalmente.
let awakeBlocker = null;
function syncKeepAwake() {
  if (config.farming && awakeBlocker == null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!config.farming && awakeBlocker != null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
}

function setFarming(on) {
  config.farming = !!on;
  saveConfig();
  syncKeepAwake();
  reconcileWatchers();
  updateTray();
  send('status', snapshot());
}

// O app portátil roda de uma pasta temporária: o que abre com o Windows é o .exe original.
const isOpenAtLogin = () => ctx.isOpenAtLogin();
const showMain = () => ctx.showMain();
const quitApp = () => ctx.quit();
const updateTray = () => ctx.updateTray();

function recoverAfterResume() {
  for (const slug of [...watchers.keys()]) if (!isShown(slug)) stopWatcher(slug);
  if (!apiWin.isVisible()) loadApi(LIGHT_URL);
  setTimeout(poll, 15 * 1000);
}

// Atualização automática pelo GitHub Releases. A versão portátil não se atualiza sozinha.
ipcMain.handle('kick:state:get', () => snapshot());
ipcMain.handle('kick:gainDisplay:set', (_e, v) => { config.gainDisplay = ['watching', 'always', 'never'].includes(v) ? v : 'watching'; saveConfig(); return snapshot(); });
ipcMain.handle('kick:gains:reset', () => { for (const s of status.values()) s.gainShown = 0; return snapshot(); });
ipcMain.handle('kick:channels:add', async (_e, slug) => {
  slug = String(slug || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/[^a-z0-9_-]/g, '');
  if (slug && !config.channels.includes(slug)) { config.channels.push(slug); saveConfig(); poll(); }
  return snapshot();
});
ipcMain.handle('kick:channels:remove', (_e, slug) => {
  config.channels = config.channels.filter((c) => c !== slug);
  // Tirou: não volta sozinho (nem sendo canal oficial do PokeIdle) e sai dos favoritos.
  config.seenDefaults = [...new Set([...(config.seenDefaults || []), slug])];
  config.favorites = (config.favorites || []).filter((s) => s !== slug);
  stopWatcher(slug); status.delete(slug); saveConfig();
  return snapshot();
});
ipcMain.handle('kick:farming:set', (_e, on) => { setFarming(on); return snapshot(); });
ipcMain.handle('kick:notifyBonus:set', (_e, on) => { config.notifyBonus = !!on; saveConfig(); return snapshot(); });
ipcMain.handle('kick:notifyChat:set', (_e, on) => { config.notifyChat = !!on; saveConfig(); return snapshot(); });
ipcMain.handle('kick:sleepMode:set', (_e, on) => { config.sleepMode = !!on; saveConfig(); return snapshot(); });
ipcMain.handle('kick:favorite:toggle', (_e, slug) => {
  if (!config.channels.includes(slug)) return snapshot();
  config.favorites = config.favorites.includes(slug) ? config.favorites.filter((s) => s !== slug) : [...config.favorites, slug];
  saveConfig();
  return snapshot();
});
ipcMain.handle('kick:purchase:add', (_e, key) => {
  const kind = KIND[key] ? key : KIND_BY_COST[key];
  if (kind) { config.purchases.push({ t: Date.now(), kind, hours: 1, cost: KIND[kind].per, slug: null }); saveConfig(); }
  updateTray();
  return snapshot();
});
ipcMain.handle('kick:purchase:remove', (_e, t) => { config.purchases = config.purchases.filter((p) => p.t !== t); saveConfig(); updateTray(); return snapshot(); });
ipcMain.handle('kick:stores:sequence', (_e, slugs) => {
  const queue = (Array.isArray(slugs) ? slugs : []).filter((s) => config.channels.includes(s));
  if (!queue.length) return snapshot();
  storeSequence = { queue, total: queue.length, done: 0, current: null };
  openNextStore();
  return snapshot();
});
ipcMain.handle('kick:stores:cancel', () => { if (storeSequence) storeSequence.queue = []; return snapshot(); });
ipcMain.handle('kick:report:get', () => weeklyReport());
// Salva o card do relatório como imagem (o recorte é a área do card na janela).
ipcMain.handle('kick:report:save', async (_e, rect) => {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  const image = await mainWin.webContents.capturePage(r);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Salvar resumo da semana',
    defaultPath: path.join(app.getPath('pictures'), `kickterino-semana-${dayKey(Date.now())}.png`),
    filters: [{ name: 'Imagem PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
});
ipcMain.handle('kick:intro:done', () => { config.lastSeenVersion = app.getVersion(); firstRun = false; saveConfig(); return snapshot(); });
ipcMain.handle('kick:maxWatchers:set', (_e, n) => {
  limitTest = null; // mexer na mão cancela o teste de limite
  config.maxWatchers = Math.max(1, Math.min(30, Number(n) || 1)); saveConfig(); reconcileWatchers(); return snapshot();
});
ipcMain.handle('kick:rotation:set', (_e, on) => { limitTest = null; config.rotation = !!on; saveConfig(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('kick:bonusTarget:set', (_e, value) => {
  const t = parseTarget(value);
  config.bonusTarget = t ? `${t.kind}:${t.hours}` : '';
  saveConfig();
  reconcileWatchers();
  return snapshot();
});
ipcMain.handle('kick:limitTest:start', () => {
  if (!loggedIn && !process.env.KICKTERINO_LIMIT_AUTOSTART) return snapshot(); // sem login a Kick não dá pontos: o teste não mediria nada
  startLimitTest(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('kick:limitTest:stop', () => { stopLimitTest(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('kick:lowQuality:set', (_e, on) => {
  config.lowQuality = !!on; saveConfig();
  for (const win of watchers.values()) if (!win.isDestroyed() && !userOpened.has(win)) win.webContents.reload();
  return snapshot();
});
ipcMain.handle('kick:refresh', async () => { await poll(); return snapshot(); });
ipcMain.handle('kick:login:show', async () => {
  apiWin.show(); apiWin.focus();
  await loadApi(`${KICK}/login`);
});
// Sair da conta: apaga cookies, cache e tudo que as páginas guardaram, inclusive o login do
// Google, Apple ou Discord. A lista de canais e as preferências ficam.
ipcMain.handle('kick:logout', async () => {
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'question', buttons: ['Sair da conta', 'Cancelar'], defaultId: 1, cancelId: 1,
    title: 'Sair da conta', message: 'Sair da conta da Kick neste PC?',
    detail: 'Os dados de login salvos no app serão apagados. Para farmar de novo, será preciso entrar outra vez.',
  });
  if (response !== 0) return snapshot();
  for (const slug of [...watchers.keys()]) stopWatcher(slug);
  for (const win of storeWindows.values()) if (!win.isDestroyed()) win.close();
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  ses.flushStorageData();
  status.clear();
  await loadApi(LIGHT_URL);
  await poll();
  return snapshot();
});
ipcMain.handle('kick:store:open', (_e, slug) => openStore(slug));
// Mostra a live de verdade, com imagem, som e qualidade normal (e o aviso +18, se houver, para a pessoa confirmar).
ipcMain.handle('kick:channel:show', (_e, slug) => {
  let win = watchers.get(slug);
  if (!win) { startWatcher(slug); win = watchers.get(slug); }
  userOpened.add(win);
  win.webContents.setAudioMuted(false);
  win.setOpacity(1);
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.setSize(960, 600); win.center();
  win.show(); win.focus();
  win.webContents.reload();
  const s = status.get(slug);
  if (s) s.ageGate = false;
  send('status', snapshot());
});
ipcMain.handle('kick:chat:send', async (_e, { chatroomId, content }) => {
  const { status: code, json } = await kickFetch(`/api/v2/messages/send/${chatroomId}`, {
    method: 'POST', body: { content, type: 'message' },
  });
  return { ok: code >= 200 && code < 300, status: code, message: json && (json.message || (json.status && json.status.message)) };
});

// Só uma instância: abrir o atalho de novo traz a janela existente para frente.

// ---------- Ligar e desligar o módulo (a casca chama) ----------
const timers = [];
let started = false;
function start() {
  if (started) return;
  started = true;
  syncKeepAwake();
  createApiWindow();
    apiReady.then(poll);
  timers.push(setInterval(poll, POLL_MS));
  timers.push(setInterval(() => send('status', snapshot()), 15 * 1000));
  timers.push(setInterval(() => { checkBonusEnding(); updateTray(); }, 30 * 1000));
  timers.push(setTimeout(syncPartners, 30 * 1000));
  timers.push(setInterval(syncPartners, 6 * 60 * 60 * 1000));
}
function stop() {
  if (!started) return;
  started = false;
  while (timers.length) clearInterval(timers.pop());
  for (const slug of [...watchers.keys()]) stopWatcher(slug);
  for (const win of storeWindows.values()) if (!win.isDestroyed()) win.destroy();
  if (apiWin && !apiWin.isDestroyed()) apiWin.destroy();
  apiWin = null;
  
  if (awakeBlocker != null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
  status.clear();
}
// Canais oficiais que o próprio jogo mostra (Bônus na Kick), lidos pelas contas do PokeIdle.
// Canal novo com "pontos ativos" entra sozinho; canal que a pessoa tirou não volta (fica em seenDefaults).
function syncOfficial(list) {
  const ids = [...new Set((list || []).filter((o) => o && o.ativo).map((o) => String(o.id).toLowerCase()).filter((x) => /^[a-z0-9_-]{2,30}$/.test(x)))].slice(0, 80);
  if (!ids.length) return [];
  const seen = new Set(config.seenDefaults || []);
  const fresh = ids.filter((x) => !seen.has(x) && !config.channels.includes(x));
  if (!fresh.length && ids.every((x) => seen.has(x))) return [];
  config.seenDefaults = [...new Set([...seen, ...ids])];
  if (fresh.length) { config.channels.push(...fresh); if (started) { poll(); } send('status', snapshot()); }
  saveConfig();
  return fresh;
}
// Resumo para a bandeja e para a tela Início.
function trayInfo() {
  const now = Date.now();
  return { started, loggedIn, watching: watchers.size, gained: sumGained(), bonuses: activeBonuses(now) };
}
return {
  ns: 'kick', start, stop, snapshot, trayInfo, recoverAfterResume, syncOfficial, setGameBonus,
  loadConfig, setupSession, setMain: (w) => { mainWin = w; }, get started() { return started; },
};
};
