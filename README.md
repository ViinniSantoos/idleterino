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

### Estrutura

| Arquivo | O que faz |
|---|---|
| `main.js` | Janela, bandeja, atualização e regras de segurança |
| `platforms/twitch.js` e `platforms/kick.js` | Pontos, lives, baú e chat |
| `pokeidle.js` | Contas do jogo, modos, congelar e leitura |
| `extensions.js` | Extensões |
| `renderer/` | A tela |

Projeto independente, sem ligação com o PokeIdle, a Twitch ou a Kick. Licença MIT.
