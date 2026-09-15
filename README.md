# Indicadores Sebratel — construtor de dashboards com IA

Ferramenta interna onde a **própria área monta as telas**: escolhe a fonte, o
tipo de gráfico, os campos, os filtros e a formatação — ou descreve em português
o que precisa ver, e a IA propõe os widgets para aprovação. **React 18 + Vite +
Recharts** no front, **Express rodado por tsx** no servidor, sem banco de dados.

O assunto não é um relatório específico. É a **dependência de desenvolvedor**:
antes, cada indicador novo era uma página programada no código, e mudar a cor de
uma barra passava por um deploy. Aqui a tela é um documento editável, com
permissão por pasta, dashboard e guia.

> **Este repositório versiona `data/` e `public/installData.data`** — decisão
> explícita registrada em [.gitignore](.gitignore), ciente de que põe segredo e
> dado real da empresa no histórico. Isso inclui `data/.secret-key` (a chave
> AES que decifra os tokens do Data Hub e as sessões de login),
> `data/sessions.json` e o log de auditoria. As duas únicas exceções são
> `data/aiConfig.json` — a chave de API cifrada mais a chave que a decifra no
> mesmo repositório equivalem a publicar a credencial em claro — e o cache de
> certificados públicos do Google.
>
> `node_modules/` também é versionado, e isso tem consequência de projeto: cada
> dependência nova entra como milhares de arquivos no histórico. É o argumento
> que manteve `firebase-admin`, o SDK da OpenAI e o do Gemini fora do projeto.

O conteúdo tem três níveis, cada um com o seu próprio controle de acesso:

| Nível | O que é | Quem cria |
|---|---|---|
| **Pasta** | o setor (Comercial, Instalação, Financeiro), no menu lateral | só administrador |
| **Dashboard** | uma tela dentro da pasta | administrador ou gerente da pasta |
| **Guia** | uma aba dentro da dashboard — **é onde os widgets de fato vivem** | administrador ou gerente da pasta |

Guia é o que o código chama de `tab` e o botão do modo edição ainda chama de
**Abas**. São a mesma coisa.

São cinco rotas, e só cinco ([src/router/index.tsx](src/router/index.tsx)):

| Rota | O que é |
|---|---|
| `/login` | entrada por conta Google corporativa |
| `/` | **não é uma página** — redireciona para a primeira dashboard que a pessoa pode ver |
| `/dashboard/:folderId/:dashboardId` | a tela de verdade: o Builder |
| `/configuracoes` | fontes de dados, dicionário de campos e provedor de IA |
| `/acessos` | usuários, papéis e log de ações (só admin) |

Não existe home genérica num app cuja tela é sempre "uma dashboard de alguém".
Sem nenhuma pasta liberada, `/` mostra *"Nenhuma dashboard disponível ainda —
peça acesso a um administrador."* em vez de navegar para algo que não existe.

---

## Como rodar

```bash
npm install
```

Copie [.env.example](.env.example) para `.env` e preencha. O arquivo é comentado
variável por variável, com o motivo de cada uma — é a fonte da verdade, não a
tabela da seção 2.5 do [DOCUMENTACAO.md](DOCUMENTACAO.md), que ficou defasada na
migração para Firebase e ainda lista `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`
como obrigatórias. Ninguém mais lê essas duas.

Desenvolvimento precisa de **dois processos**:

```bash
npm run dev     # Vite na 5173, com proxy de /api
npm run api     # Express na 8788
```

E, na primeira vez, de um terceiro passo que quase todo mundo esquece:

```bash
npm run fetch:install   # materializa o snapshot em public/installData.data
```

**O ciclo automático de ETL não faz parte do `npm run dev`.** Sem rodar
`fetch:install` ao menos uma vez, a tela abre normalmente e o Builder não mostra
dado nenhum — `/api/widget-data` responde 503 *"Base ainda não materializada no
backend."*. Não é bug. Quem quiser o ciclo automático localmente chama
`node scripts/etl-scheduler.mjs` na mão; não existe `npm run etl`.

Três armadilhas de ambiente, todas já vividas aqui:

- **`npm run api` não observa o `.env`.** O `tsx watch` recarrega ao salvar
  qualquer arquivo de `server/` ou `scripts/`, mas o `.env` não está no grafo de
  módulos e `--include` não resolve o caso. Depois de editar, reinicie na mão —
  está escrito dentro do próprio [package.json](package.json), na chave `"//api"`.
- **O Vite também lê o `.env`** ([vite.config.ts](vite.config.ts) usa `loadEnv`
  com prefixo vazio) para montar o alvo do proxy. Trocar `API_PORT` exige
  reiniciar os **dois** processos; reiniciar só a API deixa o proxy apontando
  para a porta velha.
- **Faltar `FIREBASE_PROJECT_ID` não impede a API de subir.** Ela sobe, e só o
  login devolve 503 dizendo exatamente o que falta. É fácil confundir com
  problema de rede.

A única validação que **derruba** a API na subida é `AUTH_DISABLED=true` com um
`AUTH_DISABLED_EMAIL` fora do `ALLOWED_DOMAIN` — e isso é deliberado, pelo motivo
que a seção de login explica.

O backend é `.mjs` puro rodado direto por `tsx`, sem etapa de build no servidor;
o `tsc` do `npm run build` checa só o TypeScript do front. Ele precisa de `tsx`
(e não `node` puro) porque [server/workspace.mjs](server/workspace.mjs) importa
`createWelcomeTab` de um arquivo `.ts` do front — por isso a imagem da API copia
`src/` também. `src` não é sobra.

---

## De onde vem o dado

Por dois caminhos, e só dois:

| Fonte | Chave | Como é buscada | Teto |
|---|---|---|---|
| Dataset do **Data Hub** (lakehouse) | `dhub:<id>` | ETL em segundo plano, paginado | 500.000 linhas |
| **Planilha do Google** | `sheet:<id>` | dentro da requisição, com o token de quem está logado | 20.000 linhas |

