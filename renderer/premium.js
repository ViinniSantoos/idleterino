// Idleterino — TRADER PREMIUM (18/11/2026): a tela dos planos (teste grátis de 3 dias, mensal, vitalício) com o Pix no
// próprio app, e a faixa do plano em cima da aba Trader. A licença é conferida no processo principal (licenca.js);
// aqui só se mostra e se pede. Escondido até o lançamento (licenca.js › PREMIUM_LANCADO).
let premSit = null;          // a situação do plano da conta principal
let premPix = null;          // o Pix aberto agora { id, plano, copiaECola, qrSvg, valor, expiraEm }
let premPixTimer = null;
let premResumo = null;
const premReal = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
const premData = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const premDias = (s) => (s.dias > 1 ? `${s.dias} dias` : s.dias === 1 ? '1 dia' : 'menos de 1 dia');

(() => {
  if (document.getElementById('nav-premium')) return;
  const pve = document.querySelector('.nav[data-page="pve"]');
  const sec = document.createElement('section'); sec.className = 'page'; sec.id = 'page-premium';
  const tr = document.getElementById('page-trader');
  if (tr) tr.after(sec);
  if (!pve) return;
  const b = document.createElement('button');
  b.className = 'nav'; b.dataset.page = 'premium'; b.id = 'nav-premium'; b.hidden = true; b.title = 'Trader Premium';
  b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 17l5-5 4 4 7-8M15 8h5v5"/></svg><span>Trader</span>';
  b.onclick = () => go('premium');
  pve.after(b);
})();

async function premAtualizar(buscar) {
  const s = await call(buscar ? 'app:licenca:atualizar' : 'app:licenca:situacao').catch(() => null);
  if (!s) return;
  premSit = s;
  // O botão "Trader" dos planos aparece para quem ainda não tem o Trader liberado (depois do lançamento).
  const temTrader = typeof traderLiberado !== 'undefined' && traderLiberado;
  const nav = document.getElementById('nav-premium');
  // (o app do dono e os pacotes antigos dos testadores liberam sem licença: lá esse botão nunca aparece)
  if (nav) nav.hidden = !(s.lancado && !temTrader);
  if (page === 'premium') renderPremium();
  premFaixa();
  // Liberado (teste, mensal ou vitalício) e a tela do Trader ainda não está aqui: leva até ela.
  if (s.lancado && s.permite && !temTrader) premLevarAoTrader();
}
// LIBEROU E A TELA NÃO MUDOU (caso do L. Gabriel, 19/11/2026: "to lockado aqui", e um Ctrl+R resolveu). O teste/Pix
// libera o Trader por trás, mas a tela ficava nos planos. Agora: assim que o Trader entra, vai direto para a aba dele;
// se em 45 s a tela dele não chegou, a janela se atualiza sozinha (o mesmo Ctrl+R), no máximo 1 vez a cada 10 min.
let premLevando = null;
function premLevarAoTrader() {
  if (premLevando) return;
  const t0 = Date.now();
  const irDepois = (() => { try { return sessionStorage.getItem('premIrTrader') === '1'; } catch { return false; } })();
  premLevando = setInterval(() => {
    const ok = typeof traderLiberado !== 'undefined' && traderLiberado;
    if (ok) {
      clearInterval(premLevando); premLevando = null;
      try { sessionStorage.removeItem('premIrTrader'); } catch {}
      if (page === 'premium' || irDepois) { go('trader'); if (typeof toast === 'function') toast('📈 Trader liberado! Bem-vindo ao Premium.'); }
      premAtualizar(false);
      return;
    }
    if (Date.now() - t0 < 45000) return;
    clearInterval(premLevando); premLevando = null;
    let ultima = 0; try { ultima = Number(localStorage.getItem('premRecarregouEm')) || 0; } catch {}
    // Só atualiza a janela com a pessoa nos planos ou no Trader (nunca no meio de outra aba que ela está usando).
    if (Date.now() - ultima < 10 * 60 * 1000 || !['premium', 'trader'].includes(page)) { if (typeof toast === 'function') toast('⚠ O Trader foi liberado, mas a tela dele não abriu: aperte Ctrl+R (ou feche e abra o Idleterino).'); return; }
    try { localStorage.setItem('premRecarregouEm', String(Date.now())); sessionStorage.setItem('premIrTrader', '1'); } catch {}
    location.reload();
  }, 1000);
}
premAtualizar(false);
setInterval(() => premAtualizar(false), 60 * 1000);
window.idle.on('trader:licenca', () => premAtualizar(false));

