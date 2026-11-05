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
    rate: 2, hasChest: true,
  },
  kick: {
    name: 'Kick', letter: 'K', login: 'Entrar com a Kick',
    emote: (id) => `https://files.kick.com/emotes/${id}/fullsize`,
    bonusKey: (b) => b.cost,
    targets: () => [['0', 'Bônus automático'], ['300', '+15% XP — 300 pts'], ['500', '+15% Capture Boost — 500 pts'], ['1000', '+15% Secret Lure — 1.000 pts']],
    rate: 2, hasChest: false,
  },
};
const short = (name) => String(name).replace('+15% ', '');

// ---------- Estado ----------
const S = { app: null, twitch: null, kick: null, poke: null };
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
}
for (const b of document.querySelectorAll('.nav')) b.onclick = () => go(b.dataset.page);

// ---------- Início ----------
function renderHome() {
  const box = $('#home-platforms');
  box.replaceChildren();
  const h = new Date().getHours();
  $('#hello').textContent = h < 5 ? 'Boa madrugada 🌙' : h < 12 ? 'Bom dia ☀️' : h < 18 ? 'Boa tarde 👋' : 'Boa noite 🌙';
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
  target.value = String(s.bonusTarget || (ns === 'kick' ? 0 : ''));
  target.title = 'Bônus que o foco busca: as lives vão para os canais mais perto do preço dele';
  target.onchange = async () => apply(ns, await call(`${ns}:bonusTarget:set`, ns === 'kick' ? Number(target.value) : target.value));
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
  if (ch.earning === 'earning') sub.append(el('span', 'earn', '● ganhando'));
  else if (ch.earning === 'warming') sub.append('◌ aquecendo');
  else if (ch.earning === 'idle') sub.append('○ sem pontos');
  else sub.append(ch.live ? `${fmt(ch.viewers)} assistindo${ch.watching ? '' : ' · na fila'}` : 'offline');
  if (ch.watching && ch.goalLeft > 0) sub.append(` · ⏱ ${clock((ch.goalLeft / (P[ns].rate * (ch.multiplier || 1))) * 60000)}`);
  info.append(name, sub);
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
  const head = el('div', 'col-head'); head.append('Bônus ativos');
  const list = el('div', 'col-scroll');
  const now = Date.now();
  for (const b of s.bonuses || []) {
    const on = b.endsAt && b.endsAt > now;
    const r = el('div', `bonus${on ? ' on' : ''}`);
    r.append(el('span', 'n', short(b.name)), el('span', 'l', on ? clock(b.endsAt - now) : 'inativo'));
    const add = button('+1h', null, async () => apply(ns, await call(`${ns}:purchase:add`, P[ns].bonusKey(b))));
    add.title = 'Registrar uma compra feita fora do app';
    r.append(add);
    list.append(r);
  }
  const kv = (k, v) => { const d = el('div', 'kv'); d.append(el('span', null, k), el('b', null, v)); return d; };
  list.append(el('div', 'group', 'Resumo'));
  list.append(kv('Pontos em todos os canais', fmt(s.channels.reduce((t, c) => t + (c.points || 0), 0))));
  if (ns === 'twitch') { list.append(kv('Ganhos hoje', `+${fmt(s.today || 0)}`)); list.append(kv('Baús pegos hoje', fmt(s.chestsToday || 0))); }
  const recent = (s.purchases || []).slice(0, 4);
  if (recent.length) {
    list.append(el('div', 'group', 'Compras recentes'));
    for (const p of recent) {
      const c = s.channels.find((x) => x.slug === p.slug);
      const d = el('div', 'kv');
      d.append(el('span', null, `${ns === 'twitch' ? `${p.kind === 'xp' ? 'XP' : p.kind === 'capture' ? 'Capture' : 'Lure'} ${p.hours || 1}h` : `${fmt(p.cost)} pts`} · ${c ? c.displayName : 'à mão'}`));
      const x = button('✕', 'ghost', async () => apply(ns, await call(`${ns}:purchase:remove`, p.t)));
      x.title = 'Não foi compra de bônus? Remove do cronômetro';
      d.append(x);
      list.append(d);
    }
  }
  col.append(head, list);
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
  c.onclick = onclick;
  return c;
}

