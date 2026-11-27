# Idleterino · Design (KV de cores)

Referência visual de tudo o que for feito no app daqui para frente.

- **`kv-cores.html` / `kv-cores.png`** — o KV: todas as cores, com nome, variável e hex, e exemplos de componentes.
- **`../renderer/tokens.css`** — a fonte única das cores no código. Toda cor nova vem de uma variável dali (nada de `#hex` solto nas telas).

## Identidade: "noite de batalha"
- **Fundo** azul-violeta bem escuro, em camadas (`--bg` → `--s1` → `--s2` → `--s3` → `--s4`). Cada camada é um passo mais clara. Nunca preto puro.
- **Vermelho Pokébola** (`--brand`) = ação principal (Comprar, Salvar, botão de destaque).
- **Violeta elétrico** (`--brand-2`) = seleção, foco, aba ativa, link.
- **Verde neon** (`--brand-3`) = "ao vivo", Kick.
- **Tipos Pokémon** com as cores clássicas da franquia (`--t-fire`, `--t-water`…): o fã reconhece sem ler.

## Regras de uso
1. **Estado sempre com ícone ou palavra**, nunca só a cor: ✅ ok, ⚠ atenção, ⛔ não, ℹ informação (`--ok`, `--warn`, `--bad`, `--info`, e o fundo `-bg` de cada um).
2. **Moedas**: 💎 gema em `--gema` (rosa), 🪙 coin em `--coin` (dourado). O preço é sempre o número maior da linha.
3. **IV**: `--iv-alto` (25+), `--iv-medio` (15–24), `--iv-baixo` (abaixo de 15).
4. **Tier** S/A/B/C/D: `--tier-s` … `--tier-d`. **Raridade** do jogo: `--rar-*`.
5. **Hierarquia de texto**: o valor em `--text`, a explicação em `--muted`, a dica em `--dim`.
6. **Bate o olho**: o número importante é grande (`--fs-num`); o porquê fica pequeno embaixo ou abre ao clicar.
7. **Retrato do pokémon**: a pose de frente do próprio jogo, recortada e centralizada, num círculo com a cor do tipo (mais forte embaixo, como uma plataforma). Nunca letra no lugar do pokémon quando a imagem existir.
8. **Leve em 1º lugar**: CSS e canvas, sem biblioteca pesada; imagens em cache.

## Forma
- Cantos: `--r-s` 8px (chip), `--r` 14px (card), `--r-l` 18px (painel), `--r-pill` (etiqueta).
- Sombra: `--shadow` (painel), `--shadow-s` (card), `--glow-brand` (botão principal).
- Fonte: `--font` (Segoe UI do Windows; números com `font-variant-numeric: tabular-nums` em tabelas).