**O app não fala com banco de dados.** Não tem driver, não tem credencial, não
tem caminho de código. Havia antes um catálogo de queries SQL que batia direto no
Postgres do ERP e no MariaDB; manter os dois caminhos consumia duas plataformas
grandes pela mesma informação, e o lakehouse existe justamente para ser o
barramento. Dado novo no dashboard se resolve publicando o dataset no Data Hub.

O ETL ([scripts/fetch-install.mjs](scripts/fetch-install.mjs)) lê o catálogo,
decifra o token de cada fonte, pagina a API pública do Data Hub e grava **tudo
num arquivo único gzip**, `public/installData.data` — o snapshot. A API carrega
esse arquivo inteiro em memória e o recarrega sozinha quando o `mtime` muda, sem
precisar de restart ([server/dataset.mjs](server/dataset.mjs)).

### O fim da paginação vem do `total`, nunca do tamanho da página

O Data Hub capa em 10 mil linhas por requisição **mas ecoa no corpo o `limit` que
você pediu, não o que aplicou** — `limit=20000` e `limit=60000` devolvem 10.000
linhas as duas. Com página de 50 mil e um laço que tratava "página menor que o
pedido" como fim dos dados, **todo dataset grande vinha cortado em 10 mil
linhas**, e o log dizia `10000 linhas de 177505` sem que ninguém reparasse. A
sonda anterior tinha passado por sorte, porque usava páginas de mil.

Hoje `DHUB_PAGE_SIZE` é 10.000 — o teto real, pedir mais só gasta round-trip — e
o fim é decidido pelo `total` que a própria API informa. Há ainda uma trava fixa
de 200 páginas em [server/lakehouseSources.mjs](server/lakehouseSources.mjs),
para o laço terminar mesmo se a API responder de um jeito inesperado.

### Frequência

| Parâmetro | Padrão | O que é |
|---|---|---|
| `ETL_BASE_INTERVAL_MINUTES` | **2 min** | o ciclo BASE do agendador — não o ritmo de cada fonte |
| modo da fonte | `scheduled`, 60 min | configurado por fonte na tela: tempo real ou agendada |
| cache de planilha | 5 min | planilha é dado mantido à mão; não pede agressividade de fonte SQL |

Ciclo curto é o que faz "tempo real" significar algo. Quem decide se uma fonte
roda é a própria fonte: `realtime` vence sempre, `scheduled` só quando o
intervalo já passou. Fonte nova nasce agendada a cada 60 minutos porque dataset
de lakehouse costuma ser materializado de tempo em tempo — buscar a cada 2
minutos não traria dado novo.

O ETL busca as fontes **uma de cada vez**, nunca com `Promise.all`: são datasets
de tamanho desconhecido, e empilhar N buscas grandes contra o Data Hub ao mesmo
tempo é como se perde o ciclo inteiro. Uma fonte que falha **mantém o último dado
bom** e não grava `lastRunAt` — assim é tentada de novo no ciclo seguinte em vez
de esperar o intervalo inteiro, e o erro fica registrado para aparecer na tela.

### Os segredos em disco são cifrados, e a chave é uma só

Token do Data Hub, `access_token` do Google guardado na sessão e credencial de IA
passam todos por [server/secretBox.mjs](server/secretBox.mjs): **AES-256-GCM**,
IV de 12 bytes por segredo, formato `v1:<iv>:<tag>:<cifra>`. GCM não só cifra:
autentica — uma alteração no arquivo vira erro na decifra, em vez de devolver
lixo silenciosamente.

A chave vem de `SECRETS_KEY` ou, faltando ela, de 32 bytes aleatórios gerados em
`data/.secret-key` na primeira subida. A gravação usa flag `wx` e relê o arquivo
se falhar, porque `api` e `etl` podem subir ao mesmo tempo e tentar gerar a chave
juntos.

**Trocar `SECRETS_KEY` desloga todo mundo** (as sessões salvas viram ilegíveis e
são tratadas como expiradas, não como erro), invalida os tokens do Data Hub já
cadastrados — que precisam ser recadastrados na tela — e torna a credencial de IA
ilegível. E ela precisa ser **idêntica** nos serviços `api` e `etl`, senão um não
decifra o que o outro cifrou.

O token do Data Hub vai no header `X-Api-Token`, **nunca na query string**, para
não cair no log de acesso do lakehouse nem em proxy no caminho. Ele nunca volta
ao navegador: a tela recebe só uma dica (`dhub_…6T97`, os 5 primeiros e os 4
últimos caracteres). Por consequência, editar uma fonte com o campo de token
vazio mantém o token salvo — a UI não teria como reenviar algo que nunca recebeu.

Criar ou editar uma fonte **revalida contra o Data Hub antes de persistir**: se o
token não abrir o dataset, nada é salvo e o erro real do Data Hub aparece na tela
("token revogado", "dataset não existe"), em vez de gravar um cadastro quebrado
que só falharia no ciclo seguinte do ETL.

E a mensagem distingue **quem** recusou. A API pública do lakehouse sempre
responde `{ error: "…" }`; se o corpo não é JSON, quem respondeu não foi o Data
Hub, e sim algo no caminho — proxy da empresa, firewall, um nginx errado. O app
engolia exatamente essa pista e mandava investigar um token que podia estar
perfeito. Hoje, com JSON, mostra a frase do Data Hub mais o status e a origem;
sem JSON, aponta o proxy como suspeito e mostra o começo da resposta crua.

### Não existe esquema fixo

Cada fonte traz as colunas que o dataset tem, e o tipo de cada uma é **inferido
de uma amostra de 300 linhas reais**: número, data (só ISO `AAAA-MM-DD`) ou
dimensão, que é o neutro. Coluna nova no dataset aparece sozinha no Builder, sem
configuração manual.

A inferência tem dois pontos cegos conhecidos, e os dois têm a mesma saída:

- uma data gravada como `16/07/2026` cai como texto comum — sem eixo de tempo,
  sem filtro de período;
- um código numérico de identificação (`ID`, `CODIGO`) vira "número", como se
  fizesse sentido tirar a média dele.

