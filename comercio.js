// Idleterino — #comércio automático da guild no Discord (sem servidor nosso).
//
// Dois jeitos de ligar o canal:
//  · Canal oficial da guild: o link do webhook vem do site do Idleterino (guildas.json), cifrado. O app só
//    usa nas contas que são de fato daquela guild no jogo, e o link nunca aparece na tela nem fica salvo.
//  · Outro canal: o líder cria um webhook e põe a TAG da guild entre colchetes no nome dele
//    (ex.: "Comércio [TFT]"); o membro cola o link nos Ajustes.
// Quando a pessoa anuncia no Market do jogo, o app posta um card no canal (em canal de fórum, cada anúncio
// vira um tópico); quando vende ou tira do Market, o card vira "VENDIDO" ou "RETIRADO".
// O app não compra nem vende nada: ele só mostra o que a pessoa já anunciou no jogo.
const { app, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { gerarFichaPng, FAIXAS } = require('./fichaImagem');

const WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/(\d+)\/([\w-]+)$/;
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const SITE = 'https://viinnisantoos.github.io/idleterino/';
const sprite = (id, shiny) => (id > 0 && id <= 1025 ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shiny ? 'shiny/' : ''}${id}.png` : null);
// A chave dos canais oficiais só existe na versão publicada (o arquivo não vai para o GitHub).
let SEGREDO = null;
try { SEGREDO = require('./segredo').chave || null; } catch {}

module.exports = function createComercio(ctx, poke) {
  const file = () => path.join(app.getPath('userData'), 'comercio.json');
  const DEF = { webhook: '', discord: '', contas: {}, so: 'pokemon', posts: {}, info: null, forum: {} };
  let C = { ...DEF };
  try { C = { ...DEF, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch {}
  if (!C.forum) C.forum = {};
  const save = () => { try { fs.writeFileSync(file(), JSON.stringify(C, null, 2)); } catch {} };
  const status = {}; // accId -> { ok, texto }
  let infoAt = 0;

  // ---------- Canais oficiais (do site; só na memória)
  let oficiais = {}; // TAG -> { url, nome }
  let oficiaisAt = 0;
  let oficiaisErro = null;
  async function carregarOficiais(force) {
    if (!SEGREDO) return oficiais;
    if (!force && Date.now() - oficiaisAt < 30 * 60 * 1000) return oficiais;
    oficiaisAt = Date.now();
    const r = await net.fetch(`${SITE}guildas.json?t=${Math.floor(Date.now() / 600000)}`).catch(() => null);
    if (!r || !r.ok) { oficiaisErro = 'Sem resposta do site do Idleterino agora.'; return oficiais; }
    const j = await r.json().catch(() => null);
    const novo = {};
    for (const [tag, g] of Object.entries((j && j.guildas) || {})) {
      try {
        const [iv, tg, ct] = String(g.c).split('.').map((x) => Buffer.from(x, 'base64'));
        const d = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(`${SEGREDO}|${tag}|v${Number(g.v) || 1}`).digest(), iv);
        d.setAuthTag(tg);
        const url = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
        if (WEBHOOK.test(url)) novo[tag.toUpperCase()] = { url, nome: String(g.nome || `Comércio ${tag}`).slice(0, 60) };
      } catch {}
    }
    oficiais = novo; oficiaisErro = null;
    return oficiais;
  }

  // ---------- Outro canal (link colado): o nome do webhook diz a guild
  async function lerWebhook(force) {
    if (!C.webhook) { C.info = null; return null; }
    if (!force && C.info && Date.now() - infoAt < 30 * 60 * 1000) return C.info;
    const r = await net.fetch(C.webhook).catch(() => null);
    if (!r) return C.info;
    if (!r.ok) { C.info = { erro: r.status === 404 || r.status === 401 ? 'Esse webhook não existe mais (foi apagado ou trocado). Peça o link novo ao líder.' : `O Discord respondeu ${r.status}.` }; save(); return C.info; }
    const j = await r.json().catch(() => ({}));
    const m = /\[([^\]]{1,10})\]/.exec(j.name || '');
    C.info = { nome: j.name || '', tag: m ? m[1].trim() : null, canal: j.channel_id || null, at: Date.now() };
    infoAt = Date.now();
    save();
    return C.info;
  }

  // O canal desta conta: o colado (se houver) ou o oficial da guild dela.
  async function canalDa(tagConta) {
    if (C.webhook) {
      const info = await lerWebhook(false);
      if (!info || info.erro) return { erro: info && info.erro ? info.erro : 'Sem resposta do Discord.' };
      if (!info.tag) return { erro: 'O líder precisa pôr a tag da guild entre colchetes no nome do webhook, ex.: "Comércio [TFT]".' };
      return { key: 'manual', tag: info.tag, nome: info.nome };
    }
    await carregarOficiais(false);
    const g = tagConta && oficiais[tagConta.toUpperCase()];
    if (g) return { key: `g:${tagConta.toUpperCase()}`, tag: tagConta.toUpperCase(), nome: g.nome };
    return { erro: tagConta ? `A guild [${tagConta}] ainda não tem canal oficial no Idleterino. Dá para colar o link de um webhook em "Outro canal".` : 'Esta conta não está em guild.' };
  }
  const urlDe = (key) => (key === 'manual' ? C.webhook : key && key.startsWith('g:') && oficiais[key.slice(2)] ? oficiais[key.slice(2)].url : null);

  const fila = [];
  let rodando = false;
  async function processar() {
    if (rodando) return;
    rodando = true;
    try {
      while (fila.length) {
        const job = fila.shift();
        try { await job(); } catch {}
        await new Promise((r) => setTimeout(r, 1500)); // limite do Discord: devagar e sempre
      }
    } finally { rodando = false; }
  }
  async function enviar(key, metodo, sufixo, body, png) {
    const base = urlDe(key);
    if (!base) throw new Error('canal indisponível');
    let opts;
    if (png) {
      // Com a imagem da ficha: multipart (payload_json + o arquivo), que o Discord mostra dentro do card.
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ ...body, attachments: [{ id: 0, filename: 'ficha.png' }] }));
      fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'ficha.png');
      opts = { method: metodo, body: fd };
    } else opts = { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await net.fetch(base + sufixo, opts);
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise((ok) => setTimeout(ok, ((j.retry_after || 2) * 1000) + 300)); return enviar(key, metodo, sufixo, body, png); }
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(`Discord ${r.status}`); e.code = j && j.code; throw e; }
    return r.status === 204 ? null : r.json().catch(() => null);
  }
  // Post novo: em canal de fórum o Discord exige um título (vira um tópico por anúncio).
  async function postar(key, a, body, png) {
    const comTopico = () => ({ ...body, thread_name: tituloTopico(a) });
    if (C.forum[key]) { const m = await enviar(key, 'POST', '?wait=true', comTopico(), png); return { m, thread: m && m.channel_id }; }
    try {
      return { m: await enviar(key, 'POST', '?wait=true', body, png), thread: null };
    } catch (e) {
      if (e.code !== 220001) throw e;
      C.forum[key] = true; save();
      const m = await enviar(key, 'POST', '?wait=true', comTopico(), png);
      return { m, thread: m && m.channel_id };
    }
  }
  const sufixoMsg = (p) => `/messages/${p.msg}${p.thread ? `?thread_id=${p.thread}` : ''}`;

  // Título do tópico no padrão que a guild já usa no fórum: "VENDO GALLADE SHINY 60K".
  const precoCurto = (n) => {
    n = Number(n) || 0;
    const f = (v, suf) => `${(Math.round(v * 10) / 10).toString().replace('.', ',')}${suf}`;
    return n >= 1e6 ? f(n / 1e6, 'M') : n >= 1e3 ? f(n / 1e3, 'K') : String(n);
  };
  function tituloTopico(a) {
    const nome = String(a.nome || 'Pokémon').toUpperCase();
    return `VENDO ${nome}${a.shiny ? ' SHINY' : ''}${a.qtd > 1 ? ` x${a.qtd}` : ''} ${precoCurto(a.preco)}${a.moeda === 'orb' ? '' : ' OURO'}${a.qtd > 1 ? ' CADA' : ''}`.slice(0, 100);
  }

  // Nota (0 a 10, igual à ficha do jogo) e a imagem da ficha. Se der errado, o card sai como antes.
  async function extraDe(accId, a) {
    if (a.tipo !== 'pokemon' || !poke.fichaNota) return null;
    const info = await poke.fichaNota(accId, { speciesId: a.sp, ivs: a.ivs, refino: a.refino, quality: a.q, potencia: a.pot, shiny: a.shiny, level: a.level }).catch(() => null);
    if (!info) return null;
    const png = await gerarFichaPng({ ...info, nome: info.nome || a.nome, level: a.level, shiny: a.shiny, potencia: a.pot, qualidade: a.q, iv: a.iv, ivs: a.ivs, preco: a.preco }).catch(() => null);
    return { nota: info.nota, faixa: info.faixa, png };
  }
  const quemContata = () => { const d = String(C.discord || '').trim(); return /^\d{15,22}$/.test(d) ? `<@${d}>` : d ? d.replace(/[`*_~|<>@]/g, '').slice(0, 40) : null; };
  function card(a, nick, tag, fim, extra) {
    const moedaNome = a.moeda === 'orb' ? 'gemas' : 'ouro';
    const cor = fim === 'vendido' ? 0x45e39b : fim === 'retirado' ? 0x5d6378 : a.shiny ? 0xffcf4a : a.moeda === 'orb' ? 0xe055b5 : 0xf2b72a;
    const prefixo = fim === 'vendido' ? '✅ VENDIDO · ' : fim === 'retirado' ? '❌ RETIRADO · ' : '';
    const fields = [{ name: '💰 Preço', value: `**${fmt(a.preco)} ${moedaNome}**${a.qtd > 1 ? ' (cada)' : ''}`, inline: true }];
    const nota = extra && extra.nota != null ? extra.nota : a.nota;
    const faixa = extra && extra.faixa ? extra.faixa : a.faixa;
    if (nota != null) fields.unshift({ name: '🏅 Nota', value: `**${Number(nota).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} / 10**${faixa && FAIXAS[faixa] ? ` · ${FAIXAS[faixa][0]}` : ''}`, inline: true });
    if (a.qtd > 1) fields.push({ name: '📦 Quantidade', value: fmt(a.qtd), inline: true });
    if (a.iv) fields.push({ name: '🧬 IV somado', value: `${a.iv}/192`, inline: true });
    if (a.q) fields.push({ name: '⭐ Qualidade', value: String(a.q).replace('.', ','), inline: true });
    if (a.pot) fields.push({ name: '⚡ Potência', value: `P${a.pot}`, inline: true });
    if (a.aoe) fields.push({ name: '💥 AoE', value: 'sim', inline: true });
    const c = quemContata();
    fields.push({ name: '🧑 Vendedor', value: `**${nick}**${tag ? ` [${tag}]` : ''}${c ? `\n💬 ${c}` : ''}`, inline: false });
    const desc = fim === 'vendido' ? `Vendido${a.comprador ? ` para **${a.comprador}**` : ''}.`
      : fim === 'retirado' ? 'O vendedor tirou do Market.'
        : a.retidoAte && a.retidoAte > Date.now() ? `⏳ Liberado para compra <t:${Math.floor(a.retidoAte / 1000)}:R>. Compre no **Market do jogo**.` : 'Compre no **Market do jogo**: busque pelo nome ou pelo vendedor.';
    const comFicha = !!(extra && extra.png) && !fim;
    const img = a.tipo === 'pokemon' && !comFicha ? sprite(a.sp, a.shiny) : null;
    // Botão para abrir o anúncio no Idleterino de quem clica (página do site -> idleterino://anuncio/<id>).
    const link = !fim && Number.isSafeInteger(Number(a.id)) && Number(a.id) > 0
      ? `${SITE}anuncio.html?id=${Number(a.id)}&n=${encodeURIComponent(String(a.nome || '').slice(0, 60))}&v=${encodeURIComponent(String(nick || '').slice(0, 30))}` : null;
    return {
      title: `${prefixo}${a.shiny ? '✨ ' : ''}${a.nome}${a.level ? ` · Nv ${a.level}` : ''}`.slice(0, 250),
      ...(link ? { url: link } : {}),
      description: link ? `${desc}\n🛒 **[Abrir no Idleterino](${link})**` : desc, color: cor, fields: fim ? fields.filter((f) => /Nota|Preço/.test(f.name)).concat(fields.slice(-1)) : fields,
      ...(img ? { thumbnail: { url: img } } : {}),
      ...(comFicha ? { image: { url: 'attachment://ficha.png' } } : {}),
      footer: { text: '📦 Anúncio real, lido do jogo pelo Idleterino' }, timestamp: new Date().toISOString(),
    };
  }
  const mesmoBicho = (u, a) => !!u && u.sp === a.sp && u.level === a.level && !!u.shiny === !!a.shiny && u.iv === a.iv && u.q === a.q && u.pot === a.pot;
  const corpo = (embed) => ({ embeds: [embed], allowed_mentions: { parse: [] } });

  // Chamado a cada leitura de conta (30 s). Os anúncios ("Meus anúncios") se atualizam a cada leitura do Market.
  async function onRead(id, r) {
    if (!C.contas[id]) return;
    if (!r || !r.logged) return;
    const minhaTag = r.guildTag || null;
    const canal = await canalDa(minhaTag);
    if (canal.erro) { status[id] = { ok: false, texto: canal.erro }; return; }
    if (!minhaTag || minhaTag.toLowerCase() !== canal.tag.toLowerCase()) { status[id] = { ok: false, texto: `Esta conta${minhaTag ? ` é da guild [${minhaTag}]` : ' não está em guild'}; o canal é da [${canal.tag}].` }; return; }
    const meus = r.mercado && r.mercado.meus;
    if (!meus || !meus.at) { status[id] = { ok: true, texto: 'Esperando a primeira leitura do Market (até 5 min).' }; return; }
    const nick = r.nick && r.nick !== '—' ? r.nick : 'Treinador';
    // Só pokémon à venda em GEMAS vai para o Discord (itens e vendas em ouro floodariam o canal).
    const pokes = (meus.linhas || []).filter((a) => a.tipo === 'pokemon');
    // A chave é o POKÉMON, não o anúncio: tirar do Market e pôr de novo (ou trocar o preço, que no jogo
    // vira anúncio novo) cria outro id de anúncio, e o card certo é o que já está no canal.
    const chave = (a) => (a.pk != null ? `${id}|p${a.pk}` : `${id}|${a.id}`);
    // "Vivo" = ainda está no Market em gemas. O resto que tinha card vira RETIRADO lá embaixo.
    const vivos = new Set();
    for (const a of pokes) {
      if (a.moeda !== 'orb') continue;
      const k = chave(a); vivos.add(k);
      const sig = `${a.id}|${a.preco}|${a.moeda}|${a.qtd}|${a.retidoAte && a.retidoAte > Date.now() ? 1 : 0}`;
      // Card antigo (de antes da chave por pokémon) do mesmo bicho: passa a usar a chave nova.
      if (!C.posts[k] && a.pk != null) {
        const velho = Object.keys(C.posts).find((kv) => kv.startsWith(`${id}|`) && !kv.includes('|p') && C.posts[kv].msg && C.posts[kv].estado !== 'vendido' && mesmoBicho(C.posts[kv].ultimo, a));
        if (velho) { C.posts[k] = C.posts[velho]; delete C.posts[velho]; }
      }
      const p = C.posts[k];
      if (!p) {
        C.posts[k] = { estado: 'enviando', sig, t: Date.now(), nick, nome: a.nome, canal: canal.key };
        fila.push(async () => {
          try {
            const ex = await extraDe(id, a);
            const { m, thread } = await postar(canal.key, a, corpo(card(a, nick, minhaTag, null, ex)), ex && ex.png);
            C.posts[k] = { ...C.posts[k], estado: 'aberto', msg: m && m.id, thread, nota: ex && ex.nota, faixa: ex && ex.faixa };
          } catch { delete C.posts[k]; } // tenta de novo na próxima leitura
          save();
        });
      } else if (p.msg && (p.estado === 'retirado' || (p.estado === 'aberto' && p.sig !== sig))) {
        // Voltou ao Market ou mudou o preço: o MESMO card volta a valer, com o anúncio de agora.
        p.estado = 'aberto'; p.sig = sig; p.t = Date.now(); p.nick = nick;
        fila.push(async () => {
          const ex = await extraDe(id, a);
          if (ex) { p.nota = ex.nota; p.faixa = ex.faixa; }
          await enviar(p.canal || canal.key, 'PATCH', sufixoMsg(p), corpo(card(a, nick, minhaTag, null, ex)), ex && ex.png);
          save();
        });
      }
      if (C.posts[k]) C.posts[k].ultimo = a;
    }
    // Sumiu de "Meus anúncios" depois que postamos: vendeu (está no histórico de vendas) ou foi retirado.
    for (const [k, p] of Object.entries(C.posts)) {
      if (!k.startsWith(`${id}|`) || vivos.has(k) || p.estado !== 'aberto' || !p.msg || meus.at < p.t + 5000) continue;
      const vendas = (r.mercado.vendas && r.mercado.vendas.linhas) || [];
      const v = vendas.find((x) => x.em && x.em >= p.t - 60000 && String(x.descricao || '').toLowerCase().includes(String(p.nome || '').toLowerCase()));
      p.estado = v ? 'vendido' : 'retirado';
      const a = { ...(p.ultimo || { nome: p.nome, preco: 0, moeda: 'gold', qtd: 1 }), comprador: v && v.comprador, nota: p.nota, faixa: p.faixa };
      fila.push(async () => { await enviar(p.canal || canal.key, 'PATCH', sufixoMsg(p), corpo(card(a, p.nick || nick, minhaTag, p.estado))); save(); });
    }
    status[id] = { ok: true, texto: `Conectada ao canal ${canal.key === 'manual' ? '' : 'oficial '}[${canal.tag}] · ${Object.entries(C.posts).filter(([k, p]) => k.startsWith(`${id}|`) && p.estado === 'aberto').length} anúncio(s) no canal.` };
    save();
    processar();
  }

  function state() {
    const accs = poke.accounts().filter((a) => a.isPoke);
    const posts = Object.entries(C.posts).map(([k, p]) => ({ k, nick: p.nick, nome: p.nome, estado: p.estado, t: p.t, preco: p.ultimo && p.ultimo.preco, moeda: p.ultimo && p.ultimo.moeda })).sort((a, b) => b.t - a.t).slice(0, 15);
    return {
      temWebhook: !!C.webhook, webhookFim: C.webhook ? `…${C.webhook.slice(-6)}` : null, info: C.info, discord: C.discord,
      oficiais: Object.entries(oficiais).map(([tag, g]) => ({ tag, nome: g.nome })), oficiaisErro, temOficial: !!SEGREDO,
      contas: accs.map((a) => { const i = poke.infoOf(a.id) || {}; return { id: a.id, nick: i.logged && i.nick && i.nick !== '—' ? i.nick : a.name, guild: i.guildTag || null, on: !!C.contas[a.id], status: status[a.id] || null }; }),
      posts,
    };
  }
  ipcMain.handle('app:comercio:state', async () => { await carregarOficiais(false); return state(); });
  ipcMain.handle('app:comercio:set', async (_e, patch) => {
    const p = patch || {};
    if ('webhook' in p) {
      const u = String(p.webhook || '').trim();
      if (u && !WEBHOOK.test(u)) return { ...state(), error: 'Esse não parece um link de webhook do Discord (https://discord.com/api/webhooks/…).' };
      if (u !== C.webhook) { C.webhook = u; C.info = null; }
      if (u) { const i = await lerWebhook(true); if (i && i.erro) return { ...state(), error: i.erro }; }
    }
    if ('discord' in p) C.discord = String(p.discord || '').trim().slice(0, 40);
    if (p.conta) C.contas[p.conta.id] = !!p.conta.on;
    save();
    return state();
  });
  ipcMain.handle('app:comercio:atualizar', async () => { await Promise.all([lerWebhook(true), carregarOficiais(true)]); if (ctx.refreshMarket) ctx.refreshMarket(); return state(); });

  return { onRead, ativo: () => Object.values(C.contas).some(Boolean) };
};
