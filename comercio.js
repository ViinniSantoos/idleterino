// Idleterino — #comércio automático da guild no Discord (sem servidor nosso).
//
// O líder da guild cria um webhook no canal de comércio e põe a TAG da guild entre colchetes no nome
// dele (ex.: "Comércio [TFT]"). Cada membro cola o link no app. Quando ele anuncia no Market do jogo,
// o app posta um card no canal; quando vende ou tira do Market, o card vira "VENDIDO" ou "RETIRADO".
//
// Trava da guild: o app só posta se a conta logada no jogo for da guild que está no nome do webhook
// (lido do próprio Discord: o membro não consegue trocar). O anúncio vem do jogo, não é digitado.
// O app não compra nem vende nada: ele só mostra o que a pessoa já anunciou no jogo.
const { app, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');

const WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/(\d+)\/([\w-]+)$/;
const num = (s) => Number(String(s == null ? '' : s).replace(/\D+/g, '')) || 0;
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const SITE = 'https://viinnisantoos.github.io/idleterino/';
const sprite = (id, shiny) => (id > 0 && id <= 1025 ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shiny ? 'shiny/' : ''}${id}.png` : null);

module.exports = function createComercio(ctx, poke) {
  const file = () => path.join(app.getPath('userData'), 'comercio.json');
  const DEF = { webhook: '', discord: '', contas: {}, so: 'pokemon', posts: {}, info: null };
  let C = { ...DEF };
  try { C = { ...DEF, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch {}
  const save = () => { try { fs.writeFileSync(file(), JSON.stringify(C, null, 2)); } catch {} };
  const status = {}; // accId -> { ok, texto }
  let infoAt = 0;

  // Nome do webhook (dono: o líder) -> a tag exigida. Consulta só de leitura, não posta nada.
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
  async function enviar(metodo, sufixo, body) {
    const r = await net.fetch(C.webhook + sufixo, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise((ok) => setTimeout(ok, ((j.retry_after || 2) * 1000) + 300)); return enviar(metodo, sufixo, body); }
    if (!r.ok) throw new Error(`Discord ${r.status}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  const quemContata = () => { const d = String(C.discord || '').trim(); return /^\d{15,22}$/.test(d) ? `<@${d}>` : d ? d.replace(/[`*_~|<>@]/g, '').slice(0, 40) : null; };
  function card(a, nick, tag, fim) {
    const moedaNome = a.moeda === 'orb' ? 'gemas' : 'ouro';
    const cor = fim === 'vendido' ? 0x45e39b : fim === 'retirado' ? 0x5d6378 : a.shiny ? 0xffcf4a : a.moeda === 'orb' ? 0xe055b5 : 0xf2b72a;
    const prefixo = fim === 'vendido' ? '✅ VENDIDO · ' : fim === 'retirado' ? '❌ RETIRADO · ' : '';
    const fields = [{ name: '💰 Preço', value: `**${fmt(a.preco)} ${moedaNome}**${a.qtd > 1 ? ' (cada)' : ''}`, inline: true }];
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
    const img = a.tipo === 'pokemon' ? sprite(a.sp, a.shiny) : null;
    // Botão para abrir o anúncio no Idleterino de quem clica (página do site -> idleterino://anuncio/<id>).
    const link = !fim && Number.isSafeInteger(Number(a.id)) && Number(a.id) > 0
      ? `${SITE}anuncio.html?id=${Number(a.id)}&n=${encodeURIComponent(String(a.nome || '').slice(0, 60))}&v=${encodeURIComponent(String(nick || '').slice(0, 30))}` : null;
    return {
      title: `${prefixo}${a.shiny ? '✨ ' : ''}${a.nome}${a.level ? ` · Nv ${a.level}` : ''}`.slice(0, 250),
      ...(link ? { url: link } : {}),
      description: link ? `${desc}\n🛒 **[Abrir no Idleterino](${link})**` : desc, color: cor, fields: fim ? fields.slice(0, 1).concat(fields.slice(-1)) : fields,
      ...(img ? { thumbnail: { url: img } } : {}),
      footer: { text: '📦 Anúncio real, lido do jogo pelo Idleterino' }, timestamp: new Date().toISOString(),
    };
  }
  const corpo = (embed) => ({ username: C.info && C.info.nome ? C.info.nome.slice(0, 80) : 'Comércio da guild', embeds: [embed], allowed_mentions: { parse: [] } });

  // Chamado a cada leitura de conta (30 s). Os anúncios ("Meus anúncios") se atualizam a cada leitura do Market.
  async function onRead(id, r) {
    if (!C.webhook || !C.contas[id]) return;
    const info = await lerWebhook(false);
    if (!info || info.erro) { status[id] = { ok: false, texto: info && info.erro ? info.erro : 'Sem resposta do Discord.' }; return; }
    if (!info.tag) { status[id] = { ok: false, texto: 'O líder precisa pôr a tag da guild entre colchetes no nome do webhook, ex.: "Comércio [TFT]".' }; return; }
    if (!r || !r.logged) return;
    const minhaTag = r.guildTag || null;
    if (!minhaTag || minhaTag.toLowerCase() !== info.tag.toLowerCase()) { status[id] = { ok: false, texto: `Esta conta${minhaTag ? ` é da guild [${minhaTag}]` : ' não está em guild'}; o canal é da [${info.tag}].` }; return; }
    const meus = r.mercado && r.mercado.meus;
    if (!meus || !meus.at) { status[id] = { ok: true, texto: 'Esperando a primeira leitura do Market (até 5 min).' }; return; }
    const nick = r.nick && r.nick !== '—' ? r.nick : 'Treinador';
    const linhas = (meus.linhas || []).filter((a) => C.so === 'tudo' || a.tipo === 'pokemon');
    const vivos = new Set();
    for (const a of linhas) {
      const k = `${id}|${a.id}`; vivos.add(k);
      const sig = `${a.preco}|${a.moeda}|${a.qtd}|${a.retidoAte && a.retidoAte > Date.now() ? 1 : 0}`;
      const p = C.posts[k];
      if (!p) {
        C.posts[k] = { estado: 'enviando', sig, t: Date.now(), nick, nome: a.nome };
        fila.push(async () => { const m = await enviar('POST', '?wait=true', corpo(card(a, nick, minhaTag))); C.posts[k] = { ...C.posts[k], estado: 'aberto', msg: m && m.id }; save(); });
      } else if (p.estado === 'aberto' && p.sig !== sig && p.msg) {
        p.sig = sig;
        fila.push(async () => { await enviar('PATCH', `/messages/${p.msg}`, corpo(card(a, nick, minhaTag))); save(); });
      }
      if (C.posts[k]) C.posts[k].ultimo = a;
    }
    // Sumiu de "Meus anúncios" depois que postamos: vendeu (está no histórico de vendas) ou foi retirado.
    for (const [k, p] of Object.entries(C.posts)) {
      if (!k.startsWith(`${id}|`) || vivos.has(k) || p.estado !== 'aberto' || !p.msg || meus.at < p.t + 5000) continue;
      const vendas = (r.mercado.vendas && r.mercado.vendas.linhas) || [];
      const v = vendas.find((x) => x.em && x.em >= p.t - 60000 && String(x.descricao || '').toLowerCase().includes(String(p.nome || '').toLowerCase()));
      p.estado = v ? 'vendido' : 'retirado';
      const a = { ...(p.ultimo || { nome: p.nome, preco: 0, moeda: 'gold', qtd: 1 }), comprador: v && v.comprador };
      fila.push(async () => { await enviar('PATCH', `/messages/${p.msg}`, corpo(card(a, p.nick || nick, minhaTag, p.estado))); save(); });
    }
    status[id] = { ok: true, texto: `Conectada ao canal [${info.tag}] · ${Object.entries(C.posts).filter(([k, p]) => k.startsWith(`${id}|`) && p.estado === 'aberto').length} anúncio(s) no canal.` };
    save();
    processar();
  }

  function state() {
    const accs = poke.accounts().filter((a) => a.isPoke);
    const posts = Object.entries(C.posts).map(([k, p]) => ({ k, nick: p.nick, nome: p.nome, estado: p.estado, t: p.t, preco: p.ultimo && p.ultimo.preco, moeda: p.ultimo && p.ultimo.moeda })).sort((a, b) => b.t - a.t).slice(0, 15);
    return {
      temWebhook: !!C.webhook, webhookFim: C.webhook ? `…${C.webhook.slice(-6)}` : null, info: C.info, discord: C.discord, so: C.so,
      contas: accs.map((a) => { const i = poke.infoOf(a.id) || {}; return { id: a.id, nick: i.logged && i.nick && i.nick !== '—' ? i.nick : a.name, guild: i.guildTag || null, on: !!C.contas[a.id], status: status[a.id] || null }; }),
      posts,
    };
  }
  ipcMain.handle('app:comercio:state', () => state());
  ipcMain.handle('app:comercio:set', async (_e, patch) => {
    const p = patch || {};
    if ('webhook' in p) {
      const u = String(p.webhook || '').trim();
      if (u && !WEBHOOK.test(u)) return { ...state(), error: 'Esse não parece um link de webhook do Discord (https://discord.com/api/webhooks/…).' };
      if (u !== C.webhook) { C.webhook = u; C.posts = {}; C.info = null; }
      if (u) { const i = await lerWebhook(true); if (i && i.erro) return { ...state(), error: i.erro }; }
    }
    if ('discord' in p) C.discord = String(p.discord || '').trim().slice(0, 40);
    if ('so' in p) C.so = p.so === 'tudo' ? 'tudo' : 'pokemon';
    if (p.conta) C.contas[p.conta.id] = !!p.conta.on;
    save();
    return state();
  });
  ipcMain.handle('app:comercio:atualizar', async () => { await lerWebhook(true); if (ctx.refreshMarket) ctx.refreshMarket(); return state(); });

  return { onRead, ativo: () => !!C.webhook && Object.values(C.contas).some(Boolean) };
};
