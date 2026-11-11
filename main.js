// Idleterino — a casca do app: janela, bandeja, atualização, iniciar com o sistema e o registro de
// quais sites cada sessão pode abrir. Twitch e Kick moram em platforms/ (cada um com seu login,
// sua configuração e seus canais de IPC "twitch:..." e "kick:..."). O PokeIdle mora em pokeidle.js.
const { app, BrowserWindow, ipcMain, session, shell, Tray, Menu, Notification, nativeImage, powerMonitor, dialog, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Lives e jogo rodando mesmo com janelas ocultas ou minimizadas.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackgroundVideoTrackOptimization,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=1');

// Pasta de dados alternativa (testes sem mexer na instalação de verdade).
if (process.env.IDLETERINO_DATA) app.setPath('userData', process.env.IDLETERINO_DATA);
// Twitch e Kick recusam login de navegador desconhecido: o app se apresenta como o Chrome que ele é.
// As contas do PokeIdle usam a identificação original (o Google aceita o login com ela; ver pokeidle.js).
const ORIGINAL_UA = app.userAgentFallback;
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|idleterino|Idleterino)\/\S+/g, '');

const isLinux = process.platform === 'linux';
const ICON = path.join(__dirname, 'build', 'icon.png');

// ---------- Configuração da casca ----------
const configPath = () => path.join(app.getPath('userData'), 'idleterino.json');
const DEFAULT_CONFIG = { platforms: { twitch: true, kick: true }, trayHintShown: false, lastSeenVersion: null };
let config = { ...DEFAULT_CONFIG };
let firstRun = false;
function loadConfig() {
  firstRun = !fs.existsSync(configPath());
  try { config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch {}
  config.platforms = { ...DEFAULT_CONFIG.platforms, ...config.platforms };
  saveConfig();
}
function saveConfig() { fs.writeFileSync(configPath(), JSON.stringify(config, null, 2)); }

// ---------- Quais sites cada sessão pode abrir ----------
// Cada módulo registra a sua partição e a sua regra. A janela do app (sessão padrão) só abre os
// próprios arquivos. Pop-ups de login abrem numa janela normal com a mesma sessão.
const trusts = new Map(); // partição -> (url) => boolean
function trustFor(wc) {
  for (const [partition, fn] of trusts) if (wc.session === session.fromPartition(partition)) return { partition, fn };
  return null;
}
let lastOutside = 0;
function openOutside(url) {
  try { if (new URL(url).protocol !== 'https:') return; } catch { return; }
  if (Date.now() - lastOutside < 2000) return;
  lastOutside = Date.now();
  shell.openExternal(url).catch(() => {});
}
app.on('web-contents-created', (_e, wc) => {
  // Ferramentas de desenvolvedor fechadas no app instalado: ninguém abre o console de uma conta
  // para copiar cookies ou injetar código.
  if (app.isPackaged) wc.on('devtools-opened', () => wc.closeDevTools());
  // Nenhuma página baixa programa (exe, scripts, instaladores) pelo app.
  wc.session.on('will-download', (event, item) => {
    if (/\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|dll|appimage|deb|sh|apk|dmg|pkg)$/i.test(item.getFilename())) event.preventDefault();
  });
  // Páginas não podem trocar de janela para endereços estranhos (file://, javascript:, etc.).
  wc.on('will-attach-webview', (event) => event.preventDefault());
  // Nenhuma página segura o fechamento ("Deseja sair do site?"): uma live escondida da Kick fazia
  // o Sair parar no meio, com a janela fechada e o app ainda rodando.
  wc.on('will-prevent-unload', (event) => event.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    const t = trustFor(wc);
    // Contas do PokeIdle: link de outro site (ex.: "Votar no TopIdle", Discord) abre no navegador
    // padrão da pessoa, fora da sessão da conta. Só https e no máximo um a cada 2 s.
    if (t && !t.fn(url) && t.partition.startsWith('persist:poke-')) { openOutside(url); poke.noteOutside(t.partition, url); return { action: 'deny' }; }
    return t && t.fn(url) ? {
      action: 'allow',
      overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, icon: ICON, webPreferences: { partition: t.partition } },
    } : { action: 'deny' };
  });
  const guard = (details) => {
    if (!details.isMainFrame) return;
    const t = trustFor(wc);
    const ok = t ? t.fn(details.url) : details.url.startsWith('file://');
    if (!ok) details.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
});

