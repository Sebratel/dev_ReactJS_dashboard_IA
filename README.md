# Indicadores Sebratel — construtor de dashboards com IA

Ferramenta interna onde a **própria área monta as telas**: escolhe a fonte, o
tipo de gráfico, os campos, os filtros e a formatação — ou descreve em português
o que precisa ver, e a IA monta medidas e widgets que já entram salvos (com
"Desfazer"). **React 18 + Vite +
Recharts** no front, **Express rodado por tsx** no servidor, sem banco de dados.

O assunto não é um relatório específico. É a **dependência de desenvolvedor**:
antes, cada indicador novo era uma página programada no código, e mudar a cor de
uma barra passava por um deploy. Aqui a tela é um documento editável, com
permissão por pasta, dashboard e guia.

> **Este repositório versiona `data/` e `public/installData.data`** — decisão
> explícita registrada em [.gitignore](.gitignore), ciente de que põe dado real
> da empresa no histórico. As exceções são os **segredos**: `data/.secret-key`
> (a chave AES que decifra os tokens do Data Hub e as sessões de login),
> `data/lakehouseSources.json` (o token cifrado do Data Hub),
> `data/sessions.json` (o id da sessão é o próprio cookie de login) e
> `data/aiConfig.json` — cifrado mais a chave que o decifra, no mesmo
> repositório, equivale a publicar a credencial em claro. Saíram do git em
> 18/10/2026 (achado FRN-01 do comitê). Também fica fora o cache de
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

Por dois caminhos, e só dois — e o do Data Hub tem dois modos:

| Fonte | Chave | Como é lida | Teto |
|---|---|---|---|
| Dataset do **Data Hub**, leitura **direta** (padrão) | `dhub:<id>` | cada widget é uma consulta agregada no Data Hub, na hora | nenhum na tabela; 10.000 linhas por resposta |
| Dataset do **Data Hub**, **cópia local** | `dhub:<id>` | ETL em segundo plano, paginado, para o snapshot | 500.000 linhas e 100 MB |
| **Planilha do Google** | `sheet:<id>` | dentro da requisição, com o token de quem está logado | 20.000 linhas |

**O app não fala com banco de dados.** Não tem driver, não tem credencial, não
tem caminho de código. Havia antes um catálogo de queries SQL que batia direto no
Postgres do ERP e no MariaDB; manter os dois caminhos consumia duas plataformas
grandes pela mesma informação, e o lakehouse existe justamente para ser o
barramento. Dado novo no dashboard se resolve publicando o dataset no Data Hub.

### Leitura direta: o Data Hub agrega, nada é copiado

O Data Hub já é o lake (Parquet + DuckDB). Na leitura direta — o padrão de toda
fonte cadastrada a partir de 01/10/2026 — o app não guarda linha nenhuma: cada
widget vira um `QueryDef` enviado a `POST /api/public/v1/datasets/<slug>/query`
([server/directWidgetQuery.mjs](server/directWidgetQuery.mjs)), o DuckDB de lá
agrupa e agrega, e só o resultado volta. Um gráfico por mês de uma tabela de 1,8
milhão de linhas atravessa a rede em poucos KB. Foi o que destravou tabela grande
ou larga: na cópia, 287 mil linhas × 154 colunas eram ~1,5 GB de texto, que
derrubavam o processo do ETL sem erro em lugar nenhum.

- **A saída é a mesma do motor em memória** — as regras de rótulo, hierarquia de
  datas, top N, legenda, matriz e tabela são as de
  [server/widgetQuery.mjs](server/widgetQuery.mjs), reaproveitadas; o que muda é
  quem agrega. `npm run test:direct` roda 42 widgets nos dois modos e compara.
- **Relação com outra fonte funciona** como filtro (semi-join pelas chaves) e
  como campo (eixo, legenda, medida, coluna): o Data Hub agrupa também pela chave
  da relação e a junção acontece aqui — desde que caiba em 10 mil grupos.
  Passou disso, o widget diz o que fazer em vez de mostrar número incompleto.
