// Idleterino — preparo das páginas das contas do PokeIdle (roda antes do jogo).
//
// O jogo só aceita UMA conexão por conta, então nada de abrir outra: o app escuta a conexão que o
// próprio jogo abriu e, quando precisa, faz pelas mesmas vias as CONSULTAS que as telas do jogo
// fazem (mercado, tabela do PvP, perfil público de um jogador). Comprar, vender, editar, remover,
// jogar ou mexer em qualquer coisa: nunca (nem é possível por aqui — só consultas da lista PEDIDOS).
//
// O que vem daqui para o Início e para a aba PvP:
//  · mercado: Meus anúncios, Histórico de vendas e Tabela de preços;
//  · Twitch/Kick: a lista oficial de canais e o tempo de bônus;
//  · bônus de XP (com o fim de cada parte) e as hunts com o nível de cada uma;
//  · sugestão de hunt: o tempo de abate com as fórmulas do jogo (stats, golpes, efetividade da hunt, AoE,
//    bicicleta), acertado pela vida real dos selvagens e pelo placar que a conta já fez em cada hunt;
//  · PvP: a tabela ranqueada e a equipe pública dos primeiros (uma consulta a cada poucos segundos).
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    if (!/(^|\.)pokeidle\.io$/.test(location.hostname)) return;
    const Native = window.WebSocket;
    const keep = {};
    const canais = {};
    let hunts = [];      // [{ nome, nivel }] uma por nível (meta de XP)
    let bonusXp = null;  // { tr, pk, partes: [{ id, tr, ate, alvo }] }
    let sock = null;
    // ENCAIXE para ferramentas que só existem num PC (ex.: o Trader do dono, que não vai no app público): quem se
    // encaixa recebe as peças do núcleo e pode ouvir o socket e esconder do jogo as respostas das consultas dele.
    const extras = { filtros: [], ouvintes: [], api: {}, instalados: new Set() };
    const ABAS = { meus: 1, historico: 1, historicoGlobal: 1 };
    const SEQ = 987654321;
    const SEQ_SHINY = 987654555; // consultas da aba Procurar shiny na Tabela de preços (o jogo descarta seq que não é dele)
    let shinyHist = null;

    // ---- estado leve do jogador: o que a sugestão de hunt e o PvP precisam ----
    const jogo = { hunts: null, tabelaTipos: null, amp: 1.5, multHp: 5, eu: {}, pks: new Map(), keys: [] };
    const CAMPOS_EU = ['diaSazonal', 'guild', 'xp', 'xpNivel', 'xpProximo', 'gold', 'orbs', 'nick', 'level', 'activeId', 'bicicleta', 'pvp', 'pvpRank', 'pvpPosicao', 'pvpHistorico', 'pvpTime', 'huntSlug', 'hunt', 'huntAtual', 'area'];
    const DUELO = (k) => ({ ivs: k.ivs || null, quality: k.quality ?? k.qualidade ?? null, potencia: k.potencia ?? null, refino: k.refino || null, tmElemental: k.tmElemental || null, tmFisico: !!k.tmFisico });
    const slimPk = (k) => ({
      ...DUELO(k),
      id: k.id, speciesId: k.speciesId, level: Number(k.level) || 0, shiny: !!k.shiny, starter: !!k.starter,
      aoe: k.tmAoe === true || k.tmAoe === 1 || k.tmAoe === 'true' || k.tm_aoe === true,
      el: k.tmElemental || k.tm_elemental || null, apelido: k.apelido || null, poder: Number(k.poder || k.power) || 0,
      xp: Number(k.xp) || 0, xpNivel: Number(k.xpNivel) || 0, // aba Casas: quanto falta para o nível pedido
      slot: k.slot ?? null, // na EQUIPE (0–4); fora dela, Depot ou Coleção
    });
    function aplicarEstado(p, cheioForcado) {
      if (!p || typeof p !== 'object') return;
      const { cheio, pokemons, pkMud, pkFora } = p;
      if (cheio || cheioForcado) jogo.keys = Object.keys(p);
      for (const k of CAMPOS_EU) if (k in p) jogo.eu[k] = p[k];
      // Casas (aba Casas): junta por cima, porque o jogo pode mandar só o pedaço que mudou (ex.: só "dentro").
      if (p.casa && typeof p.casa === 'object') jogo.eu.casa = { ...(jogo.eu.casa || {}), ...p.casa };
      if (p.bonusXp && Array.isArray(p.bonusXp.partes)) jogo.eu.bonusXpBruto = p.bonusXp;
      // Shiny Secret Lure da Loja: só o fim dele (o resto da Loja não interessa ao app).
      if (p.loja && p.loja.boosts && 'shiny' in p.loja.boosts) jogo.eu.lureAte = Number(p.loja.boosts.shiny) || 0;
      // Capture Boost da Loja (aba Procurar shiny: o shiny só conta se a bola fechar).
      if (p.loja && p.loja.boosts && 'captura' in p.loja.boosts) jogo.eu.capturaAte = Number(p.loja.boosts.captura) || 0;
      // As bolas da mochila (quantas de cada): a aba Procurar shiny usa a melhor que a pessoa tem.
      if (p.balls && typeof p.balls === 'object') jogo.eu.balls = { ...p.balls };
      // A COLEÇÃO do jogo são os pokémon travados (automation.pokemonTravado); fora da equipe e da coleção = Depot.
      if (p.automation && Array.isArray(p.automation.pokemonTravado)) jogo.eu.travados = p.automation.pokemonTravado.map(Number);
      if ('nick' in p || 'xp' in p || 'level' in p) jogo.at = Date.now();
      if (Array.isArray(pokemons)) jogo.pks = new Map(pokemons.map((k) => [k.id, slimPk(k)]));
      for (const k of pkMud || []) jogo.pks.set(k.id, slimPk(k));
      for (const id of pkFora || []) jogo.pks.delete(id);
    }

    // ---- consultas do app que o jogo NÃO deve desenhar (o perfil de outro jogador abriria na tela) ----
    const nossos = { tabela: 0, perfis: new Map(), especies: 0, lista: 0, itens: 0 };
    let itensResp = null; // resposta do market.itens pedida pela Calculadora de Boss
    const precos = {}; // nome em minúsculas -> { em, linhas }
    let ultimaEspecies = null;
    let ultimaLista = null;
    const recente = (t) => t && Date.now() - t < 30000;
    function ehNosso(d) {
      if (typeof d !== 'string') return false;
      if (d.indexOf('"pvpTabela"') >= 0 && recente(nossos.tabela)) return true;
      if (d.indexOf('"especies"') >= 0 && d.indexOf('"market"') >= 0 && Date.now() - nossos.especies < 8000) return true;
      if (d.indexOf('"vitrine"') >= 0 && d.indexOf('"market"') >= 0 && Date.now() - nossos.lista < 8000) return true;
      if (d.indexOf('"seq":' + SEQ_SHINY) >= 0 && d.indexOf('"market"') >= 0) return true;
      if (Date.now() - nossos.itens < 8000 && d.indexOf('"aba":"itens"') >= 0 && d.indexOf('"market"') >= 0) return true;
      for (const f of extras.filtros) { try { if (f(d)) return true; } catch {} }
      if (d.indexOf('"perfil"') >= 0 && nossos.perfis.size) {
        try { const m = JSON.parse(d); if (m.t === 'perfil' && m.perfil && recente(nossos.perfis.get(String(m.perfil.nick || '').toLowerCase()))) return true; } catch {}
      }
      return false;
    }

    // ---- PvP: tabela e equipes do topo ----
    const pvp = { tabela: null, tabelaEm: 0, perfis: {}, coletando: false, feitos: 0, total: 0, at: 0, erro: null };
    const slimTime = (lista) => (Array.isArray(lista) ? lista : []).slice(0, 5).map((k) => ({
      ...DUELO(k),
      speciesId: k.speciesId ?? k.especieId ?? k.pokeId ?? null, nome: k.nome || k.name || null, level: Number(k.level) || 0,
      shiny: !!k.shiny, aoe: k.tmAoe === true || k.tmAoe === 1, el: k.tmElemental || null, casa: k.casa ?? k.posicao ?? null,
      poder: Number(k.poder || k.power) || 0, potencia: k.potencia ?? null,
    }));

    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      try {
        if (new URL(url, location.href).host === location.host) {
          sock = ws;
          // O jogo lê pelo `onmessage`: embrulhado para não desenhar as respostas das consultas do app.
          const desc = Object.getOwnPropertyDescriptor(Native.prototype, 'onmessage');
          if (desc && desc.set) {
            Object.defineProperty(ws, 'onmessage', {
              configurable: true,
              get() { return desc.get.call(ws); },
              set(fn) { desc.set.call(ws, typeof fn === 'function' ? function (ev) { if (ehNosso(ev.data)) return undefined; return fn.call(this, ev); } : fn); },
            });
          }
          ws.addEventListener('message', (e) => {
            const d = e.data;
            if (typeof d !== 'string') return;
            for (const f of extras.ouvintes) { try { f(d); } catch {} }
            const welcome = d.indexOf('"welcome"') >= 0 && d.indexOf('"welcome"') < 40;
            const estado = !welcome && d.indexOf('"estado"') >= 0 && d.indexOf('"t":"estado"') >= 0;
            if (welcome || estado) {
              try {
                const m = JSON.parse(d);
                const est = m && m.estado;
                if (m.t === 'welcome') {
                  if (Array.isArray(m.hunts)) {
                    jogo.hunts = m.hunts;
                    hunts = m.hunts.map((h) => ({ nome: String(h.nome || h.name || h.slug || ''), nivel: Number(h.nivel ?? h.level) || 0 }))
                      .filter((h) => h.nome && h.nivel > 0).sort((a, b) => a.nivel - b.nivel)
                      .filter((h, i, l) => i === 0 || l[i - 1].nivel !== h.nivel);
                  }
                  if (m.tabelaTipos) jogo.tabelaTipos = m.tabelaTipos;
                  if (m.ampliacaoHunt) jogo.amp = Number(m.ampliacaoHunt) || 1.5;
                  if (m.multHpSelvagem) jogo.multHp = Number(m.multHpSelvagem) || 5;
                  if (m.chanceShiny) jogo.chanceShiny = Number(m.chanceShiny) || 0;
                  // Procurar shiny: quem tem forma shiny (dex), as bolas e a conta de captura do jogo.
                  if (m.shinyLooks && typeof m.shinyLooks === 'object') jogo.shinyDex = new Set(Object.keys(m.shinyLooks).map(Number));
                  if (Array.isArray(m.catalogoBolas)) jogo.bolas = m.catalogoBolas.map((b) => ({ id: b.id, nome: b.nome, rate: Number(b.catchRate) || 1 }));
                  if (m.captura && typeof m.captura === 'object') jogo.captura = m.captura;
                  if (m.mercado && typeof m.mercado === 'object') jogo.mercado = m.mercado;
                  // Pedras: de evolução por tipo, a Shiny Stone por tipo e as de Mega (com os fragmentos e o custo de fabricar).
                  if (m.mega && typeof m.mega === 'object') jogo.mega = m.mega;
                  if (m.shinyStone && typeof m.shinyStone === 'object') jogo.shinyStone = m.shinyStone;
                  if (m.pedrasEvolucao && typeof m.pedrasEvolucao === 'object') jogo.pedrasEvolucao = m.pedrasEvolucao;
                  // TM Researcher: fragmentos de AoE e de Z-Move (pieceAoe/pieceElemental) e quantos fazem um (custoAoe/custoElemental).
                  if (m.tmResearcher && typeof m.tmResearcher === 'object') jogo.tmResearcher = m.tmResearcher;
                  // Calculadora de Boss: os bosses (token de entrada e drops com a chance) e a taxa do Market.
                  if (Array.isArray(m.bossesJogaveis)) jogo.bosses = m.bossesJogaveis;
                  if (m.economia && typeof m.economia === 'object') jogo.economia = m.economia;
                }
                aplicarEstado(est, m.t === 'welcome');
                const bx = est && est.bonusXp;
                if (bx && Array.isArray(bx.partes)) {
                  bonusXp = { at: Date.now(), tr: Number(bx.tr) || 1, pk: Number(bx.pk) || 1,
                    partes: bx.partes.map((x) => ({ id: String(x.id || ''), tr: Number(x.tr) || 1, ate: Number(x.ate) || 0, alvo: Number(x.alvo) || 0 })) };
                }
                for (const k of ['twitch', 'kick']) {
                  const b = est && est[k];
                  if (!b || !Array.isArray(b.oficiais)) continue;
                  canais[k] = {
                    at: Date.now(),
                    oficiais: b.oficiais.map((x) => ({ id: String(x.login || x.slug || '').toLowerCase(), nome: x.nome || '', ativo: !!x.ativo })).filter((x) => x.id),
                    recompensas: Array.isArray(b.recompensas) ? b.recompensas.map((r) => ({ tipo: r.tipo, custo: r.custo })) : [],
                    bonus: b.bonus && typeof b.bonus === 'object' ? { ...b.bonus } : {},
                    pct: b.pct, minutos: b.minutos,
                  };
                }
              } catch {}
              return;
            }
            if (d.indexOf('"pvpTabela"') >= 0) {
              try { const m = JSON.parse(d); if (m.t === 'pvpTabela' && !m.erro && Number(m.pagina) === 1) { pvp.tabela = Array.isArray(m.linhas) ? m.linhas : []; pvp.tabelaEm = Date.now(); } } catch {}
              return;
            }
            if (d.indexOf('"perfil"') >= 0 && d.indexOf('"t":"perfil"') >= 0) {
              try {
                const m = JSON.parse(d);
                const p = m.perfil;
                if (p && p.nick && nossos.perfis.has(String(p.nick).toLowerCase())) pvp.perfis[String(p.nick)] = { em: Date.now(), time: slimTime(p.pvpTime), chaves: Object.keys(p).slice(0, 40) };
              } catch {}
              return;
            }
            if (d.indexOf('"t":"pvp"') >= 0) {
              try {
                const m = JSON.parse(d);
                if (m.t === 'pvp') {
                  pvp.eu = { em: Date.now(), dados: JSON.parse(JSON.stringify(m)) };
                  // O time ATIVO do PvP (ids) e a casa de cada um no tabuleiro: o jogo manda em pedaços (time/casas ou
                  // timeSalvo/casasSalvas ao salvar). Guarda o último de cada para o Planejador abrir com ele.
                  const t = m.timeSalvo !== undefined ? m.timeSalvo : m.time;
                  const c = m.timeSalvo !== undefined ? m.casasSalvas : m.casas;
                  if (Array.isArray(t)) pvp.meuTime = { ...(pvp.meuTime || {}), ids: t.map(Number).filter(Number.isFinite).slice(0, 5), em: Date.now() };
                  if (c && typeof c === 'object') pvp.meuTime = { ...(pvp.meuTime || {}), casas: { ...c }, em: Date.now() };
                }
              } catch {}
              return;
            }
            // Campo: só o pacote em que selvagens aparecem (`mhp`), para a vida real e o tamanho dos bandos.
            const ic = d.indexOf('"t":"campo"');
            if (ic >= 0 && ic < 40) {
              if (d.indexOf('"mhp"') >= 0) { try { campoNovos(JSON.parse(d)); } catch {} }
              return;
            }
            if (d.indexOf('"market"') < 0) return;
            try {
              const m = JSON.parse(d);
              if (m && m.t === 'market' && m.aba === 'especies' && Date.now() - nossos.especies < 8000) { ultimaEspecies = { em: Date.now(), m }; return; }
              if (m && m.t === 'market' && m.aba === 'vitrine' && Date.now() - nossos.lista < 8000) { ultimaLista = { em: Date.now(), m }; return; }
              if (m && m.t === 'market' && m.seq === SEQ_SHINY) { shinyHist = { em: Date.now(), m }; return; }
              if (m && m.t === 'market' && m.aba === 'itens' && Date.now() - nossos.itens < 8000) { itensResp = { em: Date.now(), m }; return; }
              if (!m || m.t !== 'market' || !ABAS[m.aba]) return;
              if (m.aba !== 'meus' && m.seq != null && m.seq !== SEQ) return;
              const key = m.aba === 'historicoGlobal' ? `historicoGlobal:${m.pagina || 0}` : m.aba;
              keep[key] = { at: Date.now(), m };
            } catch {}
          });
        }
      } catch {}
      return ws;
    }
    Patched.prototype = Native.prototype;
    Object.setPrototypeOf(Patched, Native);
    window.WebSocket = Patched;

    // ---- catálogo de espécies (os mesmos arquivos que o jogo baixa) ----
    let especiesP = null;
    function especies() {
      if (!especiesP) {
        especiesP = (async () => {
          const lista = [];
          for (const f of ['/assets/creatures.json', '/assets/creatures-novos.json', '/assets/creatures-outland-novos.json', '/assets/creatures-formas.json']) {
            try { const r = await fetch(f); if (r.ok) { const j = await r.json(); if (Array.isArray(j.creatures)) lista.push(...j.creatures); } } catch {}
          }
          const map = new Map();
          for (const c of lista) if (c && c.pokeId != null) map.set(c.pokeId, c);
          // As Megas o jogo monta a partir da base (tipos e status próprios): a mesma função dele.
          try { const mg = await import('/shared/megas.mjs'); for (const e of mg.criarEspeciesMega(lista)) map.set(e.pokeId, e); } catch {}
          return map;
        })();
      }
      return especiesP;
    }
    // ---- nota do pokémon (0 a 10), igual à da ficha do jogo ----
    // O jogo monta o catálogo com os elos de evolução e o "piso da linhagem" antes de dar a nota
    // (evoluir sempre sobe a nota). Os mesmos módulos dele, só quando o comércio vai postar.
    let catNotaP = null;
    function catalogoNota() {
      if (!catNotaP) {
        catNotaP = (async () => {
          const lista = [];
          for (const f of ['/assets/creatures.json', '/assets/creatures-novos.json', '/assets/creatures-outland-novos.json', '/assets/creatures-formas.json']) {
            try { const r = await fetch(f); if (r.ok) { const j = await r.json(); if (Array.isArray(j.creatures)) lista.push(...j.creatures); } } catch {}
          }
          const [mg, cz, ln, nt, gi] = await Promise.all([import('/shared/megas.mjs'), import('/shared/evolucoes-cruzadas.mjs'), import('/shared/linhagem-nota.mjs'), import('/shared/nota-pokemon.mjs'), import('/shared/ginasios.mjs')]);
          try { cz.aplicarCadeiasTruncadas(lista); } catch {}
          try { cz.aplicarEvolucoesEntreGeracoes(lista); } catch {}
          let megasPedras = [];
          try { for (const e of mg.criarEspeciesMega(lista)) lista.push(e); } catch {}
          const map = new Map(lista.map((c) => [c.pokeId, c]));
          try { ln.anotarLinhagemDaNota(lista, (id) => map.get(id), mg.elosMegaDaNota(lista)); } catch {}
          try { megasPedras = mg; } catch {}
          return { map, nt, gi, mg: megasPedras };
        })().catch((e) => { catNotaP = null; throw e; });
      }
      return catNotaP;
    }
    async function fichaNota(f) {
      const { map, nt, gi, mg } = await catalogoNota();
      const esp = map.get(Number(f && f.speciesId));
      if (!esp) return null;
      const pk = { id: 1, speciesId: esp.pokeId, ivs: f.ivs || null, refino: f.refino || null, quality: f.quality, potencia: f.potencia, shiny: !!f.shiny, level: Number(f.level) || 1 };
      let nota = null; try { nota = nt.notaDePokemon(pk, esp); } catch {}
      let stats = null; try { stats = pk.ivs ? gi.statsNoNivel(pk, esp, pk.level) : null; } catch {}
      let dex = esp.pokeId;
      try { if (mg.especieBaseDaMega) { const b = mg.especieBaseDaMega(esp.pokeId); if (b) dex = b.pokeId || b; } } catch {}
      if (dex >= 13000 && dex < 14000) dex -= 13000;
      else if (dex >= 9000 && dex < 10000) dex -= 9000; // a 2ª Mega de um dex
      else if (dex >= 3000 && dex < 4000) dex -= 3000; // a Mega (#3000 + dex)
      return { nota, faixa: nota != null ? nt.faixaDaNota(nota) : null, nome: esp.name, tipos: [esp.type1, esp.type2].filter((x) => x && x !== 'NONE'), stats, dex: Number(dex) || 0 };
    }
    // ---- aba PvE: próximas hunts e "evoluir para qual?" (mesmas regras do jogo) ----
    const PEDRA_POR_TIPO = { NORMAL: 'Sun Stone', FIRE: 'Fire Stone', WATER: 'Water Stone', GRASS: 'Leaf Stone', ELECTRIC: 'Thunder Stone', ICE: 'Ice Stone', FIGHTING: 'Punch Stone', POISON: 'Venom Stone', GROUND: 'Earth Stone', FLYING: 'Feather Stone', PSYCHIC: 'Enigma Stone', BUG: 'Cocoon Stone', ROCK: 'Rock Stone', GHOST: 'Darkness Stone', DRAGON: 'Ancient Stone', DARK: 'Darkness Stone', STEEL: 'Metal Stone', FAIRY: 'Heart Stone' };
    let pveRam = null;
    async function catalogoPve() {
      const c = await catalogoNota();
      if (!pveRam) {
        pveRam = await import('/shared/evolucoes-ramificadas.mjs');
        // Os níveis de evolução no teto de captura, como o jogo faz no boot (a tabela já vem ajustada por ele).
        try { const teto = await import('/shared/teto-captura.mjs'); teto.aplicarTetoDeCaptura([...c.map.values()], (id) => c.map.get(id)); } catch {}
      }
      return { ...c, ram: pveRam };
    }
    const fxTipo = (atk, defs) => defs.reduce((m, d) => m * ((jogo.tabelaTipos && jogo.tabelaTipos[atk] && jogo.tabelaTipos[atk][d] != null) ? jogo.tabelaTipos[atk][d] : 1), 1);
    const naHuntX = (x) => { const a = jogo.amp || 1.5; return x > 1 ? 1 + (x - 1) * a : x < 1 ? x / a : 1; };
    const melhorX = (atks, defs) => Math.max(0, ...atks.map((t) => naHuntX(fxTipo(t, defs))));
    const statsBase = (c) => ({ hp: c.baseHp, atk: c.baseAtk, def: c.baseDef, spAtk: c.baseSpAtk, spDef: c.baseSpDef, speed: c.baseSpeed });
    // Regiões do Mapa (nível em que cada uma abre). O sufixo do slug da hunt diz a região quando existe
    // (ex.: gabite_sinnoh); senão vale a faixa de nível (Outland fica junto de Kanto/Johto).
    const REGIOES = [['Kanto', 1], ['Johto', 200], ['Hoenn', 500], ['Sinnoh', 1000], ['Unova', 5000], ['Kalos', 10000], ['Alola', 25000], ['Galar', 40000], ['Paldea', 75000]];
    const regiaoPorNivel = (n) => { let i = 0; for (let k = 0; k < REGIOES.length; k++) if (n >= REGIOES[k][1]) i = k; return i; };
    const regiaoDe = (h) => {
      const sl = String(h.slug || '').toLowerCase();
      const k = REGIOES.findIndex(([nm]) => sl.endsWith('_' + nm.toLowerCase()));
      return k >= 0 ? k : regiaoPorNivel(Number(h.nivel) || 0);
    };
    // XP total para chegar ao nível L (curva do jogo) e o nível a que a conta chega com X horas de farm.
    const xpTotalNv = (L) => (50 / 3) * (L ** 3 - 6 * L ** 2 + 17 * L - 12);
    function xpHoraDaConta() {
      const nick = String(jogo.eu.nick || '').toLowerCase();
      try { const s2 = nick && JSON.parse(localStorage.getItem('sessao-hunt:' + nick) || 'null'); if (s2 && s2.ms > 30 * 60000 && s2.xpTreinador > 0) return s2.xpTreinador / (s2.ms / 3600000); } catch {}
      return 0;
    }
    function nivelDepoisDe(L, horas, xpH) {
      if (!(xpH > 0) || !(horas > 0)) return L;
      const alvo = xpTotalNv(L) + xpH * horas;
      let lo = L, hi = L * 4 + 100;
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (xpTotalNv(m) < alvo) lo = m; else hi = m; }
      return Math.floor(lo);
    }
    // Hunts que importam para um pokémon que a conta vai usar por um tempo: TODAS as da região em que ela está
    // e as da próxima, mais as que ela alcança no horizonte. Cada hunt leva todas as espécies (peso = pontos).
    function huntsDoHorizonte(map, L, Lh) {
      const rAtual = regiaoPorNivel(L);
      const rFim = Math.max(rAtual + 1, regiaoPorNivel(Lh));
      return (jogo.hunts || []).filter((h) => Array.isArray(h.especies) && h.especies.length).map((h) => {
        const n = Number(h.nivel) || 0; const r = regiaoDe(h);
        if (r < rAtual || r > rFim) return null;
        // As que ela já pode ou vai poder caçar no horizonte valem 1; as de depois (só a próxima região) valem ½.
        const peso = n <= Math.max(Lh, L) ? 1 : 0.5;
        const esp2 = h.especies.map((e) => ({ t: tiposDe(map.get(e.pokeId) || {}), w: Number(e.pontos) || 1 })).filter((e) => e.t.length);
        return esp2.length ? { nivel: n, regiao: REGIOES[r][0], peso, esp: esp2 } : null;
      }).filter(Boolean);
    }
    // Quanto um ataque (lista de tipos) rende numa hunt: a média da melhor efetividade contra cada espécie.
    const multNaHunt = (atks, h) => { let s2 = 0, w = 0; for (const e of h.esp) { s2 += melhorX(atks, e.t) * e.w; w += e.w; } return w ? s2 / w : 0; };
    function coberturaHunts(atks, alvo) {
      let x25 = 0, x55 = 0, sc = 0;
      for (const h of alvo) { const m = multNaHunt(atks, h); if (m >= 4.5) x55++; else if (m >= 2.2) x25++; sc += h.peso * m; }
      return { x25, x55, sc };
    }
    const bst = (c) => ['baseHp', 'baseAtk', 'baseDef', 'baseSpAtk', 'baseSpDef', 'baseSpeed'].reduce((t, k) => t + (Number(c[k]) || 0), 0);
    async function pveMeus() {
      const { map } = await catalogoNota();
      const por = new Map();
      for (const k of jogo.pks.values()) {
        const c = map.get(k.speciesId); if (!c) continue;
        const cur = por.get(k.speciesId);
        if (!cur || k.level > cur.level) por.set(k.speciesId, { id: k.id, speciesId: k.speciesId, nome: c.name, level: k.level, shiny: !!k.shiny, tipos: tiposDe(c), el: k.el || k.tmElemental || null });
      }
      return [...por.values()].sort((a, b) => b.level - a.level);
    }
    async function pveProximas() {
      if (!jogo.hunts || !jogo.tabelaTipos) return { pronto: false };
      const { map } = await catalogoNota();
      const L = Number(jogo.eu.level) || 0;
      // Só quem dá conta: até o nível do treinador + 5 (regra do jogo) e pelo menos metade dele.
      const meus = (await pveMeus()).filter((m) => m.level <= L + 5 && m.level >= L * 0.5);
      const niveis = [...new Set(jogo.hunts.map((h) => Number(h.nivel) || 0).filter((n) => n > L))].sort((a, b) => a - b).slice(0, 3);
      const TIPOS = Object.keys(jogo.tabelaTipos);
      const grupos = niveis.map((nv) => {
        const hunts = jogo.hunts.filter((h) => Number(h.nivel) === nv && Array.isArray(h.especies) && h.especies.length).map((h) => {
          const e = h.especies[0]; const c = map.get(e.pokeId) || {}; const t = tiposDe(c);
          const ataques = TIPOS.map((tp) => ({ t: tp, x: naHuntX(fxTipo(tp, t)) })).filter((a) => a.x >= 2.4).sort((a, b) => b.x - a.x).slice(0, 4);
          let meu = null;
          for (const m of meus) { const x = melhorX([...new Set([...m.tipos, m.el].filter(Boolean))], t); if (!meu || x > meu.x || (x === meu.x && m.level > meu.level)) meu = { nome: m.nome, level: m.level, x }; }
          return { nome: String(h.nome || h.slug), tipos: t, ataques, meu, doDia: !!(tipoDoDia() && t.includes(tipoDoDia())) };
        }).sort((a, b) => (b.meu ? b.meu.x : 0) - (a.meu ? a.meu.x : 0));
        return { nivel: nv, hunts };
      });
      return { pronto: true, L, grupos, tipoDia: tipoDoDia() };
    }

    // ---- aba Casas: em quanto tempo o pokémon da casa chega no nível que a pessoa quer ----
    // A casa repassa ao pokémon do posto uma parte do XP do pokémon de BATALHA, já com os buffs (Comum 25%,
    // Incomum 40%, Rara 75%, Mítica/Lendária 100%; a Lendária tem 2 postos). Só as casas EM USO repartem. O Exp.
    // Share segurado (5%) fica de fora desta conta. É uma ESTIMATIVA, simulada de 10 em 10 minutos:
    //  · XP limpo por abate = o da hunt (depende só do nível da hunt) × abates/h (medidos quando dá);
    //  · cada buff vale até acabar (ou para sempre, se a pessoa diz que renova); o dos Atrasados vale até o
    //    TREINADOR chegar no alvo dele, e o treinador sobe junto na simulação;
    //  · "subir de hunt": quando o treinador libera um nível de hunt maior, o XP passa a ser o dela.
    const PCT_CASA = { comum: 0.25, incomum: 0.4, rara: 0.75, mitica: 1, lendaria: 1 };
    const NOME_BUFF = { vip: 'VIP', boostXp: 'XP Boost (só treinador)', boostPokexp: 'XP Boost Pokémon', guildBoost: 'Boost da Guild', twitch: 'Bônus Twitch', kick: 'Bônus Kick', atrasados: 'Boost dos Atrasados', guild: 'Guild no ranking', evento: 'Evento', raid: 'Raid Gigantamax', sacrificio: 'Sacrifício', outros: 'Outro bônus' };
    // Só dá para renovar o que a pessoa compra ou resgata de novo. Evento, Raid, ranking da guild e Atrasados não.
    const RENOVAVEL = { vip: 1, boostXp: 1, boostPokexp: 1, guildBoost: 1, twitch: 1, kick: 1, sacrificio: 1 };
    async function pveCasas(arg) {
      const o = arg && typeof arg === 'object' ? arg : {};
      const lista = jogo.eu.casa && Array.isArray(jogo.eu.casa.lista) ? jogo.eu.casa.lista : null;
      if (!lista) return { pronto: false, motivo: 'casas' };
      let pctDe = (r) => PCT_CASA[r] || 0;
      try { const cs = await import('/shared/casas.mjs'); if (cs.xpShareDaRaridade) pctDe = (r) => Number(cs.xpShareDaRaridade(r)) || PCT_CASA[r] || 0; } catch {}
      const emUso = lista.filter((c) => c && !c.anunciada && c.emUso !== false);
      const ativo = jogo.eu.activeId;
      const postos = [];
      for (const c of emUso) {
        (Array.isArray(c.postos) ? c.postos : []).forEach((id, slot) => {
          if (id == null) return;
          const k = jogo.pks.get(id);
          postos.push({ casaId: c.id, rar: c.rar, pct: pctDe(c.rar), slot, id, k, batalha: id === ativo });
        });
      }
      const base = { pronto: true, casas: emUso.map((c) => ({ id: c.id, rar: c.rar, pct: pctDe(c.rar), postos: (c.postos || []).length, ocupados: (c.postos || []).filter((x) => x != null).length })), guardadas: lista.length - emUso.length, total: lista.length };
      if (!postos.length) return { ...base, pokemons: [] };

      // Hunt de agora e o ritmo (abates/h) da Melhor hunt — medido quando a conta já caçou ali.
      const hr = await huntRank().catch(() => null);
      const at = hr && hr.atualEst;
      const esp = await especies();
      let ha = null; try { ha = await import('/hunt-analyser.mjs'); } catch {}
      const xpPorAbate = (h) => { try { return ha ? ha.mediaPorKill(h, esp, 0).xp : 0; } catch { return 0; } };
      // Melhor XP por abate de cada nível de hunt (para quando o treinador liberar a próxima).
      const porNivel = new Map();
      for (const h of jogo.hunts || []) {
        const n = Number(h.nivel) || 0;
        if (!n || !Array.isArray(h.especies) || !h.especies.length) continue;
        const x = xpPorAbate(h);
        const cur = porNivel.get(n);
        if (x > 0 && (!cur || x > cur.xp)) porNivel.set(n, { nivel: n, xp: x, nome: String(h.nome || h.name || h.slug || '?') });
      }
      const niveis = [...porNivel.values()].sort((a, b) => a.nivel - b.nivel);
      const huntAgora = at && (jogo.hunts || []).find((h) => h.slug && h.slug === at.slug);
      const xpAbAgora = huntAgora ? xpPorAbate(huntAgora) : 0;
      const kph = at ? Number(at.kph) || 0 : 0;

      // Buffs de agora (o servidor manda cada parte com o fator do treinador, do pokémon e o fim).
      const agora = Date.now();
      const bx = jogo.eu.bonusXpBruto;
      let partes = [];
      if (bx && Array.isArray(bx.partes)) {
        partes = bx.partes.map((x) => ({ id: String(x.id || ''), tr: Number(x.tr) || 1, pk: Number(x.pk) || 1, ate: Number(x.ate) || 0, alvo: Number(x.alvo) || 0 }))
          .filter((x) => !(x.ate > 0) || x.ate > agora);
        const prod = (k) => partes.reduce((m, x) => m * x[k], 1);
        const resto = (k) => { const r = (Number(bx[k]) || 1) / prod(k); return Math.abs(r - 1) < 1e-4 ? 1 : r; };
        if (resto('tr') !== 1 || resto('pk') !== 1) partes.push({ id: 'outros', tr: resto('tr'), pk: resto('pk'), ate: 0, alvo: 0 });
      }
      // VIP "permanente": o jogo guarda uma data muito distante.
      const PERMANENTE = agora + 5 * 365 * 86400000;
      // Renovar é escolhido buff por buff: { boostPokexp: true, ... } (o antigo `true` = todos os renováveis).
      const renovar = o.renovar === true ? { ...RENOVAVEL } : o.renovar && typeof o.renovar === 'object' ? o.renovar : {};
      const renova = (id) => !!(RENOVAVEL[id] && renovar[id]);
      const subir = o.subir !== false;
      const horasDia = Math.min(24, Math.max(1, Number(o.horasDia) || 24));
      const f = horasDia / 24;
      const vale = (x, t, Ltr) => {
        if (x.id === 'atrasados') return !(x.alvo > 0) || Ltr < x.alvo;
        if (!(x.ate > 0) || x.ate >= PERMANENTE || renova(x.id)) return true;
        return agora + t < x.ate;
      };
      const multEm = (k, t, Ltr) => partes.reduce((m, x) => (vale(x, t, Ltr) ? m * x[k] : m), 1);

      // Pokémon de cada posto, com o alvo pedido (padrão: o próximo múltiplo de 500).
      const alvos = o.alvos && typeof o.alvos === 'object' ? o.alvos : {};
      const pks = postos.map((p) => {
        const k = p.k || {};
        const lv = Number(k.level) || 0;
        const c = esp.get(k.speciesId) || {};
        const pedido = Math.floor(Number(alvos[p.id]) || 0);
        const alvo = pedido > lv ? pedido : (Math.floor(lv / 500) + 1) * 500;
        // A curva do pokémon é a mesma do treinador; se o jogo mandar outra escala, acerta pela que ele mandou.
        const esc = lv > 1 && k.xpNivel > 0 ? k.xpNivel / xpTotalNv(lv) : 1;
        const xpAlvo = xpTotalNv(alvo) * (esc > 0.5 && esc < 2 ? esc : 1);
        const xp = Number(k.xp) || (k.xpNivel || 0);
        return { id: p.id, nome: (k.apelido || c.name || '?'), especie: c.name || '?', shiny: !!k.shiny, level: lv, alvo, pedido: pedido > lv,
          casaId: p.casaId, rar: p.rar, pct: p.pct, batalha: p.batalha, semDados: !(k.xp > 0 || k.xpNivel > 0),
          falta: Math.max(0, xpAlvo - xp), _xp: xp, _alvo: xpAlvo, ms: null };
      });

      const out = { ...base, kph, horasDia, renovando: Object.keys(RENOVAVEL).filter(renova).length, subir, huntAgora: at ? { nome: at.nome, nivel: Number(at.nivel) || 0 } : null,
        partes: partes.map((x) => ({ ...x, nome: NOME_BUFF[x.id] || x.id, permanente: x.id !== 'atrasados' && (!(x.ate > 0) || x.ate >= PERMANENTE), renovavel: !!RENOVAVEL[x.id], renovar: renova(x.id) })),
        multPk: multEm('pk', 0, Number(jogo.eu.level) || 0), multTr: multEm('tr', 0, Number(jogo.eu.level) || 0) };
      // XP do pokémon de batalha: o placar real da sessão (para conferir o cálculo).
      try {
        const nick = String(jogo.eu.nick || '').toLowerCase();
        const s = nick && JSON.parse(localStorage.getItem('sessao-hunt:' + nick) || 'null');
        if (s && s.ms > 10 * 60000 && s.xpPokemon > 0) out.xpPkMedidoH = Math.round(s.xpPokemon / (s.ms / 3600000));
      } catch {}
      if (!(kph > 0) || !(xpAbAgora > 0)) {
        out.semHunt = true;
        out.pokemons = pks.map(({ _xp, _alvo, ...r }) => r);
        return out;
      }
      out.xpPkAgoraH = Math.round(kph * xpAbAgora * out.multPk);
      for (const p of pks) p.xpH = p.batalha ? 0 : Math.round(kph * xpAbAgora * out.multPk * p.pct);

      // Simulação: o treinador e os pokémon das casas sobem juntos; buffs e hunt mudam no caminho.
      const PASSO = 10 * 60000, HORIZ = 366 * 86400000;
      let Ltr = Number(jogo.eu.level) || 1;
      let xpTr = Number(jogo.eu.xp) || xpTotalNv(Ltr);
      let nvHunt = Number(at.nivel) || 0, xpAb = xpAbAgora;
      const eventos = [];
      const ativos = new Set(partes.filter((x) => vale(x, 0, Ltr)).map((x) => x.id));
      const pend = pks.filter((p) => !p.batalha && p.falta > 0);
      for (const p of pks) if (!p.batalha && p.falta <= 0) p.ms = 0;
      for (let t = 0; t < HORIZ && pend.length; t += PASSO) {
        const mTr = multEm('tr', t, Ltr), mPk = multEm('pk', t, Ltr);
        const ganho = kph * xpAb * (PASSO / 3600000) * f;
        xpTr += ganho * mTr;
        while (xpTr >= xpTotalNv(Ltr + 1)) Ltr++;
        for (let i = pend.length - 1; i >= 0; i--) {
          const p = pend[i];
          p._xp += ganho * mPk * p.pct;
          if (p._xp >= p._alvo) { p.ms = t + PASSO; pend.splice(i, 1); }
        }
        const anota = (e) => { if (eventos.length < 12) eventos.push(e); };
        for (const x of partes) if (ativos.has(x.id) && !vale(x, t + PASSO, Ltr)) { ativos.delete(x.id); anota({ ms: t + PASSO, tipo: 'buff', nome: NOME_BUFF[x.id] || x.id }); }
        if (subir) {
          let prox = null;
          for (const h of niveis) { if (h.nivel > nvHunt && h.nivel <= Ltr) prox = h; }
          if (prox && prox.xp > xpAb) { nvHunt = prox.nivel; xpAb = prox.xp; anota({ ms: t + PASSO, tipo: 'hunt', nome: prox.nome, nivel: prox.nivel }); }
        }
      }
      out.eventos = eventos;
      out.pokemons = pks.map(({ _xp, _alvo, ...r }) => r);
      return out;
    }
    const STATS_K =[['hp', 'HP'], ['atk', 'ATK'], ['def', 'DEF'], ['spAtk', 'SP.ATK'], ['spDef', 'SP.DEF'], ['speed', 'SPD']];
    const numTxt = (v) => Number(String(v || '').replace(/[^\d.]/g, '')) || 0;
    function lerFichaColada(txt, map) {
      const t = String(txt || '');
      const lin = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
      const nomeEsp = lin(/^\s*-\s*(?:Espécie|Species|Especie)\s*:\s*([^(\n—]+)/mi);
      if (!nomeEsp) return { erro: 'Não achei a espécie na ficha colada. Use o botão "Copiar p/ ChatGPT" da ficha do pokémon no jogo e cole tudo.' };
      const alvo = nomeEsp.toLowerCase();
      const esp = [...map.values()].find((c) => c && c.name && c.name.toLowerCase() === alvo);
      if (!esp) return { erro: `Não conheço a espécie "${nomeEsp}".` };
      const nivel = numTxt(lin(/^\s*-\s*(?:Nível|Level|Nivel)\s*:\s*([\d.,]+)/mi)) || 1;
      const pot = Number((lin(/^\s*-\s*(?:Potência|Potency|Potencia)\s*:\s*P(\d)/mi)) || 1);
      const qual = Number(lin(/^\s*-\s*(?:Qualidade|Quality|Calidad)\s*:\s*([\d.]+)/mi)) || null;
      const shiny = /^\s*-\s*Shiny\s*:\s*(sim|yes|sí|si)\b/mi.test(t);
      // A tabela: acha a coluna do IV pelo cabeçalho.
      const linhas = t.split(/\r?\n/).filter((l) => /^\s*\|/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
      const cab = linhas.find((c) => c.some((x) => /^IV\b/i.test(x)));
      if (!cab) return { erro: 'A ficha colada não traz os IVs (anúncio antigo?).' };
      const iIv = cab.findIndex((x) => /^IV\b/i.test(x));
      const ivs = {};
      for (const [k, rot] of STATS_K) { const l = linhas.find((c) => c[0] && c[0].toUpperCase() === rot); if (l) ivs[k] = numTxt(l[iIv]); }
      if (Object.keys(ivs).length < 6) return { erro: 'Não consegui ler os 6 IVs da ficha colada.' };
      return { pk: { id: 1, speciesId: esp.pokeId, level: nivel, ivs, potencia: pot, quality: qual, shiny, refino: null }, esp };
    }
    async function pveEvolucoes(arg) {
      const { map, ram, gi } = await catalogoPve();
      const o0 = arg && typeof arg === 'object' ? arg : { speciesId: arg };
      // O indivíduo (quando há): um pokémon da conta ou a ficha colada — os IVs dele valem em toda forma.
      let ind = null;
      if (o0.texto) {
        const f = lerFichaColada(o0.texto, map);
        if (f.erro) return { erro: f.erro };
        ind = f.pk; o0.speciesId = f.esp.pokeId;
      } else if (o0.pkId != null) {
        const k = jogo.pks.get(o0.pkId) || [...jogo.pks.values()].find((x) => String(x.id) === String(o0.pkId));
        if (k && k.ivs) ind = { id: 1, speciesId: k.speciesId, level: Number(k.level) || 1, ivs: k.ivs, potencia: k.potencia, quality: k.quality, shiny: !!k.shiny, refino: null };
      }
      const speciesId = o0.speciesId;
      const base = map.get(Number(speciesId));
      if (!base) return { erro: 'Espécie não encontrada.' };
      const buscar = (id) => map.get(id);
      const finais = [];
      const dfs = (esp, passos, prof) => {
        let ds = []; try { ds = ram.destinosDeEvolucao(esp, buscar); } catch {}
        const comArte = ds.filter((d) => d.temArte);
        const prox = comArte.length ? comArte : ds;
        if (!prox.length || prof > 4) { finais.push({ final: esp, passos }); return; }
        for (const d of prox) {
          let tp = null; try { tp = ram.tipoDaPedraDeEvolucao(esp, d.especie); } catch {}
          dfs(d.especie, [...passos, { de: esp.name, para: d.especie.name, nivel: Number(d.nivel) || 0, pedra: tp ? PEDRA_POR_TIPO[tp] || null : null, temArte: !!d.temArte }], prof + 1);
        }
      };
      dfs(base, [], 0);
      // Hunts que a pessoa vai enfrentar: do nível dela até o triplo (as próximas regiões).
      const L = Number(jogo.eu.level) || 0;
      const alvo = huntsDoHorizonte(map, L, nivelDepoisDe(L, 30 * 12, xpHoraDaConta()));
      const nivelUso = ind ? Math.max(ind.level, L) : L;
      const metaT = (Array.isArray(o0.meta) ? o0.meta : []).map((m) => ({ t: tiposDe(map.get(Number(m.id)) || {}), w: Number(m.n) || 1 })).filter((m) => m.t.length);
      const metaW = metaT.reduce((a2, m) => a2 + m.w, 0);
      const xPvp = (atks, defs) => Math.max(0, ...atks.map((t) => fxTipo(t, defs)));
      const avalia = (c, mega) => {
        const t = tiposDe(c);
        const { x25, x55, sc } = coberturaHunts(t, alvo);
        const fisico = (Number(c.baseAtk) || 0) >= (Number(c.baseSpAtk) || 0);
        const r0 = { pokeId: c.pokeId, nome: c.name, tipos: t, stats: statsBase(c), bst: bst(c), ataque: Math.max(Number(c.baseAtk) || 0, Number(c.baseSpAtk) || 0), fisico, x25, x55, sc: Math.round(sc * 100) / 100, huntsAlvo: alvo.length, mega };
        if (metaW) {
          // Contra os times do top 50: em quantos ela bate forte (×2+) e quantos batem forte nela.
          let vant = 0, risco = 0;
          for (const m of metaT) { if (xPvp(t, m.t) >= 2) vant += m.w; if (xPvp(m.t, t) >= 2) risco += m.w; }
          r0.pvpVant = Math.round((vant / metaW) * 100); r0.pvpRisco = Math.round((risco / metaW) * 100);
        }
        if (ind) {
          let st = null; try { st = gi.statsNoNivel({ ...ind, speciesId: c.pokeId }, c, nivelUso); } catch {}
          if (st) {
            const real = {}; for (const [k] of STATS_K) real[k] = Math.round(Number(st[k]) || 0);
            // Encaixe: a média dos IVs pesada pela base desta forma, contra a média simples dos IVs.
            // Acima de 0: os IVs altos caem nos stats em que esta forma é forte.
            const b = statsBase(c); const sb = Object.values(b).reduce((a2, v) => a2 + (Number(v) || 0), 0) || 1;
            const ivMed = STATS_K.reduce((a2, [k]) => a2 + (Number(ind.ivs[k]) || 0), 0) / 6 || 1;
            const ivPes = STATS_K.reduce((a2, [k]) => a2 + (Number(ind.ivs[k]) || 0) * (Number(b[k]) || 0), 0) / sb;
            r0.real = real;
            r0.ataqueReal = fisico ? real.atk : real.spAtk;
            r0.resist = Math.round(Math.sqrt(real.hp * (real.def + real.spDef) / 2));
            r0.encaixe = Math.round((ivPes / ivMed - 1) * 1000) / 10;
          }
        }
        return r0;
      };
      const megasDe = (c) => { const vistos = new Set(); return [...map.values()].sort((x, y) => x.pokeId - y.pokeId).filter((m) => m && m.name && (m.name === `Mega ${c.name}` || m.name.startsWith(`Mega ${c.name} `)) && !vistos.has(m.name) && vistos.add(m.name)); };
      const opcoes = finais.map((f) => ({ passos: f.passos, final: avalia(f.final, false), megas: megasDe(f.final).map((m) => avalia(m, true)) }));
      const regs = [...new Set(alvo.map((h) => h.regiao))];
      return { base: { pokeId: base.pokeId, nome: base.name, tipos: tiposDe(base), stats: statsBase(base), bst: bst(base) }, L, opcoes, regioes: regs, huntsAlvo: alvo.length,
        ind: ind ? { ivs: ind.ivs, level: ind.level, potencia: ind.potencia || 1, shiny: ind.shiny, nivelUso, colada: !!o0.texto } : null };
    }
    // ---- aba PROCURAR SHINY: quais shiny caçar com o pokémon em campo (regras do próprio jogo) ----
    // · O brilho é sorteado a CADA ARREMESSO (1 em 24.000), antes da bola fechar: shiny que escapa vai embora.
    //   Então shiny/h de uma espécie = arremessos/h nela (≈ abates/h × fatia dela na hunt, com "Lançar sem parar")
    //   × chance de shiny (com Lure e os bônus da live) × chance da bola fechar.
    // · A chance da bola fechar depende do ESTÁGIO da evolução (1º estágio fecha mais) e da bola.
    // · Valor: vendas de shiny da espécie na Tabela de preços (Nv baixo, como sai da captura), 1 consulta a cada
    //   1,5 s, escondida do jogo e guardada 45 min. PvP: uso da linha no top 50 + vantagem de tipo da forma final.
    //   PvE: em quantas das suas próximas hunts a forma final tira ×5,5.
    const shinyPrecoCache = new Map(); // `${nome}|${moeda}` -> { em, v }
    let shinyBuscando = false;
    async function vendasShiny(nome, moeda) {
      const k = `${nome}|${moeda}`;
      const c = shinyPrecoCache.get(k);
      if (c && Date.now() - c.em < 45 * 60000) return c.v;
      if (!sock || sock.readyState !== 1) return null;
      const antes = shinyHist && shinyHist.em;
      sock.send(JSON.stringify({ t: 'market.historicoGlobal', pagina: 0, seq: SEQ_SHINY, tipo: 'pokemon', busca: nome, moeda, soShiny: true, ordem: 'recentes' }));
      for (let i = 0; i < 15 && (shinyHist && shinyHist.em) === antes; i++) await espera(400);
      if (!shinyHist || shinyHist.em === antes) return null;
      const linhas = (shinyHist.m.linhas || []).filter((x) => x && x.ficha && x.ficha.shiny && String(x.ficha.nome || '').toLowerCase() === nome.toLowerCase() && (!x.moeda || x.moeda === moeda))
        .map((x) => ({ preco: Number(x.bruto) || 0, level: Number(x.ficha.level) || 1, em: Number(x.em) || 0 })).filter((x) => x.preco > 0);
      shinyPrecoCache.set(k, { em: Date.now(), v: linhas });
      return linhas;
    }
    async function pveShiny(arg) {
      const o = arg && typeof arg === 'object' ? arg : {};
      if (!jogo.hunts || !jogo.tabelaTipos) return { pronto: false };
      if (shinyBuscando) return { erro: 'Já estou calculando. Espere terminar.' };
      shinyBuscando = true;
      try {
        const { map, ram } = await catalogoPve();
        let cd = null; try { cd = await import('/shared/captura-degrau.mjs'); } catch {}
        const rk = await huntRank({ todas: true });
        if (!rk || !rk.pronto) return { pronto: false };
        if (rk.semPokemon) return { pronto: true, semPokemon: true };
        const agora = Date.now();
        const L = Number(jogo.eu.level) || 0;
        const horas = Math.min(240, Math.max(1, Number(o.horas) || 24));
        const moeda = o.moeda === 'orb' ? 'orb' : 'gold';
        // Bônus: o que vale AGORA (ou o que a pessoa marcou para quando for caçar).
        const ativo = (fim) => Number(fim) > agora;
        const pctK = Number(canais.kick && canais.kick.pct) || 15, pctT = Number(canais.twitch && canais.twitch.pct) || 15;
        const fimB = (k, t) => Number(canais[k] && canais[k].bonus && canais[k].bonus[t]) || 0;
        const tem = (k, d) => (o[k] == null ? d : !!o[k]);
        const b = {
          lure: tem('lure', ativo(jogo.eu.lureAte)), kick: tem('kick', ativo(fimB('kick', 'shiny'))), twitch: tem('twitch', ativo(fimB('twitch', 'shiny'))),
          captura: tem('captura', ativo(jogo.eu.capturaAte)), kickCap: tem('kickCap', ativo(fimB('kick', 'captura'))), twitchCap: tem('twitchCap', ativo(fimB('twitch', 'captura'))),
        };
        const multS = 1 + (b.lure ? 1 : 0) + (b.kick ? pctK / 100 : 0) + (b.twitch ? pctT / 100 : 0);
        const multC = 1 + (b.captura ? 1 : 0) + (b.kickCap ? pctK / 100 : 0) + (b.twitchCap ? pctT / 100 : 0);
        const chanceS = Number(jogo.chanceShiny) || 1 / 24000;
        // A bola: a escolhida, ou a melhor que tem na mochila (sem nenhuma, a Ultra Ball).
        const bolas = (jogo.bolas || [{ id: 4, nome: 'Ultra Ball', rate: 4 }]).slice().sort((x, y) => y.rate - x.rate);
        const temBola = (id) => Number(jogo.eu.balls && jogo.eu.balls[id]) > 0;
        const bola = bolas.find((x) => String(x.id) === String(o.bola)) || bolas.find((x) => temBola(x.id)) || bolas.find((x) => x.id === 4) || bolas[0];
        const cap = jogo.captura || { base: 0.0075, piso: 0.003, teto: 0.1, raridadeDiv: 17, precoSemPreco: 6.5e9 };
        const chaves = cd ? cd.chavesEmHunt(jogo.hunts) : new Set();
        const dexDe = (id) => (cd ? cd.chaveDeHunt(id) : id);
        const fechar = (esp) => {
          const preco = esp.priceNpc > 0 ? esp.priceNpc : cap.precoSemPreco;
          let fator = 3.5745;
          try { fator = cd.fatorDeCaptura({ tetoCaptura: esp.tetoCaptura, peloDegrau: cd.capturaPeloDegrau(esp.pokeId, chaves), preco, raridadeDiv: cap.raridadeDiv ?? 17, porDegrau: cap.porDegrau ?? cd.FATOR_CAPTURA_DO_DEGRAU }); } catch {}
          return Math.max(cap.piso, Math.min(cap.teto, cap.base * (bola.rate / fator) * 1.4 * multC));
        };
        const ESTAGIO = { 20: '1º estágio', 40: '2º estágio', 100: '3º estágio' };
        // Cada hunt que o pokémon em campo consegue fazer → cada espécie dela com forma shiny.
        const porSlug = new Map((jogo.hunts || []).map((h) => [h.slug, h]));
        const porEsp = new Map();
        for (const hr of rk.todas || []) {
          const h = porSlug.get(hr.slug);
          if (!h || !Array.isArray(h.especies) || !(hr.kph > 0) || String(h.area || '').toLowerCase() === 'outland') continue;
          const tot = h.especies.reduce((t, e) => t + (Number(e.pontos) || 0), 0) || 1;
          for (const e of h.especies) {
            const esp = map.get(e.pokeId);
            if (!esp || !(jogo.shinyDex ? jogo.shinyDex.has(Number(dexDe(e.pokeId))) || jogo.shinyDex.has(Number(e.pokeId)) : true)) continue;
            const fatia = (Number(e.pontos) || 0) / tot;
            const arrH = hr.kph * fatia;
            const fecha = fechar(esp);
            const porH = arrH * chanceS * multS * fecha;
            const cur = porEsp.get(esp.pokeId);
            if (!cur || porH > cur.porH) porEsp.set(esp.pokeId, { pokeId: esp.pokeId, nome: esp.name, tipos: tiposDe(esp), estagio: ESTAGIO[esp.tetoCaptura] || null, teto: Number(esp.tetoCaptura) || null,
              hunt: { nome: hr.nome, nivel: hr.nivel, kph: hr.kph, fatia: Math.round(fatia * 100) }, fecha, porH });
          }
        }
        let lista = [...porEsp.values()].sort((x, y) => y.porH - x.porH);
        // Evoluções (formas finais) para o PvP e o PvE: a forma final é a que a pessoa vai usar.
        const alvo = huntsDoHorizonte(map, L, nivelDepoisDe(L, 30 * 12, xpHoraDaConta()));
        const meta = (Array.isArray(o.meta) ? o.meta : []).map((m) => ({ id: Number(m.id), t: tiposDe(map.get(Number(m.id)) || {}), w: Number(m.n) || 1 })).filter((m) => m.t.length);
        const metaW = meta.reduce((t, m) => t + m.w, 0);
        const usoPorId = new Map(meta.map((m) => [m.id, m.w]));
        const xPvp = (atks, defs) => Math.max(0, ...atks.map((t) => fxTipo(t, defs)));
        const linha = (esp) => {
          const ids = [esp.pokeId]; let fim = esp; const vistos = new Set();
          const anda = (e2, prof) => { let ds = []; try { ds = ram.destinosDeEvolucao(e2, (id) => map.get(id)); } catch {} const prox = ds.filter((d) => d.temArte).length ? ds.filter((d) => d.temArte) : ds;
            for (const d of prox) { if (!d.especie || vistos.has(d.especie.pokeId) || prof > 4) continue; vistos.add(d.especie.pokeId); ids.push(d.especie.pokeId); if (bst(d.especie) > bst(fim)) fim = d.especie; anda(d.especie, prof + 1); } };
          anda(esp, 0);
          return { ids, fim };
        };
        // Força de verdade no PvP: o duelo do jogo contra os times do top 50 (os "candidatos" da aba PvP, com as
        // Megas). A linha inteira conta: base, evoluções e a Mega da forma final (ex.: Mawile → Mega Mawile).
        const forca = new Map((Array.isArray(o.forca) ? o.forca : []).map((f) => [Number(f.id), Number(f.win) || 0]));
        const megasDe = (c) => [...map.values()].filter((m2) => m2 && m2.name && (m2.name === `Mega ${c.name}` || m2.name.startsWith(`Mega ${c.name} `)));
        const meusShiny = new Set([...jogo.pks.values()].filter((k) => k.shiny).map((k) => k.speciesId));
        for (const x of lista) {
          const esp = map.get(x.pokeId);
          const { ids, fim } = linha(esp);
          const megas = megasDe(fim);
          const t = tiposDe(fim);
          const cob = coberturaHunts(t, alvo);
          x.final = fim.pokeId !== esp.pokeId ? { nome: fim.name, tipos: t } : null;
          x.mega = megas.length ? megas[0].name : null;
          const atq = Math.max(Number(fim.baseAtk) || 0, Number(fim.baseSpAtk) || 0);
          x.pve = { x55: cob.x55, x25: cob.x25, sc: Math.round(cob.sc * 100) / 100, huntsAlvo: alvo.length, bst: bst(fim), atq };
          // A melhor forma da linha no duelo contra o top.
          let win = null, formaPvp = null;
          for (const f of [fim, ...megas, esp, ...ids.map((id) => map.get(id)).filter(Boolean)]) { const w = forca.get(f.pokeId); if (w != null && (win == null || w > win)) { win = w; formaPvp = f.name; } }
          x.pvp = { win: win != null ? Math.round(win * 100) : null, forma: formaPvp };
          if (metaW) {
            let vant = 0, risco = 0;
            for (const m of meta) { if (xPvp(t, m.t) >= 2) vant += m.w; if (xPvp(m.t, t) >= 2) risco += m.w; }
            Object.assign(x.pvp, { uso: ids.concat(megas.map((m2) => m2.pokeId)).reduce((s2, id) => s2 + (usoPorId.get(id) || 0), 0), vant: Math.round((vant / metaW) * 100), risco: Math.round((risco / metaW) * 100) });
          }
          x.temShiny = ids.some((id) => meusShiny.has(id));
          x.umEmH = x.porH > 0 ? Math.round(1 / x.porH) : null;
          x.chance = 1 - Math.exp(-x.porH * horas);
          // Notas de 0 a 100 de cada objetivo (a lista de cada aba sai delas).
          if (fim.pokeId === esp.pokeId && Number(esp.tetoCaptura) === 100) x.estagio = 'não evolui';
          const bstMax = Math.max(bst(fim), ...megas.map((m2) => bst(m2)));
          const pvpBase = x.pvp.win != null ? x.pvp.win : Math.min(60, (bstMax - 300) / 5 + (x.pvp.vant || 0) / 5 - (x.pvp.risco || 0) / 8);
          x.notaPvp = Math.round(Math.max(0, pvpBase + Math.min(15, (x.pvp.uso || 0) * 2)));
          x.notaPve = Math.round(Math.min(100, (cob.x55 / Math.max(1, alvo.length)) * 60 + (cob.x25 / Math.max(1, alvo.length)) * 15 + Math.min(25, atq / 6)));
        }
        // Só espécies que este pokémon caça num ritmo razoável (pelo menos ¼ do melhor ritmo de shiny).
        const maxH = Math.max(0, ...lista.map((x) => x.porH));
        lista = lista.filter((x) => x.porH >= maxH * 0.25);
        // Preço e raridade no Market: as mais fortes no PvP e no PvE e as mais fáceis (até 20 consultas, 1 a cada 1,2 s).
        const comPreco = o.precos !== false;
        let consultas = 0;
        if (comPreco) {
          const pega = (arr, n) => arr.slice(0, n);
          const alvoP = [...new Set([
            ...pega([...lista].sort((a2, b2) => b2.notaPvp - a2.notaPvp), 8),
            ...pega([...lista].sort((a2, b2) => b2.notaPve - a2.notaPve), 8),
            ...pega([...lista].sort((a2, b2) => b2.porH - a2.porH), 4),
          ])].slice(0, 20);
          for (const x of alvoP) {
            if (document.querySelector('#community:not(.hidden)')) { x.precoErro = 'mercado-aberto'; break; }
            const cached = shinyPrecoCache.has(`${x.nome}|${moeda}`);
            const v = await vendasShiny(x.nome, moeda);
            if (!cached) { consultas++; await espera(1200); }
            if (!v) continue;
            const tetoNv = Math.max(200, (x.teto || 100) * 2.5);
            const baixas = v.filter((y) => y.level <= tetoNv).map((y) => y.preco);
            const usar = baixas.length >= 2 ? baixas : v.map((y) => y.preco);
            const med = mediana(usar);
            x.preco = med != null ? { v: Math.round(med), n: v.length, n7: v.filter((y) => agora - y.em < 7 * 86400000).length, nvBaixo: baixas.length >= 2 } : { v: null, n: 0, n7: 0 };
            x.valorH = x.preco.v ? x.porH * x.preco.v : 0;
            // Raridade: poucos desse shiny vendidos em 30 dias = pouca gente tem (ex.: o Mawile).
            x.raro = v.length === 0 ? 'nenhum' : v.length <= 3 ? 'poucos' : v.length <= 10 ? 'alguns' : 'muitos';
          }
        }
        lista = lista.sort((a2, b2) => (b2.notaPvp + b2.notaPve) - (a2.notaPvp + a2.notaPve)).slice(0, 60);
        return { pronto: true, pokemon: rk.pokemon, L, horas, moeda, bola, bolas: bolas.map((x) => ({ id: x.id, nome: x.nome, rate: x.rate, tem: temBola(x.id) })),
          bonus: b, multS: Math.round(multS * 100) / 100, multC: Math.round(multC * 100) / 100, chanceS, pctK, pctT, consultas, lista, em: Date.now(),
          ativos: { lure: jogo.eu.lureAte || 0, kick: fimB('kick', 'shiny'), twitch: fimB('twitch', 'shiny'), captura: jogo.eu.capturaAte || 0 } };
      } finally { shinyBuscando = false; }
    }
    // ---- CALCULADORA DE BOSS (ideia do 369, 13/11/2026; a dele era toda à mão) ----
    // O jogo diz, para cada boss: o token de entrada (ex.: Bronze Boss Token × 1) e os drops com a CHANCE por luta
    // (ex.: Articuno 0,5% de peça de TM e 0,5% de peça de AoE). Os preços são os de AGORA na aba de itens do Market
    // (o menor anúncio, e a média vendida em 7 dias), pedidos escondidos do jogo e guardados 1 min. A taxa do Market é a
    // do jogo: coins 15%; gemas por faixa do preço (13% até 500, 10% até 5.000, 7,5% acima).
    let itensCache = null;
    async function precosItensCore(maxIdadeMs = 60 * 1000) {
      if (itensCache && Date.now() - itensCache.em < maxIdadeMs) return itensCache;
      if (!sock || sock.readyState !== 1) return itensCache;
      if (document.querySelector('#community:not(.hidden)')) return itensCache; // Market aberto na tela: não pede
      const antes = itensResp && itensResp.em;
      nossos.itens = Date.now();
      sock.send(JSON.stringify({ t: 'market.itens' }));
      for (let i = 0; i < 15 && (itensResp && itensResp.em) === antes; i++) await espera(400);
      if (!itensResp || itensResp.em === antes) return itensCache;
      itensCache = { em: Date.now(), resumo: itensResp.m.resumo || {}, medias: itensResp.m.medias || {} };
      return itensCache;
    }
    function taxaMercadoPct(preco, moeda) {
      const e = jogo.economia || {};
      if (moeda !== 'orb') return Number(e.taxaMercadoGoldPct ?? 15);
      const f = (Array.isArray(e.faixasMercadoOrb) && e.faixasMercadoOrb.length ? e.faixasMercadoOrb : [{ ate: 500, pct: 13 }, { ate: 5000, pct: 10 }, { ate: null, pct: 7.5 }]);
      for (const x of f) if (x.ate == null || preco <= Number(x.ate)) return Number(x.pct);
      return Number(f[f.length - 1].pct);
    }
    function precoItemCore(ic, itemId, moeda) {
      if (!ic || itemId == null) return { agora: null, media: null, vendidos7d: 0, anuncios: 0 };
      const r = ic.resumo[itemId] || ic.resumo[String(itemId)];
      const md = ic.medias[itemId] || ic.medias[String(itemId)];
      const mm = md && (moeda === 'orb' ? md.orb : md.gold);
      return { agora: r && (moeda === 'orb' ? r.minOrb : r.minGold) != null ? Number(moeda === 'orb' ? r.minOrb : r.minGold) : null,
        media: mm && mm.media ? Math.round(Number(mm.media) * 100) / 100 : null, vendidos7d: mm ? Number(mm.unidades) || 0 : 0, anuncios: r ? Number(r.anuncios) || 0 : 0 };
    }
    async function pveBoss(arg) {
      const o = arg && typeof arg === 'object' ? arg : {};
      const moeda = o.moeda === 'gold' ? 'gold' : 'orb';
      if (!Array.isArray(jogo.bosses) || !jogo.bosses.length) return { pronto: false, motivo: 'sem-bosses' };
      const ic = await precosItensCore(o.forcar ? 0 : 60 * 1000);
      const catL = jogo.mercado && jogo.mercado.catalogo;
      const cat = new Map((Array.isArray(catL) ? catL : catL && typeof catL === 'object' ? Object.values(catL) : []).filter((x) => x && x.id != null).map((x) => [Number(x.id), x]));
      const L = Number(jogo.eu.level) || 0;
      const itens = {};
      // Os nomes como o JOGO mostra na tela (os dados dos bosses vêm com o nome interno: "TM Disk Piece" é o Fragmento
      // de Z-Move, e parecia um segundo AoE).
      const tmr = jogo.tmResearcher || {};
      const PT = { 'TM Disk Piece': 'Fragmento de Z-Move', 'AoE TM Disk Piece': 'Fragmento de AoE (AoE TM Disk Piece)', 'Mega Stone Fragment': 'Fragmento de Mega Stone',
        'Mega Shiny Stone Fragment': 'Fragmento de Mega Shiny Stone', 'Shiny Stone Fragment': 'Fragmento de Shiny Stone', 'Key Fragment': 'Fragmento de Chave', 'Bicycle Fragment': 'Fragmento de Bicicleta' };
      const nomePt = (id, nome) => (Number(id) === Number(tmr.pieceElemental ?? 59194) ? 'Fragmento de Z-Move'
        : Number(id) === Number(tmr.pieceAoe ?? 40530) ? 'Fragmento de AoE (AoE TM Disk Piece)' : PT[nome] || nome);
      const item = (id, nome0) => {
        if (itens[id]) return itens[id];
        const c = cat.get(Number(id)) || {};
        const nome = nomePt(id, nome0 || c.nome);
        const p = precoItemCore(ic, id, moeda);
        // Preço de referência: o menor anúncio de agora; sem anúncio, a média vendida em 7 dias.
        const ref = p.agora != null ? p.agora : p.media;
        itens[id] = { id: Number(id), nome: nome || c.nome || `#${id}`, icone: c.icone || null, ...p, preco: ref, taxaPct: ref != null ? taxaMercadoPct(ref, moeda) : null };
        return itens[id];
      };
      const bosses = jogo.bosses.map((b) => {
        const ent = b.entrada || {};
        const tok = ent.itemId != null ? item(ent.itemId, ent.nome) : null;
        const custo = tok && tok.preco != null ? tok.preco * (Number(ent.qtd) || 1) : null;
        let ev = 0, falta = !tok || tok.preco == null;
        const drops = (b.drops || []).map((d) => {
          const it = item(d.itemId, d.nome);
          const chance = Number(d.chance) || 0, qtd = Number(d.qtd) || 1;
          const liq = it.preco != null ? it.preco * (1 - (it.taxaPct || 0) / 100) : null;
          if (liq == null) falta = true; else ev += chance * qtd * liq;
          return { itemId: Number(d.itemId), nome: it.nome, chance, qtd, preco: it.preco, liquido: liq != null ? Math.round(liq * 100) / 100 : null, porLuta: liq != null ? Math.round(chance * qtd * liq * 10000) / 10000 : null,
            lutasPorDrop: chance > 0 ? Math.round(1 / chance) : null };
        });
        const lucro = custo != null ? ev - custo : null;
        return { key: b.key, nome: b.nome || b.name, level: Number(b.level) || 0, minNivel: Number(b.minNivelTreinador) || 0, liberado: L >= (Number(b.minNivelTreinador) || 0), regiao: b.regiao || null, trio: b.trio || null,
          premio: b.premio || null, equipeIdeal: b.equipeIdeal || null, token: tok ? { itemId: tok.id, nome: tok.nome, qtd: Number(ent.qtd) || 1, preco: tok.preco } : null, custoLuta: custo,
          evLuta: Math.round(ev * 10000) / 10000, lucroLuta: lucro != null ? Math.round(lucro * 10000) / 10000 : null, roi: custo ? Math.round((lucro / custo) * 1000) / 10 : null, faltaPreco: falta, drops };
      });
      return { pronto: true, moeda, L, em: ic ? ic.em : null, semPrecos: !ic, itens, bosses,
        taxa: { gold: taxaMercadoPct(0, 'gold'), faixasOrb: (jogo.economia && jogo.economia.faixasMercadoOrb) || [{ ate: 500, pct: 13 }, { ate: 5000, pct: 10 }, { ate: null, pct: 7.5 }] } };
    }
    // Comprar no Market para FARMAR: as espécies que mais rendem nas próximas hunts da conta, as ofertas mais
    // baratas delas agora (consulta escondida do jogo, como a do PvP) e o ataque REAL de cada pokémon à venda.
    let pveBuscando = false;
    async function pveMercado(moeda, dias, orcamento) {
      if (pveBuscando) return { erro: 'Já estou procurando. Espere terminar.' };
      if (!jogo.hunts || !jogo.tabelaTipos) return { erro: 'A conta precisa estar logada no jogo.' };
      if (!sock || sock.readyState !== 1) return { erro: 'Sem conexão com o jogo agora.' };
      pveBuscando = true;
      try {
        const { map, gi } = await catalogoNota();
        const L = Number(jogo.eu.level) || 0;
        // Horizonte: quantos dias a pessoa pretende ficar com o pokémon (12 h de farm por dia) e o XP/h da conta.
        const nDias = Math.min(365, Math.max(1, Number(dias) || 30));
        const xpH = xpHoraDaConta();
        const Lh = nivelDepoisDe(L, nDias * 12, xpH);
        const alvo = huntsDoHorizonte(map, L, Lh);
        const cobertura = (t) => coberturaHunts(t, alvo);
        // Candidatas: espécies com arte, capturáveis (sem Mega), que mais rendem nessas hunts pelo tipo e pelo ataque-base.
        const cand = [];
        for (const c of map.values()) {
          if (!c || !c.name || /^Mega /.test(c.name) || !(Number(c.looktype) > 1)) continue;
          const t = tiposDe(c); if (!t.length) continue;
          const cv = cobertura(t);
          const atkB = Math.max(Number(c.baseAtk) || 0, Number(c.baseSpAtk) || 0);
          const sc = cv.sc * atkB;
          if (sc > 0) cand.push({ id: c.pokeId, sc });
        }
        cand.sort((a, b) => b.sc - a.sc);
        const vistos = new Set();
        const ids = [];
        for (const x of cand) { const nm = map.get(x.id).name; if (vistos.has(nm)) continue; vistos.add(nm); ids.push(x.id); if (ids.length >= 15) break; }
        // Regra do jogo: o pokémon só entra em campo até o nível do treinador + 5. A busca pede ao Market só essa
        // faixa (do ~75% do nível até o teto), só até o orçamento, e os de MAIOR nível primeiro — o nível pesa
        // mais que tudo nos stats. Sem nada nessa faixa, tenta de novo sem o piso.
        const tetoNv = L + 5;
        const pisoNv = Math.max(1, Math.floor(L * 0.75));
        const precoMax = Number(orcamento) > 0 ? String(Math.floor(Number(orcamento))) : '';
        const vazias = { potenciaMin: '', potenciaMax: '', ivMin: '', ivMax: '', qualidadeMin: '', qualidadeMax: '', notaMin: '', notaMax: '', precoMin: '' };
        async function listarEspecie(id, nivelMin) {
          const antes = ultimaLista && ultimaLista.em;
          nossos.lista = Date.now();
          sock.send(JSON.stringify({ t: 'market.listar', tipo: 'pokemon', moeda: moeda === 'gold' ? 'gold' : 'orb', ordem: 'baratos', busca: '', criterios: ['nivel'], elementos: [], tiposUnidos: true,
            ...vazias, nivelMin: nivelMin ? String(nivelMin) : '', nivelMax: String(tetoNv), precoMax, pagina: 0, especieId: Number(id) }));
          for (let i = 0; i < 12 && (ultimaLista && ultimaLista.em) === antes; i++) await espera(400);
          return ultimaLista && ultimaLista.em !== antes ? (ultimaLista.m.linhas || []) : null;
        }
        const out = [];
        let semPiso = 0;
        for (const id of ids) {
          if (!sock || sock.readyState !== 1) break;
          if (document.querySelector('#community:not(.hidden)')) return { erro: 'mercado-aberto', lista: out };
          let linhas = await listarEspecie(id, pisoNv);
          if (linhas && !linhas.length) { await espera(1500); linhas = await listarEspecie(id, 0); if (linhas && linhas.length) semPiso++; }
          if (linhas) {
            for (const a of linhas) {
              const f = a.ficha || {};
              if (a.tipo !== 'pokemon' || !f.speciesId) continue;
              const c = map.get(f.speciesId); if (!c) continue;
              const pk = { id: 1, speciesId: f.speciesId, level: Number(f.level) || 1, ivs: f.ivs || null, quality: f.quality ?? null, potencia: f.potencia ?? null, refino: f.refino || null, shiny: !!f.shiny };
              if (pk.level > tetoNv) continue; // acima do treinador + 5: a conta não pode usar
              let st = null; try { st = pk.ivs ? gi.statsNoNivel(pk, c, pk.level) : null; } catch {}
              const t = [...new Set([...tiposDe(c), f.tmElemental ? String(f.tmElemental).toUpperCase() : null].filter(Boolean))];
              const cv = cobertura(t);
              const ataque = st ? Math.max(Number(st.atk) || 0, Number(st.spAtk) || 0) : 0;
              out.push({ anuncio: a.id, speciesId: f.speciesId, nome: f.nome || c.name, level: pk.level, shiny: pk.shiny, aoe: f.tmAoe === true || f.tmAoe === 1, el: f.tmElemental || null, potencia: f.potencia ?? null,
                preco: Number(a.preco) || 0, qtd: Number(a.qtd) || 1, moeda: a.moeda, vendedor: a.vendedor || '', retido: !!(a.compravelEm && a.compravelEm > Date.now()),
                tipos: tiposDe(c), x25: cv.x25, x55: cv.x55, ataque, farm: Math.round(cv.sc * ataque * ((f.tmAoe === true || f.tmAoe === 1) ? 1.1 : 1)) });
            }
          }
          await espera(2500);
        }
        const regs = [...new Set(alvo.map((h) => h.regiao))];
        return { lista: out, L, Lh, dias: nDias, xpH: Math.round(xpH), regioes: regs, huntsAlvo: alvo.length, pisoNv, tetoNv, semPiso, em: Date.now() };
      } finally { pveBuscando = false; }
    }
    async function pveBuscar(texto) {
      const { map } = await catalogoNota();
      const q = String(texto || '').trim().toLowerCase();
      if (q.length < 2) return [];
      return [...map.values()].filter((c) => c && c.name && c.name.toLowerCase().includes(q) && !/^Mega /.test(c.name)).slice(0, 12).map((c) => ({ speciesId: c.pokeId, nome: c.name, tipos: tiposDe(c) }));
    }
    // DIA SAZONAL (shared/dia-sazonal.mjs): nas hunts do Mapa, todo pokémon da tipagem do dia — o seu E os
    // selvagens — causa o dobro de dano e recebe ¼ (dobro de defesa e de vida). Vira às 18:00 de Brasília.
    const tipoDoDia = () => { const d = jogo.eu.diaSazonal; return d && d.tipo && (!d.fim || Number(d.fim) > Date.now()) ? String(d.tipo).toUpperCase() : null; };
    const multSazonal = (tipoDia, atq, def) => (!tipoDia ? 1 : (atq.includes(tipoDia) ? 2 : 1) / (def.includes(tipoDia) ? 4 : 1));
    const VEL_BIKE = { comum: 0.15, incomum: 0.25, rara: 0.5, mitica: 0.75, lendaria: 1 };
    const tiposDe = (c) => [c && c.type1, c && c.type2].filter((x) => x && x !== 'NONE').map((x) => String(x).toUpperCase());
    let modTab = null;
    const tabuleiro = () => (modTab || (modTab = import('/shared/pvp-tabuleiro.mjs').catch(() => null)));

    // ---- sugestão de hunt ----
    // Quanto tempo o pokémon em campo leva para derrubar cada selvagem de cada hunt, com as contas do jogo:
    //  · stats do pokémon: `statsNoNivel` (/shared/ginasios.mjs), a mesma conta do "Poder no PvE";
    //  · selvagem: stats da espécie no nível da hunt (IV médio); vida = HP × 12 × multHpSelvagem (welcome),
    //    acertada pela vida que o campo mostra (`mhp`) nas hunts em que a conta já esteve;
    //  · dano de cada golpe: nível, power, ataque ÷ defesa do selvagem, STAB e a efetividade AMPLIADA da
    //    hunt (×2 → ×2,5; ×4 → ×5,5; ×0,5 → ×0,33), golpe a golpe, com o tipo de cada um (e o Z-Move);
    //  · ritmo: a IA usa o golpe pronto que mais dá dano; intervalo e Investida pelo IV de Speed, skills
    //    com o desconto do Speed (`cooldownGolpeComSpeed`);
    //  · AoE (disco): o golpe pega o bando inteiro (área 11×11) — o bando cai no tempo de um selvagem;
    //  · bicicleta: divide só a caminhada.
    //  · ritmo do mapa: andar até o próximo bando e esperar a onda custam um tempo por selvagem que o dano
    //    não encurta (o jogo calibrou o mesmo ritmo em toda hunt). É ele que segura a hunt fácil: matar em
    //    menos de 1 s não passa de ~1.000 abates/h.
    // Depois, o que a conta MEDIU (placar do jogo, 10+ min na hunt com este pokémon) acerta o ritmo das
    // outras e substitui a estimativa da própria hunt. O resto é estimativa.
    const IV_SELVAGEM = 16;            // IV médio de selvagem (1–32)
    const HP_SELVAGEM_EXTRA = 1.33;    // Gible nv 1000: 72.000 de vida no campo contra 54.000 da conta crua (28/10/2026)
    const BANDO_PADRAO = 5;            // selvagens por bando enquanto o campo não mostrou nenhum
    // TETO DO RITMO: andar até o próximo alvo e esperar a onda nascer. Mesmo matando na hora, a pé não passa de
    // ~900 abates/h (medido: 934/h numa hunt de ×5,5 e 847/h em outra conta). O tempo de cada abate é o MAIOR
    // entre a luta e esse teto — não a soma: matar mais rápido que o teto não rende mais abates.
    const PISO_PADRAO_MS = 3900;
    const MEDIDO_MIN_MS = 10 * 60 * 1000;
    const VARIACAO_MEDIA = 0.925;      // o dano de cada golpe sai entre 0,85 e 1,00
    const naHunt = (v, amp) => (v === 0 || v === 1 ? v : v > 1 ? 1 + (v - 1) * amp : v / amp);
    const mediana = (l) => { const s = l.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

    // O que a conta já viu em cada hunt: vida dos selvagens, tamanho dos bandos e o placar com cada pokémon.
    const MEDIDO_KEY = 'idleterino:huntMedido';
    let medido = {};
    try { medido = JSON.parse(localStorage.getItem(MEDIDO_KEY) || '{}') || {}; } catch { medido = {}; }
    let medidoSalvoEm = 0;
    const medidoDe = (slug) => medido[slug] || (medido[slug] = { hp: {}, bando: [], pk: {} });
    function salvarMedido(agora) {
      if (!agora && Date.now() - medidoSalvoEm < 30000) return;
      medidoSalvoEm = Date.now();
      try { localStorage.setItem(MEDIDO_KEY, JSON.stringify(medido)); } catch {}
    }
    const huntAtualSlug = () => jogo.eu.huntSlug || (jogo.eu.hunt && jogo.eu.hunt.slug) || null;
    // Quantos quadrados 11×11 cobrem os selvagens que nasceram juntos (cobertura gulosa).
    function bandosDe(mobs) {
      let resto = mobs.slice(), n = 0;
      while (resto.length) {
        let melhor = null;
        for (const a of resto) {
          const dentro = resto.filter((b) => Math.abs(b.c - a.c) <= 5 && Math.abs(b.r - a.r) <= 5);
          if (!melhor || dentro.length > melhor.length) melhor = dentro;
        }
        resto = resto.filter((b) => !melhor.includes(b));
        n++;
      }
      return n;
    }
    // Pacote de campo com selvagens novos (`mhp` só vem quando o mob aparece): vida real e bandos.
    function campoNovos(m) {
      const slug = huntAtualSlug();
      if (!slug || !Array.isArray(m.mobs)) return;
      const novos = m.mobs.filter((b) => b && b.mhp != null && b.c != null && !b.tr && !b.bn && b.eq == null && b.dn == null);
      if (!novos.length) return;
      const M = medidoDe(slug);
      for (const b of novos) if (b.n && b.nv && !b.sh) M.hp[`${b.n}|${b.nv}`] = Number(b.mhp) || 0;
      if (novos.length >= 3) {
        M.bando.push(Math.round((novos.length / bandosDe(novos)) * 10) / 10);
        if (M.bando.length > 40) M.bando.shift();
      }
      salvarMedido();
    }
    // Soma ao placar da hunt o que a sessão do jogo andou desde a última leitura (mesma hunt e mesmo pokémon).
    let ultimaSessao = null;
    function medirSessao(slug, pkId) {
      const nick = String(jogo.eu.nick || '').toLowerCase();
      let s = null;
      try { s = nick && JSON.parse(localStorage.getItem('sessao-hunt:' + nick) || 'null'); } catch {}
      if (!s || !(s.ms > 0) || !slug || pkId == null) { ultimaSessao = null; return; }
      const agora = { slug, pk: pkId, ms: +s.ms, ab: +s.abates || 0, xp: +s.xpTreinador || 0, gold: +s.gold || 0, em: Date.now() };
      const p = ultimaSessao;
      if (p && p.slug === slug && p.pk === pkId && agora.ms > p.ms && agora.ab >= p.ab && agora.em - p.em < 10 * 60 * 1000) {
        const pks = medidoDe(slug).pk;
        const P = pks[pkId] || (pks[pkId] = { ms: 0, ab: 0, xp: 0, gold: 0 });
        P.ms += agora.ms - p.ms; P.ab += agora.ab - p.ab;
        P.xp += Math.max(0, agora.xp - p.xp); P.gold += Math.max(0, agora.gold - p.gold);
        salvarMedido(true);
      }
      ultimaSessao = agora;
    }

    // Dano por segundo do pokémon contra uma espécie, simulando a escolha de golpe da IA por 3 minutos.
    function dpsContra(P, tiposAlvo, defW, spDefW, tabela, ef) {
      const dano = (g) => {
        const e = ef(g.type, tiposAlvo[0] || null, tiposAlvo[1] || null, tabela);
        if (!(e > 0)) return 0;
        const especial = g.category === 'SPECIAL';
        const atk = especial ? P.st.spAtk : P.st.atk;
        const def = Math.max(1, especial ? spDefW : defW);
        const base = ((2 * P.nivel) / 5 + 2) * (g.power || 0) * (atk / def) / 50 + 2;
        return base * (P.tipos.includes(g.type) ? 1.5 : 1) * naHunt(e, P.amp) * VARIACAO_MEDIA;
      };
      const lista = P.golpes.map((g) => ({ g, d: dano(g) })).filter((x) => x.d > 0);
      const basico = P.tipos.map((t) => ({ g: { name: 'Investida', power: 30, type: t, category: 'PHYSICAL', cd: P.cdBasico }, d: 0 }))
        .map((x) => ({ ...x, d: dano(x.g) })).sort((a, b) => b.d - a.d)[0];
      if (basico && basico.d > 0) lista.push(basico);
      if (!lista.length) return { dps: 0, golpe: null };
      const T = 180000;
      const pronto = lista.map(() => 0);
      const usado = lista.map(() => 0);
      let t = 0, total = 0;
      while (t < T) {
        let i = -1;
        for (let k = 0; k < lista.length; k++) if (pronto[k] <= t && (i < 0 || lista[k].d > lista[i].d)) i = k;
        if (i < 0) { t = Math.min(...pronto); continue; }
        total += lista[i].d; usado[i] += lista[i].d;
        pronto[i] = t + lista[i].g.cd;
        t += P.gi;
      }
      const top = usado.indexOf(Math.max(...usado));
      return { dps: total / (T / 1000), golpe: lista[top].g.name };
    }

    // MELHOR HUNT PELO /hunt: quando a extensão /hunt está ligada nesta conta, a referência é o MOTOR DELA (o mesmo
    // cálculo da tabela "Onde caçar?", com o pokémon em campo, os bônus, o Dia Sazonal e o AoE dela). O Idleterino só
    // acrescenta o que o /hunt não conta: a BICICLETA (ele calcula a pé). A bike encurta só a caminhada de cada abate,
    // com as mesmas constantes do /hunt (caminhada = 83% do tempo do mapa, piso 1,41 s, que cai com a luta).
    async function huntRankPeloHunt(opts) {
      const PIH = window.__pokeidleHunt;
      if (!PIH || !PIH.engine || !PIH.engine.analisar || !PIH.on || !PIH.carregarJogo) return null;
      let welcome = null, eu = null;
      PIH.on('welcome', (m) => { welcome = m; })();
      PIH.on('estado', (e) => { eu = e; })();
      if (!welcome || !eu) return null;
      let pk = (eu.pokemons || []).find((x) => x.id === eu.activeId);
      if (!pk) return { pronto: true, semPokemon: true };
      if (opts && opts.testeAoe) pk = { ...pk, tmAoe: true }; // só para teste
      const J = await PIH.carregarJogo();
      const chave = PIH.geo && PIH.geo.chaveDoPokemon ? PIH.geo.chaveDoPokemon(pk) : null;
      const ctx = {
        mod: J.mod, especies: J.especies, hunts: welcome.hunts || [],
        consts: { tabelaTipos: welcome.tabelaTipos, ampliacaoHunt: welcome.ampliacaoHunt, multHpSelvagem: welcome.multHpSelvagem, multDanoSelvagem: welcome.multDanoSelvagem,
          tiposBoost: welcome.tiposBoost, catalogoBolas: welcome.catalogoBolas, captura: welcome.captura, chanceShiny: welcome.chanceShiny, shinyLooks: welcome.shinyLooks },
        eu, ritmo: PIH.ritmo || null,
        mapaVisto: (slug) => (PIH.geo && PIH.geo.mapaDa ? PIH.geo.mapaDa(slug) : null),
        ritmoMedido: (slug) => (chave && PIH.geo && PIH.geo.ritmoMedido ? PIH.geo.ritmoMedido(slug, chave) : null),
      };
      const tipoDia = eu.diaSazonal && eu.diaSazonal.tipo && (!eu.diaSazonal.fim || Number(eu.diaSazonal.fim) > Date.now()) ? eu.diaSazonal.tipo : null;
      const r = PIH.engine.analisar(pk, ctx, { ordem: 'xp', soLiberadas: true, comPocao: true, tipoDoDia: tipoDia });
      const M = PIH.engine.MEDIDO || {};
      const I = PIH.engine._interno || {};
      const rar = eu.bicicleta && (eu.bicicleta.equipadaRar || null);
      const vel = VEL_BIKE[rar] || 0;
      const aoe = !!pk.tmAoe;
      const porGolpe = aoe ? (M.aoeAlvosPorGolpe || 2) : 1;
      const atualSlug = eu.huntSlug || (eu.hunt && eu.hunt.slug) || huntAtualSlug();
      const nomeReg = (x) => (x && typeof x === 'object' ? x.rotulo || x.nome || x.id : x) || null;
      const out = [];
      for (const l of r.linhas || []) {
        if (l.inviavel || !(l.kph > 0)) continue;
        let kph = l.kph;
        // AoE MEDIDO: o /hunt chuta 2 selvagens por golpe em toda hunt (faixa 1,5–3). Onde esta conta já viu os
        // bandos nascerem (quadrado 11×11, medido no campo), usa a medida dela — dentro da mesma faixa do /hunt.
        let pg = porGolpe, bandoMed = null;
        const Mh = l.slug && medido[l.slug];
        if (aoe && Mh && Array.isArray(Mh.bando) && Mh.bando.length >= 3 && I.tempoMorto && I.tempoDoMapa && l.hunt && Number(l.ttk) > 0.02) {
          bandoMed = mediana(Mh.bando);
          const faixa = M.aoeAlvosFaixa || [1.5, 3];
          const novo = Math.min(faixa[1], Math.max(faixa[0], bandoMed));
          if (Math.abs(novo - porGolpe) > 0.05) {
            const mp0 = I.tempoDoMapa(l.hunt, ctx.ritmo, ctx.mapaVisto);
            const t = Number(l.ttk);
            const porAbate = (k) => I.tempoMorto(mp0.sAoe, t / k) + t / k;
            const uptime = l.kph / (3600 / porAbate(porGolpe)); // o /hunt já desconta as mortes: mantém
            kph = (3600 / porAbate(novo)) * uptime;
            pg = novo;
          }
        }
        // Bicicleta: só a caminhada encolhe.
        if (vel > 0 && I.tempoDoMapa && l.hunt) {
          const mp = I.tempoDoMapa(l.hunt, ctx.ritmo, ctx.mapaVisto);
          const sB = aoe ? mp.sAoe : mp.s;
          const F = (Number(l.ttk) || 0) / pg;
          const andar1 = (M.caminhadaDoMapa || 0.83) * sB;
          const andar = andar1 - Math.max(0, andar1 - (M.caminhadaPisoS || 1.41)) * (1 - Math.exp(-F / (M.caminhadaTauS || 2.8)));
          const T = 3600 / kph;
          const T2 = Math.max(0.5, T - andar + andar / (1 + vel));
          kph = 3600 / T2;
        }
        const f = kph / l.kph;
        const hit = Number(l.hitPct) || 0;
        out.push({ slug: l.slug || null, nome: String(l.nome || l.slug || '?'), nivel: Number(l.nivel) || 0, regiao: nomeReg(l.regiao),
          kph: Math.round(kph), kphHunt: Math.round(l.kph), xpH: Math.round((l.xpTreinadorH || 0) * f), xpPkH: Math.round((l.xpPokemonH || 0) * f),
          goldH: Math.round((l.ouroH || 0) * f), goldLiq: Math.round((l.ouroH || 0) * f),
          seg: Math.round((Number(l.ttk) || 0) * 10) / 10, golpe: l.melhorGolpe ? l.melhorGolpe.nome : null, effH: Math.round((Number(l.efetividade) || 0) * 100) / 100,
          risco: hit < 0.25 ? 1 : hit < 0.5 ? 1.5 : 2.5, riscoPct: Math.round(hit * 100), medidoMin: 0, kphMedido: l.kphMedido || null,
          teto: false, lenta: !!(l.aoe && l.aoe.estimado) && bandoMed == null, bando: Math.round(pg * 10) / 10, bandoMedido: bandoMed != null ? Math.round(bandoMed * 10) / 10 : null });
      }
      out.sort((a, b) => b.xpH - a.xpH);
      const atualEst = out.find((h) => h.slug && h.slug === atualSlug) || null;
      const tipos = [...new Set([...(pk.tipos || []), pk.tmElemental ? String(pk.tmElemental).toUpperCase() : null].filter(Boolean))];
      return {
        pronto: true, fonte: 'hunt', L: Number(eu.level) || 0, pokemon: (r.especie && r.especie.name) || pk.nome || '?', tipos, aoe, bike: rar, vel,
        bonus: r.bonusXp && r.bonusXp.treinador ? r.bonusXp.treinador : 1, tipoDia, seuDoDia: !!(tipoDia && tipos.includes(tipoDia)),
        calibrado: 0, ritmo: 0, top: out.slice(0, 8), atual: atualSlug, atualEst,
        topOuro: [...out].sort((a, b) => b.goldLiq - a.goldLiq).slice(0, 8),
        todas: opts && opts.todas ? out.map((h) => ({ slug: h.slug, nome: h.nome, nivel: h.nivel, kph: h.kph })) : undefined,
      };
    }

    async function huntRank(opts) {
      // Primeiro o /hunt (a referência); sem ele nesta conta, o cálculo próprio.
      try { const r = await huntRankPeloHunt(opts); if (r) return r; } catch {}
      return huntRankProprio(opts);
    }
    async function huntRankProprio(opts) {
      if (!jogo.hunts || !jogo.tabelaTipos) return { pronto: false };
      let ha, gi, cdm, tm;
      try {
        [ha, gi, cdm, tm] = await Promise.all([import('/hunt-analyser.mjs'), import('/shared/ginasios.mjs'), import('/shared/cooldown-golpes.mjs'), import('/shared/tm-elemental.mjs')]);
      } catch { return { pronto: false, erro: 'modulo' }; }
      const esp = await especies();
      const L = Number(jogo.eu.level) || 0;
      const act = jogo.pks.get(jogo.eu.activeId);
      if (!act) return { pronto: true, semPokemon: true };
      const cat = esp.get(act.speciesId) || {};
      const tiposPk = tiposDe(cat);
      const atk = [...new Set([...tiposPk, act.el ? String(act.el).toUpperCase() : null].filter(Boolean))];
      const rar = jogo.eu.bicicleta && (jogo.eu.bicicleta.equipadaRar || null);
      const vel = VEL_BIKE[rar] || 0;
      const bx = bonusXp ? bonusXp.tr : 1;
      const amp = jogo.amp || 1.5;
      const atualSlug = huntAtualSlug();
      medirSessao(atualSlug, act.id);

      // O pokémon em campo: stats de verdade, golpes que já aprendeu (e o Z-Move) e o ritmo pelo Speed.
      const st = act.ivs ? gi.statsNoNivel(act, cat, act.level) : null;
      if (!st) return { pronto: true, semPokemon: true };
      const ivSpe = Math.min(32, Math.max(1, Math.round(Number(act.ivs.speed) || 1)));
      const comSpeed = (g) => ({ ...g, type: String(g.type || 'NORMAL').toUpperCase(), cd: g.cdFixo ? g.cooldownMs : cdm.cooldownGolpeComSpeed(g.cooldownMs, cat.baseSpeed, ivSpe) });
      const golpes = (cat.attacks || []).filter((a) => (a.learnLevel || 1) <= act.level).map(comSpeed);
      if (act.tmElemental) golpes.push(comSpeed(tm.golpeTmElemental(String(act.tmElemental).toUpperCase(), act.tmFisico)));
      const P = { st, nivel: Number(act.level) || 1, tipos: tiposPk, golpes, amp,
        gi: Math.max(400, 900 - 10 * ivSpe), cdBasico: 2000 - 10 * ivSpe };

      // Vida dos selvagens: a conta crua, acertada pelo que o campo já mostrou.
      const statW = (base, n) => ((Number(base) || 0) + 2 * IV_SELVAGEM) * n / 100;
      const hpCru = (c, n) => 12 * (jogo.multHp || 5) * statW(c.baseHp, n);
      const porNome = new Map(); for (const c of esp.values()) if (c && c.name && !porNome.has(c.name)) porNome.set(c.name, c);
      const razoes = [];
      for (const M of Object.values(medido)) for (const [k, v] of Object.entries(M.hp || {})) {
        const [nome, nv] = k.split('|'); const c = porNome.get(nome);
        if (c && v > 0) razoes.push(v / hpCru(c, Number(nv)));
      }
      const hpExtra = mediana(razoes) || HP_SELVAGEM_EXTRA;

      const tipoDia = tipoDoDia();
      const out = [];
      for (const h of jogo.hunts) {
        const nivel = Number(h.nivel) || 0;
        if (nivel > L || !Array.isArray(h.especies) || !h.especies.length) continue;
        let pontos = 0, tAbate = 0, effMed = 0, effH = 0, effMax = 0, risco = 0, semDano = false, selvagemDoDia = false;
        const golpeUso = {};
        const nivelRel = nivel / Math.max(1, Number(act.level) || 1); // hunt acima do nível do pokémon = mob batendo mais forte
        for (const e of h.especies) {
          const c = esp.get(e.pokeId) || {};
          const t = tiposDe(c);
          const w = Number(e.pontos) || 1;
          let eff = 1;
          try { eff = ha.melhorEfetividadeContra(atk, t[0] || null, t[1] || null, jogo.tabelaTipos) || 0; } catch {}
          const r = dpsContra(P, t, statW(c.baseDef, nivel), statW(c.baseSpDef, nivel), jogo.tabelaTipos, ha.efetividade);
          if (!(r.dps > 0)) { semDano = true; break; }
          const hp = hpCru(c, nivel) * hpExtra;
          if (tipoDia && t.includes(tipoDia)) selvagemDoDia = true;
          tAbate += Math.max(P.gi, (hp / (r.dps * multSazonal(tipoDia, tiposPk, t))) * 1000) * w;
          golpeUso[r.golpe] = (golpeUso[r.golpe] || 0) + w;
          pontos += w; effMed += eff * w; effH += naHunt(eff, amp) * w; effMax = Math.max(effMax, eff);
          // Risco de gastar poção: o golpe do selvagem contra o SEU pokémon (tipos dele × os seus) e o nível da hunt.
          let dano = 1;
          try { dano = ha.melhorEfetividadeContra(t, tiposPk[0] || null, tiposPk[1] || null, jogo.tabelaTipos) || 1; } catch {}
          risco += dano * multSazonal(tipoDia, t, tiposPk) * nivelRel * w;
        }
        if (semDano || !pontos) continue;
        tAbate /= pontos; effMed /= pontos; effH /= pontos; risco /= pontos;
        const porOnda = Math.min(ha.MAX_MOBS || 16, pontos);
        const M = medido[h.slug] || null;
        // Bando que nasce junto (medido no campo, quadrado 11×11 do AoE). O AoE pega o bando inteiro de uma vez.
        const bandoMedido = act.aoe ? Math.min(porOnda, mediana((M && M.bando) || []) || 0) : 0;
        const bandoSpawn = act.aoe ? (bandoMedido || BANDO_PADRAO) : 1;
        let xp = 0, gold = 0;
        try { const r = ha.mediaPorKill(h, esp, 0); xp = r.xp; gold = r.gold; } catch {}
        const med = M && M.pk && M.pk[act.id];
        const golpe = Object.entries(golpeUso).sort((a, b) => b[1] - a[1])[0];
        out.push({ slug: h.slug || null, nome: String(h.nome || h.name || h.slug || '?'), nivel, regiao: REGIOES[regiaoDe(h)][0], tAbate, bandoSpawn, bandoMedido, porOnda, xp, gold, selvagemDoDia,
          medido: med && med.ms >= MEDIDO_MIN_MS && med.ab >= 20 ? med : null,
          seg: Math.round(tAbate / 100) / 10, bando: Math.round(bandoSpawn * 10) / 10, golpe: golpe ? golpe[0] : null,
          risco: Math.round(risco * 100) / 100, eff: Math.round(effMed * 100) / 100, effH: Math.round(effH * 100) / 100, effMax });
      }

      // Teto do ritmo calibrado pelo que a conta MEDIU — só nas hunts em que a luta é bem mais rápida que o tempo
      // medido (senão a luta é que manda e a medida não diz nada do teto). Sem medida assim, o padrão.
      // (O teto é POR ABATE: o simulador do jogo dá ~3,4 s por abate mesmo matando num golpe, e o AoE só
      // encurta ~10% — a onda é que segura. Medido: 934/h e 847/h com AoE.)
      const pisoMedido = mediana(out.filter((h) => h.medido && h.tAbate < 0.6 * (h.medido.ms / h.medido.ab))
        .map((h) => (h.medido.ms / h.medido.ab) * (1 + vel)));
      const ritmo = Math.min(9000, Math.max(2500, pisoMedido || PISO_PADRAO_MS));
      const pisoParada = ritmo / (1 + vel); // a bike encurta só a caminhada
      // Tempo por abate = o MAIOR entre o teto e a luta. Na luta lenta o AoE divide o tempo só pelo bando que
      // a conta já viu nascer junto NAQUELA hunt (sem medida: 2) — nunca passa do teto: matar devagar não
      // rende mais abates que matar na hora.
      const msPorAbate = (h) => {
        const bandoEf = act.aoe ? Math.max(1, h.bandoMedido || 2) : 1;
        h.bando = Math.round(bandoEf * 10) / 10;
        return Math.max(pisoParada, h.tAbate / bandoEf);
      };
      // Acerto geral pelo que a conta MEDIU: abates/h medidos ÷ abates/h que a conta previa nas mesmas hunts.
      // Vale para todas as estimativas (o teto e a luta erram juntos na mesma conta). Ex.: 917/h medidos no
      // Gabite contra ~1.060/h previstos = ×0,86 em todas as outras.
      const fatorMed = mediana(out.filter((h) => h.medido).map((h) => (h.medido.ab / (h.medido.ms / 3600000)) / (3600000 / msPorAbate(h))));
      const fator = fatorMed ? Math.min(1.3, Math.max(0.5, fatorMed)) : 1;
      for (const h of out) {
        const m = h.medido;
        const horas = m ? m.ms / 3600000 : 0;
        // O acerto pela medida nunca leva a estimativa acima do teto da onda (nem do melhor ritmo que a conta já mediu).
        const tetoKph = Math.max(3600000 / pisoParada, ...out.filter((x) => x.medido).map((x) => x.medido.ab / (x.medido.ms / 3600000)));
        const kph = m ? m.ab / horas : Math.min(tetoKph, (3600000 / msPorAbate(h)) * fator);
        if (m) msPorAbate(h);
        h.kph = Math.round(kph);
        // XP e ouro: sempre abates/h × o que cada selvagem dá × os bônus de AGORA — a medida entra só no ritmo.
        // (O XP medido mistura horas com e sem evento/boost e não dá para comparar com as estimativas.)
        h.xpH = Math.round(kph * h.xp * bx);
        h.goldH = Math.round(kph * h.gold);
        // Ouro "de verdade": quanto mais o pokémon apanha, mais poção some do lucro (estimativa).
        h.goldLiq = Math.round(h.goldH / (1 + Math.max(0, h.risco - 1) * 0.6));
        h.medidoMin = m ? Math.round(m.ms / 60000) : 0;
        h.teto = h.tAbate <= pisoParada; // mata mais rápido que o teto: ×5,5 ou ×2,5 tanto faz aqui
        h.lenta = !m && h.tAbate > pisoParada * 1.5; // luta bem mais lenta que o teto: estimativa menos certa
        delete h.medido; delete h.tAbate; delete h.bandoSpawn; delete h.bandoMedido; delete h.porOnda; delete h.xp; delete h.gold;
      }
      // Quase empate (até 3%): fica na frente a de mais dano (×5,5 antes de ×2,5) e depois a já medida.
      // (Só na ORDEM: os números mostrados não mudam.)
      const ordem = (h, k) => h[k] * (h.effH >= 4.5 ? 1.03 : 1) * (h.medidoMin ? 1.01 : 1);
      out.sort((a, b) => ordem(b, 'xpH') - ordem(a, 'xpH'));
      const atualEst = out.find((h) => h.slug && h.slug === atualSlug) || null;
      return {
        pronto: true, L, pokemon: cat.name || '?', tipos: atk, aoe: act.aoe, bike: rar, vel, bonus: bx, tipoDia, seuDoDia: !!(tipoDia && tiposPk.includes(tipoDia)),
        calibrado: out.filter((h) => h.medidoMin).length, ritmo: Math.round(ritmo), fator: Math.round(fator * 100) / 100, hpExtra: Math.round(hpExtra * 100) / 100,
        top: out.slice(0, 8), atual: atualSlug, atualEst,
        topOuro: [...out].sort((a, b) => ordem(b, 'goldLiq') - ordem(a, 'goldLiq')).slice(0, 8),
        todas: opts && opts.todas ? out.map((h) => ({ slug: h.slug, nome: h.nome, nivel: h.nivel, kph: h.kph })) : undefined,
      };
    }

    // ---- PvP: consulta a tabela e as equipes públicas dos primeiros, devagar ----
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    async function pvpColetar(n = 50, passoMs = 5000) {
      if (pvp.coletando) return { ok: false, motivo: 'ja' };
      if (!sock || sock.readyState !== 1) return { ok: false, motivo: 'sem conexão' };
      pvp.coletando = true; pvp.erro = null; pvp.feitos = 0;
      try {
        const antes = pvp.tabelaEm;
        nossos.tabela = Date.now();
        sock.send(JSON.stringify({ t: 'pvp.tabela', pagina: 1 }));
        for (let i = 0; i < 40 && pvp.tabelaEm === antes; i++) await espera(500);
        if (pvp.tabelaEm === antes) { pvp.erro = 'a tabela não respondeu'; return { ok: false, motivo: pvp.erro }; }
        const nicks = (pvp.tabela || []).slice(0, Math.max(1, Math.min(100, n))).map((l) => l[1]).filter(Boolean);
        pvp.total = nicks.length;
        const novos = {};
        for (const nick of nicks) {
          if (!sock || sock.readyState !== 1) break;
          const k = String(nick).toLowerCase();
          nossos.perfis.set(k, Date.now());
          const t0 = Date.now();
          sock.send(JSON.stringify({ t: 'ranking.perfil', nick }));
          for (let i = 0; i < 16 && !(pvp.perfis[nick] && pvp.perfis[nick].em >= t0); i++) await espera(500);
          if (pvp.perfis[nick] && pvp.perfis[nick].em >= t0) novos[nick] = pvp.perfis[nick];
          pvp.feitos++;
          await espera(passoMs);
        }
        pvp.at = Date.now();
        setTimeout(() => nossos.perfis.clear(), 30000);
        return { ok: true, n: Object.keys(novos).length };
      } finally { pvp.coletando = false; }
    }
    // Junta tudo com nome, tipos e alcance de cada espécie, e as espécies que a conta tem.
    async function pvpLer(extraIds) {
      const esp = await especies();
      const tab = await tabuleiro();
      const info = {};
      const anota = (id) => {
        if (id == null || info[id]) return;
        const c = esp.get(id);
        if (!c) return;
        let alc = 1;
        try { alc = tab ? tab.alcanceDaEspecie(c) : 1; } catch {}
        const n = (k) => Number(c[k]) || 0;
        info[id] = { nome: c.name, tipos: tiposDe(c), alcance: alc,
          stats: { hp: n('baseHp'), atk: n('baseAtk'), def: n('baseDef'), spa: n('baseSpAtk'), spd: n('baseSpDef'), spe: n('baseSpeed') } };
      };
      const linhas = (pvp.tabela || []).slice(0, 100).map((l) => ({ pos: l[0], nick: l[1], tier: l[2], div: l[3], pr: l[4], v: l[5], d: l[6] }));
      for (const p of Object.values(pvp.perfis)) for (const k of p.time) anota(k.speciesId);
      for (const id of Array.isArray(extraIds) ? extraIds.slice(0, 400) : []) anota(id);
      const meus = {};
      // Cada pokémon da conta (pelo id): dois Charizards são dois — o PvP pode levar os dois.
      for (const k of jogo.pks.values()) { anota(k.speciesId); meus[k.id] = { ...k }; }
      const eu = pvp.eu ? pvp.eu.dados : null;
      // Sem o time ativo ainda (a aba PvP do jogo não foi aberta): pede a mesma leitura que a aba faz (no máx. 1×/5 min).
      if ((!pvp.meuTime || !pvp.meuTime.ids) && sock && sock.readyState === 1 && Date.now() - (pvp.pediuInfo || 0) > 5 * 60 * 1000) {
        pvp.pediuInfo = Date.now();
        try { sock.send(JSON.stringify({ t: 'pvp.info', semLadder: 1 })); } catch {}
      }
      return { meuTime: pvp.meuTime || null, euPvp: jogo.eu.pvp ? JSON.parse(JSON.stringify(jogo.eu.pvp)) : null, nivel: Number(jogo.eu.level) || 0, at: pvp.at, coletando: pvp.coletando, feitos: pvp.feitos, total: pvp.total, erro: pvp.erro, linhas, perfis: pvp.perfis, info, meus, tabelaTipos: jogo.tabelaTipos, eu, nick: jogo.eu.nick || null, euKeys: jogo.keys.slice(0, 80) };
    }

    // ---- duelo 1×1 com as contas do jogo ----
    let modGin = null;
    const gin = () => (modGin || (modGin = import('/shared/ginasios.mjs').catch(() => null)));
    async function duelos(a, b) {
      const g = await gin();
      if (!g || !g.compararDuelo1v1) return { erro: 'comparador indisponível' };
      const esp = await especies();
      const tab = jogo.tabelaTipos || {};
      const m = [];
      for (const x of a || []) {
        const ea = esp.get(x.speciesId);
        m.push((b || []).map((y) => {
          const eb = esp.get(y.speciesId);
          if (!ea || !eb) return null;
          try { const r = g.compararDuelo1v1({ ...x, id: x.id ?? 1 }, ea, { ...y, id: y.id ?? 2 }, eb, { amostras: 80, tabelaTipos: tab }); return r ? Math.round(r.pctA * 1000) / 1000 : null; } catch { return null; }
        }));
      }
      return { m };
    }
    // Melhores espécies contra o meta, se a pessoa pudesse ter qualquer uma (a "baleia"): cada espécie
    // forte do jogo (inclusive Mega), num pokémon de referência do nível/qualidade típicos do top,
    // em duelo contra cada pokémon dos times do top.
    async function candidatos(meta, opts = {}) {
      const g = await gin();
      if (!g || !g.compararDuelo1v1) return { erro: 'comparador indisponível' };
      const esp = await especies();
      const tab = jogo.tabelaTipos || {};
      const alvo = (meta || []).slice(0, 250);
      const ref = opts.ref || {};
      const lista = [...esp.values()].filter((c) => {
        const soma = (Number(c.baseHp) || 0) + (Number(c.baseAtk) || 0) + (Number(c.baseDef) || 0) + (Number(c.baseSpAtk) || 0) + (Number(c.baseSpDef) || 0) + (Number(c.baseSpeed) || 0);
        return soma >= (opts.minSoma || 520);
      });
      let mis = null;
      try { mis = await import('/shared/mistico.mjs'); } catch {}
      const out = [];
      let n = 0, erro1 = null;
      for (const c of lista) {
        const tipos = tiposDe(c);
        const pk = { id: 1, speciesId: c.pokeId, level: ref.level || 3000, ivs: ref.ivs || { hp: 22, atk: 22, def: 22, spAtk: 22, spDef: 22, speed: 22 }, quality: ref.quality ?? 1.25, potencia: ref.potencia ?? 2, refino: ref.refino || { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0 }, tmElemental: tipos[0] || null, tmFisico: false, shiny: !!ref.shiny };
        let soma = 0, peso = 0;
        const arq = {};
        for (const e of alvo) {
          const eb = esp.get(e.speciesId);
          if (!eb) continue;
          let p = 0.5;
          try { const r = g.compararDuelo1v1(pk, c, { ...e, id: 2 }, eb, { amostras: 24, tabelaTipos: tab }); if (r) p = r.pctA; else if (!erro1) erro1 = 'nulo'; } catch (x) { if (!erro1) erro1 = String(x && x.message || x); }
          soma += p * (e.w || 1); peso += e.w || 1;
          if (e.arq != null) { const a = arq[e.arq] || (arq[e.arq] = [0, 0]); a[0] += p; a[1]++; }
        }
        let lend = false;
        try { lend = !!(mis && mis.ehLendarioOuMitico && mis.ehLendarioOuMitico(c.pokeId)); } catch {}
        const porArq = {};
        for (const [k, v] of Object.entries(arq)) porArq[k] = Math.round((v[0] / v[1]) * 100) / 100;
        if (peso) out.push({ speciesId: c.pokeId, nome: c.name, tipos, win: Math.round((soma / peso) * 1000) / 1000, z: pk.tmElemental, lend, porArq });
        if (++n % 40 === 0) await new Promise((r) => setTimeout(r, 0)); // não trava a página do jogo
      }
      out.sort((x, y) => y.win - x.win);
      // Os melhores que dá para conseguir (sem lendário/mítico) e, à parte, os lendários.
      return { lista: [...out.filter((x) => !x.lend).slice(0, opts.top || 40), ...out.filter((x) => x.lend).slice(0, 15)], erro1 };
    }
    // Preço no Market agora (ofertas por espécie, "a partir de"), uma consulta a cada 2,5 s.
    async function precosDe(nomes) {
      const res = {};
      for (const nome of (nomes || []).slice(0, 15)) {
        if (!sock || sock.readyState !== 1) break;
        const k = String(nome).toLowerCase();
        if (precos[k] && Date.now() - precos[k].em < 20 * 60 * 1000) { res[nome] = precos[k].linhas; continue; }
        // Com o Mercado aberto na tela, não consulta (a resposta poderia aparecer para a pessoa).
        if (document.querySelector('#community:not(.hidden)')) break;
        const antes = ultimaEspecies && ultimaEspecies.em;
        nossos.especies = Date.now();
        sock.send(JSON.stringify({ t: 'market.especies', tipo: 'pokemon', busca: String(nome), pagina: 0 }));
        for (let i = 0; i < 12 && (ultimaEspecies && ultimaEspecies.em) === antes; i++) await espera(400);
        if (ultimaEspecies && ultimaEspecies.em !== antes) {
          const linhas = (ultimaEspecies.m.linhas || []).slice(0, 6).map((e) => JSON.parse(JSON.stringify(e)));
          precos[k] = { em: Date.now(), linhas };
          res[nome] = linhas;
        }
        await espera(2500);
      }
      return res;
    }

    // Busca no Market NA HORA (o orçamento da pessoa): as ofertas mais baratas de cada espécie boa no
    // PvP, uma consulta a cada 2,5 s, e cada pokémon à venda avaliado no duelo 1×1 do jogo contra o top
    // (o pokémon de verdade: nível, IV, qualidade, potência, refino, shiny, Z-Move). Só leitura.
    async function ofertas(ids, moeda, meta) {
      const g = await gin();
      const esp = await especies();
      const tab = jogo.tabelaTipos || {};
      const alvo = (meta || []).slice(0, 250);
      const out = [];
      for (const id of (ids || []).slice(0, 15)) {
        if (!sock || sock.readyState !== 1) break;
        if (document.querySelector('#community:not(.hidden)')) return { erro: 'mercado-aberto', lista: out };
        const antes = ultimaLista && ultimaLista.em;
        nossos.lista = Date.now();
        sock.send(JSON.stringify({ t: 'market.listar', tipo: 'pokemon', moeda: moeda === 'gold' ? 'gold' : 'orb', ordem: 'baratos', busca: '', criterios: [], elementos: [], pagina: 0, especieId: Number(id) }));
        for (let i = 0; i < 12 && (ultimaLista && ultimaLista.em) === antes; i++) await espera(400);
        if (ultimaLista && ultimaLista.em !== antes) {
          for (const a of (ultimaLista.m.linhas || []).slice(0, 8)) {
            const f = a.ficha || {};
            if (a.tipo !== 'pokemon' || !f.speciesId) continue;
            const c = esp.get(f.speciesId);
            if (!c) continue;
            const pk = { id: 1, speciesId: f.speciesId, level: Number(f.level) || 1, ivs: f.ivs || null, quality: f.quality ?? null, potencia: f.potencia ?? null, refino: f.refino || null, tmElemental: f.tmElemental || null, tmFisico: !!f.tmFisico, shiny: !!f.shiny };
            let soma = 0, peso = 0;
            if (g && g.compararDuelo1v1) for (const e of alvo) { const eb = esp.get(e.speciesId); if (!eb) continue; let p = 0.5; try { const r = g.compararDuelo1v1(pk, c, { ...e, id: 2 }, eb, { amostras: 24, tabelaTipos: tab }); if (r) p = r.pctA; } catch {} soma += p * (e.w || 1); peso += e.w || 1; }
            out.push({ anuncio: a.id, speciesId: f.speciesId, nome: f.nome || c.name, level: pk.level, shiny: pk.shiny, aoe: f.tmAoe === true || f.tmAoe === 1, el: f.tmElemental || null, potencia: f.potencia ?? null, preco: Number(a.preco) || 0, qtd: Number(a.qtd) || 1, moeda: a.moeda, vendedor: a.vendedor || '', retido: a.compravelEm && a.compravelEm > Date.now(), win: peso ? Math.round((soma / peso) * 1000) / 1000 : 0, tipos: tiposDe(c) });
          }
        }
        await espera(2500);
      }
      return { lista: out };
    }

    // ---- Treinador pela conexão: nick, nível, XP e ouro chegam mesmo no ULTRA (que não desenha nada) ----
    function treinador() {
      const e = jogo.eu;
      if (!e.nick) return null;
      const dentro = Math.max(0, (Number(e.xp) || 0) - (Number(e.xpNivel) || 0));
      const faixa = Math.max(1, (Number(e.xpProximo) || 0) - (Number(e.xpNivel) || 0));
      return { nick: String(e.nick), level: Number(e.level) || 0, dentro, faixa, gold: Number(e.gold) || 0, guildTag: (e.guild && e.guild.tag) || null, guildNome: (e.guild && e.guild.nome) || null, at: jogo.at || 0 };
    }
    // Faixa do Idleterino no modo ULTRA: nick, nível e XP do nível, em cima da caixa do jogo. Só
    // mostra (não clica em nada) e some fora do ULTRA.
    setInterval(() => {
      const ultra = document.documentElement.classList.contains('modo-ultra');
      let f = document.getElementById('idleterino-ultra');
      const t = ultra ? treinador() : null;
      if (!t) { if (f) f.remove(); return; }
      // Dentro da caixa do ULTRA (o jogo esconde tudo o que fica fora dela), logo abaixo do título.
      const caixa = document.querySelector('#ultra .ultra-caixa') || document.querySelector('.ultra-caixa');
      if (f && caixa && f.parentElement !== caixa) { f.remove(); f = null; }
      if (!f) {
        f = document.createElement('div'); f.id = 'idleterino-ultra';
        f.style.cssText = 'pointer-events:none;display:flex;flex-direction:column;gap:4px;margin:6px 0 8px;padding:8px 12px;border-radius:10px;background:rgba(12,13,20,.82);border:1px solid rgba(255,255,255,.14);color:#eef0f7;font:700 14px/1.3 "Segoe UI",system-ui,sans-serif;text-align:center';
        if (!caixa) f.style.cssText += ';position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483646;min-width:260px';
        const l1 = document.createElement('div'); l1.className = 'l1';
        const bar = document.createElement('div'); bar.style.cssText = 'height:6px;border-radius:6px;background:rgba(255,255,255,.1);overflow:hidden';
        const fill = document.createElement('i'); fill.style.cssText = 'display:block;height:100%;background:linear-gradient(90deg,#ff4d6d,#a970ff,#53fc18)'; bar.append(fill);
        const l2 = document.createElement('div'); l2.className = 'l2'; l2.style.cssText = 'font-weight:500;font-size:12px;color:#a7adc2';
        f.append(l1, bar, l2);
        if (caixa) { const titulo = caixa.firstElementChild; if (titulo) titulo.after(f); else caixa.prepend(f); }
        else { (document.body || document.documentElement).append(f); f.style.setProperty('display', 'flex', 'important'); }
      }
      const n = (x) => Number(x || 0).toLocaleString('pt-BR');
      const pct = Math.min(100, (t.dentro / t.faixa) * 100);
      f.querySelector('.l1').textContent = `${t.nick} · Nv ${t.level}`;
      f.querySelector('i').style.width = `${pct}%`;
      f.querySelector('.l2').textContent = `${n(t.dentro)} / ${n(t.faixa)} xp (${pct.toFixed(1).replace('.', ',')}%) · ouro ${n(t.gold)}`;
    }, 2000);

    const PEDIDOS = { 'market.meus': 1, 'market.historico': 1, 'market.historicoGlobal': 1 };
    Object.defineProperty(window, '__idleterinoMercado', {
      value: Object.freeze({
        pedir(t, pagina) {
          if (!PEDIDOS[t] || !sock || sock.readyState !== 1) return false;
          const msg = { t };
          if (t !== 'market.meus') { msg.pagina = Math.max(0, Math.min(4, pagina | 0)); msg.seq = SEQ; }
          sock.send(JSON.stringify(msg));
          return true;
        },
        ler() { return JSON.parse(JSON.stringify(keep)); },
        canais() { return JSON.parse(JSON.stringify(canais)); },
        // Aba PvE do app (só leitura).
        pve(o, arg) {
          const f = o === 'proximas' ? pveProximas : o === 'evolucoes' ? () => pveEvolucoes(arg) : o === 'meus' ? pveMeus : o === 'buscar' ? () => pveBuscar(arg) : o === 'casas' ? () => pveCasas(arg) : o === 'shiny' ? () => pveShiny(arg) : o === 'boss' ? () => pveBoss(arg) : o === 'mercado' ? () => (arg && typeof arg === 'object' ? pveMercado(arg.moeda, arg.dias, arg.valor) : pveMercado(arg)) : null;
          return f ? f().catch((e) => ({ erro: String(e && e.message || e) })) : null;
        },
        // Comércio: nota, stats e espécie da ficha de um anúncio (mesma conta da ficha do jogo).
        fichaNota(f) { return fichaNota(f).catch(() => null); },
        // Previsão de shiny: chance por encontro (do servidor) e o fim de cada bônus de shiny que vale agora.
        shinyInfo() {
          const fim = (k) => Number(canais[k] && canais[k].bonus && canais[k].bonus.shiny) || 0;
          return { chance: jogo.chanceShiny || 0, lure: jogo.eu.lureAte || 0, kick: fim('kick'), twitch: fim('twitch') };
        },
        hunts() { return hunts.slice(); },
        // Encaixe: `__plug('nome', function (I) { ... })` instala uma vez; o que ela expõe fica em `extra`.
        extra: extras.api,
        __plug(nome, fn) {
          if (typeof fn !== 'function' || extras.instalados.has(nome)) return extras.instalados.has(nome);
          extras.instalados.add(nome);
          const I = {
            get sock() { return sock; }, get ultimaLista() { return ultimaLista; },
            jogo, keep, nossos, espera, catalogoNota, huntsDoHorizonte, nivelDepoisDe, xpHoraDaConta, coberturaHunts, tiposDe, fichaNota,
            get meuTimePvp() { return pvp.meuTime ? JSON.parse(JSON.stringify(pvp.meuTime)) : null; },
            filtro: (f) => extras.filtros.push(f), ouvir: (f) => extras.ouvintes.push(f), expor: (o) => Object.assign(extras.api, o),
          };
          try { fn(I); return true; } catch (e) { extras.instalados.delete(nome); return String(e && e.message || e); }
        },
        bonusXp() { return bonusXp ? JSON.parse(JSON.stringify(bonusXp)) : null; },
        huntRank(o) { return huntRank(o && o.testeAoe ? { testeAoe: true } : undefined).then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ pronto: false, erro: String(e) })); },
        pvpColetar(n, passo) { return pvpColetar(n, passo).catch((e) => ({ ok: false, motivo: String(e) })); },
        treinador() { const t = treinador(); return t ? { ...t } : null; },
        pvpEu() { return jogo.eu.pvp ? { ...JSON.parse(JSON.stringify(jogo.eu.pvp)), nick: jogo.eu.nick || null } : null; },
        pvpEstado() { return { coletando: pvp.coletando, feitos: pvp.feitos, total: pvp.total, at: pvp.at }; },
        // Duelo 1×1 do próprio jogo (o "Comparar" e o ginásio): matriz de chance de vitória de A contra B.
        duelos(a, b) { return duelos(a, b).then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ erro: String(e) })); },
        candidatos(meta, opts) { return candidatos(meta, opts).then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ erro: String(e) })); },
        ofertas(ids, moeda, meta) { return ofertas(ids, moeda, meta).then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ erro: String(e) })); },
        precos(nomes) { return precosDe(nomes).then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ erro: String(e) })); },
        pvpLer(ids) { return pvpLer(ids).then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ erro: String(e) })); },
      }),
    });
  },
});
