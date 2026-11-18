// Idleterino — LICENÇA do Trader Premium (18/11/2026).
//
// O código do Trader e a PERMISSÃO de usar ficam separados. A permissão é uma licença pequena, assinada, presa ao nick
// do jogo:
//   { nick, plano: 'teste' | 'mensal' | 'vitalicio', inicio, validoAte (null no vitalício), emitida, id, revogada? }
//
// QUEM ASSINA: a chave mestra do dono fica SÓ no PC dele. Ela assina um "certificado" de uma chave filha, que só serve
// para assinar licenças (papel 'licencas'). A chave filha é a que fica na função online que emite o teste e a licença
// depois do Pix. Se ela vazar, o dono emite outra e cancela a velha (lista `chavesRevogadas` abaixo, na próxima versão).
// O app só confia na chave PÚBLICA mestra (a mesma do pacote).
//
// HORA: o vencimento é conferido pela hora do servidor do jogo (cabeçalho Date de https://pokeidle.io) e nunca volta
// para trás (o app guarda a maior hora já vista). Atrasar o relógio do PC não estende o plano.
//
// SEM INTERNET: a licença fica guardada e vale até a data dela (o vitalício vale sempre). O app pega a versão nova
// sozinho (renovação, revogação) de 6 em 6 h e ao abrir.
//
// PRIVACIDADE: o app manda para a loja só o nick do jogo, o plano escolhido e um número aleatório deste PC (para o teste
// grátis não repetir). Nada do jogo, nenhuma senha, nenhum código de acesso.
const crypto = require('crypto');

const CHAVE_MESTRA = 'MCowBQYDK2VwAyEA3aew5ylt7TT0GE4u+utf51KfyH27cU18GOqEdqf1psQ=';
// O endereço da loja (função online). Vazio = a loja ainda não abriu (o app mostra "em breve").
const LOJA_URL = 'https://idleterino-loja.idleterino.workers.dev';
// Ligar quando lançar o Premium (mostra a tela de planos para todo mundo).
const PREMIUM_LANCADO = true;
const PLANOS = {
  teste: { nome: 'Teste grátis', dias: 3, preco: 0 },
  mensal: { nome: 'Mensal', dias: 30, preco: 15.9 },
  vitalicio: { nome: 'Vitalício', dias: null, preco: 49.9 },
};
const TOLERANCIA_MS = 24 * 3600 * 1000; // mensal: 1 dia depois de vencer (o Pix pode demorar)
const chavesRevogadas = new Set([]); // ids de certificados de chaves filhas que não valem mais
const DIA = 24 * 3600 * 1000;

const b64 = (s) => Buffer.from(String(s || ''), 'base64');
const nickDe = (n) => String(n || '').trim().toLowerCase();