- **Cache de 60 s** por consulta, a mesma consulta em andamento é compartilhada e
  no máximo 6 vão ao Data Hub ao mesmo tempo
  ([server/datahubQuery.mjs](server/datahubQuery.mjs)). Editar a fonte ou clicar
  em "Atualizar agora" descarta o cache dela.
- **Exige o Data Hub com a consulta pública** (commit `3cea3c6` "API publica: consulta agregada pelo token", na branch `staging` de `Sebratel/dev_DataHub_ReactJS`:
  rota `/query`, período em `groupBy`, contagem de linhas, `orNull`,
  `withTotal`). Sem ela, o cadastro avisa e a fonte pode ficar em cópia local.
- O ETL não copia fonte direta: na vez dela, só confere que o Data Hub responde
  e anota o total de linhas, que é o que Configurações mostra.

Diferenças para a cópia, todas a favor do que se espera de BI: média ignora
campo vazio (a cópia o contava como zero); "Contagem de X" conta texto vazio
como preenchido; contagem distinta sem campo conta linhas; na tabela paginada lá,
o vazio vai para o fim e empate na coluna clicada é desfeito pelas demais.

### Cópia local

O ETL ([scripts/fetch-install.mjs](scripts/fetch-install.mjs)) lê o catálogo,
decifra o token de cada fonte copiada, pagina a API pública do Data Hub e grava
**tudo num arquivo único gzip**, `public/installData.data` — o snapshot. A API
carrega esse arquivo inteiro em memória e o recarrega sozinha quando o `mtime`
muda, sem precisar de restart ([server/dataset.mjs](server/dataset.mjs)).

Uma fonte copiada que não cabe (`DHUB_COPY_MAX_MB`, padrão 100 MB de JSON,
estimado pela 1ª página antes de baixar o resto) vira **erro na própria fonte**,
com a sugestão de passar para a leitura direta, e segue a agenda dela. Antes,
ela derrubava o ciclo inteiro na gravação: nada era registrado, as fontes
pequenas paravam de atualizar junto, e tudo era baixado de novo a cada 2 minutos.

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

### Filtro por clique

Clicar numa barra, fatia, rótulo do eixo, célula de tabela ou linha/coluna de
matriz filtra a guia inteira por aquele valor — o filtro cruzado do Power BI, o
mesmo da Agenda do Dia: o widget clicado não se filtra (acende o item e esmaece
o resto), Ctrl+clique soma, clicar fora ou Esc limpa, e um balão no rodapé diz
o que está filtrando. Só fora do modo edição.

Na agenda, todo visual lê a mesma lista de linhas no navegador. Aqui cada widget
é uma consulta, de fontes diferentes, com medidas nomeadas e relações — então o
clique **vira filtro da guia**, o mesmo `{ filter, values }` dos filtros do topo
([clickFilter.ts](src/features/builder/clickFilter.ts)). Com isso, relação
(semi-join pela chave), medida nomeada (inclusive fórmula, com o aviso de
"filtro parcial") e leitura direta já funcionam sem código novo no servidor. O
servidor só passou a devolver a chave crua do ponto (`key`) quando o rótulo é
outro — numa hierarquia de datas, "Março" não volta a ser data. Campo de outra
fonte (`fonte.campo`) vira filtro naquela fonte, e a relação o traz de volta.

O preço é o que um filtro de guia expressa: campo a campo, "está em" ou "entre
datas". Ctrl+clique em duas células de matriz (Ana às 8h, Bruno às 9h) vira
"Ana ou Bruno" e "8h ou 9h"; vários meses viram o período do primeiro ao
último. Histograma e cartão não filtram.

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

### Nada some sem aviso

Os problemas mais caros deste app foram os **invisíveis**: o trabalho de alguém
sumia, ou um gerente não conseguia editar, e nada na tela dizia por quê. Cada
causa conhecida agora aparece ou é barrada:

