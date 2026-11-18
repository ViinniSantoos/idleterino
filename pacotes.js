// Idleterino — TRADER fora do app do dono. Dois jeitos, os dois ASSINADOS pela chave do dono (que só existe no PC dele):
//  1) PACOTE EXTRA (.idlpack, o jeito antigo dos testadores): travado no nick do jogo; o app confere a assinatura com a
//     chave PÚBLICA abaixo. Fica em <dados>/pacotes e vale depois de cada atualização do app.
//  2) CÓDIGO DO PREMIUM (trader-codigo.idlcode, 18/11/2026): vai DENTRO de toda versão pública, criptografado. Só abre com
//     a chave que vem na licença (licenca.js) e só roda com a licença do nick da principal em dia. Atualizar o app já
//     entrega o Trader novo para quem pagou: ninguém recebe arquivo avulso.
const crypto = require('crypto');
const Module = require('module');

const CHAVE_PUBLICA = 'MCowBQYDK2VwAyEA3aew5ylt7TT0GE4u+utf51KfyH27cU18GOqEdqf1psQ=';
const ARQUIVOS = ['trader-main.js', 'trader-preload.js', 'trader.js'];

module.exports = function criarPacotes({ app, ipcMain, fs, path, ctx, dialog, chavePublica, arqCodigo }) {
  const dir = () => path.join(app.getPath('userData'), 'pacotes');
  const arq = () => path.join(dir(), 'trader.idlpack');
  const codigoArq = () => arqCodigo || path.join(__dirname, 'trader-codigo.idlcode');
  const chave = crypto.createPublicKey({ key: Buffer.from(chavePublica || CHAVE_PUBLICA, 'base64'), format: 'der', type: 'spki' });

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

  // O código do Premium: confere a assinatura (do arquivo inteiro, ANTES de abrir) e abre com a chave da licença.
  function abrirCodigo(licenca) {
    let f;
    try { f = JSON.parse(fs.readFileSync(codigoArq(), 'utf8')); } catch { return { erro: 'sem-codigo' }; }
    if (!f || f.formato !== 'idleterino-codigo' || typeof f.dados !== 'string' || typeof f.assinatura !== 'string') return { erro: 'Código do Trader inválido.' };
    const { assinatura, ...semAss } = f;
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(JSON.stringify(semAss), 'utf8'), chave, Buffer.from(assinatura, 'base64')); } catch {}
    if (!ok) return { erro: 'Código do Trader alterado ou não oficial.' };
    const k = licenca && licenca.chaveDoCodigo ? licenca.chaveDoCodigo(f.kid) : null;
    if (!k) return { erro: 'sem-chave' };
    try {
      const b = Buffer.from(f.dados, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(f.iv, 'base64'));
      d.setAuthTag(b.subarray(b.length - 16));
      const p = JSON.parse(Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString('utf8'));
      if (p.nome !== 'trader' || !p.arquivos || ARQUIVOS.some((n) => typeof p.arquivos[n] !== 'string')) return { erro: 'Código do Trader incompleto.' };
      return { ok: true, p: { ...p, nicks: ['*'], exigeLicenca: true } };
    } catch { return { erro: 'A chave da licença não abre este código (licença antiga: o app pega a nova sozinho).' }; }
  }

  let carregado = null; // o pacote/código em uso nesta sessão do app
  let fonteTela = null;
  let janela = null;
  let exige = false;

  // Põe o Trader para rodar a partir de um pacote/código já conferido.
  function rodar(p, args, nickPrincipal, licenca, pastaNome) {
    const nicks = p.nicks.map((n) => String(n).trim().toLowerCase());
    // PREMIUM: pacote com `exigeLicenca` (ou nicks ['*'], o do código para todos) só libera com a licença do nick
    // (licenca.js: teste, mensal em dia, vitalício). Os pacotes antigos dos testadores seguem só pelo nick.
    exige = !!p.exigeLicenca || nicks.includes('*');
    // Nick conferido no jogo (guardado 1 min): fora do nick do pacote, o Trader não faz nada.
    let cache = { em: 0, ok: false };
    const liberado = async () => {
      if (Date.now() - cache.em < 60 * 1000) return cache.ok;
      const nick = await Promise.resolve(nickPrincipal()).catch(() => null);
      const n = nick ? String(nick).trim().toLowerCase() : '';
      const nickOk = !!n && (nicks.includes(n) || nicks.includes('*'));
      cache = { em: Date.now(), ok: nickOk && (!exige || !!(licenca && licenca.permite(n))) };
      return cache.ok;
    };
    // Os arquivos saem do pacote CONFERIDO a cada abertura (mexer neles no disco não adianta: são reescritos).
    const pasta = path.join(dir(), pastaNome);
    fs.mkdirSync(pasta, { recursive: true });
    for (const n of ARQUIVOS) fs.writeFileSync(path.join(pasta, n), p.arquivos[n]);
    const principal = path.join(pasta, 'trader-main.js');
    delete Module._cache[principal];
    const criar = require(principal);
    const trader = criar({ ...args, liberado });
    carregado = resumo(p);
    fonteTela = p.arquivos['trader.js'];
    // Carregado com o app já aberto (teste/Pix agora): a tela do Trader entra na janela na hora.
    if (janela && !janela.isDestroyed()) janela.webContents.executeJavaScript(fonteTela).catch(() => {});
    return trader;
  }

  // Carrega o Trader: primeiro o código do Premium que veio NA ATUALIZAÇÃO (se a licença tem a chave: é sempre o mais
  // novo), senão o pacote antigo (testadores que ainda não têm licença).
  function carregarTrader(args, nickPrincipal, licenca) {
    const c = abrirCodigo(licenca);
    if (c.ok) return rodar(c.p, args, nickPrincipal, licenca, 'trader-premium');
    let texto = null;
    try { texto = fs.readFileSync(arq(), 'utf8'); } catch {}
    if (texto) { const r = conferir(texto); if (r.ok) return rodar(r.p, args, nickPrincipal, licenca, 'trader'); }
    return null;
  }
  // Sem o Trader ainda (a pessoa começou o teste/pagou com o app aberto): tenta de novo, sem reiniciar.
  function tentarCodigo(args, nickPrincipal, licenca) {
    if (carregado) return null;
    const c = abrirCodigo(licenca);
    return c.ok ? rodar(c.p, args, nickPrincipal, licenca, 'trader-premium') : null;
  }

  // A parte da tela vai para a janela do app a cada carga dela.
  function aoAbrirJanela(win) {
    if (!win) return;
    janela = win;
    // Roda como um <script> da página (funções e variáveis no escopo global, igual ao trader.js do app do dono).
    win.webContents.on('did-finish-load', () => { if (fonteTela) win.webContents.executeJavaScript(fonteTela).catch(() => {}); });
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

  return { carregarTrader, tentarCodigo, aoAbrirJanela, conferir, abrirCodigo, exigeLicenca: () => exige };
};
