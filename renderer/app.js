// Idleterino — tela. Uma página de plataforma serve para Twitch e Kick (as diferenças ficam em P).
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const clock = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`; };
const timeStr = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const call = (ch, ...a) => window.idle.invoke(ch, ...a);
const button = (text, cls, onclick) => { const b = el('button', cls, text); b.onclick = onclick; return b; };

// O que muda de uma plataforma para a outra.
const P = {
  twitch: {
    name: 'Twitch', letter: 'T', login: 'Entrar com a Twitch',
    emote: (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`,
    bonusKey: (b) => b.kind,
    targets: (s) => [['', 'Bônus automático'], ...(s.bonusOptions || []).map((o) => [o.value, `${o.kind === 'xp' ? 'XP' : o.kind === 'capture' ? 'Capture Boost' : 'Secret Lure'} · ${o.hours} h — ${fmt(o.cost)} pts`])],
    rate: 2, hasChest: true, firstCount: 5,
  },
  kick: {
    name: 'Kick', letter: 'K', login: 'Entrar com a Kick',
    emote: (id) => `https://files.kick.com/emotes/${id}/fullsize`,
    bonusKey: (b) => b.kind,
    targets: (s) => [['', 'Bônus automático'], ...(s.bonusOptions || []).map((o) => [o.value, `${o.kind === 'xp' ? 'XP' : o.kind === 'capture' ? 'Capture Boost' : 'Secret Lure'} · ${o.hours} h — ${fmt(o.cost)} pts`])],
    rate: 2, hasChest: false, firstCount: 7,
  },
};
const short = (name) => String(name).replace('+15% ', '');

// ---------- Estado ----------
const S = { app: null, twitch: null, kick: null, poke: null, ext: null };
const view = { twitch: { active: null, filter: '', offline: false }, kick: { active: null, filter: '', offline: false } };
const chat = { twitch: new Map(), kick: new Map() }; // slug -> [nós]
const MAX_MSG = 300, MAX_BG = 120;

// ---------- Navegação ----------
let page = 'home';
function go(p) {
  page = p;
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('on', b.dataset.page === p);
  for (const s of document.querySelectorAll('.page')) s.classList.toggle('on', s.id === `page-${p}`);
  if (P[p]) renderPlatform(p);
  if (p === 'poke') renderPoke(); else pokeView(false);
  if (p === 'home') renderHome();
  if (p === 'settings') renderSettings();
  if (p === 'ext') renderExt();
  if (p === 'pvp' && typeof renderPvp === 'function') renderPvp();
  if (p === 'help') renderHelp();
}
for (const b of document.querySelectorAll('.nav')) b.onclick = () => go(b.dataset.page);

// ---------- Início ----------
function renderHome() {
  const box = $('#home-platforms');
  box.replaceChildren();
  const h = new Date().getHours();
  $('#hello').textContent = h < 5 ? 'Boa madrugada 🌙' : h < 12 ? 'Bom dia ☀️' : h < 18 ? 'Boa tarde 👋' : 'Boa noite 🌙';
  renderUpdateBar();
  for (const ns of ['twitch', 'kick']) {
    const s = S[ns];
    const on = S.app && S.app.platforms[ns];
    const card = el('div', `card pcard ${ns}${on ? '' : ' disabled'}`);
    const head = el('div', 'pcard-head');
    head.append(el('span', 'badge', P[ns].letter), el('b', null, P[ns].name));
    const state = el('span', 'state', !on ? 'desligado' : !s ? 'carregando…' : !s.loggedIn ? 'sem login' : s.farming ? 'juntando pontos' : 'pausado');
    head.append(state);
    card.append(head);
    if (on && s) {
      const live = s.channels.filter((c) => c.live).length;
      const watching = s.channels.filter((c) => c.watching).length;
      const pts = s.channels.reduce((t, c) => t + (c.points || 0), 0);
      const stats = el('div', 'stats');
      const stat = (v, l) => { const d = el('div', 'stat'); d.append(el('b', null, v), el('span', null, l)); return d; };
      stats.append(stat(`${watching}/${live}`, 'assistindo / ao vivo'), stat(fmt(pts), 'pontos nos canais'), stat(ns === 'twitch' ? `+${fmt(s.today || 0)}` : `+${fmt(s.channels.reduce((t, c) => t + (c.gained || 0), 0))}`, ns === 'twitch' ? 'hoje' : 'desde o último gasto'));
      card.append(stats, timers(ns, s));
      if (!s.loggedIn) card.append(button(P[ns].login, 'primary go', () => call(`${ns}:login:show`)));
      else card.append(button(`Abrir ${P[ns].name} →`, 'go', () => go(ns)));
    } else if (!on) {
      card.append(el('span', 'sub', 'Desligado: não abre lives nem gasta memória.'), button('Ligar', 'go', () => setPlatform(ns, true)));
    }
    box.append(card);
  }
  renderHomePoke();
}
// Faixa de versão nova, no topo do Início.
function renderUpdateBar() {
  let bar = $('#update-bar');
  if (!bar) { bar = el('div', 'update-bar'); bar.id = 'update-bar'; $('#home-platforms').before(bar); }
  const u = S.app && S.app.update;
  bar.hidden = !u;
  if (!u) return;
  bar.className = `update-bar ${u.state}`;
  bar.replaceChildren();
  const txt = el('div', 'ub-txt');
  if (u.state === 'downloading') {
    txt.append(el('b', null, `Nova versão ${u.version} chegando`), el('span', null, `Baixando… ${u.percent || 0}%. O botão de atualizar aparece aqui quando terminar.`));
    const pr = el('div', 'ub-prog'); const f = el('i'); f.style.width = `${u.percent || 0}%`; pr.append(f); txt.append(pr);
    bar.append(el('span', 'ub-ico', '⬇'), txt);
  } else if (u.state === 'ready') {
    txt.append(el('b', null, `Nova versão ${u.version} pronta`), el('span', null, 'O app fecha, instala e abre de novo sozinho, em poucos segundos. As contas voltam conectadas.'));
    const b = button('Atualizar agora', 'primary', async () => { b.disabled = true; b.textContent = 'Atualizando…'; await call('app:update:install'); });
    bar.append(el('span', 'ub-ico', '✦'), txt, b);
  } else {
    txt.append(el('b', null, `Nova versão ${u.version} disponível`), el('span', null, 'Esta versão (portátil ou .deb) não se atualiza sozinha: baixe a nova no site.'));
    bar.append(el('span', 'ub-ico', '✦'), txt, button('Baixar no site', 'primary', () => call('app:update:install')));
  }
}
function timers(ns, s) {
  const wrap = el('div', 'timers');
  const now = Date.now();
  for (const b of s.bonuses || []) {
    const on = b.endsAt && b.endsAt > now;
    const t = el('span', `timer${on ? ' on' : ''}`);
    t.append(el('span', null, short(b.name)), el('b', null, on ? clock(b.endsAt - now) : '—'));
    wrap.append(t);
  }
  return wrap;
}

// ---------- Página de plataforma ----------
function renderPlatform(ns) {
  const root = $(`#page-${ns}`);
  const s = S[ns];
  root.replaceChildren();
  const on = S.app && S.app.platforms[ns];
  const top = el('div', 'ptop');
  const h = el('h1'); h.append(el('i'), P[ns].name);
  top.append(h);
  if (!on) {
    root.append(top, emptyBox(`${P[ns].name} desligado`, 'Ligue para abrir as lives e juntar pontos. Desligado, não gasta nada.', button('Ligar', 'primary', () => setPlatform(ns, true))));
    return;
  }
  if (!s) { root.append(top, emptyBox('Carregando…', 'Conectando aos canais.')); return; }
  // Barra de cima: o essencial, sem poluir.
  const farm = el('label', 'switch');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = s.farming;
  cb.onchange = async () => apply(ns, await call(`${ns}:farming:set`, cb.checked));
  farm.append(cb, el('span', 'ui'), el('span', null, 'Juntar pontos'));
  const target = el('select');
  for (const [v, l] of P[ns].targets(s)) { const o = el('option', null, l); o.value = v; target.append(o); }
  target.value = String(s.bonusTarget || '');
  target.title = 'Bônus que o foco busca: as lives vão para os canais mais perto do preço dele';
  target.onchange = async () => apply(ns, await call(`${ns}:bonusTarget:set`, target.value));
  const live = s.channels.filter((c) => c.live).length;
  const watching = s.channels.filter((c) => c.watching).length;
  const chipW = el('span', 'chip'); chipW.append(el('b', null, `${watching}/${live}`), 'assistindo');
  top.append(farm, target, chipW, el('span', 'spacer'));
  if (!s.loggedIn) top.append(button(P[ns].login, 'primary', () => call(`${ns}:login:show`)));
  else { const u = el('span', 'chip'); u.append('✓ ', el('b', null, s.username || 'conectado')); top.append(u); }
  top.append(button('⚙ Ajustes', null, () => openDrawer(ns)));
  const body = el('div', 'pbody');
  body.append(channelCol(ns, s), chatCol(ns, s), sideCol(ns, s));
  root.append(top, body);
  const box = $('.msgs', root);
  if (box) box.scrollTop = box.scrollHeight;
}
function emptyBox(title, text, ...extra) {
  const e = el('div', 'empty'); e.append(el('b', null, title), el('span', null, text));
  if (extra.length) { const a = el('div', 'actions'); a.style.justifyContent = 'center'; a.append(...extra); e.append(a); }
  return e;
}

function avatar(ns, ch) {
  const a = el('div', 'av');
  const pct = ch.goal && ch.points != null ? Math.min(100, Math.round((ch.points / ch.goal) * 100)) : 0;
  a.style.setProperty('--p', `${pct}%`);
  if (ch.avatar) { const i = el('img'); i.src = ch.avatar; i.alt = ''; a.append(i); } else a.append(el('span', null, ch.displayName.slice(0, 1).toUpperCase()));
  if (ch.live) a.append(el('i', 'live'));
  a.title = ch.goal ? `${fmt(ch.points)} de ${fmt(ch.goal)} pts até o próximo bônus` : '';
  return a;
}
const showGain = (s, ch) => s.gainDisplay === 'always' || (s.gainDisplay !== 'never' && ch.watching);