| Causa | O que acontece agora |
|---|---|
| aba do navegador aberta desde antes de um redeploy (código velho) | aviso flutuante "Saiu uma versão nova do app" ([useNewVersion.ts](src/hooks/useNewVersion.ts) compara o script principal do `index.html` com o carregado), e o servidor **recusa** o salvar de página antiga (409 `client_outdated`) em vez de adivinhar — era a página antiga que regravava a lista inteira de guias e apagava o trabalho dos outros |
| arquivo de tela da versão antiga sumiu depois do redeploy | `vite:preloadError` recarrega a página uma vez, em vez de deixar a tela em branco |
| permissão mudou com a página aberta (virou gerente, ganhou/perdeu edição) | a consulta de 15 s traz as permissões de agora (`editable`, `canManage`): fora do modo edição a tela se atualiza; no modo edição, avisa e atualiza ao sair |
| saiu da dashboard (menu, F5, fechar a aba) com alteração não salva | pergunta antes ("Sair sem salvar?") |
| o trabalho "sumiu" porque outra pessoa salvou depois | cada guia guarda quem gravou por último e quando; o modo edição mostra "Última gravação desta guia: *Fulano*, hoje às 14:32", e a recusa por cópia velha diz o nome |
| e-mail na lista de acesso ou de gerentes diferente do login da pessoa | a lista "Pessoas da pasta" põe esse e-mail no topo, marcado "nunca entrou", e explica: se a pessoa já usa o app, o e-mail está errado e ela fica sem o acesso |

### A IA é a exceção: o que ela entrega já entra salvo

Aprovar cartão por cartão e ainda clicar em "Salvar" fazia quem usava a IA achar
que estava salvo — e perder. Agora, quando a resposta termina, o que ela
entregou é gravado na hora ([useAiAutoSave.ts](src/features/builder/useAiAutoSave.ts)):
primeiro as medidas, depois os widgets (que podem usá-las), na guia do pedido. A
gravação leva **só** isso: o rascunho manual da pessoa continua rascunho. Cada
resposta mostra onde entrou e tem **Desfazer**, que tira os widgets, as medidas
novas, volta as medidas ajustadas e remove a guia que nasceu vazia por causa
dela. Guia bloqueada por outra pessoa, ou medida que só o gerente pode alterar:
o cartão diz por quê e oferece "Tentar de novo".

As medidas são gravadas **uma a uma** (`PUT …/dashboards/:did/measures`),
nunca a lista inteira — inclusive no "Salvar" manual, que manda só o que mudou.
Quem só edita uma guia cria medida nova e remove uma sem uso; alterar uma medida
que já existe é do gerente da pasta (ela vale pra dashboard inteira).

### Uma guia, um editor por vez

Enquanto alguém está no modo edição de uma guia, ela fica **bloqueada para os
outros** — e só ela: as outras guias da mesma dashboard continuam livres, que é
o caso de um gerente com uma guia por supervisor, todos mexendo ao mesmo tempo.
Quem abre uma guia bloqueada vê o cadeado na aba e o aviso "*Fulano* está
editando esta guia", e não consegue editar até ela ficar livre; a tela pega o
bloqueio sozinha quando isso acontece.

O bloqueio vive **em memória** na API ([server/tabLocks.mjs](server/tabLocks.mjs))
e é da **janela**, não só do e-mail: a tela renova a cada 30 s, e quem fecha a
aba, perde a rede ou deixa a tela parada 20 minutos perde o bloqueio sozinho em
até 2 minutos (`TAB_LOCK_TTL_SECONDS`). Não existe bloqueio esquecido para um
administrador destravar. A API precisa rodar numa instância só — o que já era
verdade por causa da memória da IA.

