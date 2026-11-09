// Idleterino — a "ficha" do pokémon em imagem, para o post do #comércio no Discord.
//
// Desenha um card no estilo da ficha do jogo (arte, nota de 0 a 10 com a faixa, potência, qualidade,
// IV e os stats atuais) numa janela invisível e devolve o PNG. Roda só na hora de postar ou editar
// um anúncio, e a janela é destruída logo depois (nada fica aberto ou na memória).
const { BrowserWindow, net } = require('electron');

const FAIXAS = {
  'extremamente-fraco': ['Extremamente fraco', '#9aa0ad'], fraco: ['Fraco', '#e05555'], mediano: ['Mediano', '#f08a3c'],
  razoavel: ['Razoável', '#e8c84a'], bom: ['Bom', '#5cc46a'], forte: ['Forte', '#3fd0a0'], poderoso: ['Poderoso', '#4cc9f0'],
  mitico: ['Mítico', '#b98cff'], legendario: ['Legendário', '#ffcf4a'], divino: ['Divino', '#ff7ad9'],
};
const COR_TIPO = {
  NORMAL: '#a8a77a', FIRE: '#ee8130', WATER: '#6390f0', ELECTRIC: '#d8b416', GRASS: '#5fae3b', ICE: '#62c4c0', FIGHTING: '#c22e28',
  POISON: '#a33ea1', GROUND: '#c9a649', FLYING: '#8f7fd8', PSYCHIC: '#f95587', BUG: '#94a51b', ROCK: '#b6a136', GHOST: '#735797',
  DRAGON: '#6f35fc', DARK: '#705746', STEEL: '#8f8fae', FAIRY: '#d685ad',
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, casas = 0) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

