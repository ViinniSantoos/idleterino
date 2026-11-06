// Idleterino 0.3.0 — tela das novidades: modo noite e "Bom dia", Wrapped, Cartão do Treinador,
// avisos (PC, celular, Discord), painel no celular, backups e versões, e as horas logadas.
// Usa as peças do app.js (el, button, call, S, toast, rowOpt, sw, fmt, go, pokeView, closeModal).

S.diario = null;
const refreshDiario = async () => { try { S.diario = await call('app:diario:state'); } catch {} };
refreshDiario();
setInterval(() => { refreshDiario().then(() => { if (page === 'home') renderHome(); }); }, 60 * 1000);
const hm = (ms) => { const m = Math.max(0, Math.round((ms || 0) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
const bigN = (n) => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')}B` : a >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')}M` : a >= 1e4 ? `${Math.round(n / 1e3)}k` : fmt(Math.round(n)); };
const hhmmOf = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function openModal(...nodes) { pokeView(false); $('#modal-card').replaceChildren(...nodes); $('#modal').hidden = false; }
const actionsRow = (...b) => { const a = el('div', 'actions'); a.append(...b); return a; };

// ---------- Horas logadas (lista de contas e Início) ----------
function horasTxt(h, curto) {
  if (!h) return '';
  if (curto) return h.agora ? `⏱ ${hm(h.agora)}` : '';
  return [h.agora ? `logada há ${hm(h.agora)}` : 'fora agora', `hoje ${hm(h.hoje)}`, `7 dias ${hm(h.semana)}`].join(' · ');
}

// ---------- Início: faixa da noite e do recap ----------
function homeExtras() {
  const d = S.diario;
  const box = el('div', 'night-row');
  const n = d && d.noite;
  if (n) {
    const c = el('div', 'card night on');
    const t = el('div', 'nt'); t.append(el('b', null, `🌙 Modo noite ligado desde ${hhmmOf(n.inicio)}`), el('span', null, `Há ${hm(Date.now() - n.inicio)}. Todas em ULTRA e otimizando a cada 1 h. Quando você voltar, sai o relatório.`));
    c.append(t, button('☀ Acordei: ver o relatório', 'primary', acordar));
    box.append(c);
  } else {
    const c = el('div', 'card night');
    const t = el('div', 'nt'); t.append(el('b', null, '🌙 Vai dormir?'), el('span', null, 'O app prepara as contas para a noite e de manhã mostra o que rendeu.'));
    c.append(t, button('🌙 Vou dormir', 'primary', vouDormir));
    const rel = d && d.ultimoRelatorio;
    if (rel && Date.now() - rel.fim < 20 * 3600 * 1000) c.append(button('🌅 Relatório da noite', null, () => mostrarRelatorio(rel)));
    box.append(c);
  }
  const r = el('div', 'card recap');
  const t2 = el('div', 'nt'); t2.append(el('b', null, '🎬 Seu PokeIdle em números'), el('span', null, 'Retrospectiva e cartão para postar.'));
  r.append(t2, button('Wrapped da semana', null, () => abrirWrapped(7)), button('do mês', null, () => abrirWrapped(30)), button('📇 Cartão', null, abrirCartao));
  const lb = button('🧪 Laboratório', null, abrirLab); lb.title = 'Compare hunts medindo de verdade: você troca no jogo, o app mede e dá o veredito.';
  r.append(lb);
  box.append(r);
  const lc = labCard(); if (lc) box.append(lc);
  return box;
}

// ---------- Modo noite ----------
async function vouDormir() {
  const lista = await call('app:diario:noite:check');
  const card = [el('h3', null, '🌙 Preparar a noite'), el('p', null, 'Ao confirmar, o app põe todas as contas no ULTRA (gasta quase nada) e liga o Otimizar a cada 1 h. Quando você voltar, tudo volta como estava e aparece o relatório.')];
  const ul = el('div', 'night-list');
  for (const c of lista) {
    const r = el('div', `nl-row${c.logged ? '' : ' bad'}`);
    r.append(el('b', null, c.nick));
    if (!c.logged) r.append(el('span', 'warn', '⚠ não está logada: entre nela antes de dormir'));
    else if (c.sugestao) {
      if (c.sugestao.mesma) r.append(el('span', 'ok', `✓ ${c.sugestao.nome}: boa para a noite (pouca poção)`));
      else r.append(el('span', c.sugestao.atualArriscada ? 'warn' : null, `${c.sugestao.atualArriscada ? '⚠ A hunt atual gasta poção. ' : ''}Para a noite: ${c.sugestao.nome} (Nv ${fmt(c.sugestao.nivel)}), mais XP com pouca poção. Troque no jogo se quiser.`));
    } else r.append(el('span', null, c.hunt ? `Hunt: ${c.hunt}` : 'A sugestão de hunt aparece quando a conta estiver caçando.'));
    const autos = (c.autos || []).filter((a) => !a.on).map((a) => ({ 'auto-revive': 'reviver', 'auto-potion': 'poção', 'auto-voltar-hunt': 'voltar à hunt' }[a.id])).filter(Boolean);
    if (c.logged && autos.length) r.append(el('span', 'warn', `⚠ No jogo, o automático de ${autos.join(', ')} está desligado.`));
    ul.append(r);
  }
  if (!lista.length) ul.append(el('p', null, 'Nenhuma conta do PokeIdle no app.'));
  card.push(ul, el('p', 'small', 'O app não troca a hunt nem joga por você: ele só sugere. Os avisos de conta parada ou caída chegam no celular se você ligou nos Ajustes.'));
  card.push(actionsRow(button('Cancelar', null, closeModal), button('🌙 Boa noite!', 'primary', async () => { S.diario = await call('app:diario:noite:start'); closeModal(); toast('Boa noite! As contas estão no ULTRA e otimizando a cada 1 h.'); renderHome(); })));
  openModal(...card);
}
async function acordar() {
  const r = await call('app:diario:noite:end');
  S.diario = r.state;
  if (r.rel) mostrarRelatorio(r.rel); else renderHome();
}
function mostrarRelatorio(rel) {
  const tot = rel.contas.reduce((t, c) => { for (const k of ['ms', 'xp', 'gold', 'ab', 'cap', 'shV', 'shC', 'reab', 'quedas']) t[k] = (t[k] || 0) + (c[k] || 0); return t; }, {});
  const nodes = [el('h3', null, '🌅 Bom dia, treinador!'), el('p', null, `Das ${hhmmOf(rel.inicio)} às ${hhmmOf(rel.fim)} (${hm(rel.fim - rel.inicio)}), enquanto você dormia:`)];
  const g = el('div', 'rel-grid');
  const st = (v, l, cls) => { const d = el('div', `rs${cls ? ' ' + cls : ''}`); d.append(el('b', null, v), el('span', null, l)); return d; };
  g.append(st(`+${bigN(tot.xp)}`, 'XP de treinador'), st(`+${bigN(tot.gold)}`, 'ouro', 'gold'), st(fmt(tot.ab), 'abates'), st(fmt(tot.cap), 'capturas'), st(`${fmt(tot.shV)} / ${fmt(tot.shC)}`, '✨ shinys vistos / capt.', tot.shV || tot.shC ? 'shiny' : ''), st(tot.quedas + tot.reab ? `${tot.quedas + tot.reab}` : '0 💪', 'quedas ou travadas'));
  nodes.push(g);
  const lst = el('div', 'rel-contas');
  for (const c of rel.contas) {
    const r = el('div', 'rel-c');
    r.append(el('b', null, c.nick), el('span', null, [`${hm(c.ms)} logada`, `+${bigN(c.xp)} XP`, `+${bigN(c.gold)} ouro`, c.lvl1 > c.lvl0 ? `⬆ Nv ${c.lvl0} → ${c.lvl1}` : null, c.shC ? `✨ ${c.shC} shiny` : null].filter(Boolean).join(' · ')));
    lst.append(r);
  }
  if (rel.contas.length) nodes.push(lst);
  const ev = rel.eventos.filter((e) => ['parada', 'caiu', 'travou', 'voltou'].includes(e.tipo));
  if (ev.length) {
    const ul = el('ul', 'rel-ev');
    for (const e of ev.slice(0, 10).reverse()) ul.append(el('li', null, `${hhmmOf(e.t)} · ${e.nick} ${e.texto}`));
    nodes.push(el('b', null, 'O que aconteceu'), ul);
  } else nodes.push(el('p', 'ok-line', '✓ Noite perfeita: nenhuma conta caiu nem travou.'));
  const img = () => desenharRelatorio(rel, tot);
  nodes.push(actionsRow(button('📋 Copiar imagem', null, async () => { if (await call('app:image:copy', img())) toast('Imagem copiada. Cole no Discord (Ctrl+V).'); }),
    button('💾 Salvar', null, () => call('app:image:save', img(), 'idleterino-bom-dia')), button('Fechar', 'primary', closeModal)));
  openModal(...nodes);
}
window.idle.on('app:bomdia', (rel) => { refreshDiario(); if (document.visibilityState !== 'hidden') mostrarRelatorio(rel); });

// ---------- Desenho das imagens (Bom dia, Wrapped, Cartão) ----------
function tela(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#11121c'); bg.addColorStop(1, '#07080d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const glow = (x, y, r, col) => { const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, col); rg.addColorStop(1, 'transparent'); g.fillStyle = rg; g.fillRect(0, 0, w, h); };
  glow(w * 0.85, h * 0.1, w * 0.6, 'rgba(169,112,255,.22)'); glow(w * 0.1, h * 0.95, w * 0.6, 'rgba(255,77,109,.16)');
  const bar = g.createLinearGradient(0, 0, w, 0); bar.addColorStop(0, '#ff4d6d'); bar.addColorStop(0.5, '#a970ff'); bar.addColorStop(1, '#53fc18');
  g.fillStyle = bar; g.fillRect(0, 0, w, 8);
  const F = '"Segoe UI", system-ui, sans-serif';
  const txt = (s, x, y, size, color = '#eef0f7', weight = 700, align = 'left') => { g.font = `${weight} ${size}px ${F}`; g.fillStyle = color; g.textAlign = align; g.fillText(s, x, y); };
  const caixa = (x, y, ww, hh, val, lab, col) => {
    g.fillStyle = 'rgba(255,255,255,.05)'; g.strokeStyle = 'rgba(255,255,255,.09)'; g.lineWidth = 2;
    g.beginPath(); g.roundRect(x, y, ww, hh, 22); g.fill(); g.stroke();
    txt(val, x + 28, y + hh * 0.52, Math.round(hh * 0.36), col || '#eef0f7', 800); txt(lab, x + 28, y + hh * 0.8, Math.round(hh * 0.16), '#8a90a6', 600);
  };
  const rodape = (s) => txt(s, w / 2, h - 34, 24, '#5d6378', 600, 'center');
  return { c, g, txt, caixa, rodape, w, h };
}
function desenharRelatorio(rel, tot) {
  const T = tela(1080, 1080);
  T.txt('🌅 Bom dia, treinador!', 70, 130, 64, '#eef0f7', 800);
  T.txt(`Noite de ${hm(rel.fim - rel.inicio)} · ${new Date(rel.fim).toLocaleDateString('pt-BR')}`, 72, 185, 30, '#8a90a6', 600);
  const W = 455, H = 170;
  T.caixa(70, 240, W, H, `+${bigN(tot.xp)}`, 'XP de treinador'); T.caixa(555, 240, W, H, `+${bigN(tot.gold)}`, 'ouro', '#ffcf4a');
  T.caixa(70, 440, W, H, fmt(tot.ab), 'abates'); T.caixa(555, 440, W, H, fmt(tot.cap), 'capturas');
  T.caixa(70, 640, W, H, `${fmt(tot.shV)} / ${fmt(tot.shC)}`, '✨ shinys vistos / capturados', '#ffd76a'); T.caixa(555, 640, W, H, tot.quedas + tot.reab ? String(tot.quedas + tot.reab) : '0 💪', 'quedas ou travadas', tot.quedas + tot.reab ? '#ff9f43' : '#45e39b');
  let y = 870;
  for (const c of rel.contas.slice(0, 4)) { T.txt(`${c.nick}`, 72, y, 28, '#eef0f7', 700); T.txt(`${hm(c.ms)} · +${bigN(c.xp)} XP${c.lvl1 > c.lvl0 ? ` · Nv ${c.lvl0}→${c.lvl1}` : ''}`, 1010, y, 26, '#8a90a6', 600, 'right'); y += 40; }
  T.rodape('Idleterino · PokeIdle, Twitch e Kick num app só');
  return T.c.toDataURL('image/png');
}

// ---------- Wrapped ----------
function somaPeriodo(dados, dias) {
  const ate = Date.now();
  const keys = new Set(); for (let i = 0; i < dias; i++) { const d = new Date(ate - i * 86400000); keys.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }
  const tot = { ms: 0, xp: 0, gold: 0, ab: 0, cap: 0, shV: 0, shC: 0, reab: 0, quedas: 0 };
  const porConta = []; const hunts = {}; const porDia = {};
  for (const c of Object.values(dados.contas)) {
    const pc = { nick: c.nick, ms: 0, xp: 0, gold: 0, lvl0: 0, lvl1: 0, shC: 0 };
    for (const k of [...keys].sort()) {
      const d = c.dias[k]; if (!d) continue;
      for (const f of Object.keys(tot)) tot[f] += d[f] || 0;
      pc.ms += d.ms; pc.xp += d.xp; pc.gold += d.gold; pc.shC += d.shC;
      if (d.lvl0 && !pc.lvl0) pc.lvl0 = d.lvl0; if (d.lvl1) pc.lvl1 = d.lvl1;
      for (const [h, ms] of Object.entries(d.hunts || {})) hunts[h] = (hunts[h] || 0) + ms;
      const pd = porDia[k] || (porDia[k] = { xp: 0, gold: 0, ms: 0 }); pd.xp += d.xp; pd.gold += d.gold; pd.ms += d.ms;
    }
    if (pc.ms) porConta.push(pc);
  }
  const fav = Object.entries(hunts).filter(([h]) => h && h !== '—').sort((a, b) => b[1] - a[1])[0];
  const melhor = Object.entries(porDia).sort((a, b) => b[1].xp - a[1].xp)[0];
  const noites = (dados.relatorios || []).filter((r) => r.fim > ate - dias * 86400000);
  const niveis = porConta.reduce((t, c) => t + Math.max(0, (c.lvl1 || 0) - (c.lvl0 || 0)), 0);
  return { tot, porConta: porConta.sort((a, b) => b.ms - a.ms), fav: fav ? { nome: fav[0], ms: fav[1] } : null, melhor: melhor ? { dia: melhor[0], ...melhor[1] } : null, noites: noites.length, niveis, diasAtivos: Object.keys(porDia).length };
}
async function abrirWrapped(dias) {
  const dados = await call('app:diario:dados');
  const w = somaPeriodo(dados, dias);
  const nome = dias === 7 ? 'semana' : 'mês';
  const doNome = dias === 7 ? 'da semana' : 'do mês';
  if (!w.tot.ms) { openModal(el('h3', null, `🎬 Wrapped ${doNome}`), el('p', null, 'Ainda não tem dados. O Idleterino começa a contar a partir desta versão: deixe as contas rodando e volte em alguns dias.'), actionsRow(button('Fechar', 'primary', closeModal))); return; }
  const dataBr = (k) => { const [y, m, d] = k.split('-'); return `${d}/${m}`; };
  const slides = [
    ['⏱', `Nesta ${nome} você farmou`, `${hm(w.tot.ms)}`, `em ${w.diasAtivos} dia(s), somando as contas`],
    ['⚡', 'XP de treinador', `+${bigN(w.tot.xp)}`, w.niveis ? `e ${w.niveis} nível(is) a mais` : 'contando todas as contas'],
    ['💰', 'Ouro que entrou', `+${bigN(w.tot.gold)}`, `${fmt(w.tot.ab)} abates e ${fmt(w.tot.cap)} capturas`],
    ...(w.fav ? [['🧭', 'Sua hunt favorita', w.fav.nome, `${hm(w.fav.ms)} caçando lá`]] : []),
    ['✨', 'Shinys', `${fmt(w.tot.shV)} vistos`, w.tot.shC ? `e ${fmt(w.tot.shC)} capturado(s)!` : 'o próximo vem 🍀'],
    ...(w.melhor ? [['🏆', 'Seu melhor dia', dataBr(w.melhor.dia), `+${bigN(w.melhor.xp)} XP e +${bigN(w.melhor.gold)} ouro`]] : []),
    ['🛡', 'O Idleterino cuidou', `${w.tot.reab + w.tot.quedas}`, `queda(s) e travada(s)${w.noites ? ` · ${w.noites} noite(s) no modo noite` : ''}`],
  ];
  let i = 0;
  const stage = el('div', 'wr-stage');
  const dots = el('div', 'wr-dots');
  const show = () => {
    const [ico, a, b, c] = slides[i];
    const s = el('div', 'wr-slide'); s.append(el('div', 'wr-ico', ico), el('div', 'wr-a', a), el('div', 'wr-b', b), el('div', 'wr-c', c));
    stage.replaceChildren(s);
    dots.replaceChildren(...slides.map((_, k) => el('i', k === i ? 'on' : null)));
    prev.disabled = i === 0; next.textContent = i === slides.length - 1 ? 'Ver o resumo' : 'Próximo →';
  };
  const prev = button('←', null, () => { if (i > 0) { i--; show(); } });
  const next = button('Próximo →', 'primary', () => { if (i < slides.length - 1) { i++; show(); } else resumo(); });
  const resumo = () => {
    const url = desenharWrapped(w, nome);
    const im = el('img', 'wr-img'); im.src = url;
    openModal(el('h3', null, `🎬 Seu Wrapped ${doNome}`), im, actionsRow(button('📋 Copiar imagem', null, async () => { if (await call('app:image:copy', url)) toast('Imagem copiada. Cole no Discord (Ctrl+V).'); }), button('💾 Salvar', null, () => call('app:image:save', url, `idleterino-wrapped-${nome}`)), button('Fechar', 'primary', closeModal)));
  };
  openModal(el('h3', null, `🎬 Wrapped ${doNome}`), stage, dots, actionsRow(prev, next));
  show();
}
function desenharWrapped(w, nome) {
  const T = tela(1080, 1350);
  T.txt(`Meu PokeIdle ${nome === 'semana' ? 'na semana' : 'no mês'}`, 70, 130, 62, '#eef0f7', 800);
  T.txt('Wrapped do Idleterino', 72, 185, 30, '#a970ff', 700);
  const W = 455, H = 180;
  T.caixa(70, 240, 940, 230, hm(w.tot.ms), `de farm em ${w.diasAtivos} dia(s)`);
  T.caixa(70, 500, W, H, `+${bigN(w.tot.xp)}`, w.niveis ? `XP · ${w.niveis} nível(is) a mais` : 'XP de treinador'); T.caixa(555, 500, W, H, `+${bigN(w.tot.gold)}`, 'ouro', '#ffcf4a');
  T.caixa(70, 710, W, H, fmt(w.tot.ab), 'abates'); T.caixa(555, 710, W, H, `${fmt(w.tot.shV)} / ${fmt(w.tot.shC)}`, '✨ shinys vistos / capt.', '#ffd76a');
  T.caixa(70, 920, 940, H, w.fav ? w.fav.nome : '—', w.fav ? `hunt favorita · ${hm(w.fav.ms)}` : 'hunt favorita');
  let y = 1170;
  for (const c of w.porConta.slice(0, 3)) { T.txt(c.nick, 72, y, 28, '#eef0f7', 700); T.txt(`${hm(c.ms)} · +${bigN(c.xp)} XP`, 1010, y, 26, '#8a90a6', 600, 'right'); y += 42; }
  T.rodape('Idleterino · PokeIdle, Twitch e Kick num app só');
  return T.c.toDataURL('image/png');
}

// ---------- Cartão do Treinador ----------
function conquistas(dados) {
  let ms = 0, shC = 0, maxGold = 0, maxXp = 0;
  for (const c of Object.values(dados.contas)) for (const d of Object.values(c.dias)) { ms += d.ms; shC += d.shC; }
  const dias = {};
  for (const c of Object.values(dados.contas)) for (const [k, d] of Object.entries(c.dias)) { const x = dias[k] || (dias[k] = { xp: 0, gold: 0 }); x.xp += d.xp; x.gold += d.gold; }
  for (const d of Object.values(dias)) { maxGold = Math.max(maxGold, d.gold); maxXp = Math.max(maxXp, d.xp); }
  const perfeita = (dados.relatorios || []).some((r) => r.fim - r.inicio >= 6 * 3600 * 1000 && !r.contas.some((c) => c.quedas || c.reab));
  const h = ms / 3600000;
  const lista = [
    ['⏱', '10 horas de farm', h >= 10], ['⏳', '100 horas de farm', h >= 100], ['🏛', '500 horas de farm', h >= 500],
    ['✨', 'Primeiro shiny capturado', shC >= 1], ['🌟', '10 shinys capturados', shC >= 10],
    ['🌙', 'Noite perfeita (6 h, zero quedas)', perfeita], ['💰', '1M de ouro num dia', maxGold >= 1e6], ['⚡', '10M de XP num dia', maxXp >= 1e7],
  ];
  return { ms, shC, lista, feitas: lista.filter((x) => x[2]) };
}
async function abrirCartao() {
  const dados = await call('app:diario:dados');
  const s = S.poke;
  const main = s && (s.accounts.find((a) => a.id === s.mainId) || s.accounts[0]);
  const i = (main && main.info) || {};
  const nick = i.logged && i.nick && i.nick !== '—' ? i.nick : (main ? main.name : 'Treinador');
  const k = conquistas(dados);
  const url = desenharCartao(nick, i, k, s);
  const im = el('img', 'wr-img'); im.src = url;
  const ul = el('div', 'medals');
  for (const [ico, nomeM, ok] of k.lista) { const m = el('span', `medal${ok ? ' on' : ''}`, `${ico} ${nomeM}`); m.title = ok ? 'Conquistada' : 'Ainda não'; ul.append(m); }
  openModal(el('h3', null, '📇 Cartão do Treinador'), im, el('b', null, `Conquistas (${k.feitas.length}/${k.lista.length})`), ul,
    actionsRow(button('📋 Copiar imagem', null, async () => { if (await call('app:image:copy', url)) toast('Cartão copiado. Cole no Discord (Ctrl+V).'); }), button('💾 Salvar', null, () => call('app:image:save', url, `cartao-${nick}`)), button('Fechar', 'primary', closeModal)));
}
function desenharCartao(nick, i, k, s) {
  const T = tela(1200, 675);
  const lv = String(i.level || '').replace(/\D+/g, '');
  T.txt('CARTÃO DO TREINADOR', 64, 82, 26, '#a970ff', 800);
  T.txt(nick, 64, 170, 78, '#eef0f7', 800);
  T.txt([lv ? `Nível ${lv}` : null, i.guild && i.guild !== '—' ? `Guild ${i.guild}` : null, s ? `${s.pokeCount} conta(s)` : null].filter(Boolean).join('   ·   '), 66, 222, 30, '#8a90a6', 600);
  T.caixa(64, 270, 340, 160, hm(k.ms), 'de farm com o app'); T.caixa(430, 270, 340, 160, fmt(k.shC), '✨ shinys capturados', '#ffd76a'); T.caixa(796, 270, 340, 160, `${k.feitas.length}/${k.lista.length}`, 'conquistas', '#45e39b');
  let x = 64; let y = 500;
  for (const [ico, nomeM] of k.feitas.slice(0, 6)) {
    T.g.font = '700 24px "Segoe UI", system-ui, sans-serif'; const wd = T.g.measureText(`${ico} ${nomeM}`).width + 36;
    if (x + wd > 1136) { x = 64; y += 56; }
    T.g.fillStyle = 'rgba(69,227,155,.12)'; T.g.strokeStyle = 'rgba(69,227,155,.45)'; T.g.lineWidth = 2; T.g.beginPath(); T.g.roundRect(x, y - 34, wd, 46, 23); T.g.fill(); T.g.stroke();
    T.txt(`${ico} ${nomeM}`, x + 18, y - 3, 24, '#c8f7e0', 700); x += wd + 12;
  }
  if (!k.feitas.length) T.txt('As conquistas aparecem conforme você farma com o Idleterino.', 64, 520, 26, '#5d6378', 600);
  T.rodape('Idleterino · PokeIdle, Twitch e Kick num app só');
  return T.c.toDataURL('image/png');
}

// ---------- Ajustes: avisos, painel, segurança ----------
let settingsTok = 0;
async function settingsExtras(box) {
  const my = ++settingsTok;
  if (!S.diario) await refreshDiario();
  const st = await call('app:seg:state');
  // Outra pintura começou enquanto esperava: ela é que desenha (senão as seções saem dobradas).
  if (my !== settingsTok) return;
  const d = S.diario; if (!d) return;
  const setA = async (patch) => { const r = await call('app:diario:avisos', patch); if (r.error) toast(`⚠ ${r.error}`); S.diario = r; renderSettings(); };
  // Avisos
  const av = el('div', 'card list xsec'); av.id = 'sec-avisos';
  av.append(el('h3', null, '🚨 Vigia e avisos'), el('p', 'sub', 'O app vigia as contas do PokeIdle e avisa quando algo dá errado. Os avisos levam só o nick e o que aconteceu.'));
  const pm = el('select'); for (const v of [3, 5, 10, 15, 30]) { const o = el('option', null, `${v} min`); o.value = v; pm.append(o); } pm.value = String(d.vigia.paradaMin);
  pm.onchange = async () => { S.diario = await call('app:diario:vigia', { paradaMin: Number(pm.value) }); };
  const vg = el('div', 'inline'); vg.append(sw(d.vigia.on, async (v) => { S.diario = await call('app:diario:vigia', { on: v }); }), el('span', 'sub', 'parada há'), pm);
  av.append(rowOpt('Vigia ligado', 'Conta logada sem ganhar XP, conta que caiu ou deslogou e conta que travou.', vg, true));
  av.append(rowOpt('Aviso no PC', 'A notificação do Windows/Linux.', sw(d.avisos.desktop, (v) => setA({ desktop: v }))));
  // ntfy
  const nt = el('div', 'notify-box');
  const ntHead = rowOpt('📱 Aviso no celular (ntfy)', 'App gratuito, sem cadastro. Chega mesmo com a tela bloqueada e no 4G.', sw(d.avisos.ntfyOn, (v) => setA({ ntfyOn: v })), true);
  nt.append(ntHead);
  if (d.avisos.ntfyOn && d.avisos.ntfyTopic) {
    const qrw = el('div', 'qr-wrap');
    const im = el('img', 'qr'); im.src = d.avisos.ntfyQr; qrw.append(im);
    const steps = el('ol', 'steps');
    for (const s of ['Instale o app ntfy no celular (Play Store ou App Store).', 'Android: leia o QR code com a câmera. Ele abre o ntfy já no seu canal.', `iPhone: no ntfy, toque em + e cole o nome do canal: ${d.avisos.ntfyTopic}`, 'Toque em "Testar" aqui embaixo.']) steps.append(el('li', null, s));
    qrw.append(steps); nt.append(qrw);
    nt.append(actionsRow(button('📋 Copiar nome do canal', null, () => { navigator.clipboard.writeText(d.avisos.ntfyTopic); toast('Nome do canal copiado.'); }), button('Gerar canal novo', 'ghost', () => setA({ ntfyNovo: true })), button('Testar', 'primary', async () => { const r = await call('app:diario:testar', 'ntfy'); toast(r.ok ? '✅ Enviado. Chegou no celular?' : `⚠ ${r.error}`); })));
    nt.append(el('p', 'small', 'O nome do canal é longo e aleatório, só seu. As mensagens passam pelo servidor do ntfy (ntfy.sh). Quem tiver o nome do canal vê os avisos: não poste ele por aí.'));
  }
  av.append(nt);
  // Discord
  const dc = el('div', 'notify-box');
  dc.append(rowOpt('💬 Aviso no Discord', 'Num canal seu, por webhook (Configurações do canal > Integrações > Webhooks > Novo > Copiar URL).', sw(d.avisos.discordOn, (v) => { if (v && !d.avisos.discordUrl) { toast('Cole o link do webhook primeiro.'); renderSettings(); return; } setA({ discordOn: v }); })));
  const url = el('input'); url.type = 'text'; url.placeholder = 'https://discord.com/api/webhooks/…'; url.value = d.avisos.discordUrl ? `${d.avisos.discordUrl.slice(0, 48)}…` : ''; url.style.flex = '1';
  url.onfocus = () => { if (url.value.endsWith('…')) url.value = ''; };
  const ur = el('div', 'inline wide'); ur.append(url, button('Salvar', null, () => setA({ discordUrl: url.value.endsWith('…') ? d.avisos.discordUrl : url.value, discordOn: true })), button('Testar', 'primary', async () => { const r = await call('app:diario:testar', 'discord'); toast(r.ok ? '✅ Enviado no Discord.' : `⚠ ${r.error}`); }));
  if (d.avisos.discordUrl) ur.append(button('Apagar', 'ghost', () => setA({ discordUrl: '' })));
  dc.append(ur, el('p', 'small', 'O link do webhook fica só neste PC. Crie num servidor ou canal seu: quem tiver o link consegue mandar mensagem nele.'));
  av.append(dc);
  // Tipos
  const tp = el('div', 'tipos');
  for (const [k, nome] of Object.entries(d.tipos)) { const l = el('label', 'tchk'); const c = el('input'); c.type = 'checkbox'; c.checked = !!d.avisos.tipos[k]; c.onchange = () => setA({ tipos: { [k]: c.checked } }); l.append(c, nome); tp.append(l); }
  av.append(el('b', 'tipos-hd', 'O que avisar'), tp, el('p', 'small', 'O mesmo aviso da mesma conta não se repete por 15 min.'));
  box.append(av);

  box.append(streamSection(d));
  // Painel Wi-Fi
  const pn = el('div', 'card list xsec');
  pn.append(el('h3', null, '📶 Painel no celular (Wi-Fi de casa)'), el('p', 'sub', 'Veja as contas ao vivo no navegador do celular: nível, XP/h, ouro/h, horas e se alguma está parada. Só leitura, com código de acesso, e só no mesmo Wi-Fi.'));
  pn.append(rowOpt('Painel ligado', d.painel.semRede ? 'Não achei uma rede Wi-Fi/cabo neste PC.' : 'Na primeira vez, o Windows pode perguntar se o Idleterino pode usar a rede: escolha só "Redes privadas".', sw(d.painel.on, async (v) => { S.diario = await call('app:diario:painel', { on: v }); renderSettings(); })));
  if (d.painel.on) {
    if (d.painel.erro) pn.append(el('p', 'warn-google', `⚠ ${d.painel.erro}`));
    if (d.painel.qr) {
      const qrw = el('div', 'qr-wrap'); const im = el('img', 'qr'); im.src = d.painel.qr; qrw.append(im);
      const t = el('div'); t.append(el('p', null, 'Leia com a câmera do celular (no mesmo Wi-Fi do PC).'), el('code', 'url', d.painel.url));
      qrw.append(t); pn.append(qrw);
      pn.append(actionsRow(button('📋 Copiar link', null, () => { navigator.clipboard.writeText(d.painel.url); toast('Link copiado.'); }), button('Trocar o código', 'ghost', async () => { S.diario = await call('app:diario:painel', { novoCodigo: true }); toast('Código trocado: o link antigo parou de funcionar.'); renderSettings(); })));
    }
  }
  box.append(pn);

  // Segurança e versões
  const sg = el('div', 'card list xsec'); sg.id = 'sec-seguranca';
  sg.append(el('h3', null, '🛡️ Backups e versões'), el('p', 'sub', 'Se uma atualização der problema, dá para voltar atrás sem perder nada.'));
  if (st.falhas >= 3) sg.append(el('p', 'warn-google', `⚠ Esta versão fechou sozinha ${st.falhas} vezes seguidas logo ao abrir. Restaure um backup ou volte para a versão anterior.`));
  const bk = el('div', 'bk-list');
  for (const b of st.backups.slice(0, 6)) {
    const r = el('div', 'bk');
    r.append(el('span', null, `${new Date(b.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · versão ${b.version} · ${b.motivo}`), button('Restaurar', 'mini', async () => { const r2 = await call('app:seg:restore', b.id); if (r2 && r2.error) toast(`⚠ ${r2.error}`); }));
    bk.append(r);
  }
  if (!st.backups.length) bk.append(el('span', 'sub', 'O primeiro backup é feito agora, ao abrir esta versão, e depois todo dia.'));
  sg.append(rowOpt('Backups das configurações', 'Contas, canais, ajustes, extensões e histórico (os logins não entram: ficam protegidos pelo próprio sistema). Feito sozinho todo dia e antes de cada atualização. Guarda os 8 últimos.', button('Fazer backup agora', null, async () => { const r = await call('app:seg:backup'); toast(r.ok ? 'Backup feito.' : 'Não consegui fazer o backup.'); renderSettings(); })), bk);
  const vs = el('div', 'bk-list');
  const vBtn = button('Ver versões anteriores', null, async () => {
    vBtn.disabled = true; vBtn.textContent = 'Procurando…';
    const r = await call('app:seg:versions');
    vs.replaceChildren();
    if (!r.ok) { vs.append(el('span', 'sub', r.error)); vBtn.disabled = false; vBtn.textContent = 'Ver versões anteriores'; return; }
    if (!r.list.length) vs.append(el('span', 'sub', 'Nenhuma versão anterior publicada.'));
    for (const v of r.list) {
      const row = el('div', 'bk');
      row.append(el('span', null, `Versão ${v.version} · ${new Date(v.at).toLocaleDateString('pt-BR')}`));
      if (!st.canRollback) row.append(el('span', 'sub', 'baixe no GitHub'));
      else if (!v.canInstall) { const t = el('span', 'sub', `só a partir da ${r.minRollback}`); t.title = 'Versões antes da 0.3.0 não sabem "pular" a versão com problema: elas instalariam a mais nova de novo ao sair. Para elas, use o botão do Início quando a correção sair.'; row.append(t); }
      else row.append(button(`Voltar para a ${v.version}`, 'mini', async (ev) => { ev.target.disabled = true; ev.target.textContent = 'Baixando…'; const res = await call('app:seg:rollback', v.version); if (res.error) { toast(`⚠ ${res.error}`); ev.target.disabled = false; ev.target.textContent = `Voltar para a ${v.version}`; } else if (res.ok) toast('Instalando… o app fecha e abre de novo sozinho.'); }));
      vs.append(row);
    }
    vBtn.textContent = 'Atualizar lista'; vBtn.disabled = false;
  });
  sg.append(rowOpt('Voltar para a versão anterior', st.canRollback ? 'Baixa do GitHub, confere a assinatura, instala e abre sozinho. A versão com problema não volta sozinha: a correção chega normalmente quando sair.' : 'No app instalado do Windows é com um clique. No portátil e no Linux, baixe a versão anterior em github.com/ViinniSantoos/idleterino/releases.', vBtn), vs);
  box.append(sg);
}
window.idle.on('app:seg:progress', (p) => { const b = [...document.querySelectorAll('#sec-seguranca button')].find((x) => x.textContent.startsWith('Baixando')); if (b) b.textContent = `Baixando… ${p}%`; });
window.idle.on('app:goto', (where) => { go('settings'); setTimeout(() => { const t = $(`#sec-${where}`); if (t) t.scrollIntoView({ behavior: 'smooth' }); }, 400); });

// ---------- Extensões: pelo link da loja e "trazer do meu navegador" ----------
function permsBox(p) {
  const nodes = [];
  const sel = el('div', `ext-badge ${p.verified ? 'ok' : 'warn'}`, p.verified ? '✔ Verificada pelo Idleterino' : '⚠ Por sua conta: o Idleterino não conferiu esta extensão');
  nodes.push(sel);
  nodes.push(el('p', null, `${p.name} · v${p.version} · ${p.store === 'opera' ? 'loja do Opera' : 'Chrome Web Store'}${p.jaTem ? ` (você tem a v${p.jaTem})` : ''}`));
  if (p.description) nodes.push(el('p', 'small', p.description));
  const ul = el('ul', 'perm-list');
  if (p.sites && p.sites.length) ul.append(el('li', p.todosSites ? 'forte' : null, `Mexe em: ${p.sites.join(', ')}${p.todosSites ? ' (no Idleterino, dentro das contas só abrem o jogo e as páginas de login)' : ''}`));
  for (const x of p.perms || []) ul.append(el('li', x.forte ? 'forte' : null, `Pode ${x.txt}`));
  if (!ul.children.length) ul.append(el('li', null, 'Não pede nenhuma permissão especial.'));
  nodes.push(el('b', null, 'O que ela pode fazer'), ul);
  if (p.novas && p.novas.length) nodes.push(el('p', 'warn-google', `⚠ Permissões NOVAS nesta versão: ${p.novas.join('; ')}.`));
  nodes.push(el('p', 'small', 'Ela roda só nas contas do PokeIdle, nunca na Twitch nem na Kick. Pode ver o que acontece nessas contas, inclusive o login do jogo.'));
  return nodes;
}
function confirmarExt(p, titulo) {
  openModal(el('h3', null, titulo), ...permsBox(p), actionsRow(
    button('Cancelar', null, () => { call('poke:ext:cancel', p.token); closeModal(); }),
    button(p.jaTem ? `Atualizar para a v${p.version}` : 'Instalar', 'primary', async () => { const r = await call('poke:ext:confirm', p.token); closeModal(); if (r.error) toast(`⚠ ${r.error}`); else { toast(`${p.name} instalada. As contas recarregaram para aplicar.`); S.ext = r.list; } if (page === 'ext') renderExt(); })));
}
function instalarPorLink(preUrl) {
  const input = el('input'); input.type = 'text'; input.placeholder = 'https://chromewebstore.google.com/detail/…'; input.style.width = '100%'; input.value = preUrl || '';
  const err = el('p', 'warn-google'); err.hidden = true;
  const go2 = async () => {
    btn.disabled = true; btn.textContent = 'Baixando da loja…'; err.hidden = true;
    const p = await call('poke:ext:preview', input.value.trim());
    btn.disabled = false; btn.textContent = 'Continuar';
    if (!p.ok) { err.textContent = p.error; err.hidden = false; return; }
    confirmarExt(p, p.jaTem ? 'Atualizar extensão' : 'Instalar extensão');
  };
  const btn = button('Continuar', 'primary', go2);
  input.onkeydown = (e) => { if (e.key === 'Enter') go2(); };
  openModal(el('h3', null, '🔗 Instalar pelo link da loja'), el('p', null, 'Abra a página da extensão na Chrome Web Store (funciona para quem usa Chrome, Opera, Opera GX, Edge ou Brave) ou na loja do Opera, copie o link da barra de endereço e cole aqui.'), input, err, el('p', 'small', 'O app baixa direto da loja oficial e mostra o que a extensão pode fazer antes de instalar.'), actionsRow(button('Cancelar', null, closeModal), btn));
  if (preUrl) go2(); else input.focus();
}
async function trazerDoNavegador() {
  openModal(el('h3', null, '📥 Trazer do meu navegador'), el('p', null, 'Procurando…'));
  const r = await call('poke:ext:scan');
  const nodes = [el('h3', null, '📥 Trazer do meu navegador'), el('p', null, r.browsers.length ? `Olhei as extensões do ${r.browsers.join(', ')} (só a lista delas: nada de histórico, senha ou login).` : 'Não achei Chrome, Edge, Brave, Opera, Opera GX nem Vivaldi neste PC.')];
  if (!r.list.length) nodes.push(el('p', null, 'Nenhuma extensão feita para o PokeIdle por lá. Se a sua não apareceu, use "Instalar pelo link".'));
  const box = el('div', 'bk-list');
  for (const x of r.list) {
    const row = el('div', 'bk');
    const t = el('span'); t.append(el('b', null, x.name), ` · v${x.version} · no ${x.browsers.join(', ')}`, x.verified ? el('span', 'ext-mini ok', ' ✔') : '');
    row.append(t, x.installed ? el('span', 'sub', 'já no app') : button('Instalar', 'mini primary', () => instalarPorLink(`https://chromewebstore.google.com/detail/${x.id}`)));
    box.append(row);
  }
  if (r.list.length) nodes.push(box, el('p', 'small', 'A instalação baixa a cópia oficial da Chrome Web Store pelo mesmo ID: nada é copiado do seu navegador. Se a extensão só existir na loja do Opera, cole o link de lá.'));
  nodes.push(actionsRow(button('Fechar', 'primary', closeModal)));
  openModal(...nodes);
}
async function atualizarExt(e) {
  const p = await call('poke:ext:previewUpdate', e.id);
  if (!p.ok) { toast(`⚠ ${p.error}`); return; }
  confirmarExt(p, `Atualizar ${e.name}`);
}

// ---------- 🧪 Laboratório de hunts ----------
// A pessoa troca de hunt no jogo quando quiser; o app mede cada uma com o placar do próprio jogo.
let labTimer = null;
function labCard() {
  const L = S.diario && S.diario.lab;
  if (!L || L.fim) return null;
  const c = el('div', 'card night lab on');
  const t = el('div', 'nt');
  t.append(el('b', null, `🧪 Laboratório medindo ${L.nick}`), el('span', null, `${L.atual ? `Agora: ${L.atual}` : 'Esperando a hunt'} · ${L.lista.length} hunt(s) medida(s) · desde ${hhmmOf(L.inicio)}`));
  c.append(t, button('Ver resultados', 'primary', abrirLab));
  return c;
}
async function abrirLab() {
  await refreshDiario();
  const L = S.diario && S.diario.lab;
  clearInterval(labTimer);
  if (!L) return labNovo();
  if (L.fim) return labVeredito(L);
  labAoVivo();
  labTimer = setInterval(async () => { if ($('#modal').hidden || !$('#lab-live')) { clearInterval(labTimer); return; } await refreshDiario(); const x = S.diario.lab; if (x && !x.fim) labAoVivo(); }, 10000);
}
function labNovo() {
  const accs = (S.poke ? S.poke.accounts : []).filter((a) => a.isPoke && a.info && a.info.logged);
  const sel = el('select');
  for (const a of accs) { const o = el('option', null, a.info.nick && a.info.nick !== '—' ? a.info.nick : a.name); o.value = a.id; sel.append(o); }
  const err = el('p', 'warn-google'); err.hidden = true;
  const passos = el('ol', 'steps');
  for (const s of ['Escolha a conta e clique em "Começar".', 'No jogo, cace na primeira hunt que quer testar.', 'Quando quiser, troque para a próxima hunt (pode ser mais de duas). O app percebe a troca sozinho.', '10 min em cada hunt já dá um resultado confiável. Depois clique em "Ver o veredito".']) passos.append(el('li', null, s));
  openModal(el('h3', null, '🧪 Laboratório de hunts'), el('p', null, 'Compare hunts medindo de verdade: XP/h, ouro/h, abates, capturas e shinys, com o placar do próprio jogo.'), passos,
    accs.length ? sel : el('p', 'warn-google', 'Nenhuma conta logada agora.'), err,
    el('p', 'small', 'O app só mede: quem troca de hunt é você. Não mexa no pokémon em campo durante o teste, senão a comparação fica injusta.'),
    actionsRow(button('Cancelar', null, closeModal), accs.length ? button('Começar', 'primary', async () => {
      const r = await call('app:diario:lab:start', sel.value);
      if (r.error) { err.textContent = r.error; err.hidden = false; return; }
      S.diario = r; toast('Laboratório ligado. Troque de hunt no jogo quando quiser.'); abrirLab();
    }) : el('span')));
}
function labTabela(L) {
  const t = el('div', 'lab-tab');
  const hd = el('div', 'lab-row hd'); for (const h of ['Hunt', 'Medido', 'XP/h', 'Ouro/h', 'Abates/h', '✨']) hd.append(el('span', null, h)); t.append(hd);
  for (const x of L.lista) {
    const r = el('div', `lab-row${x.nome === L.atual && !L.fim ? ' medindo' : ''}`);
    const n = el('span', 'n'); n.append(el('b', null, x.nome), el('i', null, [x.nome === L.atual && !L.fim ? '● medindo agora' : null, x.risco, x.pronto ? null : 'precisa de 10 min'].filter(Boolean).join(' · ')));
    r.append(n, el('span', null, hm(x.ms)), el('span', null, bigN(x.xpH)), el('span', 'gold', bigN(x.goldH)), el('span', null, fmt(Math.round(x.abH))), el('span', null, `${x.shV}/${x.shC}`));
    t.append(r);
  }
  if (!L.lista.length) t.append(el('div', 'mempty', 'Esperando o placar da primeira hunt (uns 30 s).'));
  return t;
}
function labAoVivo() {
  const L = S.diario.lab;
  const box = el('div'); box.id = 'lab-live';
  box.append(labTabela(L));
  openModal(el('h3', null, `🧪 Laboratório · ${L.nick}`), el('p', null, `Medindo desde ${hhmmOf(L.inicio)}. Troque de hunt no jogo quando quiser: o app separa sozinho.`), box,
    actionsRow(button('Cancelar teste', 'ghost', async () => { S.diario = await call('app:diario:lab:clear'); closeModal(); renderHome(); }), button('Fechar (continua medindo)', null, closeModal),
      button('Ver o veredito', 'primary', async () => { S.diario = await call('app:diario:lab:end'); labVeredito(S.diario.lab); })));
}
function labVeredito(L) {
  clearInterval(labTimer);
  const v = L.veredito;
  const nodes = [el('h3', null, `🧪 Veredito · ${L.nick}`)];
  if (v) {
    const g = el('div', 'rel-grid two');
    const st = (ico, rot, nome, val, mais, cls) => { const d = el('div', `rs ${cls || ''}`); d.append(el('span', null, `${ico} ${rot}`), el('b', null, nome), el('span', null, `${val}${mais ? ` · +${mais}% que a pior` : ''}`)); return d; };
    g.append(st('⚡', 'Quer mais XP', v.xp.nome, `${bigN(v.xp.xpH)} XP/h`, v.xp.mais), st('💰', 'Quer mais ouro', v.ouro.nome, `${bigN(v.ouro.goldH)} ouro/h`, v.ouro.mais, 'gold'));
    nodes.push(g);
  } else nodes.push(el('p', 'warn-google', 'Para o veredito, meça pelo menos 2 hunts com 10 min cada. A tabela abaixo mostra o que deu até agora.'));
  nodes.push(labTabela(L), el('p', 'small', 'Ouro bruto, sem descontar as poções. A marca de poção vem da mesma conta da sugestão de hunt.'));
  const img = () => desenharLab(L);
  nodes.push(actionsRow(button('Novo teste', 'ghost', async () => { S.diario = await call('app:diario:lab:clear'); labNovo(); }),
    button('📋 Copiar imagem', null, async () => { if (await call('app:image:copy', img())) toast('Imagem copiada. Cole no Discord (Ctrl+V).'); }), button('💾 Salvar', null, () => call('app:image:save', img(), `laboratorio-${L.nick}`)), button('Fechar', 'primary', () => { closeModal(); renderHome(); })));
  openModal(...nodes);
}
function desenharLab(L) {
  const T = tela(1080, 1080);
  const v = L.veredito;
  T.txt('🧪 Laboratório de hunts', 70, 130, 60, '#eef0f7', 800);
  T.txt(`${L.nick} · medido de verdade com o Idleterino`, 72, 185, 30, '#a970ff', 700);
  if (v) {
    T.caixa(70, 240, 455, 210, v.xp.nome.slice(0, 18), `⚡ mais XP · ${bigN(v.xp.xpH)}/h`);
    T.caixa(555, 240, 455, 210, v.ouro.nome.slice(0, 18), `💰 mais ouro · ${bigN(v.ouro.goldH)}/h`, '#ffcf4a');
  }
  let y = v ? 540 : 260;
  T.txt('Hunt', 72, y, 26, '#8a90a6', 700); T.txt('tempo', 560, y, 26, '#8a90a6', 700, 'right'); T.txt('XP/h', 770, y, 26, '#8a90a6', 700, 'right'); T.txt('ouro/h', 1010, y, 26, '#8a90a6', 700, 'right');
  y += 52;
  for (const x of L.lista.slice(0, 7)) {
    T.txt(x.nome.slice(0, 22), 72, y, 30, '#eef0f7', 700); T.txt(hm(x.ms), 560, y, 28, '#8a90a6', 600, 'right'); T.txt(bigN(x.xpH), 770, y, 30, '#eef0f7', 800, 'right'); T.txt(bigN(x.goldH), 1010, y, 30, '#ffcf4a', 800, 'right');
    y += 54;
  }
  T.rodape('Idleterino · PokeIdle, Twitch e Kick num app só');
  return T.c.toDataURL('image/png');
}

// ---------- 📺 Modo Streamer (Ajustes) ----------
function streamSection(d) {
  const sec = el('div', 'card list xsec'); sec.id = 'sec-stream';
  sec.append(el('h3', null, '📺 Modo Streamer (overlay para o OBS)'), el('p', 'sub', 'Mostre na live o XP e o ouro subindo, o nível e os shinys, com animação quando aparece shiny ou sobe de nível. Funciona só neste PC.'));
  const s = d.stream;
  sec.append(rowOpt('Overlay ligado', 'Liga uma página local que o OBS lê. Ninguém de fora acessa.', sw(s.on, async (v) => { S.diario = await call('app:diario:stream', { on: v }); renderSettings(); })));
  if (s.on && s.base) {
    if (s.erro) sec.append(el('p', 'warn-google', `⚠ ${s.erro}`));
    let estilo = 'card', contas = 'principal';
    try { estilo = localStorage.getItem('streamEstilo') || 'card'; contas = localStorage.getItem('streamContas') || 'principal'; } catch {}
    const url = () => `${s.base}&estilo=${estilo}&contas=${contas}`;
    const e1 = el('select'); for (const [v, l] of [['card', 'Cartão'], ['barra', 'Barra fina']]) { const o = el('option', null, l); o.value = v; e1.append(o); } e1.value = estilo;
    const e2 = el('select'); for (const [v, l] of [['principal', 'Só a principal'], ['todas', 'Todas as contas']]) { const o = el('option', null, l); o.value = v; e2.append(o); } e2.value = contas;
    const code = el('code', 'url', url());
    e1.onchange = () => { estilo = e1.value; try { localStorage.setItem('streamEstilo', estilo); } catch {} code.textContent = url(); };
    e2.onchange = () => { contas = e2.value; try { localStorage.setItem('streamContas', contas); } catch {} code.textContent = url(); };
    const opts = el('div', 'inline wide'); opts.append(el('span', 'sub', 'Estilo'), e1, el('span', 'sub', 'Contas'), e2);
    sec.append(opts, code);
    const passos = el('ol', 'steps');
    for (const p of ['Copie o link.', 'No OBS: Fontes > + > Navegador (Browser) > cole o link em URL.', 'Largura 900 e altura 400 (Cartão) ou 1400 e 120 (Barra). O fundo já é transparente.']) passos.append(el('li', null, p));
    sec.append(passos);
    sec.append(actionsRow(button('📋 Copiar link', 'primary', () => { navigator.clipboard.writeText(url()); toast('Link do overlay copiado. Cole no OBS.'); }),
      button('Ver como fica', null, () => call('app:stream:preview', url())),
      button('↺ Zerar contagem da live', null, async () => { S.diario = await call('app:diario:stream', { zerar: true }); toast('Contagem da live zerada.'); renderSettings(); }),
      button('Trocar o código', 'ghost', async () => { S.diario = await call('app:diario:stream', { novoCodigo: true }); toast('Código trocado: atualize o link no OBS.'); renderSettings(); })));
    if (s.liveInicio) sec.append(el('p', 'small', `Contando a live desde ${new Date(s.liveInicio).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}. Zere no começo de cada live.`));
  }
  return sec;
}
