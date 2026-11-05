// Idleterino — extensões do navegador que o usuário já usa no PokeIdle (sniper, /hunt e afins).
// Duas vêm por padrão (BUILTINS): o app baixa da Chrome Web Store, a fonte oficial, no PC da pessoa
// (nada de cópia nossa do código delas) e confere versão nova uma vez por dia. Quem remove uma
// padrão não a recebe de volta sozinho. As outras, a pessoa escolhe e instala. Elas são carregadas só
// nas sessões das contas do PokeIdle (nunca nas da Twitch/Kick, onde estão esses logins).
// Instalar = copiar para <dados do app>/extensions/<id>. Aceita pasta, .zip ou .crx (o .crx é um
// zip com um cabeçalho na frente, que é retirado antes de extrair).
const { app, BrowserWindow, dialog, ipcMain, session, net } = require('electron');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Extensões padrão: o Rotom Sniper é a oficial do PokeIdle; o /hunt só mostra as melhores hunts
// (lê o jogo e não envia nada nem clica em nada).
const BUILTINS = [
  { cws: 'olccbpdjdkbfgondiiaicmlifhbcggmk', name: 'Rotom Sniper', why: 'Extensão oficial do PokeIdle: mercado, telemetria de farm, hunts e rotas. Painel no botão 🧩 de cada conta.' },
  { cws: 'mhnplloljgchpfpcpbhmcokmnefodjnh', name: '/hunt', why: 'Mostra, em cima do seu pokémon, as melhores hunts por XP/h e ouro/h. Só mostra: não joga sozinha.' },
];
const crxUrl = (id) => `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(process.versions.chrome)}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
const newerVersion = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
// ID da extensão na Chrome Web Store, a partir da chave do manifest (reconhece quem já instalou na mão).
function storeIdOf(dir) {
  try {
    const key = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).key;
    if (!key) return null;
    const h = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    return [...h].map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('');
  } catch { return null; }
}

module.exports = function createExtensions(ctx) {
  const root = () => path.join(app.getPath('userData'), 'extensions');
  const listPath = () => path.join(root(), 'extensoes.json');
  let list = []; // { id, name, version, description, dir, enabled, mv }
  const builtinPath = () => path.join(root(), 'padrao.json');
  let builtinState = { dismissed: [] };
  const load = () => {
    try { list = JSON.parse(fs.readFileSync(listPath(), 'utf8')); } catch { list = []; }
    try { builtinState = { dismissed: [], ...JSON.parse(fs.readFileSync(builtinPath(), 'utf8')) }; } catch {}
    for (const e of list) if (!e.cws) { const id = storeIdOf(e.dir); if (BUILTINS.some((b) => b.cws === id)) e.cws = id; }
    setTimeout(() => ensureBuiltins().catch(() => {}), 15 * 1000);
    setInterval(() => ensureBuiltins().catch(() => {}), 24 * 60 * 60 * 1000);
  };
  const saveBuiltins = () => { fs.mkdirSync(root(), { recursive: true }); fs.writeFileSync(builtinPath(), JSON.stringify(builtinState, null, 2)); };
  const save = () => { fs.mkdirSync(root(), { recursive: true }); fs.writeFileSync(listPath(), JSON.stringify(list, null, 2)); };
  const extApi = (ses) => ses.extensions || ses; // Electron novo: ses.extensions; antigo: ses.*
  const loadedIn = new Map(); // partição -> Map(dir -> id carregado no Chromium)

  // Nome da extensão pode vir traduzido (__MSG_appName__): procura no _locales.
  function readManifest(dir) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const msg = (s) => {
      const k = /^__MSG_(.+)__$/.exec(String(s || ''));
      if (!k) return s;
      for (const loc of [m.default_locale, 'pt_BR', 'en'].filter(Boolean)) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8')); const e = Object.entries(j).find(([kk]) => kk.toLowerCase() === k[1].toLowerCase()); if (e) return e[1].message; } catch {}
      }
      return k[1];
    };
    return { name: String(msg(m.name) || 'Extensão').slice(0, 60), version: String(m.version || ''), description: String(msg(m.description) || '').slice(0, 200), mv: m.manifest_version || 2 };
  }

  // Extrai um .zip (ou o zip de dentro de um .crx) para a pasta destino.
  function extract(file, dest) {
    let zip = file;
    const buf = fs.readFileSync(file);
    if (buf.slice(0, 4).toString() === 'Cr24') {
      const version = buf.readUInt32LE(4);
      const start = version === 3 ? 12 + buf.readUInt32LE(8) : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
      zip = path.join(app.getPath('temp'), `idleterino-ext-${Date.now()}.zip`);
      fs.writeFileSync(zip, buf.slice(start));
    }
    fs.mkdirSync(dest, { recursive: true });
    try {
      // O tar do próprio Windows (10 e 11) abre .zip; o caminho completo evita pegar outro tar do PATH.
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', path.resolve(zip), '-C', path.resolve(dest)], { windowsHide: true });
      else execFileSync('unzip', ['-q', '-o', zip, '-d', dest]);
    } finally { if (zip !== file) fs.rmSync(zip, { force: true }); }
  }
  // Alguns pacotes trazem tudo dentro de uma subpasta: acha onde está o manifest.json.
  function findManifestDir(dir, depth = 0) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    if (depth > 2) return null;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) { const r = findManifestDir(path.join(dir, d.name), depth + 1); if (r) return r; }
    return null;
  }

  async function install(source, isFile) {
    const id = Math.random().toString(36).slice(2, 10);
    const dest = path.join(root(), id);
    try {
      if (isFile) extract(source, dest);
      else fs.cpSync(source, dest, { recursive: true });
      const dir = findManifestDir(dest);
      if (!dir) throw new Error('Não achei o manifest.json: isso não parece uma extensão de navegador.');
      const info = readManifest(dir);
      list.push({ id, ...info, dir, enabled: true });
      save();
      await applyAll();
      return { ok: true };
    } catch (e) {
      fs.rmSync(dest, { recursive: true, force: true });
      return { ok: false, error: String(e.message || e) };
    }
  }

  // Instala ou atualiza as extensões padrão direto da Chrome Web Store.
  let ensuring = false;
  async function ensureBuiltins(force = null) {
    if (ensuring) return false;
    ensuring = true;
    let changed = false;
    try {
      for (const b of BUILTINS) {
        if (builtinState.dismissed.includes(b.cws) && force !== b.cws) continue;
        const cur = list.find((e) => e.cws === b.cws);
        const res = await net.fetch(crxUrl(b.cws)).catch(() => null);
        if (!res || !res.ok) continue;
        const file = path.join(app.getPath('temp'), `idleterino-${b.cws}-${Date.now()}.crx`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        const id = Math.random().toString(36).slice(2, 10);
        const dest = path.join(root(), id);
        try {
          extract(file, dest);
          const dir = findManifestDir(dest);
          if (!dir) throw new Error('pacote inesperado'); // veio do endereço oficial da loja para este ID (o .crx da loja não traz a "key" no manifest)
          const info = readManifest(dir);
          if (cur && !newerVersion(info.version, cur.version)) { fs.rmSync(dest, { recursive: true, force: true }); continue; }
          if (cur) {
            const oldDir = cur.dir;
            Object.assign(cur, info, { dir, error: null });
            setTimeout(() => { const top = path.relative(root(), oldDir).split(path.sep)[0]; if (top && !list.some((e) => e.dir.startsWith(path.join(root(), top)))) fs.rmSync(path.join(root(), top), { recursive: true, force: true }); }, 60 * 1000);
          } else {
            list.push({ id, ...info, dir, enabled: true, cws: b.cws });
          }
          changed = true;
        } catch { fs.rmSync(dest, { recursive: true, force: true }); } finally { fs.rmSync(file, { force: true }); }
      }
      if (changed) { save(); await applyAll(); ctx.send('poke:ext:changed', snapshot()); }
    } finally { ensuring = false; }
    return changed;
  }

  // Carrega/descarrega as extensões numa sessão de conta, conforme estão ligadas.
  async function applyTo(partition) {
    const ses = session.fromPartition(partition);
    const api = extApi(ses);
    const loaded = loadedIn.get(partition) || new Map();
    loadedIn.set(partition, loaded);
    for (const e of list) {
      const has = loaded.has(e.dir);
      if (e.enabled && !has) {
        try { const x = await api.loadExtension(e.dir, { allowFileAccess: false }); loaded.set(e.dir, x.id); } catch (err) { e.error = String(err.message || err).slice(0, 200); }
      } else if (!e.enabled && has) {
        try { api.removeExtension(loaded.get(e.dir)); } catch {}
        loaded.delete(e.dir);
      }
    }
    // Extensão removida da lista: tira da sessão também.
    for (const [dir, xid] of [...loaded]) if (!list.some((e) => e.dir === dir)) { try { api.removeExtension(xid); } catch {} loaded.delete(dir); }
  }
  function closePanels(extId) { for (const [k, w] of [...panelWins]) if (k.startsWith(`${extId}|`)) { if (!w.isDestroyed()) w.close(); panelWins.delete(k); } }
  async function applyAll() { for (const p of ctx.pokePartitions()) await applyTo(p); ctx.reloadPoke(); }

  // Telas da própria extensão (o painel que no Chrome abre pelo ícone da barra): popup, opções ou,
  // quando o ícone não tem popup (ex.: abre um "cockpit" numa janela), as páginas .html da raiz.
  function panelsOf(e) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(e.dir, 'manifest.json'), 'utf8'));
      const act = m.action || m.browser_action || null;
      const bg = new Set([m.background && m.background.page].filter(Boolean));
      const out = [act && act.default_popup, m.options_page, m.options_ui && m.options_ui.page];
      if (act && !act.default_popup) for (const n of fs.readdirSync(e.dir)) if (/\.html?$/i.test(n) && !bg.has(n)) out.push(n);
      return [...new Set(out.filter((p) => typeof p === 'string' && p && !p.includes('..') && fs.existsSync(path.join(e.dir, p))))];
    } catch { return []; }
  }
  const panelWins = new Map(); // "ext|conta|página" -> janela
  async function openPanel(extId, accountId, title) {
    const e = list.find((x) => x.id === extId && x.enabled);
    const partition = `persist:poke-${String(accountId)}`;
    if (!e || !ctx.pokePartitions().includes(partition)) return { ok: false, error: 'Conta ou extensão não encontrada.' };
    const page = panelsOf(e)[0];
    if (!page) return { ok: false, error: 'Essa extensão não tem painel para abrir.' };
    const key = `${extId}|${accountId}|${page}`;
    const open = panelWins.get(key);
    if (open && !open.isDestroyed()) { open.show(); open.focus(); return { ok: true }; }
    if (!(loadedIn.get(partition) || new Map()).has(e.dir)) await applyTo(partition);
    const xid = (loadedIn.get(partition) || new Map()).get(e.dir);
    if (!xid) return { ok: false, error: e.error || 'A extensão não carregou nesta conta.' };
    const win = new BrowserWindow({
      width: 1160, height: 760, autoHideMenuBar: true, backgroundColor: '#0b0d14',
      title: `${e.name} — ${String(title || '').slice(0, 30)}`,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: { partition, spellcheck: false },
    });
    win.on('page-title-updated', (ev) => ev.preventDefault());
    win.on('closed', () => panelWins.delete(key));
    panelWins.set(key, win);
    win.loadURL(`chrome-extension://${xid}/${page}`);
    return { ok: true };
  }

  const snapshot = () => list.map((e) => ({ id: e.id, name: e.name, version: e.version, description: e.description, enabled: e.enabled, mv: e.mv, error: e.error || null, hasPanel: panelsOf(e).length > 0, builtin: !!e.cws }));
  const builtinsSnapshot = () => BUILTINS.map((b) => ({ ...b, installed: list.some((e) => e.cws === b.cws), dismissed: builtinState.dismissed.includes(b.cws) }));

  ipcMain.handle('poke:ext:list', () => snapshot());
  ipcMain.handle('poke:ext:addFolder', async () => {
    const r = await dialog.showOpenDialog(ctx.mainWin(), { title: 'Escolha a pasta da extensão (a que tem o manifest.json)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, list: snapshot() };
    return { ...(await install(r.filePaths[0], false)), list: snapshot() };
  });
  ipcMain.handle('poke:ext:addFile', async () => {
    const r = await dialog.showOpenDialog(ctx.mainWin(), { title: 'Escolha o arquivo da extensão', properties: ['openFile'], filters: [{ name: 'Extensão', extensions: ['zip', 'crx'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, list: snapshot() };
    return { ...(await install(r.filePaths[0], true)), list: snapshot() };
  });
  ipcMain.handle('poke:ext:open', (_e, extId, accountId, title) => openPanel(extId, accountId, title));
  ipcMain.handle('poke:ext:toggle', async (_e, id, on) => { const e = list.find((x) => x.id === id); if (e) { e.enabled = !!on; e.error = null; save(); if (!e.enabled) closePanels(id); await applyAll(); } return snapshot(); });
  ipcMain.handle('poke:ext:remove', async (_e, id) => {
    const e = list.find((x) => x.id === id);
    if (e) {
      closePanels(id); list = list.filter((x) => x.id !== id); save(); await applyAll(); fs.rmSync(path.join(root(), id), { recursive: true, force: true });
      // Padrão removida: não volta sozinha (dá para instalar de novo na lista de padrões).
      if (e.cws && !builtinState.dismissed.includes(e.cws)) { builtinState.dismissed.push(e.cws); saveBuiltins(); }
    }
    return snapshot();
  });
  ipcMain.handle('poke:ext:builtins', () => builtinsSnapshot());
  ipcMain.handle('poke:ext:builtin:install', async (_e, cws) => {
    if (!BUILTINS.some((b) => b.cws === cws)) return { ok: false, list: snapshot() };
    builtinState.dismissed = builtinState.dismissed.filter((x) => x !== cws); saveBuiltins();
    await ensureBuiltins(cws);
    const ok = list.some((e) => e.cws === cws);
    return { ok, error: ok ? null : 'Não consegui baixar da Chrome Web Store agora. Tente de novo em instantes.', list: snapshot() };
  });

  return { load, applyTo };
};
