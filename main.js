// Idleterino — a casca do app: janela, bandeja, atualização, iniciar com o sistema e o registro de
// quais sites cada sessão pode abrir. Twitch e Kick moram em platforms/ (cada um com seu login,
// sua configuração e seus canais de IPC "twitch:..." e "kick:..."). O PokeIdle mora em pokeidle.js.
const { app, BrowserWindow, ipcMain, session, shell, Tray, Menu, Notification, nativeImage, powerMonitor } = require('electron');
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
    news: config.lastSeenVersion && config.lastSeenVersion !== app.getVersion(),
    update,
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
      if (m && newer(m[1], app.getVersion())) setUpdate({ state: 'manual', version: m[1] });
    }).catch(() => {});
    check();
    setInterval(check, 2 * 60 * 60 * 1000);
    return;
  }
  autoUpdater.on('error', () => { if (update && update.state === 'downloading') setUpdate(null); });
  autoUpdater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => { if (update) { update.percent = Math.round(p.percent || 0); send('app:state', appState()); } });
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ state: 'ready', version: i.version });
    notify('Atualização pronta', `O Idleterino ${i.version} está pronto. Clique em "Atualizar agora" no Início.`, showMain);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 2 * 60 * 60 * 1000);
}

// ---------- IPC da casca ----------
ipcMain.handle('app:state', () => appState());
ipcMain.handle('app:platform', (_e, ns, on) => { if (modules[ns]) setPlatform(ns, on); return appState(); });
ipcMain.handle('app:autostart', (_e, on) => { try { setOpenAtLogin(!!on); } catch {} return appState(); });
ipcMain.handle('app:introDone', () => { config.lastSeenVersion = app.getVersion(); firstRun = false; saveConfig(); return appState(); });
ipcMain.handle('app:quit', quitApp);
ipcMain.handle('app:update:install', () => installUpdate());
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
app.on('second-instance', showMain);
app.setAppUserModelId('com.vinniisaantos.idleterino');

app.whenReady().then(() => {
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
  setupAutoUpdate();
  for (const [ns, m] of Object.entries(modules)) if (config.platforms[ns]) m.start();
  extensions.load();
  poke.start();
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => app.quit());
