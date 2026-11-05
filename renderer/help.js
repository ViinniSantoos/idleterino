// Idleterino — guia de ajuda: as dúvidas mais comuns, com busca. Cada item: [categoria, pergunta, passos/resposta].
// Linhas que começam com "1." viram passos numerados; o resto, parágrafos.
window.HELP = [
  ['Primeiros passos', 'Por onde eu começo?', [
    '1. Em Twitch e Kick, clique em "Entrar com…" e faça login na página oficial de cada uma.',
    '2. Em PokeIdle, clique em "＋ Adicionar conta", dê um nome e entre no jogo, como no navegador.',
    '3. No Início você vê tudo junto: lives, pontos, bônus ativos e as suas contas do jogo.',
    'Não usa a Kick ou a Twitch? Desligue em Ajustes: o que fica desligado não gasta memória.',
  ]],
  ['PokeIdle', 'Como adicionar uma conta do PokeIdle?', [
    '1. Vá em PokeIdle e clique em "＋ Adicionar conta".',
    '2. Dê um nome para reconhecer a conta (ex.: Principal, ALT 1). O endereço já vem como https://pokeidle.io/app.',
    '3. Clique em Adicionar e entre no jogo pela tela de login dele (Google, Discord ou e-mail e senha).',
    'Se a conta estiver aberta em outro lugar (navegador, IdleDeck), ela cai lá quando entrar aqui: o jogo deixa uma conexão por conta.',
  ]],
  ['PokeIdle', 'Quantas contas eu posso ter?', [
    'O PokeIdle permite até 4 contas por pessoa e identifica as contas pelo IP. As que passarem disso são removidas pelo jogo.',
    'Por isso o app trava em 4 contas do PokeIdle e nunca oferece forma de burlar essa regra.',
  ]],
  ['PokeIdle', 'Posso entrar com o Gmail (Google)?', [
    'Pode. Clique em "Login com Google" na tela do jogo e siga a página oficial do Google.',
    'Se aparecer "Não foi possível fazer o login", clique em ↻ (recarregar) na barra da conta e tente de novo. Persistindo, avise no Discord com um print.',
  ]],
  ['PokeIdle', 'Qual modo de tela eu escolho: Cena, Otimizado, Economia ou ULTRA?', [
    'São os mesmos modos do próprio jogo, e a escolha é sua, conta por conta, na barra em cima do jogo.',
    'Cena: o jogo completo, com a batalha. Otimizado: sem animações de golpe. Economia: sem a cena, só estatísticas.',
    'ULTRA (★ sugerido para as ALTs): só uma caixa com os números. Nos testes gastou ~30% menos memória e quase nada de CPU.',
    'Em Ajustes do PokeIdle dá para ligar o "ULTRA automático no fundo": as contas que você não está olhando passam para o ULTRA sozinhas.',
    'Em todos os modos a conta continua caçando e online.',
  ]],
  ['PokeIdle', 'O que é "Congelar"?', [
    'Congelar troca a tela da conta por uma foto e para de desenhar o jogo. A conta continua conectada e caçando.',
    'Clique na foto para voltar ao vivo. Ótimo para as ALTs: junto com o ULTRA, quase não gasta nada.',
    'Em Ajustes do PokeIdle você pode ligar "Congelar ALTs sozinho" depois de alguns minutos sem abrir a conta.',
  ]],
  ['Extensões', 'Como conectar uma extensão (sniper, /hunt…)?', [
    '1. Baixe a extensão do lugar oficial de quem fez. Ela vem como arquivo .zip, .crx ou como uma pasta.',
    '2. Vá em Extensões, no menu da esquerda.',
    '3. Arquivo .zip ou .crx: clique em "📦 Instalar .zip / .crx" e escolha o arquivo.',
    '4. Pasta: clique em "📁 Instalar pasta" e escolha a pasta que tem o arquivo manifest.json dentro.',
    '5. Pronto: a extensão aparece na lista, ligada. As contas do PokeIdle recarregam sozinhas para aplicar.',
    'Para desligar, use o botão ao lado da extensão. Para tirar de vez, clique em Remover.',
  ]],
  ['Extensões', 'Onde fica o painel da extensão (ex.: Cockpit do Rotom Sniper)?', [
    'No Chrome, o painel abre pelo ícone da extensão na barra do navegador. No Idleterino, ele fica na tela de cada conta do PokeIdle.',
    'Vá em PokeIdle, escolha a conta e clique no botão 🧩 com o nome da extensão, ao lado de Congelar.',
    'Cada conta tem o seu painel, com os dados e as regras daquela conta. Abra o painel da conta que você quer usar.',
    'Pegar a pasta de uma extensão que você já usa no Chrome ou no Edge: ela fica em AppData\\Local\\Google\\Chrome (ou Microsoft\\Edge)\\User Data\\Default\\Extensions\\<ID da extensão>\\<versão>. Copie essa pasta para outro lugar e instale com "📁 Instalar pasta".',
  ]],
  ['Extensões', 'Instalei e a extensão não funciona. E agora?', [
    'Confira se ela está ligada na lista e se aparece algum aviso embaixo do nome ("Não carregou: …").',
    'Clique em ↻ na conta do PokeIdle para recarregar o jogo.',
    'Algumas extensões usam recursos que só existem no Chrome e não funcionam em apps. As que mexem só na página do jogo costumam funcionar.',
  ]],
  ['Extensões', 'Extensão é segura?', [
    'Uma extensão roda dentro das suas contas do PokeIdle e consegue ver o que acontece nelas. Instale só de quem você confia.',
    'Elas nunca entram nas sessões da Twitch e da Kick. E as regras do jogo continuam valendo com extensão.',
  ]],
  ['Twitch e Kick', 'Como os pontos funcionam?', [
    'Cada live assistida rende 10 pontos a cada ~5 min (subs ganham mais). O app deixa 2 lives escondidas tocando em 160p, sem som.',
    'Com o "Foco em bônus" ligado, as lives vão para os canais mais perto do próximo bônus.',
    'Na Twitch, o baú de +50 é pego sozinho (dá para desligar em Ajustes da Twitch).',
  ]],
  ['Twitch e Kick', 'Como compro o bônus?', [
    'Abra o canal e clique em "Loja": abre a loja oficial do canal. A compra é sempre feita por você.',
    'Comprou pelo celular? Use o "+1h" em Bônus ativos para o cronômetro contar.',
    'Nas contas do PokeIdle, o tempo de bônus da Twitch e da Kick aparece direto do jogo, no cartão da conta.',
  ]],
  ['Desempenho', 'O app está pesando no meu PC. O que faço?', [
    '1. Coloque as ALTs em ULTRA (ou ligue o "ULTRA automático no fundo").',
    '2. Congele as contas que você não está olhando.',
    '3. Deixe "Lives ao mesmo tempo" em 2 e o "Modo leve (160p)" ligado.',
    '4. Desligue em Ajustes a plataforma que você não usa (Twitch ou Kick).',
  ]],
  ['Segurança', 'Minhas contas estão seguras?', [
    'Os logins ficam só no seu PC, criptografados pelo Windows. Não existe servidor do Idleterino e o app nunca lê nem guarda senhas.',
    'Cada conta tem a sua sessão separada. Baixe o app só pelo site oficial ou pelo GitHub e mantenha um antivírus ligado.',
    'Vai vender ou emprestar o PC? Em Ajustes, use "Apagar todos os logins deste PC".',
  ]],
  ['App', 'Como atualizo o Idleterino?', [
    'Instalado: a atualização chega sozinha. Para pegar na hora, clique com o botão direito no ícone perto do relógio > Sair, e abra de novo.',
    'Versão portátil e .deb (Linux): baixe de novo no site.',
  ]],
  ['App', 'Fechei a janela e o app continuou rodando?', [
    'Sim, de propósito: ele fica na bandeja, perto do relógio, juntando pontos e com as contas conectadas.',
    'Para sair de vez: botão direito no ícone > Sair, ou Ajustes > Sair do app.',
  ]],
];
