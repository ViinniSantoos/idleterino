// Retrato do pokémon como o jogo faz (direção 3, de frente), mas CENTRALIZADO pelo desenho de verdade: recorta o quadro,
// acha onde tem pixel (tira o espaço vazio da folha), amplia em número inteiro (pixel art nítido) e põe no meio.
const sprCache = new Map();
function sprCarregar(url) {
  if (!sprCache.has(url)) sprCache.set(url, new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = url; }));
  return sprCache.get(url);
}
async function sprRetrato(nome, px) {
  const s = (window.SPR || {})[nome]; if (!s) return null;
  const img = await sprCarregar(s.url); if (!img) return null;
  const c = document.createElement('canvas'); c.width = s.w; c.height = s.h;
  const g = c.getContext('2d'); g.drawImage(img, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
  let x0 = s.w, y0 = s.h, x1 = -1, y1 = -1;
  try {
    const d = g.getImageData(0, 0, s.w, s.h).data;
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (d[(y * s.w + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  } catch { x0 = 0; y0 = 0; x1 = s.w - 1; y1 = s.h - 1; }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const esc = Math.max(1, Math.floor((px * 0.86) / Math.max(w, h))) || 1;
  const fit = Math.min(esc, (px * 0.86) / Math.max(w, h));
  const o = document.createElement('canvas'); o.width = px; o.height = px;
  const go = o.getContext('2d'); go.imageSmoothingEnabled = false;
  const nw = Math.round(w * fit), nh = Math.round(h * fit);
  // Sombra no chão (o pokémon "pisa" no círculo) e o desenho no centro, um pouco para baixo.
  const cx = px / 2, base = Math.round(px / 2 + nh / 2 + px * 0.02);
  go.fillStyle = 'rgba(0,0,0,.35)'; go.beginPath(); go.ellipse(cx, Math.min(px - 3, base), nw * 0.38, Math.max(2, px * 0.045), 0, 0, Math.PI * 2); go.fill();
  go.drawImage(c, x0, y0, w, h, Math.round(cx - nw / 2), Math.round(base - nh), nw, nh);
  return o.toDataURL();
}
async function sprTodos() {
  for (const a of document.querySelectorAll('[data-p]')) {
    const px = Number(a.dataset.px) || a.clientWidth;
    const url = await sprRetrato(a.dataset.p, px);
    if (url) { a.innerHTML = `<img src="${url}" width="${px}" height="${px}" style="image-rendering:pixelated;display:block">`; a.classList.add('comSpr'); }
  }
  document.body.dataset.pronto = '1';
}
