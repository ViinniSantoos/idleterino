// Idleterino — "Apoie o dev": Pix de valor livre (QR + copia e cola + chave). Só abre quando a pessoa clica.
const PIX_CHAVE = 'b1701527-48c0-4be1-85fa-11faba0dc6b8';
// BR Code estático (valor livre), gerado a partir da chave acima; o QR (pix-qr.svg) é este mesmo texto.
const PIX_COPIA_COLA = '00020126580014br.gov.bcb.pix0136b1701527-48c0-4be1-85fa-11faba0dc6b85204000053039865802BR5910IDLETERINO6006BRASIL62070503***630481E7';

function abrirApoio() {
  const box = el('div', 'apoio');
  const qr = el('img', 'apoio-qr'); qr.src = 'pix-qr.svg'; qr.alt = 'QR Code Pix';
  const txt = el('div', 'apoio-txt');
  txt.append(
    el('h2', null, '❤ Apoie o dev'),
    el('p', null, 'O Idleterino é feito por um jogador, nas horas vagas, e é de graça para todo mundo.'),
    el('p', null, 'Se ele te ajuda no dia a dia e tocou o seu coração, qualquer valor no Pix ajuda a manter o app vivo e a trazer novidades. Se não der, tudo bem: usar e indicar para a galera já é um baita apoio. 💜'),
    el('p', 'sub', 'Escaneie o QR com o app do banco ou use o Pix copia e cola. O valor é você quem escolhe.'),
  );
  const copiar = (v, msg) => { try { navigator.clipboard.writeText(v); toast(msg); } catch { toast('Não consegui copiar agora.'); } };
  const acts = el('div', 'actions');
  acts.append(
    button('📋 Copiar Pix copia e cola', 'primary', () => copiar(PIX_COPIA_COLA, 'Pix copia e cola copiado. Cole no app do banco.')),
    button('🔑 Copiar a chave Pix', null, () => copiar(PIX_CHAVE, 'Chave Pix copiada.')),
    button('Fechar', 'ghost', closeModal),
  );
  txt.append(acts, el('p', 'small', `Chave aleatória: ${PIX_CHAVE}`));
  box.append(qr, txt);
  openModal(box);
}
(() => { const b = document.getElementById('nav-apoio'); if (b) b.onclick = abrirApoio; })();
