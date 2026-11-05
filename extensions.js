// Idleterino — extensões do navegador que o usuário já usa no PokeIdle (sniper, /hunt e afins).
// O usuário escolhe e instala; o app não traz nem cria extensão nenhuma. Elas são carregadas só
// nas sessões das contas do PokeIdle (nunca nas da Twitch/Kick, onde estão esses logins).
// Instalar = copiar para <dados do app>/extensions/<id>. Aceita pasta, .zip ou .crx (o .crx é um
// zip com um cabeçalho na frente, que é retirado antes de extrair).
const { app, dialog, ipcMain, session } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = function createExtensions(ctx) {
  const root = () => path.join(app.getPath('userData'), 'extensions');
  const listPath = () => path.join(root(), 'extensoes.json');
  let list = []; // { id, name, version, description, dir, enabled, mv }
  const load = () => { try { list = JSON.parse(fs.readFileSync(listPath(), 'utf8')); } catch { list = []; } };
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
  async function applyAll() { for (const p of ctx.pokePartitions()) await applyTo(p); ctx.reloadPoke(); }

  const snapshot = () => list.map(({ id, name, version, description, enabled, mv, error }) => ({ id, name, version, description, enabled, mv, error: error || null }));

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
  ipcMain.handle('poke:ext:toggle', async (_e, id, on) => { const e = list.find((x) => x.id === id); if (e) { e.enabled = !!on; e.error = null; save(); await applyAll(); } return snapshot(); });
  ipcMain.handle('poke:ext:remove', async (_e, id) => {
    const e = list.find((x) => x.id === id);
    if (e) { list = list.filter((x) => x.id !== id); save(); await applyAll(); fs.rmSync(path.join(root(), id), { recursive: true, force: true }); }
    return snapshot();
  });

  return { load, applyTo };
};