function channelCol(ns, s) {
  const col = el('div', 'col');
  const head = el('div', 'col-head'); head.append('Canais', el('span', 'muted', `${s.channels.length}`));
  const search = el('input', 'search'); search.type = 'text'; search.placeholder = 'Buscar canal…'; search.value = view[ns].filter;
  search.oninput = () => { view[ns].filter = search.value; const list = $('.col-scroll', col); list.replaceChildren(...channelRows(ns, s)); };
  const list = el('div', 'col-scroll');
  list.append(...channelRows(ns, s));
  col.append(head, search, list);
  return col;
}
function channelRows(ns, s) {
  const q = view[ns].filter.trim().toLowerCase();
  const favs = new Set(s.favorites || []);
  const list = s.channels.filter((c) => !q || c.displayName.toLowerCase().includes(q) || c.slug.includes(q));
  const order = (a, b) => (b.watching - a.watching) || (b.live - a.live) || ((b.points || 0) - (a.points || 0));
  const pinned = list.filter((c) => favs.has(c.slug) || c.subscribed).sort(order);
  const live = list.filter((c) => !pinned.includes(c) && c.live).sort(order);
  const off = list.filter((c) => !pinned.includes(c) && !c.live);
  const out = [];
  const group = (t, items) => { if (items.length) out.push(el('div', 'group', t), ...items.map((c) => row(ns, s, c))); };
  group('Fixados', pinned);
  group(`Ao vivo · ${live.length}`, live);
  if (off.length) {
    const t = el('div', 'group', `Offline · ${off.length} ${view[ns].offline || q ? '▴' : '▾'}`);
    t.style.cursor = 'pointer';
    t.onclick = () => { view[ns].offline = !view[ns].offline; renderPlatform(ns); };
    out.push(t);
    if (view[ns].offline || q) out.push(...off.map((c) => row(ns, s, c)));
  }
  const add = button('＋ Adicionar canal', 'add-ch', async () => {
    const input = el('input', 'search'); input.type = 'text'; input.placeholder = 'nome ou link do canal';
    add.replaceWith(input); input.focus();
    input.onkeydown = async (e) => {
      if (e.key === 'Enter' && input.value.trim()) apply(ns, await call(`${ns}:channels:add`, input.value));
      if (e.key === 'Escape') renderPlatform(ns);
    };
  });
  out.push(add);
  return out;
}
function row(ns, s, ch) {
  const r = el('div', `ch${ch.slug === view[ns].active ? ' active' : ''}${ch.live ? '' : ' off'}`);
  const info = el('div', 'ch-info');
  const name = el('div', 'ch-name');
  if ((s.favorites || []).includes(ch.slug)) name.append(el('span', null, '★'));
  name.append(el('span', null, ch.displayName));
  if (ch.subscribed) name.append(el('span', 'tag sub', 'SUB'));
  if (ch.rewardsLoaded && ch.hasBonus === false) name.append(el('span', 'tag soon', 'em breve'));
  const sub = el('div', 'ch-sub');
  // Status com o tempo desta vez de assistir: aquecendo X de Y min → ganhando há X min.
  const first = P[ns].firstCount; // minutos até a primeira contagem de pontos
  const tm = ch.turnMin ?? 0;
  if (ch.earning === 'earning') sub.append(el('span', 'earn', `● ganhando · ${clock(tm * 60000)}`));
  else if (ch.earning === 'warming') { const w = el('span', 'warm', `◌ aquecendo · ${Math.min(tm, first)} de ${first} min`); w.title = `A primeira contagem de pontos chega ~${first} min depois que a live abre.`; sub.append(w); }
  else if (ch.earning === 'idle') { const w = el('span', 'idle', `○ sem pontos há ${clock(tm * 60000)}`); w.title = 'Tocando sem o saldo subir: o app troca para outra live sozinho.'; sub.append(w); }
  else if (ch.live) { const q = el('span', null, ch.watching ? `${fmt(ch.viewers)} assistindo` : `na fila · ${fmt(ch.viewers)} assistindo`); if (!ch.watching) q.title = 'Na fila: entra quando abrir uma vaga (o foco põe primeiro quem está mais perto do bônus).'; sub.append(q); }
  else sub.append('offline');
  const eta = ch.watching && ch.goalLeft > 0 && ch.earning !== 'idle' ? el('div', 'ch-eta', `próx. bônus em ${clock((ch.goalLeft / (P[ns].rate * (ch.multiplier || 1))) * 60000)}`) : null;
  info.append(name, sub);
  if (eta) info.append(eta);
  const pts = el('div', 'ch-pts', ch.points != null ? fmt(ch.points) : '—');
  if (ch.gained > 0 && showGain(s, ch)) pts.append(el('small', null, `+${fmt(ch.gained)}`));
  r.append(avatar(ns, ch), info);
  if (ch.chest) { const c = el('span', 'tag chest', ch.chestState === 'claiming' ? 'pegando…' : '🎁'); c.title = 'Baú de bônus'; c.onclick = (e) => { e.stopPropagation(); call(`${ns}:store:open`, ch.slug); }; r.append(c); }
  r.append(pts);
  r.onclick = () => { view[ns].active = ch.slug; renderPlatform(ns); };
  return r;
}

function chatCol(ns, s) {
  const col = el('div', 'col');
  const ch = s.channels.find((c) => c.slug === view[ns].active) || s.channels.find((c) => c.watching) || s.channels.find((c) => c.live) || s.channels[0];
  if (!ch) { col.append(emptyBox('Nenhum canal', 'Adicione um canal na lista.')); return col; }
  view[ns].active = ch.slug;
  const head = el('div', 'chat-head');
  const t = el('div', 't'); t.append(el('b', null, ch.displayName), el('span', null, ch.live ? `🔴 ${fmt(ch.viewers)} · ${ch.title}` : 'offline'));
  const fav = button((s.favorites || []).includes(ch.slug) ? '★' : '☆', 'ghost', async () => apply(ns, await call(`${ns}:favorite:toggle`, ch.slug)));
  fav.title = 'Fixar no topo e avisar quando entrar ao vivo';
  head.append(avatar(ns, ch), t, fav, button('▶ Live', null, () => call(`${ns}:channel:show`, ch.slug)), button('Loja', null, () => call(`${ns}:store:open`, ch.slug)));
  const prices = el('div', 'prices');
  if (ns === 'twitch' && ch.rewards && ch.rewards.length) {
    for (const k of ['xp', 'capture', 'lure']) {
      const r = ch.rewards.filter((x) => x.kind === k).sort((a, b) => a.hours - b.hours)[0];
      if (!r) continue;
      const p = el('span', `price${ch.points >= r.cost ? ' ok' : ''}`);
      p.append(el('b', null, k === 'xp' ? 'XP' : k === 'capture' ? 'Capture' : 'Lure'), ` ${fmt(r.cost)}`);
      p.title = ch.rewards.filter((x) => x.kind === k).map((x) => `${x.hours} h: ${fmt(x.cost)}`).join('\n');
      prices.append(p);
    }
  }
  const msgs = el('div', 'msgs');
  const buf = chat[ns].get(ch.slug) || [];
  if (buf.length) msgs.append(...buf);
  else msgs.append(el('div', 'msg system', ns === 'kick' && !ch.watching ? 'O chat da Kick aparece quando a live está tocando.' : 'As mensagens aparecem aqui.'));
  const form = el('form', 'composer');
  const input = el('input'); input.type = 'text'; input.placeholder = s.loggedIn ? `Mensagem em ${ch.displayName}…` : 'Entre para mandar mensagens';
  form.append(input);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    input.value = '';
    const res = await call(`${ns}:chat:send`, { chatroomId: ns === 'twitch' ? ch.slug : ch.chatroomId, content: text });
    if (!res || !res.ok) pushMsg(ns, ch.slug, sysMsg(`Não enviou${res && res.message ? `: ${res.message}` : ''}.`));
  };
  col.append(head, prices, msgs, form);
  return col;
}