A correção é o **Dicionário & Tipo de dado**, em Configurações, onde um admin
sobrescreve o tipo campo a campo. A sobrescrita é aplicada num único ponto
(`listSourceDefs` em [server/widgetQuery.mjs](server/widgetQuery.mjs)), então
propaga sozinha para o Builder inteiro e para a IA.

---

## O construtor

O editor produz um `WidgetConfig` — uma estrutura **declarativa**, a mesma que a
IA emite — salvo dentro da árvore Pasta → Dashboard → Guia e executado por um
motor de agregação genérico no servidor. São **15 tipos de widget**
([src/features/builder/types.ts](src/features/builder/types.ts)):

| Grupo | Tipos |
|---|---|
| Número | Card (KPI) |
| Barras | Barras (v), Barras (h), Empilhadas (v), Empilhadas (h), Colunas + linha |
| Série | Linha, Área |
| Distribuição | Pizza, Funil, Dispersão, Histograma |
| Tabular | Tabela, Matriz |
| Texto | Texto (o que a IA usa para escrever uma leitura) |

Cada tipo só oferece os recursos que usa: séries múltiplas existem em 7 tipos,
legenda em 6, formatação condicional em 8. Um controle que não faz nada engana
quem clica.

Agregações são **quatro** — Contagem distinta, Contagem, Soma e Média — e a
semântica de cada uma está fixada em `makeAggregator`: `count` sem campo conta
todas as linhas, com campo conta só as não-nulas; `sum` e `avg` falham com erro
explícito se não houver campo.

> **Contagem distinta sem campo escolhido não conta o que parece.** O motor
> procura uma chave primária da fonte (`sourceDef.fields.find(f => f.pk)`), e
> **`pk` nunca é atribuído em lugar nenhum** — nem a inferência define, nem o
> dicionário. O valor é sempre `null`, e a agregação cai no fallback
> `JSON.stringify(r)`: conta **linhas inteiras distintas**, não protocolos
> únicos. `FieldDef.pk` é um contrato sem implementação. Escolha sempre o campo.

### Medidas nomeadas

Vivem na **dashboard**, não na guia nem no widget, e têm duas formas:

| Forma | O que é |
|---|---|
| `simple` | agregação sobre um campo, com **janela de data relativa** e **filtro fixo próprio** |
| `formula` | combina **outras medidas** por nome — nunca um campo cru |

O filtro embutido na própria medida é o que permite montar "% de reincidência"
sem sujar o filtro da guia. E uma fórmula operar sempre sobre medidas, nunca
sobre linhas, é o mesmo espírito do DAX: como toda medida já vira um número
escalar antes de entrar na conta, **combinar fontes diferentes nunca precisa de
JOIN nem de relacionamento declarado**.

A janela de data tem 7 formas, e `shiftYears` envolve qualquer uma delas — é
assim que "mesmo período do ano passado" existe sem um caso fixo por período.
**Toda janela termina hoje**, nunca no fim teórico do período, porque não existe
dado além de hoje mesmo; é por isso que `yearToDate` e `currentYear` calculam
exatamente a mesma coisa e são mantidos como dois nomes só pela naturalidade da
frase. A aritmética é toda em UTC, e `addMonthsUTC` encolhe para o último dia do
mês de destino quando o dia não existe lá — 31/mar menos um mês é 28 ou 29 de
fevereiro, nunca "3 de março", que é o que o rollover automático do JS faria.

O motor de expressão ([server/measureExpr.mjs](server/measureExpr.mjs)) é um
parser recursivo-descendente próprio, com teto de 500 caracteres e 32 níveis de
profundidade. **Nunca chega perto de `eval`, `Function` ou `vm`**: a string é
tokenizada, vira AST e é percorrida com um `switch`. Não é sandbox — é
estruturalmente impossível virar código JS a partir do texto, o que importa
porque **a string pode ter vindo da IA**. Divisão e módulo por zero devolvem
`NaN` explicitamente, nunca `Infinity`: um resultado indeterminado tem de se
comportar sempre da mesma forma, e nunca `0`, que pareceria um resultado real.

A detecção de ciclo usa **quem está na pilha agora**, não "já visitado alguma
vez". A diferença não é sutil: "já visitado" quebraria o losango legítimo de duas
medidas-irmãs — "período atual" e "período anterior" — dependerem da mesma
medida-base. Isso não é ciclo, é uma árvore com nó repetido.

### Relacionamentos entre fontes

Declarados **por guia**, e fazem duas coisas ao mesmo tempo: propagam o filtro
entre fontes e liberam todos os campos da fonte relacionada em qualquer widget da
outra, como se fossem nativos.

O filtro cruzado é um **semi-join de verdade**: filtra a fonte do filtro pelos
valores escolhidos e extrai o conjunto de **chaves reais** do campo da relação —
nunca reaplica o texto exibido. É o que faz "Base SP", grafado diferente em cada
sistema de origem, continuar funcionando; permite filtrar por *Nome da base* e
relacionar por *Base de Origem*.

Duas limitações declaradas:

- **Relação não encadeia.** Se A se relaciona com B e B com C, um widget de A não
  enxerga campo de C. Cobre bem o padrão comum (uma dimensão compartilhada por
  várias fontes-fato); um encadeamento fato→dimensão→outro fato não é suportado.
- **Só a primeira relação que casa um par de fontes tem efeito** no servidor. Uma
  segunda entre as mesmas duas fontes ficaria permanentemente inerte, e por isso
  o formulário bloqueia o par duplicado por completo.

Relação apontando para fonte removida aparece em âmbar na lista. **Relação
faltando não avisa nada** — o widget simplesmente não reage ao filtro.

### A grade tem 24 colunas porque o piso é 1 unidade

O piso de redimensionar de qualquer widget cai sempre em uma unidade da grade.
Dobrar a resolução de 12/56px para **24 colunas / 22px** foi a única forma de dar
ao Card e ao Texto um piso genuinamente menor — são os únicos sem eixo, legenda
ou cabeçalho, e cabem bem menores. Os outros 13 tipos mantêm piso de 2 unidades
para não ficarem ilegíveis.

