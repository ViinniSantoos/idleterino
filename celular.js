// Idleterino — "Levar para o celular": as contas do PokeIdle deste PC vão para o Idleterino Android.
//
// O login do PokeIdle é só o `sessao` da página (nick + código de acesso). Ele vai CRIPTOGRAFADO com um PIN de 8 números
// (AES-256-GCM, chave PBKDF2-SHA256 de 310 mil voltas), com prazo de 5 minutos.
//
// O QR é PEQUENO (igual ao do Pix): leva só o endereço deste PC na rede de casa. Ao gerar, o app abre por 5 minutos um
// "guichê" só na rede local; o celular, na mesma Wi-Fi, lê o QR, pega o pacote criptografado aqui (no máximo 3 vezes) e o
// guichê abre o Idleterino Android, que pede o PIN. Nada passa pela internet nem por servidor de ninguém.
//
// Twitch/Kick entre o PC e o celular: o pacote leva também uma CHAVE SECRETA deste par PC+celular. Enquanto a Twitch (ou
// a Kick) está farmando no celular, ele avisa na rede de casa (UDP 47813, a cada minuto, assinado com a chave). O PC só
// aceita aviso com a chave certa e, enquanto ele chega, para as lives DAQUELA plataforma. O celular fechou, saiu do Wi-Fi
// ou passou 3 min sem avisar: o PC volta a farmar sozinho. Longe de casa o aviso não chega e os dois farmam.
const { ipcMain, app } = require('electron');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const qrcode = require('qrcode-generator');

const VALIDADE_MS = 5 * 60 * 1000;
const USOS_MAX = 3;
const PORTA = 47811;
const PORTA_ELO = 47813;
const ELO_VALE_MS = 3 * 60 * 1000;
const BAIXAR = 'https://github.com/ViinniSantoos/idleterino-android/releases/latest';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** O endereço deste PC na rede de casa (Wi-Fi/cabo), preferindo as faixas privadas comuns. */
function ipLocal() {
  const todos = [];
  for (const [nome, lista] of Object.entries(os.networkInterfaces())) {
    for (const i of lista || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|docker/i.test(nome)) continue;
      const p = i.address.startsWith('192.168.') ? 0 : i.address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(i.address) ? 2 : 9;
      if (p < 9) todos.push({ ip: i.address, p });
    }
  }
  todos.sort((a, b) => a.p - b.p);
  return todos[0] ? todos[0].ip : null;
}

