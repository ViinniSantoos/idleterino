// Idleterino — aba PvP: meta do top 50 do Ranqueado (lido do próprio jogo, uma vez por dia), sugestão
// de time com os SEUS pokémon e um planejador de equipe. Tudo é leitura: o time se monta no jogo
// ("Editar tabuleiro"); o app não mexe em nada.
//
// Como o app pesa cada pokémon contra o meta:
//  · tipos: a tabela de efetividade do jogo (com a diagonal da série), ataque = tipos da espécie + o
//    tipo do Z-Move; defesa = tipos da espécie;
//  · força: nível e poder (o "poder" que o jogo mostra), e os status base da espécie;
//  · AoE conta a favor; o alcance (corpo a corpo ou a distância) equilibra o time.

const PVP_DIAG = { FIRE: 0.5, WATER: 0.5, ELECTRIC: 0.5, GRASS: 0.5, ICE: 0.5, POISON: 0.5, PSYCHIC: 0.5, DARK: 0.5, STEEL: 0.5, GHOST: 2, DRAGON: 2 };
const TIPO_PT = { NORMAL: 'Normal', FIRE: 'Fogo', WATER: 'Água', GRASS: 'Planta', ELECTRIC: 'Elétrico', ICE: 'Gelo', FIGHTING: 'Lutador', POISON: 'Veneno', GROUND: 'Terra', FLYING: 'Voador', PSYCHIC: 'Psíquico', BUG: 'Inseto', ROCK: 'Pedra', GHOST: 'Fantasma', DRAGON: 'Dragão', DARK: 'Sombrio', STEEL: 'Aço', FAIRY: 'Fada' };
const TIPO_COR = { NORMAL: '#9fa19f', FIRE: '#e62829', WATER: '#2980ef', GRASS: '#3fa129', ELECTRIC: '#fac000', ICE: '#3dcef3', FIGHTING: '#ff8000', POISON: '#9141cb', GROUND: '#915121', FLYING: '#81b9ef', PSYCHIC: '#ef4179', BUG: '#91a119', ROCK: '#afa981', GHOST: '#704170', DRAGON: '#5060e1', DARK: '#624d4e', STEEL: '#60a1b8', FAIRY: '#ef70ef' };
let pvpData = null;
let pvpAcc = (() => { try { return localStorage.getItem('pvpAcc') || null; } catch { return null; } })();
let pvpPlan = null; // ids de espécie no planejador
let pvpBusca = '';
let pvpRetry = 0;

function pvpEff(tabela, atq, def1, def2) {
  const one = (a, d) => { if (!d) return 1; if (a === d) return PVP_DIAG[a] ?? 1; return ((tabela || {})[a] || {})[d] ?? 1; };
  let v = one(atq, def1);
  if (def2 && def2 !== def1) v *= one(atq, def2);
  return v;
}
const pvpBest = (tab, atks, defs) => Math.max(0, ...atks.map((a) => pvpEff(tab, a, defs[0], defs[1])));
const tipoChip = (t) => { const s = el('span', 'tchip', TIPO_PT[t] || t); s.style.setProperty('--tc', TIPO_COR[t] || '#777'); return s; };
const alcIcon = (a) => (a > 1 ? `${a}🏹` : '🗡️');
const statSum = (st) => (st ? st.hp + st.atk + st.def + st.spa + st.spd + st.spe : 0);
const ago2 = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `há ${m} min` : m < 48 * 60 ? `há ${Math.round(m / 60)}h` : `há ${Math.round(m / 1440)} dias`; };

// Entradas do meta: cada pokémon de cada time do top, com peso pela posição (o 1º pesa o dobro do 50º).
function pvpMetaEntries(meta) {
  const out = [];
  if (!meta) return out;
  for (const l of meta.linhas) {
    const p = meta.perfis[l.nick];
    if (!p) continue;
    const w = 1 + (51 - Math.min(50, l.pos)) / 50;
    for (const k of p.time) {
      const inf = meta.info[k.speciesId] || {};
      const tipos = inf.tipos || [];
      out.push({ ...k, pos: l.pos, nick: l.nick, w, tipos, atk: [...new Set([...tipos, k.el].filter(Boolean))], alcance: inf.alcance || 1, stats: inf.stats, nome: k.nome || inf.nome || `#${k.speciesId}` });
    }
  }
  return out;
}

