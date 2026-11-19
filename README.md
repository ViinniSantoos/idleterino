# Idleterino

App para Windows e Linux que junta as contas do PokeIdle, os pontos da Twitch e os da Kick num só lugar. É leve, organizado e cada opção é escolha do usuário.

**Download:** https://viinnisantoos.github.io/idleterino/

## Recursos

### PokeIdle
- **Contas:** até 4 contas, a regra do jogo. Cada uma tem o login separado e entra com Google, Discord ou e-mail e senha.
- **Modo por conta:** Cena, Otimizado, Economia ou ULTRA, os mesmos modos do jogo. O ULTRA vem sugerido para as ALTs.
- **Congelar:** a conta vira uma foto e continua caçando. Também dá para congelar as ALTs sozinho.
- **Leitura do jogo:** nível, XP/h e o tempo do Bônus Twitch e do Bônus na Kick, direto do jogo.

### Twitch e Kick
- **Lives em segundo plano:** em 160p, com foco no próximo bônus e prioridade para subs.
- **Twitch:** preço real dos bônus de cada canal, pacotes de 1 h a 10 h e baú de +50 pego sozinho.

### No app todo
- **Extensões:** instale a partir de uma pasta, de um .zip ou de um .crx. Elas valem só nas contas do PokeIdle.
- **Ajuda:** guia dentro do app, com busca.

## Segurança

- O login é sempre feito nas páginas oficiais. O app nunca lê nem guarda senhas.
- Não existe servidor. Os logins ficam só no PC, criptografados pelo sistema.
- Cada conta tem a sua sessão separada.
- O app confere a integridade do próprio pacote, bloqueia downloads de programas e mantém as ferramentas de desenvolvedor fechadas na versão instalada.

## Desenvolvimento

```bash
npm ci
npm start
npm run dist
npm run dist:linux
```

- `npm start` roda o app.
- `npm run dist` gera o instalador e a versão portátil em `dist/`.
- `npm run dist:linux` gera o AppImage e o .deb. Rode no Linux ou no WSL.

### Compilar do código (Mac, Linux) com o Trader Premium

O código do Trader não fica no repositório: ele vai **criptografado** no arquivo `trader-codigo.idlcode`, que só abre com uma licença válida (teste grátis, mensal ou vitalício, na aba 📈 Trader do app).

1. Use o código da mesma versão do release (ex.: `git checkout v0.3.35`).
2. Baixe o `trader-codigo.idlcode` **desse release** no GitHub e coloque na raiz do projeto, do lado do `package.json`.
3. Gere o app (ex.: `npx electron-builder --mac`).

Sem o arquivo, o app funciona normalmente, só que sem o Trader.

### Estrutura

| Arquivo | O que faz |
|---|---|
| `main.js` | Janela, bandeja, atualização e regras de segurança |
| `platforms/twitch.js` e `platforms/kick.js` | Pontos, lives, baú e chat |
| `pokeidle.js` | Contas do jogo, modos, congelar e leitura |
| `extensions.js` | Extensões |
| `renderer/` | A tela |

Projeto independente, sem ligação com o PokeIdle, a Twitch ou a Kick. Licença MIT.