`ROW_HEIGHT` é 22 e não 56/2 = 28 porque a margem de 12px entre linhas soma
dentro da altura total: **22 = (56 − 12) / 2** é o valor exato que preserva o
tamanho visual de todo widget já salvo. A migração roda uma única vez, controlada
pela versão do arquivo — decidir pelo conteúdo aqui não é seguro, porque dobrar
de novo corromperia o layout em silêncio.

**Sobrepor widgets é permitido de propósito.** Por padrão o `react-grid-layout`
empurra o vizinho para baixo ao colidir; um compactor customizado desliga isso,
para quem monta decidir se quer empilhar ou não.

### Formatação

Dois motores separados, porque são duas perguntas diferentes: o **numérico**
compara um valor agregado contra um limiar (barra, KPI, célula de matriz); o da
**Tabela** compara o texto de uma célula contra uma palavra, pensado para coluna
de categoria — "Concluído"/"Pendente". A comparação de texto é sempre sem
diferenciar maiúsculas e com espaço nas pontas ignorado, pelo problema mais
banal do mundo: `Concluido`, `CONCLUIDO` e `concluído` convivendo no dado de
origem. Em ambos, as regras são avaliadas em ordem e **a última que bater vence**.

São **10 temas prontos**, cada um com paleta de 8 cores. Só dois deles — Oceano e
Alto contraste — definem fundo de card próprio e, por consequência, cor de texto.
Os outros oito deixam `textColor` ausente de propósito: eles continuam sobre o
fundo padrão do card, que já é claro ou escuro conforme o tema do app, e uma cor
de texto fixa ficaria ilegível toda vez que o app estivesse no modo contrário.

Não existe campo salvo "tema atual da guia" — as cores são gravadas direto em
cada widget e o tema é **inferido** comparando a paleta. Assim cada widget
continua editável individualmente depois de aplicar um tema: mudar a cor de um
não é desfeito, só fica fora do tema a partir dali. O preço é que **aplicar um
tema sobrescreve as cores de todos os widgets da guia de uma vez**.

### Tudo é rascunho até o Salvar

O Builder mantém o rascunho e o último estado salvo, e `dirty` é literalmente a
comparação dos dois. Nada vai ao servidor antes do clique. Isso não é zelo
gratuito: o que se salva **passa a valer para todo mundo com acesso àquela
guia** — é um painel de equipe, não um documento pessoal. Vale inclusive para o
que a IA propõe.

Duas coisas deliberadamente **não** são rascunho, porque são de quem está
olhando, não da dashboard: os filtros ativos escolhidos na barra e a ordenação
por clique no cabeçalho de Tabela/Matriz. Cada pessoa ordena do próprio jeito
sem afetar ninguém — e sem precisar de permissão de edição.

---

## Montagem com IA

Três provedores atrás de um adaptador único
([server/aiProvider.mjs](server/aiProvider.mjs)):

| Provedor | Como é chamado | Esforço | Cache de prompt |
|---|---|---|---|
| **Anthropic** | SDK oficial, repasse puro | sim | sim |
| **OpenAI** | `fetch` REST, `Bearer` | ignorado | não |
| **Google Gemini** | `fetch` REST, `x-goog-api-key` | ignorado | não |

O formato canônico interno é o da Anthropic, e a tradução acontece **só na
borda**. Não é preferência: é o formato que o histórico em memória já guardava, é
o mais rico dos três e é o único com cache de prompt explícito — traduzir só na
borda manteve o caminho em produção idêntico ao que já funcionava. Não há SDK
novo para os outros dois porque as duas APIs são REST simples e um leitor de SSE
de vinte linhas é menos superfície que uma dependência nova neste repositório.

A chave do Gemini vai em cabeçalho, nunca na query string, pelo mesmo motivo do
token do Data Hub: URL é onde credencial costuma ir parar em log de proxy.

### A configuração saiu do `.env` de vez

Desde **10/09/2026**, nenhuma variável de ambiente de IA é lida. Provedor,
credencial, modelo, esforço, teto de tokens, idas por turno, orçamento diário,
preço e endpoint vivem em `data/aiConfig.json` e são editados em **Configurações
› Provedor de IA**, só para admin.

A causa foi técnica: [server/aiAssistant.mjs](server/aiAssistant.mjs) lia tudo em
constante de módulo, no import. Trocar de modelo exigia reiniciar a API — no
Portainer, um redeploy da stack — **e quem administra a ferramenta não tem acesso
ao `.env` do container**. Hoje a configuração é lida a cada uso.

Houve uma fase em que o `.env` valia como semente, para não quebrar a instalação
existente. Foi removida no mesmo dia: semente é uma segunda fonte de verdade para
a mesma decisão — dois lugares onde procurar "qual modelo está rodando", e um
deles mentindo assim que alguém salva pela tela. **Consequência aceita:
instalação nova sobe com a IA não configurada**, o que é explícito e visível, ao
contrário de uma chave herdada de um arquivo que ninguém lembra de ter
preenchido.

As duas únicas variáveis de IA que sobraram são da **leitura de gráfico**, não da
montagem, porque nunca tiveram tela: `AI_INSIGHT_EFFORT` (padrão `medium`) e
`AI_INSIGHT_MAX_TOKENS` (padrão 1200). Nenhuma das duas está no
[docker-compose.yml](docker-compose.yml) — em produção rodam sempre no padrão.

Padrões de fábrica: esforço `high`, teto de 16.000 tokens, 14 idas por turno,
orçamento de US$ 5 por usuário por dia. O campo **modelo nasce vazio, inclusive
para a Anthropic**: um modelo pré-escolhido junto com nenhuma credencial produz
uma tela que parece configurada e não é.

A lista de modelos é perguntada **ao próprio provedor**, com a credencial
informada. Catálogo de modelo muda toda hora, e uma lista fixa no código envelhece
em silêncio — some um modelo que ainda existe, ou oferece um que a conta não tem
acesso.

### O que a IA faz, e as travas