// Nota de um pokémon seu contra o meta, e o porquê.
function pvpScore(c, entries, tab, refLevel) {
  let off = 0, def = 0, wsum = 0;
  const forte = new Map(), fraco = new Map();
  for (const e of entries) {
    const o = pvpBest(tab, c.atk, e.tipos);
    const d = pvpBest(tab, e.atk, c.tipos);
    off += o * e.w; def += d * e.w; wsum += e.w;
    if (o >= 2) forte.set(e.nome, Math.max(forte.get(e.nome) || 0, o));
    if (d >= 2) fraco.set(e.nome, Math.max(fraco.get(e.nome) || 0, d));
  }
  off /= wsum || 1; def /= wsum || 1;
  const lvl = Math.min(1.5, (c.level || 1) / Math.max(1, refLevel));
  const st = statSum(c.stats) / 600;
  const score = off * 1.0 - def * 0.8 + lvl * 1.4 + st * 0.5 + (c.aoe ? 0.25 : 0);
  return { score, off, def, lvl, forte: [...forte.entries()].sort((a, b) => b[1] - a[1]), fraco: [...fraco.entries()].sort((a, b) => b[1] - a[1]) };
}

function pvpMine(live, metaInfo) {
  if (!live) return [];
  const info = { ...(metaInfo || {}), ...(live.info || {}) };
  return Object.entries(live.meus || {}).map(([sid, m]) => {
    const inf = info[sid] || {};
    const tipos = inf.tipos || [];
    return { speciesId: Number(sid), nome: inf.nome || `#${sid}`, tipos, atk: [...new Set([...tipos, m.el].filter(Boolean))], el: m.el, aoe: !!m.aoe, level: m.level, alcance: inf.alcance || 1, stats: inf.stats };
  }).sort((a, b) => b.level - a.level);
}

// Time sugerido: o melhor primeiro, depois quem cobre o que o time ainda não bate forte, com alcances equilibrados.
function pvpSuggest(mine, entries, tab, refLevel) {
  const pool = mine.map((c) => ({ c, s: pvpScore(c, entries, tab, refLevel) })).sort((a, b) => b.s.score - a.s.score);
  const team = [];
  const coberto = new Set();
  while (team.length < 5 && pool.length) {
    let best = null, bestV = -1e9;
    const perto = team.filter((x) => x.c.alcance <= 1).length, longe = team.length - perto;
    for (const x of pool) {
      if (team.some((t) => t.c.speciesId === x.c.speciesId)) continue;
      const novos = x.s.forte.filter(([n]) => !coberto.has(n)).length;
      const equilibrio = (x.c.alcance <= 1 ? (perto >= 3 ? -0.6 : 0) : (longe >= 3 ? -0.6 : 0));
      const v = x.s.score + novos * 0.08 + equilibrio;
      if (v > bestV) { bestV = v; best = x; }
    }
    if (!best) break;
    team.push(best);
    for (const [n] of best.s.forte) coberto.add(n);
    pool.splice(pool.indexOf(best), 1);
  }
  return team;
}

// Casas do tabuleiro (fileiras de 6, 8, 8, 4 e 4; a 1ª é a da frente). Corpo a corpo na frente, quem
// atira mais longe mais atrás, do meio para as pontas.
const PVP_ROWS = [6, 8, 8, 4, 4];
function pvpPlace(team) {
  const ordemFila = (n) => { const mid = (n - 1) / 2; return [...Array(n).keys()].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b); };
  const usadas = new Set();
  const lugar = [];
  const linhaDe = (a) => (a <= 1 ? [0, 1, 2, 3, 4] : a === 2 ? [1, 2, 0, 3, 4] : a === 3 ? [2, 3, 1, 4, 0] : [3, 2, 4, 1, 0]);
  for (const m of team) {
    let pos = null;
    for (const r of linhaDe(m.alcance)) { for (const col of ordemFila(PVP_ROWS[r])) { const k = `${r}:${col}`; if (!usadas.has(k)) { pos = { r, col }; usadas.add(k); break; } } if (pos) break; }
    lugar.push(pos);
  }
  return lugar;
}

