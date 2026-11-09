// Idleterino — aba PvE: a hunt de agora, as próximas hunts e "evoluir para qual?".
// Tudo vem do próprio jogo (hunts, tipos, tabela de dano, evoluções e megas) pela conta escolhida.
// Só leitura: o app mostra e sugere; quem evolui e troca de hunt é a pessoa, no jogo.
let pveAcc = (() => { try { return localStorage.getItem('pveAcc') || null; } catch { return null; } })();
let pveTab = (() => { try { return localStorage.getItem('pveTab') || 'agora'; } catch { return 'agora'; } })();
let pveEvoSel = null;   // speciesId escolhido no "evoluir para qual?"
let pveBuscaTxt = '';
const pveCache = new Map(); // `${acc}|${o}|${arg}` -> { at, v }

async function pveGet(o, arg, maxIdadeMs = 60000) {
  const k = `${pveAcc}|${o}|${arg == null ? '' : arg}`;
  const c = pveCache.get(k);
  if (c && Date.now() - c.at < maxIdadeMs) return c.v;
  const v = await call('poke:pve', pveAcc, o, arg);
  pveCache.set(k, { at: Date.now(), v });
  return v;
}
const xTxt = (x) => `×${Number(x || 0).toFixed(x >= 10 ? 0 : 1).replace('.', ',')}`;
const diaAviso = (tipo, seu) => {
  if (!tipo) return null;
  const d = el('div', 'pve-dia');
  d.append(el('b', null, '📅 Dia Sazonal: '), tipoChip(tipo), el('span', null, seu
    ? ' — o seu pokémon em campo é desse tipo: bate o dobro e apanha ¼ hoje nas hunts.'
    : ' — hoje os pokémon desse tipo (os seus e os selvagens) batem o dobro e apanham ¼ nas hunts. Hunt de selvagem desse tipo fica mais difícil.'));
  return d;
};
const xCls = (x) => (x >= 5 ? 'x55' : x >= 2.4 ? 'x25' : x >= 1 ? 'x1' : 'x0');

async function renderPve() {
  const root = $('#page-pve');
  const accs = (S.poke && S.poke.accounts || []).filter((a) => a.isPoke);
  if (!accs.length) { root.replaceChildren(emptyBox('PvE', 'Adicione uma conta do PokeIdle para ver as hunts e as evoluções.')); return; }
  if (!pveAcc || !accs.some((a) => a.id === pveAcc)) pveAcc = S.poke.mainId || accs[0].id;
  root.replaceChildren();
  const head = el('header', 'page-head');
  const t = el('div');
  t.append(el('h1', null, 'PvE'), el('p', 'sub', 'Hunt de agora, próximas hunts e qual evolução vale mais, com as regras e os números do próprio jogo.'));
  const act = el('div', 'actions'); act.style.margin = '0';
  const sel = el('select');
  for (const a of accs) { const i = a.info || {}; const o = el('option', null, `${a.id === S.poke.mainId ? '★ ' : ''}${i.logged && i.nick && i.nick !== '—' ? i.nick : a.name}`); o.value = a.id; sel.append(o); }
  sel.value = pveAcc;
  sel.onchange = () => { pveAcc = sel.value; pveEvoSel = null; try { localStorage.setItem('pveAcc', pveAcc); } catch {} renderPve(); };
  act.append(sel);
  head.append(t, act);
  const tabs = el('div', 'pvp-tabs');
  for (const [k, l] of [['agora', '🎯 Hunt agora'], ['proximas', '🗺️ Próximas hunts'], ['evo', '🧬 Evoluir para qual?'], ['mercado', '🛒 Comprar para farmar']]) {
    tabs.append(button(l, pveTab === k ? 'on' : '', () => { pveTab = k; try { localStorage.setItem('pveTab', k); } catch {} renderPve(); }));
  }
  root.append(head, tabs);
  const corpo = el('div', 'pve-corpo');
  root.append(corpo);
  if (pveTab === 'agora') pveAgora(corpo, accs.find((a) => a.id === pveAcc));
  else if (pveTab === 'proximas') await pveProximas(corpo);
  else if (pveTab === 'mercado') pveMercado(corpo, accs.find((a) => a.id === pveAcc));
  else await pveEvo(corpo);
}

