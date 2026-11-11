// Idleterino — "Levar para o celular": escolher as contas, mostrar o QR e o PIN (com prazo de 5 minutos).
async function abrirLevarCelular() {
  const card = el('div', 'celular');
  card.append(el('h2', null, '📱 Levar as contas para o celular'), el('p', 'sub', 'Abre o Idleterino Android já com as suas contas do PokeIdle logadas, sem digitar senha. Escolha quais contas levar:'));
  const lista = el('div', 'cel-lista');
  card.append(lista, el('p', 'sub', 'Carregando as contas…'));
  openModal(card);
  const contas = await call('app:celular:contas');
  card.querySelector('p.sub:last-of-type').remove();
  const marcadas = new Set();
  for (const c of contas || []) {
    const l = el('label', `cel-conta${c.logada ? '' : ' off'}`);
    const cb = el('input'); cb.type = 'checkbox'; cb.disabled = !c.logada; cb.checked = c.logada; if (c.logada) marcadas.add(c.id);
    cb.onchange = () => { if (cb.checked) marcadas.add(c.id); else marcadas.delete(c.id); };
    l.append(cb, el('b', null, c.nick || c.nome), el('span', 'sub', c.logada ? (c.nick && c.nick !== c.nome ? c.nome : 'logada') : 'não está logada'));
    lista.append(l);
  }
  if (!contas || !contas.length) lista.append(el('p', 'sub', 'Nenhuma conta do PokeIdle neste PC.'));
  const acts = el('div', 'actions');
  acts.append(button('Cancelar', null, closeModal), button('Gerar QR Code', 'primary', async () => {
    if (!marcadas.size) return toast('Escolha pelo menos uma conta.');
    const r = await call('app:celular:gerar', [...marcadas]);
    if (!r || r.erro) return toast(`⚠ ${(r && r.erro) || 'Não consegui gerar agora.'}`);
    mostrarQrCelular(r);
  }));
  card.append(acts);
}

// O QR na janela, pequeno e simples (como o do Pix): ele só leva o endereço do PC na rede de casa.
function mostrarQrCelular(r) {
  const card = el('div', 'celular');
  card.append(el('h2', null, '📱 Aponte a câmera do celular'));
  const meio = el('div', 'cel-meio');
  const qr = el('div', 'cel-qr'); qr.innerHTML = r.qrSvg; // o SVG vem do próprio app (gerado no processo principal)
  const lado = el('div', 'cel-lado');
  const pin = el('div', 'cel-pin', r.pin.replace(/(\d{4})(\d{4})/, '$1 $2'));
  const tempo = el('div', 'cel-tempo');
  const ol = el('ol');
  for (const t of ['Deixe o celular na MESMA Wi-Fi deste PC.', 'Abra a câmera do celular e aponte para o QR.', 'Toque no link que aparecer: o Idleterino abre.', 'Digite o PIN de 8 números. Pronto: as contas entram logadas.']) ol.append(el('li', null, t));
  lado.append(el('span', 'sub', 'Quando o celular pedir, digite o PIN:'), pin, tempo, el('span', 'sub', `${r.n} conta(s): ${r.nomes.join(', ')}`), ol,
    el('div', 'tip warn', '🔒 Não mostre este QR nem o PIN para ninguém: juntos, eles dão acesso às suas contas.'));
  meio.append(qr, lado);
  card.append(meio, el('p', 'small', 'Se o Windows perguntar se o Idleterino pode usar a rede, permita na rede PRIVADA (é a sua Wi-Fi de casa). A conta que entrar no celular sai do PC, igual quando você abre no navegador.'));
  const acts = el('div', 'actions');
  const fechar = () => { call('app:celular:fechar'); closeModal(); };
  acts.append(button('Baixar o app Android', null, () => window.open('https://github.com/ViinniSantoos/idleterino-android/releases/latest', '_blank')), button('Fechar', 'primary', fechar));
  card.append(acts);
  openModal(card);
  const tick = () => {
    if (!card.isConnected) { call('app:celular:fechar'); return clearInterval(t); }
    const s = Math.max(0, Math.round((r.exp - Date.now()) / 1000));
    tempo.textContent = s > 0 ? `Vale por mais ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expirou. Feche e gere outro.';
    if (s <= 0) { qr.style.opacity = '.12'; pin.style.opacity = '.3'; clearInterval(t); }
  };
  const t = setInterval(tick, 1000); tick();
}
