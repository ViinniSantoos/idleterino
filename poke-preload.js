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
//  · sugestão de hunt: as contas do próprio jogo (módulo /hunt-analyser.mjs) + AoE, bicicleta e efetividade;
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
    const jogo = { hunts: null, tabelaTipos: null, amp: 1.5, eu: {}, pks: new Map(), keys: [] };
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
    // Base: as contas do jogo (kills por onda, golpe, deslocamento e XP/ouro por kill, do /hunt-analyser.mjs).
    // Em cima delas: efetividade do pokemon em campo contra cada espécie (com a ampliação de hunt do jogo),
    // AoE (até 3 alvos por golpe) e bicicleta (o passo divide pelo fator da raridade). É estimativa.
    const GOLPES_NEUTRO = 2; // golpes para derrubar um selvagem com dano neutro (premissa da estimativa)
    async function huntRank() {
      if (!jogo.hunts || !jogo.tabelaTipos) return { pronto: false };
      let ha;
      try { ha = await import('/hunt-analyser.mjs'); } catch { return { pronto: false, erro: 'modulo' }; }
      const esp = await especies();
      const L = Number(jogo.eu.level) || 0;
      const act = jogo.pks.get(jogo.eu.activeId);
      if (!act) return { pronto: true, semPokemon: true };
      const cat = esp.get(act.speciesId) || {};
      const atk = [...new Set([...tiposDe(cat), act.el ? String(act.el).toUpperCase() : null].filter(Boolean))];
      const rar = jogo.eu.bicicleta && (jogo.eu.bicicleta.equipadaRar || null);
      const vel = VEL_BIKE[rar] || 0;
      const bx = bonusXp ? bonusXp.tr : 1;
      const amp = jogo.amp || 1.5;
      const out = [];
      for (const h of jogo.hunts) {
        const nivel = Number(h.nivel) || 0;
        if (nivel > L || !Array.isArray(h.especies) || !h.especies.length) continue;
        let pontos = 0, golpes = 0, effMed = 0, effMax = 0, risco = 0;
        const def = tiposDe(cat);
        const nivelRel = nivel / Math.max(1, Number(act.level) || 1); // hunt acima do nível do pokémon = mob batendo mais forte
        for (const e of h.especies) {
          const c = esp.get(e.pokeId) || {};
          const t = tiposDe(c);
          let eff = 1;
          try { eff = ha.melhorEfetividadeContra(atk, t[0] || null, t[1] || null, jogo.tabelaTipos) || 1; } catch {}
          const effH = eff > 1 ? 1 + (eff - 1) * amp : eff;
          const w = Number(e.pontos) || 1;
          pontos += w; effMed += eff * w; effMax = Math.max(effMax, eff);
          golpes += Math.max(1, Math.ceil(GOLPES_NEUTRO / Math.max(0.05, effH))) * w;
          // Risco de gastar poção: o golpe do selvagem contra o SEU pokémon (tipos dele × os seus) e o nível da hunt.
          let dano = 1;
          try { dano = ha.melhorEfetividadeContra(t, def[0] || null, def[1] || null, jogo.tabelaTipos) || 1; } catch {}
          risco += dano * nivelRel * w;
        }
        if (!pontos) continue;
        golpes /= pontos; effMed /= pontos; risco /= pontos;
        const porOnda = Math.min(ha.MAX_MOBS || 16, pontos);
        const alvos = act.aoe ? Math.min(3, porOnda) : 1;
        const msKill = (golpes * ((ha.CD_GOLPE_MS || 900) + (ha.CD_MOVIMENTO_MEDIO_MS || 2000)) + (ha.MS_DESLOC_MS || 600) / (1 + vel)) / alvos;
        const kph = (porOnda / ((porOnda * msKill + (ha.MS_ONDA || 2600)) / 1000)) * 3600;
        let xp = 0, gold = 0;
        try { const r = ha.mediaPorKill(h, esp, 0); xp = r.xp; gold = r.gold; } catch {}
        // Ouro "de verdade": quanto mais o pokémon apanha, mais poção some do lucro (estimativa).
        const goldH = Math.round(kph * gold);
        const goldLiq = Math.round(goldH / (1 + Math.max(0, risco - 1) * 0.6));
        out.push({ slug: h.slug || null, nome: String(h.nome || h.name || h.slug || '?'), nivel, kph: Math.round(kph), xpH: Math.round(kph * xp * bx), goldH, goldLiq, risco: Math.round(risco * 100) / 100, eff: Math.round(effMed * 100) / 100, effMax });
      }
      out.sort((a, b) => b.xpH - a.xpH);
      const atualSlug = jogo.eu.huntSlug || (jogo.eu.hunt && jogo.eu.hunt.slug) || null;
      const atualEst = out.find((h) => h.slug && h.slug === atualSlug) || null;
      return {
        pronto: true, L, pokemon: cat.name || '?', tipos: atk, aoe: act.aoe, bike: rar, vel, bonus: bx,
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