Ela **nunca gera código nem SQL**. Emite um `WidgetConfig` — a mesma estrutura
declarativa que o editor manual produz — e o motor de agregação que já existe
renderiza. Isso é o que torna a feature segura e barata: nada é executado, o
resultado é determinístico e o **dado bruto nunca sobe ao modelo**.

O que sobe é só o catálogo de campos: nome, tipo, a descrição do dicionário, até
6 valores de exemplo por campo de texto e a marca de "muitos valores distintos —
identificador". Sem RAG, sem índice vetorial, sem embedding: o catálogo cabe
inteiro no prompt, então o índice simplesmente não existe. Para escrever uma
leitura, o modelo vê o resultado **já agregado** que o gráfico desenha.

| Trava | O que impede |
|---|---|
| validação contra o catálogo real | campo ou fonte inexistente volta como erro e o modelo corrige na mesma conversa, em vez de gravar lixo |
| posição x/y fora do schema | o cliente calcula com `findFreeSpot` ao aprovar — o modelo nunca sobrepõe o que já existe |
| nada é gravado sozinho | a proposta vira rascunho só depois de "Adicionar à guia", e ainda depende do "Salvar" |
| fontes da conversa | `field_values` só alcança as fontes que a pessoa selecionou; turno de conversa de outro e-mail é recusado |

Nada aplicado sozinho é deliberado: **o modelo pode interpretar mal um pedido
ambíguo**.

O "Como foi calculado" de um widget **não passa pela IA** — sai do próprio
`WidgetConfig` no navegador. Pagar o modelo para narrar algo que sabemos com
exatidão só criaria uma explicação plausível onde havia uma correta. E a leitura
de gráfico é sempre sob demanda, um clique: um gráfico não pode gerar custo só
por estar na dashboard.

### O medidor de gasto, e quando ele mente

O custo sai do `usage` normalizado pelo adaptador vezes o preço da configuração.
**Preço é editável na tela, e modelo desconhecido entra com preço zero** — um
valor plausível e errado somando dinheiro que ninguém gastou é pior que um zero
explícito. O painel marca isso com um asterisco vermelho.

Três coisas a saber sobre o teto:

- é **por usuário e por dia**, e vive em memória: reiniciar a API zera o gasto
  acumulado do dia de todo mundo;
- é **compartilhado** entre montar widget e ler gráfico — não há dois contadores;
- **modelo sem preço cadastrado não segura nada**, porque o acumulado fica em
  zero. O asterisco é o único sinal.

A virada do dia depende do fuso do container, e é por isso que `TZ` está fixado
em `America/Sao_Paulo` no [Dockerfile.api](Dockerfile.api) e repetido nos três
serviços do compose. Sem ele o container roda em UTC e três coisas passam a
mentir por três horas: o carimbo do log de auditoria, o "visto por último" da aba
Acessos e a virada do teto de gasto.

---

## Login e controle de acesso

Conta Google corporativa via **Firebase Authentication**, com o SDK vindo do
bundle npm — nunca de `<script src>`. O Google Identity Services baixa o SDK de
`accounts.google.com` **antes de qualquer clique**, então um bloqueio de rede
derruba o login antes que a tela reaja, e a mensagem de erro não ajuda porque ela
precisa exatamente do domínio bloqueado.

O navegador pega o ID token e o manda **uma vez** para `POST /api/auth/session`.
O servidor confere a assinatura **localmente**, com a chave pública do Google em
cache ([server/firebaseToken.mjs](server/firebaseToken.mjs), ~80 linhas de
`node:crypto`, sem `firebase-admin`). Depois da primeira busca dos certificados,
validar login **não toca na rede** — é isso que faz um bloqueio de saída não
derrubar quem já tem token.

O que é conferido em todo token, e por quê:

| Checagem | Se faltasse |
|---|---|
| `alg === 'RS256'` (constante, não a do cabeçalho) | ataque `alg: none`, e a variante HS256 que usa a chave **pública** como segredo |
| `iss === securetoken.google.com/<projeto>` | token de qualquer outro projeto Firebase do mundo entraria |
| `aud === <projeto>` | idem — e criar um projeto Firebase é de graça |
| `exp` no futuro, **sem tolerância** | token vencido entraria |
| `iat` com 5 min de folga | token forjado com relógio adiantado |
| `sub` presente | token sem dono não serve |
| `kid` conhecido + assinatura RSA-SHA256 | qualquer um assinaria o próprio token |

Duas checagens ficam **fora** do verificador, de propósito: `email_verified` é
barrado na rota de login (403), e o **domínio é revalidado a cada requisição**,
não só no login — se o domínio permitido mudar, as sessões já abertas de fora
dele param na hora.

O cache dos certificados fica em memória **e em disco**, no volume. Sem a cópia
em disco, um restart durante um bloqueio deixaria a API sem validar nada —
exatamente o cenário que este desenho existe para evitar. TTL suave de 6 horas,
duro de 30 dias, e **uma renovação que falha não invalida o cache que já existe**:
é essa regra que impede uma oscilação de rede de virar "ninguém mais entra".

### A sessão é do servidor, e é ela que sustenta a navegação

O ID token vale 1 hora e prova a identidade só no momento de entrar. Quem
sustenta a navegação é uma sessão de servidor em `data/sessions.json`,
referenciada por um cookie **HttpOnly opaco** de 30 dias. Guardar no servidor, e
não emitir um JWT próprio, dá duas coisas que um JWT não daria: um **logout de
verdade** invalida a sessão, e o `access_token` do Google usado para ler planilha
fica ali — cifrado — em vez de no navegador.

O cookie é `SameSite=Lax` e não `Strict`: com `Strict`, abrir um link da dashboard
vindo do Slack ou do e-mail não enviaria o cookie na primeira navegação, e a
pessoa cairia no login com sessão válida. E `Secure` só é marcado quando a
requisição chega por https — num servidor interno em http puro, marcar sempre
faria o navegador **descartar o cookie em silêncio** e o login nunca completaria.

### Três camadas de permissão, e o papel vem do servidor

