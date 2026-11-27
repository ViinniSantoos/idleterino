// Idleterino — 🖼️ RETRATO DO POKÉMON (27/11/2026, visual novo; ver design/README.md).
// retratoEl(speciesId, px, tipo) devolve na hora um círculo com a cor do tipo (a "plataforma") e a 1ª letra; a imagem do
// jogo chega logo depois (pedidos juntados em lote, cache na memória). Sem conta aberta, fica a letra — nada quebra.
const RET_TIPO = { NORMAL: '--t-normal', FIRE: '--t-fire', WATER: '--t-water', GRASS: '--t-grass', ELECTRIC: '--t-electric', ICE: '--t-ice', FIGHTING: '--t-fighting', POISON: '--t-poison', GROUND: '--t-ground', FLYING: '--t-flying', PSYCHIC: '--t-psychic', BUG: '--t-bug', ROCK: '--t-rock', GHOST: '--t-ghost', DRAGON: '--t-dragon', DARK: '--t-dark', STEEL: '--t-steel', FAIRY: '--t-fairy' };
const retMem = new Map(); // `${id}|${px}` -> dataURL | null
const retEspera = new Map(); // px -> { ids:Set, els: [[id, img, el]] }
let retTimer = null;
function retratoEl(speciesId, px = 56, tipo = null, nome = '') {
  const id = Number(speciesId);
  const box = document.createElement('span');
  box.className = 'retrato';
  box.style.width = box.style.height = `${px}px`;
  const cor = RET_TIPO[String(tipo || '').toUpperCase()];
  if (cor) box.style.setProperty('--rt', `var(${cor})`);
  const letra = document.createElement('b'); letra.textContent = String(nome || '?').charAt(0).toUpperCase(); letra.style.fontSize = `${Math.round(px * 0.38)}px`;
  box.append(letra);
  if (!(id > 0)) return box;
  const px2 = Math.round(px * 1.12); // a imagem sai um pouco do círculo (mais vida)
  const pinta = (url) => { if (!url) return; const img = new Image(); img.width = img.height = px2; img.alt = nome || ''; img.src = url; box.replaceChildren(img); box.classList.add('tem'); };
  const k = `${id}|${px2}`;
  if (retMem.has(k)) { pinta(retMem.get(k)); return box; }
  const fila = retEspera.get(px2) || { ids: new Set(), els: [] };
  fila.ids.add(id); fila.els.push([id, pinta]); retEspera.set(px2, fila);
  clearTimeout(retTimer); retTimer = setTimeout(retBuscar, 40);
  return box;
}
async function retBuscar() {
  const lotes = [...retEspera.entries()]; retEspera.clear();
  for (const [px, f] of lotes) {
    let r = {};
    try { r = (await window.idle.invoke('poke:retratos', [...f.ids], px)) || {}; } catch {}
    for (const id of f.ids) if (r[id]) retMem.set(`${id}|${px}`, r[id]); // sem imagem agora (conta fechada): tenta de novo depois
    for (const [id, pinta] of f.els) pinta(r[id]);
  }
}