O bloqueio é a parte visível; a garantia está no salvar. Antes, salvar
substituía **todas** as guias pela cópia que a tela tinha aberto — um gerente
que abriu a dashboard às 9h apagava, ao salvar às 10h, o que um supervisor
gravou às 9h30. Agora o Builder manda só as guias que mudou
(`changedTabIds`/`removedTabIds`), o servidor grava guia por guia e recusa
(409, dizendo quem) mudar ou remover uma guia que outra pessoa está editando.
Cada guia tem uma versão (`rev`): gravar uma guia a partir de uma cópia
desatualizada também é recusado. E quem só está olhando recebe a versão nova de
uma guia salva por outra pessoa em até 15 s, sem F5.

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
| posição x/y fora do schema | o cliente calcula com `findFreeSpot` ao salvar — o modelo nunca sobrepõe o que já existe |
| entra salvo, mas só o que ela entregou | ao fim da resposta, o navegador grava as medidas (uma a uma) e depois os widgets, na guia do pedido — sem levar junto o rascunho da pessoa; cada resposta tem "Desfazer" |
| fontes da conversa | só as fontes liberadas para a pasta, marcadas no painel — dá para pôr ou tirar no meio da conversa, e vale a partir da mensagem seguinte; `field_values` só alcança as marcadas; turno de conversa de outro e-mail é recusado |
| o que entregar (passo 4 do painel) | com a entrega restrita (tabelas, gráficos, cards), `propose_widgets` recusa tipo não marcado (inclusive texto) — volta como erro e o modelo refaz na mesma resposta. Medidas nomeadas ficam fora da restrição: o modelo cria as que a análise pedir em qualquer escolha ([server/aiRequestOptions.mjs](server/aiRequestOptions.mjs)) |

O **nível de personalização** (passo 3: Mínimo, Médio — o padrão — ou Alto) e a
entrega escolhida vão em cada `POST …/messages` como `options` e viram um bloco
próprio do prompt de sistema **a cada turno**, depois dos blocos com cache — a
pessoa pode mudar entre um pedido e outro sem estragar o cache. A personalização
fica só no prompt (aparência não quebra nada); a entrega é cobrada nas
ferramentas, porque "pedi só tabela e veio card" é o tipo de coisa que a pessoa
percebe na hora.

Nada aplicado sozinho é deliberado: **o modelo pode interpretar mal um pedido
ambíguo**.

### A conversa dura a sessão, uma por dashboard

O painel não guarda a conversa: quem guarda é
[aiChatStore.ts](src/features/builder/ai/aiChatStore.ts), uma por dashboard, no
`sessionStorage` da aba. Fechar o painel, trocar de dashboard ou dar F5 não apaga
nada; o turno roda no store, então fechar o painel no meio de uma resposta não a
interrompe. **Logout ou fechar a aba apaga** — o `logout()` do `authStore` limpa
a chave mesmo que o Builder nem tenha sido carregado naquela aba, e trocar de
usuário na mesma aba também zera. O botão ↺ ("Nova conversa") é o jeito de zerar
de propósito, e libera a conversa no servidor (`DELETE /api/ai/conversations/:id`).

A **memória do modelo** continua no servidor, só em memória: some após 2 h sem uso,
no teto de 200 conversas, ou quando a API reinicia (todo redeploy). Por isso a rota
de mensagem confere a conversa **antes** de abrir o stream e responde **410**
quando ela sumiu; o navegador então abre outra mandando o que já foi dito na tela
(`history`, só texto — o que foi proposto e aprovado vira uma linha "[Propus…]") e
reenvia o pedido. O servidor confere papel, alternância e tamanho
(`resumeHistory`: 30 falas, 4.000 caracteres cada, 24.000 no total), porque é texto
vindo do navegador e cada caractere é token cobrado. Resultado de ferramenta não
volta: se precisar de um valor de novo, o modelo consulta.

> A gravação no `sessionStorage` é adiada (400 ms, e na hora no `pagehide`):
> durante a resposta o texto chega aos pedaços, e serializar todas as conversas a
> cada pedaço seria trabalho jogado fora.

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
próprio nível de acesso. Quem entra pela primeira vez é `standard` (Padrão).
`ADMIN_EMAILS` (ou a lista de 7 e-mails embutida em
[server/accessLog.mjs](server/accessLog.mjs)) é só **bootstrap**: vale apenas
enquanto não existe nenhum admin salvo em `data/users.json`. O papel é gravado
uma vez, no primeiro acesso, e dali em diante o valor salvo manda.
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

Das **70 rotas** de [server/index.mjs](server/index.mjs), apenas três não passam
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

### Primeiro acesso: Manual de uso e pedido de acesso