Papéis globais são exatamente dois, `admin` e `standard`. **O papel não vem do
token** — o ID token diz o e-mail; quem resolve papel é o servidor. Confiar numa
claim do cliente para decidir permissão seria deixar o navegador escolher o
próprio nível de acesso. `ADMIN_EMAILS` (ou a lista de 7 e-mails embutida em
[server/accessLog.mjs](server/accessLog.mjs)) é só **bootstrap**: o papel é
gravado uma vez, no primeiro acesso, e dali em diante o valor salvo manda.
Rebaixar o último administrador é bloqueado, para não travar o acesso à própria
tela que gerencia isso.

Além do papel global existe **gerente de pasta**, que não é papel global: é a
presença do e-mail em `folder.managers`. Um usuário `standard` pode gerenciar uma
ou mais pastas — o poder vale só dentro delas.

| Camada | Quem decide | Efeito |
|---|---|---|
| **Pasta** | só admin define acesso e gerentes | sem acesso, a pasta e tudo dentro nem aparecem |
| **Dashboard** | admin ou gerente da pasta | criar, e mexer na estrutura (guias, filtros, medidas, temas) |
| **Guia** | admin ou gerente da pasta | listas independentes de **ver** e **editar** |

Guias novas nascem **restritas**; só a de boas-vindas nasce e permanece aberta, e
o servidor recusa removê-la ou bloqueá-la. Liberar uma guia para quem não tem
acesso à pasta **não é um atalho**: o servidor recusa a gravação dizendo
*"libere o acesso à pasta antes de liberar a guia"*. E o seletor de e-mails
mostra só membros daquela pasta — um gerente nunca precisa de visibilidade sobre
gente de fora do próprio setor.

Das **59 rotas** de [server/index.mjs](server/index.mjs), apenas três não passam
por `requireAuth()`: as duas de login/logout e o `/api/health`. As checagens do
React Router são **só UX** — o comentário no código diz isso com todas as
letras. Esconder o link nunca foi controle de acesso.

> **`AUTH_DISABLED=true` atende toda requisição como um e-mail fixo.** Não há
> sessão, não há cookie, não há autenticação: qualquer um que alcance a API é
> esse usuário. É só para desenvolvimento — serve para abrir as telas num
> navegador de verdade sem depender do popup do Google, que exige navegação até
> `accounts.google.com`. A API imprime um aviso em letras garrafais a cada
> subida enquanto estiver ligada, e o compose **não repassa a variável para
> serviço nenhum** — preenchê-la na tela do Portainer não tem efeito, o que é
> parte da proteção.
>
> O bypass não é "modo deus": a permissão continua saindo do e-mail, então a tela
> mostra o que aquela pessoa veria logada. Um bug de acesso não fica escondido
> atrás de um usuário sintético durante o teste — que é justamente o tipo de coisa
> que só apareceria em produção. E se o e-mail do bypass for de fora do
> `ALLOWED_DOMAIN`, a API **não sobe**: `requireAuth()` garante em toda rota que
> o e-mail é do domínio permitido, e o bypass não pode ser a exceção que fura
> essa garantia.

### Um projeto Firebase por sistema

`authentication-dashboardsia`, separado do de qualquer outro setor — mesmo sendo
a mesma empresa e o mesmo domínio de e-mail. Assim base de usuários, domínios
autorizados, cotas e log de acesso ficam separados, e comprometer um sistema não
alcança os outros.

Dois passos no console que **não aparecem no build** e são sempre esquecidos:

1. **Authentication → Sign-in method → Google → Ativar.** Projeto novo vem com
   todos os provedores desligados.
2. **Authentication → Settings → Authorized domains** → adicionar o domínio onde
   o dashboard vai rodar. Só `localhost` vem liberado; sem isso o popup falha com
   `auth/unauthorized-domain` **no primeiro clique real, nunca antes**.

---

## Publicar no Portainer

Três serviços, sem registry — o próprio servidor constrói as imagens a cada
deploy, rodando `npm ci` + `vite build` dentro dele:

| Serviço | O que é | Porta |
|---|---|---|
| `web` | nginx servindo a SPA + proxy de `/api/` | `${WEB_PORT}:80` — a única publicada |
| `api` | Express rodado por `tsx` | 8788, só na rede interna |
| `etl` | **a mesma imagem do `api`**, com o comando trocado para o agendador | nenhuma |

```bash
docker compose up -d --build
```

### A divisão que mais custa caro: BUILD × runtime

| Grupo | Variáveis | Obrigatório? |
|---|---|---|
| **Login (BUILD)** | `VITE_FIREBASE_API_KEY` `VITE_FIREBASE_AUTH_DOMAIN` `VITE_FIREBASE_PROJECT_ID` `VITE_FIREBASE_APP_ID` | **sim — e exigem rebuild** |
| Login (runtime) | `FIREBASE_PROJECT_ID` (derivado do `VITE_` no compose) `ALLOWED_DOMAIN` `ADMIN_EMAILS` `SESSION_TTL_DAYS` | sim |
| Cifra | `SECRETS_KEY` | não — gerada sozinha, mas **idêntica em `api` e `etl`** |
| Publicação | `WEB_PORT` | **sim — o deploy para sem ela** |
| Data Hub | `DHUB_BASE_URL` `DHUB_PAGE_SIZE` `DHUB_MAX_ROWS` `DHUB_TIMEOUT_MS` | não |
| ETL | `ETL_BASE_INTERVAL_MINUTES` `ETL_RUN_ON_START` | não |

**As `VITE_*` são gravadas dentro do bundle pelo Vite, em tempo de build.**
Preenchê-las na tela da stack e só recriar o container **não muda nada** — o
JavaScript já saiu da fábrica com o valor de antes. O sintoma é o pior possível:
o container sobe, a tela de login aparece, e o botão não reage. O conserto é
redeploy **com rebuild**, não restart.

O Dockerfile aborta o build se `VITE_FIREBASE_API_KEY` ou
`VITE_FIREBASE_PROJECT_ID` vierem vazias — falha cedo e com a mensagem certa.
Mas atenção: **`AUTH_DOMAIN` e `APP_ID` não são validadas**. Um build sem elas
passa limpo e o popup quebra só no primeiro clique real.