// Arte oficial do PokeAPI (a Mega pela forma "-mega"), com cache em memória durante a sessão.
const cacheArte = new Map();
async function arteDe(nome, dex, shiny) {
  const k = `${nome}|${dex}|${shiny ? 1 : 0}`;
  if (cacheArte.has(k)) return cacheArte.get(k);
  let url = null;
  const m = /^Mega (.+?)(?: ([XY]))?$/.exec(String(nome || ''));
  if (m) {
    const slug = `${m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-')}-mega${m[2] ? `-${m[2].toLowerCase()}` : ''}`;
    try {
      const r = await net.fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`);
      if (r.ok) { const j = await r.json(); const oa = j.sprites && j.sprites.other && j.sprites.other['official-artwork']; url = (shiny && oa && oa.front_shiny) || (oa && oa.front_default) || null; }
    } catch {}
  }
  if (!url && dex > 0 && dex <= 1025) url = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${shiny ? 'shiny/' : ''}${dex}.png`;
  cacheArte.set(k, url);
  return url;
}

function html(d) {
  const [faixaNome, faixaCor] = FAIXAS[d.faixa] || ['', '#b98cff'];
  const pos = Math.max(0, Math.min(100, (Number(d.nota) || 0) * 10));
  const statNomes = [['hp', 'HP'], ['atk', 'ATK'], ['def', 'DEF'], ['spAtk', 'SP.ATK'], ['spDef', 'SP.DEF'], ['speed', 'SPD']];
  const st = d.stats || {};
  const maxSt = Math.max(1, ...statNomes.map(([k]) => Number(st[k]) || 0));
  const barras = statNomes.map(([k, n]) => {
    const v = Number(st[k]) || 0; const iv = d.ivs ? d.ivs[k] : null;
    const corIv = iv == null ? '#999' : iv >= 25 ? '#5cd17a' : iv >= 15 ? '#e8c84a' : '#e07a5f';
    return `<div class="br"><b>${n}</b><div class="tr"><i style="width:${Math.round((v / maxSt) * 100)}%"></i></div><span>${v ? num(v) : '—'}</span><em style="color:${corIv}">${iv != null ? `IV ${iv}` : ''}</em></div>`;
  }).join('');
  const tipos = (d.tipos || []).map((t) => `<span class="tp" style="background:${COR_TIPO[t] || '#777'}">${esc(t)}</span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:900px;height:470px;font-family:"Segoe UI",system-ui,sans-serif;color:#fff;background:#2a1a24;overflow:hidden}
.card{position:absolute;inset:10px;border-radius:16px;background:linear-gradient(160deg,#5b3346,#3a2230 60%,#2b1824);border:2px solid #8a5a6e;display:flex;gap:16px;padding:18px}
.esq{width:330px;display:flex;flex-direction:column;align-items:center;border-radius:12px;background:radial-gradient(circle at 50% 40%,rgba(185,140,255,.35),rgba(0,0,0,.25) 65%);padding:10px}
.arte{width:250px;height:250px;object-fit:contain;filter:drop-shadow(0 10px 18px rgba(0,0,0,.55))}
.nome{font-size:26px;font-weight:800;text-align:center;margin-top:4px;line-height:1.1}
.nv{margin-top:6px;font-size:14px;background:#1d1219;border-radius:8px;padding:3px 10px;font-weight:700}
.tps{margin-top:8px;display:flex;gap:6px}.tp{font-size:12px;font-weight:800;border-radius:6px;padding:2px 8px}
.sh{font-size:12px;font-weight:800;color:#2a1a24;background:#ffcf4a;border-radius:6px;padding:2px 8px}
.dir{flex:1;display:flex;flex-direction:column;gap:10px}
.nota{background:#1d1219;border-radius:12px;padding:10px 16px}
.nota .n{font-size:54px;font-weight:900;color:${faixaCor};line-height:1}.nota .n small{font-size:24px;color:#d9c9e6;font-weight:700}
.nota .f{font-size:16px;font-weight:900;letter-spacing:2px;color:${faixaCor};margin-top:2px}
.rg{margin-top:8px;height:10px;border-radius:5px;background:linear-gradient(90deg,#9aa0ad,#e05555,#f08a3c,#e8c84a,#5cc46a,#3fd0a0,#4cc9f0,#b98cff,#ffcf4a,#ff7ad9);position:relative}
.rg i{position:absolute;top:-4px;width:4px;height:18px;border-radius:2px;background:#fff;box-shadow:0 0 6px #fff;left:calc(${pos}% - 2px)}
.box{display:flex;gap:8px}.box div{flex:1;border-radius:10px;padding:6px 10px;background:#4b8f4f}.box div:nth-child(2){background:#7d4fc4}
.box small{display:block;font-size:11px;font-weight:800;opacity:.85}.box b{font-size:20px}
.sts{background:#1d1219;border-radius:12px;padding:8px 12px;display:flex;flex-direction:column;gap:4px}
.br{display:grid;grid-template-columns:56px 1fr 70px 48px;align-items:center;gap:8px;font-size:13px}
.tr{height:9px;border-radius:5px;background:#3a2a35;overflow:hidden}.tr i{display:block;height:100%;background:#d6a6ff;border-radius:5px}
.br span{text-align:right;font-weight:700}.br em{font-style:normal;font-weight:800;font-size:12px}
.pe{margin-top:auto;display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#d9c9e6}
.preco{font-size:20px;font-weight:900;color:#ff9ad9}
</style></head><body><div class="card">
<div class="esq">${d.arte ? `<img class="arte" src="${esc(d.arte)}">` : '<div class="arte"></div>'}
<div class="nome">${d.shiny ? '✨ ' : ''}${esc(d.nome)}</div><div class="nv">Nv ${num(d.level)}</div>
<div class="tps">${tipos}${d.shiny ? '<span class="sh">SHINY</span>' : ''}</div></div>
<div class="dir">
<div class="nota"><div class="n">${d.nota != null ? num(d.nota, 3) : '—'} <small>/ 10,0</small></div><div class="f">${esc(faixaNome.toUpperCase())}</div><div class="rg"><i></i></div></div>
<div class="box"><div><small>POTÊNCIA</small><b>P${esc(d.potencia || '?')}</b></div><div><small>QUALIDADE</small><b>${d.qualidade != null ? num(d.qualidade, 3) : '—'}</b></div><div><small>IV SOMADO</small><b>${d.iv != null ? `${d.iv}<small style="display:inline"> /192</small>` : '—'}</b></div></div>
<div class="sts">${barras}</div>
<div class="pe"><span>📦 Anúncio real, lido do jogo pelo Idleterino</span>${d.preco ? `<span class="preco">💎 ${num(d.preco)} gemas</span>` : ''}</div>
</div></div></body></html>`;
}

/** Devolve o PNG (Buffer) da ficha, ou null se não deu para desenhar. */
async function gerarFichaPng(d) {
  let win = null;
  try {
    const arte = await arteDe(d.nome, d.dex, d.shiny).catch(() => null);
    win = new BrowserWindow({ show: false, width: 900, height: 470, useContentSize: true, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true, sandbox: true, javascript: false, backgroundThrottling: false } });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html({ ...d, arte }))}`);
    await new Promise((r) => setTimeout(r, 400)); // a arte remota termina de pintar
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 900, height: 470 });
    const png = img.toPNG();
    return png && png.length > 1000 ? png : null;
  } catch { return null; } finally { if (win && !win.isDestroyed()) win.destroy(); }
}

module.exports = { gerarFichaPng, FAIXAS };
