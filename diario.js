// Idleterino — diário das contas do PokeIdle, tudo neste PC.
//
// - Horas logadas: quanto tempo cada conta ficou logada (hoje, na semana) e há quanto está logada agora.
// - Histórico por dia (diario.json): XP, ouro, abates, capturas e shinys, a partir do placar da sessão
//   que o próprio jogo grava. É a base do relatório "Bom dia", do Wrapped e do Cartão do Treinador.
// - Vigia: conta logada que não ganha XP há X min, conta que caiu/deslogou, conta que travou e foi
//   reaberta, shiny. Avisa no PC e, se a pessoa ligar, no celular (ntfy) e no Discord dela (webhook).
//   O aviso leva o nick e o que aconteceu, nunca login, senha ou token.
// - Modo noite ("Vou dormir"): ULTRA em todas e Otimizar a cada 1 h; de manhã, o relatório da noite.
//   Ao acordar, volta tudo como estava. O app não troca hunt nem joga: só sugere.
// - Painel no celular (Wi-Fi de casa): página só de leitura, com código de acesso. Desligado de fábrica.
const { app, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const qrcode = require('qrcode-generator');

const READ_GAP = 90 * 1000; // leituras a cada 30 s: até 90 s entre duas ainda conta como "logada o tempo todo"
const DAY_KEEP = 400;
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const num = (s) => Number(String(s || '').replace(/\D+/g, '')) || 0;
const qr = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(6, 3); };
const randKey = (n) => { const abc = 'abcdefghijkmnpqrstuvwxyz23456789'; return [...crypto.randomBytes(n)].map((b) => abc[b % abc.length]).join(''); };
const big = (n) => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)); };
const hm = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };

const TIPOS = {
  parada: { nome: 'Conta parada (sem ganhar XP)', ico: '🚨', prio: 4 },
  caiu: { nome: 'Conta caiu ou deslogou', ico: '🔌', prio: 4 },
  travou: { nome: 'Conta travou e foi reaberta', ico: '🧊', prio: 3 },
  shiny: { nome: 'Shiny visto ou capturado', ico: '✨', prio: 4 },
  mercado: { nome: 'Alerta do Market', ico: '🔔', prio: 3 },
  bomdia: { nome: 'Relatório "Bom dia, treinador"', ico: '🌅', prio: 3 },
};