// ---------- 🎯 Hunt agora (a Melhor hunt que o app já calcula, mais completa) ----------
function pveAgora(box, a) {
  const hr = a && a.info && a.info.huntRank;
  if (!hr || !hr.pronto) { box.append(emptyBox('Calculando…', 'A conta precisa estar logada e caçando. Em até 1 minuto aparece aqui.')); return; }
  if (hr.semPokemon) { box.append(emptyBox('Sem pokémon em campo', 'Ponha um pokémon em campo no jogo para o app calcular as hunts.')); return; }
  const top = el('div', 'card pve-top');
  const pk = el('div', 'pve-pk');
  pk.append(el('b', null, hr.pokemon), el('span', 'tipos'));
  for (const tp of hr.tipos || []) pk.lastChild.append(tipoChip(tp));
  const extras = [hr.aoe ? '💥 AoE' : null, hr.bike ? `🚲 bike ${hr.bike}` : null, hr.bonus > 1 ? `bônus de XP ×${String(hr.bonus).replace('.', ',')}` : null].filter(Boolean).join(' · ');
  if (extras) pk.append(el('span', 'sub', extras));
  top.append(el('h3', null, 'Pokémon em campo'), pk);
  const da = diaAviso(hr.tipoDia, hr.seuDoDia); if (da) top.append(da);
  const at = hr.atualEst;
  // O placar REAL da sessão (o mesmo do painel do jogo); a estimativa só serve para comparar hunts.
  const ss = a.info && a.info.sess;
  const porH = (v) => (ss && ss.ms > 0 ? Math.round((v * 3600000) / ss.ms) : 0);
  if (at) {
    const g = el('div', 'pve-atual');
    g.append(el('span', 'sub', 'Hunt atual'), el('b', null, `${at.nome} · Nv ${fmt(at.nivel)}`),
      el('span', `pve-x ${xCls(at.effH)}`, `dano ${xTxt(at.effH)}`));
    if (ss && ss.ms > 60000) g.append(el('span', null, `${fmt(porH(ss.xpTreinador))} XP/h`), el('span', 'gold', `${fmt(porH(ss.gold))} ouro/h`), el('span', 'sub', `(placar real da sessão, ${Math.round(ss.ms / 60000)} min)`));
    g.append(el('span', at.risco > 1.4 ? 'warn' : 'sub', at.risco > 1.4 ? '⚠ apanha bastante' : 'apanha pouco'));
    top.append(g);
  }
  const rel = (v, base) => { if (!base || !v) return { t: '—', c: 'sub' }; const p = Math.round((v / base - 1) * 100); return p === 0 ? { t: 'igual', c: 'sub' } : { t: `${p > 0 ? '+' : ''}${p}%`, c: p > 0 ? 'up' : 'down' }; };
  box.append(top);
  const tabela = (titulo, lista, campo) => {
    const c = el('div', 'card');
    c.append(el('h3', null, titulo));
    const tb = el('div', 'pve-tab');
    const hd = el('div', 'pve-row hd'); for (const h of ['Hunt', 'Nv', 'Dano', 'XP vs atual', 'Ouro vs atual', 'Risco']) hd.append(el('span', null, h)); tb.append(hd);
    for (const h of lista) {
      const r = el('div', `pve-row${hr.atual && h.slug === hr.atual ? ' atual' : ''}`);
      r.append(el('span', 'n', `${h.selvagemDoDia ? '💪 ' : ''}${h.nome}${hr.atual && h.slug === hr.atual ? ' (atual)' : ''}${h.medidoMin ? ' ✓' : ''}`), el('span', null, fmt(h.nivel)), el('span', `pve-x ${xCls(h.effH)}`, xTxt(h.effH)),
        (() => { const x = rel(h.xpH, at && at.xpH); return el('span', `${x.c}${campo === 'xp' ? ' b' : ''}`, x.t); })(), (() => { const x = rel(h.goldLiq, at && at.goldLiq); return el('span', `${x.c}${campo === 'ouro' ? ' b' : ''}`, x.t); })(), el('span', h.risco > 1.4 ? 'warn' : 'sub', h.risco > 1.4 ? 'alto' : h.risco > 1 ? 'médio' : 'baixo'));
      if (h.medidoMin) r.title = `Medido de verdade: ${h.medidoMin} min nesta hunt com este pokémon`;
      tb.append(r);
    }
    c.append(tb);
    return c;
  };
  const grid = el('div', 'pvp-grid');
  grid.append(tabela('⚡ Mais XP por hora', hr.top || [], 'xp'), tabela('💰 Mais ouro por hora (já tirando poção)', hr.topOuro || [], 'ouro'));
  box.append(grid, el('p', 'small', 'A comparação usa as fórmulas do jogo (dano, vida dos selvagens, ritmo do mapa) com este pokémon em campo. ✓ = hunt medida de verdade (10+ min com ele). O 🧪 Laboratório do Início mede na prática.'));
}