// A faixa do plano, em cima da aba Trader (teste/mensal: quanto falta e "Renovar").
function premFaixa() {
  let f = document.getElementById('prem-faixa');
  const s = premSit;
  const mostra = page === 'trader' && s && s.lancado && ['teste', 'ativo', 'tolerancia'].includes(s.estado);
  if (!mostra) { if (f) f.remove(); return; }
  const tr = document.getElementById('page-trader');
  if (!tr) return;
  if (!f) { f = el('div', 'prem-faixa'); f.id = 'prem-faixa'; }
  if (f.parentElement !== tr) tr.prepend(f);
  f.className = `prem-faixa${s.estado === 'tolerancia' || (s.restaMs || 0) < 3 * 86400000 ? ' alerta' : ''}`;
  f.replaceChildren();
  const txt = s.estado === 'teste' ? `🎁 Teste grátis: faltam ${premDias(s)} (até ${premData(s.validoAte)}).`
    : s.estado === 'tolerancia' ? '⚠ O seu plano mensal venceu. O Trader segue por mais algumas horas.'
    : `📅 Plano mensal: faltam ${premDias(s)} (até ${premData(s.validoAte)}).`;
  f.append(el('span', null, txt), button(s.estado === 'teste' ? 'Assinar' : 'Renovar', 'primary', () => go('premium')));
}

// A aba Trader se redesenha inteira: põe a faixa de volta quando ela some.
(() => { const tr = document.getElementById('page-trader'); if (tr) new MutationObserver(() => { if (page === 'trader' && premSit && !document.getElementById('prem-faixa')) premFaixa(); }).observe(tr, { childList: true }); })();