module.exports = function createDiario(ctx, poke) {
  const file = () => path.join(app.getPath('userData'), 'diario.json');
  const DEF = {
    contas: {}, eventos: [], noite: null, relatorios: [],
    avisos: { desktop: true, ntfyOn: false, ntfyTopic: null, discordOn: false, discordUrl: '', tipos: { parada: true, caiu: true, travou: true, shiny: true, mercado: true, bomdia: true } },
    vigia: { on: true, paradaMin: 5 },
    painel: { on: false, port: 47800, key: null },
  };
  let D = JSON.parse(JSON.stringify(DEF));
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
      D = { ...DEF, ...j, avisos: { ...DEF.avisos, ...(j.avisos || {}), tipos: { ...DEF.avisos.tipos, ...((j.avisos || {}).tipos || {}) } }, vigia: { ...DEF.vigia, ...(j.vigia || {}) }, painel: { ...DEF.painel, ...(j.painel || {}) } };
    } catch {}
  }
  let dirty = false;
  const save = () => { dirty = false; try { fs.writeFileSync(file(), JSON.stringify(D)); } catch {} };
  const touch = () => { dirty = true; };

  // ---------- Estado de cada conta, em memória ----------
  const rt = new Map(); // id -> { nick, at, logged, loggedSince, sess, prog, progAt, offSince, alerted }
  const keyOf = (nick) => String(nick || '').trim().toLowerCase();
  function dia(nick, t = Date.now()) {
    const k = keyOf(nick);
    const c = D.contas[k] || (D.contas[k] = { nick, dias: {} });
    c.nick = nick;
    const dk = dayKey(t);
    return c.dias[dk] || (c.dias[dk] = { ms: 0, xp: 0, gold: 0, ab: 0, cap: 0, shV: 0, shC: 0, reab: 0, quedas: 0, lvl0: 0, lvl1: 0, hunts: {} });
  }
  function noiteAcc(nick) {
    if (!D.noite) return null;
    const k = keyOf(nick);
    return D.noite.acc[k] || (D.noite.acc[k] = { nick, ms: 0, xp: 0, gold: 0, ab: 0, cap: 0, shV: 0, shC: 0, reab: 0, quedas: 0, lvl0: 0, lvl1: 0 });
  }
  const addTo = (o, d) => { if (!o) return; for (const k of ['ms', 'xp', 'gold', 'ab', 'cap', 'shV', 'shC']) o[k] += d[k] || 0; };

  function evento(nick, tipo, texto) {
    D.eventos.unshift({ t: Date.now(), nick, tipo, texto });
    D.eventos = D.eventos.slice(0, 300);
    touch();
  }

  // ---------- Avisos: PC, celular (ntfy) e Discord ----------
  const lastSent = new Map();
  async function enviar(tipo, titulo, texto, opts = {}) {
    const a = D.avisos;
    const t = TIPOS[tipo] || { ico: 'ℹ', prio: 3 };
    const out = [];
    if (a.ntfyOn && a.ntfyTopic) {
      out.push(net.fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: a.ntfyTopic, title: `${t.ico} ${titulo}`.slice(0, 200), message: String(texto).slice(0, 1500), priority: t.prio, tags: [] }) }).then((r) => r.ok, () => false));
    }
    if (a.discordOn && a.discordUrl) {
      out.push(net.fetch(a.discordUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Idleterino', content: `${t.ico} **${titulo}**\n${texto}`.slice(0, 1900), allowed_mentions: { parse: [] } }) }).then((r) => r.ok, () => false));
    }
    if (opts.desktop !== false && a.desktop && ctx.notify) ctx.notify(`${t.ico} ${titulo}`, texto, ctx.showMain);
    return Promise.all(out);
  }
  // Aviso de um acontecimento: respeita o liga/desliga de cada tipo e não repete o mesmo aviso da
  // mesma conta em 15 min (shiny: 1 min).
  function alerta(tipo, titulo, texto, chave = '') {
    if (!D.avisos.tipos[tipo]) return false;
    const k = `${tipo}|${chave}`;
    const gap = tipo === 'shiny' ? 60 * 1000 : 15 * 60 * 1000;
    if (Date.now() - (lastSent.get(k) || 0) < gap) return false;
    lastSent.set(k, Date.now());
    enviar(tipo, titulo, texto).catch(() => {});
    return true;
  }

  // ---------- Leitura de cada conta (chamada a cada 30 s pelo pokeidle.js) ----------
  function onRead(id, r) {
    const now = Date.now();
    const st = rt.get(id) || { alerted: {}, progAt: now };
    rt.set(id, st);
    const logged = !!r.logged;
    const nick = logged && r.nick && r.nick !== '—' ? r.nick : st.nick;
    if (nick) st.nick = nick;
    if (!nick) { st.at = now; st.logged = logged; return; }
    const day = dia(nick, now);
    const na = noiteAcc(nick);
    const lv = num(r.level);
    if (logged && lv) {
      if (!day.lvl0) day.lvl0 = lv; day.lvl1 = Math.max(day.lvl1 || 0, lv);
      if (na) { if (!na.lvl0) na.lvl0 = lv; na.lvl1 = Math.max(na.lvl1 || 0, lv); }
    }
    // Tempo logada
    if (logged) {
      if (st.logged && st.at && now - st.at < READ_GAP) {
        const dt = now - st.at;
        day.ms += dt; if (na) na.ms += dt;
        // Só o nome da hunt ("Brute Rhydon · nível 150" e "Brute Rhydon" são a mesma).
        const hunt = r.where && r.where !== '—' ? String(r.where).split(' · ')[0].trim() : null;
        if (hunt) day.hunts[hunt] = (day.hunts[hunt] || 0) + dt;
      }
      if (!st.loggedSince || !st.logged) st.loggedSince = now;
    } else st.loggedSince = null;
    // Placar da sessão: soma o que andou desde a última leitura (sessão nova = recomeça do zero).
    const s = r.sess;
    if (s && st.sess) {
      const same = s.ms >= st.sess.ms;
      const d = {};
      for (const [k, sk] of [['xp', 'xpTreinador'], ['gold', 'gold'], ['ab', 'abates'], ['cap', 'capturas'], ['shV', 'shVistos'], ['shC', 'shCapt']]) {
        const v = same ? (s[sk] || 0) - (st.sess[sk] || 0) : (s[sk] || 0);
        d[k] = v > 0 ? v : 0;
      }
      addTo(day, d); addTo(na, d);
      if (d.shC > 0) alerta('shiny', `${nick} capturou ${d.shC > 1 ? `${d.shC} shinys` : 'um shiny'}!`, 'Abra o jogo para ver qual foi.', id);
      else if (d.shV > 0) alerta('shiny', `${nick} viu um shiny!`, 'Um shiny apareceu na hunt.', id);
    }
    if (s) st.sess = s;
    // Vigia: progresso = nível + XP + placar. Sem mudar há X min estando logada = conta parada.
    const prog = `${r.level}|${r.xp}|${s ? s.xpTreinador : ''}`;
    if (prog !== st.prog) { st.prog = prog; st.progAt = now; st.alerted.parada = false; }
    if (D.vigia.on && logged && now - st.progAt >= D.vigia.paradaMin * 60 * 1000 && !st.alerted.parada) {
      st.alerted.parada = true;
      evento(nick, 'parada', `sem ganhar XP há ${D.vigia.paradaMin} min`);
      alerta('parada', `${nick} está parada`, `Logada, mas sem ganhar XP há ${D.vigia.paradaMin} min${r.where ? ` (${r.where})` : ''}. Pode ter morrido, acabado a poção ou ficado num menu.`, id);
    }
    // Caiu ou deslogou: estava logada e está fora há 2 min.
    if (logged) { if (st.alerted.caiu) evento(nick, 'voltou', 'logada de novo'); st.offSince = null; st.alerted.caiu = false; }
    else if (st.logged && !st.offSince) st.offSince = now;
    if (!logged && st.offSince && now - st.offSince >= 2 * 60 * 1000 && !st.alerted.caiu) {
      st.alerted.caiu = true;
      day.quedas++; const n2 = noiteAcc(nick); if (n2) n2.quedas++;
      evento(nick, 'caiu', 'saiu da conta ou caiu');
      if (D.vigia.on) alerta('caiu', `${nick} caiu`, 'A conta não está mais logada no app há 2 min. Entre de novo nela.', id);
    }
    st.logged = logged; st.at = now;
    touch();
  }
  // Conta reaberta pelo app (Otimizar, travou, login preso, recarregar).
  function onEvent(id, kind, motivo) {
    const st = rt.get(id); const nick = st && st.nick;
    if (!nick || kind !== 'reaberta') return;
    if (motivo === 'travou' || motivo === 'login preso') {
      const day = dia(nick); day.reab++; const na = noiteAcc(nick); if (na) na.reab++;
      evento(nick, 'travou', motivo === 'travou' ? 'travou e foi reaberta sozinha' : 'login preso: reaberta sozinha');
      if (D.vigia.on) alerta('travou', `${nick} ${motivo === 'travou' ? 'travou' : 'ficou presa no login'}`, 'O app reabriu a conta sozinho. Já deve estar caçando de novo.', id);
    }
  }

  // Horas de cada conta (vão para a lista de contas e para o painel).
  function horasOf(id) {
    const st = rt.get(id);
    if (!st || !st.nick) return null;
    const c = D.contas[keyOf(st.nick)];
    if (!c) return null;
    const now = Date.now();
    let semana = 0;
    for (let i = 0; i < 7; i++) { const d = c.dias[dayKey(now - i * 86400000)]; if (d) semana += d.ms; }
    const hoje = (c.dias[dayKey(now)] || {}).ms || 0;
    return { agora: st.logged && st.loggedSince ? now - st.loggedSince : 0, hoje, semana, parada: !!(st.alerted && st.alerted.parada) };
  }

  // ---------- Modo noite ----------
  function sugestaoNoite(info) {
    const hr = info && info.huntRank;
    if (!hr || !hr.top || !hr.top.length) return null;
    // A que mais dá XP entre as que gastam pouca poção (dormindo, ninguém compra poção).
    const seguras = hr.top.filter((h) => !(h.risco >= 1.3));
    const h = seguras[0] || [...hr.top].sort((a, b) => (a.risco || 0) - (b.risco || 0))[0];
    const cur = hr.atualEst;
    return { nome: h.nome, nivel: h.nivel, mesma: !!(cur && cur.slug === h.slug), atual: cur ? cur.nome : null, atualArriscada: !!(cur && cur.risco >= 1.3) };
  }
  function checklist() {
    return poke.accounts().filter((a) => a.isPoke).map((a) => {
      const i = poke.infoOf(a.id) || {};
      return { id: a.id, nick: i.logged && i.nick && i.nick !== '—' ? i.nick : a.name, logged: !!i.logged, hunt: i.where || null, sugestao: sugestaoNoite(i), autos: i.autos || [] };
    });
  }
  function startNight() {
    if (D.noite) return state();
    const accs = poke.accounts().filter((a) => a.isPoke);
    D.noite = { inicio: Date.now(), prev: { modes: Object.fromEntries(accs.map((a) => [a.id, a.mode])), optimizeEvery: poke.getOptimizeEvery() }, acc: {} };
    poke.setModes(Object.fromEntries(accs.map((a) => [a.id, 'ultra'])));
    if (!poke.getOptimizeEvery()) poke.setOptimizeEvery(60);
    evento('', 'noite', 'modo noite ligado');
    save();
    return state();
  }
  function endNight(auto = false) {
    const n = D.noite;
    if (!n) return null;
    D.noite = null;
    const keep = {};
    for (const a of poke.accounts()) if (n.prev.modes[a.id]) keep[a.id] = n.prev.modes[a.id];
    poke.setModes(keep);
    poke.setOptimizeEvery(n.prev.optimizeEvery || 0);
    const fim = Date.now();
    const rel = { inicio: n.inicio, fim, contas: Object.values(n.acc), eventos: D.eventos.filter((e) => e.t >= n.inicio && e.t <= fim && e.tipo !== 'noite').slice(0, 40) };
    D.relatorios.unshift(rel); D.relatorios = D.relatorios.slice(0, 15);
    evento('', 'noite', auto ? 'modo noite desligado sozinho' : 'bom dia: modo noite desligado');
    save();
    const tot = rel.contas.reduce((t, c) => ({ xp: t.xp + c.xp, gold: t.gold + c.gold, shC: t.shC + c.shC, shV: t.shV + c.shV, quedas: t.quedas + c.quedas + c.reab }), { xp: 0, gold: 0, shC: 0, shV: 0, quedas: 0 });
    const ups = rel.contas.filter((c) => c.lvl1 > c.lvl0).map((c) => `${c.nick} Nv ${c.lvl0}→${c.lvl1}`);
    alerta('bomdia', 'Bom dia, treinador!', [`Em ${hm(fim - n.inicio)} de noite: +${big(tot.xp)} XP, +${big(tot.gold)} de ouro`,
      tot.shC || tot.shV ? `✨ ${tot.shV} shiny(s) visto(s), ${tot.shC} capturado(s)` : null, ups.length ? `⬆ ${ups.join(', ')}` : null,
      tot.quedas ? `${tot.quedas} problema(s) resolvido(s) ou para ver` : 'Nenhuma queda 💪'].filter(Boolean).join('\n'), 'noite');
    return rel;
  }
  // Voltou para o PC depois de 4 h com o modo noite ligado: a tela mostra o relatório.
  function onWake() {
    if (D.noite && Date.now() - D.noite.inicio >= 4 * 3600 * 1000) { const rel = endNight(true); if (rel) ctx.send('app:bomdia', rel); }
  }

  // ---------- Painel no celular (Wi-Fi) ----------
  let server = null; let serverErr = null;
  const privado = (ip) => { ip = String(ip || '').replace(/^::ffff:/, ''); return ip === '127.0.0.1' || ip === '::1' || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip); };
  function lanIp() {
    for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal && privado(n.address)) return n.address;
    return null;
  }
  const sameKey = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  function painelDados() {
    const now = Date.now();
    return {
      at: now, noite: D.noite ? { inicio: D.noite.inicio } : null,
      contas: poke.accounts().filter((a) => a.isPoke).map((a) => {
        const i = poke.infoOf(a.id) || {}; const h = horasOf(a.id) || {}; const s = i.sess;
        const rate = (x) => (s && s.ms > 0 ? Math.round((x * 3600000) / s.ms) : 0);
        return { nick: i.logged && i.nick && i.nick !== '—' ? i.nick : a.name, logged: !!i.logged, nivel: num(i.level), modo: a.mode, onde: i.where || '', xpH: s ? rate(s.xpTreinador) : 0, ouroH: s ? rate(s.gold) : 0, shV: s ? s.shVistos : 0, shC: s ? s.shCapt : 0, agora: h.agora || 0, hoje: h.hoje || 0, parada: !!h.parada };
      }),
      eventos: D.eventos.slice(0, 12),
    };
  }
  const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Idleterino</title>
