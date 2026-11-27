# Idleterino · Varredura de UX (27/11/2026)

Objetivo: **bater o olho e entender**. O número que importa é grande, o porquê fica pequeno ou abre ao clicar, e todo pokémon aparece com a imagem do jogo. Cores só pelo KV (`renderer/tokens.css`).

## Engine
Continua **Electron + HTML/CSS/JS puro**. Trocar para React/Vue deixaria o app mais pesado e mais lento para abrir, e a regra nº 1 do Idleterino é ser **leve**. O "motor novo" é o design system: tokens (KV), componentes (retrato, card, chip, medidor) e CSS moderno (`color-mix`, gradientes, grid). Dá o visual de app moderno sem custo de memória.

## Feito (fase 1)
- **KV de cores** (`design/kv-cores.html` + `.png`) e `renderer/tokens.css` como fonte única das cores.
- **Retrato do pokémon** (`renderer/retrato.js` + núcleo `retratos`): a pose de frente do jogo, recortada e centralizada, num círculo na cor do tipo. Em cache, pedido em lote.
- **PvP · Planejador**: tabuleiro "arena" com o pokémon em cada casa (anel vermelho = adversário, violeta = você), nome por baixo, papel no canto; listas com retrato; outro jogador, x1, copiar texto e print.

## Próximas fases (por tela)
| Tela | Hoje | Melhoria |
|---|---|---|
| **Início** | muitos cards de texto do mesmo tamanho | 1 faixa "agora" (conta, hunt, XP/h, shiny) com números grandes; lembretes como chips; o resto recolhido |
| **PvP · Meta** | listas de nomes | arquétipos como "comps" do TFT: os 5 retratos em fila, tier grande à esquerda, % de uso/vitória à direita |
| **PvP · Tier list** | linhas de texto | grade S/A/B/C/D com retratos (como as tier lists de TFT) |
| **PvP · Meu time** | cards de texto | cards com retrato, medidor de força e o "forte contra / cuidado com" em chips |
| **PvP · Minhas partidas** | tabela | cada partida com os 2 times em retratos e o resultado em destaque |
| **PvE** (melhor hunt, evoluir, Prey, Casas, Boss) | texto e tabelas | retrato do pokémon em campo; hunts como cards com XP/h grande; evolução como "linha do tempo" de retratos |
| **Trader** | texto longo por pechincha | o card das propostas (`divulgacao/idleterino/mockups-trader`): retrato, preço × justo, medidor, IVs à vista, ⤢ Expandir |
| **Twitch / Kick** | listas | só as cores do KV e chips de estado |
| **Ajustes / Ajuda** | longos | seções com ícone e busca |

Ordem sugerida: **Trader (pechinchas)** → **PvP Meta + Tier list** → **Início** → **PvE** → resto.