function pvpMemberCard(c, s, extra) {
  const card = el('div', 'pvp-mem');
  const top = el('div', 'pm-top');
  top.append(el('b', null, c.nome), el('span', 'pm-lv', `Nv ${fmt(c.level)}`), el('span', 'pm-alc', alcIcon(c.alcance)));
  const tags = el('div', 'pm-tags');
  for (const t of c.tipos) tags.append(tipoChip(t));
  if (c.el) { const z = el('span', 'zchip', `Z ${TIPO_PT[String(c.el).toUpperCase()] || c.el}`); z.title = 'Z-Move: dá um tipo de ataque a mais'; tags.append(z); }
  if (c.aoe) tags.append(el('span', 'aoechip', 'AoE'));
  card.append(top, tags);
  if (s) {
    const why = el('div', 'pm-why');
    if (s.forte.length) why.append(el('span', 'ok', `Forte contra: ${s.forte.slice(0, 4).map(([n, x]) => `${n} (${x}×)`).join(', ')}`));
    if (s.fraco.length) why.append(el('span', 'bad', `Cuidado com: ${s.fraco.slice(0, 3).map(([n, x]) => `${n} (${x}×)`).join(', ')}`));
    if (s.lvl < 0.5) why.append(el('span', 'warn', 'Nível bem abaixo do topo: suba antes de contar com ele.'));
    card.append(why);
  }
  if (extra) card.append(extra);
  return card;
}