// ---------- 🗺️ Próximas hunts ----------
async function pveProximas(box) {
  box.append(el('p', 'sub', 'Carregando as próximas hunts…'));
  const r = await pveGet('proximas');
  if (page !== 'pve' || pveTab !== 'proximas') return;
  box.replaceChildren();
  if (!r || r.erro || !r.pronto) { box.append(emptyBox('Ainda não deu', (r && r.erro) || 'A conta precisa estar logada no jogo. Tente de novo em instantes.')); return; }
  if (!r.grupos.length) { box.append(emptyBox('Você já liberou todas as hunts', 'Não há hunt acima do seu nível.')); return; }
  { const da = diaAviso(r.tipoDia, false); if (da) box.append(da); }
  box.append(el('p', 'sub', `Treinador no Nv ${fmt(r.L)}. Os próximos níveis de hunt que você libera, com o tipo de cada selvagem, quem toma ×2,5 ou ×5,5 e qual pokémon seu (até o seu nível +5) bate mais forte.`));
  for (const g of r.grupos) {
    const c = el('div', 'card');
    c.append(el('h3', null, `Nv ${fmt(g.nivel)} · ${g.hunts.length} hunt${g.hunts.length > 1 ? 's' : ''}${g.nivel - r.L > 0 ? ` · faltam ${fmt(g.nivel - r.L)} níveis` : ''}`));
    const lista = el('div', 'pve-lista');
    const mostra = (n) => {
      lista.replaceChildren();
      for (const h of g.hunts.slice(0, n)) {
        const row = el('div', 'pve-hunt');
        const nm = el('div', 'pve-hn'); nm.append(el('b', null, `${h.doDia ? '💪 ' : ''}${h.nome}`)); if (h.doDia) nm.title = 'Selvagem do tipo do Dia Sazonal: hoje ele bate o dobro e apanha ¼.'; const tps = el('span', 'tipos'); for (const tp of h.tipos) tps.append(tipoChip(tp)); nm.append(tps);
        const atk = el('div', 'pve-atk'); atk.append(el('span', 'sub', 'toma forte de'));
        for (const a of h.ataques) { const ch = tipoChip(a.t); ch.append(el('i', `pve-x ${xCls(a.x)}`, ` ${xTxt(a.x)}`)); atk.append(ch); }
        if (!h.ataques.length) atk.append(el('span', 'sub', 'nenhum tipo passa de ×2,5'));
        const meu = el('div', 'pve-meu');
        if (h.meu && h.meu.x >= 1) { meu.append(el('span', 'sub', 'seu melhor'), el('b', null, h.meu.nome), el('span', `pve-x ${xCls(h.meu.x)}`, xTxt(h.meu.x))); } else meu.append(el('span', 'warn', 'nenhum seu bate forte aqui'));
        row.append(nm, atk, meu);
        lista.append(row);
      }
      if (g.hunts.length > n) lista.append(button(`Ver as ${g.hunts.length} hunts`, 'ghost', () => mostra(g.hunts.length)));
    };
    mostra(10);
    c.append(lista);
    box.append(c);
  }
}

