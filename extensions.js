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
// Verificadas: as que o Idleterino conhece e confere (selo ✔). As outras instalam com o aviso
// "por sua conta" e só se atualizam quando a pessoa aceita (o golpe comum é alguém comprar uma
// extensão popular e soltar uma versão nova maliciosa).
const VERIFIED = new Set(BUILTINS.map((b) => b.cws));
const OPERA_DL = (slug) => `https://addons.opera.com/extensions/download/${encodeURIComponent(slug)}/`;
// Link de loja -> de onde baixar. Chrome Web Store (o Opera, o Edge e o Brave também usam) ou loja do Opera.
function parseStore(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const cws = /^\/(?:webstore\/)?detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/.exec(u.pathname);
  if ((u.hostname === 'chromewebstore.google.com' || u.hostname === 'chrome.google.com') && cws) return { store: 'cws', id: cws[1] };
  const op = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?extensions\/details\/([\w.-]+)\/?$/i.exec(u.pathname);
  if (u.hostname === 'addons.opera.com' && op) return { store: 'opera', id: op[1] };
  return null;
}
// O que cada permissão deixa a extensão fazer, em português. "forte" = merece atenção.
const PERMS = {
  cookies: ['ler e mudar cookies (consegue ver o seu login)', true], debugger: ['controlar as páginas por completo', true], nativeMessaging: ['conversar com programas do seu PC', true],
  proxy: ['mudar a sua conexão de internet', true], management: ['ver e desligar outras extensões', true], history: ['ver o seu histórico', true],
  webRequest: ['ver o tráfego das páginas', true], webRequestBlocking: ['bloquear ou mudar o tráfego das páginas', true], declarativeNetRequest: ['bloquear ou mudar pedidos das páginas', false],
  declarativeNetRequestWithHostAccess: ['bloquear ou mudar pedidos das páginas', false], scripting: ['rodar código nas páginas', false], tabs: ['ver as abas e os endereços abertos', false],
  webNavigation: ['ver para onde as páginas navegam', false], clipboardRead: ['ler o que você copia', true], clipboardWrite: ['copiar coisas para a área de transferência', false],
  downloads: ['baixar arquivos', false], storage: ['guardar os próprios dados', false], unlimitedStorage: ['guardar muitos dados', false], notifications: ['mostrar avisos', false],
  alarms: ['rodar de tempos em tempos', false], contextMenus: ['pôr itens no menu do botão direito', false], activeTab: ['mexer na página aberta quando você clica nela', false],
  offscreen: ['rodar uma página escondida', false], sidePanel: ['abrir um painel lateral', false], identity: ['pedir login em serviços (Google etc.)', true], bookmarks: ['ver os favoritos', false],
};
const ALL_SITES = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|\*:\/\/\*\/?)$/;
function describe(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const perms = [...(m.permissions || []), ...(m.optional_permissions || [])].filter((p) => typeof p === 'string');
  const sites = new Set([...(m.host_permissions || []), ...perms.filter((p) => p.includes('://') || p === '<all_urls>'), ...(m.content_scripts || []).flatMap((c) => c.matches || [])]);
  const lista = [];
  for (const p of new Set(perms)) if (PERMS[p]) lista.push({ p, txt: PERMS[p][0], forte: PERMS[p][1] });
  const todos = [...sites].some((s) => ALL_SITES.test(s));
  const sitesTxt = todos ? ['todos os sites'] : [...new Set([...sites].map((s) => s.replace(/^\*?:?\/\/|^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '')))].slice(0, 8);
  return { perms: lista, sites: sitesTxt, todosSites: todos };
}
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
    for (const e of list) { if (!e.cws) { const id = storeIdOf(e.dir); if (BUILTINS.some((b) => b.cws === id)) e.cws = id; } delete e.update; }
    setTimeout(() => ensureBuiltins().catch(() => {}), 15 * 1000);
    setInterval(() => ensureBuiltins().catch(() => {}), 24 * 60 * 60 * 1000);
    setTimeout(() => checkUpdates().catch(() => {}), 3 * 60 * 1000);
    setInterval(() => checkUpdates().catch(() => {}), 24 * 60 * 60 * 1000);
    // Sobras de uma pasta de espera (o app fechou antes de confirmar).
    fs.rmSync(stageRoot(), { recursive: true, force: true });
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

  // ATUALIZAR SEM PERDER AS CONFIGURAÇÕES: extensão carregada de uma pasta ganha o ID pelo CAMINHO da pasta
  // (o .crx da loja não traz a "key"). Se a versão nova fosse para outra pasta, o ID mudava e o navegador a
  // tratava como outra extensão — as configurações (chrome.storage) ficavam para trás. Por isso a versão nova
  // entra NA MESMA pasta: descarrega, troca os arquivos e carrega de novo, com o mesmo ID.
  function unloadDir(dir) {
    for (const [partition, loaded] of loadedIn) {
      const xid = loaded.get(dir);
      if (!xid) continue;
      try { extApi(session.fromPartition(partition)).removeExtension(xid); } catch {}
      loaded.delete(dir);
    }
  }
  function replaceInPlace(cur, newDir) {
    unloadDir(cur.dir);
    const novos = new Set(fs.readdirSync(newDir));
    fs.cpSync(newDir, cur.dir, { recursive: true, force: true });
    for (const n of fs.readdirSync(cur.dir)) if (!novos.has(n)) fs.rmSync(path.join(cur.dir, n), { recursive: true, force: true });
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
            // Mesma pasta = mesmo ID = as configurações da extensão continuam (ver replaceInPlace).
            try { replaceInPlace(cur, dir); } catch { fs.rmSync(dest, { recursive: true, force: true }); continue; }
            fs.rmSync(dest, { recursive: true, force: true });
            Object.assign(cur, info, { error: null });
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

  const snapshot = () => list.map((e) => ({ id: e.id, name: e.name, version: e.version, description: e.description, enabled: e.enabled, mv: e.mv, error: e.error || null, hasPanel: panelsOf(e).length > 0, builtin: !!e.cws,
    src: e.src ? e.src.store : null, verified: !!(e.cws && VERIFIED.has(e.cws)) || !!(e.src && e.src.store === 'cws' && VERIFIED.has(e.src.id)),
    update: e.update ? { version: e.update.version, novas: e.update.novas || [] } : null }));
  const builtinsSnapshot = () => BUILTINS.map((b) => ({ ...b, installed: list.some((e) => e.cws === b.cws), dismissed: builtinState.dismissed.includes(b.cws) }));

  // ---------- Instalar pelo link da loja (Chrome Web Store ou Opera) ----------
  // 1) "preview": baixa da loja oficial para uma pasta de espera e mostra as permissões;
  // 2) "confirm": a pessoa aceitou, a extensão entra (ou substitui a mesma, se for atualização).
  const staged = new Map(); // token -> { dir, top, src, info }
  const stageRoot = () => path.join(root(), '_espera');
  async function fetchStore(src) {
    const url = src.store === 'cws' ? crxUrl(src.id) : OPERA_DL(src.id);
    const res = await net.fetch(url).catch(() => null);
    if (!res || !res.ok) throw new Error(src.store === 'cws' ? 'Não achei essa extensão na Chrome Web Store (ou a loja não respondeu). Se ela for só da loja do Opera, cole o link de lá.' : 'Não consegui baixar da loja do Opera agora.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.slice(0, 4).toString() !== 'Cr24') throw new Error('A loja não mandou uma extensão (talvez ela seja paga ou só funcione no navegador).');
    const token = crypto.randomBytes(9).toString('hex');
    const file = path.join(app.getPath('temp'), `idleterino-loja-${token}.crx`);
    fs.writeFileSync(file, buf);
    const top = path.join(stageRoot(), token);
    try { extract(file, top); } finally { fs.rmSync(file, { force: true }); }
    const dir = findManifestDir(top);
    if (!dir) { fs.rmSync(top, { recursive: true, force: true }); throw new Error('O pacote não tem manifest.json.'); }
    const info = readManifest(dir);
    staged.set(token, { dir, top, src, info, at: Date.now() });
    // Pasta de espera esquecida: some em 30 min.
    setTimeout(() => { if (staged.get(token)) { staged.delete(token); fs.rmSync(top, { recursive: true, force: true }); } }, 30 * 60 * 1000);
    return { token, dir, info };
  }
  async function preview(raw) {
    const src = parseStore(raw);
    if (!src) return { ok: false, error: 'Cole o link da página da extensão na Chrome Web Store (chromewebstore.google.com/detail/…) ou na loja do Opera (addons.opera.com/…/extensions/details/…).' };
    try {
      const { token, dir, info } = await fetchStore(src);
      const same = list.find((e) => e.src && e.src.store === src.store && e.src.id === src.id) || (src.store === 'cws' && list.find((e) => e.cws === src.id));
      return { ok: true, token, ...info, ...describe(dir), store: src.store, verified: src.store === 'cws' && VERIFIED.has(src.id), jaTem: same ? same.version : null };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
  async function confirm(token) {
    const s = staged.get(token);
    if (!s) return { ok: false, error: 'O tempo para confirmar passou. Cole o link de novo.' };
    staged.delete(token);
    const old = list.find((e) => (e.src && e.src.store === s.src.store && e.src.id === s.src.id) || (s.src.store === 'cws' && e.cws === s.src.id));
    if (old) {
      // Atualização: a versão nova entra na MESMA pasta, para a extensão manter o ID e as configurações.
      try { replaceInPlace(old, s.dir); } catch (err) { fs.rmSync(s.top, { recursive: true, force: true }); return { ok: false, error: `Não consegui atualizar agora (${String(err.message || err).slice(0, 80)}). Feche o app e tente de novo.` }; }
      fs.rmSync(s.top, { recursive: true, force: true });
      Object.assign(old, s.info, { error: null, update: null });
      if (!old.cws) old.src = s.src;
      save();
      await applyAll();
      return { ok: true };
    }
    const id = Math.random().toString(36).slice(2, 10);
    const dest = path.join(root(), id);
    fs.renameSync(s.top, dest);
    const dir = path.join(dest, path.relative(s.top, s.dir));
    list.push({ id, ...s.info, dir, enabled: true, src: s.src, ...(s.src.store === 'cws' && VERIFIED.has(s.src.id) ? { cws: s.src.id } : {}) });
    save();
    await applyAll();
    return { ok: true };
  }
  // Extensões da loja (não verificadas): confere versão nova uma vez por dia e só AVISA. A pessoa vê
  // as permissões novas e decide atualizar.
  async function checkUpdates() {
    let changed = false;
    for (const e of list.filter((x) => x.src && !x.cws)) {
      try {
        const { token, dir, info } = await fetchStore(e.src);
        if (!newerVersion(info.version, e.update ? e.update.version : e.version)) { const s = staged.get(token); staged.delete(token); if (s) fs.rmSync(s.top, { recursive: true, force: true }); continue; }
        const antes = new Set(describe(e.dir).perms.map((p) => p.p));
        const novas = describe(dir).perms.filter((p) => !antes.has(p.p)).map((p) => p.txt);
        if (e.update && e.update.token && staged.has(e.update.token)) { const s = staged.get(e.update.token); staged.delete(e.update.token); fs.rmSync(s.top, { recursive: true, force: true }); }
        e.update = { version: info.version, token, novas };
        changed = true;
      } catch {}
    }
    if (changed) { save(); ctx.send('poke:ext:changed', snapshot()); }
  }

  // ---------- Trazer do meu navegador ----------
  // Lê só os manifest.json das extensões instaladas no Chrome, Edge, Brave, Opera, Opera GX e Vivaldi
  // da pessoa (nada de histórico, senha ou login) e mostra as que funcionam no PokeIdle. A instalação
  // baixa a cópia OFICIAL da loja pelo ID: nada é copiado do navegador.
  function browserDirs() {
    const L = process.env.LOCALAPPDATA || '', R = process.env.APPDATA || '', H = app.getPath('home');
    const chromium = (name, base) => ({ name, base, profiles: true });
    const out = process.platform === 'win32' ? [
      chromium('Chrome', path.join(L, 'Google', 'Chrome', 'User Data')), chromium('Edge', path.join(L, 'Microsoft', 'Edge', 'User Data')),
      chromium('Brave', path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data')), chromium('Vivaldi', path.join(L, 'Vivaldi', 'User Data')),
      { name: 'Opera', base: path.join(R, 'Opera Software', 'Opera Stable'), opera: true }, { name: 'Opera GX', base: path.join(R, 'Opera Software', 'Opera GX Stable'), opera: true },
    ] : [
      chromium('Chrome', path.join(H, '.config', 'google-chrome')), chromium('Chromium', path.join(H, '.config', 'chromium')), chromium('Edge', path.join(H, '.config', 'microsoft-edge')),
      chromium('Brave', path.join(H, '.config', 'BraveSoftware', 'Brave-Browser')), chromium('Vivaldi', path.join(H, '.config', 'vivaldi')), { name: 'Opera', base: path.join(H, '.config', 'opera'), opera: true },
    ];
    const dirs = [];
    for (const b of out) {
      if (!fs.existsSync(b.base)) continue;
      const cands = b.opera ? [path.join(b.base, 'Extensions'), path.join(b.base, 'Default', 'Extensions')] : (() => { try { return fs.readdirSync(b.base).filter((n) => n === 'Default' || /^Profile \d+$/.test(n)).map((n) => path.join(b.base, n, 'Extensions')); } catch { return []; } })();
      for (const d of cands) if (fs.existsSync(d)) dirs.push({ browser: b.name, dir: d });
    }
    return dirs;
  }
  function scanBrowsers() {
    const found = new Map();
    for (const { browser, dir } of browserDirs()) {
      let ids = []; try { ids = fs.readdirSync(dir).filter((n) => /^[a-p]{32}$/.test(n)); } catch {}
      for (const xid of ids) {
        try {
          const vers = fs.readdirSync(path.join(dir, xid)).filter((v) => fs.existsSync(path.join(dir, xid, v, 'manifest.json'))).sort((a, b) => (newerVersion(a.split('_')[0], b.split('_')[0]) ? -1 : 1));
          if (!vers.length) continue;
          const vdir = path.join(dir, xid, vers[0]);
          const raw = fs.readFileSync(path.join(vdir, 'manifest.json'), 'utf8');
          const info = readManifest(vdir);
          // Feita para o PokeIdle: o manifest cita pokeidle (sites ou nome/descrição).
          if (!/pokeidle|poke[\s_-]?idle/i.test(raw + info.name + info.description)) continue;
          const cur = found.get(xid);
          if (cur) { if (!cur.browsers.includes(browser)) cur.browsers.push(browser); continue; }
          const installed = list.some((e) => e.cws === xid || (e.src && e.src.store === 'cws' && e.src.id === xid) || storeIdOf(e.dir) === xid);
          found.set(xid, { id: xid, name: info.name, version: info.version, description: info.description, browsers: [browser], installed, verified: VERIFIED.has(xid) });
        } catch {}
      }
    }
    return { browsers: [...new Set(browserDirs().map((d) => d.browser))], list: [...found.values()] };
  }

  ipcMain.handle('poke:ext:preview', (_e, url) => preview(url));
  ipcMain.handle('poke:ext:confirm', async (_e, token) => ({ ...(await confirm(token)), list: snapshot() }));
  ipcMain.handle('poke:ext:cancel', (_e, token) => { const s = staged.get(token); if (s) { staged.delete(token); fs.rmSync(s.top, { recursive: true, force: true }); } return true; });
  ipcMain.handle('poke:ext:scan', () => scanBrowsers());
  ipcMain.handle('poke:ext:previewUpdate', (_e, id) => {
    const e = list.find((x) => x.id === id);
    const s = e && e.update && staged.get(e.update.token);
    if (!s) return { ok: false, error: 'A atualização não está mais pronta. Ela é conferida de novo amanhã.' };
    return { ok: true, token: e.update.token, ...s.info, ...describe(s.dir), store: e.src.store, verified: false, jaTem: e.version, novas: e.update.novas };
  });
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
