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
    const ABAS = { meus: 1, historico: 1, historicoGlobal: 1 };
    const SEQ = 987654321;

    // ---- estado leve do jogador: o que a sugestão de hunt e o PvP precisam ----
    const jogo = { hunts: null, tabelaTipos: null, amp: 1.5, multHp: 5, eu: {}, pks: new Map(), keys: [] };
    const CAMPOS_EU = ['guild', 'xp', 'xpNivel', 'xpProximo', 'gold', 'nick', 'level', 'activeId', 'bicicleta', 'pvp', 'pvpRank', 'pvpPosicao', 'pvpHistorico', 'pvpTime', 'huntSlug', 'hunt', 'huntAtual', 'area'];
    const DUELO = (k) => ({ ivs: k.ivs || null, quality: k.quality ?? k.qualidade ?? null, potencia: k.potencia ?? null, refino: k.refino || null, tmElemental: k.tmElemental || null, tmFisico: !!k.tmFisico });
    const slimPk = (k) => ({
      ...DUELO(k),
      id: k.id, speciesId: k.speciesId, level: Number(k.level) || 0, shiny: !!k.shiny, starter: !!k.starter,
      aoe: k.tmAoe === true || k.tmAoe === 1 || k.tmAoe === 'true' || k.tm_aoe === true,
      el: k.tmElemental || k.tm_elemental || null, apelido: k.apelido || null, poder: Number(k.poder || k.power) || 0,
    });
    function aplicarEstado(p, cheioForcado) {
      if (!p || typeof p !== 'object') return;
      const { cheio, pokemons, pkMud, pkFora } = p;
      if (cheio || cheioForcado) jogo.keys = Object.keys(p);
      for (const k of CAMPOS_EU) if (k in p) jogo.eu[k] = p[k];
      if ('nick' in p || 'xp' in p || 'level' in p) jogo.at = Date.now();
      if (Array.isArray(pokemons)) jogo.pks = new Map(pokemons.map((k) => [k.id, slimPk(k)]));
      for (const k of pkMud || []) jogo.pks.set(k.id, slimPk(k));
      for (const id of pkFora || []) jogo.pks.delete(id);
    }

    // ---- consultas do app que o jogo NÃO deve desenhar (o perfil de outro jogador abriria na tela) ----
    const nossos = { tabela: 0, perfis: new Map(), especies: 0, lista: 0 };
    const precos = {}; // nome em minúsculas -> { em, linhas }
    let ultimaEspecies = null;
    let ultimaLista = null;
    const recente = (t) => t && Date.now() - t < 30000;
    function ehNosso(d) {
      if (typeof d !== 'string') return false;
      if (d.indexOf('"pvpTabela"') >= 0 && recente(nossos.tabela)) return true;
      if (d.indexOf('"especies"') >= 0 && d.indexOf('"market"') >= 0 && Date.now() - nossos.especies < 8000) return true;
      if (d.indexOf('"vitrine"') >= 0 && d.indexOf('"market"') >= 0 && Date.now() - nossos.lista < 8000) return true;
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
              try { const m = JSON.parse(d); if (m.t === 'pvp') pvp.eu = { em: Date.now(), dados: JSON.parse(JSON.stringify(m)) }; } catch {}
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
    // Depois, o que a conta MEDIU (placar do jogo, 10+ min na hunt com este pokémon) acerta a escala das
    // outras e substitui a estimativa da própria hunt. O resto é estimativa.
    const IV_SELVAGEM = 16;            // IV médio de selvagem (1–32)
    const HP_SELVAGEM_EXTRA = 1.33;    // Gible nv 1000: 72.000 de vida no campo contra 54.000 da conta crua (28/10/2026)
    const BANDO_PADRAO = 5;            // selvagens por bando enquanto o campo não mostrou nenhum
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

    async function huntRank() {
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

      const passo = (ha.MS_DESLOC_MS || 600) / (1 + vel);
      const out = [];
      for (const h of jogo.hunts) {
        const nivel = Number(h.nivel) || 0;
        if (nivel > L || !Array.isArray(h.especies) || !h.especies.length) continue;
        let pontos = 0, tAbate = 0, effMed = 0, effH = 0, effMax = 0, risco = 0, semDano = false;
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
          tAbate += Math.max(P.gi, (hp / r.dps) * 1000) * w;
          golpeUso[r.golpe] = (golpeUso[r.golpe] || 0) + w;
          pontos += w; effMed += eff * w; effH += naHunt(eff, amp) * w; effMax = Math.max(effMax, eff);
          // Risco de gastar poção: o golpe do selvagem contra o SEU pokémon (tipos dele × os seus) e o nível da hunt.
          let dano = 1;
          try { dano = ha.melhorEfetividadeContra(t, tiposPk[0] || null, tiposPk[1] || null, jogo.tabelaTipos) || 1; } catch {}
          risco += dano * nivelRel * w;
        }
        if (semDano || !pontos) continue;
        tAbate /= pontos; effMed /= pontos; effH /= pontos; risco /= pontos;
        const porOnda = Math.min(ha.MAX_MOBS || 16, pontos);
        const M = medido[h.slug] || null;
        const bando = act.aoe ? Math.min(porOnda, mediana((M && M.bando) || []) || BANDO_PADRAO) : 1;
        // Por selvagem: a luta (o bando inteiro de uma vez com AoE), a caminhada até o próximo alvo e a pausa da onda.
        const msModelo = tAbate / bando + passo / bando + (ha.MS_ONDA || 2600) / porOnda;
        let xp = 0, gold = 0;
        try { const r = ha.mediaPorKill(h, esp, 0); xp = r.xp; gold = r.gold; } catch {}
        const med = M && M.pk && M.pk[act.id];
        const golpe = Object.entries(golpeUso).sort((a, b) => b[1] - a[1])[0];
        out.push({ slug: h.slug || null, nome: String(h.nome || h.name || h.slug || '?'), nivel, msModelo, xp, gold,
          medido: med && med.ms >= MEDIDO_MIN_MS && med.ab >= 20 ? med : null,
          seg: Math.round(tAbate / 100) / 10, bando: Math.round(bando * 10) / 10, golpe: golpe ? golpe[0] : null,
          risco: Math.round(risco * 100) / 100, eff: Math.round(effMed * 100) / 100, effH: Math.round(effH * 100) / 100, effMax });
      }

      // Escala: o que a conta mediu com este pokémon contra o que a conta previa nas mesmas hunts.
      const k = mediana(out.filter((h) => h.medido).map((h) => (h.medido.ms / h.medido.ab) / h.msModelo)) || 1;
      for (const h of out) {
        const m = h.medido;
        const horas = m ? m.ms / 3600000 : 0;
        const kph = m ? m.ab / horas : 3600000 / (h.msModelo * k);
        h.kph = Math.round(kph);
        h.xpH = Math.round(m ? m.xp / horas : kph * h.xp * bx);
        h.goldH = Math.round(m ? m.gold / horas : kph * h.gold);
        // Ouro "de verdade": quanto mais o pokémon apanha, mais poção some do lucro (estimativa).
        h.goldLiq = Math.round(h.goldH / (1 + Math.max(0, h.risco - 1) * 0.6));
        h.medidoMin = m ? Math.round(m.ms / 60000) : 0;
        delete h.medido; delete h.msModelo; delete h.xp; delete h.gold;
      }
      out.sort((a, b) => b.xpH - a.xpH);
      const atualEst = out.find((h) => h.slug && h.slug === atualSlug) || null;
      return {
        pronto: true, L, pokemon: cat.name || '?', tipos: atk, aoe: act.aoe, bike: rar, vel, bonus: bx,
        calibrado: out.filter((h) => h.medidoMin).length, escala: Math.round(k * 100) / 100, hpExtra: Math.round(hpExtra * 100) / 100,
        top: out.slice(0, 8), atual: atualSlug, atualEst,
        topOuro: [...out].sort((a, b) => b.goldLiq - a.goldLiq).slice(0, 8),
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
      for (const k of jogo.pks.values()) { anota(k.speciesId); const cur = meus[k.speciesId]; if (!cur || k.level > cur.level) meus[k.speciesId] = { ...k }; }
      const eu = pvp.eu ? pvp.eu.dados : null;
      return { euPvp: jogo.eu.pvp ? JSON.parse(JSON.stringify(jogo.eu.pvp)) : null, nivel: Number(jogo.eu.level) || 0, at: pvp.at, coletando: pvp.coletando, feitos: pvp.feitos, total: pvp.total, erro: pvp.erro, linhas, perfis: pvp.perfis, info, meus, tabelaTipos: jogo.tabelaTipos, eu, nick: jogo.eu.nick || null, euKeys: jogo.keys.slice(0, 80) };
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
        hunts() { return hunts.slice(); },
        bonusXp() { return bonusXp ? JSON.parse(JSON.stringify(bonusXp)) : null; },
        huntRank() { return huntRank().then((r) => JSON.parse(JSON.stringify(r))).catch((e) => ({ pronto: false, erro: String(e) })); },
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
