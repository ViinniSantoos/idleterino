// Idleterino — preparo das páginas das contas do PokeIdle (roda antes do jogo).
//
// O Início mostra o mercado de cada conta (Meus anúncios, Histórico de vendas e a Tabela de preços).
// O jogo só aceita UMA conexão por conta, então nada de abrir outra: guardamos as respostas de
// mercado que chegam pela conexão que o próprio jogo abriu, e pedimos só as mesmas três consultas que
// os botões do mercado pedem. Comprar, vender, editar ou remover: nunca (nem é possível por aqui).
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    if (!/(^|\.)pokeidle\.io$/.test(location.hostname)) return;
    const Native = window.WebSocket;
    const keep = {};
    // Blocos "twitch" e "kick" do estado do jogador: a lista oficial de canais e os bônus ativos.
    // O estado chega em pedaços, mas cada chave de cima chega inteira quando muda.
    const canais = {};
    // Hunts do jogo com o nível que libera cada uma (vêm no welcome): é a "próxima meta" do Início.
    let hunts = [];
    // Bônus de XP do jogo: { tr, pk, partes: [{ id, tr, pk, ate?, alvo? }] } (multiplicadores e quando acabam).
    let bonusXp = null;
    let sock = null;
    const ABAS = { meus: 1, historico: 1, historicoGlobal: 1 };
    // Respostas dos nossos pedidos de histórico levam este `seq`: o jogo descarta (não repinta a
    // tabela que a pessoa tiver aberta) e nós guardamos.
    const SEQ = 987654321;
    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      try {
        if (new URL(url, location.href).host === location.host) {
          sock = ws;
          ws.addEventListener('message', (e) => {
            const d = e.data;
            if (typeof d === 'string' && (d.indexOf('"oficiais"') >= 0 || d.indexOf('"bonusXp"') >= 0) && (d.indexOf('"welcome"') >= 0 || d.indexOf('"estado"') >= 0)) {
              try {
                const m = JSON.parse(d);
                const bx = m && m.estado && m.estado.bonusXp;
                if (bx && Array.isArray(bx.partes)) {
                  bonusXp = { at: Date.now(), tr: Number(bx.tr) || 1, pk: Number(bx.pk) || 1,
                    partes: bx.partes.map((x) => ({ id: String(x.id || ''), tr: Number(x.tr) || 1, ate: Number(x.ate) || 0, alvo: Number(x.alvo) || 0 })) };
                }
                if (m && m.t === 'welcome' && Array.isArray(m.hunts)) {
                  hunts = m.hunts.map((h) => ({ nome: String(h.nome || h.name || h.slug || ''), nivel: Number(h.nivel ?? h.level) || 0 }))
                    .filter((h) => h.nome && h.nivel > 0).sort((a, b) => a.nivel - b.nivel)
                    .filter((h, i, l) => i === 0 || l[i - 1].nivel !== h.nivel); // uma por nível basta
                }
                const est = m && m.estado;
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
            }
            if (typeof d !== 'string' || d.indexOf('"market"') < 0) return;
            try {
              const m = JSON.parse(d);
              if (!m || m.t !== 'market' || !ABAS[m.aba]) return;
              // Histórico com filtro ou outra página que a PESSOA pediu no jogo: não é o nosso.
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
      }),
    });
  },
});
