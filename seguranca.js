// Idleterino — rede de segurança das atualizações.
//
// 1. Backup das configurações (contas, canais, ajustes, extensões, histórico): antes da versão nova
//    tocar em qualquer arquivo, uma vez por dia e antes de instalar uma atualização. Guarda os 8
//    mais recentes em <dados>/backups. Os logins NÃO entram (ficam no próprio Chromium, criptografados).
// 2. Proteção ao abrir: se a mesma versão fecha sozinha (cai) 3 vezes seguidas nos primeiros 2 min,
//    o app avisa e oferece voltar para a versão anterior ou restaurar o backup.
// 3. Voltar de versão (instalador do Windows): baixa a versão escolhida do GitHub, confere o SHA-512
//    publicado no latest.yml daquela versão, instala e marca a versão de agora como "pular", para o
//    atualizador não instalar de novo a que deu problema.
const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const REPO = 'ViinniSantoos/idleterino';
const KEEP = 8;
// Primeira versão que entende o "pular versão": as anteriores reinstalariam a mais nova ao sair.
const MIN_ROLLBACK = '0.3.0';
const cmp = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

module.exports = function createSeguranca() {
  const dir = () => app.getPath('userData');
  const bdir = () => path.join(dir(), 'backups');
  const statePath = () => path.join(dir(), 'seguranca.json');
  let state = { lastVersion: null, startVersion: null, ok: true, falhas: 0, lastDaily: 0, skip: [] };
  const save = () => { try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch {} };

  // Arquivos que entram no backup: os .json da pasta de dados (menos o meta do PvP, grande e que se
  // refaz sozinho) e as listas de extensões.
  function filesToSave() {
    const out = [];
    try {
      for (const n of fs.readdirSync(dir())) if (/\.json$/i.test(n) && n !== 'pvp-meta.json' && n !== 'seguranca.json' && fs.statSync(path.join(dir(), n)).isFile()) out.push(n);
    } catch {}
    for (const n of ['extensoes.json', 'padrao.json']) if (fs.existsSync(path.join(dir(), 'extensions', n))) out.push(path.join('extensions', n));
    return out;
  }
  function backupNow(motivo, version = app.getVersion()) {
    try {
      const files = filesToSave();
      if (!files.length) return null;
      const stamp = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${crypto.randomBytes(2).toString('hex')}`;
      const id = `${stamp}_${version}`;
      const dest = path.join(bdir(), id);
      for (const f of files) { fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.copyFileSync(path.join(dir(), f), path.join(dest, f)); }
      fs.writeFileSync(path.join(dest, 'backup.json'), JSON.stringify({ at: Date.now(), version, motivo, files }, null, 2));
      prune();
      return id;
    } catch { return null; }
  }
  function prune() {
    const all = list();
    for (const b of all.slice(KEEP)) fs.rmSync(path.join(bdir(), b.id), { recursive: true, force: true });
  }
  function list() {
    const out = [];
    try {
      for (const id of fs.readdirSync(bdir())) {
        try { const m = JSON.parse(fs.readFileSync(path.join(bdir(), id, 'backup.json'), 'utf8')); out.push({ id, at: m.at, version: m.version, motivo: m.motivo, files: m.files.length }); } catch {}
      }
    } catch {}
    return out.sort((a, b) => b.at - a.at);
  }
  // Restaura um backup (o de agora vira um backup antes, para dar para desfazer) e reabre o app.
  function restore(id) {
    const src = path.join(bdir(), String(id).replace(/[\\/]/g, ''));
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(src, 'backup.json'), 'utf8')); } catch { return { ok: false, error: 'Backup não encontrado.' }; }
    backupNow('antes de restaurar');
    for (const f of m.files) {
      if (f.includes('..')) continue;
      try { fs.mkdirSync(path.dirname(path.join(dir(), f)), { recursive: true }); fs.copyFileSync(path.join(src, f), path.join(dir(), f)); } catch {}
    }
    state.ok = true; save();
    setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
    return { ok: true };
  }

  // Chamado no começo do app, ANTES de qualquer módulo ler ou gravar as configurações.
  function beforeStart() {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) }; } catch {}
    const v = app.getVersion();
    // Versão nova: guarda as configurações como estavam na versão anterior.
    if (state.lastVersion && state.lastVersion !== v) backupNow(`antes da ${v}`, state.lastVersion);
    else if (Date.now() - (state.lastDaily || 0) > 24 * 3600 * 1000) { backupNow('diário'); state.lastDaily = Date.now(); }
    // A última abertura desta versão não terminou bem (não chegou aos 2 min nem saiu pelo Sair).
    if (state.startVersion === v && state.ok === false) state.falhas = (state.falhas || 0) + 1;
    else if (state.startVersion !== v) state.falhas = 0;
    state.startVersion = v; state.lastVersion = v; state.ok = false;
    save();
    return { falhas: state.falhas };
  }
  // Ficou 2 min aberto, ou saiu pelo Sair: abriu bem.
  function markOk() { if (!state.ok || state.falhas) { state.ok = true; state.falhas = 0; save(); } }

  const skipped = (v) => (state.skip || []).includes(v);
  function skip(v) { state.skip = [...new Set([...(state.skip || []), v])].slice(-10); save(); }

  // Versões publicadas que dá para instalar de volta (a partir da 0.3.0, menores que a de agora).
  async function versions() {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { Accept: 'application/vnd.github+json' } }).catch(() => null);
    if (!r || !r.ok) return { ok: false, error: 'Não consegui ver as versões no GitHub agora.' };
    const rel = await r.json();
    const cur = app.getVersion();
    const out = rel.filter((x) => !x.draft && !x.prerelease).map((x) => ({ version: String(x.tag_name).replace(/^v/, ''), at: Date.parse(x.published_at) || 0, assets: (x.assets || []).map((a) => a.name) }))
      .filter((x) => cmp(x.version, cur) < 0 && x.assets.includes('Idleterino-Setup.exe') && x.assets.includes('latest.yml'))
      .sort((a, b) => cmp(b.version, a.version))
      .map((x) => ({ version: x.version, at: x.at, canInstall: cmp(x.version, MIN_ROLLBACK) >= 0 }));
    return { ok: true, list: out.slice(0, 6), current: cur, minRollback: MIN_ROLLBACK };
  }

  // Baixa a versão e confere o SHA-512 do instalador com o publicado no latest.yml dela.
  async function download(version, onProgress) {
    if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('Versão inválida.');
    const base = `https://github.com/${REPO}/releases/download/v${version}`;
    const yml = await net.fetch(`${base}/latest.yml`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    const m = /path:\s*Idleterino-Setup\.exe\s*\n\s*sha512:\s*(\S+)/.exec(yml) || /sha512:\s*(\S+)/.exec(yml);
    if (!m) throw new Error('Não achei a assinatura (SHA-512) dessa versão.');
    const res = await net.fetch(`${base}/Idleterino-Setup.exe`);
    if (!res.ok) throw new Error('Não consegui baixar o instalador.');
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = []; let got = 0;
    const reader = res.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); got += value.length; if (onProgress && total) onProgress(Math.round((got / total) * 100)); }
    const buf = Buffer.concat(chunks);
    const sha = crypto.createHash('sha512').update(buf).digest('base64');
    if (sha !== m[1]) throw new Error('O arquivo baixado não confere com a assinatura publicada. Nada foi instalado.');
    const file = path.join(app.getPath('temp'), `Idleterino-Setup-${version}.exe`);
    fs.writeFileSync(file, buf);
    return file;
  }

  // Instala a versão baixada: um ajudante (criado pelo Windows, fora do app) espera o app fechar,
  // roda o instalador em silêncio e abre o Idleterino de novo.
  function runInstaller(file) {
    const exe = process.execPath.replace(/'/g, "''");
    const inst = file.replace(/'/g, "''");
    const ps = `$exe='${exe}'; $inst='${inst}'; $t=0; while ((Get-Process | Where-Object { $_.Path -eq $exe }) -and $t -lt 60) { Start-Sleep 1; $t++ }; Start-Process -FilePath $inst -ArgumentList '/S' -Wait; Start-Sleep 2; if (-not (Get-Process | Where-Object { $_.Path -eq $exe })) { Start-Process -FilePath $exe }; Remove-Item -LiteralPath $inst -Force -ErrorAction SilentlyContinue`;
    const inner = `powershell.exe -NoProfile -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
    const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}' } | Out-Null`], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    return r.status === 0;
  }

  // Dá para voltar de versão só no app instalado do Windows (o portátil e o Linux baixam pelo site).
  const canRollback = () => process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;

  return { beforeStart, markOk, backupNow, list, restore, versions, download, runInstaller, skipped, skip, canRollback, falhas: () => state.falhas || 0, MIN_ROLLBACK };
};