async function renderPremium() {
  const root = document.getElementById('page-premium');
  if (!root) return;
  const s = premSit;
  root.replaceChildren();
  const head = el('header', 'page-head');
  const hd = el('div');
  hd.append(el('h1', null, '📈 Trader Premium'), el('p', 'sub', 'Pechinchas no Market com o preço justo calculado, compra dentro dos seus limites, sorteios, esteira de upar e revender, ⚡ Auto hunt (o pokémon sempre na melhor hunt) e 🎯 Auto catch (o Top Catch da semana sozinho).'));
  head.append(hd);
  root.append(head);
  if (!s) { root.append(el('p', 'sub', 'Carregando…')); return; }

  // ---- situação ----
  const sit = el('div', 'card prem-sit');
  if (!s.nick) sit.append(el('b', null, 'Entre no jogo com a sua conta principal (★)'), el('span', 'sub', 'O Premium fica preso ao nick da conta principal. Faça login nela na aba PokeIdle e volte aqui.'));
  else if (s.estado === 'vitalicio') sit.append(el('b', null, `⭐ ${s.nick}: Trader vitalício`), el('span', 'sub', 'Liberado para sempre nesta conta. Obrigado pelo apoio! 💜'));
  else if (s.estado === 'ativo') sit.append(el('b', null, `✅ ${s.nick}: plano mensal ativo`), el('span', 'sub', `Faltam ${premDias(s)} (até ${premData(s.validoAte)}). Renovar agora soma 30 dias ao que falta.`));
  else if (s.estado === 'teste') sit.append(el('b', null, `🎁 ${s.nick}: teste grátis`), el('span', 'sub', `Faltam ${premDias(s)} (até ${premData(s.validoAte)}). Assine quando quiser: os dias do teste não se perdem no mensal.`));
  else if (s.estado === 'tolerancia') sit.append(el('b', null, `⚠ ${s.nick}: o plano mensal venceu`), el('span', 'sub', 'O Trader segue por mais algumas horas. Renove pelo Pix para não parar.'));
  else if (s.estado === 'revogada') sit.append(el('b', null, `⛔ ${s.nick}: licença cancelada`), el('span', 'sub', 'Esta licença foi cancelada (Pix devolvido ou uso indevido). Fale com o dev no Discord se achar que é engano.'));
  else if (s.estado === 'vencido') sit.append(el('b', null, s.plano === 'teste' ? `⏰ ${s.nick}: o teste grátis acabou` : `⏰ ${s.nick}: o plano mensal acabou`), el('span', 'sub', 'O Trader parou de comprar e de entrar em sorteios. Os seus anúncios e os pokémon nas casas ficaram como estavam, e as suas configurações estão guardadas: assine e tudo volta como estava.'));
  else sit.append(el('b', null, `${s.nick}: ainda sem Premium`), el('span', 'sub', s.testeUsado ? 'O teste grátis desta conta já foi usado.' : 'Teste 3 dias grátis, sem pagar nada e sem cadastro. A assinatura é por conta (nick): cada conta, inclusive ALT, tem a sua.'));
  root.append(sit);

  // ---- o que o Trader fez no teste ----
  if (s.nick && s.plano === 'teste' && s.inicio) {
    if (!premResumo || premResumo.desde !== s.inicio) {
      const r = await call('poke:trader:resumo', s.inicio).catch(() => null);
      premResumo = r ? { ...r, desde: s.inicio } : { desde: s.inicio, nada: true };
    }
    const r = premResumo;
    if (r && !r.nada && (r.achados || r.compras)) {
      const c = el('div', 'card prem-resumo');
      const lu = [r.lucro && r.lucro.gold ? `${r.lucro.gold > 0 ? '+' : ''}${fmt(Math.round(r.lucro.gold / 1e6))} mi coins` : null, r.lucro && r.lucro.orb ? `${r.lucro.orb > 0 ? '+' : ''}${fmt(Math.round(r.lucro.orb))} 💎` : null].filter(Boolean).join(' · ');
      c.append(el('b', null, s.estado === 'teste' ? 'Até agora, no seu teste' : 'No seu teste grátis, o Trader'),
        el('div', 'prem-num', `${fmt(r.achados)} pechinchas achadas · ${fmt(r.compras)} compras · ${fmt(r.vendidas)} revendidas${lu ? ` · lucro ${lu}` : ''}`));
      root.append(c);
    }
  }

  // ---- teste grátis ----
  const pode = s.nick && s.loja;
  if (s.nick && (s.estado === 'nenhuma') && !s.testeUsado) {
    const t = el('div', 'card prem-teste');
    t.append(el('b', null, '🎁 Teste grátis de 3 dias'), el('span', 'sub', 'Tudo liberado por 3 dias: pechinchas, compra dentro dos seus limites, sorteios, a esteira, o Auto hunt e o Auto catch. Um teste por pessoa (uma conta por PC). No fim, se não assinar, o Trader para sozinho.'));
    const bt = button(s.loja ? 'Começar o teste grátis' : 'A loja abre em breve', 'primary', async () => {
      bt.disabled = true; bt.textContent = 'Liberando…';
      const r = await call('app:licenca:teste').catch(() => null);
      if (!r || r.erro) { toast(`⚠ ${(r && r.erro) || 'Não deu agora. Tente de novo.'}`); bt.disabled = false; bt.textContent = 'Começar o teste grátis'; await premAtualizar(false); return; }
      toast('🎁 Teste liberado! A aba Trader aparece no menu em até 1 minuto.');
      await premAtualizar(false);
    });
    bt.disabled = !pode;
    t.append(bt);
    root.append(t);
  }

  // ---- planos ----
  if (s.nick && s.estado !== 'vitalicio') {
    const g = el('div', 'prem-planos');
    const card = (plano, titulo, preco, linhas, destaque) => {
      const c = el('div', `card prem-plano${destaque ? ' destaque' : ''}`);
      if (destaque) c.append(el('span', 'prem-selo', destaque));
      c.append(el('b', null, titulo), el('div', 'prem-preco', preco));
      const ul = el('ul'); for (const l of linhas) ul.append(el('li', null, l)); c.append(ul);
      const bt = button(s.loja ? 'Pagar com Pix' : 'A loja abre em breve', 'primary', () => premAbrirPix(plano, bt));
      bt.disabled = !pode;
      c.append(bt);
      return c;
    };
    g.append(
      card('mensal', 'Mensal', `${premReal(s.planos.mensal.preco)}/mês`, ['30 dias de Trader, ⚡ Auto hunt e 🎯 Auto catch', 'Renovar soma 30 dias ao que falta', 'Sem renovação automática: você decide']),
      card('vitalicio', 'Vitalício', premReal(s.planos.vitalicio.preco), ['Pague uma vez, use para sempre', 'Todas as atualizações incluídas', 'Vale ~3 meses do mensal'], 'melhor valor'),
    );
    root.append(g);
    root.append(el('p', 'small', 'Pagamento por Pix, liberado em segundos. Uma assinatura por conta: vale para o nick da conta principal (★) — para usar o Trader numa ALT, ela precisa da assinatura dela. O app manda para a loja só o nick e o plano: nada do jogo e nenhuma senha.'));
  }
  if (premPix) premMostrarPix();
}