// ---------- 🧬 Evoluir para qual? ----------
async function pveEvo(box) {
  const lay = el('div', 'pve-evo');
  const esq = el('div', 'card pve-evo-esq');
  const dir = el('div', 'pve-evo-dir');
  lay.append(esq, dir);
  box.append(lay);
  esq.append(el('h3', null, 'Escolha o pokémon'));
  const q = el('input'); q.type = 'text'; q.placeholder = 'Buscar espécie (ex.: Eevee, Ralts, Kirlia)'; q.value = pveBuscaTxt;
  const res = el('div', 'pve-busca');
  let tm = null;
  q.oninput = () => { pveBuscaTxt = q.value; clearTimeout(tm); tm = setTimeout(async () => { const l = q.value.trim().length >= 2 ? await pveGet('buscar', q.value.trim(), 600000) : []; res.replaceChildren(); for (const s of l || []) { const b = button(s.nome, 'pve-op', () => { pveEvoSel = s.speciesId; renderPve(); }); res.append(b); } }, 250); };
  esq.append(q, res, el('b', 'tipos-hd', 'Seus pokémon'));
  const meusBox = el('div', 'pve-meus');
  esq.append(meusBox);
  const meus = await pveGet('meus');
  if (page !== 'pve' || pveTab !== 'evo') return;
  for (const m of (Array.isArray(meus) ? meus : [])) {
    const b = button('', `pve-op${pveEvoSel === m.speciesId ? ' on' : ''}`, () => { pveEvoSel = m.speciesId; renderPve(); });
    b.append(el('b', null, `${m.shiny ? '✨ ' : ''}${m.nome}`), el('span', 'sub', ` Nv ${fmt(m.level)}`));
    meusBox.append(b);
  }
  if (!Array.isArray(meus) || !meus.length) meusBox.append(el('p', 'sub', 'A lista aparece quando a conta estiver logada.'));
  if (!pveEvoSel) { dir.append(emptyBox('Evoluir para qual?', 'Escolha um pokémon seu ou busque uma espécie. O app mostra todos os caminhos (com o nível e a pedra), as Megas, e compara para farmar nas suas próximas hunts e para o PvP.')); return; }
  dir.append(el('p', 'sub', 'Calculando…'));
  const [r, pvp] = await Promise.all([pveGet('evolucoes', pveEvoSel), call('poke:pvp:get', pveAcc).catch(() => null)]);
  if (page !== 'pve' || pveTab !== 'evo') return;
  dir.replaceChildren();
  if (!r || r.erro) { dir.append(emptyBox('Não deu para calcular', (r && r.erro) || 'Tente de novo em instantes.')); return; }
  // Uso no PvP: quantos dos times do top 50 levam a espécie.
  // Pelo NOME: o jogo cria algumas Megas com mais de um número (a do clone de Hoenn), e o nome é o mesmo.
  const usoPvp = {};
  const info = (pvp && pvp.meta && pvp.meta.info) || {};
  const perfis = pvp && pvp.meta && pvp.meta.perfis ? Object.values(pvp.meta.perfis) : [];
  for (const p of perfis) {
    const vistos = new Set();
    for (const k of p.time || []) { const n = k.nome || (info[k.speciesId] || {}).nome; if (n && !vistos.has(n)) { vistos.add(n); usoPvp[n] = (usoPvp[n] || 0) + 1; } }
  }
  const todas = [];
  for (const o of r.opcoes) { todas.push({ ...o.final, caminho: o.passos }); for (const m of o.megas) todas.push({ ...m, caminho: o.passos, deMega: o.final.nome }); }
  for (const x of todas) { x.pvp = usoPvp[x.nome] || 0; x.farm = (x.x55 * 2 + x.x25) * x.ataque; }
  const melhor = (f) => todas.reduce((b, x) => (!b || f(x) > f(b) ? x : b), null);
  const mFarm = melhor((x) => x.farm), mPvp = perfis.length ? melhor((x) => x.pvp * 1000 + x.bst) : null, mBst = melhor((x) => x.bst);
  const cab = el('div', 'card');
  const ttp = el('span', 'tipos'); for (const tp of r.base.tipos) ttp.append(tipoChip(tp));
  cab.append(el('h3', null, `${r.base.nome}`), ttp);
  if (!r.opcoes.length || (r.opcoes.length === 1 && !r.opcoes[0].passos.length && !r.opcoes[0].megas.length)) cab.append(el('p', 'sub', 'Esta espécie não evolui nem tem Mega.'));
  else {
    const v = el('div', 'pve-veredito');
    if (mFarm) v.append(el('span', 'pve-badge farm', `🌾 Para farmar: ${mFarm.nome}`));
    if (mPvp && mPvp.pvp) v.append(el('span', 'pve-badge pvp', `⚔ Para PvP: ${mPvp.nome} (${mPvp.pvp} do top 50)`));
    if (mBst) v.append(el('span', 'pve-badge bst', `⭐ Mais forte: ${mBst.nome} (status ${fmt(mBst.bst)})`));
    cab.append(v, el('p', 'small', `Farm = hunts com ×2,5 e ×5,5 do Nv ${fmt(Math.round(r.L * 0.8))} ao Nv ${fmt(Math.max(r.L * 3, r.L + 3000))} (as suas próximas regiões), pelo tipo e pelo melhor status de ataque. PvP = quantos times do top 50 usam a espécie${perfis.length ? '' : ' (o meta do PvP ainda não foi lido: abra a aba PvP)'}.`));
  }
  dir.append(cab);
  for (const o of r.opcoes) {
    if (!o.passos.length && !o.megas.length) continue;
    const c = el('div', 'card pve-opcao');
    const cam = o.passos.map((p) => `${p.para} (Nv ${fmt(p.nivel)}${p.pedra ? ` · ${p.pedra}` : ''}${p.temArte ? '' : ' · sem arte ainda'})`).join(' → ');
    if (cam) c.append(el('p', 'pve-cam', `${r.base.nome} → ${cam}`));
    const linha = (x, mega) => {
      const d = el('div', `pve-final${mega ? ' mega' : ''}`);
      const n = el('div', 'pve-fn'); n.append(el('b', null, `${mega ? '💎 ' : ''}${x.nome}`)); const tps = el('span', 'tipos'); for (const tp of x.tipos) tps.append(tipoChip(tp)); n.append(tps);
      const badges = el('span', 'pve-bs');
      if (x === mFarm) badges.append(el('span', 'pve-badge farm', '🌾 farm'));
      if (mPvp && x === mPvp && x.pvp) badges.append(el('span', 'pve-badge pvp', '⚔ PvP'));
      if (x === mBst) badges.append(el('span', 'pve-badge bst', '⭐ status'));
      n.append(badges);
      const nums = el('div', 'pve-nums');
      nums.append(el('span', null, `status ${fmt(x.bst)}`), el('span', null, `${x.fisico ? 'ATK' : 'SP.ATK'} ${fmt(x.ataque)}`),
        el('span', 'pve-x x25', `${x.x25} hunts ×2,5`), el('span', 'pve-x x55', `${x.x55} hunts ×5,5`), el('span', x.pvp ? 'pvp' : 'sub', perfis.length ? `PvP: ${x.pvp ? `${x.pvp} do top 50` : 'fora do top'}` : 'PvP: —'));
      if (mega) nums.append(el('span', 'sub', `precisa da Mega Stone (${x.deMega || ''})`));
      d.append(n, nums);
      return d;
    };
    const finalAvaliado = todas.find((x) => x.pokeId === o.final.pokeId && !x.deMega);
    c.append(linha(finalAvaliado || o.final, false));
    for (const m of o.megas) c.append(linha(todas.find((x) => x.pokeId === m.pokeId && x.deMega) || m, true));
    dir.append(c);
  }
  dir.append(el('p', 'small', 'Nível e pedra de cada evolução vêm das regras do próprio jogo. Shiny pede a Shiny Stone do mesmo tipo. A nota do pokémon sobe sempre que ele evolui (regra do jogo).'));
}