Quem entra pela primeira vez cai na página **Manual de uso** (`/manual`), não na
primeira dashboard: o registro novo em `data/users.json` nasce com
`manualPending: true`, e a página avisa o servidor (`POST /api/manual/seen`)
quando é aberta. Registro de antes do campo existir conta como já visto — quem
já usava o sistema não é mandado para o manual. Quem **não tem nenhuma dashboard
liberada** também cai lá, em todo acesso.

No topo, a página lista **todas** as pastas, com o acesso de quem está vendo
(`GET /api/access/folders` — só nome e status, nunca dashboards, guias ou a lista
de acesso), e deixa pedir acesso a uma pasta com uma mensagem opcional; o manual
vem embaixo. O pedido
vai para `data/accessRequests.json`; um pendente por pasta (o segundo é 409).
O administrador responde no card **Pedidos de acesso a pastas**, no topo da aba
Acessos, e o número de pendentes aparece ao lado de "Acessos" no menu.
**Liberar** põe o e-mail na lista de acesso da pasta (`grantFolderAccess`) — as
guias restritas dela continuam dependendo da liberação por guia. **Recusar** só
fecha o pedido; a pessoa vê "recusado" e pode pedir de novo.

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

## Manual de uso

O manual é **um PDF**: [manual/manual-de-uso.pdf](manual/manual-de-uso.pdf). Para
atualizar o material, **substitua esse arquivo por outro com o mesmo nome** e
publique — a página conta as páginas sozinha, e não existe lista de slides para
manter. O `Dockerfile.api` copia a pasta `manual/`; `MANUAL_PATH` aponta para outro
arquivo (ex.: um PDF no volume `data`, para trocar sem rebuild).

Ele sai pela API (`GET /api/manual`, atrás do login), e não pelo nginx a partir
de `public/`, porque tudo em `public/` fica alcançável sem autenticação. Vai com
`Cache-Control: private, no-cache` e ETag: cada abertura revalida (304 quando nada
mudou), então o arquivo trocado vale na próxima vez que alguém abrir a página.

A página desenha um slide por vez com o **pdf.js** (`pdfjs-dist`, build
*legacy*): setas, miniaturas, teclado (← →; em tela cheia também PageUp/PageDown,
espaço, Home/End; F liga a tela cheia), arrastar o dedo no celular. Só
visualização — não há botão de baixar nem de imprimir. A tela cheia usa a API
nativa e, onde ela não existe ou não responde em 1,5 s, cobre a janela por CSS.

> **O worker do pdf.js sai como `.js`, não `.mjs`.** O pacote o entrega como
> `.mjs`, e o `mime.types` padrão do nginx não conhece a extensão: serviria como
> `application/octet-stream`, e o navegador recusa worker de módulo sem MIME de
> JavaScript — o manual abriria no `npm run dev` e não abriria em produção. O
> `assetFileNames` do [vite.config.ts](vite.config.ts) renomeia.
>
> **`pdfjs-dist` está em `devDependencies`, de propósito.** O Vite o empacota no
> build da imagem `web`; a imagem `api` roda `npm ci --omit=dev` e não precisa
> dele — nem da dependência opcional dele, `@napi-rs/canvas`, um binário nativo de
> ~37 MB (que por isso também fica fora do `node_modules/` versionado, ver
> `.gitignore`).
>
> O pdf.js desenha em etapas agendadas por `requestAnimationFrame`: numa aba em
> segundo plano o navegador pausa isso, e o slide só aparece quando a aba volta
> a ficar visível.

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
| Data Hub | `DHUB_BASE_URL` `DHUB_PAGE_SIZE` `DHUB_MAX_ROWS` `DHUB_TIMEOUT_MS` `DHUB_COPY_MAX_MB` `DHUB_QUERY_CACHE_SECONDS` `DHUB_QUERY_CONCURRENCY` `DHUB_QUERY_TIMEOUT_MS` | não |
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
  surpreender. O contrário também: com um admin já salvo, pôr um e-mail em
  `ADMIN_EMAILS` não o torna admin — ele entra como Padrão e é promovido na aba
  Acessos.