function sideCol(ns, s) {
  const col = el('div', 'col side');
  const list = el('div', 'col-scroll');
  const now = Date.now();
  const kv = (k, v) => { const d = el('div', 'kv'); d.append(el('span', null, k), el('b', null, v)); return d; };
  const section = (title, hint) => { const h = el('div', 'side-title', title); if (hint) h.title = hint; list.append(h); };

  // 1) Tocando agora: miniatura de cada live escondida + anel até o próximo +10.
  section('Tocando agora', 'As lives que estão rendendo pontos neste momento, escondidas e em 160p.');
  const playing = s.channels.filter((c) => c.watching);
  if (!s.loggedIn) list.append(el('div', 'side-empty', `Entre na ${P[ns].name} para começar.`));
  else if (!playing.length) list.append(el('div', 'side-empty', s.farming ? 'Nenhum canal ao vivo agora. As lives entram sozinhas quando alguém abrir.' : 'Juntar pontos está desligado.'));
  for (const c of playing) {
    const card = el('div', 'now');
    const thumb = el('div', 'now-thumb');
    const bucket = Math.floor(now / 300000); // a imagem muda a cada 5 min (sem pesar)
    const url = ns === 'twitch' ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${c.slug}-320x180.jpg?t=${bucket}` : c.thumb;
    // Sem miniatura da live (a Kick nem sempre manda): a foto do canal desfocada no fundo e nítida no meio.
    const fallback = () => {
      if (!c.avatar || thumb.querySelector('.now-av')) return;
      thumb.style.backgroundImage = `url("${c.avatar}")`;
      thumb.classList.add('blurbg');
      const a = el('img', 'now-av'); a.src = c.avatar; a.alt = ''; thumb.append(a);
    };
    if (url) { const i = el('img'); i.src = url; i.alt = ''; i.onerror = () => { i.remove(); fallback(); }; thumb.append(i); } else fallback();
    thumb.append(el('span', 'now-live', 'AO VIVO'));
    // Anel: enche até a próxima contagem (5 min depois da última; aquecendo, até a primeira).
    const first = P[ns].firstCount;
    let pct, label;
    if (c.earning === 'earning' && c.lastGainAt) { const m = (now - c.lastGainAt) / 60000; pct = Math.min(1, m / 5); label = m < 1 ? 'agora' : `há ${Math.floor(m)} min`; }
    else { const m = c.turnMin || 0; pct = Math.min(1, m / first); label = `${Math.min(m, first)}/${first} min`; }
    const ring = el('div', 'now-ring'); ring.style.setProperty('--p', `${Math.round(pct * 100)}%`); ring.append(el('span', null, '+10'));
    const info = el('div', 'now-info');
    info.append(el('b', null, c.displayName));
    const st = el('span', c.earning === 'earning' ? 'ok' : c.earning === 'idle' ? 'bad' : 'warm',
      c.earning === 'earning' ? `✓ último ponto ${label}` : c.earning === 'idle' ? '○ sem pontos — vai trocar' : `◌ aquecendo ${label}`);
    info.append(st);
    card.append(thumb, el('div', 'now-row'));
    card.lastChild.append(ring, info);
    card.onclick = () => { view[ns].active = c.slug; renderPlatform(ns); };
    list.append(card);
  }

  // 2) Próximos bônus: quem já dá para comprar e quem está chegando.
  const costOf = (c) => (ns === 'twitch' ? (s.bonusTarget ? c.targetCost : Math.min(c.costs.xp, c.costs.capture, c.costs.lure)) : (s.targetCost || 300));
  const withPts = s.channels.filter((c) => c.points != null && (ns !== 'twitch' || c.hasBonus));
  const ready = withPts.filter((c) => c.points >= costOf(c)).sort((x, y) => y.points - x.points);
  const coming = withPts.filter((c) => c.watching && c.points < costOf(c) && c.earning !== 'idle')
    .map((c) => ({ c, min: (costOf(c) - c.points) / (P[ns].rate * (c.multiplier || 1)) })).sort((x, y) => x.min - y.min);
  section('Próximos bônus', 'Canais com pontos para comprar agora e quanto falta nos que estão tocando.');
  if (!ready.length && !coming.length) list.append(el('div', 'side-empty', 'Ainda nenhum canal perto do bônus.'));
  for (const c of ready.slice(0, 4)) {
    const r = el('div', 'nb ready');
    r.append(el('span', 'nb-name', c.displayName), el('span', 'nb-val', `✓ ${fmt(c.points)} pts`));
    const shop = button('Loja', null, (e) => { e.stopPropagation(); call(`${ns}:store:open`, c.slug); }); r.append(shop);
    list.append(r);
  }
  for (const { c, min } of coming.slice(0, 3)) {
    const r = el('div', 'nb');
    r.append(el('span', 'nb-name', c.displayName), el('span', 'nb-val', `em ${clock(min * 60000)}`));
    list.append(r);
  }

  // 3) No jogo: quanto tempo cada conta do PokeIdle ainda tem deste bônus (lido do jogo).
  section(`No jogo · Bônus ${ns === 'twitch' ? 'Twitch' : 'na Kick'}`, 'Lido direto das suas contas do PokeIdle.');
  const accs = (S.poke && S.poke.accounts || []).filter((x) => x.isPoke !== false);
  if (!accs.length) { const e = el('div', 'side-empty'); e.append('Adicione suas contas do PokeIdle para ver aqui o tempo de bônus de cada uma. '); const l = button('Adicionar', 'ghost', () => go('poke')); e.append(l); list.append(e); }
  for (const x of accs) {
    const i = x.info || {};
    const nick = i.logged && i.nick && i.nick !== '—' ? i.nick : x.name;
    const at = (i.ativos || []).find((y) => y.kind === ns);
    const left = at && at.end ? at.end - now : 0;
    const r = el('div', `game${left > 0 ? '' : ' off'}`);
    r.append(el('span', null, nick), el('b', null, !i.logged ? 'sem login' : left > 0 ? clock(left) : '⚠ sem bônus'));
    if (left <= 0 && i.logged) r.title = 'Esta conta está sem o bônus: compre na loja de um canal com pontos (veja "Próximos bônus").';
    list.append(r);
  }

  // 4) Bônus ativos (cronômetro do app) e resumo.
  section('Cronômetro do app');
  for (const bn of s.bonuses || []) {
    const on = bn.endsAt && bn.endsAt > now;
    const r = el('div', `bonus${on ? ' on' : ''}`);
    r.append(el('span', 'n', short(bn.name)), el('span', 'l', on ? clock(bn.endsAt - now) : 'inativo'));
    const add = button('+1h', null, async () => apply(ns, await call(`${ns}:purchase:add`, P[ns].bonusKey(bn))));
    add.title = 'Registrar uma compra feita fora do app';
    r.append(add);
    list.append(r);
  }
  section('Resumo');
  list.append(kv('Pontos em todos os canais', fmt(s.channels.reduce((t, c) => t + (c.points || 0), 0))));
  if (ns === 'twitch') { list.append(kv('Ganhos hoje', `+${fmt(s.today || 0)}`)); list.append(kv('Baús pegos hoje', fmt(s.chestsToday || 0))); }
  col.append(list);
  return col;
}

// ---------- Chat ----------
function appendContent(ns, parent, content) {
  const re = /\[emote:([A-Za-z0-9_]+):([^\]]*)\]/g;
  let last = 0, m;
  while ((m = re.exec(content))) {
    if (m.index > last) parent.append(content.slice(last, m.index));
    const img = el('img', 'emote'); img.src = P[ns].emote(m[1]); img.alt = img.title = m[2];
    parent.append(img);
    last = re.lastIndex;
  }
  if (last < content.length) parent.append(content.slice(last));
}
const GIVEAWAY = /\b(sorteio|sorteando|giveaway|!sorteio|!giveaway|!sortear)\b/i;
function chatNode(ns, data) {
  const me = S[ns] && S[ns].username && S[ns].username.toLowerCase();
  const text = String(data.content || '');
  const mention = !!me && (data.sender.username || '').toLowerCase() !== me && new RegExp(`(^|[^a-z0-9_])@?${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i').test(text);
  const r = el('div', `msg${mention ? ' mention' : ''}${GIVEAWAY.test(text) ? ' giveaway' : ''}`);
  r.append(el('time', null, timeStr(data.created_at || Date.now())));
  const id = (data.sender && data.sender.identity) || {};
  for (const b of id.badges || []) r.append(el('span', `bdg ${b.type}`, b.text || b.type));
  const u = el('span', 'u', data.sender ? data.sender.username : '?'); u.style.color = id.color || '#c9b6ff';
  r.append(u, ': ');
  appendContent(ns, r, text);
  return r;
}
const sysMsg = (t) => { const r = el('div', 'msg system'); r.append(el('time', null, timeStr(Date.now())), t); return r; };
function pushMsg(ns, slug, node) {
  const buf = chat[ns].get(slug) || [];
  buf.push(node);
  const limit = slug === view[ns].active && page === ns ? MAX_MSG : MAX_BG;
  while (buf.length > limit) buf.shift().remove();
  chat[ns].set(slug, buf);
  if (page === ns && view[ns].active === slug) {
    const box = $(`#page-${ns} .msgs`);
    if (!box) return;
    if (box.firstChild && box.firstChild.classList.contains('system') && buf.length === 1) box.replaceChildren();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.append(node);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}

// ---------- Gaveta de ajustes da plataforma ----------
function sw(checked, onchange) {
  const l = el('label', 'switch'); const i = el('input'); i.type = 'checkbox'; i.checked = !!checked;
  i.onchange = () => onchange(i.checked); l.append(i, el('span', 'ui')); return l;
}
function rowOpt(title, help, control, rec) {
  const r = el('div', 'row'); const t = el('div', 'txt'); const b = el('b', null, title);
  if (rec) b.append(el('span', 'rec', 'recomendado'));
  t.append(b, el('small', null, help)); r.append(t, control); return r;
}
function openDrawer(ns) {
  const s = S[ns];
  const card = $('#drawer-card');
  card.replaceChildren();
  card.style.setProperty('--c', ns === 'twitch' ? 'var(--tw)' : 'var(--kk)');
  const set = (k) => async (v) => apply(ns, await call(`${ns}:${k}:set`, v));
  card.append(el('h3', null, `Ajustes da ${P[ns].name}`), el('p', 'sub', 'Tudo aqui é escolha sua. O que estiver desligado não gasta nada.'));
  card.append(rowOpt('Foco em bônus', 'As lives vão para os canais mais perto do próximo bônus. Subs vêm primeiro.', sw(s.rotation, set('rotation')), true));
  const n = el('input'); n.type = 'number'; n.min = 1; n.max = 10; n.value = s.maxWatchers; n.style.width = '64px';
  n.onchange = async () => apply(ns, await call(`${ns}:maxWatchers:set`, Number(n.value)));
  card.append(rowOpt('Lives ao mesmo tempo', 'Padrão: 2. Mais que isso gasta memória e costuma não render mais pontos.', n));
  card.append(rowOpt('Modo leve (160p)', 'Lives ocultas sem imagem nem qualidade alta.', sw(s.lowQuality, set('lowQuality')), true));
  if (ns === 'twitch') {
    card.append(rowOpt('Pegar baú sozinho 🎁', 'O app clica no baú de +50 quando ele aparece. Não gasta pontos.', sw(s.autoChest, set('autoChest')), true));
    card.append(rowOpt('Avisar baú', 'Com o automático desligado: avisa para você clicar.', sw(s.notifyChest, set('notifyChest'))));
  }
  card.append(rowOpt('Avisar bônus', 'Quando um canal alcança o preço do bônus.', sw(s.notifyBonus, set('notifyBonus'))));
  card.append(rowOpt('Menções e sorteios', 'Destaque no chat e aviso com a janela escondida.', sw(s.notifyChat, set('notifyChat'))));
  const g = el('select');
  for (const [v, l] of [['watching', 'Só nas lives tocando'], ['always', 'Em todos os canais'], ['never', 'Não mostrar']]) { const o = el('option', null, l); o.value = v; g.append(o); }
  g.value = s.gainDisplay || 'watching';
  g.onchange = async () => apply(ns, await call(`${ns}:gainDisplay:set`, g.value));
  card.append(rowOpt('Pontos ganhos (+X)', 'Zera quando você gasta pontos no canal e na virada do dia.', g));
  card.append(rowOpt('Zerar os +X', 'Recomeça os números de todos os canais.', button('↺ Zerar', null, async () => apply(ns, await call(`${ns}:gains:reset`)))));
  const acc = el('div', 'actions'); acc.style.justifyContent = 'space-between';
  acc.append(s.loggedIn ? button('Sair da conta', null, async () => apply(ns, await call(`${ns}:logout`))) : button(P[ns].login, 'primary', () => call(`${ns}:login:show`)),
    button('Desligar a ' + P[ns].name, 'ghost', () => { closeDrawer(); setPlatform(ns, false); }));
  card.append(acc);
  $('#drawer').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; if (page === 'poke') renderPoke(); }
$('#drawer').onclick = (e) => { if (e.target.id === 'drawer') closeDrawer(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
window.addEventListener('resize', () => { if (page === 'poke') pokeView($('#drawer').hidden && $('#modal').hidden); });

// ---------- Ajustes do app ----------
function renderSettings() {
  const box = $('#settings-app');
  const a = S.app; if (!a) return;
  box.replaceChildren();
  box.append(rowOpt('Twitch', 'Lives, pontos, baú e chat da Twitch.', sw(a.platforms.twitch, (v) => setPlatform('twitch', v))));
  box.append(rowOpt('Kick', 'Lives, pontos e chat da Kick.', sw(a.platforms.kick, (v) => setPlatform('kick', v))));
  box.append(rowOpt(a.platform === 'linux' ? 'Iniciar com o sistema' : 'Iniciar com o Windows', 'Abre direto na bandeja, perto do relógio.', sw(a.openAtLogin, async (v) => { S.app = await call('app:autostart', v); renderSettings(); })));
  box.append(rowOpt('Versão', `Idleterino ${a.version}`, button('Sair do app', null, () => call('app:quit'))));
  // Segurança: o que o app faz para proteger os logins, e como apagar tudo.
  const sec = el('div', 'card security');
  sec.append(el('h3', null, '🔒 Segurança das suas contas'));
  const ul = el('ul');
  for (const t of [
    'Você faz login nas páginas oficiais (Google, Discord, Twitch, Kick, PokeIdle). O app nunca lê nem guarda a sua senha.',
    'Os logins ficam só neste PC, criptografados pelo Windows. Não existe servidor do Idleterino.',
    'Cada conta tem a sua sessão separada: uma não enxerga a outra.',
    'Só os sites do jogo e das páginas de login abrem dentro das contas. Downloads de programas são bloqueados.',
    'O app confere a própria integridade ao abrir: uma cópia alterada por terceiros não roda.',
    'Baixe o Idleterino só pelo site oficial ou pelo GitHub.',
  ]) ul.append(el('li', null, t));
  sec.append(ul, button('Apagar todos os logins deste PC', null, async () => { if (await call('app:wipeLogins')) toast('Logins apagados. Entre de novo quando quiser.'); }));
  box.append(sec);
}
async function setPlatform(ns, on) { S.app = await call('app:platform', ns, on); refreshAll(); }

// ---------- PokeIdle ----------
const MODE_INFO = {
  cena: ['Cena', 'O jogo completo, com a batalha na tela.'],
  otimizado: ['Otimizado', 'Sem animações de golpe e números de dano.'],
  economia: ['Economia', 'Sem a cena: só estatísticas e capturas.'],
  ultra: ['ULTRA', 'Só uma caixa com os números. Gasta ~30% menos memória e quase nada de CPU.'],
};
const kindOfAtivo = (a, k) => (a.info && a.info.ativos || []).find((x) => x.kind === k);
// Sigla da conta (ex.: "Principal" → PR, "Alt 1" → A1, "Conta 2" → C2).
function accInitials(a) {
  const n = String(a.name || '').trim();
  const d = (n.match(/\d+/) || [''])[0];
  const letters = n.replace(/[^\p{L}]/gu, '');
  return ((d ? letters.slice(0, 1) + d : letters.slice(0, 2)) || '?').toUpperCase().slice(0, 3);
}
function accTags(a) {
  const tags = el('div', 'acc-tags');
  const m = el('span', `mtag${a.effectiveMode === 'ultra' ? ' ultra' : ''}`, MODE_INFO[a.effectiveMode][0]);
  if (a.effectiveMode !== a.mode) m.title = 'ULTRA automático porque a conta está no fundo';
  tags.append(m);
  if (a.frozen) tags.append(el('span', 'mtag frozen', '❄ congelada'));
  const now = Date.now();
  for (const [k, cls, label] of [['twitch', 'tw', 'Twitch'], ['kick', 'kk', 'Kick']]) {
    const b = kindOfAtivo(a, k);
    if (b && b.end && b.end > now) { const t = el('span', `mtag ${cls}`, `${label} ${clock(b.end - now)}`); t.title = b.title; tags.append(t); }
  }
  return tags;
}
function accCard(a, onclick, active) {
  const c = el('div', `acc${active ? ' active' : ''}`);
  const i = a.info || {};
  const top = el('div', 'acc-top');
  const nick = i.logged && i.nick && i.nick !== '—' ? i.nick : a.name;
  top.append(el('b', null, nick), el('span', 'lvl', i.logged && i.level ? `Nv ${i.level.replace(/\D+/g, '')}` : ''));
  const sub = el('div', 'acc-sub', !a.isPoke ? a.host : !a.info ? 'carregando…' : !i.logged ? 'entre na conta do jogo' : [i.xpH && `${i.xpH}`, i.where].filter(Boolean).join(' · ') || a.name);
  c.append(top, sub, accTags(a));
  c.title = [nick, sub.textContent].filter(Boolean).join(' · ');
  c.onclick = onclick;
  return c;
}

let pokeStageRect = null;
let pokeGrid = (() => { try { return localStorage.getItem('pokeGrid') === '1'; } catch { return false; } })();
let pokeGridMain = (() => { try { return localStorage.getItem('pokeGridMain') === '1'; } catch { return false; } })(); // principal junto no "Ver juntas"
let pokeExpanded = (() => { try { return localStorage.getItem('pokeExpanded') === '1'; } catch { return false; } })();
function renderPoke() {
  const root = $('#page-poke');
  const s = S.poke;
  root.replaceChildren();
  const top = el('div', 'ptop');
  const h = el('h1'); h.append(el('i'), 'PokeIdle'); top.append(h);
  if (!s) { root.append(top, emptyBox('Carregando…', '')); return pokeView(false); }
  const chip = el('span', 'chip'); chip.append(el('b', null, `${s.pokeCount}/${s.max}`), 'contas do PokeIdle'); top.append(chip, el('span', 'spacer'));
  const alts = s.accounts.filter((x) => x.id !== s.mainId);
  if (s.accounts.length > 1) {
    const g = button(pokeGrid ? '▢ Ver uma por vez' : '▦ Ver juntas', pokeGrid ? 'on' : null, () => { pokeGrid = !pokeGrid; try { localStorage.setItem('pokeGrid', pokeGrid ? '1' : '0'); } catch {} renderPoke(); });
    g.title = pokeGrid ? 'Voltar a ver uma conta por vez' : 'Mostra as contas lado a lado';
    top.append(g);
    if (pokeGrid) {
      const pm = button(pokeGridMain ? '★ Principal junto' : '★ Principal separada', pokeGridMain ? 'on' : null, () => { pokeGridMain = !pokeGridMain; try { localStorage.setItem('pokeGridMain', pokeGridMain ? '1' : '0'); } catch {} renderPoke(); });
      pm.title = pokeGridMain ? 'A principal aparece junto com as ALTs. Clique para deixá-la sozinha.' : 'A principal aparece sozinha (as ALTs ficam juntas). Clique para ver a principal junto com as ALTs.';
      top.append(pm);
    }
  }
  const ot = button('⚡ Otimizar todas', null, async () => { toast('Otimizando: cada conta fecha e abre de novo (uns segundos cada). O login continua salvo.'); S.poke = await call('poke:optimizeAll'); renderPoke(); });
  ot.title = 'Fecha e abre cada conta num processo novo: libera a memória e a CPU acumuladas com horas aberto. Não perde o login nem a contagem da sessão.';
  top.append(ot);
  const prc = button('🏷 Precificador', null, () => call('app:tool:open', 'precificador'));
  prc.title = 'Quanto pedir por um Pokémon, pelas vendas recentes do mercado (ferramenta do briaoale)';
  top.append(prc, button('⚙ Ajustes', null, openPokeDrawer));
  if (!s.accounts.length) {
    root.append(top, emptyBox('Adicione sua primeira conta', 'Cada conta tem a sua sessão e o modo de tela que você escolher. O PokeIdle permite até 4 contas por pessoa.', button('＋ Adicionar conta', 'primary', addAccount)));
    return pokeView(false);
  }
  const body = el('div', 'poke-body');
  const list = el('div', 'acc-list');
  const toggleList = () => { pokeExpanded = !pokeExpanded; try { localStorage.setItem('pokeExpanded', pokeExpanded ? '1' : '0'); } catch {} renderPoke(); };
  if (pokeExpanded) {
    // Recolhida: a lista some e as contas viram chips com o nome na linha do título
    // (como os streamers no Kickterino). O jogo fica com a largura toda.
    const strip = el('div', 'acc-strip');
    const open = button('»', 'rail-toggle', toggleList); open.title = 'Abrir a lista de contas';
    strip.append(open);
    const now = Date.now();
    for (const x of s.accounts) {
      const i = x.info || {};
      const nick = i.logged && i.nick && i.nick !== '—' ? i.nick : x.name;
      const b = button('', `acc-chip${x.id === s.selected ? ' on' : ''}${x.id === s.mainId ? ' main' : ''}${x.frozen ? ' frozen' : ''}`, async () => { S.poke = await call('poke:select', x.id); renderPoke(); });
      b.append(el('i', `dot ${!i.logged ? 'off' : x.frozen ? 'frz' : 'ok'}`), `${x.id === s.mainId ? '★ ' : ''}${nick}`);
      if (['twitch', 'kick'].some((k) => { const v = kindOfAtivo(x, k); return v && v.end && v.end > now; })) b.append(el('i', 'dot bonus'));
      b.title = [nick, x.id === s.mainId ? 'Principal' : 'ALT', (MODE_INFO[x.effectiveMode] || [x.effectiveMode])[0], i.logged && i.level ? `Nv ${i.level.replace(/\D+/g, '')}` : 'entre na conta do jogo', x.frozen ? 'congelada' : ''].filter(Boolean).join(' · ');
      strip.append(b);
    }
    if (s.accounts.length < s.maxWindows) { const add = button('＋', 'acc-chip add', addAccount); add.title = 'Adicionar conta'; strip.append(add); }
    chip.after(strip);
  } else {
    const hd = el('div', 'acc-hd'); hd.append(el('span', null, 'Contas'));
    const close = button('«', 'rail-toggle', toggleList); close.title = 'Recolher a lista: as contas viram chips no topo e o jogo fica com a largura toda';
    hd.append(close); list.append(hd);
    for (const a of s.accounts) {
      const c = accCard(a, async () => { S.poke = await call('poke:select', a.id); renderPoke(); }, a.id === s.selected);
      if (a.id === s.mainId) { const tg = c.querySelector('.acc-tags'); if (tg) tg.prepend(el('span', 'mtag main', '★ Principal')); }
      list.append(c);
    }
    if (s.accounts.length < s.maxWindows) list.append(button('＋ Adicionar conta', 'acc-add', addAccount));
  }
  const a = s.accounts.find((x) => x.id === s.selected) || s.accounts[0];
  const wrap = el('div', 'stage-wrap');
  const bar = el('div', 'stage-bar');
  const name = el('span', 'name', a.info && a.info.logged && a.info.nick && a.info.nick !== '—' ? `${a.info.nick} · ${a.name}` : a.name); name.title = 'Clique duas vezes para renomear';
  name.ondblclick = () => renameAccount(a);
  const seg = el('div', 'seg');
  if (!a.isPoke) seg.hidden = true;
  for (const [m, [label, help]] of Object.entries(MODE_INFO)) {
    const b = button(label, a.mode === m ? 'on' : '', async () => { S.poke = await call('poke:mode', a.id, m); renderPoke(); });
    b.title = help + (m === 'ultra' ? ' Recomendado para as contas que você não está olhando.' : '');
    if (m === 'ultra') b.append(el('span', 'star', '★'));
    seg.append(b);
  }
  const star = button(a.id === s.mainId ? '★' : '☆', a.id === s.mainId ? 'ghost main-on' : 'ghost', async () => { if (a.id !== s.mainId) { S.poke = await call('poke:main', a.id); renderPoke(); } });
  star.title = a.id === s.mainId ? 'Esta é a sua conta principal: ela aparece sempre sozinha' : 'Marcar esta conta como a principal (as outras viram ALTs)';
  bar.append(name, star, seg, el('span', 'spacer'));
  // Painel das extensões (ex.: o Cockpit do Rotom Sniper), aberto na sessão desta conta.
  for (const x of (S.ext || []).filter((x) => x.enabled && x.hasPanel)) {
    const b = button(`🧩 ${x.name.split(/\s[-–—|]\s/)[0].slice(0, 18)}`, null, async () => { const r = await call('poke:ext:open', x.id, a.id, a.info && a.info.nick && a.info.nick !== '—' ? a.info.nick : a.name); if (r && r.error) toast(`⚠ ${r.error}`); });
    b.title = `Abrir o painel de ${x.name} para esta conta`;
    bar.append(b);
  }
  if (!S.ext) call('poke:ext:list').then((l) => { S.ext = l; if (l.some((x) => x.enabled && x.hasPanel)) renderPoke(); });
  // Zoom do jogo: diminuir abre o layout largo (mercado/RMT com a barra de busca, mais colunas).
  const zoom = el('div', 'seg zoom');
  const z = a.zoom || 1;
  const zb = (label, nz, tip) => { const b = button(label, '', async () => { S.poke = await call('poke:zoom', a.id, nz); renderPoke(); }); b.title = tip; return b; };
  const zv = button(`${Math.round(z * 100)}%`, '', async () => { S.poke = await call('poke:zoom', a.id, 1); renderPoke(); });
  zv.title = 'Zoom do jogo nesta conta. Clique para voltar a 100%. Também dá para usar Ctrl + rodinha do mouse dentro do jogo.';
  zoom.append(zb('−', z - 0.1, 'Diminuir: cabe mais coisa na tela (bom para o mercado)'), zv, zb('+', z + 0.1, 'Aumentar'));
  if (!a.isPoke) zoom.hidden = true;
  bar.append(zoom);
  if (a.isPoke) {
    const ob = button(`⚡ Otimizar${a.memMB ? ` · ${a.memMB} MB` : ''}`, a.memMB > 700 ? 'warn' : null, async () => { toast('Otimizando: a conta fecha e abre de novo (uns segundos). O login continua salvo.'); S.poke = await call('poke:optimize', a.id); renderPoke(); });
    const last = (a.optLog || [])[0];
    ob.title = [`Memória desta conta agora: ${a.memMB || '—'} MB.`, 'Otimizar fecha e abre a conta num processo novo: libera a memória acumulada. Não perde o login nem a contagem da sessão.',
      a.optNext ? `Otimizar sozinho: próxima em ${clock(Math.max(0, a.optNext - Date.now()))}.` : 'Otimizar sozinho: desligado (Ajustes do PokeIdle).',
      last ? `Última: ${timeStr(last.t)} (${last.motivo}${last.mb ? `, estava com ${last.mb} MB` : ''}).` : ''].filter(Boolean).join('\n');
    bar.append(ob);
  }
  bar.append(button(a.frozen ? '☀ Descongelar' : '❄ Congelar', null, async () => { S.poke = await call(a.frozen ? 'poke:unfreeze' : 'poke:freeze', a.id); renderPoke(); }));
  bar.append(button(a.muted ? '🔇' : '🔊', 'ghost', async () => { S.poke = await call('poke:mute', a.id, !a.muted); renderPoke(); }));
  bar.append(button('↻', 'ghost', () => call('poke:reload', a.id)));
  const remove = button('✕', 'ghost', () => confirmRemove(a)); remove.title = 'Remover a conta deste app'; bar.append(remove);
  const stage = el('div'); stage.id = 'poke-stage';
  const juntas = pokeGridMain ? [...s.accounts.filter((x) => x.id === s.mainId), ...alts] : alts;
  if (pokeGrid && juntas.length > 1 && (pokeGridMain || a.id !== s.mainId)) {
    // Modo juntas: uma coluna por conta (até 4 por linha), com o nome em cima. Clicar no nome escolhe
    // a conta que a barra de cima controla.
    stage.classList.add('grid');
    stage.style.setProperty('--cols', Math.min(4, Math.ceil(juntas.length / Math.ceil(juntas.length / 4))));
    for (const x of juntas) {
      const t = el('div', `tile${x.id === a.id ? ' on' : ''}`);
      const i = x.info || {};
      const hd = el('div', 'tile-hd');
      hd.append(el('b', null, `${x.id === s.mainId ? '★ ' : ''}${i.logged && i.nick && i.nick !== '—' ? i.nick : x.name}`), el('span', `mtag ${x.effectiveMode === 'ultra' ? 'ultra' : ''}`, (MODE_INFO[x.effectiveMode] || [x.effectiveMode])[0]));
      if (i.logged && i.level) hd.append(el('span', 'lvl', `Nv ${i.level.replace(/\D+/g, '')}`));
      hd.title = 'Clique para controlar esta conta pela barra de cima';
      hd.onclick = async () => { S.poke = await call('poke:select', x.id); renderPoke(); };
      const bd = el('div', 'tile-bd'); bd.dataset.id = x.id;
      if (x.frozen) {
        const f = el('div', 'frozen-shot');
        if (x.frozenImg) { const img = el('img'); img.src = x.frozenImg; f.append(img); }
        f.append(el('div', 'pill', '❄ Congelada · clique'));
        f.onclick = async () => { S.poke = await call('poke:unfreeze', x.id); renderPoke(); };
        bd.append(f);
      }
      t.append(hd, bd);
      stage.append(t);
    }
  } else if (a.frozen) {
    const f = el('div', 'frozen-shot');
    if (a.frozenImg) { const img = el('img'); img.src = a.frozenImg; f.append(img); }
    f.append(el('div', 'pill', '❄ Conta congelada — continua caçando. Clique para voltar.'));
    f.onclick = async () => { S.poke = await call('poke:unfreeze', a.id); renderPoke(); };
    stage.append(f);
  }
  wrap.append(bar, stage);
  body.classList.toggle('expanded', pokeExpanded);
  if (pokeExpanded) body.append(wrap); else body.append(list, wrap);
  root.append(top, body);
  requestAnimationFrame(() => pokeView(page === 'poke' && $('#drawer').hidden && $('#modal').hidden));
}
// Diz ao app onde a conta aparece (o jogo fica por cima da tela, nesse retângulo).
function pokeView(visible) {
  const st = $('#poke-stage');
  const r = st && visible ? st.getBoundingClientRect() : null;
  let tiles = null;
  if (st && visible && st.classList.contains('grid')) {
    tiles = {};
    for (const b of st.querySelectorAll('.tile-bd')) { const q = b.getBoundingClientRect(); tiles[b.dataset.id] = { x: q.left, y: q.top, width: q.width, height: q.height }; }
  }
  call('poke:view', !!(visible && r), r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null, tiles);
}
function addAccount() {
  pokeView(false);
  const card = $('#modal-card');
  const input = el('input'); input.type = 'text'; input.placeholder = 'Ex.: Principal, ALT 1…'; input.style.width = '100%';
  const url = el('input'); url.type = 'text'; url.value = (S.poke && S.poke.defaultUrl) || 'https://pokeidle.io/app'; url.style.width = '100%'; url.style.marginTop = '8px';
  url.title = 'Endereço da página onde você joga. Padrão: https://pokeidle.io/app';
  const err = el('p', 'warn-google'); err.hidden = true;
  card.replaceChildren(el('h3', null, 'Nova conta do PokeIdle'),
    el('p', null, 'Dê um nome para reconhecer a conta e confira o endereço do jogo. Depois é só entrar no jogo nela, como no navegador. Cada conta fica com o login separado.'), input, url,
    el('p', null, 'Lembrete: o PokeIdle permite até 4 contas por pessoa. Se a conta estiver aberta em outro lugar (navegador, IdleDeck), ela cai lá quando entrar aqui.'),
    el('p', 'warn-google', '⚠ Entre com Discord ou com e-mail e senha. O Google bloqueia login dentro de apps ("Não foi possível fazer o login"), então contas criadas só com Gmail não entram aqui.'));
  const actions = el('div', 'actions');
  actions.append(button('Cancelar', null, closeModal), button('Adicionar', 'primary', async () => {
    const res = await call('poke:add', input.value.trim(), url.value.trim());
    if (res.error) { err.textContent = res.error; err.hidden = false; return; }
    S.poke = res; closeModal(); go('poke');
  }));
  card.append(err, actions);
  $('#modal').hidden = false; input.focus();
}
function renameAccount(a) {
  pokeView(false);
  const card = $('#modal-card');
  const input = el('input'); input.type = 'text'; input.value = a.name; input.style.width = '100%';
  card.replaceChildren(el('h3', null, 'Renomear conta'), input);
  const actions = el('div', 'actions');
  actions.append(button('Cancelar', null, closeModal), button('Salvar', 'primary', async () => { closeModal(); S.poke = await call('poke:rename', a.id, input.value.trim()); renderPoke(); }));
  card.append(actions);
  $('#modal').hidden = false; input.focus(); input.select();
}
function confirmRemove(a) {
  pokeView(false);
  const card = $('#modal-card');
  card.replaceChildren(el('h3', null, `Remover ${a.name}?`), el('p', null, 'A conta sai deste app e o login dela é apagado deste PC. A conta no jogo continua existindo normalmente.'));
  const actions = el('div', 'actions');
  actions.append(button('Cancelar', null, closeModal), button('Remover', 'primary', async () => { closeModal(); S.poke = await call('poke:remove', a.id); renderPoke(); }));
  card.append(actions);
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; if (page === 'poke') renderPoke(); }
function openPokeDrawer() {
  pokeView(false);
  const s = S.poke;
  const card = $('#drawer-card');
  card.replaceChildren(el('h3', null, 'Ajustes do PokeIdle'), el('p', 'sub', 'O app sugere, você decide. O modo de cada conta fica na barra em cima do jogo.'));
  card.append(rowOpt('ULTRA automático no fundo', 'As contas que você não está olhando passam para o ULTRA sozinhas e voltam ao seu modo quando você abre. Medido: ~30% menos memória e quase nada de CPU.',
    sw(s.autoBackgroundUltra, async (v) => { S.poke = await call('poke:autoBackgroundUltra', v); }), true));
  const f = el('select');
  for (const [v, l] of [[0, 'Desligado'], [5, 'Depois de 5 min'], [15, 'Depois de 15 min'], [30, 'Depois de 30 min']]) { const o = el('option', null, l); o.value = v; f.append(o); }
  f.value = String(s.autoFreezeMin || 0);
  f.onchange = async () => { S.poke = await call('poke:autoFreezeMin', Number(f.value)); };
  card.append(rowOpt('Congelar ALTs sozinho', 'Contas que você não abre há algum tempo ficam congeladas: seguem caçando, e a tela só volta quando você clicar.', f));
  const o = el('select');
  for (const [v, l] of [[0, 'Desligado'], [30, 'A cada 30 min'], [60, 'A cada 1 h'], [120, 'A cada 2 h'], [300, 'A cada 5 h']]) { const op = el('option', null, l); op.value = v; o.append(op); }
  o.value = String(s.optimizeEvery || 0);
  o.onchange = async () => { S.poke = await call('poke:optimizeEvery', Number(o.value)); };
  card.append(rowOpt('Otimizar sozinho', 'Com horas aberta, a página do jogo vai acumulando memória e CPU (mesmo no modo Economia). O app fecha e abre cada conta num processo novo de tempos em tempos, uma por vez. Não perde o login nem a contagem da sessão; se você estiver mexendo na conta, ele espera.', o, true));
  $('#drawer').hidden = false;
}

// Meta de XP: XP total do nível L (a mesma conta do jogo: 50 × (L² − 3L + 4) por nível).
const xpTotal = (L) => (L <= 1 ? 0 : Math.round((50 / 3) * (L ** 3 - 6 * L ** 2 + 17 * L - 12)));
const longDur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); if (m < 60) return `${m} min`; const h = Math.floor(m / 60); if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`; return `${Math.floor(h / 24)}d ${h % 24}h`; };
const BOOST_NAMES = { vip: 'VIP', passe: 'Passe', passeVip: 'Passe', twitch: 'Twitch', kick: 'Kick', guild: 'Guild', guildBoost: 'Guild', evento: 'Evento', atrasados: 'Atrasados', item: 'Boost', raid: 'Raid', sacrificio: 'Sacrifício' };
// Quanto falta para o próximo nível e para o nível que libera a próxima hunt.
// Leva em conta os bônus de XP de treinador e quando cada um acaba (o jogo manda os dois): o XP/h
// medido na sessão é dividido pelo bônus de agora (= ritmo sem bônus) e a conta anda no tempo,
// tirando cada bônus quando ele vence (o "atrasados" vale até o nível-alvo dele).
function metaOf(a, xpH, hunts) {
  const i = a.info || {};
  const L = Number(String(i.level || '').replace(/\D+/g, ''));
  if (!L || !(xpH > 0)) return null;
  const m = /([\d.]+)\s*\/\s*([\d.]+)/.exec(i.xp || '');
  const start = xpTotal(L) + (m ? Number(m[1].replace(/\./g, '')) : 0);
  const t0 = Date.now();
  const bx = i.bonusXp;
  const parts = bx ? bx.partes.filter((p) => !(p.ate > 0) || p.ate > t0) : [];
  const prod = (list) => list.reduce((x, p) => x * (p.tr || 1), 1);
  const rest = bx ? (bx.tr / Math.max(1e-9, prod(bx.partes))) : 1; // parte que o jogo não detalha: fica valendo
  const restF = Math.abs(rest - 1) < 1e-4 ? 1 : rest;
  const multAt = (t, xp) => restF * prod(parts.filter((p) => (!(p.ate > 0) || p.ate > t) && !(p.id === 'atrasados' && p.alvo && xp >= xpTotal(p.alvo))));
  const nowMult = multAt(t0, start);
  const base = xpH / Math.max(1e-9, nowMult); // XP/h sem bônus
  const eta = (target) => {
    const goal = xpTotal(target);
    let t = t0, xp = start;
    for (let k = 0; k < 60 && xp < goal; k++) {
      const rate = (base * multAt(t, xp)) / 3600000; // XP por ms
      if (!(rate > 0)) return Infinity;
      let dt = (goal - xp) / rate;
      for (const p of parts) {
        if (p.ate > t && p.ate - t < dt) dt = p.ate - t;
        if (p.id === 'atrasados' && p.alvo) { const g = xpTotal(p.alvo); if (g > xp && (g - xp) / rate < dt) dt = (g - xp) / rate; }
      }
      xp += rate * dt; t += dt + 1;
    }
    return Math.max(0, t - t0);
  };
  const next = (hunts || []).find((h) => h.nivel > L);
  const ending = parts.filter((p) => p.ate > t0 && p.ate - t0 < 400 * 86400000).sort((x, y) => x.ate - y.ate)
    .map((p) => `${BOOST_NAMES[p.id] || p.id} +${Math.round((p.tr - 1) * 1000) / 10}% acaba em ${longDur(p.ate - t0)}`);
  return { L, nextMs: eta(L + 1), hunt: next ? { nome: next.nome, nivel: next.nivel, ms: eta(next.nivel) } : null,
    boost: bx ? Math.round((nowMult - 1) * 1000) / 10 : null, ending };
}
// Sugestão de hunt (vem da página do jogo: as contas do jogo + AoE, bicicleta e efetividade).
// Duas opções: a que dá MAIS XP e a que dá MAIS OURO (descontando o risco de gastar poção). O "quanto
// a mais" é relativo à hunt em que a conta está, calibrado com o que ela rende de verdade na sessão.
function huntSugg(hr, f) {
  if (!hr || !hr.top || !hr.top.length) return null;
  const cur = hr.atualEst;
  const bestXp = hr.top[0];
  const bestOuro = (hr.topOuro && hr.topOuro[0]) || bestXp;
  const ganho = (a, b) => (b > 0 ? Math.round((a / b - 1) * 100) : null);
  const kx = f && cur && cur.xpH > 0 ? f.xp / cur.xpH : null;
  const kg = f && cur && cur.goldLiq > 0 ? f.gold / cur.goldLiq : null;
  const est = (v, k) => (k ? `≈ ${(v * k / 1e6).toFixed(1).replace('.', ',')}M` : '');
  const risco = (h) => (h.risco >= 2 ? 'gasta muita poção' : h.risco >= 1.3 ? 'gasta poção' : 'pouca poção');
  const tip = [
    `Pokémon em campo: ${hr.pokemon} (${(hr.tipos || []).join('/')})${hr.aoe ? ' · AoE' : ' · sem AoE'} · ${hr.bike ? `bike ${hr.bike} (+${Math.round(hr.vel * 100)}%)` : 'a pé'}`,
    '⚡ Mais XP:',
    ...hr.top.slice(0, 4).map((h, i) => `${i + 1}. ${h.nome} (Nv ${h.nivel}) · dano ${h.eff}× ${est(h.xpH, kx)} XP/h${cur ? ` · ${ganho(h.xpH, cur.xpH) >= 0 ? '+' : ''}${ganho(h.xpH, cur.xpH)}%` : ''} · ${risco(h)}`),
    '💰 Mais ouro (já descontando poção):',
    ...(hr.topOuro || []).slice(0, 4).map((h, i) => `${i + 1}. ${h.nome} (Nv ${h.nivel}) ${est(h.goldLiq, kg)} ouro/h${cur ? ` · ${ganho(h.goldLiq, cur.goldLiq) >= 0 ? '+' : ''}${ganho(h.goldLiq, cur.goldLiq)}%` : ''} · ${risco(h)}`),
    cur ? `Hunt atual: ${cur.nome} (dano ${cur.eff}×, ${risco(cur)})` : '',
    'Estimativa: contas do jogo + efetividade de tipo (com Z-Move), AoE, bicicleta e o quanto o seu pokémon apanha. Muda quando você troca o pokémon em campo.',
  ].filter(Boolean).join('\n');
  const opt = (h, campo) => {
    const g = cur ? ganho(h[campo], cur[campo]) : null;
    return { h, mesma: cur && cur.slug === h.slug, ganho: g != null && g > 0 ? g : null, risco: risco(h) };
  };
  return { xp: opt(bestXp, 'xpH'), ouro: opt(bestOuro, 'goldLiq'), igual: bestXp.slug === bestOuro.slug, tip,
    // compatível com o resto da tela
    best: bestXp, mesma: cur && cur.slug === bestXp.slug, ganho: (() => { const g = cur ? ganho(bestXp.xpH, cur.xpH) : null; return g != null && g > 0 ? g : null; })() };
}
function renderHomePoke() {
  const box = $('#home-poke');
  box.replaceChildren();
  box.className = 'home-poke';
  const s = S.poke;
  if (!s || !s.accounts.length) {
    box.append(el('h2', 'section', 'PokeIdle'));
    const e = el('div', 'poke-empty');
    const t = el('div'); t.append(el('b', null, 'Nenhuma conta do PokeIdle ainda'), el('span', null, 'Adicione até 4 contas e escolha o modo de cada uma: Cena, Otimizado, Economia ou ULTRA.'));
    e.append(el('div', 'empty-art', '◓'), t, button('＋ Adicionar conta', 'primary', () => { go('poke'); addAccount(); }));
    box.append(e); return;
  }
  const now = Date.now();
  const accs = s.accounts.filter((a) => a.isPoke);
  const nickOf = (a) => { const i = a.info || {}; return i.logged && i.nick && i.nick !== '—' ? i.nick : a.name; };
  const openAcc = async (a) => { S.poke = await call('poke:select', a.id); go('poke'); };
  const main = accs.find((a) => a.id === s.mainId) || accs[0];
  const alts = accs.filter((a) => a !== main);

  // ---- Lembretes ----
  const alerts = el('div', 'home-alerts');
  const ev = accs.map((a) => a.info && a.info.evento).find(Boolean);
  if (ev) { const c = el('div', 'alert ev'); c.append(el('b', null, ev.texto || 'Evento'), el('span', 'at', ev.tempo || '')); alerts.append(c); }
  for (const a of accs) {
    const v = a.vote;
    if (!v) continue;
    const left = v.at + s.voteMs - now;
    const c = el('div', `alert vote${left <= 0 ? ' ready' : ''}`);
    c.append(el('span', 'ai', left <= 0 ? '✓' : '⏱'), el('b', null, nickOf(a)), el('span', 'at', left <= 0 ? 'pode votar no TopIdle' : `vota de novo em ${clock(left)}`));
    if (left <= 0) c.append(button('Votar', 'mini', async () => { S.poke = await call('poke:vote', a.id); renderHome(); }));
    c.title = 'Contado desde a última vez que o voto foi aberto pelo app. O voto libera a cada 25h.';
    alerts.append(c);
  }
  for (const a of accs) for (const [k, label] of [['twitch', 'Twitch'], ['kick', 'Kick']]) {
    const b = kindOfAtivo(a, k);
    if (b && b.end && b.end > now && b.end - now < 30 * 60 * 1000) {
      const c = el('div', `alert bonus ${k}`); c.append(el('span', 'ai', '⏳'), el('b', null, nickOf(a)), el('span', 'at', `Bônus ${label} acaba em ${clock(b.end - now)}`)); alerts.append(c);
    }
  }
  if (!accs.some((a) => a.vote)) {
    const c = el('div', 'alert hint'); c.append(el('span', 'ai', '⏱'), el('span', 'at', 'Vote no TopIdle pelo botão do jogo: o lembrete de 25h de cada conta aparece aqui.')); alerts.append(c);
  }

  // ---- Farm ----
  const rate = (x, ms) => (ms > 0 ? Math.round((x * 3600000) / ms) : 0);
  const big = (n) => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e9 ? `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B` : a >= 1e6 ? `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e4 ? `${Math.round(n / 1e3)}k` : fmt(n); };
  const farmOf = (a) => { const x = a.info && a.info.sess; if (!x) return null; return { ms: x.ms, xp: rate(x.xpTreinador, x.ms), pxp: rate(x.xpPokemon, x.ms), gold: rate(x.gold, x.ms), ab: rate(x.abates, x.ms), cap: x.capturas, capH: rate(x.capturas, x.ms), lucroH: x.lucroH, shV: x.shVistos || 0, shC: x.shCapt || 0 }; };
  const lvl = (a) => { const i = a.info || {}; return i.logged && i.level ? `Nv ${i.level.replace(/\D+/g, '')}` : ''; };
  const statBox = (v, l, cls) => { const d = el('div', `fstat${cls ? ' ' + cls : ''}`); d.append(el('b', null, v), el('span', null, l)); return d; };

  const farm = el('div', 'home-farm');
  // Principal
  const mc = el('div', 'card farm-main');
  const mh = el('div', 'farm-hd');
  mh.append(el('span', 'star', '★'), el('b', null, nickOf(main)), el('span', 'lvl', lvl(main)), el('span', 'tagp', 'Principal'));
  mc.append(mh, accTags(main));
  const mf = farmOf(main);
  const mg = el('div', 'fstats');
  if (mf) {
    mg.append(statBox(big(mf.xp), 'XP treinador/h'), statBox(big(mf.gold), 'ouro/h', 'gold'), (mf.lucroH ? statBox(mf.lucroH, 'lucro líquido/h', 'ok') : statBox(big(mf.pxp), 'XP pokémon/h')), statBox(big(mf.ab), 'abates/h'), statBox(fmt(mf.cap), `capturas · ${mf.capH}/h`), statBox(clock(mf.ms), 'tempo de sessão'));
  } else mg.append(el('span', 'sub', 'O placar aparece quando a conta estiver caçando (o mesmo do painel "Estatísticas da sessão" do jogo).'));
  if (mf) {
    const sh = el('div', `shiny-strip${mf.shV || mf.shC ? ' tem' : ''}`);
    sh.append(el('span', 'ico', '✨'), el('span', null, 'Shinys nesta sessão'), el('b', null, fmt(mf.shV)), el('span', 'l', 'vistos'), el('b', null, fmt(mf.shC)), el('span', 'l', 'capturados'));
    mc.append(mg, sh);
  }
  if (!mg.parentNode) mc.append(mg);
  const hr = main.info && main.info.huntRank;
  const hs = huntSugg(hr, mf);
  if (hs) {
    const g = el('div', 'hunt-strip two');
    g.append(el('span', 'ico', '🧭'));
    const linha = (ico, rot, o, campo) => {
      const r = el('div', 'hs-line');
      r.append(el('span', 'hs-rot', `${ico} ${rot}`));
      if (o.mesma) r.append(el('b', null, 'você já está nela'), el('span', 'hs-sub', `(${o.h.nome})`));
      else r.append(el('b', 'hn', o.h.nome), el('span', 'hs-sub', `Nv ${fmt(o.h.nivel)} · ${o.risco}`), el('b', 'up', o.ganho ? `+${o.ganho}% ${campo}` : ''));
      return r;
    };
    const box = el('div', 'hs-box');
    if (hs.igual) box.append(linha('⭐', 'Melhor em XP e ouro:', hs.xp, 'XP'));
    else box.append(linha('⚡', 'Quer mais XP:', hs.xp, 'XP'), linha('💰', 'Quer mais ouro:', hs.ouro, 'ouro'));
    g.append(box);
    g.title = hs.tip;
    mc.append(g);
  }
  const mm = mf && metaOf(main, mf.xp, s.hunts);
  if (mm) {
    const g = el('div', 'meta-strip');
    g.append(el('span', 'ico', '🎯'), el('span', null, `Nv ${mm.L + 1} em`), el('b', null, longDur(mm.nextMs)));
    if (mm.hunt) { g.append(el('span', 'sep', '·'), el('span', null, 'próxima hunt'), el('b', 'hn', mm.hunt.nome), el('span', null, `(Nv ${fmt(mm.hunt.nivel)}) em`), el('b', null, longDur(mm.hunt.ms))); }
    if (mm.boost != null) g.append(el('span', 'bx', mm.boost > 0 ? `com XP +${String(mm.boost).replace('.', ',')}%` : 'sem bônus de XP'));
    g.title = ['No ritmo de XP/h desta sessão, já contando quando cada bônus de XP de treinador acaba.', ...mm.ending, 'Hunt liberada quando o seu nível alcança o nível da área.'].join('\n');
    mc.append(g);
  }
  mc.append(el('span', 'farm-open', 'Abrir a conta →'));
  mc.onclick = () => openAcc(main);
  farm.append(mc);
  // ALTs
  if (alts.length) {
    const ac = el('div', 'card farm-alts');
    const fs = alts.map(farmOf);
    const sum = (k) => fs.reduce((t, f) => t + (f ? f[k] : 0), 0);
    const ah = el('div', 'farm-hd'); ah.append(el('b', null, `ALTs (${alts.length})`), el('span', 'sub', 'somadas'));
    const tot = el('div', 'fstats five');
    tot.append(statBox(big(sum('xp')), 'XP treinador/h'), statBox(big(sum('gold')), 'ouro/h', 'gold'), statBox(big(sum('ab')), 'abates/h'), statBox(fmt(sum('cap')), 'capturas'), statBox(`${fmt(sum('shV'))} / ${fmt(sum('shC'))}`, '✨ shinys vistos / capt.', sum('shV') || sum('shC') ? 'shiny' : ''));
    const tbl = el('div', 'alt-rows');
    const hdr = el('div', 'alt-row hd'); for (const h of ['Conta', 'XP/h', 'Ouro/h', 'Abates/h', 'Capturas', '✨ Shinys']) hdr.append(el('span', null, h));
    tbl.append(hdr);
    alts.forEach((a, i) => {
      const f = fs[i];
      const r = el('div', 'alt-row');
      const n = el('span', 'n'); n.append(el('b', null, nickOf(a)), el('i', null, `${lvl(a)} · ${(MODE_INFO[a.effectiveMode] || [a.effectiveMode])[0]}`));
      const am = f && metaOf(a, f.xp, s.hunts);
      const ah = huntSugg(a.info && a.info.huntRank, f);
      if (ah) {
        const txt = ah.igual ? `🧭 ${ah.xp.mesma ? 'já na melhor hunt' : ah.xp.h.nome}` : `⚡ ${ah.xp.mesma ? 'atual' : ah.xp.h.nome} · 💰 ${ah.ouro.mesma ? 'atual' : ah.ouro.h.nome}`;
        if (!(ah.xp.mesma && ah.ouro.mesma)) { const t2 = el('i', 'hsug', txt); t2.title = ah.tip; n.append(t2); }
      }
      if (am) { const t = el('i', 'meta', am.hunt ? `🎯 ${am.hunt.nome} (Nv ${fmt(am.hunt.nivel)}) em ${longDur(am.hunt.ms)}` : `🎯 Nv ${am.L + 1} em ${longDur(am.nextMs)}`); t.title = [`Próximo nível (Nv ${am.L + 1}) em ${longDur(am.nextMs)}`, am.boost != null ? (am.boost > 0 ? `Bônus de XP agora: +${am.boost}%` : 'Sem bônus de XP agora') : '', ...am.ending, 'Já conta quando cada bônus acaba.'].filter(Boolean).join('\n'); n.append(t); }
      r.append(n, el('span', null, f ? big(f.xp) : '—'), el('span', 'gold', f ? big(f.gold) : '—'), el('span', null, f ? big(f.ab) : '—'), el('span', null, f ? fmt(f.cap) : '—'), el('span', f && (f.shV || f.shC) ? 'shiny' : null, f ? `${fmt(f.shV)} / ${fmt(f.shC)}` : '—'));
      r.onclick = () => openAcc(a);
      tbl.append(r);
    });
    ac.append(ah, tot, tbl);
    farm.append(ac);
  }

  // ---- Mercado ----
  const money = (v, moeda) => { const b = el('b', `mv${moeda === 'orb' ? ' orb' : ''}`); b.append(el('i', `cur ${moeda === 'orb' ? 'orb' : 'gold'}`), fmt(v)); return b; };
  const ago = (t) => { const m = Math.round((now - t) / 60000); return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
  const hhmm = (t) => (t ? new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const mk = accs.map((a) => ({ a, m: a.info && a.info.mercado })).filter((x) => x.m);
  const lastAt = Math.max(0, ...mk.flatMap((x) => [x.m.meus, x.m.vendas, x.m.global].filter(Boolean).map((y) => y.at)));

  const mhd = el('div', 'market-hd');
  mhd.append(el('h2', 'section', 'Mercado'), el('span', 'sub', lastAt ? `atualizado ${ago(lastAt)} · atualiza sozinho a cada 10 min` : 'primeira leitura 1 min depois de abrir o app'));
  const rf = button('↻ Atualizar', 'mini', async () => { S.poke = await call('poke:market:refresh'); toast('Atualizando o mercado das contas…'); });
  const pr = button('🏷 Precificador', 'mini', () => call('app:tool:open', 'precificador'));
  pr.title = 'Quanto pedir por um Pokémon, pelas vendas recentes do mercado (ferramenta do briaoale)';
  mhd.append(pr, rf);
  const grid = el('div', 'home-market');
  const panel = (title, sub) => { const p = el('div', 'card mpanel'); const h = el('div', 'mp-hd'); h.append(el('b', null, title)); if (sub) h.append(el('span', 'sub', sub)); p.append(h); return p; };
  const line = (left, right, meta, cls) => { const r = el('div', `mrow${cls ? ' ' + cls : ''}`); const l = el('div', 'ml'); l.append(left); if (meta) l.append(el('span', 'meta', meta)); r.append(l, right); return r; };
  const nameNode = (txt, shiny) => { const b = el('span', 'mn'); if (shiny) b.append(el('span', 'shiny', '✨ ')); b.append(txt); return b; };
  const empty = (t) => el('div', 'mempty', t);

  // Meus anúncios
  const p1 = panel('Meus anúncios', 'todas as contas');
  const mine = mk.flatMap(({ a, m }) => (m.meus ? m.meus.linhas.map((l) => ({ ...l, acc: nickOf(a) })) : []));
  if (!mine.length) p1.append(empty(mk.some((x) => x.m.meus) ? 'Nenhum anúncio aberto agora.' : 'Os anúncios das suas contas aparecem aqui depois da primeira leitura.'));
  for (const l of mine.slice(0, 12)) {
    const retido = l.retidoAte && l.retidoAte > now;
    const meta = [l.acc, l.qtd > 1 ? `${fmt(l.qtd)} em estoque · por unidade` : null, retido ? `retido · ${clock(l.retidoAte - now)}` : null].filter(Boolean).join(' · ');
    p1.append(line(nameNode(`${l.qtd > 1 ? `${fmt(l.qtd)}× ` : ''}${l.nome}${l.level ? ` Nv ${l.level}` : ''}`, l.shiny), money(l.preco, l.moeda), meta, retido ? 'held' : ''));
  }
  // Minhas vendas
  const p2 = panel('Suas vendas', 'mais recentes');
  const sold = mk.flatMap(({ a, m }) => (m.vendas ? m.vendas.linhas.map((l) => ({ ...l, acc: nickOf(a) })) : [])).sort((x, y) => (y.em || 0) - (x.em || 0));
  if (!sold.length) p2.append(empty(mk.some((x) => x.m.vendas) ? 'Nenhuma venda ainda.' : 'O histórico de vendas das contas aparece aqui depois da primeira leitura.'));
  for (const l of sold.slice(0, 10)) p2.append(line(nameNode(l.descricao || '—', l.shiny), money(l.bruto, l.moeda), [l.acc, l.comprador ? `para ${l.comprador}` : null, hhmm(l.em)].filter(Boolean).join(' · ')));
  // Maiores vendas
  const p3 = panel('Maiores vendas agora');
  p3.title = 'Da Tabela de preços do jogo (o ícone de prancheta no mercado).';
  const seg = el('div', 'curseg');
  for (const [k, label] of [['gold', 'Coins'], ['orb', 'Gemas']]) seg.append(button(label, homeCur === k ? 'on' : '', () => { homeCur = k; renderHome(); }));
  p3.querySelector('.mp-hd').append(seg);
  const g = mk.find((x) => x.a.id === main.id && x.m.global) || mk.find((x) => x.m.global);
  const all = g ? g.m.global.linhas.filter((l) => l.tipo !== 'deposito' && l.tipo !== 'saque') : [];
  const top = all.filter((l) => (l.moeda || 'gold') === homeCur).sort((x, y) => (y.bruto || 0) - (x.bruto || 0)).slice(0, 10);
  if (!g) p3.append(empty('As vendas do servidor aparecem aqui depois da primeira leitura (pela conta principal).'));
  else if (!top.length) p3.append(empty(`Nenhuma venda em ${homeCur === 'orb' ? 'gemas' : 'coins'} nas últimas ${all.length} do servidor.`));
  top.forEach((l, i) => p3.append(line(nameNode(`${i + 1}. ${l.descricao || '—'}`, l.shiny), money(l.bruto, l.moeda), [l.vendedor && l.comprador ? `${l.vendedor} → ${l.comprador}` : null, hhmm(l.em)].filter(Boolean).join(' · '))));
  if (g && all.length) p3.append(el('div', 'mfoot', `entre as últimas ${all.length} vendas do servidor`));
  grid.append(p1, p2, p3);

  box.append(el('h2', 'section', 'PokeIdle'));
  if (alerts.children.length) box.append(alerts);
  box.append(farm, mhd, grid);
}
let homeCur = 'gold';

// ---------- Extensões ----------
async function renderExt() {
  const root = $('#page-ext');
  if (!S.ext) S.ext = await call('poke:ext:list');
  root.replaceChildren();
  const head = el('header', 'page-head');
  const t = el('div'); t.append(el('h1', null, 'Extensões'), el('p', 'sub', 'As extensões que você já usa no PokeIdle (sniper, /hunt e outras). Valem só nas contas do jogo.'));
  const add = el('div', 'actions'); add.style.margin = '0';
  const run = async (ch) => { const r = await call(ch); if (r.error) toast(`⚠ ${r.error}`); else if (r.ok) toast('Extensão instalada. As contas recarregaram para aplicar.'); S.ext = r.list; renderExt(); };
  add.append(button('? Como instalar', 'ghost', () => openHelp('extensão')), button('📁 Instalar pasta', null, () => run('poke:ext:addFolder')), button('📦 Instalar .zip / .crx', 'primary', () => run('poke:ext:addFile')));
  head.append(t, add);
  const warn = el('div', 'card ext-warn');
  warn.append(el('b', null, '⚠ Antes de instalar'));
  const ul = el('ul');
  for (const w of [
    'Uma extensão roda dentro das suas contas do PokeIdle e consegue ver o que acontece nelas. Instale só extensões de quem você confia.',
    'Elas nunca entram nas sessões da Twitch e da Kick, onde estão esses logins.',
    'Nem toda extensão do Chrome funciona fora do navegador. As que mexem só na página do jogo costumam funcionar; as que dependem de recursos específicos do Chrome podem falhar.',
    'Respeite as regras do PokeIdle: o que o jogo não permite continua não permitido com extensão.',
  ]) ul.append(el('li', null, w));
  warn.append(ul);
  // Padrões do app: já vêm instaladas (baixadas da Chrome Web Store).
  const builtins = await call('poke:ext:builtins');
  const pad = el('div', 'card list');
  pad.append(el('div', 'ext-sec', 'Já vêm no app'));
  for (const b of builtins) {
    const inst = b.installed ? S.ext.find((e) => e.builtin && e.name.toLowerCase().includes(b.name.replace('/', '').toLowerCase())) : null;
    const r = rowOpt(`${b.name}${inst && inst.version ? ` · v${inst.version}` : ''}`, `${b.why} Baixada da Chrome Web Store e atualizada sozinha.`, el('span'));
    const tag = el('span', `ext-tag${b.installed ? ' on' : ''}`, b.installed ? 'Instalada' : b.dismissed ? 'Removida por você' : 'Baixando…');
    const ctrl = el('div'); ctrl.style.display = 'flex'; ctrl.style.gap = '10px'; ctrl.style.alignItems = 'center';
    if (inst) ctrl.append(sw(inst.enabled, async (v) => { S.ext = await call('poke:ext:toggle', inst.id, v); renderExt(); }),
      button('Remover', 'ghost', async () => { S.ext = await call('poke:ext:remove', inst.id); renderExt(); }));
    else ctrl.append(tag);
    if (!b.installed) ctrl.append(button('Instalar', 'primary', async () => { toast(`Baixando ${b.name} da Chrome Web Store…`); const res = await call('poke:ext:builtin:install', b.cws); if (res.error) toast(`⚠ ${res.error}`); else toast(`${b.name} instalada. As contas recarregaram para aplicar.`); S.ext = res.list; renderExt(); }));
    r.lastChild.replaceWith(ctrl);
    pad.append(r);
  }
  const tools = el('div', 'card list');
  tools.append(el('div', 'ext-sec', 'Ferramentas da comunidade'));
  const tr = rowOpt('🏷 Precificador de Pokémon', 'Quanto pedir em gemas por um Pokémon, a partir das vendas recentes do mercado. No jogo, abra a ficha do Pokémon, clique em "Copiar p/ ChatGPT" e cole lá. Feito pelo briaoale; abre numa janela própria, sem acesso às suas contas.', el('span'));
  tr.lastChild.replaceWith(button('Abrir', 'primary', () => call('app:tool:open', 'precificador')));
  tools.append(tr);
  const list = el('div', 'card list');
  list.append(el('div', 'ext-sec', 'Suas extensões'));
  const mine = S.ext.filter((e) => !e.builtin);
  if (!mine.length) list.append(el('div', 'empty', 'Nenhuma outra extensão. Use os botões acima para adicionar a pasta ou o arquivo de uma extensão.'));
  for (const e of mine) {
    const r = rowOpt(`${e.name}${e.version ? ` · v${e.version}` : ''}`, e.error ? `Não carregou: ${e.error}` : `${e.description || (e.mv === 3 ? 'Manifest V3' : 'Manifest V2')}${e.hasPanel && e.enabled ? ' · Painel: botão 🧩 na tela de cada conta do PokeIdle.' : ''}`, el('span'));
    const ctrl = el('div'); ctrl.style.display = 'flex'; ctrl.style.gap = '10px'; ctrl.style.alignItems = 'center';
    ctrl.append(sw(e.enabled, async (v) => { S.ext = await call('poke:ext:toggle', e.id, v); renderExt(); }),
      button('Remover', 'ghost', async () => { S.ext = await call('poke:ext:remove', e.id); renderExt(); }));
    r.lastChild.replaceWith(ctrl);
    list.append(r);
  }
  // As padrões aparecem na lista de cima; aqui ficam também (com o liga/desliga e o remover).
  root.append(head, pad, tools, list, warn);
}
window.idle.on('poke:ext:changed', (list) => { S.ext = list; if (page === 'ext') renderExt(); });

// ---------- Ajuda ----------
let helpQuery = '';
function renderHelp() {
  const root = $('#page-help');
  root.replaceChildren();
  const head = el('header', 'page-head');
  const t = el('div'); t.append(el('h1', null, 'Ajuda'), el('p', 'sub', 'As dúvidas mais comuns. Não achou? Pergunte no Discord da comunidade.'));
  const q = el('input', 'help-search'); q.type = 'text'; q.placeholder = 'Buscar: extensão, gmail, ULTRA, baú…'; q.value = helpQuery;
  q.oninput = () => { helpQuery = q.value; fill(); };
  head.append(t, q);
  const box = el('div', 'help-list');
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function fill() {
    box.replaceChildren();
    const term = norm(helpQuery.trim());
    let cat = null;
    for (const [c, question, lines] of window.HELP || []) {
      if (term && !norm(`${c} ${question} ${lines.join(' ')}`).includes(term)) continue;
      if (c !== cat) { cat = c; box.append(el('h2', 'section', c)); }
      const d = el('details', 'help-item');
      if (term) d.open = true;
      d.append(el('summary', null, question));
      const body = el('div', 'help-body');
      let ol = null;
      for (const line of lines) {
        const m = /^(\d+)\.\s+(.*)$/.exec(line);
        if (m) { if (!ol) { ol = el('ol'); body.append(ol); } ol.append(el('li', null, m[2])); }
        else { ol = null; body.append(el('p', null, line)); }
      }
      d.append(body);
      box.append(d);
    }
    if (!box.childElementCount) box.append(el('div', 'empty', 'Nada encontrado. Tente outra palavra.'));
  }
  fill();
  root.append(head, box);
  if (helpQuery) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}
// Atalho: abrir a ajuda já filtrada (ex.: botão "?" da página de extensões).
function openHelp(term) { helpQuery = term || ''; go('help'); }

// ---------- Atualizações ----------
function apply(ns, snap) { if (!snap) return; S[ns] = snap; refreshAll(); }
function toast(text) { const t = el('div', 'toast', text); $('#toasts').append(t); setTimeout(() => t.remove(), 4500); }
function refreshDots() {
  for (const ns of ['twitch', 'kick']) {
    const d = $(`#dot-${ns}`); const s = S[ns];
    d.className = 'nav-dot ' + (!S.app || !S.app.platforms[ns] ? 'off' : !s ? '' : !s.loggedIn ? 'warn' : s.channels.some((c) => c.earning === 'earning') ? 'live' : '');
  }
}
function refreshAll() {
  refreshDots();
  if (page === 'home') renderHome();
  if (page === 'settings') renderSettings();
  if (page === 'poke' && $('#drawer').hidden && $('#modal').hidden) renderPoke();
  if (P[page]) {
    // Não redesenhar enquanto a pessoa digita no chat ou na busca.
    const focus = document.activeElement;
    if (focus && focus.tagName === 'INPUT' && $(`#page-${page}`).contains(focus)) return;
    renderPlatform(page);
  }
}
for (const ns of ['twitch', 'kick']) {
  window.idle.on(`${ns}:status`, (snap) => { S[ns] = snap; refreshAll(); });
  window.idle.on(`${ns}:chat`, ({ slug, kind, data }) => {
    if (kind === 'message') pushMsg(ns, slug, chatNode(ns, data));
    else if (kind === 'reward') pushMsg(ns, slug, sysMsg(`🎁 ${data.username} resgatou "${data.reward_title}"`));
  });
  window.idle.on(`${ns}:select`, (slug) => { view[ns].active = slug; go(ns); });
}
window.idle.on('twitch:toast', toast);
window.idle.on('poke:status', (p) => { S.poke = p; refreshAll(); });
window.idle.on('poke:relayout', () => { if (page === 'poke') pokeView($('#drawer').hidden && $('#modal').hidden); });
window.idle.on('app:state', (a) => { S.app = a; refreshAll(); });
setInterval(() => { if (page === 'home') renderHome(); }, 20000);

(async () => {
  S.app = await call('app:state');
  for (const ns of ['twitch', 'kick']) { try { S[ns] = await call(`${ns}:state:get`); } catch {} }
  try { S.poke = await call('poke:state'); } catch {}
  go('home');
  refreshAll();
})();