<style>body{margin:0;font:15px system-ui,sans-serif;background:#0a0b10;color:#e8e9f0}h1{font-size:18px;margin:16px}.c{background:#151722;border:1px solid #262a3a;border-radius:12px;margin:10px 16px;padding:12px}.t{display:flex;gap:8px;align-items:center}.t b{font-size:16px}.lv{margin-left:auto;color:#9aa0b5}.g{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.g div{background:#0f111a;border-radius:8px;padding:6px 8px}.g small{display:block;color:#8a90a5;font-size:11px}.ok{color:#45d483}.bad{color:#ff6b6b}.e{color:#9aa0b5;font-size:13px;margin:4px 16px}.f{color:#666b80;font-size:12px;margin:12px 16px 24px}</style></head>
<body><h1>⚡ Idleterino · contas</h1><div id="r">Carregando…</div><div class="f">Só leitura · atualiza a cada 15 s · funciona no Wi-Fi de casa</div>
<script>const k=new URLSearchParams(location.search).get('k');const big=n=>{n=+n||0;return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e4?Math.round(n/1e3)+'k':String(n)};const hm=ms=>{const m=Math.round(ms/6e4);return Math.floor(m/60)+'h'+String(m%60).padStart(2,'0')};const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function go(){try{const d=await (await fetch('/api?k='+encodeURIComponent(k))).json();let h=d.noite?'<div class="e">🌙 Modo noite desde '+new Date(d.noite.inicio).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+'</div>':'';for(const c of d.contas){h+='<div class="c"><div class="t"><span class="'+(c.logged&&!c.parada?'ok':'bad')+'">●</span><b>'+esc(c.nick)+'</b><span class="lv">Nv '+c.nivel+'</span></div><div class="e" style="margin:4px 0">'+(c.logged?(c.parada?'⚠ parada, sem ganhar XP':'caçando')+(c.onde?' · '+esc(c.onde):''):'fora do jogo')+'</div><div class="g"><div><small>XP/h</small>'+big(c.xpH)+'</div><div><small>Ouro/h</small>'+big(c.ouroH)+'</div><div><small>Logada agora</small>'+hm(c.agora)+'</div><div><small>Hoje</small>'+hm(c.hoje)+'</div><div><small>✨ vistos / capt.</small>'+(c.shV||0)+' / '+(c.shC||0)+'</div><div><small>Modo</small>'+esc(c.modo)+'</div></div></div>'}for(const e of d.eventos.slice(0,6))h+='<div class="e">'+new Date(e.t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+' · '+esc(e.nick)+' '+esc(e.texto)+'</div>';document.getElementById('r').innerHTML=h}catch(e){document.getElementById('r').textContent='Sem conexão com o PC.'}}go();setInterval(go,15000)</script></body></html>`;
  function startServer() {
    stopServer();
    if (!D.painel.key) { D.painel.key = randKey(20); save(); }
    serverErr = null;
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (!privado(req.socket.remoteAddress) || !sameKey(u.searchParams.get('k'), D.painel.key) || req.method !== 'GET') { res.writeHead(403); return res.end('Acesso negado'); }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (u.pathname === '/api') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(painelDados())); }
      if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" }); return res.end(PAGE); }
      res.writeHead(404); res.end();
    });
    server.on('error', (e) => { serverErr = e.code === 'EADDRINUSE' ? `A porta ${D.painel.port} está ocupada por outro programa.` : String(e.message || e); server = null; ctx.send('app:diario', state()); });
    server.listen(D.painel.port, '0.0.0.0');
  }
  function stopServer() { if (server) { try { server.close(); } catch {} server = null; } }

  // ---------- Estado para a tela ----------
  function state() {
    const ip = lanIp();
    const painelUrl = ip && D.painel.key ? `http://${ip}:${D.painel.port}/?k=${D.painel.key}` : null;
    return {
      avisos: { ...D.avisos, ntfyQr: D.avisos.ntfyTopic ? qr(`ntfy://ntfy.sh/${D.avisos.ntfyTopic}?display=Idleterino`) : null, ntfyWeb: D.avisos.ntfyTopic ? `https://ntfy.sh/${D.avisos.ntfyTopic}` : null },
      tipos: Object.fromEntries(Object.entries(TIPOS).map(([k, v]) => [k, v.nome])),
      vigia: D.vigia,
      painel: { on: D.painel.on, rodando: !!server, erro: serverErr, url: D.painel.on ? painelUrl : null, qr: D.painel.on && painelUrl ? qr(painelUrl) : null, semRede: !ip },
      noite: D.noite ? { inicio: D.noite.inicio, prev: D.noite.prev } : null,
      ultimoRelatorio: D.relatorios[0] || null,
      eventos: D.eventos.slice(0, 30),
    };
  }

  ipcMain.handle('app:diario:state', () => state());
  ipcMain.handle('app:diario:dados', () => ({ contas: D.contas, relatorios: D.relatorios, hoje: dayKey() }));
  ipcMain.handle('app:diario:avisos', (_e, patch) => {
    const a = D.avisos;
    const p = patch || {};
    if ('desktop' in p) a.desktop = !!p.desktop;
    if ('ntfyOn' in p) { a.ntfyOn = !!p.ntfyOn; if (a.ntfyOn && !a.ntfyTopic) a.ntfyTopic = `idl-${randKey(22)}`; }
    if (p.ntfyNovo) a.ntfyTopic = `idl-${randKey(22)}`;
    if ('discordUrl' in p) {
      const u = String(p.discordUrl || '').trim();
      if (u && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u)) return { ...state(), error: 'Esse não parece um link de webhook do Discord. Ele começa com https://discord.com/api/webhooks/' };
      a.discordUrl = u; if (!u) a.discordOn = false;
    }
    if ('discordOn' in p) a.discordOn = !!p.discordOn && !!a.discordUrl;
    if (p.tipos) for (const k of Object.keys(TIPOS)) if (k in p.tipos) a.tipos[k] = !!p.tipos[k];
    save();
    return state();
  });
  ipcMain.handle('app:diario:testar', async (_e, canal) => {
    const a = D.avisos;
    const quer = { desktop: canal === 'desktop', ntfy: canal === 'ntfy', discord: canal === 'discord' };
    const saved = { ...a };
    a.ntfyOn = quer.ntfy && !!a.ntfyTopic; a.discordOn = quer.discord && !!a.discordUrl; a.desktop = quer.desktop;
    let ok;
    try { const r = await enviar('bomdia', 'Idleterino conectado ✅', 'Os avisos das suas contas vão chegar aqui.'); ok = quer.desktop || (r.length > 0 && r.every(Boolean)); } finally { Object.assign(a, { ntfyOn: saved.ntfyOn, discordOn: saved.discordOn, desktop: saved.desktop }); }
    return { ok, error: ok ? null : 'Não consegui enviar. Confira o link e a internet.' };
  });
  ipcMain.handle('app:diario:vigia', (_e, patch) => {
    if (patch && 'on' in patch) D.vigia.on = !!patch.on;
    if (patch && 'paradaMin' in patch) D.vigia.paradaMin = [3, 5, 10, 15, 30].includes(Number(patch.paradaMin)) ? Number(patch.paradaMin) : 5;
    save(); return state();
  });
  ipcMain.handle('app:diario:painel', (_e, patch) => {
    if (patch && patch.novoCodigo) { D.painel.key = randKey(20); if (D.painel.on) startServer(); }
    if (patch && 'on' in patch) { D.painel.on = !!patch.on; if (D.painel.on) startServer(); else stopServer(); }
    save();
    return new Promise((res) => setTimeout(() => res(state()), 300));
  });
  ipcMain.handle('app:diario:noite:check', () => checklist());
  ipcMain.handle('app:diario:noite:start', () => startNight());
  ipcMain.handle('app:diario:noite:end', () => ({ rel: endNight(false), state: state() }));

  function start() {
    load();
    setInterval(() => { if (dirty) save(); }, 60 * 1000);
    // Poda: só os últimos 400 dias.
    const lim = dayKey(Date.now() - DAY_KEEP * 86400000);
    for (const c of Object.values(D.contas)) for (const k of Object.keys(c.dias)) if (k < lim) delete c.dias[k];
    if (D.painel.on) startServer();
    // Modo noite esquecido ligado por mais de 16 h: desliga e manda o relatório.
    setInterval(() => { if (D.noite && Date.now() - D.noite.inicio > 16 * 3600 * 1000) { const rel = endNight(true); if (rel) ctx.send('app:bomdia', rel); } }, 10 * 60 * 1000);
  }
  return { start, onRead, onEvent, horasOf, alerta, onWake, save, stopServer };
};
