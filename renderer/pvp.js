// Idleterino — aba PvP. Tudo é leitura do próprio jogo: o time se monta no jogo ("Editar
// tabuleiro") e comprar é sempre com a pessoa, no Market do jogo. O app não mexe em nada.
//
//  · Meta: arquétipos do top 50 (times que dividem 3+ pokémon) com tier, tendência de 14 dias,
//    pokémon e tipos mais usados e o top 50.
//  · Meu time: o seu time contra cada arquétipo (duelo 1×1 do jogo), sugestão com o que você tem,
//    upgrade, time anti-meta "sem limite" (baleia) com preço no Market, orçamento e contra-times.
//  · Planejador: os dois lados do tabuleiro — o adversário previsto e o seu posicionamento contra ele.
//  · Histórico: PR, vitórias e derrotas ao longo dos dias, sequência e decaimento.
//
// Como o app pesa um pokémon: o duelo 1×1 do jogo (compararDuelo1v1: status no nível, IV, qualidade,
// potência, refino, golpe, STAB, tipos e Z-Move) e, onde não há duelo, a tabela de tipos do jogo.

const PVP_DIAG = { FIRE: 0.5, WATER: 0.5, ELECTRIC: 0.5, GRASS: 0.5, ICE: 0.5, POISON: 0.5, PSYCHIC: 0.5, DARK: 0.5, STEEL: 0.5, GHOST: 2, DRAGON: 2 };
const TIPO_PT = { NORMAL: 'Normal', FIRE: 'Fogo', WATER: 'Água', GRASS: 'Planta', ELECTRIC: 'Elétrico', ICE: 'Gelo', FIGHTING: 'Lutador', POISON: 'Veneno', GROUND: 'Terra', FLYING: 'Voador', PSYCHIC: 'Psíquico', BUG: 'Inseto', ROCK: 'Pedra', GHOST: 'Fantasma', DRAGON: 'Dragão', DARK: 'Sombrio', STEEL: 'Aço', FAIRY: 'Fada' };
const TIPO_COR = { NORMAL: '#9fa19f', FIRE: '#e62829', WATER: '#2980ef', GRASS: '#3fa129', ELECTRIC: '#fac000', ICE: '#3dcef3', FIGHTING: '#ff8000', POISON: '#9141cb', GROUND: '#915121', FLYING: '#81b9ef', PSYCHIC: '#ef4179', BUG: '#91a119', ROCK: '#afa981', GHOST: '#704170', DRAGON: '#5060e1', DARK: '#624d4e', STEEL: '#60a1b8', FAIRY: '#ef70ef' };
const TIER_COR = { S: '#ff6b6b', A: '#ffb347', B: '#ffe066', C: '#8fd18f', U: '#8a90a6' };
let pvpData = null;
let pvpAcc = (() => { try { return localStorage.getItem('pvpAcc') || null; } catch { return null; } })();
let pvpTab = (() => { try { return localStorage.getItem('pvpTab') || 'meta'; } catch { return 'meta'; } })();
let pvpPlan = null;
let pvpBusca = '';
let pvpRetry = 0;
let pvpArqSel = null;
let pvpSemLend = true;
let pvpSoVenda = (() => { try { return localStorage.getItem('pvpSoVenda') !== '0'; } catch { return true; } })();
let pvpBudget = (() => { try { return Number(localStorage.getItem('pvpBudget')) || 3000; } catch { return 3000; } })();
const pvpSimCache = new Map();

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
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const shortName = (n) => String(n || '').replace(/^Mega /, 'M. ');
const zChip = (z) => { const s = el('span', 'zchip', `Z ${TIPO_PT[String(z).toUpperCase()] || z}`); s.title = 'Z-Move: dá um tipo de ataque a mais'; return s; };

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
      out.push({ ...k, pos: l.pos, nick: l.nick, w, arq: meta.porNick ? meta.porNick[l.nick] : null, tipos, atk: [...new Set([...tipos, k.el || k.tmElemental].filter(Boolean))], alcance: inf.alcance || 1, stats: inf.stats, nome: k.nome || inf.nome || `#${k.speciesId}` });
    }
  }
  return out;
}

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

function pvpMine(live, info) {
  if (!live) return [];
  return Object.entries(live.meus || {}).map(([sid, m]) => {
    const inf = info[sid] || {};
    const tipos = inf.tipos || [];
    const el2 = m.el || m.tmElemental || null;
    return { speciesId: Number(sid), nome: inf.nome || `#${sid}`, tipos, atk: [...new Set([...tipos, el2].filter(Boolean))], el: el2, aoe: !!m.aoe, level: m.level, alcance: inf.alcance || 1, stats: inf.stats, pk: m };
  }).sort((a, b) => b.level - a.level);
}