module.exports = function criarLicenca({ app, ipcMain, fs, path, ctx, chaveMestra, lojaUrl, lancado }) {
  const mestra = crypto.createPublicKey({ key: b64(chaveMestra || CHAVE_MESTRA), format: 'der', type: 'spki' });
  const loja = () => String(process.env.IDLETERINO_LICENCA_URL || lojaUrl || LOJA_URL || '').replace(/\/+$/, '');
  const premiumLancado = () => !!(lancado ?? PREMIUM_LANCADO) || process.env.IDLETERINO_PREMIUM === '1';
  const dir = () => path.join(app.getPath('userData'), 'licencas');
  const arqLic = (nick) => path.join(dir(), `${nickDe(nick).replace(/[^a-z0-9_.-]/g, '_')}.json`);
  const arqEstado = () => path.join(dir(), 'estado.json');

  // ---------- estado local: maior hora vista, avisos já dados, número aleatório deste PC ----------
  let est = null;
  function estado() {
    if (est) return est;
    try { est = JSON.parse(fs.readFileSync(arqEstado(), 'utf8')); } catch { est = {}; }
    if (!est.aparelho) est.aparelho = crypto.randomBytes(12).toString('hex');
    est.maiorVisto = Number(est.maiorVisto) || 0;
    est.avisos = est.avisos || {};
    est.testeUsado = est.testeUsado || {};
    return est;
  }
  function salvarEstado() { try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(arqEstado(), JSON.stringify(estado())); } catch {} }

  // ---------- hora confiável ----------
  let desvio = 0, desvioEm = 0;
  async function calibrar() {
    if (Date.now() - desvioEm < 30 * 60 * 1000) return;
    desvioEm = Date.now();
    try {
      const t0 = Date.now();
      const r = await fetch('https://pokeidle.io/', { method: 'HEAD', cache: 'no-store' });
      const d = Date.parse(r.headers.get('date') || '');
      if (Number.isFinite(d)) desvio = d + (Date.now() - t0) / 2 - Date.now();
    } catch { desvioEm = Date.now() - 25 * 60 * 1000; } // sem internet: tenta de novo em 5 min
  }
  function agora() {
    const e = estado();
    const t = Math.max(Date.now() + desvio, e.maiorVisto || 0);
    if (t - (e.maiorVisto || 0) > 60 * 1000) { e.maiorVisto = t; salvarEstado(); }
    return t;
  }

  // ---------- conferir uma licença ----------
  function conferir(texto) {
    let f;
    try { f = typeof texto === 'string' ? JSON.parse(texto) : texto; } catch { return { erro: 'Licença inválida.' }; }
    if (!f || f.formato !== 'idleterino-licenca' || !f.cert || typeof f.dados !== 'string' || typeof f.assinatura !== 'string') return { erro: 'Não é uma licença do Idleterino.' };
    let c;
    try {
      const cd = b64(f.cert.dados);
      if (!crypto.verify(null, cd, mestra, b64(f.cert.assinatura))) return { erro: 'Licença com certificado inválido.' };
      c = JSON.parse(cd.toString('utf8'));
    } catch { return { erro: 'Licença com certificado inválido.' }; }
    if (!c || c.papel !== 'licencas' || typeof c.pub !== 'string') return { erro: 'Licença com certificado inválido.' };
    if (c.id && chavesRevogadas.has(c.id)) return { erro: 'Licença de uma chave cancelada. Peça uma nova.' };
    let L;
    try {
      const filha = crypto.createPublicKey({ key: b64(c.pub), format: 'der', type: 'spki' });
      const d = b64(f.dados);
      if (!crypto.verify(null, d, filha, b64(f.assinatura))) return { erro: 'Assinatura da licença inválida.' };
      L = JSON.parse(d.toString('utf8'));
    } catch { return { erro: 'Assinatura da licença inválida.' }; }
    if (!L || !L.nick || !PLANOS[L.plano]) return { erro: 'Licença incompleta.' };
    if (c.validoAte && Number(L.emitida) > Number(c.validoAte)) return { erro: 'Licença emitida depois do prazo da chave.' };
    return { ok: true, L, cert: c };
  }

  function lerLicenca(nick) {
    try { const r = conferir(fs.readFileSync(arqLic(nick), 'utf8')); return r.ok ? r.L : null; } catch { return null; }
  }
  // Guarda só se for mais nova que a guardada (a loja nunca "volta" uma licença por engano).
  function guardar(texto) {
    const r = conferir(texto);
    if (!r.ok) return r;
    const atual = lerLicenca(r.L.nick);
    if (atual && Number(atual.emitida) > Number(r.L.emitida)) return { ok: true, L: atual, velha: true };
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(arqLic(r.L.nick), typeof texto === 'string' ? texto : JSON.stringify(texto));
    if (r.L.plano === 'teste') { estado().testeUsado[nickDe(r.L.nick)] = true; salvarEstado(); }
    for (const f of ouvintes) setImmediate(() => { try { f(r.L); } catch {} });
    return { ok: true, L: r.L };
  }
  const ouvintes = [];
  const aoMudar = (f) => { if (typeof f === 'function') ouvintes.push(f); };

  // ---------- situação do plano para um nick ----------
  // estado: 'nenhuma' | 'teste' | 'ativo' | 'tolerancia' | 'vitalicio' | 'vencido' | 'revogada'
  function situacao(nick) {
    const n = nickDe(nick);
    const base = { nick: n || null, lancado: premiumLancado(), loja: !!loja(), planos: PLANOS, testeUsado: !!(n && estado().testeUsado[n]) };
    if (!n) return { ...base, estado: 'nenhuma', permite: false };
    const L = lerLicenca(n);
    if (!L || nickDe(L.nick) !== n) return { ...base, estado: 'nenhuma', permite: false };
    const t = agora();
    const info = { ...base, plano: L.plano, inicio: L.inicio || null, validoAte: L.validoAte || null, id: L.id || null, testeUsado: base.testeUsado || L.plano === 'teste' };
    if (L.revogada) return { ...info, estado: 'revogada', permite: false };
    if (L.plano === 'vitalicio' && !L.validoAte) return { ...info, estado: 'vitalicio', permite: true };
    const fim = Number(L.validoAte) || 0;
    const resta = fim - t;
    // (1 h de folga na conta dos dias: o relógio do PC alguns segundos atrás não vira "31 dias" num plano de 30)
    if (resta > 0) return { ...info, estado: L.plano === 'teste' ? 'teste' : 'ativo', permite: true, restaMs: resta, dias: Math.max(1, Math.ceil((resta - 3600e3) / DIA)) };
    if (L.plano === 'mensal' && -resta < TOLERANCIA_MS) return { ...info, estado: 'tolerancia', permite: true, restaMs: TOLERANCIA_MS + resta, dias: 0 };
    return { ...info, estado: 'vencido', permite: false, vencidoHa: -resta };
  }
  const permite = (nick) => situacao(nick).permite;
  // A chave que abre o código do Trader (vem na licença de quem pagou/está no teste). Procura em qualquer licença guardada
  // e não revogada: abrir o código não libera nada (quem libera é `permite`, pelo nick da principal, a cada minuto).
  function chaveDoCodigo(kid) {
    let nomes = [];
    try { nomes = fs.readdirSync(dir()).filter((n) => n.endsWith('.json') && n !== 'estado.json'); } catch { return null; }
    for (const n of nomes) {
      let r; try { r = conferir(fs.readFileSync(path.join(dir(), n), 'utf8')); } catch { continue; }
      const k = r.ok && !r.L.revogada && r.L.k && typeof r.L.k[kid] === 'string' ? Buffer.from(r.L.k[kid], 'base64') : null;
      if (k && k.length === 32) return k;
    }
    return null;
  }

  // ---------- conversa com a loja ----------
  async function pedir(caminho, corpo) {
    const base = loja();
    if (!base) return { erro: 'A loja do Premium ainda não abriu.' };
    try {
      const r = await fetch(base + caminho, corpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) } : { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) return { ...(j || {}), erro: (j && j.erro) || `A loja respondeu ${r.status}.` };
      return j;
    } catch { return { erro: 'Sem conexão com a loja. Confira a internet e tente de novo.' }; }
  }
  // Licença que veio da loja: confere, confere o nick e guarda.
  function receber(j, nick) {
    if (!j || !j.licenca) return null;
    const r = guardar(j.licenca);
    if (!r.ok || nickDe(r.L.nick) !== nickDe(nick)) return null;
    return r.L;
  }
  async function atualizar(nick) {
    const n = nickDe(nick);
    if (!n || !loja()) return situacao(n);
    const j = await pedir(`/v1/licenca?nick=${encodeURIComponent(n)}`);
    if (j && j.testeUsado) { estado().testeUsado[n] = true; salvarEstado(); }
    receber(j, n);
    return situacao(n);
  }
  async function pedirTeste(nick) {
    const n = nickDe(nick);
    if (!n) return { erro: 'Entre no jogo com a conta principal (★) primeiro.' };
    const s = situacao(n);
    if (s.permite) return { erro: 'Esta conta já está com o Trader liberado.' };
    const j = await pedir('/v1/teste', { nick: n, aparelho: estado().aparelho });
    if (j.erro) { if (j.testeUsado) { estado().testeUsado[n] = true; salvarEstado(); } return { erro: j.erro }; }
    if (!receber(j, n)) return { erro: 'A licença do teste não confere. Tente de novo.' };
    return { ok: true, situacao: situacao(n) };
  }
  async function criarPix(nick, plano) {
    const n = nickDe(nick);
    if (!n) return { erro: 'Entre no jogo com a conta principal (★) primeiro.' };
    if (plano !== 'mensal' && plano !== 'vitalicio') return { erro: 'Plano inválido.' };
    const j = await pedir('/v1/pix', { nick: n, plano, aparelho: estado().aparelho });
    if (j.erro) return { erro: j.erro };
    if (!j.id || typeof j.copiaECola !== 'string' || !/^000201[\x20-\x3b\x3d\x3f-\x7e]{20,600}$/.test(j.copiaECola)) return { erro: 'A loja não devolveu um Pix válido.' };
    let qrSvg = null;
    try { const qrcode = require('qrcode-generator'); const q = qrcode(0, 'M'); q.addData(j.copiaECola); q.make(); qrSvg = q.createSvgTag({ cellSize: 6, margin: 4, scalable: true }); } catch {}
    return { ok: true, id: String(j.id).slice(0, 80), copiaECola: j.copiaECola, qrSvg, valor: Number(j.valor) || PLANOS[plano].preco, plano, expiraEm: Number(j.expiraEm) || Date.now() + 30 * 60 * 1000 };
  }
  async function conferirPix(nick, id) {
    const n = nickDe(nick);
    const j = await pedir(`/v1/pix/${encodeURIComponent(String(id || '').slice(0, 80))}?nick=${encodeURIComponent(n)}`);
    if (j.erro) return { erro: j.erro };
    const L = receber(j, n);
    return { status: L ? 'pago' : (j.status === 'expirado' ? 'expirado' : 'pendente'), situacao: situacao(n) };
  }

  // ---------- avisos no Windows: 3 dias, 1 dia, no dia e quando acaba (uma vez cada, por licença) ----------
  function avisar(s) {
    if (!s || !s.id || !ctx || typeof ctx.notify !== 'function') return;
    const e = estado();
    const marca = (k) => { const c = `${s.id}:${k}`; if (e.avisos[c]) return false; e.avisos[c] = Date.now(); salvarEstado(); return true; };
    const oQue = s.plano === 'teste' ? 'O teste grátis do Trader' : 'O seu plano mensal do Trader';
    if ((s.estado === 'ativo' || s.estado === 'teste') && s.restaMs <= 3 * DIA && s.restaMs > DIA && marca('3d')) ctx.notify('📈 Trader Premium', `${oQue} acaba em ${s.dias} dias.${s.plano === 'teste' ? ' Assine para continuar.' : ' Renove pelo Pix na aba Trader.'}`);
    else if ((s.estado === 'ativo' || s.estado === 'teste') && s.restaMs <= DIA && marca('1d')) ctx.notify('📈 Trader Premium', `${oQue} acaba amanhã.${s.plano === 'teste' ? ' Assine para continuar.' : ' Renove pelo Pix na aba Trader.'}`);
    else if (s.estado === 'tolerancia' && marca('venceu')) ctx.notify('📈 Trader Premium', 'O seu plano mensal venceu. O Trader segue por mais algumas horas: renove pelo Pix na aba Trader.');
    else if (s.estado === 'vencido' && marca('fim')) ctx.notify('📈 Trader Premium', `${oQue} acabou. O Trader parou de comprar; os seus anúncios e pokémon ficam como estão. Assine na aba Trader para voltar.`);
  }

  // ---------- IPC (a tela do plano) ----------
  let nickAtual = async () => null;
  const comNick = async (f) => { const n = await Promise.resolve(nickAtual()).catch(() => null); return f(n); };
  ipcMain.handle('app:licenca:situacao', () => comNick(async (n) => { await calibrar(); return situacao(n); }));
  ipcMain.handle('app:licenca:atualizar', () => comNick(async (n) => { await calibrar(); return atualizar(n); }));
  ipcMain.handle('app:licenca:teste', () => comNick((n) => pedirTeste(n)));
  ipcMain.handle('app:licenca:pix', (_e, plano) => comNick((n) => criarPix(n, plano)));
  ipcMain.handle('app:licenca:pixStatus', (_e, id) => comNick((n) => conferirPix(n, id)));

  // Ciclo: hora do jogo, licença nova da loja (6 h) e avisos.
  let ultimaBusca = 0;
  async function ciclo() {
    await calibrar();
    const n = await Promise.resolve(nickAtual()).catch(() => null);
    if (!n) return;
    if (Date.now() - ultimaBusca > 6 * 3600 * 1000) { ultimaBusca = Date.now(); await atualizar(n).catch(() => {}); }
    avisar(situacao(n));
  }
  function iniciar(fnNick) {
    if (typeof fnNick === 'function') nickAtual = fnNick;
    setTimeout(() => ciclo().catch(() => {}), 20 * 1000);
    setInterval(() => ciclo().catch(() => {}), 10 * 60 * 1000);
  }

  return { conferir, guardar, aoMudar, situacao, permite, chaveDoCodigo, agora, calibrar, atualizar, pedirTeste, criarPix, conferirPix, iniciar, premiumLancado, PLANOS, _estado: estado };
};
module.exports.PLANOS = PLANOS;