async function renderPvp() {
  const root = $('#page-pvp');
  const accs = (S.poke && S.poke.accounts || []).filter((a) => a.isPoke);
  if (!accs.length) { root.replaceChildren(); root.append(emptyBox('PvP', 'Adicione uma conta do PokeIdle para ver o meta e montar o seu time.')); return; }
  if (!pvpAcc || !accs.some((a) => a.id === pvpAcc)) pvpAcc = S.poke.mainId || accs[0].id;
  pvpData = await call('poke:pvp:get', pvpAcc);
  if (page !== 'pvp') return;
  const { meta, live, running, prog } = pvpData;
  // Nome, tipos, status e alcance de cada espécie: o que a página do jogo acabou de calcular vale mais.
  if (meta && live && live.info) meta.info = { ...(meta.info || {}), ...live.info };
  const tab = (live && live.tabelaTipos) || (meta && meta.tabelaTipos) || {};
  root.replaceChildren();

  // ---- cabeçalho ----
  const head = el('header', 'page-head');
  const t = el('div');
  t.append(el('h1', null, 'PvP'), el('p', 'sub', 'O meta do top 50 do Ranqueado, lido do próprio jogo e atualizado sozinho todo dia. Monte e compare times com os seus pokémon.'));
  const act = el('div', 'actions'); act.style.margin = '0';
  const sel = el('select');
  for (const a of accs) { const i = a.info || {}; const o = el('option', null, `${a.id === S.poke.mainId ? '★ ' : ''}${i.logged && i.nick ? i.nick : a.name}`); o.value = a.id; sel.append(o); }
  sel.value = pvpAcc;
  sel.title = 'Conta cujos pokémon entram na sugestão e no planejador';
  sel.onchange = () => { pvpAcc = sel.value; pvpPlan = null; try { localStorage.setItem('pvpAcc', pvpAcc); } catch {} renderPvp(); };
  const st = el('span', 'sub pvp-st', running ? `Lendo o top 50… ${prog ? `${prog.feitos}/${prog.total || 50}` : ''}` : meta ? `Meta ${ago2(meta.at)}` : 'Meta ainda não lido');
  const rf = button('↻ Atualizar meta', null, async () => { const r = await call('poke:pvp:refresh'); if (r.error) toast(`⚠ ${r.error}`); else toast('Lendo o top 50 pela conta principal (uns 5 minutos). O jogo segue normal.'); setTimeout(() => page === 'pvp' && renderPvp(), 1500); });
  act.append(st, sel, rf);
  head.append(t, act);
  root.append(head);

  if (!meta) {
    root.append(emptyBox(running ? 'Lendo o top 50…' : 'O meta ainda não foi lido', running ? 'Uma consulta a cada poucos segundos pela conta principal. Em uns 5 minutos aparece tudo aqui.' : 'Ele é lido sozinho 3 minutos depois de abrir o app (pela conta principal) e depois uma vez por dia. Ou clique em "Atualizar meta".'));
    if (running) setTimeout(() => page === 'pvp' && renderPvp(), 8000);
    return;
  }
  if (running) setTimeout(() => page === 'pvp' && renderPvp(), 8000);

  const entries = pvpMetaEntries(meta);
  const teams = meta.linhas.filter((l) => meta.perfis[l.nick]);
  const levels = entries.map((e) => e.level).sort((a, b) => a - b);
  const refLevel = levels[Math.floor(levels.length / 2)] || 1;
  const mine = pvpMine(live, meta.info);
  // Conta ainda carregando o jogo: tenta de novo em alguns segundos (até 10 vezes).
  if (!mine.length) { pvpRetry = (pvpRetry || 0) + 1; if (pvpRetry <= 10) setTimeout(() => page === 'pvp' && renderPvp(), 6000); } else pvpRetry = 0;

  // ---- seu PvP ----
  const me = live && live.nick ? meta.linhas.find((l) => l.nick.toLowerCase() === live.nick.toLowerCase()) : null;
  const meCard = el('div', 'card pvp-me');
  meCard.append(el('div', 'ext-sec', 'Seu PvP'));
  const mrow = el('div', 'pvp-me-row');
  const stat = (v, l) => { const d = el('div', 'fstat'); d.append(el('b', null, v), el('span', null, l)); return d; };
  if (me) mrow.append(stat(`#${me.pos}`, 'no top 50'), stat(fmt(me.pr), 'PR'), stat(`${fmt(me.v)} / ${fmt(me.d)}`, 'vitórias / derrotas'), stat(`${Math.round((me.v / Math.max(1, me.v + me.d)) * 100)}%`, 'de vitórias'));
  else mrow.append(stat(live && live.nick ? live.nick : '—', 'fora do top 50'), stat(fmt(live ? live.nivel : 0), 'nível do treinador'), stat(fmt(refLevel), 'nível típico de um pokémon do top'), stat(fmt(mine.length), 'espécies suas'));
  meCard.append(mrow);
  root.append(meCard);

  // ---- mais usados e tipos ----
  const bySp = new Map();
  for (const e of entries) {
    const k = e.speciesId;
    const cur = bySp.get(k) || { e, n: 0, lv: 0, aoe: 0, z: {} };
    cur.n++; cur.lv += e.level; if (e.aoe) cur.aoe++; if (e.el) cur.z[e.el] = (cur.z[e.el] || 0) + 1;
    bySp.set(k, cur);
  }
  const usados = [...bySp.values()].sort((a, b) => b.n - a.n);
  const grid = el('div', 'pvp-grid');
  const cardUsed = el('div', 'card');
  cardUsed.append(el('div', 'ext-sec', `Mais usados no top 50 (${teams.length} times lidos)`));
  const ul = el('div', 'pvp-used');
  for (const u of usados.slice(0, 12)) {
    const row = el('div', 'pu-row');
    const n = el('div', 'pu-n'); n.append(el('b', null, u.e.nome), el('span', 'sub', `${alcIcon(u.e.alcance)} · Nv médio ${fmt(Math.round(u.lv / u.n))} · AoE em ${Math.round((u.aoe / u.n) * 100)}%`));
    const tg = el('div', 'pm-tags'); for (const tt of u.e.tipos) tg.append(tipoChip(tt));
    const zs = Object.entries(u.z).sort((a, b) => b[1] - a[1])[0]; if (zs) tg.append(el('span', 'zchip', `Z ${TIPO_PT[zs[0]] || zs[0]}`));
    const bar = el('div', 'pu-bar'); const f = el('i'); f.style.width = `${Math.round((u.n / Math.max(1, teams.length)) * 100)}%`; bar.append(f);
    const owned = mine.find((m) => m.speciesId === u.e.speciesId);
    row.append(n, tg, el('span', 'pu-c', `${u.n} de ${teams.length}`), bar, el('span', `pu-own${owned ? ' on' : ''}`, owned ? `você tem · Nv ${fmt(owned.level)}` : 'você não tem'));
    ul.append(row);
  }
  cardUsed.append(ul);
  const cardTypes = el('div', 'card');
  cardTypes.append(el('div', 'ext-sec', 'Tipos do meta'));
  const cnt = (f) => { const m = {}; for (const e of entries) for (const x of f(e)) m[x] = (m[x] || 0) + e.w; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const bars = (title, list) => { const box = el('div', 'pt-box'); box.append(el('b', null, title)); const max = list[0] ? list[0][1] : 1; for (const [tt, v] of list.slice(0, 7)) { const r = el('div', 'pt-row'); const b = el('div', 'pt-bar'); const f = el('i'); f.style.width = `${Math.round((v / max) * 100)}%`; f.style.background = TIPO_COR[tt] || '#777'; b.append(f); r.append(tipoChip(tt), b); box.append(r); } return box; };
  cardTypes.append(bars('Tipos dos pokémon (para ter quem bata forte)', cnt((e) => e.tipos)), bars('Tipos de ataque com Z-Move (para aguentar)', cnt((e) => e.atk)));
  // contra-meta: tipos de ataque que batem forte em mais entradas do meta
  const counter = Object.keys(TIPO_PT).map((tt) => [tt, entries.reduce((s, e) => s + (pvpEff(tab, tt, e.tipos[0], e.tipos[1]) >= 2 ? e.w : 0), 0)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const cbox = el('div', 'pt-box'); cbox.append(el('b', null, 'Ataques que mais punem o meta'));
  const crow = el('div', 'pm-tags'); for (const [tt] of counter) crow.append(tipoChip(tt)); cbox.append(crow);
  cardTypes.append(cbox);
  grid.append(cardUsed, cardTypes);
  root.append(grid);

  // ---- sugestão de time ----
  const sug = pvpSuggest(mine, entries, tab, refLevel);
  const sc = el('div', 'card');
  const sh = el('div', 'pvp-sh'); sh.append(el('div', 'ext-sec', 'Time sugerido com os seus pokémon'));
  if (sug.length) sh.append(button('Levar ao planejador ↓', 'mini', () => { pvpPlan = sug.map((x) => x.c.speciesId); renderPvp(); }));
  sc.append(sh);
  if (!mine.length) sc.append(el('div', 'mempty', 'Não consegui ler os pokémon desta conta ainda. Abra a conta no PokeIdle e volte aqui.'));
  else {
    const row = el('div', 'pvp-team');
    for (const x of sug) row.append(pvpMemberCard(x.c, x.s));
    sc.append(row);
    if (mine.length < 5) sc.append(el('div', 'mempty', `Esta conta tem só ${mine.length} espécie${mine.length === 1 ? '' : 's'}: o time completo tem 5.`));
  }
  root.append(sc);

  // ---- planejador ----
  if (!pvpPlan) { try { pvpPlan = JSON.parse(localStorage.getItem(`pvpPlan:${pvpAcc}`) || 'null'); } catch {} }
  if (!pvpPlan) pvpPlan = sug.map((x) => x.c.speciesId);
  pvpPlan = pvpPlan.filter((id) => mine.some((m) => m.speciesId === id)).slice(0, 5);
  const savePlan = () => { try { localStorage.setItem(`pvpPlan:${pvpAcc}`, JSON.stringify(pvpPlan)); } catch {} };
  const team = pvpPlan.map((id) => mine.find((m) => m.speciesId === id)).filter(Boolean);
  const pc = el('div', 'card pvp-plan');
  const ph = el('div', 'pvp-sh'); ph.append(el('div', 'ext-sec', `Planejador de equipe (${team.length}/5)`), button('Limpar', 'mini', () => { pvpPlan = []; savePlan(); renderPvp(); }));
  pc.append(ph);
  const body = el('div', 'pp-body');
  // lista dos seus pokémon
  const left = el('div', 'pp-left');
  const q = el('input'); q.type = 'text'; q.placeholder = 'Buscar seu pokémon…'; q.value = pvpBusca;
  q.oninput = () => { pvpBusca = q.value; const pos = q.selectionStart; renderPvp().then(() => { const n = $('#page-pvp .pp-left input'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
  left.append(q);
  const list = el('div', 'pp-list');
  for (const m of mine.filter((x) => !pvpBusca || x.nome.toLowerCase().includes(pvpBusca.toLowerCase())).slice(0, 60)) {
    const on = pvpPlan.includes(m.speciesId);
    const b = el('button', `pp-item${on ? ' on' : ''}`);
    b.append(el('b', null, m.nome), el('span', null, `Nv ${fmt(m.level)} · ${alcIcon(m.alcance)}${m.aoe ? ' · AoE' : ''}${m.el ? ` · Z ${TIPO_PT[String(m.el).toUpperCase()] || m.el}` : ''}`));
    b.onclick = () => { if (on) pvpPlan = pvpPlan.filter((x) => x !== m.speciesId); else if (pvpPlan.length < 5) pvpPlan.push(m.speciesId); else return toast('O time tem no máximo 5. Tire um antes.'); savePlan(); renderPvp(); };
    list.append(b);
  }
  left.append(list);
  // tabuleiro
  const mid = el('div', 'pp-mid');
  const board = el('div', 'pp-board');
  const lugares = pvpPlace([...team].sort((a, b) => a.alcance - b.alcance));
  const sorted = [...team].sort((a, b) => a.alcance - b.alcance);
  PVP_ROWS.forEach((n, r) => {
    const row = el('div', 'pp-row');
    for (let col = 0; col < n; col++) {
      const i = lugares.findIndex((p) => p && p.r === r && p.col === col);
      const cell = el('div', `pp-cell${i >= 0 ? ' on' : ''}`);
      if (i >= 0) { const m = sorted[i]; cell.append(el('b', null, m.nome.replace(/^Mega /, 'M. ')), el('span', null, alcIcon(m.alcance))); cell.title = `${m.nome} · Nv ${fmt(m.level)}`; }
      row.append(cell);
    }
    board.append(row);
  });
  mid.append(el('div', 'pp-front', '↑ frente (perto do adversário)'), board, el('div', 'mempty', 'Posição sugerida: corpo a corpo na frente, quem atira de mais longe mais atrás. Monte igual no "Editar tabuleiro" do jogo.'));
  // análise contra o meta
  const right = el('div', 'pp-right');
  if (!team.length) right.append(el('div', 'mempty', 'Escolha até 5 pokémon na lista para ver como o time vai contra o meta.'));
  else {
    const top10 = usados.slice(0, 10).map((u) => u.e);
    const rows = el('div', 'pp-matrix');
    const hd = el('div', 'pm-row hd'); hd.append(el('span', null, 'Contra'), el('span', null, 'Seu melhor golpe'), el('span', null, 'O golpe dele'), el('span', null, ''));
    rows.append(hd);
    let wins = 0, losses = 0;
    for (const e of top10) {
      const mine2 = Math.max(...team.map((m) => pvpBest(tab, m.atk, e.tipos)));
      const theirs = Math.max(...team.map((m) => pvpBest(tab, e.atk, m.tipos)));
      const v = mine2 > theirs ? 'ok' : mine2 < theirs ? 'bad' : 'meh';
      if (v === 'ok') wins++; if (v === 'bad') losses++;
      const r = el('div', `pm-row ${v}`);
      r.append(el('span', null, e.nome), el('span', null, `${mine2}×`), el('span', null, `${theirs}×`), el('span', 'vv', v === 'ok' ? 'vantagem' : v === 'bad' ? 'desvantagem' : 'empate'));
      rows.append(r);
    }
    const avgLv = Math.round(team.reduce((s, m) => s + m.level, 0) / team.length);
    const perto = team.filter((m) => m.alcance <= 1).length;
    const resumo = el('div', 'pp-sum');
    resumo.append(el('b', null, `Vantagem de tipo contra ${wins} dos 10 mais usados · desvantagem contra ${losses}`),
      el('span', null, `Nível médio ${fmt(avgLv)} (no topo: ~${fmt(refLevel)}) · ${perto} corpo a corpo, ${team.length - perto} a distância · AoE em ${team.filter((m) => m.aoe).length}`));
    if (avgLv < refLevel * 0.5) resumo.append(el('span', 'warn', 'O nível pesa muito no PvP: com o time bem abaixo do topo, o tipo sozinho não ganha. Suba os escolhidos.'));
    right.append(resumo, rows);
  }
  body.append(left, mid, right);
  pc.append(body);
  root.append(pc);

  // ---- times do topo que você chega perto ----
  const near = teams.map((l) => { const time = meta.perfis[l.nick].time; const has = time.filter((k) => mine.some((m) => m.speciesId === k.speciesId)); return { l, time, has }; })
    .sort((a, b) => b.has.length - a.has.length || a.l.pos - b.l.pos).slice(0, 6);
  const nc = el('div', 'card');
  nc.append(el('div', 'ext-sec', 'Times do topo que você chega perto'));
  for (const x of near) {
    const r = el('div', 'pn-row');
    const n = el('div', 'pu-n'); n.append(el('b', null, `#${x.l.pos} ${x.l.nick}`), el('span', 'sub', `você tem ${x.has.length}/5`));
    const tg = el('div', 'pm-tags');
    for (const k of x.time) { const ok = x.has.includes(k); const s2 = el('span', `pn-p${ok ? ' ok' : ''}`, (k.nome || '').replace(/^Mega /, 'M. ')); s2.title = `${k.nome} · Nv ${fmt(k.level)}${k.aoe ? ' · AoE' : ''}${k.el ? ` · Z ${k.el}` : ''}`; tg.append(s2); }
    r.append(n, tg);
    nc.append(r);
  }
  root.append(nc);

  // ---- top 50 ----
  const tc = el('div', 'card');
  tc.append(el('div', 'ext-sec', 'Top 50 do Ranqueado'));
  const tl = el('div', 'pvp-top');
  for (const l of meta.linhas) {
    const p = meta.perfis[l.nick];
    const r = el('div', 'pt-line');
    r.append(el('span', 'pos', `#${l.pos}`), el('b', 'nk', l.nick), el('span', 'pr', `${fmt(l.pr)} PR`), el('span', 'wl', `${fmt(l.v)}V / ${fmt(l.d)}D · ${Math.round((l.v / Math.max(1, l.v + l.d)) * 100)}%`));
    const tg = el('div', 'pm-tags');
    for (const k of (p ? p.time : [])) { const s2 = el('span', 'pn-p', `${(k.nome || '').replace(/^Mega /, 'M. ')} ${fmt(k.level)}`); s2.title = `${k.nome} · Nv ${fmt(k.level)}${k.aoe ? ' · AoE' : ''}${k.el ? ` · Z-Move ${k.el}` : ''}`; tg.append(s2); }
    if (!p) tg.append(el('span', 'sub', 'equipe não lida'));
    r.append(tg);
    tl.append(r);
  }
  tc.append(tl);
  root.append(tc);
}