function pvpSuggest(mine, entries, tab, refLevel) {
  const pool = mine.map((c) => ({ c, s: pvpScore(c, entries, tab, refLevel) })).sort((a, b) => b.s.score - a.s.score);
  const team = [];
  const coberto = new Set();
  while (team.length < 5 && pool.length) {
    let best = null, bestV = -1e9;
    const perto = team.filter((x) => x.c.alcance <= 1).length, longe = team.length - perto;
    for (const x of pool) {
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

// ---------- tabuleiro ----------
const PVP_ROWS = [6, 8, 8, 4, 4];
const ordemFila = (n) => { const mid = (n - 1) / 2; return [...Array(n).keys()].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b); };
const linhasDoAlcance = (a) => (a <= 1 ? [0, 1, 2, 3, 4] : a === 2 ? [1, 2, 0, 3, 4] : a === 3 ? [2, 3, 1, 4, 0] : [3, 2, 4, 1, 0]);
// O previsto: corpo a corpo na frente, quem atira de mais longe mais atrás, do meio para as pontas.
function pvpPlace(team) {
  const usadas = new Set();
  return team.map((m) => {
    for (const r of linhasDoAlcance(m.alcance)) for (const col of ordemFila(PVP_ROWS[r])) { const k = `${r}:${col}`; if (!usadas.has(k)) { usadas.add(k); return { r, col }; } }
    return null;
  });
}
// O seu, contra um adversário: cada um na fileira do seu alcance, na coluna de frente para o alvo que
// ele vence no 1×1 (o tabuleiro dele está girado: a esquerda dele é a sua direita). Contra time com
// muito AoE, ninguém fica colado em ninguém.
function pvpPlaceVs(team, alvos, enemyPlaces, spread) {
  const usadas = new Set();
  const vizinho = (r, col) => [...usadas].some((k) => { const [rr, cc] = k.split(':').map(Number); return rr === r && Math.abs(cc - col) <= 1; });
  return team.map((m, i) => {
    const t = alvos[i] != null ? enemyPlaces[alvos[i]] : null;
    const alvoX = t ? 1 - (t.col + 0.5) / PVP_ROWS[t.r] : 0.5;
    for (const pass of spread ? [true, false] : [false]) {
      for (const r of linhasDoAlcance(m.alcance)) {
        const cols = [...Array(PVP_ROWS[r]).keys()].sort((a, b) => Math.abs((a + 0.5) / PVP_ROWS[r] - alvoX) - Math.abs((b + 0.5) / PVP_ROWS[r] - alvoX));
        for (const col of cols) { const k = `${r}:${col}`; if (usadas.has(k) || (pass && vizinho(r, col))) continue; usadas.add(k); return { r, col }; }
      }
    }
    return null;
  });
}
function boardEl(sides) {
  // sides: [{ team, places, cls, flip }]: o de cima vem girado (a frente dele perto do meio).
  const wrap = el('div', 'pp-board two');
  for (const sd of sides) {
    const half = el('div', `pp-half ${sd.cls}`);
    const order = sd.flip ? [4, 3, 2, 1, 0] : [0, 1, 2, 3, 4];
    for (const r of order) {
      const row = el('div', 'pp-row');
      const cols = [...Array(PVP_ROWS[r]).keys()];
      if (sd.flip) cols.reverse();
      for (const col of cols) {
        const i = sd.places.findIndex((p) => p && p.r === r && p.col === col);
        const cell = el('div', `pp-cell${i >= 0 ? ' on' : ''}`);
        if (i >= 0) { const m = sd.team[i]; cell.append(el('b', null, shortName(m.nome)), el('span', null, `${alcIcon(m.alcance)}${m.aoe ? ' AoE' : ''}`)); cell.title = `${m.nome} · Nv ${fmt(m.level)}`; }
        row.append(cell);
      }
      half.append(row);
    }
    wrap.append(half);
    if (sd.flip) wrap.append(el('div', 'pp-ball', '◓'));
  }
  return wrap;
}

function pvpMemberCard(c, s, extra) {
  const card = el('div', 'pvp-mem');
  const top = el('div', 'pm-top');
  top.append(el('b', null, c.nome), el('span', 'pm-lv', c.level ? `Nv ${fmt(c.level)}` : ''), el('span', 'pm-alc', alcIcon(c.alcance)));
  const tags = el('div', 'pm-tags');
  for (const t of c.tipos || []) tags.append(tipoChip(t));
  if (c.el) tags.append(zChip(c.el));
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

// Preço no Market (lido pelo app na atualização do meta): "a partir de", em gemas e coins.
function priceRow(meta, nome) {
  const rows = (meta.precos || {})[nome] || [];
  const r = rows.find((x) => String(x.nome).toLowerCase() === String(nome).toLowerCase()) || null;
  const box = el('div', 'price');
  if (!r) { box.append(el('span', 'sub', rows.length ? 'sem oferta dessa forma agora' : 'sem oferta lida no Market')); return { box, r: null }; }
  if (r.minOrb) { const b = el('b', 'orb'); b.append(el('i', 'cur orb'), fmt(r.minOrb)); box.append(b); }
  if (r.minGold) { const b = el('b'); b.append(el('i', 'cur gold'), fmt(r.minGold)); box.append(b); }
  box.append(el('span', 'sub', `${r.anuncios} oferta${r.anuncios === 1 ? '' : 's'}${r.temTmAoe ? ' · tem com AoE' : ''}${r.temTmElemental ? ' · tem com Z-Move' : ''}`));
  return { box, r };
}
function watchBtn(nome) {
  const on = (pvpData.watch || []).includes(nome);
  const b = button(on ? '🔔 Avisando' : '🔔 Avisar quando baratear', `mini${on ? ' on' : ''}`, async () => {
    const list = new Set(pvpData.watch || []);
    if (on) list.delete(nome); else list.add(nome);
    pvpData.watch = await call('poke:pvp:watch', [...list]);
    toast(on ? `Sem aviso para ${nome}.` : `O app avisa quando ${nome} aparecer bem mais barato no Market (confere a cada 30 min).`);
    renderPvp(true);
  });
  b.title = 'Só avisa. A compra é sempre sua, no Market do jogo.';
  return b;
}

// Simulação: o seu time contra o time de um jogador do top, no duelo 1×1 do jogo (cada um contra
// cada um). Nota do time = 60% "para cada adversário, o seu melhor contra ele" + 40% a média geral.
async function simTeam(team, enemyTime) {
  const key = `${pvpAcc}|${team.map((m) => `${m.speciesId}:${m.level}`).join(',')}|${enemyTime.map((k) => `${k.speciesId}:${k.level}`).join(',')}`;
  if (pvpSimCache.has(key)) return pvpSimCache.get(key);
  const res = await call('poke:pvp:duel', pvpAcc, team.map((m) => ({ ...m.pk, speciesId: m.speciesId })), enemyTime);
  if (!res || !res.m) return null;
  const m = res.m.map((row) => row.map((x) => (x == null ? 0.5 : x)));
  const cols = enemyTime.map((_, j) => Math.max(...m.map((row) => row[j])));
  const all = m.flat();
  const est = 0.6 * (cols.reduce((a, b) => a + b, 0) / cols.length) + 0.4 * (all.reduce((a, b) => a + b, 0) / all.length);
  const out = { m, est };
  pvpSimCache.set(key, out);
  return out;
}

async function renderPvp(keepScroll) {
  const root = $('#page-pvp');
  const scroll = keepScroll ? root.scrollTop : 0;
  const accs = (S.poke && S.poke.accounts || []).filter((a) => a.isPoke);
  if (!accs.length) { root.replaceChildren(); root.append(emptyBox('PvP', 'Adicione uma conta do PokeIdle para ver o meta e montar o seu time.')); return; }
  if (!pvpAcc || !accs.some((a) => a.id === pvpAcc)) pvpAcc = S.poke.mainId || accs[0].id;
  pvpData = await call('poke:pvp:get', pvpAcc);
  if (page !== 'pvp') return;
  const { meta, live, running, prog } = pvpData;
  if (meta && live && live.info) meta.info = { ...(meta.info || {}), ...live.info };
  const tab = (live && live.tabelaTipos) || (meta && meta.tabelaTipos) || {};
  root.replaceChildren();

  // ---- cabeçalho ----
  const head = el('header', 'page-head');
  const t = el('div');
  t.append(el('h1', null, 'PvP'), el('p', 'sub', 'Meta do top 50 do Ranqueado, lido do próprio jogo e atualizado sozinho todo dia. Os cálculos usam o duelo 1×1 do jogo.'));
  const act = el('div', 'actions'); act.style.margin = '0';
  const sel = el('select');
  for (const a of accs) { const i = a.info || {}; const o = el('option', null, `${a.id === S.poke.mainId ? '★ ' : ''}${i.logged && i.nick ? i.nick : a.name}`); o.value = a.id; sel.append(o); }
  sel.value = pvpAcc;
  sel.title = 'Conta cujos pokémon entram nas sugestões, no planejador e no histórico';
  sel.onchange = () => { pvpAcc = sel.value; pvpPlan = null; try { localStorage.setItem('pvpAcc', pvpAcc); } catch {} renderPvp(); };
  const st = el('span', 'sub pvp-st', running ? `Lendo o top 50… ${prog ? `${prog.feitos}/${prog.total || 50}` : '(e calculando)'}` : meta ? `Meta ${ago2(meta.at)}` : 'Meta ainda não lido');
  const rf = button('↻ Atualizar meta', null, async () => { const r = await call('poke:pvp:refresh'); if (r.error) toast(`⚠ ${r.error}`); else toast('Lendo o top 50 pela conta principal (uns 6 minutos, com os cálculos). O jogo segue normal.'); setTimeout(() => page === 'pvp' && renderPvp(true), 1500); });
  act.append(st, sel, rf);
  head.append(t, act);
  root.append(head);

  const tabs = el('div', 'pvp-tabs');
  for (const [k, l] of [['meta', 'Meta'], ['time', 'Meu time'], ['plan', 'Planejador'], ['hist', 'Histórico']]) {
    tabs.append(button(l, pvpTab === k ? 'on' : '', () => { pvpTab = k; try { localStorage.setItem('pvpTab', k); } catch {} renderPvp(); }));
  }
  root.append(tabs);

  if (running) setTimeout(() => page === 'pvp' && renderPvp(true), 8000);
  if (pvpTab === 'hist') { renderPvpHist(root); root.scrollTop = scroll; return; }
  if (!meta) {
    root.append(emptyBox(running ? 'Lendo o top 50…' : 'O meta ainda não foi lido', running ? 'Uma consulta a cada poucos segundos pela conta principal. Em uns 6 minutos aparece tudo aqui.' : 'Ele é lido sozinho 3 minutos depois de abrir o app (pela conta principal) e depois uma vez por dia. Ou clique em "Atualizar meta".'));
    return;
  }
  if (!meta.arqs) { root.append(emptyBox('Meta de uma versão anterior', 'Clique em "Atualizar meta" para ler de novo com arquétipos, tier list e preços.')); }

  const entries = pvpMetaEntries(meta);
  const teams = meta.linhas.filter((l) => meta.perfis[l.nick]);
  const levels = entries.map((e) => e.level).sort((a, b) => a - b);
  const refLevel = levels[Math.floor(levels.length / 2)] || 1;
  const mine = pvpMine(live, meta.info);
  if (!mine.length) { pvpRetry++; if (pvpRetry <= 10) setTimeout(() => page === 'pvp' && renderPvp(true), 6000); } else pvpRetry = 0;
  const ctx2 = { meta, live, tab, entries, teams, refLevel, mine, arqs: meta.arqs || [] };

  if (pvpTab === 'meta') renderPvpMeta(root, ctx2);
  else if (pvpTab === 'time') renderPvpTime(root, ctx2);
  else renderPvpPlan(root, ctx2);
  root.scrollTop = scroll;
}

const arqName = (a, meta) => a.core.slice(0, 3).map((id) => shortName((meta.info[id] || {}).nome || `#${id}`)).join(' + ');
const arqTeam = (a, meta) => ((meta.perfis[a.rep] || {}).time || []).map((k) => { const inf = meta.info[k.speciesId] || {}; return { ...k, nome: k.nome || inf.nome, tipos: inf.tipos || [], alcance: inf.alcance || 1, stats: inf.stats, el: k.el || k.tmElemental, atk: [...new Set([...(inf.tipos || []), k.el || k.tmElemental].filter(Boolean))] }; });

// ================= META =================
function renderPvpMeta(root, c) {
  const { meta, entries, teams, mine, arqs } = c;
  const hist = pvpData.hist || [];
  const old = hist.length > 1 ? hist[Math.max(0, hist.length - 8)] : null; // ~7 leituras atrás
  if (arqs.length) {
    const card = el('div', 'card');
    card.append(el('div', 'ext-sec', `Tier list dos arquétipos (times do top que dividem 3+ pokémon) · ${teams.length} times`));
    for (const tier of ['S', 'A', 'B', 'C', 'U']) {
      const list = arqs.filter((a) => a.tier === tier);
      if (!list.length) continue;
      const row = el('div', 'tier-row');
      const lab = el('div', 'tier-lab', tier === 'U' ? 'Únicos' : tier); lab.style.background = TIER_COR[tier];
      const items = el('div', 'tier-items');
      for (const a of list.slice(0, tier === 'U' ? 8 : 12)) {
        const it = el('button', 'arq');
        const was = old && old.arqs ? old.arqs[a.key] : null;
        const tr = was == null ? (old ? 'novo' : '') : a.n > was ? `▲${a.n - was}` : a.n < was ? `▼${was - a.n}` : '=';
        it.append(el('b', null, arqName(a, meta)), el('span', null, `${a.n} no top · PR ${fmt(a.pr)} · ${pct(a.wr)} vit. · melhor #${a.best}`));
        if (tr) it.append(el('i', `tr ${tr.startsWith('▲') || tr === 'novo' ? 'up' : tr.startsWith('▼') ? 'down' : ''}`, tr));
        it.title = `Usado por: ${a.nicks.slice(0, 8).join(', ')}${a.nicks.length > 8 ? '…' : ''}\nClique para planejar contra ele.`;
        it.onclick = () => { pvpArqSel = a.id; pvpTab = 'plan'; renderPvp(); };
        items.append(it);
      }
      row.append(lab, items);
      card.append(row);
    }
    card.append(el('div', 'mempty', 'Tier: quantos usam, o PR médio e a taxa de vitórias de quem usa. ▲▼ = mudança nos últimos ~7 dias. Clique num arquétipo para planejar contra ele.'));
    root.append(card);
  }
  const bySp = new Map();
  for (const e of entries) {
    const cur = bySp.get(e.speciesId) || { e, n: 0, lv: 0, aoe: 0, z: {} };
    cur.n++; cur.lv += e.level; if (e.aoe) cur.aoe++; const z = e.el || e.tmElemental; if (z) cur.z[z] = (cur.z[z] || 0) + 1;
    bySp.set(e.speciesId, cur);
  }
  const usados = [...bySp.values()].sort((a, b) => b.n - a.n);
  const grid = el('div', 'pvp-grid');
  const cardUsed = el('div', 'card');
  cardUsed.append(el('div', 'ext-sec', 'Pokémon mais usados'));
  for (const u of usados.slice(0, 14)) {
    const row = el('div', 'pu-row');
    const n = el('div', 'pu-n'); n.append(el('b', null, u.e.nome), el('span', 'sub', `${alcIcon(u.e.alcance)} · Nv médio ${fmt(Math.round(u.lv / u.n))} · AoE em ${pct(u.aoe / u.n)}`));
    const tg = el('div', 'pm-tags'); for (const tt of u.e.tipos) tg.append(tipoChip(tt));
    const zs = Object.entries(u.z).sort((a, b) => b[1] - a[1])[0]; if (zs) tg.append(zChip(zs[0]));
    const was = old && old.uso ? old.uso[u.e.speciesId] || 0 : null;
    const tr = was == null ? '' : u.n > was ? ` ▲${u.n - was}` : u.n < was ? ` ▼${was - u.n}` : '';
    const bar = el('div', 'pu-bar'); const f = el('i'); f.style.width = pct(u.n / Math.max(1, teams.length)); bar.append(f);
    const owned = mine.find((m) => m.speciesId === u.e.speciesId);
    row.append(n, tg, el('span', `pu-c${tr.includes('▲') ? ' up' : tr.includes('▼') ? ' down' : ''}`, `${u.n} de ${teams.length}${tr}`), bar, el('span', `pu-own${owned ? ' on' : ''}`, owned ? `você tem · Nv ${fmt(owned.level)}` : 'você não tem'));
    cardUsed.append(row);
  }
  const cardTypes = el('div', 'card');
  cardTypes.append(el('div', 'ext-sec', 'Tipos do meta'));
  const cnt = (f) => { const m = {}; for (const e of entries) for (const x of f(e)) m[x] = (m[x] || 0) + e.w; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const bars = (title, list) => { const box = el('div', 'pt-box'); box.append(el('b', null, title)); const max = list[0] ? list[0][1] : 1; for (const [tt, v] of list.slice(0, 7)) { const r = el('div', 'pt-row'); const b = el('div', 'pt-bar'); const f = el('i'); f.style.width = `${Math.round((v / max) * 100)}%`; f.style.background = TIPO_COR[tt] || '#777'; b.append(f); r.append(tipoChip(tt), b); box.append(r); } return box; };
  cardTypes.append(bars('Tipos dos pokémon (para ter quem bata forte)', cnt((e) => e.tipos)), bars('Tipos de ataque com Z-Move (para aguentar)', cnt((e) => e.atk)));
  const counter = Object.keys(TIPO_PT).map((tt) => [tt, entries.reduce((s, e) => s + (pvpEff(c.tab, tt, e.tipos[0], e.tipos[1]) >= 2 ? e.w : 0), 0)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const cbox = el('div', 'pt-box'); cbox.append(el('b', null, 'Ataques que mais punem o meta'));
  const crow = el('div', 'pm-tags'); for (const [tt] of counter) crow.append(tipoChip(tt)); cbox.append(crow);
  cardTypes.append(cbox);
  grid.append(cardUsed, cardTypes);
  root.append(grid);
  const tc = el('div', 'card');
  tc.append(el('div', 'ext-sec', 'Top 50 do Ranqueado'));
  const tl = el('div', 'pvp-top');
  for (const l of meta.linhas) {
    const p = meta.perfis[l.nick];
    const r = el('div', 'pt-line');
    const a = meta.porNick && arqs.find((x) => x.id === meta.porNick[l.nick]);
    const tg = el('span', 'tierchip', a ? (a.tier === 'U' ? '—' : a.tier) : ''); if (a) tg.style.background = TIER_COR[a.tier];
    r.append(el('span', 'pos', `#${l.pos}`), el('b', 'nk', l.nick), el('span', 'pr', `${fmt(l.pr)} PR`), el('span', 'wl', `${fmt(l.v)}V / ${fmt(l.d)}D · ${pct(l.v / Math.max(1, l.v + l.d))}`));
    const tags = el('div', 'pm-tags'); if (a) tags.append(tg);
    for (const k of (p ? p.time : [])) { const s2 = el('span', 'pn-p', `${shortName(k.nome)} ${fmt(k.level)}`); s2.title = `${k.nome} · Nv ${fmt(k.level)}${k.aoe ? ' · AoE' : ''}${(k.el || k.tmElemental) ? ` · Z-Move ${k.el || k.tmElemental}` : ''}`; tags.append(s2); }
    r.append(tags);
    tl.append(r);
  }
  tc.append(tl);
  root.append(tc);
}

// ================= MEU TIME =================
function renderPvpTime(root, c) {
  const { meta, entries, tab, refLevel, mine, arqs } = c;
  const sug = pvpSuggest(mine, entries, tab, refLevel);
  if (!pvpPlan) { try { pvpPlan = JSON.parse(localStorage.getItem(`pvpPlan:${pvpAcc}`) || 'null'); } catch {} }
  const team = (pvpPlan && pvpPlan.length ? pvpPlan.map((id) => mine.find((m) => m.speciesId === id)).filter(Boolean) : sug.map((x) => x.c));
  const temPreco = (x) => !!priceRow(meta, x.nome).r;
  const candAll = (meta.candidatos || []).filter((x) => !pvpSemLend || !x.lend);
  const cand = pvpSoVenda && candAll.some(temPreco) ? candAll.filter(temPreco) : candAll;
  const top = arqs.filter((a) => a.tier !== 'U').slice(0, 8);

  const vs = el('div', 'card');
  const vh = el('div', 'pvp-sh'); vh.append(el('div', 'ext-sec', `Seu time contra os arquétipos do topo (${team.length}/5)`), el('span', 'sub', team.length ? team.map((m) => shortName(m.nome)).join(' · ') : 'monte no Planejador ou use o sugerido'));
  vs.append(vh);
  if (!top.length) vs.append(el('div', 'mempty', 'Atualize o meta para ter os arquétipos.'));
  for (const a of top) {
    const r = el('div', 'vs-row');
    const lab = el('span', 'tierchip', a.tier); lab.style.background = TIER_COR[a.tier];
    const nm = el('div', 'pu-n'); nm.append(el('b', null, arqName(a, meta)), el('span', 'sub', `${a.n} no top · PR ${fmt(a.pr)}`));
    const res = el('span', 'vs-res', team.length ? 'simulando…' : '—');
    const bar = el('div', 'pu-bar');
    const enemy = arqTeam(a, meta);
    let w = 0;
    for (const e of enemy) { const mb = Math.max(0, ...team.map((m) => pvpBest(tab, m.atk, e.tipos))); const th = Math.max(0, ...team.map((m) => pvpBest(tab, e.atk, m.tipos))); if (mb > th) w++; }
    r.append(lab, nm, res, bar, el('span', 'sub', team.length ? `${w}/${enemy.length} com vantagem de tipo` : ''), button('Planejar contra', 'mini', () => { pvpArqSel = a.id; pvpTab = 'plan'; renderPvp(); }));
    vs.append(r);
    if (team.length && enemy.length) simTeam(team, enemy).then((sres) => {
      if (!sres) { res.textContent = 'sem simulação'; return; }
      res.textContent = `${pct(sres.est)} de força`; res.className = `vs-res ${sres.est >= 0.55 ? 'ok' : sres.est >= 0.45 ? 'meh' : 'bad'}`;
      const f = el('i'); f.style.width = pct(sres.est); f.style.background = sres.est >= 0.55 ? 'var(--ok)' : sres.est >= 0.45 ? '#ffcf66' : '#ff8a8a'; bar.replaceChildren(f);
    });
  }
  vs.append(el('div', 'mempty', 'Força = duelos 1×1 do jogo (status no nível, IV, qualidade, potência, refino, golpe, tipos e Z-Move) de cada um seu contra cada um do time mais bem colocado do arquétipo. É estimativa: na luta real também contam posição e alcance.'));
  root.append(vs);

  const sc = el('div', 'card');
  const sh = el('div', 'pvp-sh'); sh.append(el('div', 'ext-sec', 'Com o que você tem'));
  if (sug.length) sh.append(button('Usar no planejador', 'mini', () => { pvpPlan = sug.map((x) => x.c.speciesId); try { localStorage.setItem(`pvpPlan:${pvpAcc}`, JSON.stringify(pvpPlan)); } catch {} pvpTab = 'plan'; renderPvp(); }));
  sc.append(sh);
  if (!mine.length) sc.append(el('div', 'mempty', 'Não consegui ler os pokémon desta conta ainda. Abra a conta no PokeIdle e volte aqui.'));
  else { const row = el('div', 'pvp-team'); for (const x of sug) row.append(pvpMemberCard(x.c, x.s)); sc.append(row); if (mine.length < 5) sc.append(el('div', 'mempty', `Esta conta tem só ${mine.length} espécie${mine.length === 1 ? '' : 's'}: o time completo tem 5.`)); }
  root.append(sc);

  if (team.length && cand.length) {
    const scored = team.map((m) => ({ m, s: pvpScore(m, entries, tab, refLevel).score })).sort((a, b) => a.s - b.s);
    const fraco = scored[0].m;
    const opts = cand.filter((x) => !team.some((m) => m.speciesId === x.speciesId)).slice(0, 4);
    const uc = el('div', 'card');
    uc.append(el('div', 'ext-sec', 'Upgrade: o que mais melhora o seu time'));
    uc.append(el('div', 'sub up-lead', `O mais fraco contra o meta hoje: ${fraco.nome} (Nv ${fmt(fraco.level)}). Troque por um destes (contas no nível do top, ~Nv ${fmt(meta.ref ? meta.ref.level : refLevel)}):`));
    const row = el('div', 'cand-list');
    for (const x of opts) row.append(candRow(meta, x, top));
    uc.append(row);
    root.append(uc);
  }

  if (cand.length) {
    const pick = [];
    const covered = (list) => top.reduce((s, a) => s + Math.max(0, ...list.map((x) => (x.porArq || {})[a.id] ?? x.win)), 0) / Math.max(1, top.length);
    while (pick.length < 5) {
      let best = null, bv = -1;
      for (const x of cand.slice(0, 40)) { if (pick.includes(x)) continue; const types = new Set(pick.flatMap((p) => p.tipos)); const v = covered([...pick, x]) + x.win * 0.3 - (x.tipos.some((tt) => types.has(tt)) ? 0.03 : 0); if (v > bv) { bv = v; best = x; } }
      if (!best) break; pick.push(best);
    }
    const wins = top.filter((a) => Math.max(...pick.map((x) => (x.porArq || {})[a.id] ?? x.win)) >= 0.5).length;
    const ac = el('div', 'card');
    const ah = el('div', 'pvp-sh'); ah.append(el('div', 'ext-sec', 'Time anti-meta (sem limite de pokémon)'));
    const lg = el('label', 'chk'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = pvpSemLend; cb.onchange = () => { pvpSemLend = cb.checked; renderPvp(true); }; lg.append(cb, ' sem lendários');
    const lv = el('label', 'chk'); const cv = el('input'); cv.type = 'checkbox'; cv.checked = pvpSoVenda; cv.onchange = () => { pvpSoVenda = cv.checked; try { localStorage.setItem('pvpSoVenda', pvpSoVenda ? '1' : '0'); } catch {} renderPvp(true); }; lv.append(cv, ' só o que está à venda');
    const opts2 = el('div', 'actions'); opts2.style.margin = '0'; opts2.append(lv, lg);
    ah.append(opts2);
    ac.append(ah, el('div', 'sub up-lead', `No nível/potência típicos do top (Nv ~${fmt(meta.ref ? meta.ref.level : refLevel)}, potência ${meta.ref ? meta.ref.potencia : 2}), este time tem duelo favorável contra ${wins} dos ${top.length} arquétipos do topo. É o caminho para montar do zero ou comprar no Market.`));
    const row = el('div', 'cand-list');
    for (const x of pick) row.append(candRow(meta, x, top));
    ac.append(row);
    const bc = el('div', 'budget');
    const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.step = '100'; inp.value = String(pvpBudget);
    inp.onchange = () => { pvpBudget = Math.max(0, Number(inp.value) || 0); try { localStorage.setItem('pvpBudget', String(pvpBudget)); } catch {} renderPvp(true); };
    bc.append(el('b', null, 'Orçamento em gemas:'), inp);
    let left = pvpBudget; const buy = [];
    for (const x of cand.slice(0, 40).filter((y) => !mine.some((m) => m.speciesId === y.speciesId))) {
      const { r } = priceRow(meta, x.nome); const pr = r && Number(r.minOrb);
      if (pr > 0 && pr <= left && buy.length < 5) { buy.push([x, pr]); left -= pr; }
    }
    bc.append(el('span', 'sub', buy.length ? `Dá para comprar: ${buy.map(([x, p]) => `${x.nome} (${fmt(p)} 💎)`).join(' + ')} · sobram ${fmt(left)} 💎. Preço "a partir de" (o mais barato à venda, qualquer nível), lido na atualização do meta.` : 'Nenhum dos melhores candidatos com preço em gemas lido cabe nesse valor.'));
    ac.append(bc);
    root.append(ac);
  }

  if (top.length && cand.length) {
    const cc = el('div', 'card');
    cc.append(el('div', 'ext-sec', 'Contra cada arquétipo: quem mais vence'));
    for (const a of top) {
      const vistos = new Set();
      const best = [...cand].filter((x) => x.porArq && x.porArq[a.id] != null).sort((x, y) => y.porArq[a.id] - x.porArq[a.id]).filter((x) => !vistos.has(x.nome) && vistos.add(x.nome)).slice(0, 4);
      const r = el('div', 'pn-row');
      const lab = el('div', 'pu-n'); lab.append(el('b', null, arqName(a, meta)), el('span', 'sub', `tier ${a.tier}`));
      const tg = el('div', 'pm-tags');
      for (const x of best) { const own = mine.some((m) => m.speciesId === x.speciesId); const s2 = el('span', `pn-p${own ? ' ok' : ''}`, `${shortName(x.nome)} ${pct(x.porArq[a.id])}`); s2.title = own ? 'Você tem' : 'Você não tem'; tg.append(s2); }
      r.append(lab, tg);
      cc.append(r);
    }
    cc.append(el('div', 'mempty', 'Porcentagem: duelos 1×1 vencidos contra os pokémon dos times desse arquétipo, no nível típico do top. Verde = você já tem.'));
    root.append(cc);
  }
}
function candRow(meta, x, top) {
  const r = el('div', 'cand');
  const left = el('div', 'pu-n');
  left.append(el('b', null, `${x.nome}${x.lend ? ' · lendário' : ''}`), el('span', 'sub', `vence ${pct(x.win)} dos duelos contra o top · ${top.filter((a) => ((x.porArq || {})[a.id] ?? 0) >= 0.5).length}/${top.length} arquétipos`));
  const tg = el('div', 'pm-tags'); for (const tt of x.tipos) tg.append(tipoChip(tt)); if (x.z) tg.append(zChip(x.z));
  const { box } = priceRow(meta, x.nome);
  r.append(left, tg, box, watchBtn(x.nome));
  return r;
}

// ================= PLANEJADOR =================
function renderPvpPlan(root, c) {
  const { meta, entries, tab, refLevel, mine, arqs } = c;
  if (!pvpPlan) { try { pvpPlan = JSON.parse(localStorage.getItem(`pvpPlan:${pvpAcc}`) || 'null'); } catch {} }
  if (!pvpPlan) pvpPlan = pvpSuggest(mine, entries, tab, refLevel).map((x) => x.c.speciesId);
  pvpPlan = pvpPlan.filter((id) => mine.some((m) => m.speciesId === id)).slice(0, 5);
  const savePlan = () => { try { localStorage.setItem(`pvpPlan:${pvpAcc}`, JSON.stringify(pvpPlan)); } catch {} };
  const team = pvpPlan.map((id) => mine.find((m) => m.speciesId === id)).filter(Boolean).sort((a, b) => a.alcance - b.alcance);
  const top = arqs.filter((a) => a.tier !== 'U');
  if (pvpArqSel == null || !arqs.some((a) => a.id === pvpArqSel)) pvpArqSel = top[0] ? top[0].id : (arqs[0] ? arqs[0].id : null);
  const arq = arqs.find((a) => a.id === pvpArqSel);
  const enemy = arq ? arqTeam(arq, meta).sort((a, b) => a.alcance - b.alcance) : [];

  const pc = el('div', 'card pvp-plan');
  const ph = el('div', 'pvp-sh');
  ph.append(el('div', 'ext-sec', `Planejador (${team.length}/5)`));
  const vsSel = el('select');
  for (const a of arqs) { const o = el('option', null, `${a.tier === 'U' ? '—' : a.tier} · ${arqName(a, meta)} (${a.n})`); o.value = String(a.id); vsSel.append(o); }
  vsSel.value = String(pvpArqSel);
  vsSel.onchange = () => { pvpArqSel = Number(vsSel.value); renderPvp(true); };
  const right = el('div', 'actions'); right.style.margin = '0';
  right.append(el('span', 'sub', 'Contra:'), vsSel, button('Limpar', 'mini', () => { pvpPlan = []; savePlan(); renderPvp(true); }));
  ph.append(right);
  pc.append(ph);
  const body = el('div', 'pp-body');
  const left = el('div', 'pp-left');
  const q = el('input'); q.type = 'text'; q.placeholder = 'Buscar seu pokémon…'; q.value = pvpBusca;
  q.oninput = () => { pvpBusca = q.value; const pos = q.selectionStart; renderPvp(true).then(() => { const n = $('#page-pvp .pp-left input'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
  left.append(q);
  const list = el('div', 'pp-list');
  for (const m of mine.filter((x) => !pvpBusca || x.nome.toLowerCase().includes(pvpBusca.toLowerCase())).slice(0, 80)) {
    const on = pvpPlan.includes(m.speciesId);
    const b = el('button', `pp-item${on ? ' on' : ''}`);
    b.append(el('b', null, m.nome), el('span', null, `Nv ${fmt(m.level)} · ${alcIcon(m.alcance)}${m.aoe ? ' · AoE' : ''}${m.el ? ` · Z ${TIPO_PT[String(m.el).toUpperCase()] || m.el}` : ''}`));
    b.onclick = () => { if (on) pvpPlan = pvpPlan.filter((x) => x !== m.speciesId); else if (pvpPlan.length < 5) pvpPlan.push(m.speciesId); else return toast('O time tem no máximo 5. Tire um antes.'); savePlan(); renderPvp(true); };
    list.append(b);
  }
  left.append(list);
  const mid = el('div', 'pp-mid');
  const enemyPlaces = pvpPlace(enemy);
  const boardBox = el('div');
  const tipsBox = el('div', 'pp-tips');
  const aoeInimigo = enemy.filter((e) => e.aoe).length;
  const spread = aoeInimigo >= 3;
  const draw = (alvos) => {
    const mine2 = pvpPlaceVs(team, alvos || team.map(() => null), enemyPlaces, spread);
    boardBox.replaceChildren(boardEl([{ team: enemy, places: enemyPlaces, cls: 'enemy', flip: true }, { team, places: mine2, cls: 'mine', flip: false }]));
  };
  draw(null);
  mid.append(el('div', 'pp-front', arq ? `Adversário previsto: time de ${arq.rep} (#${arq.best}), arquétipo ${arqName(arq, meta)}` : 'Sem arquétipo'), boardBox, el('div', 'pp-front', 'Você (embaixo). Monte igual no "Editar tabuleiro" do jogo.'));
  const rightCol = el('div', 'pp-right');
  if (!team.length) rightCol.append(el('div', 'mempty', 'Escolha até 5 pokémon na lista para ver a simulação contra esse time e o posicionamento sugerido.'));
  else if (!enemy.length) rightCol.append(el('div', 'mempty', 'Atualize o meta para ter os times do topo.'));
  else {
    const res = el('div', 'pp-sum'); res.append(el('b', null, 'Simulando com o duelo 1×1 do jogo…'));
    rightCol.append(res, tipsBox);
    simTeam(team, enemy).then((sres) => {
      if (!sres) { res.replaceChildren(el('b', null, 'Não deu para simular agora (a conta precisa estar aberta no app).')); return; }
      const used = new Set();
      const alvos = team.map((_, i) => { const ord = sres.m[i].map((p, j) => [p, j]).sort((a, b) => b[0] - a[0]); const pick = ord.find(([, j]) => !used.has(j)) || ord[0]; used.add(pick[1]); return pick[1]; });
      draw(alvos);
      const v = sres.est >= 0.55 ? 'ok' : sres.est >= 0.45 ? 'meh' : 'bad';
      res.replaceChildren(el('b', `big ${v}`, `${pct(sres.est)} de força contra este time`), el('span', null, v === 'ok' ? 'Você é favorito.' : v === 'meh' ? 'Luta equilibrada: o posicionamento decide.' : 'Você é azarão: veja as dicas e o Upgrade em "Meu time".'));
      tipsBox.replaceChildren();
      const add = (txt, cls) => tipsBox.append(el('div', `tip ${cls || ''}`, txt));
      team.forEach((m, i) => { const j = alvos[i]; const e = enemy[j]; add(`${shortName(m.nome)} → fique de frente para ${shortName(e.nome)}: vence o 1×1 em ${pct(sres.m[i][j])}.`, sres.m[i][j] >= 0.5 ? 'ok' : 'bad'); });
      if (spread) add(`O time deles tem ${aoeInimigo} com AoE: deixe espaço entre os seus (o tabuleiro já está espalhado).`, 'warn');
      else add('Pouco AoE do outro lado: dá para juntar o time e focar o mesmo alvo.', '');
      const meleeThem = enemy.filter((e) => e.alcance <= 1);
      const tank = [...team].sort((a, b) => ((b.stats ? b.stats.hp + b.stats.def + b.stats.spd : 0) - (a.stats ? a.stats.hp + a.stats.def + a.stats.spd : 0)))[0];
      if (meleeThem.length >= 2 && tank) add(`${meleeThem.length} deles batem corpo a corpo: ${shortName(tank.nome)} (mais HP e defesa) segura melhor a frente.`, '');
      const ranged = enemy.filter((e) => e.alcance >= 3);
      if (ranged.length) add(`Atiradores de longe deles: ${ranged.map((e) => shortName(e.nome)).join(', ')}. Quem tem alcance alto do seu lado chega à retaguarda deles.`, '');
      const lvl = Math.round(team.reduce((s, m) => s + m.level, 0) / team.length);
      const lvlE = Math.round(enemy.reduce((s, m) => s + m.level, 0) / enemy.length);
      if (lvl < lvlE * 0.7) add(`Nível médio ${fmt(lvl)} contra ${fmt(lvlE)}: no duelo do jogo o nível pesa muito. Suba os escolhidos.`, 'warn');
      const mx = el('div', 'pp-matrix');
      const hd = el('div', 'pm-row hd'); hd.append(el('span', null, 'Seu'), ...enemy.map((e) => el('span', null, shortName(e.nome))));
      mx.append(hd);
      team.forEach((m, i) => { const r = el('div', 'pm-row'); r.append(el('span', null, shortName(m.nome))); sres.m[i].forEach((p) => r.append(el('span', p >= 0.55 ? 'ok' : p >= 0.45 ? 'meh' : 'bad', pct(p)))); mx.append(r); });
      tipsBox.append(el('div', 'ext-sec', 'Duelos 1×1 (chance de vencer)'), mx);
    });
  }
  body.append(left, mid, rightCol);
  pc.append(body);
  root.append(pc);
}

// ================= HISTÓRICO =================
function renderPvpHist(root) {
  const me = (pvpData.me || []).slice().sort((a, b) => a.t - b.t);
  const live = pvpData.live || {};
  const p = live.euPvp || null;
  const card = el('div', 'card');
  card.append(el('div', 'ext-sec', 'Seu PvP agora'));
  const row = el('div', 'pvp-me-row six');
  const stat = (v, l) => { const d = el('div', 'fstat'); d.append(el('b', null, v), el('span', null, l)); return d; };
  if (p) {
    row.append(stat(`${p.tierId || '—'} ${p.divisaoNum || ''}`.trim(), 'tier'), stat(fmt(p.pontos), 'PR'), stat(fmt(p.pico), 'pico'),
      stat(`${fmt(p.vitorias)} / ${fmt(p.derrotas)}`, 'vitórias / derrotas'), stat(pct(p.vitorias / Math.max(1, p.vitorias + p.derrotas)), 'de vitórias'),
      stat(p.sequencia ? `${p.sequencia > 0 ? '+' : ''}${p.sequencia}` : '0', 'sequência'));
    card.append(row);
    if (p.decaiEm) card.append(el('div', 'tip warn', `Decaimento: sem jogar, o PR começa a cair em ${new Date(p.decaiEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.`));
    if (!p.partidas) card.append(el('div', 'mempty', 'Esta conta ainda não jogou o Ranqueado.'));
  } else card.append(el('div', 'mempty', 'Abra a conta no PokeIdle para ler o PvP dela.'));
  root.append(card);
  const gc = el('div', 'card');
  gc.append(el('div', 'ext-sec', 'PR nos últimos 30 dias (foto de hora em hora, guardada neste PC)'));
  if (me.length < 2) gc.append(el('div', 'mempty', 'O gráfico aparece depois de algumas horas com o app aberto (uma foto por hora, quando algo muda).'));
  else {
    const W = 900, H = 180, P = 28;
    const t0 = me[0].t, t1 = me[me.length - 1].t;
    const prs = me.map((r) => r.pr); const lo = Math.min(...prs), hi = Math.max(...prs, lo + 10);
    const x = (tt) => P + ((tt - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
    const y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
    const pts = me.map((r) => `${x(r.t).toFixed(1)},${y(r.pr).toFixed(1)}`).join(' ');
    const box = el('div');
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="pr-chart"><line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" class="ax"/><text x="${P}" y="${P - 8}" class="lb">${fmt(hi)} PR</text><text x="${P}" y="${H - 8}" class="lb">${fmt(lo)} PR</text><polyline points="${pts}" class="ln"/>${me.map((r) => `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.pr).toFixed(1)}" r="2.5" class="pt"><title>${new Date(r.t).toLocaleString('pt-BR')} · ${r.pr} PR · ${r.v}V/${r.d}D</title></circle>`).join('')}</svg>`;
    gc.append(box);
    const byDay = new Map();
    for (const r of me) { const k = new Date(r.t).toLocaleDateString('pt-BR'); const cur = byDay.get(k) || { first: r, last: r }; cur.last = r; byDay.set(k, cur); }
    const days = el('div', 'pvp-days');
    const hd = el('div', 'pd-row hd'); hd.append(el('span', null, 'Dia'), el('span', null, 'Vitórias'), el('span', null, 'Derrotas'), el('span', null, 'PR'));
    days.append(hd);
    for (const [k, d] of [...byDay.entries()].slice(-10).reverse()) {
      const dv = d.last.v - d.first.v, dd = d.last.d - d.first.d, dp = d.last.pr - d.first.pr;
      const r = el('div', 'pd-row'); r.append(el('span', null, k), el('span', 'ok', `+${dv}`), el('span', 'bad', `+${dd}`), el('span', dp >= 0 ? 'ok' : 'bad', `${dp >= 0 ? '+' : ''}${dp}`));
      days.append(r);
    }
    gc.append(days);
  }
  root.append(gc);
}