let pokeStageRect = null;
function renderPoke() {
  const root = $('#page-poke');
  const s = S.poke;
  root.replaceChildren();
  const top = el('div', 'ptop');
  const h = el('h1'); h.append(el('i'), 'PokeIdle'); top.append(h);
  if (!s) { root.append(top, emptyBox('Carregando…', '')); return pokeView(false); }
  const chip = el('span', 'chip'); chip.append(el('b', null, `${s.pokeCount}/${s.max}`), 'contas do PokeIdle'); top.append(chip, el('span', 'spacer'));
  top.append(button('⚙ Ajustes', null, openPokeDrawer));
  if (!s.accounts.length) {
    root.append(top, emptyBox('Adicione sua primeira conta', 'Cada conta tem a sua sessão e o modo de tela que você escolher. O PokeIdle permite até 4 contas por pessoa.', button('＋ Adicionar conta', 'primary', addAccount)));
    return pokeView(false);
  }
  const body = el('div', 'poke-body');
  const list = el('div', 'acc-list');
  for (const a of s.accounts) list.append(accCard(a, async () => { S.poke = await call('poke:select', a.id); renderPoke(); }, a.id === s.selected));
  if (s.accounts.length < s.maxWindows) list.append(button('＋ Adicionar conta', 'acc-add', addAccount));
  list.append(el('div', 'acc-rule', `Regra do PokeIdle: até ${s.max} contas por pessoa. Contas acima disso são removidas pelo jogo.`));
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
  bar.append(name, seg, el('span', 'spacer'));
  bar.append(button(a.frozen ? '☀ Descongelar' : '❄ Congelar', null, async () => { S.poke = await call(a.frozen ? 'poke:unfreeze' : 'poke:freeze', a.id); renderPoke(); }));
  bar.append(button(a.muted ? '🔇' : '🔊', 'ghost', async () => { S.poke = await call('poke:mute', a.id, !a.muted); renderPoke(); }));
  bar.append(button('↻', 'ghost', () => call('poke:reload', a.id)));
  const remove = button('✕', 'ghost', () => confirmRemove(a)); remove.title = 'Remover a conta deste app'; bar.append(remove);
  const stage = el('div'); stage.id = 'poke-stage';
  if (a.frozen) {
    const f = el('div', 'frozen-shot');
    if (a.frozenImg) { const img = el('img'); img.src = a.frozenImg; f.append(img); }
    f.append(el('div', 'pill', '❄ Conta congelada — continua caçando. Clique para voltar.'));
    f.onclick = async () => { S.poke = await call('poke:unfreeze', a.id); renderPoke(); };
    stage.append(f);
  }
  wrap.append(bar, stage);
  body.append(list, wrap);
  root.append(top, body);
  requestAnimationFrame(() => pokeView(page === 'poke' && $('#drawer').hidden && $('#modal').hidden));
}
// Diz ao app onde a conta aparece (o jogo fica por cima da tela, nesse retângulo).
function pokeView(visible) {
  const st = $('#poke-stage');
  const r = st && visible ? st.getBoundingClientRect() : null;
  call('poke:view', !!(visible && r), r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
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
  $('#drawer').hidden = false;
}

function renderHomePoke() {
  const box = $('#home-poke');
  box.replaceChildren();
  const s = S.poke;
  if (!s || !s.accounts.length) {
    const e = el('div', 'poke-empty');
    const t = el('div'); t.append(el('b', null, 'Nenhuma conta do PokeIdle ainda'), el('span', null, 'Adicione até 4 contas e escolha o modo de cada uma: Cena, Otimizado, Economia ou ULTRA.'));
    e.append(el('div', 'empty-art', '◓'), t, button('＋ Adicionar conta', 'primary', () => { go('poke'); addAccount(); }));
    box.className = ''; box.append(e); return;
  }
  box.className = 'home-accs';
  for (const a of s.accounts) box.append(accCard(a, async () => { S.poke = await call('poke:select', a.id); go('poke'); }, false));
}

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