`WEB_PORT` usa `${WEB_PORT:?…}`, e isso foi aprendido do jeito difícil: em
branco, o Docker publicava numa **porta aleatória**. A stack subia saudável e
ficava inalcançável no endereço esperado, com um aviso perdido no log — a cara de
problema de rede, sendo variável faltando. Hoje o deploy para e diz o que definir.

### Os dois volumes vão nos dois serviços

`snapshot` em `/snapshot` e `data` em `/app/data`, montados em `api` **e** `etl`
ao mesmo tempo. Separá-los quebra tudo em silêncio: o `etl` não vê as fontes
cadastradas pela tela, grava um snapshot vazio, e os tokens do Data Hub ficam
indecifráveis do lado dele. Os containers continuam saudáveis e o Builder fica
sem dado.

Pelo mesmo motivo o `api` monta `/snapshot` **com escrita**: é ele quem dispara o
ETL sob demanda quando alguém mexe no catálogo de fontes. Montar como
somente-leitura faz essa atualização falhar silenciosamente.

O nginx resolve o endereço do `api` **por requisição**, via DNS interno do Docker,
e não no start. Com host literal em `proxy_pass`, o nginx se recusa a subir quando
o `api` ainda não existe e guarda o IP para sempre — e todo redeploy da stack
recria os containers. Com a resolução diferida, o `web` sobe mesmo com o backend
fora, `/api/` responde 502 e volta sozinho.

### Detalhes que já morderam

- **`web` depende do `api` saudável** (`condition: service_healthy`). Se o `api`
  entrar em crash loop, o `web` não inicia — nem a tela de login aparece.
- **O `etl` herda o healthcheck da imagem**, que bate em `:8788/api/health`, e o
  processo do agendador nunca abre porta nenhuma. Ele tende a aparecer como
  `unhealthy` permanentemente. Nada depende da saúde dele, então a stack funciona
  — mas o painel mente. O [DEPLOY-PORTAINER.md](DEPLOY-PORTAINER.md) afirma o
  contrário; confira em campo antes de acreditar em qualquer um dos dois.
- **Dois nomes de variável para o mesmo arquivo**: o `api` lê `SNAPSHOT_PATH`, o
  `etl` escreve em `SNAPSHOT_OUT`, e cada uma só existia no seu próprio serviço.
  Acontece que **o ETL também roda disparado pela API**, com o ambiente do
  container do `api` — onde `SNAPSHOT_OUT` não existe. Ele caía no padrão
  `./public/installData.data` dentro do container do `api`, caminho que ninguém
  lê, enquanto a API seguia lendo `/snapshot/installData.data`. A fonte era
  buscada de verdade, o snapshot era gravado de verdade, e os dois nunca se
  encontravam; a fonte só aparecia quando o serviço `etl` separado rodasse — com
  agendamento de 60 minutos, até uma hora depois. Pior, **a contagem de linhas na
  tela era pista falsa**: ela vem do registro da fonte, não do snapshot, então
  dava para ver "185.564 linhas" com o snapshot vazio daquela fonte. Corrigido em
  14/09/2026: o destino agora é `SNAPSHOT_OUT || SNAPSHOT_PATH ||
  ./public/installData.data`.
- **`API_PORT` no compose é o literal 8788**, não `${API_PORT}`. Definir a
  variável na tela da stack não muda a porta; o nginx também tem `api:8788` fixo.
- **`ADMIN_EMAILS` vazio não deixa a instalação sem admin** — há 7 e-mails
  embutidos como bootstrap. Quem espera que "vazio = ninguém é admin" vai se
  surpreender.
- Heap limitado de propósito (`--max-old-space-size` 1024 no `api`, 2048 no
  `etl`): o processo carrega o snapshot inteiro em memória, e sem teto um dataset
  grande derruba o container por OOM do host em vez de falhar só a consulta.
- Log `json-file` capado em 10m × 3 nos três serviços — este serviço registra uma
  linha por ida ao modelo, e sem isso o log enche o disco do host.

> **O snapshot embutido no build fica alcançável sem autenticação.** O Vite copia
> `public/` para `dist/`, o Dockerfile serve `/app/dist` inteiro pelo nginx com
> `try_files $uri`, e `public/installData.data` — 374 KB de dado real da empresa,
> versionado no repositório — vira `GET http://<host>:<WEB_PORT>/installData.data`
> para quem alcançar a URL. Não é o snapshot vivo, que fica no volume em
> `/snapshot`, mas é dado real congelado na data do commit.

---

## O que o app grava em disco

Não há banco. Todo estado é arquivo JSON plano, gravado por reescrita síncrona do
arquivo inteiro — padrão que escala bem para o tamanho de uma ferramenta interna.

| Arquivo | O que guarda | O que se perde sem ele |
|---|---|---|
| `data/workspace.json` | **toda** a árvore Pasta→Dashboard→Guia: widgets, layout, filtros, relações, medidas e permissões | tudo o que alguém montou |
| `data/lakehouseSources.json` | catálogo de fontes do Data Hub, com token cifrado | as fontes; precisam ser recadastradas |
| `data/sheetSources.json` | planilhas cadastradas + cache de 5 min | o cadastro e o cache |
| `data/sessions.json` | sessões de login, com o token do Google cifrado | todo mundo loga de novo |
| `data/users.json` | quem já entrou e o papel salvo | os papéis voltam ao bootstrap |
| `data/audit-log.json` | as 5.000 ações mais recentes | o histórico de quem mudou o quê |
| `data/fieldDictionary.json` | descrição e tipo sobrescrito por campo | a correção de tipo volta à inferência |
| `data/widgetComments.json` | comentários nos widgets | as anotações |
| `data/aiConfig.json` | provedor, modelo, orçamento e credencial cifrada | a IA volta a "não configurada", sem erro visível |
| `data/.secret-key` | a chave AES que decifra todo o resto | tokens, sessões e credencial de IA ilegíveis |
| `public/installData.data` | o snapshot gzip de todas as fontes | widgets respondem 503 até o próximo ETL |