async function premAbrirPix(plano, bt) {
  if (bt) { bt.disabled = true; bt.textContent = 'Gerando o Pix…'; }
  const r = await call('app:licenca:pix', plano).catch(() => null);
  if (bt) { bt.disabled = false; bt.textContent = 'Pagar com Pix'; }
  if (!r || r.erro) return toast(`⚠ ${(r && r.erro) || 'Não consegui gerar o Pix agora.'}`);
  premPix = r;
  premMostrarPix();
  clearInterval(premPixTimer);
  premPixTimer = setInterval(premConferirPix, 4000);
}

function premMostrarPix() {
  const p = premPix;
  if (!p) return;
  const card = el('div', 'celular prem-pix');
  card.append(el('h2', null, `Pix · ${p.plano === 'vitalicio' ? 'Vitalício' : 'Mensal'} · ${premReal(p.valor)}`));
  const meio = el('div', 'cel-meio');
  const qr = el('div', 'cel-qr'); if (p.qrSvg) qr.innerHTML = p.qrSvg; // SVG gerado no processo principal
  const lado = el('div', 'cel-lado');
  const st = el('div', 'prem-pix-st', '⏳ Esperando o pagamento…');
  st.id = 'prem-pix-st';
  const ol = el('ol');
  for (const t of ['Abra o app do seu banco › Pix › Ler QR code (ou "Pix copia e cola").', 'Confira o valor e pague.', 'Pronto: o Trader libera aqui sozinho em alguns segundos.']) ol.append(el('li', null, t));
  lado.append(st, ol, button('Copiar o Pix copia e cola', null, async () => { try { await navigator.clipboard.writeText(p.copiaECola); toast('Pix copiado.'); } catch { toast('Não consegui copiar.'); } }),
    el('span', 'sub', `Este Pix vale até ${timeStr(p.expiraEm)}.`));
  meio.append(qr, lado);
  card.append(meio);
  const acts = el('div', 'actions');
  acts.append(button('Fechar', null, () => { premPix = null; clearInterval(premPixTimer); closeModal(); }));
  card.append(acts);
  openModal(card);
}

async function premConferirPix() {
  const p = premPix;
  if (!p) return clearInterval(premPixTimer);
  if (Date.now() > p.expiraEm + 60000) { clearInterval(premPixTimer); const st = document.getElementById('prem-pix-st'); if (st) st.textContent = '⌛ Este Pix venceu. Feche e gere outro.'; return; }
  const r = await call('app:licenca:pixStatus', p.id).catch(() => null);
  if (!r || r.erro || r.status === 'pendente') return;
  const st = document.getElementById('prem-pix-st');
  clearInterval(premPixTimer);
  if (r.status === 'expirado') { if (st) st.textContent = '⌛ Este Pix venceu. Feche e gere outro.'; return; }
  if (st) st.textContent = '✅ Pagamento recebido! O Trader foi liberado.';
  toast('✅ Pagamento recebido! A aba Trader aparece no menu em até 1 minuto.');
  premPix = null;
  setTimeout(() => { closeModal(); premAtualizar(false); }, 2500);
}
