// Idleterino — PACOTE EXTRA assinado (recursos que não vão no app público).
// O dono do app gera um arquivo .idlpack assinado com a chave dele (que só existe no PC dele) e travado no nick
// do jogo de quem vai usar. Aqui o app confere a assinatura com a chave PÚBLICA abaixo: arquivo alterado ou
// feito por outra pessoa não abre. Só roda na conta principal com o nick do pacote.
// O pacote fica em <dados>/pacotes e vale depois de cada atualização do app.
const crypto = require('crypto');
const Module = require('module');

const CHAVE_PUBLICA = 'MCowBQYDK2VwAyEA3aew5ylt7TT0GE4u+utf51KfyH27cU18GOqEdqf1psQ=';
const ARQUIVOS = ['trader-main.js', 'trader-preload.js', 'trader.js'];

module.exports = function criarPacotes({ app, ipcMain, fs, path, ctx, dialog }) {
  const dir = () => path.join(app.getPath('userData'), 'pacotes');
  const arq = () => path.join(dir(), 'trader.idlpack');
  const chave = crypto.createPublicKey({ key: Buffer.from(CHAVE_PUBLICA, 'base64'), format: 'der', type: 'spki' });

  // Lê e confere um pacote. Devolve { ok, p } ou { erro }.
  function conferir(texto) {
    let f;
    try { f = JSON.parse(texto); } catch { return { erro: 'Arquivo inválido.' }; }
    if (!f || f.formato !== 'idleterino-pacote' || typeof f.dados !== 'string' || typeof f.assinatura !== 'string') return { erro: 'Não é um pacote do Idleterino.' };
    const dados = Buffer.from(f.dados, 'base64');
    let ok = false;
    try { ok = crypto.verify(null, dados, chave, Buffer.from(f.assinatura, 'base64')); } catch {}
    if (!ok) return { erro: 'Assinatura inválida: o pacote foi alterado ou não é oficial.' };
    let p;
    try { p = JSON.parse(dados.toString('utf8')); } catch { return { erro: 'Pacote corrompido.' }; }
    if (p.nome !== 'trader' || !Array.isArray(p.nicks) || !p.nicks.length || !p.arquivos) return { erro: 'Pacote incompleto.' };
    if (ARQUIVOS.some((n) => typeof p.arquivos[n] !== 'string')) return { erro: 'Pacote incompleto.' };
    if (p.validoAte && Date.now() > Number(p.validoAte)) return { erro: 'Este pacote venceu. Peça um novo.' };
    return { ok: true, p };
  }
  const resumo = (p) => ({ nome: p.nome, nicks: p.nicks, criado: p.criado || null, validoAte: p.validoAte || null, versao: p.versao || null });

  let carregado = null; // o pacote em uso nesta sessão do app
  let fonteTela = null;

  // Carrega o Trader do pacote (se houver um válido). `nickPrincipal` devolve o nick da conta principal no jogo.
  function carregarTrader(args, nickPrincipal) {
    let texto;
    try { texto = fs.readFileSync(arq(), 'utf8'); } catch { return null; }
    const r = conferir(texto);
    if (!r.ok) return null;
    const p = r.p;
    const nicks = p.nicks.map((n) => String(n).trim().toLowerCase());
    // Nick conferido no jogo (guardado 1 min): fora do nick do pacote, o Trader não faz nada.
    let cache = { em: 0, ok: false };
    const liberado = async () => {
      if (Date.now() - cache.em < 60 * 1000) return cache.ok;
      const nick = await Promise.resolve(nickPrincipal()).catch(() => null);
      cache = { em: Date.now(), ok: !!(nick && nicks.includes(String(nick).trim().toLowerCase())) };
      return cache.ok;
    };
    // Os arquivos saem do pacote CONFERIDO a cada abertura (mexer neles no disco não adianta: são reescritos).
    const pasta = path.join(dir(), 'trader');
    fs.mkdirSync(pasta, { recursive: true });
    for (const n of ARQUIVOS) fs.writeFileSync(path.join(pasta, n), p.arquivos[n]);
    const principal = path.join(pasta, 'trader-main.js');
    delete Module._cache[principal];
    const criar = require(principal);
    const trader = criar({ ...args, liberado });
    carregado = resumo(p);
    fonteTela = p.arquivos['trader.js'];
    return trader;
  }

  // A parte da tela vai para a janela do app a cada carga dela.
  function aoAbrirJanela(win) {
    if (!win || !fonteTela) return;
    // Roda como um <script> da página (funções e variáveis no escopo global, igual ao trader.js do app do dono).
    win.webContents.on('did-finish-load', () => { win.webContents.executeJavaScript(fonteTela).catch(() => {}); });
  }

  ipcMain.handle('app:pacote:info', () => {
    let instalado = null;
    try { const r = conferir(fs.readFileSync(arq(), 'utf8')); instalado = r.ok ? resumo(r.p) : { erro: r.erro }; } catch {}
    return { instalado, emUso: carregado };
  });
  ipcMain.handle('app:pacote:importar', async () => {
    const w = ctx.mainWin && ctx.mainWin();
    const esc = await dialog.showOpenDialog(w, { title: 'Importar pacote do Idleterino', properties: ['openFile'], filters: [{ name: 'Pacote do Idleterino', extensions: ['idlpack'] }] }).catch(() => null);
    if (!esc || esc.canceled || !esc.filePaths || !esc.filePaths[0]) return { cancelado: true };
    let texto;
    try { const st = fs.statSync(esc.filePaths[0]); if (st.size > 5 * 1024 * 1024) return { erro: 'Arquivo grande demais.' }; texto = fs.readFileSync(esc.filePaths[0], 'utf8'); } catch { return { erro: 'Não consegui ler o arquivo.' }; }
    const r = conferir(texto);
    if (!r.ok) return { erro: r.erro };
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(arq(), texto);
    return { ok: true, pacote: resumo(r.p) };
  });
  ipcMain.handle('app:pacote:remover', () => {
    try { fs.rmSync(arq(), { force: true }); fs.rmSync(path.join(dir(), 'trader'), { recursive: true, force: true }); } catch {}
    return { ok: true };
  });
  ipcMain.handle('app:pacote:reiniciar', () => { app.relaunch(); if (ctx.quit) ctx.quit(); else app.quit(); return true; });

  return { carregarTrader, aoAbrirJanela, conferir };
};