> **`data/workspace.json` corrompido ou apagado não para a API — ela grava por
> cima.** O servidor loga *"arquivo corrompido — recriando a partir do padrão"* e
> escreve um workspace novo com uma pasta "Geral", uma "Dashboard Principal" e só
> a guia de boas-vindas. Pastas, dashboards, guias, widgets, medidas e permissões
> vão embora, e **nesse caminho nenhum `.bak` é feito**.
>
> O `data/workspace.json.bak` que existe **não é backup periódico**: só é escrito
> quando uma migração de schema realmente altera algo, e é sobrescrito na
> migração seguinte. Não conte com ele para desfazer uma edição errada.

Não há controle de concorrência em escrita nenhuma. **Duas pessoas editando a
mesma dashboard: a última que salvar sobrescreve a outra**, sem conflito e sem
aviso.

---

## Verificações

```bash
npm run test:auth   # 21 casos — verificação do ID token do Firebase
npm run test:ai     # 63 casos — adaptadores dos três provedores
```

Nenhum dos dois toca na rede nem gasta dinheiro.

O **test:auth** é código de autenticação, e por isso não se contenta em provar que
um token bom passa: 18 dos 21 casos provam que os **ruins param**, um a um —
`alg: none`, HS256 assinado com a chave pública, payload adulterado depois de
assinado, assinatura de outra chave, `aud` e `iss` de outro projeto, expirado, sem
`exp`, `iat` no futuro, sem `sub`, sem e-mail, `kid` desconhecido, JWT de duas
partes, base64 inválido, e `FIREBASE_PROJECT_ID` ausente recusando tudo. Um furo
aqui não aparece como bug, aparece como alguém entrando.

Ele gera o próprio par de chaves com `openssl`, assina os tokens e injeta o
certificado no cache, apontando `FIREBASE_CERTS_PATH` para um diretório temporário
para não encostar no cache real. **Depende do binário `openssl` no PATH** — no
Windows, o Git Bash traz; num PowerShell limpo pode não existir, e o teste morre
antes da primeira checagem.

O **test:ai** sobe um servidor de mentira que fala o protocolo dos três
provedores e afirma sobre as duas metades que são código nosso: a tradução de ida
e a normalização de volta. Ele fixa o que quebraria em silêncio — `cache_control`
preservado só na Anthropic, credencial em `x-api-key`/`Bearer`/`x-goog-api-key` e
**nunca na URL**, `additionalProperties` retirado do schema (o Gemini recusa e
devolve 400 sem dizer qual campo), `arguments` da OpenAI remontado de vários
chunks, id sintetizado no Gemini, e a chave nunca aparecendo em claro na resposta
da tela.

Não existe suíte de front nem teste de renderização. A limitação está registrada
em quase toda entrada do [HISTORICO_ALTERACOES.md](HISTORICO_ALTERACOES.md):
*"não testado num navegador de verdade"*. Vale reconferir na tela antes de
considerar uma feature fechada.

---

## Limites conhecidos

Alguns cortam dado **sem aviso na tela**, e essa é a parte que importa saber:

| Limite | Valor | O que acontece |
|---|---|---|
| Pontos num gráfico | 100 | corta mesmo com Top N maior |
| Séries de legenda | 8 | o excedente é **descartado**, não vira "outros" |
| Matriz | 500 linhas/nível, 50 colunas | corta em silêncio |
| Valores num filtro | 500 distintos | a lista para aí |
| Amostra de inferência | 300 linhas | campo que só ganha valor depois da linha 300 fica "dimensão" |

E os limites de projeto, declarados:

- **Não existe desfazer.** "Descartar" só funciona antes do Salvar; depois disso
  a alteração vale para todo mundo e não há versionamento.
- **Relacionamento não encadeia**, e relação faltando não gera aviso nenhum.
- **A Tabela nunca lista linha crua** — são sempre combinações distintas das
  colunas escolhidas, sem opção de desligar.
- **O motor de medidas não tem função nenhuma**: sem `round`, `abs`, `min`,
  `max`, sem condicional, sem mediana ou desvio-padrão, e sem campo calculado
  linha a linha. Uma medida sempre resolve para **um** número — nunca uma série
  acumulada mês a mês.
- **"Mostrar como percentual" só afeta o Card.** Um gráfico com dimensão usando a
  mesma medida ainda mostra o rótulo sem o `%`.
- **Um campo cujo nome comece com `year:`, `quarter:`, `month:` ou `day:`** é
  mal-interpretado como bucket de data. Não corrigido: exigiria mudar a forma como
  bucket é codificado, que hoje é só um prefixo de string.
- **O catálogo de fontes não tem permissão por usuário.** Qualquer pessoa logada
  cadastra uma fonte do Data Hub, mesmo sem acesso a nenhuma pasta; só quem
  cadastrou, ou um admin, edita a sua.
- **Uma guia aberta não percebe que o dado mudou.** Sem "Atualização automática"
  ligada naquela guia, é F5 — não há aviso de "há dados novos".
- **Não há exportação** (PDF, imagem, Excel) nem alerta por e-mail ou Slack.
- **Não há atualização sub-minuto**: mesmo "tempo real" depende do ciclo base de
  2 minutos.

---

## Onde está o resto

[DOCUMENTACAO.md](DOCUMENTACAO.md) detalha funcionalidade por funcionalidade, do
ponto de vista de quem usa. [DEPLOY-PORTAINER.md](DEPLOY-PORTAINER.md) é o passo
a passo da stack. [HISTORICO_ALTERACOES.md](HISTORICO_ALTERACOES.md) registra
cada decisão com data e motivo — é onde a maior parte dos "porquês" deste README
foi lida, e onde estão os bugs que os produziram.

Os três declaram no topo que não são atualizados automaticamente, e o
`DOCUMENTACAO.md` já tem ao menos um trecho defasado (a tabela de variáveis da
seção 2.5, anterior ao Firebase). Diante de divergência, o código manda.