// ---------- Janela, avisos, bandeja ----------
let mainWin = null;
const send = (channel, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload); };
const liveNotifications = new Set();
function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  liveNotifications.add(n);
  n.on('click', () => { liveNotifications.delete(n); if (onClick) onClick(); });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}
// Sair de vez: fecha tudo à força. Usado se algo segurar o fechamento normal.
function forceQuit() {
  app.isQuitting = true;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  app.quit();
}
function showMain() {
  if (!mainWin) return;
  // Janela já fechada = o app estava saindo e travou: termina a saída (abre de novo pelo atalho).
  if (mainWin.isDestroyed()) return forceQuit();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}
function quitApp() { app.isQuitting = true; app.quit(); }

// Iniciar com o sistema (o portátil roda de uma pasta temporária: vale o .exe original).
const LOGIN_ITEM = { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] };
const autostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'), 'autostart', 'idleterino.desktop');
const isOpenAtLogin = () => (isLinux ? fs.existsSync(autostartFile()) : app.getLoginItemSettings(LOGIN_ITEM).openAtLogin);
function setOpenAtLogin(on) {
  if (!isLinux) return app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: on });
  const file = autostartFile();
  if (!on) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Idleterino\nExec="${process.env.APPIMAGE || process.execPath}" --hidden\nIcon=idleterino\nX-GNOME-Autostart-enabled=true\n`);
}

let tray = null;
const clock = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
function updateTray() {
  if (!tray) return;
  const now = Date.now();
  const lines = ['Idleterino'];
  for (const m of Object.values(modules)) {
    const i = m.trayInfo();
    if (!i.started) continue;
    const name = m.ns === 'twitch' ? 'Twitch' : 'Kick';
    const active = i.bonuses.filter((b) => b.endsAt).map((b) => `${b.name.replace('+15% ', '')} ${clock(b.endsAt - now)}`);
    lines.push(`${name}: ${i.watching} assistindo${i.gained ? ` · +${i.gained} pts` : ''}${active.length ? ` · ${active.join(', ')}` : ''}`);
  }
  tray.setToolTip(lines.join('\n').slice(0, 127));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Idleterino', click: showMain },
    ...(update && update.state === 'ready' ? [{ label: `Atualizar agora (${update.version})`, click: installUpdate }] : []),
    { type: 'separator' },
    { label: 'Sair', click: quitApp },
  ]));
}

// ---------- Módulos ----------
const ctx = {
  send, notify, showMain, quit: quitApp, updateTray, isOpenAtLogin,
  registerTrust: (partition, fn) => trusts.set(partition, fn),
  openOutside,
  originalUA: ORIGINAL_UA,
};
const modules = {
  twitch: require('./platforms/twitch')(ctx),
  kick: require('./platforms/kick')(ctx),
};
// Lista oficial de canais vinda do jogo: novos canais entram sozinhos na Twitch e na Kick.
ctx.onOfficial = (canais, accountId) => {
  if (canais && canais.kick && modules.kick.setGameBonus) modules.kick.setGameBonus(accountId, canais.kick.bonus);
  for (const ns of ['twitch', 'kick']) {
    const b = canais && canais[ns];
    if (!b || !modules[ns]) continue;
    const fresh = modules[ns].syncOfficial(b.oficiais);
    if (fresh.length) send('twitch:toast', `${fresh.length === 1 ? 'Novo canal oficial' : 'Novos canais oficiais'} na ${ns === 'twitch' ? 'Twitch' : 'Kick'}: ${fresh.join(', ')}`);
  }
};
const poke = require('./pokeidle')(ctx);
// Extensões: só nas sessões das contas do PokeIdle.
ctx.mainWin = () => mainWin;
ctx.pokePartitions = () => poke.partitions();
ctx.reloadPoke = () => poke.reloadAll();
const extensions = require('./extensions')(ctx);
ctx.applyExtensions = (partition) => extensions.applyTo(partition);
// Diário: horas logadas, histórico, vigia com avisos (PC, celular, Discord), modo noite e painel Wi-Fi.
const diario = require('./diario')(ctx, poke);
// #comércio da guild no Discord: anúncios do Market postados sozinhos (webhook do canal).
const comercio = require('./comercio')(ctx, poke);
// "Levar para o celular": as contas do PokeIdle vão para o Idleterino Android por QR Code + PIN.
require('./celular')(ctx, poke);
ctx.comercioAtivo = () => comercio.ativo();
ctx.refreshMarket = () => poke.refreshMarket();
ctx.onPokeRead = (id, r) => { diario.onRead(id, r); comercio.onRead(id, r).catch(() => {}); };
ctx.onPokeEvent = (id, kind, motivo) => diario.onEvent(id, kind, motivo);
ctx.horasOf = (id) => diario.horasOf(id);
ctx.alert = (tipo, titulo, texto, chave) => diario.alerta(tipo, titulo, texto, chave);
// Rede de segurança: backups das configurações, proteção ao abrir e voltar de versão.
const seg = require('./seguranca')();

function setPlatform(ns, on) {
  config.platforms[ns] = !!on;
  saveConfig();
  if (on) modules[ns].start(); else modules[ns].stop();
  updateTray();
  send('app:state', appState());
}

function appState() {
  return {
    version: app.getVersion(), platform: process.platform, openAtLogin: isOpenAtLogin(),
    platforms: config.platforms, firstRun,
    fullscreen: !!(mainWin && !mainWin.isDestroyed() && mainWin.isFullScreen()),
    news: config.lastSeenVersion && config.lastSeenVersion !== app.getVersion(),
    update,
    seg: { falhas: seg.falhas(), canRollback: seg.canRollback() },
  };
}

// ---------- Atualização automática (GitHub Releases) ----------
// O Início mostra uma faixa quando sai versão nova, com o botão "Atualizar agora" (sem precisar
// sair pela bandeja). Instalador do Windows e AppImage: baixa sozinho e o botão instala e reabre.
// Portátil e .deb não se atualizam sozinhos: a faixa leva ao site para baixar.
const SITE = 'https://viinnisantoos.github.io/idleterino/';
let update = null; // { state: 'downloading' | 'ready' | 'manual', version, percent }
function setUpdate(u) { update = u; send('app:state', appState()); updateTray(); }
const newer = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
function installUpdate() {
  if (!update) return false;
  if (update.state === 'manual') { shell.openExternal(SITE).catch(() => {}); return true; }
  if (update.state !== 'ready') return false;
  seg.backupNow(`antes da ${update.version}`);
  app.isQuitting = true;
  // Silencioso. Quem reabre é o ajudante abaixo: o "reabrir" do instalador usa o atalho do Menu
  // Iniciar e, sem ele, mostra o erro "O Windows não pode encontrar ... .lnk".
  // O instalador nem sempre reabre o app no fim (testado em 05/11/2026): um ajudante escondido espera
  // a instalação terminar e abre o Idleterino. Se o instalador já tiver aberto, ele não faz nada.
  if (process.platform === 'win32') {
    try {
      const exe = process.execPath.replace(/'/g, "''");
      const ps = `$exe='${exe}'; Start-Sleep 4; $t=0; while ((Get-Process | Where-Object { $_.Path -like '*-updater\\*' -or $_.Path -eq $exe }) -and $t -lt 300) { Start-Sleep 1; $t++ }; Start-Sleep 2; if (-not (Get-Process | Where-Object { $_.Path -eq $exe })) { Start-Process -FilePath $exe }`;
      // Criado pelo próprio Windows (WMI), fora do grupo de processos do app: um filho comum é
      // encerrado junto quando o app fecha.
      const inner = `powershell.exe -NoProfile -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
      require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}' } | Out-Null`], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } catch {}
  }
  setImmediate(() => autoUpdater.quitAndInstall(true, false));
  return true;
}
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const auto = !process.env.PORTABLE_EXECUTABLE_FILE && !(isLinux && !process.env.APPIMAGE);
  if (!auto) {
    // Só confere a versão publicada (o mesmo arquivo que o atualizador lê).
    const feed = `https://github.com/ViinniSantoos/idleterino/releases/latest/download/${isLinux ? 'latest-linux.yml' : 'latest.yml'}`;
    const check = () => fetch(feed).then((r) => (r.ok ? r.text() : '')).then((t) => {
      const m = /^version:\s*([\d.]+)/m.exec(t);
      if (m && newer(m[1], app.getVersion()) && !seg.skipped(m[1])) setUpdate({ state: 'manual', version: m[1] });
    }).catch(() => {});
    check();
    setInterval(check, 60 * 60 * 1000); // procura versão nova de hora em hora
    return;
  }
  // Baixa só depois de conferir: a versão que a pessoa pulou (voltou dela por problema) não volta sozinha.
  autoUpdater.autoDownload = false;
  autoUpdater.on('error', () => { if (update && update.state === 'downloading') setUpdate(null); });
  autoUpdater.on('update-available', (i) => {
    if (seg.skipped(i.version)) return;
    setUpdate({ state: 'downloading', version: i.version, percent: 0 });
    autoUpdater.downloadUpdate().catch(() => { if (update && update.state === 'downloading') setUpdate(null); });
  });
  autoUpdater.on('download-progress', (p) => { if (update) { update.percent = Math.round(p.percent || 0); send('app:state', appState()); } });
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ state: 'ready', version: i.version });
    notify('Atualização pronta', `O Idleterino ${i.version} está pronto. Clique em "Atualizar agora" no Início.`, showMain);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000); // procura versão nova de hora em hora
}