// A página que o celular recebe: abre o Idleterino Android com o pacote (que só abre com o PIN).
const paginaGuiche = (pacote) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Idleterino no celular</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#0b0a16;color:#f1eefc;font-family:system-ui,sans-serif;text-align:center}main{max-width:420px;display:grid;gap:14px}a{display:block;padding:15px;border-radius:14px;font-weight:800;text-decoration:none}.a{background:linear-gradient(90deg,#ff5cd6,#9b7bff 55%,#33d6ff);color:#141024}.b{border:1px solid rgba(255,255,255,.25);color:#f1eefc}p{color:#cfc8f5;line-height:1.5;margin:0}</style></head>
<body><main><h1 style="margin:0">Idleterino no celular</h1><p>Toque no botão para abrir o Idleterino. Ele vai pedir o PIN de 8 números que está na tela do PC.</p>
<a class="a" id="ab" href="#">Abrir no Idleterino</a><a class="b" href="${BAIXAR}">Ainda não tenho o app: baixar</a>
<p style="font-size:13px;color:#a9a2d4">As contas vêm criptografadas e só abrem com o PIN do PC.</p></main>
<script>var i='intent://importar#Intent;scheme=idleterino;package=io.github.viinnisantoos.idleterino;S.d=${pacote};S.browser_fallback_url=${encodeURIComponent(BAIXAR)};end';document.getElementById('ab').href=i;setTimeout(function(){location.href=i},400);</script></body></html>`;

module.exports = function criarCelular(ctx, poke) {
  // ---------- elo com o celular (só rede de casa) ----------
  const eloPath = () => path.join(app.getPath('userData'), 'celular-elo.json');
  let elo = (() => { try { return JSON.parse(fs.readFileSync(eloPath(), 'utf8')); } catch { return null; } })();
  function chaveDoPar() {
    if (!elo || !elo.k) { elo = { k: b64url(crypto.randomBytes(32)), t: 0 }; try { fs.writeFileSync(eloPath(), JSON.stringify(elo)); } catch {} }
    return elo.k;
  }
  const visto = { twitch: 0, kick: 0 };
  let ultimoT = 0;
  const ativoNoCelular = (ns) => Date.now() - (visto[ns] || 0) < ELO_VALE_MS;
  ctx.celularAtivo = ativoNoCelular;
  let antes = { twitch: false, kick: false };
  function avisarMudanca() {
    for (const ns of ['twitch', 'kick']) {
      const agora = ativoNoCelular(ns);
      if (agora === antes[ns]) continue;
      antes[ns] = agora;
      const nome = ns === 'twitch' ? 'Twitch' : 'Kick';
      ctx.send('twitch:toast', agora ? `📱 ${nome} farmando no celular: o PC parou as lives da ${nome}.` : `🖥 O celular parou a ${nome}: o PC voltou a farmar.`);
      const f = ctx.aoCelular && ctx.aoCelular[ns];
      if (typeof f === 'function') try { f(); } catch {}
    }
  }
  setInterval(avisarMudanca, 20 * 1000);
  const ouvido = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  ouvido.on('error', () => { try { ouvido.close(); } catch {} });
  ouvido.on('message', (msg) => {
    if (!elo || !elo.k || msg.length > 600) return;
    const [tag, corpo, mac] = String(msg).split('.');
    if (tag !== 'IDL1' || !corpo || !mac) return;
    const certo = crypto.createHmac('sha256', Buffer.from(elo.k, 'base64url')).update(corpo).digest();
    let veio; try { veio = Buffer.from(mac, 'base64url'); } catch { return; }
    if (veio.length !== certo.length || !crypto.timingSafeEqual(veio, certo)) return;
    let d; try { d = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); } catch { return; }
    const t = Number(d.t) || 0;
    if (t <= ultimoT || Math.abs(Date.now() - t) > 5 * 60 * 1000) return; // repetido ou velho
    ultimoT = t;
    const agora = Date.now();
    visto.twitch = !d.fim && d.tw ? agora : 0;
    visto.kick = !d.fim && d.kk ? agora : 0;
    avisarMudanca();
  });
  try { ouvido.bind(PORTA_ELO, '0.0.0.0'); } catch {}

  let guiche = null; // { srv, id, pacote, exp, usos, timer }
  const fecharGuiche = () => { if (guiche) { clearTimeout(guiche.timer); try { guiche.srv.close(); } catch {} guiche = null; } };

  function abrirGuiche(pacote, exp) {
    fecharGuiche();
    const id = b64url(crypto.randomBytes(9)); // 12 caracteres: ninguém adivinha o endereço
    return new Promise((ok, falha) => {
      const srv = http.createServer((req, res) => {
        const g = guiche;
        const certo = g && req.method === 'GET' && req.url === `/l/${g.id}` && Date.now() < g.exp && g.usos < USOS_MAX;
        if (!certo) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Este QR não vale mais. Gere outro no Idleterino do PC.'); return; }
        g.usos++;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        res.end(paginaGuiche(g.pacote));
        if (g.usos >= USOS_MAX) setTimeout(fecharGuiche, 2000);
      });
      srv.on('error', falha);
      srv.listen(PORTA, '0.0.0.0', () => {
        guiche = { srv, id, pacote, exp, usos: 0, timer: setTimeout(fecharGuiche, exp - Date.now()) };
        ok(id);
      });
    });
  }

  ipcMain.handle('app:celular:contas', async () => {
    const out = [];
    for (const a of poke.accounts().filter((x) => x.isPoke)) {
      const s = await poke.lerSessao(a.id).catch(() => null);
      out.push({ id: a.id, nome: a.name, nick: s && s.nick ? s.nick : null, logada: !!(s && s.token) });
    }
    return out;
  });

  ipcMain.handle('app:celular:fechar', () => { fecharGuiche(); return true; });

  ipcMain.handle('app:celular:gerar', async (_e, ids) => {
    const contas = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 4)) {
      const s = await poke.lerSessao(id).catch(() => null);
      if (!s || !s.token) continue;
      const a = poke.accounts().find((x) => x.id === id) || {};
      contas.push({ nome: s.nick || a.name || 'Conta', curta: [String(s.nick || ''), String(s.token), String(s.provedor || '')] });
    }
    if (!contas.length) return { erro: 'Nenhuma das contas escolhidas está logada no PokeIdle.' };
    const ip = ipLocal();
    if (!ip) return { erro: 'Este PC não está numa rede Wi-Fi/cabo de casa. Conecte o PC e o celular na mesma Wi-Fi e tente de novo.' };
    const exp = Date.now() + VALIDADE_MS;
    const pin = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const chave = crypto.pbkdf2Sync(pin, salt, 310000, 32, 'sha256');
    const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
    const dados = Buffer.from(JSON.stringify({ v: 2, e: exp, c: contas.map((x) => x.curta), k: chaveDoPar() }), 'utf8');
    const corpo = Buffer.concat([c.update(dados), c.final(), c.getAuthTag()]);
    const pacote = `c2.${b64url(Buffer.concat([salt, iv, corpo]))}`;
    let id;
    try { id = await abrirGuiche(pacote, exp); } catch (e) { return { erro: `Não consegui abrir a porta ${PORTA} na rede (${e.code || e.message}). Feche outros programas que usem essa porta e tente de novo.` }; }
    // QR pequeno: só o endereço (~40 caracteres), como o do Pix.
    const url = `http://${ip}:${PORTA}/l/${id}`;
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    return { qrSvg: q.createSvgTag({ cellSize: 8, margin: 4, scalable: true }), modulos: q.getModuleCount(), pin, exp, n: contas.length, nomes: contas.map((x) => x.nome), tamanho: url.length, ip, url };
  });
};