// ---------- 🛒 Comprar no Market para farmar (com o seu orçamento) ----------
let pveBudget = (() => { try { return localStorage.getItem('pveBudget') || ''; } catch { return ''; } })();
let pveMoeda = 'orb';
let pveBusca = null; // { carregando, valor, moeda, lista, erro, em, L, huntsAlvo, acc }
function pveMercado(box, a) {
  const i = (a && a.info) || {};
  const L = Number(String(i.level || '').replace(/\D+/g, '')) || 0;
  const c = el('div', 'card');
  c.append(el('div', 'ext-sec', 'Comprar no Market com o seu orçamento (para farmar)'));
  c.append(el('div', 'sub up-lead', `${L ? `Treinador Nv ${fmt(L)}: esta conta usa pokémon até Nv ${fmt(L + 5)}, e a sugestão só inclui o que ela pode usar. ` : ''}Diga quanto quer gastar. O app procura agora as ofertas mais baratas dos pokémon que mais rendem nas SUAS próximas hunts (os que tiram ×2,5 e ×5,5) e avalia cada pokémon à venda pelo ataque de verdade dele (nível, IV, qualidade, potência, shiny, TM e AoE). Os preços mudam o tempo todo: a busca é sempre na hora.`));
  const form = el('div', 'budget');
  const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.step = '100'; inp.placeholder = 'Quanto quer gastar?'; inp.value = pveBudget;
  inp.oninput = () => { pveBudget = inp.value; try { localStorage.setItem('pveBudget', pveBudget); } catch {} };
  const msel = el('select'); for (const [v, l] of [['orb', 'em gemas 💎'], ['gold', 'em coins']]) { const o = el('option', null, l); o.value = v; msel.append(o); } msel.value = pveMoeda;
  msel.onchange = () => { pveMoeda = msel.value; };
  const go = button(pveBusca && pveBusca.carregando ? 'Procurando…' : 'Procurar no Market agora', 'primary', async () => {
    const valor = Number(pveBudget);
    if (!(valor > 0)) return toast('Digite quanto quer gastar.');
    pveBusca = { carregando: true, valor, moeda: pveMoeda, acc: pveAcc };
    renderPve();
    const r = await call('poke:pve', pveAcc, 'mercado', pveMoeda);
    pveBusca = { carregando: false, valor, moeda: pveMoeda, acc: pveAcc, lista: (r && r.lista) || [], em: r && r.em, L: r && r.L, huntsAlvo: r && r.huntsAlvo,
      erro: r && r.erro === 'mercado-aberto' ? 'Feche o Market dentro do jogo e tente de novo (com ele aberto, a consulta apareceria na sua tela).' : r && r.erro };
    if (page === 'pve' && pveTab === 'mercado') renderPve();
  });
  go.disabled = !!(pveBusca && pveBusca.carregando);
  form.append(inp, msel, go);
  c.append(form);
  box.append(c);
  if (!pveBusca || pveBusca.acc !== pveAcc) return;
  if (pveBusca.carregando) { c.append(el('div', 'mempty', 'Consultando o Market por esta conta (uma espécie a cada 2,5 s, uns 40 segundos). O jogo segue normal.')); return; }
  const { valor, moeda, lista, erro } = pveBusca;
  if (erro) c.append(el('div', 'tip warn', erro));
  const nm = moeda === 'gold' ? 'coins' : 'gemas';
  const Lc = pveBusca.L || L;
  const usa = (o) => !Lc || o.level <= Lc + 5;
  const noValor = (lista || []).filter((o) => o.moeda === moeda && o.preco > 0 && o.preco <= valor && !o.retido && usa(o) && o.farm > 0);
  // Melhor compra: os que mais rendem, um de cada espécie, que cabem juntos no valor (até 3).
  const ord = [...noValor].sort((x, y) => y.farm - x.farm || x.preco - y.preco);
  const pick = []; let gasto = 0;
  for (const o of ord) { if (pick.length >= 3) break; if (pick.some((p2) => p2.speciesId === o.speciesId)) continue; if (gasto + o.preco > valor) continue; pick.push(o); gasto += o.preco; }
  const fmtP = (o) => { const b = el('b', moeda === 'orb' ? 'orb' : ''); b.append(el('i', `cur ${moeda === 'orb' ? 'orb' : 'gold'}`), fmt(o.preco)); return b; };
  const linha = (o) => {
    const r = el('div', 'cand');
    const l = el('div', 'pu-n'); l.append(el('b', null, `${o.nome} · Nv ${fmt(o.level)}${o.shiny ? ' ✨' : ''}`), el('span', 'sub', `${o.x55} hunts ×5,5 · ${o.x25} hunts ×2,5 · ataque ${fmt(o.ataque)} · vendedor ${o.vendedor || '—'}`));
    if (!usa(o)) l.append(el('span', 'lvl-warn', `precisa de treinador Nv ${fmt(o.level - 5)}`));
    const tg = el('div', 'pm-tags'); for (const tt of o.tipos || []) tg.append(tipoChip(tt)); if (o.el && typeof zChip === 'function') tg.append(zChip(o.el)); if (o.aoe) tg.append(el('span', 'aoechip', 'AoE')); if (o.potencia) tg.append(el('span', 'pn-p', `P${o.potencia}`));
    const pr = el('div', 'price'); pr.append(fmtP(o), el('span', 'sub', o.qtd > 1 ? `${o.qtd} un.` : 'no Market agora'));
    const ver = button('Ver no Market', null, async () => { const r2 = await call('poke:anuncio:abrir', o.anuncio); if (r2 && r2.erro) toast(`⚠ ${r2.erro}`); else { toast('🏪 Abrindo o anúncio no Market…'); go2Poke(); } });
    r.append(l, tg, pr, ver);
    return r;
  };
  if (!lista || !lista.length) { c.append(el('div', 'mempty', `Nenhuma oferta em ${nm} encontrada agora para os pokémon que rendem nas suas próximas hunts.`)); return; }
  c.append(el('div', 'sub up-lead', pick.length
    ? `Com ${fmt(valor)} ${nm}, a melhor compra para farmar agora (${new Date(pveBusca.em || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}): ${pick.length} pokémon por ${fmt(gasto)} ${nm}, sobram ${fmt(valor - gasto)}. Contei ${fmt(pveBusca.huntsAlvo || 0)} hunts das suas próximas regiões.`
    : `Com ${fmt(valor)} ${nm}, nada à venda agora que esta conta possa usar rende nas suas próximas hunts. Abaixo, as melhores ofertas (acima do valor ou do seu nível).`));
  const l1 = el('div', 'cand-list'); for (const o of pick) l1.append(linha(o)); c.append(l1);
  const resto = [...lista].filter((o) => o.moeda === moeda && !pick.includes(o) && o.farm > 0).sort((x, y) => y.farm - x.farm).slice(0, 8);
  if (resto.length) { c.append(el('div', 'ext-sec mk-sub', 'Outras ofertas boas para farmar (algumas acima do seu valor ou do seu nível)')); const l2 = el('div', 'cand-list'); for (const o of resto) l2.append(linha(o)); c.append(l2); }
  c.append(el('div', 'mempty', '"Ver no Market" abre o anúncio no jogo, nesta conta. Confira o nível e o vendedor antes de comprar. A compra é sempre sua.'));
}
function go2Poke() { if (typeof go === 'function') go('poke'); }
