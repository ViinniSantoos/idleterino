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
  const ultra = document.documentElement.classList.contains('modo-ultra');
  const T = (() => { try { return window.__idleterinoMercado && window.__idleterinoMercado.treinador ? window.__idleterinoMercado.treinador() : null; } catch { return null; } })();
  const T_ok = !!(T && T.nick && Date.now() - T.at < 5 * 60 * 1000);
  const nf = (x) => Number(x || 0).toLocaleString('pt-BR');
  const domNick = txt('#tr-nick');
  const nickV = domNick && domNick !== '—' ? domNick : (T_ok ? T.nick : domNick);
  const temTela = domNick && domNick !== '—';
  const logged = (!!app && !app.classList.contains('hidden')) || (ultra && T_ok);
  const ativos = [...document.querySelectorAll('#tr-ativos .tr-ativo')].map((e) => ({
    kind: e.classList.contains('twitch') ? 'twitch' : e.classList.contains('kick') ? 'kick' : e.classList.contains('vip') ? 'vip'
      : e.classList.contains('passe-vip') ? 'passe' : e.classList.contains('guild-boost') ? 'guild' : 'item',
    text: e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60), title: (e.title || '').slice(0, 200),
    end: Number(e.dataset.twFim || e.dataset.kkFim) || null,
  }));
  const autos = ['auto-ball-captura', 'auto-ball-sem-parar', 'auto-revive', 'auto-potion', 'auto-voltar-hunt']
    .map((id) => { const c = q('#' + id); return c ? { id, on: !!c.checked } : null; }).filter(Boolean);
  return {
    temSessao: (() => { try { const x = JSON.parse(localStorage.getItem('sessao') || 'null'); return !!(x && x.token); } catch { return false; } })(),
    logged, nick: nickV, level: temTela ? txt('#tr-level') : (T_ok ? String(T.level) : txt('#tr-level')), gold: temTela ? txt('#tr-gold') : (T_ok ? nf(T.gold) : txt('#tr-gold')), gems: txt('#tr-gemas'), diamonds: txt('#tr-diamantes'),
    xp: temTela ? txt('#tr-xp-txt') : (T_ok ? nf(T.dentro) + ' / ' + nf(T.faixa) + ' xp' : txt('#tr-xp-txt')), ultraFonte: !temTela && T_ok, guildTag: T && T.guildTag ? T.guildTag : null, guild: txt('#tr-guild'), xpH: txt('#sessao-xp-treinador-h'), where: txt('#eco-onde'), ativos, autos,
    autoCount: txt('#auto-cnt'),
    // O placar da sessão que o próprio jogo grava (o mesmo do painel do modo Economia).
    sess: (() => { try { const n = nickV && nickV !== '—' ? nickV : null; const o = n && JSON.parse(localStorage.getItem('sessao-hunt:' + n.toLowerCase()) || 'null');
      return o && o.ms > 0 ? { ms: o.ms, xpTreinador: +o.xpTreinador || 0, xpPokemon: +o.xpPokemon || 0, gold: +o.gold || 0, abates: +o.abates || 0, capturas: +o.capturas || 0, shVistos: +o.shiniesVistos || 0, shCapt: +o.shinies || 0, lucroH: txt('#sessao-lucro-h') } : null; } catch { return null; } })(),
    evento: (() => { const f = q('#evento-faixa'); return f && !f.classList.contains('hidden') ? { texto: txt('#evento-texto'), tempo: txt('#evento-tempo') } : null; })(),
    bonusXp: (() => { try { return window.__idleterinoMercado ? window.__idleterinoMercado.bonusXp() : null; } catch { return null; } })(),
    hunts: (() => { try { return window.__idleterinoMercado ? window.__idleterinoMercado.hunts() : null; } catch { return null; } })(),
    canais: (() => { try { return window.__idleterinoMercado ? window.__idleterinoMercado.canais() : null; } catch { return null; } })(),
    shiny: (() => { try { return window.__idleterinoMercado && window.__idleterinoMercado.shinyInfo ? window.__idleterinoMercado.shinyInfo() : null; } catch { return null; } })(),
    mercado: (() => { try { const r = window.__idleterinoMercado && window.__idleterinoMercado.ler(); if (!r) return null;
      const out = {};
      if (r.meus) out.meus = { at: r.meus.at, linhas: (r.meus.m.linhas || []).slice(0, 40).map((a) => ({ id: a.id, pk: a.pokemonId != null ? a.pokemonId : (a.ficha && a.ficha.id != null ? a.ficha.id : null), tipo: a.tipo, nome: (a.ficha && (a.ficha.nome || (a.ficha.casaId ? 'Casa' : a.ficha.caixaId ? 'Caixa' : ''))) || a.nome || '—', level: a.ficha && a.ficha.level, shiny: !!(a.ficha && a.ficha.shiny), qtd: a.qtd || 1, preco: a.preco, moeda: a.moeda, retidoAte: a.compravelEm || 0, sp: a.ficha && a.ficha.speciesId, iv: a.ficha && a.ficha.ivs ? Object.values(a.ficha.ivs).reduce((t, x) => t + (Number(x) || 0), 0) : 0, q: a.ficha && (a.ficha.quality != null ? a.ficha.quality : a.ficha.qualidade), pot: a.ficha && a.ficha.potencia, ivs: (a.ficha && a.ficha.ivs) || null, refino: (a.ficha && a.ficha.refino) || null, aoe: !!(a.ficha && (a.ficha.tmAoe === true || a.ficha.tmAoe === 1)), favoritos: a.favoritos })) };
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
  const DEFAULT = { accounts: [], selected: null, autoBackgroundUltra: false, autoFreezeMin: 0, optimizeEvery: 0 };
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
    // Página travada (congelou): se em 15 s não voltar a responder, abre a conta de novo num processo
    // novo — o mesmo que fechar e abrir o app, sem perder o login.
    let travadaTimer = null;
    v.webContents.on('unresponsive', () => {
      travadas.add(a.id);
      clearTimeout(travadaTimer);
      travadaTimer = setTimeout(() => { if (views.get(a.id) === v && !v.webContents.isDestroyed()) reopen(a.id, 'travou'); }, 15 * 1000);
    });
    v.webContents.on('responsive', () => { travadas.delete(a.id); clearTimeout(travadaTimer); });
    // Quando a pessoa mexe na conta: o "Otimizar sozinho" espera ela parar.
    v.webContents.on('before-input-event', () => lastInput.set(a.id, Date.now()));
    openedAt.set(a.id, Date.now());
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
    let u = null;
    try { u = new URL(v.webContents.getURL()); } catch {}
    const naTelaDoJogo = u && isPokeIdle(u.href) && (u.pathname === '/app' || u.pathname.startsWith('/app/'));
    if (u && isPokeIdle(u.href) && !naTelaDoJogo && !v.webContents.isLoading()) {
      if (!fora.has(id)) { fora.set(id, Date.now()); setTimeout(() => readOne(id), 21 * 1000); }
      else if (Date.now() - fora.get(id) > 20 * 1000) { fora.delete(id); v.webContents.loadURL(urlOf(acc)); }
    } else fora.delete(id);
    // Sinal de vida: a página congelada não responde (e conta parada não dispara o aviso do Electron,
    // que depende de clique). Sem resposta em 15 s, a conta é reaberta num processo novo.
    if (!v.webContents.isLoading()) {
      const vivo = await Promise.race([v.webContents.executeJavaScript('1').then(() => true, () => true), new Promise((res) => setTimeout(() => res(false), 15 * 1000))]);
      if (!vivo) { if (views.get(id) === v) reopen(id, 'travou'); return; }
    }
    const r = await v.webContents.executeJavaScript(READ_SCRIPT).catch(() => null);
    if (r) {
      const canais = r.canais; delete r.canais;
      if (Array.isArray(r.hunts) && r.hunts.length) huntLevels = r.hunts;
      delete r.hunts;
      const prev = info.get(id);
      info.set(id, { ...r, at: Date.now(), huntRank: prev ? prev.huntRank : null });
      // Login feito (a sessão já está salva) mas a tela continua no login: é o "trava e só entra
      // fechando e abrindo o app". O app faz isso sozinho, só nesta conta.
      if (!r.logged && r.temSessao) {
        if (!stuckSince.has(id)) stuckSince.set(id, Date.now());
        else if (Date.now() - stuckSince.get(id) > 20 * 1000 && Date.now() - (lastReopen.get(id) || 0) > 2 * 60 * 1000) { stuckSince.delete(id); reopen(id, 'login preso'); }
        setTimeout(() => readOne(id), 10 * 1000); // confere de novo logo
      } else stuckSince.delete(id);
      // Diário: horas logadas, histórico do dia e vigia (conta parada, caiu, shiny).
      // No ULTRA a tela não mostra a hunt: vale o nome que a sugestão de hunt leu pela conexão.
      const hrAtual = prev && prev.huntRank && prev.huntRank.atualEst && prev.huntRank.atualEst.nome;
      if (ctx.onPokeRead) { try { ctx.onPokeRead(id, { ...r, where: r.where && r.where !== '—' ? r.where : (hrAtual || null) }); } catch {} }
      if (canais && ctx.onOfficial) { try { ctx.onOfficial(canais, id); } catch {} }
      send('status', snapshot());
    }
  }
  async function readAll() { for (const id of views.keys()) await readOne(id); autoFreeze(); }

  // ---------- Otimizar: fecha e abre a conta num processo novo ----------
  // Libera a memória que a página acumula com horas aberta. O login e o placar da sessão ficam (estão
  // salvos na conta). "Otimizar sozinho" faz isso no tempo escolhido, sempre (a tela fica aberta e "mexendo" o tempo todo).
  const stuckSince = new Map(), lastReopen = new Map(), lastInput = new Map(), openedAt = new Map(), travadas = new Set(), fora = new Map();
  const optLog = new Map(); // id -> [{ t, mb, motivo }]
  function memOf(id) {
    const v = views.get(id);
    if (!v || v.webContents.isDestroyed()) return null;
    try {
      const pid = v.webContents.getOSProcessId();
      const m = app.getAppMetrics().find((x) => x.pid === pid);
      return m ? Math.round(m.memory.workingSetSize / 1024) : null;
    } catch { return null; }
  }
  function reopen(id, motivo) {
    const a = account(id);
    const old = views.get(id);
    if (!a || !old) return false;
    const mb = memOf(id);
    try { if (mainWin && !mainWin.isDestroyed() && mainWin.contentView.children.includes(old)) mainWin.contentView.removeChildView(old); } catch {}
    views.delete(id);
    travadas.delete(id); stuckSince.delete(id); fora.delete(id);
    try { old.webContents.close(); } catch {}
    createView(a);
    layout();
    lastReopen.set(id, Date.now());
    if (ctx.onPokeEvent) { try { ctx.onPokeEvent(id, 'reaberta', motivo); } catch {} }
    const log = optLog.get(id) || [];
    log.unshift({ t: Date.now(), mb, motivo });
    optLog.set(id, log.slice(0, 5));
    send('status', snapshot());
    return true;
  }
  const ocupada = (id) => isShown(id) && mainWin && !mainWin.isDestroyed() && mainWin.isFocused() && Date.now() - (lastInput.get(id) || 0) < 2 * 60 * 1000;
  function autoOptimize() {
    const every = (config.optimizeEvery || 0) * 60 * 1000;
    if (!every) return;
    // Uma conta por vez (por minuto), para não derrubar todas juntas.
    for (const a of config.accounts) {
      if (!views.has(a.id)) continue;
      const desde = Math.max(openedAt.get(a.id) || 0, lastReopen.get(a.id) || 0);
      if (Date.now() - desde < every) continue;
      reopen(a.id, 'sozinho');
      return;
    }
  }

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
  // Arquétipos: times do top que dividem 3 ou mais pokémon formam um grupo. Cada grupo ganha uma
  // nota (quantos usam, PR médio e taxa de vitória média) e uma tier: S, A, B ou C.
  function buildArchetypes(linhas, perfis) {
    const teams = linhas.filter((l) => perfis[l.nick] && perfis[l.nick].time && perfis[l.nick].time.length)
      .map((l) => ({ ...l, sp: perfis[l.nick].time.map((k) => k.speciesId), wr: l.v / Math.max(1, l.v + l.d) }));
    const groups = [];
    for (const t of teams) {
      const g = groups.find((x) => t.sp.filter((id) => x.seed.includes(id)).length >= 3);
      if (g) g.teams.push(t); else groups.push({ seed: t.sp, teams: [t] });
    }
    const maxN = Math.max(1, ...groups.map((g) => g.teams.length));
    const prs = teams.map((t) => t.pr);
    const minPr = Math.min(...prs), maxPr = Math.max(...prs);
    const out = groups.map((g, i) => {
      const freq = {};
      for (const t of g.teams) for (const id of t.sp) freq[id] = (freq[id] || 0) + 1;
      const core = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([id]) => Number(id));
      const n = g.teams.length;
      const pr = g.teams.reduce((s2, t) => s2 + t.pr, 0) / n;
      const wr = g.teams.reduce((s2, t) => s2 + t.wr, 0) / n;
      const score = 0.45 * (n / maxN) + 0.35 * ((pr - minPr) / Math.max(1, maxPr - minPr)) + 0.2 * wr;
      return { id: i, key: core.slice(0, 3).sort((a, b) => a - b).join('-'), core: core.slice(0, 5), n, pr: Math.round(pr), wr: Math.round(wr * 1000) / 1000, best: Math.min(...g.teams.map((t) => t.pos)), nicks: g.teams.map((t) => t.nick), rep: g.teams[0].nick, score };
    }).sort((a, b) => b.score - a.score);
    const ranked = out.filter((a) => a.n >= 2);
    ranked.forEach((a, i) => { const q = i / Math.max(1, ranked.length); a.tier = q < 0.2 ? 'S' : q < 0.5 ? 'A' : q < 0.8 ? 'B' : 'C'; });
    for (const a of out) if (!a.tier) a.tier = 'U'; // time único (ninguém mais no top usa parecido)
    const porNick = {};
    for (const a of out) for (const nk of a.nicks) porNick[nk] = a.id;
    return { arqs: out, porNick };
  }
  // Histórico do meta (14 leituras) para a tendência: uso de cada espécie e de cada arquétipo.
  const histPath = () => path.join(app.getPath('userData'), 'pvp-historico.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
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
      const linhas = d.linhas.slice(0, PVP_N);
      const { arqs, porNick } = buildArchetypes(linhas, d.perfis);
      // Melhores espécies contra o meta (qualquer uma, inclusive Mega), num pokémon de referência do
      // nível/potência típicos do top, em duelo 1×1 do jogo contra cada pokémon do top.
      const entries = [];
      for (const l of linhas) { const p = d.perfis[l.nick]; if (!p) continue; const w = 1 + (51 - Math.min(50, l.pos)) / 50; for (const k of p.time) entries.push({ ...k, w, arq: porNick[l.nick] }); }
      const lv = entries.map((e) => e.level).sort((a, b) => a - b);
      const med = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : null;
      const num = (arr) => arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      const medObj = (campo, chaves) => Object.fromEntries(chaves.map((k) => [k, med(num(entries.map((e) => Number((e[campo] || {})[k])))) || 0]));
      // Pokémon de referência = a mediana do top: nível, potência, qualidade, IV e refino (o mesmo investimento).
      const ref = { level: med(lv) || 3000, potencia: med(num(entries.map((e) => Number(e.potencia)))) || 2, quality: med(num(entries.map((e) => Number(e.quality)))) || 1.25,
        ivs: medObj('ivs', ['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed']), refino: medObj('refino', ['hp', 'atk', 'def', 'spAtk', 'spDef']),
        shiny: entries.filter((e) => e.shiny).length > entries.length / 2 }; // o shiny dá ×3 nos status no jogo
      const cand = await v.webContents.executeJavaScript(`window.__idleterinoMercado.candidatos(${JSON.stringify(entries)}, ${JSON.stringify({ ref, top: 40 })})`).catch(() => null);
      const candidatos = cand && Array.isArray(cand.lista) ? cand.lista : [];
      // Preço no Market agora: os melhores candidatos e os mais usados do top.
      const usados = {};
      for (const e of entries) usados[e.nome || e.speciesId] = (usados[e.nome || e.speciesId] || 0) + 1;
      const nomes = [...new Set([...candidatos.filter((x) => !x.lend).slice(0, 20).map((x) => x.nome), ...Object.entries(usados).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n)])].filter((n) => typeof n === 'string');
      const precos = await v.webContents.executeJavaScript(`window.__idleterinoMercado.precos(${JSON.stringify(nomes)})`).catch(() => null);
      pvpMeta = { at: Date.now(), linhas, perfis: d.perfis, info: d.info, tabelaTipos: d.tabelaTipos, arqs, porNick, ref, candidatos, precos: precos && !precos.erro ? precos : {} };
      fs.writeFileSync(pvpPath(), JSON.stringify(pvpMeta));
      // tendência
      const hist = readJson(histPath(), []);
      const uso = {};
      for (const e of entries) uso[e.speciesId] = (uso[e.speciesId] || 0) + 1;
      hist.push({ at: pvpMeta.at, uso, arqs: Object.fromEntries(arqs.map((a) => [a.key, a.n])) });
      fs.writeFileSync(histPath(), JSON.stringify(hist.slice(-14)));
      return true;
    } finally { pvpRunning = false; send('status', snapshot()); }
  }
  const mePath = () => path.join(app.getPath('userData'), 'pvp-eu.json');
  async function pvpSnapshotMe() {
    const all = readJson(mePath(), {});
    for (const a of config.accounts) {
      const v = views.get(a.id);
      if (!v || v.webContents.isDestroyed() || !isPokeIdle(urlOf(a))) continue;
      const p = await v.webContents.executeJavaScript('window.__idleterinoMercado ? window.__idleterinoMercado.pvpEu() : null').catch(() => null);
      if (!p || p.pontos == null) continue;
      const list = all[a.id] || (all[a.id] = []);
      const last = list[list.length - 1];
      const row = { t: Date.now(), pr: p.pontos, pico: p.pico, v: p.vitorias, d: p.derrotas, seq: p.sequencia, tier: p.tierId, div: p.divisaoNum, pos: p.posicao, decai: p.decaiEm };
      if (!last || last.pr !== row.pr || last.v !== row.v || last.d !== row.d || Date.now() - last.t > 6 * 3600 * 1000) list.push(row);
      all[a.id] = list.filter((r) => Date.now() - r.t < 30 * 86400000).slice(-500);
    }
    fs.writeFileSync(mePath(), JSON.stringify(all));
  }
  // Alerta de Market: as espécies que a pessoa marcou ("avise quando baratear"), a cada 30 min.
  async function pvpWatch() {
    const names = (config.pvpWatch || []).slice(0, 8);
    if (!names.length) return;
    const v = views.get(mainAccId());
    if (!v || v.webContents.isDestroyed()) return;
    const r = await v.webContents.executeJavaScript(`window.__idleterinoMercado.precos(${JSON.stringify(names)})`).catch(() => null);
    if (!r || r.erro) return;
    config.pvpWatchHist = config.pvpWatchHist || {};
    for (const n of names) {
      const row = (r[n] || []).find((x) => String(x.nome).toLowerCase() === String(n).toLowerCase()) || (r[n] || [])[0];
      if (!row) continue;
      const h = config.pvpWatchHist[n] || (config.pvpWatchHist[n] = []);
      for (const [moeda, campo, nome] of [['orb', 'minOrb', 'gemas'], ['gold', 'minGold', 'coins']]) {
        const val = Number(row[campo]);
        if (!(val > 0)) continue;
        const prev = h.map((x) => x[moeda]).filter((x) => x > 0).sort((a, b) => a - b);
        const mediana = prev.length >= 3 ? prev[Math.floor(prev.length / 2)] : null;
        if (mediana && val <= mediana * 0.85 && (ctx.alert || ctx.notify)) (ctx.alert ? (t, b) => ctx.alert('mercado', t, b, n) : ctx.notify)(`${row.nome} mais barato no Market`, `A partir de ${val.toLocaleString('pt-BR')} ${nome} (antes ~${mediana.toLocaleString('pt-BR')}). ${row.anuncios} ofertas. Abra o Market no jogo para ver.`);
      }
      h.push({ t: Date.now(), orb: Number(row.minOrb) || 0, gold: Number(row.minGold) || 0 });
      config.pvpWatchHist[n] = h.slice(-12);
    }
    saveConfig();
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
    return { meta: pvpMeta, hist: readJson(histPath(), []), me: (readJson(mePath(), {})[id] || []), watch: config.pvpWatch || [], watchHist: config.pvpWatchHist || {}, running: pvpRunning, prog, accountId: id, live: live && !live.erro ? { meus: live.meus, info: live.info, euPvp: live.euPvp, nick: live.nick, nivel: live.nivel, tabelaTipos: live.tabelaTipos } : null };
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
      optimizeEvery: config.optimizeEvery || 0,
      voteMs: VOTE_MS, marketAt: lastMarket, hunts: huntLevels, pvpAt: pvpMeta ? pvpMeta.at : 0, pvpRunning,
      accounts: config.accounts.map((a) => ({ ...a, horas: ctx.horasOf ? ctx.horasOf(a.id) : null, memMB: memOf(a.id), optLog: optLog.get(a.id) || [], optNext: config.optimizeEvery ? Math.max(openedAt.get(a.id) || 0, lastReopen.get(a.id) || 0) + config.optimizeEvery * 60000 : null, vote: (config.votes || {})[a.id] || null, url: urlOf(a), isPoke: isPokeIdle(urlOf(a)), host: hostOf(urlOf(a)), effectiveMode: effectiveMode(a), zoom: a.zoom || 1, info: info.get(a.id) || null, frozen: frozen.has(a.id), frozenImg: frozen.get(a.id) || null })),
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
  // ↻ Recarregar: sempre leva de volta à página do JOGO (recarregar a página de retorno do login do
  // Google, já usada, deixava a tela parada). Conta travada (não responde) é reaberta num processo novo.
  ipcMain.handle('poke:reload', (_e, id) => {
    const v = views.get(id); const a = account(id);
    if (!v || !a) return snapshot();
    if (v.webContents.isDestroyed() || v.webContents.isCrashed() || travadas.has(id)) reopen(id, 'recarregar');
    else v.webContents.loadURL(urlOf(a));
    return snapshot();
  });
  // A tela diz onde a conta aparece e se a página PokeIdle está aberta.
  const toRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
  ipcMain.handle('poke:market:refresh', () => { if (Date.now() - lastMarket > 60 * 1000) askMarket(); return snapshot(); });
  ipcMain.handle('poke:vote', (_e, id) => {
    const v = (config.votes || {})[id];
    if (v && ctx.openOutside) { ctx.openOutside(v.url); config.votes[id] = { ...v, at: Date.now() }; saveConfig(); }
    return snapshot();
  });
  ipcMain.handle('poke:optimize', (_e, id) => { reopen(id, 'manual'); return snapshot(); });
  ipcMain.handle('poke:optimizeAll', async () => {
    for (const a of config.accounts) { if (views.has(a.id)) { reopen(a.id, 'manual'); await new Promise((r) => setTimeout(r, 1500)); } }
    return snapshot();
  });
  ipcMain.handle('poke:optimizeEvery', (_e, min) => { config.optimizeEvery = [0, 30, 60, 120, 300].includes(Number(min)) ? Number(min) : 0; saveConfig(); return snapshot(); });
  ipcMain.handle('poke:pvp:get', (_e, accId) => pvpGet(accId));
  // "Ver no Market": abre o anúncio no jogo (o mesmo caminho do link do #comércio).
  ipcMain.handle('poke:anuncio:abrir', async (_e, id) => { const r = await api.abrirAnuncio(id).catch(() => ({ erro: 'Não deu para abrir o anúncio.' })); return r; });
  // Aba PvE: as contas leem os dados do próprio jogo (próximas hunts, evoluções).
  ipcMain.handle('poke:pve', async (_e, accId, o, arg) => {
    if (!['proximas', 'evolucoes', 'meus', 'buscar', 'mercado', 'casas'].includes(o)) return null;
    const v = views.get(accId) || views.get(mainAccId());
    if (!v || v.webContents.isDestroyed()) return { erro: 'Conta do PokeIdle fechada.' };
    return v.webContents.executeJavaScript(`window.__idleterinoMercado && window.__idleterinoMercado.pve ? window.__idleterinoMercado.pve(${JSON.stringify(o)}, ${JSON.stringify(arg == null ? null : arg)}) : null`).catch(() => null);
  });
  ipcMain.handle('poke:pvp:duel', async (_e, accId, a, b) => {
    const id = account(accId) ? accId : mainAccId();
    const v = id && views.get(id);
    if (!v || v.webContents.isDestroyed()) return null;
    return v.webContents.executeJavaScript(`window.__idleterinoMercado.duelos(${JSON.stringify(a || [])}, ${JSON.stringify(b || [])})`).catch(() => null);
  });
  // Busca no Market na hora: as espécies mais fortes contra o meta (sem lendário) e as ofertas delas.
  let buscando = false;
  ipcMain.handle('poke:pvp:mercado', async (_e, moeda) => {
    if (buscando) return { erro: 'Já estou procurando. Espere terminar.' };
    if (!pvpMeta || !pvpMeta.candidatos) return { erro: 'Atualize o meta primeiro.' };
    const v = views.get(mainAccId());
    if (!v || v.webContents.isDestroyed()) return { erro: 'A conta principal precisa estar aberta no app.' };
    buscando = true;
    try {
      const entries = [];
      for (const l of pvpMeta.linhas) { const p = pvpMeta.perfis[l.nick]; if (!p) continue; const w = 1 + (51 - Math.min(50, l.pos)) / 50; for (const k of p.time) entries.push({ ...k, w }); }
      const ids = pvpMeta.candidatos.filter((x) => !x.lend).slice(0, 15).map((x) => x.speciesId);
      const r = await v.webContents.executeJavaScript(`window.__idleterinoMercado.ofertas(${JSON.stringify(ids)}, ${JSON.stringify(moeda === 'gold' ? 'gold' : 'orb')}, ${JSON.stringify(entries)})`).catch(() => null);
      if (!r) return { erro: 'Não consegui consultar o Market agora.' };
      if (r.erro === 'mercado-aberto') return { erro: 'Feche o Market dentro do jogo e tente de novo (com ele aberto, a consulta apareceria na sua tela).', lista: r.lista || [] };
      return { lista: r.lista || [], em: Date.now() };
    } finally { buscando = false; }
  });
  ipcMain.handle('poke:pvp:watch', (_e, names) => {
    config.pvpWatch = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n).slice(0, 40)))].slice(0, 8);
    saveConfig();
    setTimeout(() => pvpWatch().catch(() => {}), 2000);
    return config.pvpWatch;
  });
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

  // ---------- TRADER (escondido, só no app do dono): o Market de 5 em 5 min pela conta principal ----------
  // A conta principal varre as ofertas novas, compara com a Tabela de preços do jogo e avisa as pechinchas.
  // Compra sozinha só em COINS e só dentro dos limites daqui (gema: só avisa). Tudo desligado por padrão.
  // TRADER: só no PC do dono (trader-main.js fica fora do Git e do app público). Sem o arquivo, nada existe.
  let trader = null;
  try { trader = require('./trader-main')({ ipcMain, views, mainAccId, config, saveConfig, send, ctx, app, path, fs }); } catch {}
  const timers = [];
  function start() {
    loadConfig();
    for (const a of config.accounts) createView(a);
    timers.push(setInterval(readAll, READ_MS));
    timers.push(setInterval(autoOptimize, 60 * 1000));
    if (trader) timers.push(setInterval(() => trader.tick().catch(() => {}), 30 * 1000));
    setTimeout(askMarket, 60 * 1000);
    // PvP: confere de hora em hora se o meta tem mais de um dia; a primeira, 3 min depois de abrir.
    setTimeout(() => pvpCollect().catch(() => {}), 3 * 60 * 1000);
    timers.push(setInterval(() => pvpCollect().catch(() => {}), 60 * 60 * 1000));
    setTimeout(() => pvpSnapshotMe().catch(() => {}), 2 * 60 * 1000);
    timers.push(setInterval(() => pvpSnapshotMe().catch(() => {}), 60 * 60 * 1000));
    timers.push(setInterval(() => pvpWatch().catch(() => {}), 30 * 60 * 1000));
    // Com o comércio da guild ligado, a leitura dos anúncios vem a cada 5 min (senão, 10 min).
    timers.push(setInterval(() => { const cada = ctx.comercioAtivo && ctx.comercioAtivo() ? 5 * 60 * 1000 : MARKET_MS; if (Date.now() - lastMarket >= cada - 5000) askMarket(); }, 60 * 1000));
  }
  const api = {
    partitions: () => config.accounts.map((a) => partitionOf(a.id)),
    reloadAll: () => { for (const v of views.values()) if (!v.webContents.isDestroyed()) v.webContents.reload(); },
    start, snapshot, setMain: (w) => { mainWin = w; mainWin.on('resize', () => send('relayout', true)); },
    trayInfo: () => ({ accounts: config.accounts.length }),
    noteOutside,
    // Para o diário (modo noite e painel): ler as contas e trocar o modo / o otimizar sozinho.
    accounts: () => config.accounts.map((a) => ({ ...a, isPoke: isPokeIdle(urlOf(a)) })),
    // "Levar para o celular": o login do PokeIdle desta conta (o `sessao` da página), só a pedido da pessoa.
    lerSessao: async (id) => {
      const v = views.get(id);
      if (!v || v.webContents.isDestroyed()) return null;
      const txt = await v.webContents.executeJavaScript("localStorage.getItem('sessao')").catch(() => null);
      try { return txt ? JSON.parse(txt) : null; } catch { return null; }
    },
    infoOf: (id) => info.get(id) || null,
    setModes: (map) => { for (const [id, m] of Object.entries(map || {})) { const a = account(id); if (a && MODES[m] && a.mode !== m) { a.mode = m; applyMode(id); } } saveConfig(); send('status', snapshot()); },
    getOptimizeEvery: () => config.optimizeEvery || 0,
    mainId: () => mainAccId(),
    refreshMarket: () => { if (Date.now() - lastMarket > 60 * 1000) askMarket(); },
    // Comércio: a nota e os stats da ficha de um anúncio, calculados na página do jogo desta conta.
    fichaNota: async (accId, f) => {
      const v = views.get(accId);
      if (!v || v.webContents.isDestroyed()) return null;
      return v.webContents.executeJavaScript(`window.__idleterinoMercado && window.__idleterinoMercado.fichaNota ? window.__idleterinoMercado.fichaNota(${JSON.stringify(f)}) : null`).catch(() => null);
    },
    // Link do #comércio no Discord: leva ao anúncio no Market do jogo, na conta logada (a da frente,
    // senão a principal). Usa o mesmo caminho do link de anúncio do chat do jogo: o jogo busca o
    // anúncio na hora e mostra a folha dele. Comprar continua sendo um clique da pessoa.
    abrirAnuncio: async (anuncioId) => {
      const n = Number(anuncioId);
      if (!Number.isSafeInteger(n) || n <= 0) return { erro: 'Link de anúncio inválido.' };
      const logada = (a) => a && isPokeIdle(urlOf(a)) && views.get(a.id) && (info.get(a.id) || {}).logged;
      const acc = [account(config.selected), account(mainAccId()), ...config.accounts].find(logada);
      if (!acc) return { erro: 'Entre numa conta do PokeIdle no Idleterino para ver o anúncio.' };
      const prev = config.selected;
      config.selected = acc.id; saveConfig();
      frozen.delete(acc.id);
      if (config.autoBackgroundUltra) { if (prev && prev !== acc.id) applyMode(prev); applyMode(acc.id); }
      layout();
      send('abrir', snapshot());
      // No ULTRA o jogo esconde tudo: sai dele pelo botão "Sair" da própria caixa (sem recarregar) e,
      // quando a pessoa fechar o Market, o app põe a conta de volta no modo dela.
      const js = `(async () => { const dorme = (ms) => new Promise((r) => setTimeout(r, ms)); let saiuUltra = false;
        for (let i = 0; i < 60; i++) { const box = document.getElementById('chat-msgs');
          if (box && document.querySelector('.menu-topo')) {
            const sair = document.documentElement.classList.contains('modo-ultra') && document.getElementById('ultra-sair');
            if (sair) { sair.click(); saiuUltra = true; await dorme(700); }
            const b = document.createElement('button'); b.type = 'button'; b.className = 'm-anuncio-link';
            b.dataset.anuncio = '${n}'; b.style.display = 'none'; box.appendChild(b); b.click(); b.remove(); return { ok: true, saiuUltra }; }
          await dorme(250); } return { ok: false }; })()`;
      const wc = views.get(acc.id).webContents;
      const r = await wc.executeJavaScript(js).catch(() => ({ ok: false }));
      if (r.saiuUltra) {
        // Volta para o ULTRA quando o Market fechar (confere a cada 3 s, por até 30 min).
        const fim = Date.now() + 30 * 60 * 1000;
        const vigia = setInterval(async () => {
          if (wc.isDestroyed()) return clearInterval(vigia);
          const aberto = await wc.executeJavaScript("(() => { const m = document.getElementById('modal'); return !!m && getComputedStyle(m).display !== 'none'; })()").catch(() => false);
          if (!aberto || Date.now() > fim) { clearInterval(vigia); applyMode(acc.id); }
        }, 3000);
      }
      const i = info.get(acc.id) || {};
      return r.ok ? { ok: true, nick: i.nick && i.nick !== '—' ? i.nick : acc.name } : { erro: 'O jogo ainda está carregando. Clique no link de novo em instantes.' };
    },
    setOptimizeEvery: (min) => { config.optimizeEvery = [0, 30, 60, 120, 300].includes(Number(min)) ? Number(min) : 0; saveConfig(); send('status', snapshot()); },
  };
  return api;
};