// ---------- IPC da casca ----------
ipcMain.handle('app:state', () => appState());
ipcMain.handle('app:platform', (_e, ns, on) => { if (modules[ns]) setPlatform(ns, on); return appState(); });
ipcMain.handle('app:autostart', (_e, on) => { try { setOpenAtLogin(!!on); } catch {} return appState(); });
ipcMain.handle('app:introDone', () => { config.lastSeenVersion = app.getVersion(); firstRun = false; saveConfig(); return appState(); });
ipcMain.handle('app:quit', quitApp);
// Tela cheia da janela (modo foco do PokeIdle): F11 em qualquer tela do app ou o botão da faixa.
function toggleFullscreen() { if (mainWin && !mainWin.isDestroyed()) mainWin.setFullScreen(!mainWin.isFullScreen()); }
ipcMain.handle('app:fullscreen', () => { toggleFullscreen(); return appState(); });
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (ev, input) => { if (input.type === 'keyDown' && input.key === 'F11' && !input.alt && !input.control) { ev.preventDefault(); toggleFullscreen(); } });
});
ipcMain.handle('app:update:install', () => installUpdate());
// Segurança e versões
ipcMain.handle('app:seg:state', () => ({ backups: seg.list(), falhas: seg.falhas(), canRollback: seg.canRollback(), version: app.getVersion(), minRollback: seg.MIN_ROLLBACK }));
ipcMain.handle('app:seg:backup', () => { const id = seg.backupNow('feito por você'); return { ok: !!id, backups: seg.list() }; });
ipcMain.handle('app:seg:restore', async (_e, id) => {
  const { response } = await dialog.showMessageBox(mainWin, { type: 'question', buttons: ['Restaurar e reabrir', 'Cancelar'], defaultId: 0, cancelId: 1, title: 'Restaurar backup',
    message: 'Restaurar as configurações deste backup?', detail: 'Contas, canais, ajustes, extensões e histórico voltam como estavam. Os logins não mudam. O app fecha e abre de novo. As configurações de agora viram um backup, para dar para desfazer.' });
  if (response !== 0) return { ok: false, canceled: true };
  app.isQuitting = true;
  diario.save();
  return seg.restore(id);
});
ipcMain.handle('app:seg:versions', () => seg.versions());
let voltando = false;
ipcMain.handle('app:seg:rollback', async (_e, version) => {
  if (voltando) return { ok: false, error: 'Já estou fazendo isso.' };
  if (!seg.canRollback()) return { ok: false, error: 'Voltar de versão funciona no app instalado do Windows. No portátil e no Linux, baixe a versão no GitHub.' };
  const { response } = await dialog.showMessageBox(mainWin, { type: 'warning', buttons: [`Voltar para a ${version}`, 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Voltar de versão',
    message: `Instalar de volta o Idleterino ${version}?`, detail: `O app baixa a ${version} do GitHub, confere a assinatura, fecha, instala e abre de novo. A versão ${app.getVersion()} fica marcada para não voltar sozinha (quando sair uma correção, ela chega normalmente). Os logins e as configurações continuam.` });
  if (response !== 0) return { ok: false, canceled: true };
  voltando = true;
  try {
    const file = await seg.download(version, (p) => send('app:seg:progress', p));
    seg.skip(app.getVersion());
    seg.backupNow(`antes de voltar para a ${version}`);
    diario.save();
    if (!seg.runInstaller(file)) throw new Error('Não consegui iniciar o instalador.');
    app.isQuitting = true;
    setTimeout(() => forceQuit(), 500);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; } finally { voltando = false; }
});
// Wrapped e Cartão do Treinador: salvar ou copiar a imagem.
const pngOf = (dataUrl) => { const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '')); return m ? Buffer.from(m[1], 'base64') : null; };
ipcMain.handle('app:image:save', async (_e, dataUrl, name) => {
  const buf = pngOf(dataUrl); if (!buf) return false;
  const safe = String(name || 'idleterino').replace(/[^\w\- ]+/g, '').slice(0, 60) || 'idleterino';
  const r = await dialog.showSaveDialog(mainWin, { title: 'Salvar imagem', defaultPath: path.join(app.getPath('pictures'), `${safe}.png`), filters: [{ name: 'Imagem PNG', extensions: ['png'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, buf);
  return true;
});
// Modo Streamer: prévia do overlay numa janela do app (só o endereço local do overlay).
let overlayWin = null;
ipcMain.handle('app:stream:preview', (_e, url) => {
  let u; try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/overlay') return false;
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.loadURL(u.href); overlayWin.show(); overlayWin.focus(); return true; }
  overlayWin = new BrowserWindow({ width: 960, height: 460, autoHideMenuBar: true, backgroundColor: '#3a3f4b', title: 'Prévia do overlay (no OBS o fundo fica transparente)', icon: ICON, webPreferences: { partition: 'overlay-previa', sandbox: true, contextIsolation: true } });
  overlayWin.on('page-title-updated', (ev) => ev.preventDefault());
  overlayWin.on('closed', () => { overlayWin = null; });
  overlayWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWin.loadURL(u.href);
  return true;
});
ipcMain.handle('app:image:copy', (_e, dataUrl) => { const buf = pngOf(dataUrl); if (!buf) return false; clipboard.writeImage(nativeImage.createFromBuffer(buf)); return true; });
// Ferramentas da comunidade numa janela do app, com sessão própria (sem acesso às contas).
// Precificador de Pokémon, do briaoale (liberado por ele no Discord do PokeIdle).
const TOOLS = { precificador: { url: 'https://briaoale.github.io/precificador-pokemon/', title: 'Precificador de Pokémon — por briaoale' } };
const toolWins = new Map();
trusts.set('persist:tools', (url) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'briaoale.github.io' && u.pathname.startsWith('/precificador-pokemon'); } catch { return false; } });
ipcMain.handle('app:tool:open', (_e, name) => {
  const t = TOOLS[name];
  if (!t) return false;
  const open = toolWins.get(name);
  if (open && !open.isDestroyed()) { open.show(); open.focus(); return true; }
  const win = new BrowserWindow({ width: 1240, height: 820, minWidth: 700, minHeight: 500, autoHideMenuBar: true, backgroundColor: '#1b1b1b', title: t.title, icon: ICON, webPreferences: { partition: 'persist:tools', spellcheck: false, sandbox: true, contextIsolation: true } });
  win.on('page-title-updated', (ev) => ev.preventDefault());
  win.on('closed', () => toolWins.delete(name));
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  toolWins.set(name, win);
  win.loadURL(t.url);
  return true;
});
// Apaga TODOS os logins guardados neste PC (Twitch, Kick e todas as contas do PokeIdle). A lista de
// canais, as contas cadastradas e as preferências ficam; cada uma pede login de novo.
ipcMain.handle('app:wipeLogins', async () => {
  const { response } = await require('electron').dialog.showMessageBox(mainWin, {
    type: 'warning', buttons: ['Apagar todos os logins', 'Cancelar'], defaultId: 1, cancelId: 1,
    title: 'Apagar logins', message: 'Apagar todos os logins guardados neste PC?',
    detail: 'Twitch, Kick e todas as contas do PokeIdle vão pedir login de novo. Suas contas continuam existindo normalmente nos sites.',
  });
  if (response !== 0) return false;
  for (const m of Object.values(modules)) if (m.started) m.stop();
  const partitions = [...trusts.keys()];
  for (const p of partitions) {
    const ses = session.fromPartition(p);
    try { await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache(); } catch {}
  }
  for (const [ns, m] of Object.entries(modules)) if (config.platforms[ns]) m.start();
  poke.reloadAll();
  return true;
});

// ---------- Início ----------
if (!app.requestSingleInstanceLock()) app.quit();
// idleterino://anuncio/<id>: o botão "Abrir no Idleterino" dos posts do #comércio (via a página do site,
// porque o Discord só deixa clicar em link https). Só aceita o número do anúncio, nada mais.
const PROTOCOLO = 'idleterino';
let linkPendente = null;
function linkDe(argv) {
  const a = (argv || []).find((x) => typeof x === 'string' && x.toLowerCase().startsWith(`${PROTOCOLO}://`));
  const m = a && /^idleterino:\/\/anuncio\/(\d{1,12})\/?(?:[?#].*)?$/i.exec(a);
  return m ? Number(m[1]) : null;
}
async function abrirLink(id) {
  if (!id) return;
  showMain();
  if (!appPronto) { linkPendente = id; return; }
  const r = await poke.abrirAnuncio(id).catch(() => ({ erro: 'Não deu para abrir o anúncio.' }));
  send('twitch:toast', r.ok ? `🏪 Abrindo o anúncio no Market (${r.nick})…` : `⚠ ${r.erro}`);
}
let appPronto = false;
app.on('second-instance', (_e, argv) => { showMain(); abrirLink(linkDe(argv)); });
if (app.isPackaged && !process.env.IDLETERINO_DATA) {
  // Versão de teste (pasta separada) não registra o link: ele é da versão instalada.
  try {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE;
    if (exe) app.setAsDefaultProtocolClient(PROTOCOLO, exe, []); else app.setAsDefaultProtocolClient(PROTOCOLO);
  } catch {}
}
linkPendente = linkDe(process.argv);
app.setAppUserModelId('com.vinniisaantos.idleterino');

app.whenReady().then(() => {
  // Antes de qualquer módulo ler ou gravar as configurações: backup e contagem de aberturas.
  const abertura = seg.beforeStart();
  setTimeout(() => seg.markOk(), 2 * 60 * 1000);
  loadConfig();
  for (const m of Object.values(modules)) { m.loadConfig(); m.setupSession(); }
  // Kick com a identificação original do app, como no Kickterino: é assim que o login com Google
  // funciona (sem o "Electron" o Google recusa). A Twitch continua sem ele, como no Twitchterino.
  session.fromPartition('persist:kick').setUserAgent(ORIGINAL_UA);
  mainWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 620, backgroundColor: '#0a0b10', title: 'Idleterino',
    show: !process.argv.includes('--hidden'), icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWin.setMenuBarVisibility(false);
  for (const ev of ['enter-full-screen', 'leave-full-screen']) mainWin.on(ev, () => send('app:state', appState()));
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  for (const m of Object.values(modules)) m.setMain(mainWin);
  poke.setMain(mainWin);
  // Fechar a janela não para nada: o app continua na bandeja.
  mainWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!config.trayHintShown) {
      config.trayHintShown = true;
      saveConfig();
      notify('O Idleterino continua rodando', isLinux
        ? 'Ele fica na bandeja do sistema. Se o ícone não aparecer, abra o app de novo pelo menu. Para sair de vez, use Sair nas configurações.'
        : 'Ele fica na bandeja, perto do relógio. Para sair de vez: botão direito no ícone > Sair.', showMain);
    }
  });
  // A janela só fecha de verdade ao sair. Se em 4 s o app ainda estiver vivo, fecha o resto à força.
  mainWin.on('closed', () => setTimeout(forceQuit, 4000));
  mainWin.on('query-session-end', () => { app.isQuitting = true; });
  mainWin.on('session-end', () => { app.isQuitting = true; });

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', showMain);
  updateTray();
  powerMonitor.on('resume', () => { for (const m of Object.values(modules)) if (m.started) m.recoverAfterResume(); });
  // Voltou para o PC (abriu a janela ou desbloqueou a tela): com o modo noite ligado há 4 h, sai o relatório.
  mainWin.on('focus', () => diario.onWake());
  powerMonitor.on('unlock-screen', () => diario.onWake());
  setupAutoUpdate();
  diario.start();
  for (const [ns, m] of Object.entries(modules)) if (config.platforms[ns]) m.start();
  extensions.load();
  poke.start();
  appPronto = true;
  // Abriu o app pelo link do #comércio: espera o jogo carregar e a conta logar (até 2 min).
  if (linkPendente) {
    const id = linkPendente; linkPendente = null;
    let tentativas = 0;
    const tentar = async () => {
      const r = await poke.abrirAnuncio(id).catch(() => ({ erro: 'Não deu para abrir o anúncio.' }));
      if (r.ok) return send('twitch:toast', `🏪 Abrindo o anúncio no Market (${r.nick})…`);
      if (++tentativas < 24) return setTimeout(tentar, 5000);
      send('twitch:toast', `⚠ ${r.erro}`);
    };
    setTimeout(tentar, 4000);
  }
  // A mesma versão caiu 3 vezes seguidas logo ao abrir: oferece as saídas.
  if (abertura.falhas >= 3) {
    setTimeout(async () => {
      showMain();
      const { response } = await dialog.showMessageBox(mainWin, { type: 'warning', buttons: ['Ver backups e versões', 'Continuar'], defaultId: 0, cancelId: 1, title: 'O Idleterino fechou sozinho',
        message: `O Idleterino ${app.getVersion()} fechou sozinho ${abertura.falhas} vezes seguidas logo depois de abrir.`,
        detail: 'Você pode restaurar as configurações de antes (backup) ou voltar para a versão anterior. Se continuar, tudo segue normal.' });
      if (response === 0) send('app:goto', 'seguranca');
    }, 3000);
  }
});

// Saiu pelo Sair: a abertura foi boa (não conta como falha). O diário grava o que falta.
app.on('before-quit', () => { app.isQuitting = true; seg.markOk(); try { diario.save(); diario.stopServer(); } catch {} });
app.on('window-all-closed', () => app.quit());
