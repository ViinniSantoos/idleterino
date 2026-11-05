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
      }),
    });
  },
});