- Heap limitado de propósito (`--max-old-space-size` 1024 no `api`, 2048 no
  `etl`): o processo carrega o snapshot inteiro em memória, e sem teto um dataset
  grande derruba o container por OOM do host em vez de falhar só a consulta.
- Log `json-file` capado em 10m × 3 nos três serviços — este serviço registra uma
  linha por ida ao modelo, e sem isso o log enche o disco do host.

> **O snapshot versionado ficava alcançável sem autenticação — corrigido em
> 01/10/2026.** O Vite copia `public/` para `dist/`, o Dockerfile serve
> `/app/dist` inteiro pelo nginx com `try_files $uri`, e `public/installData.data`
> — 374 KB de dado real da empresa, versionado no repositório — virava
> `GET http://<host>:<WEB_PORT>/installData.data` para quem alcançasse a URL
> (confirmado no staging: HTTP 200, sem login). Agora o `.dockerignore` o tira do
> contexto de build; nenhuma imagem precisa dele, porque a API e o ETL usam o
> snapshot vivo do volume `/snapshot`. **Imagem construída antes disso continua
> servindo o arquivo até o próximo redeploy.** Tudo o que for colocado em
> `public/` continua público.

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
| `data/users.json` | quem já entrou, o papel salvo e se ainda falta abrir o manual | os papéis voltam ao bootstrap |
| `data/accessRequests.json` | pedidos de acesso a pastas e a resposta de cada um | a fila de pedidos (a decisão segue no log de auditoria) |
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
npm run test:auth     # 21 casos — verificação do ID token do Firebase
npm run test:ai       # 83 casos — adaptadores dos três provedores, a retomada de conversa e as preferências do pedido
npm run test:access   # 32 casos — papel no primeiro acesso, manual pendente, pedidos de acesso
npm run test:direct   # 125 casos — leitura direta no Data Hub × cópia local, filtro por clique nos dois modos, tráfego e ETL
npm run test:locks    # 63 casos — bloqueio por guia, gravação guia por guia, página antiga barrada, medidas uma a uma, duplicar dashboard
npm run test:click    # 43 casos — lógica do filtro por clique: condições, Ctrl, quem se filtra, o que acende
```

Nenhum deles toca na rede nem gasta dinheiro. O **test:access** grava só numa
pasta temporária (users.json, auditoria, pedidos e workspace próprios) e usa
e-mails fictícios. O **test:locks** também: prova que duas pessoas editam guias
diferentes ao mesmo tempo mas não a mesma, que o bloqueio vence sozinho, e que o
que um supervisor salvou não some quando o gerente salva com a cópia antiga.

O **test:direct** cadastra a MESMA tabela (2.400 linhas inventadas) duas vezes,
uma em cópia local e outra em leitura direta, e exige que 42 widgets — barras,
séries por mês e por hierarquia de datas, várias medidas, combo, legenda, KPI,
medidas nomeadas e fórmula, tabela paginada, matriz com subtotais, dispersão,
histograma, relação como filtro e como campo — deem o mesmo resultado nos dois.
O Data Hub é um servidor falso em `127.0.0.1` que implementa a consulta pública
com a semântica do compilador de lá e as conversões do DuckDB que mudam
resultado (contagem como texto, nulos por último). Prova também que a leitura
direta não baixa linha bruta, que o ETL não copia fonte direta e que uma cópia
grande demais vira erro na própria fonte sem congelar as outras. Roda em UTC: no
fuso local, o filtro de período da cópia escorrega 3 horas na virada do dia
(defeito antigo da cópia; a direta compara a data como está escrita).

No mesmo cenário, o **filtro por clique** é conferido nos dois modos: o widget
filtrado pelo clique tem de dar o MESMO número que o item clicado mostrava —
por cidade, por mês, por hierarquia de datas, por região (campo de Bases, que
volta pela relação), por célula de matriz, com Ctrl+clique e com medidas
nomeadas simples e fórmula. O **test:click** cobre a parte sem servidor:
condições, seleção com e sem Ctrl, quem recebe o filtro e o que fica aceso.

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
