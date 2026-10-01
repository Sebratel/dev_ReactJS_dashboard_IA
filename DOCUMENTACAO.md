# Indicadores Sebratel — Documentação do Projeto

> Documento gerado em 24/07/2026 e revisado em 28/08/2026, refletindo o estado do projeto até essa data (revisão de 28/08 acrescentou a seção 2.1–2.5, de estrutura técnica/requisitos/front/back — as seções de funcionalidade já estavam em dia, conferidas contra o código nesta mesma revisão). Não é atualizado automaticamente — quando o projeto mudar de forma relevante, peça para revisar este arquivo. Para o histórico de mudanças, veja [`HISTORICO_ALTERACOES.md`](HISTORICO_ALTERACOES.md).

---

## 1. Objetivo

O **Indicadores Sebratel** é uma ferramenta interna de **construção manual de dashboards**, no estilo Power BI, para acompanhar indicadores operacionais (hoje focados em Instalação: protocolos, agenda, produtividade, backlog, reincidência, capacidade de equipe etc.).

A ideia central: em vez de páginas fixas de indicadores programadas no código, **qualquer pessoa autorizada monta as próprias telas** — escolhe a fonte de dados, o tipo de gráfico/tabela, os campos, a formatação, o layout — sem precisar de um desenvolvedor para cada mudança. O resultado é compartilhado: todo mundo que acessa o sistema vê a mesma dashboard (e as mesmas edições), como um painel de equipe.

---

## 2. Visão geral da arquitetura (resumo)

```
Data Hub / lakehouse — API pública de leitura
        │  (datasets + token cadastrados em Configurações)
        ▼
Catálogo de fontes (data/lakehouseSources.json)
        │  (ETL — roda periodicamente ou sob demanda)
        ▼
Snapshot em memória (public/installData.data, gzip)
        │  (API Express: /api/widget-data, /api/sources, /api/lakehouse-sources, ...)
        ▼
Workspace (data/workspace.json) — Pasta (setor) → Dashboard → Guia → Widgets
        │  (API Express: /api/workspace/*, com checagem de acesso em cada nível)
        ▼
Dashboard Builder (React) — menu de pastas/dashboards, guias, filtros, widgets
```

**Este app não fala com banco de dados.** O lakehouse é o barramento: quem quer um dado no dashboard publica um dataset lá, e aqui se cadastra a fonte apontando para ele. Existia antes um catálogo de queries SQL que batia direto no Postgres do ERP e no MariaDB; manter os dois caminhos significava consumir duas plataformas grandes pela mesma informação, então o SQL foi removido (ver o histórico de alterações). Para dado que ninguém vai publicar no Data Hub — uma lista mantida à mão, um de-para — existem as planilhas do Google (3.7-bis).

Não existe um "esquema" fixo de dados: cada fonte cadastrada traz as colunas que o dataset tem, e o tipo de cada uma (número, data ou texto) é **inferido automaticamente** a partir dos dados reais. Coluna nova no dataset aparece sozinha no Builder, sem configuração manual.

### 2.1 Stack técnica

**Frontend**: React 18 + TypeScript, build com Vite 5, roteamento com `react-router-dom` 6, estado global com `zustand` 4, gráficos com `recharts` 2, grade de widgets arrastável/redimensionável com `react-grid-layout` 2, estilização com Tailwind CSS 3 (modo escuro via atributo `data-theme`, ver 3.10), ícones `lucide-react`, animações pontuais com `framer-motion`, formatação de data `date-fns`.

**Backend**: Node.js + Express 4, todo em arquivos `.mjs` (ESM puro) rodados direto por `tsx` — sem etapa de build/transpilação no servidor (o `tsc` do `npm run build` checa só o TypeScript do frontend). `googleapis` cobre o Google Sheets; a verificação do ID token do Firebase é feita à mão com `node:crypto` (~80 linhas em `firebaseToken.mjs`, em vez de arrastar a árvore do `firebase-admin`); `@anthropic-ai/sdk` fala com a IA (3.7-quater); `dotenv` carrega as variáveis de ambiente. Sem ORM nem driver de banco — o "banco" é o próprio snapshot em memória descrito em 2.3.

### 2.2 Estrutura de pastas

```
src/                    — frontend (React + Vite + TypeScript)
  router/                 rotas (React Router), 1 arquivo
  store/                  estado global (Zustand): sessão, workspace, preferências de UI
  features/               1 pasta por área da aplicação
    auth/                   tela de login (o fluxo OAuth em si acontece todo no servidor)
    access/                 aba "Acessos" — usuários, online, pedidos de acesso, log de auditoria (3.11)
    manual/                 página "Manual de uso": leitor do PDF (pdf.js) e pedido de acesso às pastas (3.15)
    dashboard/              casca fina: resolve a URL (pasta/dashboard) e delega ao builder
    builder/                o editor de dashboards em si — a maior pasta do projeto (3.2 em diante)
    settings/               cadastro de fontes (Data Hub) e Dicionário & Tipo de dado (3.7)
    workspace/              modal de configuração de pasta + client HTTP de pastas/dashboards
  components/             layout (Sidebar/TopBar/MainLayout) e UI genérica (Card, modais, skeleton)
  hooks/                  useHeartbeat (mantém o usuário "online", ver 3.11) e useElementSize
  lib/                    apiClient (client HTTP central) e constante do escopo OAuth
  utils/                  cn() (classnames) e formatadores de número/data em pt-BR
  types/                  ver nota abaixo

server/                 — backend Express (.mjs, ESM, sem build) — ver 2.3
scripts/                — processos batch: ETL (fetch-install.mjs, etl-scheduler.mjs)
data/                   — estado persistente em JSON (fontes, sessões, workspace, comentários, pedidos de acesso...)
manual/                 — o PDF do manual de uso (manual-de-uso.pdf), servido por GET /api/manual (3.15)
public/                 — assets estáticos + installData.data (o snapshot em si, gzip)
docker/                 — nginx.conf (produção)
Dockerfile / Dockerfile.api / docker-compose.yml / DEPLOY-PORTAINER.md — build e deploy (ver 2.5)
```

> `src/types/index.ts` guarda um modelo de domínio fixo (`ProtocoloGeral`, `Turno`, `Grupo`...) que parece resquício de uma versão anterior do app — hoje nada em `src/` importa esse arquivo, já que o schema de cada fonte é inferido ao vivo (3.7), não declarado num tipo fixo. Deixado como está; sinalizado aqui só pra não confundir quem for explorar a pasta.

### 2.3 Backend — módulos, rotas e fluxo de dados

Cada arquivo de `server/` tem uma responsabilidade:

| Arquivo | Responsabilidade |
|---|---|
| `index.mjs` | Monta o Express, CORS, cookies, os middlewares de autenticação/permissão e todas as rotas. |
| `dataset.mjs` | Mantém o snapshot (`public/installData.data`) em memória, recarregando sozinho quando o arquivo muda. |
| `widgetQuery.mjs` | O motor: infere o schema de cada fonte por amostra, filtra/agrupa/agrega/pivota conforme o `WidgetConfig`. |
| `lakehouseSources.mjs` | Catálogo de fontes do Data Hub (CRUD, 3.7-ter) + cliente HTTP paginado da API pública. |
| `sheetSources.mjs` / `googleSheets.mjs` | Catálogo de planilhas cadastradas (3.7-bis) + cliente REST da Google Sheets API. |
| `firebaseToken.mjs` / `sessions.mjs` | Verificação local do ID token do Firebase (assinatura, emissor, público, validade) e persistência da sessão. |
| `secretBox.mjs` | Cifra AES-256-GCM usada em todo segredo salvo em disco (tokens do Data Hub, tokens do Google). |
| `accessLog.mjs` | Papéis (admin/padrão), primeiro acesso (manual pendente), status "online" e o log de auditoria (3.11). |
| `accessRequests.mjs` | Pedidos de acesso a pastas e a resposta de cada um, em `data/accessRequests.json` (3.15). |
| `fieldDictionary.mjs` | Descrições e sobrescrita de tipo de dado por campo (3.7). |
| `widgetComments.mjs` | Comentários por widget (3.13). |
| `workspace.mjs` | A árvore Pasta → Dashboard → Guia, permissões e migrações de schema do `workspace.json`. |
| `aiAssistant.mjs` / `aiWidgetSchema.mjs` | A conversa com a IA (3.7-quater): orquestração de ferramentas + o contrato/validação do `WidgetConfig` que ela propõe. |
| `aiInsight.mjs` | A leitura "O que os dados dizem" (3.14). |

**Rotas** (todas sob `/api`, exigindo sessão salvo onde marcado "público"):

| Área | Rotas | Observação |
|---|---|---|
| Auth | `auth/session` (pública), `auth/me`, `auth/logout` | `auth/session` é o próprio login: recebe o ID token e abre a sessão, então não pode exigir sessão. |
| Dataset | `health` (público), `dataset/status`, `sources` | `sources` é o catálogo de campos que alimenta o Builder. |
| Widget | `widget-data`, `field-values` | O motor de agregação e a busca de valores distintos de um campo. |
| Planilhas | `sheet-sources` (CRUD) + `:id/usage`, `:id/refresh` | Qualquer usuário cadastra (3.7-bis); editar/remover exige dono ou admin. |
| Data Hub | `lakehouse-sources` (CRUD) + `test`, `:id/enabled\|refresh\|sync\|usage`, `:id/folders` | Todas admin-only, como a tela de Configurações (3.7-ter). |
| IA | `ai/status`, `ai/conversations` (abrir; com `history`, retomar), `ai/conversations/:id/messages` (streaming; 410 quando o servidor esqueceu a conversa), `ai/conversations/:id` (DELETE, "Nova conversa") | 3.7-quater. |
| Insight | `ai/insight` | 3.14. |
| Dicionário | `field-dictionary` (GET/PUT) | Leitura livre, escrita admin-only (3.7). |
| Comentários | `widget-comments` (listar/contar/criar/apagar) | 3.13. |
| Workspace | `workspace/tree`, `workspace/folders[/:fid[/dashboards[/:did[/tabs/:tid...]]]]` | Camadas de permissão por rota — acesso à pasta, gerente da pasta, ou edição da guia (3.12). |
| Acessos | `access/is-admin`, `access/users`, `access/users/:email/role`, `access/log`, `access/heartbeat` | Tudo admin-only, exceto `is-admin` e `heartbeat` (3.11). |
| Pedidos de acesso | `access/folders`, `access/requests` (GET/POST), `access/requests/:id/approve`, `access/requests/:id/reject` | `folders` e criar pedido: qualquer logado; listar, liberar e recusar: admin-only (3.15). |
| Manual | `manual` (o PDF), `manual/seen` | Com sessão; `seen` encerra o primeiro acesso (3.15). |

**Fluxo, do lakehouse até a tela**: `scripts/fetch-install.mjs` lê o catálogo de fontes, decifra cada token, pagina a API pública do Data Hub e grava **um único snapshot** (gzip, `public/installData.data`) — preservando o dado anterior de qualquer fonte que ainda não venceu seu ciclo, ou que falhou na última tentativa. `dataset.mjs` mantém esse arquivo em memória, recarregado sozinho quando o mtime muda: é o único "banco" do processo da API. Uma chamada a `POST /api/widget-data` lê esse snapshot, injeta ao vivo linhas de planilha do Google se o widget referenciar uma, valida os campos contra o catálogo, e devolve o resultado já agregado — pronto pro gráfico desenhar.

**Autenticação**: Firebase Authentication no cliente; o servidor confere a assinatura do ID token **localmente** (chave pública do Google em cache, ver 3.9) e abre uma sessão própria em `data/sessions.json`, referenciada por um cookie `HttpOnly` com id opaco. Toda rota autenticada busca a sessão pelo cookie e confere o domínio `@sebratel.com.br`. Rotas do workspace têm três camadas extras de permissão (acesso à pasta / gerente da pasta / edição da guia), refletindo 3.12.

**Processo em segundo plano**: `scripts/etl-scheduler.mjs` roda em ciclo fixo (`ETL_BASE_INTERVAL_MINUTES`, padrão 2 minutos) chamando `fetch-install.mjs`; dentro dele, cada fonte decide sozinha se é a vez dela (tempo real roda todo ciclo; agendada, só quando o próprio intervalo configurado já passou desde a última vez). Criar/editar/(des)ativar/sincronizar uma fonte do Data Hub pela tela também dispara uma atualização imediata, sem esperar o próximo ciclo (3.8).

### 2.4 Frontend — rotas, estado e comunicação com o backend

**Rotas** (`src/router/index.tsx`, `react-router-dom`, páginas carregadas sob demanda):

| Caminho | Página | Acesso |
|---|---|---|
| `/login` | Login (Google SSO) | Pública |
| `/` | Redireciona pra primeira dashboard visível — ou pro Manual de uso, no primeiro acesso e quando não há nenhuma dashboard liberada (3.15) | Sessão |
| `/dashboard/:folderId/:dashboardId` | O Builder (3.2 em diante) | Sessão |
| `/manual` | Manual de uso + pastas e pedido de acesso (3.15) | Sessão |
| `/configuracoes` | Fontes de dados + Provedor de IA + Dicionário (3.7) | Sessão + admin |
| `/acessos` | Gestão de acessos (3.11) | Sessão + admin |

A proteção de verdade mora sempre no servidor — cada rota da API confere de novo quem está pedindo; o React Router só evita mostrar a tela errada por um instante enquanto a sessão carrega.

**Estado global** (`src/store/`, Zustand): `authStore` guarda só "quem está logado" (identidade em memória — não é a sessão de verdade, essa é o cookie do servidor); `workspaceStore` guarda a árvore de pastas/dashboards visíveis ao usuário atual, sempre recarregada do servidor a cada mudança relevante; `appStore` guarda preferências puramente locais (tema, barra lateral recolhida), persistidas no `localStorage` do navegador — não compartilhadas entre pessoas nem dispositivos. As conversas com a IA ficam em `features/builder/ai/aiChatStore.ts`, uma por dashboard, no `sessionStorage` da aba — sobrevivem a fechar o painel e a recarregar a página, e somem no logout ou ao fechar a aba (3.7-quater). Não existe um "store" do builder: o estado de um dashboard sendo editado (rascunho, ver 3.2) vive local ao próprio componente do editor.

**Comunicação com o backend**: um client HTTP central (`src/lib/apiClient.ts`) usa `fetch` nativo, sempre com o cookie de sessão automático (nenhum token é manipulado no front); uma resposta `401` desloga sozinho e manda pro login. Cada feature tem seu próprio arquivo `*Api.ts` (`builderApi.ts`, `workspaceApi.ts`, `accessApi.ts` etc.) por cima desse client central. Sem axios nem react-query — sem cache/retry automático de requisição.

### 2.5 Requisitos, instalação e deploy

**Para rodar em desenvolvimento**: Node 20 (a versão usada nas imagens Docker; não há um mínimo declarado à parte pro ambiente de dev) e npm. Pelo menos dois processos em paralelo:

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe o Vite (porta 5173 por padrão), com proxy de `/api` pro backend. |
| `npm run api` | Sobe a API Express com recarga automática ao salvar arquivo em `server/`/`scripts/` — **não observa mudança no `.env`**, reinicie na mão depois de editá-lo. |
| `npm run fetch:install` | Roda o ETL uma vez, materializando o snapshot (`public/installData.data`) — sem isso o Builder não tem dado nenhum pra mostrar em dev. |
| `npm run build` | `tsc` (checagem de tipos) + `vite build` — o mesmo processo que roda em produção. |

O ciclo automático de ETL (`scripts/etl-scheduler.mjs`) não faz parte do `npm run dev`; em desenvolvimento, popular o snapshot é manual (`fetch:install`), ou pode-se rodar o scheduler à parte se quiser o ciclo automático local.

**Variáveis de ambiente** (todas comentadas, linha a linha, em `.env.example`):

| Grupo | Chaves | Obrigatória? |
|---|---|---|
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sim — sem elas não há login. |
| | `APP_BASE_URL`, `SESSION_TTL_DAYS` (30 dias), `ALLOWED_DOMAIN` (`sebratel.com.br`), `ADMIN_EMAILS` | Não — todas com padrão razoável. |
| | `AUTH_DISABLED`, `AUTH_DISABLED_EMAIL` | Não — **só desenvolvimento**, desligada por padrão. Ver 3.9. |
| IA (3.7-quater) | *nenhuma* | A IA **não se configura por ambiente** desde 10/09/2026 — é tela (Configurações › Provedor de IA), guardada em `data/aiConfig.json`. Ver 3.7-quinquies. Só a leitura de gráfico mantém `AI_INSIGHT_EFFORT` e `AI_INSIGHT_MAX_TOKENS`, ambos com padrão. |
| | `AI_MODEL`, `AI_EFFORT`, `AI_MAX_TOKENS`, `AI_MAX_ITERATIONS`, `AI_DAILY_BUDGET_USD` | Não — todas com padrão. |
| Cifra de segredos | `SECRETS_KEY` | Não (gera uma sozinha em `data/.secret-key`), mas **precisa ser igual** entre os serviços `api` e `etl` — senão um não decifra o que o outro cifrou. |
| Data Hub | `DHUB_BASE_URL`, `DHUB_PAGE_SIZE`, `DHUB_MAX_ROWS`, `DHUB_TIMEOUT_MS` | Não — todas com padrão (os mesmos números da tabela de limites, seção 5). |
| API/ETL | `API_PORT` (8788), `SNAPSHOT_PATH`, `ETL_BASE_INTERVAL_MINUTES` (2 min), `ETL_RUN_ON_START` | Não. |
| Deploy | `WEB_PORT` (8081) | Só em produção. |

Planilhas do Google não têm variável própria — reusam o Client ID acima e o token OAuth do próprio usuário logado (3.7-bis).

**Produção**: três serviços no `docker-compose.yml` — **web** (compila o frontend e serve com Nginx), **api** (a API Express) e **etl** (mesma imagem da API, rodando só o scheduler). `docker/nginx.conf` serve a SPA e repassa `/api/` pro serviço `api`. Não existe registry de imagem: o próprio Portainer builda a partir do repositório GitHub a cada deploy (ver `DEPLOY-PORTAINER.md`), e as variáveis de ambiente entram pelo campo da stack — não existe `.env` no servidor de produção.

**Estado persistente**: dois volumes nomeados, montados nos serviços `api` e `etl` **ao mesmo tempo** — um pro snapshot (`installData.data`) e outro pra `data/` (fontes cadastradas, sessões, workspace, comentários, a chave de cifra). Os dois serviços precisam enxergar os mesmos volumes: se `etl` não tivesse acesso ao mesmo `data/` do `api`, não veria as fontes cadastradas pela tela nem conseguiria decifrar os tokens que o `api` salvou.

---

## 3. Funcionalidades

### 3.1 Hierarquia: Pastas → Dashboards → Guias

O conteúdo do app tem 3 níveis, pensados pra organizar setores/equipes diferentes sem misturar tudo numa dashboard só:

- **Pasta** (representa um setor/departamento): o menu lateral tem um cabeçalho **"Dashboards"** que funciona como um dropdown — clique para expandir/recolher a lista de pastas. Dentro dele, cada pasta é ela mesma expansível (mostra suas dashboards) e tem um pequeno **botão de engrenagem** ao lado (só visível pra quem gerencia aquela pasta — admin ou gerente) que abre as configurações daquela pasta específica num modal — não existe uma tela separada "Pastas". Um "+" ao lado do cabeçalho "Dashboards" (só admin) abre o mesmo modal em modo de criação. Só **administradores** criam, renomeiam ou removem uma pasta, e só administradores decidem **quem tem acesso** a ela — sem acesso, a pasta nem aparece no menu de quem não foi liberado.
- **Dashboard**: vive dentro de uma pasta; uma pasta pode ter várias. Cada uma tem seu próprio conjunto de guias.
- **Guia** (o que antes era chamado de "aba"): vive dentro de uma dashboard — é onde ficam os widgets de fato. Ver 3.2 pra funcionalidade da guia em si (inalterada) e 3.12 pra quem pode ver/editar cada uma.

**Quem acessa e quem gerencia** são escolhidos, no modal da pasta, numa lista de quem já acessou o sistema — com busca por nome ou e-mail, sem acento —, e não digitados: um e-mail escrito errado não liberava nada e ninguém percebia. Um e-mail liberado antes do primeiro acesso da pessoa continua valendo e aparece como "ainda não acessou", para poder ser tirado.

**Gerente de pasta**: o administrador pode nomear um ou mais usuários como gerentes de uma pasta específica (o mesmo usuário pode ser gerente de uma pasta e não ter nenhum poder especial em outra). Dentro da própria pasta, um gerente pode:
- Criar novas dashboards, renomear (lápis ao lado do nome, no modal da pasta) e remover.
- Decidir quem vê e quem edita cada guia das dashboards daquela pasta (ver 3.12).

Um gerente **não** precisa ser administrador global — o poder dele vale só dentro da pasta em que foi nomeado.

Toda dashboard nova (criada por um admin ou por um gerente de pasta) já nasce com uma **guia de boas-vindas**, sempre visível pra qualquer um que acesse a pasta, com um texto explicando o funcionamento do app — o texto começa pelo caminho de conversar com a IA (3.7-quater), com exemplos prontos de pergunta, e apresenta montar manualmente como o segundo caminho. Guias de boas-vindas criadas antes dessa mudança recebem o texto novo automaticamente na primeira carga da pasta, sem precisar recriar a dashboard — desde que ninguém tenha editado manualmente o texto padrão (uma edição manual é sempre preservada). Todas as outras guias — criadas junto ou depois — nascem **bloqueadas**, e só aparecem pra um usuário padrão depois que um admin ou o gerente da pasta libera o acesso dele especificamente naquela guia.

A guia de boas-vindas nunca acumula widget de verdade: criar um gráfico (manual ou pela IA) estando nela leva automaticamente pra outra guia — a primeira que já existir na dashboard, ou, só na primeira vez (dashboard recém-criada, ainda sem nenhuma outra guia), uma nova guia criada na hora pra esse fim. A guia de boas-vindas em si nunca é criada, editada ou removida por esse mecanismo — continua existindo do jeito que sempre esteve, e só quem gerencia a dashboard pode removê-la manualmente depois, pelo gerenciador de abas (3.12), se quiser.

### 3.2 Guias — filtros e layout

- Cada guia tem seu próprio conjunto de widgets e filtros.
- Cada guia pode ter **filtros no topo** (seleção múltipla de valores, ou intervalo de datas), que afetam todos os widgets daquela guia que usam a mesma fonte de dados — e também widgets de **fontes diferentes**, quando existe um relacionamento declarado entre elas (ver 3.2-bis).
- **Modo edição**: um botão liga/desliga a edição. Fora dele, a tela é só visualização. O que aparece dentro dele depende de quem está editando (ver 3.12):
  - Quem **gerencia a dashboard** (admin ou gerente da pasta) vê tudo: adicionar/editar/duplicar/remover widgets, arrastar e redimensionar, adicionar/remover filtros, gerenciar guias (criar/renomear/remover/reordenar/controlar acesso), e configurar tamanho de tela/atualização automática.
  - Um usuário padrão com **edição liberada numa guia específica** só vê "+ Widget" e "Salvar" — mexe só nos widgets daquela guia, sem acesso a filtros, outras guias ou configurações de tela.
  - Sobrepor um widget em cima de outro é permitido deliberadamente (a grade não empurra os outros sozinha).
  - **Cartão (KPI) e Texto redimensionam bem menores** que os demais tipos — não têm eixo, legenda nem cabeçalho de tabela, então cabem num espaço bem mais compacto. Os outros tipos mantêm um piso maior, pra não virar algo ilegível.
  - A barra de ferramentas do modo edição (botões + aviso "Modo edição") fica **fixa no topo da tela** (como uma linha congelada de planilha) enquanto se rola a guia pra baixo — numa guia com muitos widgets, dá pra salvar/descartar ou adicionar mais um widget sem precisar rolar de volta ao topo.
- **Salvar/Descartar**: as edições ficam num rascunho local até clicar em "Salvar" — só aí vão para o servidor e passam a valer pra todo mundo com acesso àquela guia/dashboard. "Descartar" volta ao último estado salvo.
- **Pré-visualização em tempo real**: enquanto o painel de edição de um widget está aberto, o próprio widget na tela (atrás do painel) já mostra o resultado das mudanças (cor, tipo de gráfico, campo, formatação) — sem precisar salvar para ver o efeito. Só o botão "Salvar" persiste de verdade. Em telas grandes, a grade encolhe pra abrir espaço pro painel (em vez de ficar por baixo dele, escondida) — o mesmo vale pro painel da IA (3.7-quater); em telas estreitas não há espaço pra reservar, então o painel só sobrepõe.
- **Indicador visual**: o widget que está sendo editado no momento ganha um contorno colorido na grade, para ficar claro qual card corresponde ao painel aberto.

### 3.2-bis Relacionamentos entre fontes — filtro cruzado + campo compartilhado

Um dashboard costuma reunir mais de uma fonte de dados (uma tabela de solicitações, outra de bases/filiais, outra de usuários...). O botão **"Relacionamentos"** (barra do modo edição, só quem gerencia a dashboard) declara que um campo de uma fonte é a **mesma chave** de um campo de outra fonte — e a partir daí as duas fontes ficam "compatíveis" de duas formas ao mesmo tempo:

1. **Filtro cruzado**: por padrão, um filtro da guia só afeta widgets que usam a mesma fonte do filtro. Com a relação declarada, um filtro aplicado numa das duas fontes passa a filtrar também os widgets que usam a outra.
2. **Campo compartilhado** (desde 01/09/2026): qualquer widget de uma das duas fontes já enxerga TODOS os campos da outra nos seletores de Eixo X, Eixo Y, Legenda, Filtro fixo e Coluna de tabela — como se fossem campos nativos, sem precisar mesclar campo por campo. Isso é o que permite, por exemplo, montar uma Tabela de protocolos que também mostra o nome do instalador (que vive noutra fonte), ou agrupar um gráfico por uma categoria que só existe na fonte relacionada.

- **Como declarar**: Fonte 1 + campo-chave, Fonte 2 + campo-chave correspondente (ex. "Saldo Voalle → Base de Origem" com "Bases → Base de Origem"), e um rótulo opcional só pra identificar a relação na lista. Uma fonte pode entrar em **quantas relações forem necessárias** — o padrão comum é uma fonte "dimensão" (ex. Bases, Usuários) relacionada com várias fontes "fato" ao mesmo tempo (Consumo, Requisições, Romaneio, etc.), cada uma sua própria relação. O que não dá é relacionar o MESMO PAR de fontes duas vezes (só a primeira relação entre duas fontes tem efeito) — o formulário bloqueia e explica quando isso é tentado.
- **Comparação por chave, não por texto**: o motor busca as chaves REAIS na fonte relacionada — não reaplica o texto exibido no filtro. Isso importa quando o mesmo valor do mundo real está grafado diferente em cada sistema de origem (ex. um código de base numa fonte, o nome por extenso em outra) — desde que o CAMPO-CHAVE escolhido seja o de fato comum às duas, o filtro funciona mesmo que o campo usado no seletor do filtro seja outro (ex. filtrar por "Nome da base", relacionar pela "Base de Origem").
- **Limite deliberado — sem encadear**: nem a propagação de filtro nem o compartilhamento de campo encadeiam — valem só entre duas fontes com relação **direta**. Se A se relaciona com B, e B se relaciona com C, um widget de A não enxerga campo de C automaticamente (precisaria de uma relação direta A↔C). Na prática isso cobre bem o padrão mais comum (uma dimensão compartilhada por várias fontes-fato); um encadeamento fato→dimensão→outro fato não é suportado nesta versão.
- **Sem aviso de relação faltando**: se você esquecer de relacionar uma fonte, o widget dela simplesmente não reage ao filtro (e não enxerga os campos da outra) — sem mensagem de erro na tela. Vale a pena conferir a lista de relações ao montar um dashboard com várias fontes. **Relação apontando pra uma fonte removida** (ex. um admin excluiu a fonte do Data Hub depois que a relação foi criada) é sinalizada, essa sim: aparece destacada em âmbar na lista, com o aviso "fonte não encontrada, esta relação não tem efeito"; um widget que já usava um campo daquela fonte simplesmente para de enxergá-lo, sem quebrar.
- **Escopo por guia**: relações são declaradas por guia, não por dashboard inteira nem globalmente — guias diferentes que usam as mesmas fontes redeclaram as próprias relações.
- **Mesclagem manual antiga aposentada**: até 01/09/2026 existia uma seção separada "Mesclar campo de outra fonte" no editor de widget, pra trazer um campo específico configurando a chave de junção widget a widget. Ela foi removida — declarar o relacionamento uma vez, na guia, já cobre (e amplia) esse caso: qualquer campo da fonte relacionada, em qualquer widget, sem repetir a configuração. Widget salvo antes dessa mudança, com mesclagem manual já configurada, continua funcionando normalmente.
- A **leitura da IA** (3.14) e o painel "Como foi calculado" também respeitam as relações — um filtro cruzado aparece lá como "Filtro da tela (via relação)", e a explicação da IA reflete o dado já filtrado corretamente.

### 3.2-ter Filtro dinâmico — o valor troca sozinho a cada X segundos

Um filtro de **seleção múltipla** pode ser marcado como **dinâmico**: em vez de esperar alguém escolher um valor, ele mesmo avança sozinho pela lista inteira de valores distintos do campo, um de cada vez, a cada X segundos — voltando ao primeiro depois do último, em loop contínuo. Pensado pro mesmo cenário de tela exposta sem interação (3.8, "Atualização automática") — ex. uma TV de painel de setor girando por todas as cidades/equipes/filiais sozinha, sem ninguém precisando trocar o filtro na mão.

- **Onde ativar**: um ícone de "repetir" ao lado de cada filtro de seleção múltipla, na barra de filtros, em modo edição — só quem gerencia a dashboard vê e mexe (mesma permissão de Relacionamentos e Formato). Abre um popover pequeno: liga/desliga e o intervalo em segundos (mínimo 5s).
- **Só existe pra seleção múltipla** — um filtro de período (intervalo de datas) não tem uma lista discreta de valores pra avançar.
- **Enquanto ativo, o filtro fica travado pra escolha manual**: o dropdown mostra o valor atual (em vez de "N selecionados") com um ícone girando, mas não abre pra clicar — evita escolher um valor manualmente e ele trocar sozinho segundos depois. Desative o dinâmico pra voltar a escolher na mão.
- **Só roda em modo visualização** — igual à Atualização automática, ele para enquanto a guia está em modo edição (cada troca refaz a busca de todo widget afetado, o mesmo custo de um ciclo de atualização automática).
- Reinicia sempre do primeiro valor da lista quando liga (sair do modo edição, reabrir a guia) — a seleção de um filtro nunca fica salva entre sessões, dinâmico ou não.
- Funciona normalmente com filtro cruzado entre fontes (3.2-bis): pro motor de relacionamento, uma troca automática do filtro dinâmico é idêntica a uma troca manual.

### 3.3 Construção de um widget — as três abas do editor

Ao criar/editar um widget, o painel lateral tem três abas:

- **Dados**: tipo de visual, fonte de dados (implícita, pelo primeiro campo escolhido), Eixo X, Eixo Y, Legenda, colunas (tabela) ou Linhas/Colunas/Valores (matriz), Top N e um botão de pré-visualização.
- **Modificadores**: mesclar (fazer um "JOIN") um campo de outra fonte pela chave em comum, filtro fixo do widget (diferente do filtro da aba — não é ajustável pelo usuário final, é fixo na configuração), Top N.
- **Formato**: aparência visual — título, subtítulo, cores, fontes, eixos, legenda, linhas de grade, rótulos de dados, fundo do widget, ícones. Todas as seções vêm **fechadas por padrão** (um clique no cabeçalho expande).

### 3.4 Tipos de widget disponíveis

| Tipo | Descrição |
|---|---|
| Card (KPI) | Um número só, com cor customizável. |
| Barras (vertical/horizontal) | Colunas ou barras simples. |
| Empilhadas (vertical/horizontal) | Colunas/barras empilhadas (soma visual das séries). |
| Colunas + linha (combo) | Colunas num eixo Y, uma ou mais linhas num 2º eixo Y à direita — útil para comparar grandezas diferentes (ex. quantidade × tempo médio). |
| Linha | Série temporal ou por categoria. |
| Área | Como linha, com preenchimento. |
| Pizza | Distribuição percentual. |
| Dispersão (scatter) | Pontos posicionados por dois valores numéricos (eixo X e Y). |
| Funil | Estágios em sequência decrescente. |
| Histograma | Distribuição de frequência de UM campo numérico: os valores são divididos automaticamente em faixas de tamanho igual (padrão 10, ajustável), a barra mostra quantos registros caem em cada faixa e a linha mostra a curva normal (gaussiana) ajustada à média/desvio-padrão reais dos dados — barra e linha compartilham o mesmo eixo, estilo histograma do Excel/Power BI ("distribuição normalizada"). |
| Tabela | Combinações **distintas** das colunas escolhidas manualmente (não linha crua — ver 3.4-bis), incluindo colunas mescladas de outras fontes. |
| Matriz | Tabela dinâmica (pivot): 1+ campos nas linhas (com hierarquia e subtotal por nível), 1+ campos nas colunas (dinâmicas), uma medida por célula. |
| Texto | Bloco de texto livre, sem ligação com nenhuma fonte de dados — usado, por exemplo, na guia de boas-vindas de cada dashboard. Sem markdown; preserva quebras de linha. |

Cada tipo mostra no editor só os campos que ele realmente usa (ex.: Dispersão não tem Legenda; Tabela/Matriz/Texto não têm Eixo X/Y convencionais; Texto não tem aba "Modificadores", já que não depende de nenhuma fonte).

### 3.4-bis Tabela — combinações distintas, não linha crua

O widget Tabela não lista um registro por linha do dataset — mostra as combinações **distintas** das colunas escolhidas, como um "SELECT DISTINCT" nas colunas visíveis:

- Com **1 coluna** (ex. "Status"), cada linha da tabela é um valor distinto daquela coluna — mesmo espírito de uma "Linha" da Matriz (3.4), só que sem hierarquia/subtotal.
- Cada coluna **a mais** amplia a granularidade: com "Status" (10 valores distintos) + "Finalizado" (2 valores distintos), a tabela mostra até 10 × 2 = 20 linhas — exatamente as combinações de (Status, Finalizado) que de fato existem nos dados, nunca uma combinação inventada que não ocorre.
- Continuar adicionando colunas de alta cardinalidade (ex. um número de protocolo, que já é único por linha) faz a tabela se aproximar — ou chegar — da lista completa e crua de registros, porque a combinação de colunas passa a identificar cada linha sozinha.
- Não há opção pra desligar esse comportamento e voltar à lista crua — vale pra toda tabela, inclusive as já salvas antes dessa mudança.

### 3.4-ter Hierarquia de datas (Ano/Trimestre/Mês/Dia)

Todo campo do tipo **Data** pode ser usado de duas formas ao montar um widget, e as duas convivem lado a lado no seletor de campos:

- **Puro** — o valor de data de cada linha, sem nenhum agrupamento (só aparece como opção de **coluna da Tabela**; gráfico e matriz nunca oferecem o campo de data puro como dimensão, porque um ponto por data exata não seria útil).
- **Hierarquia de datas** — o mesmo campo quebrado em até 4 níveis: **Ano, Trimestre, Mês, Dia**. Cada nível tem sua própria caixinha de marcar no seletor de campos (abaixo do campo de data, com um leve recuo) e pode ser ligado/desligado independentemente, em qualquer combinação — só Ano, Ano+Mês, Trimestre+Dia, os 4 juntos, etc.

Onde cada forma se aplica:

- **Tabela** — o campo puro e os 4 níveis da hierarquia aparecem juntos no "+" de colunas; dá pra usar a data puro **e** um ou mais níveis como colunas separadas ao mesmo tempo (ex. "Data Saída" + "Ano" + "Mês" como 3 colunas distintas).
- **Gráfico (Eixo X) e Matriz (Linhas/Colunas)** — só os 4 níveis da hierarquia aparecem como dimensão (o campo puro não entra nessa lista, pelo motivo acima). Marcar mais de um nível ao mesmo tempo empilha os níveis marcados numa única dimensão hierárquica.

O efeito de marcar níveis diferentes num gráfico é justamente controlar a granularidade — mesma lógica do Power BI: um gráfico de colunas com Ano+Mês marcados mostra uma barra por mês; adicionar Dia faz o mesmo gráfico virar uma barra por dia, sem precisar trocar de widget nem remontar o gráfico do zero.

Detalhes de comportamento:

- A ordem em que você marca os níveis não importa — o sistema sempre reordena para Ano → Trimestre → Mês → Dia por trás dos panos, tanto no agrupamento/ordenação quanto no rótulo exibido.
- Cada nível soma no rótulo do ponto/coluna: só "Mês" marcado mostra "Agosto"; "Ano"+"Mês" mostra "Agosto/2026" (o ano só aparece repetido no rótulo quando "Ano" **não** está marcado, pra evitar ambiguidade entre anos diferentes).
- Na Tabela e na Matriz cada nível vira sua própria coluna/linha (sempre com o nome por extenso, ex. "Agosto", "2º Trimestre"), sem esse ajuste — não há string composta pra desambiguar.
- **Fora de escopo por enquanto**: não marcamos "Trimestre" ou "Dia" como dependentes de um nível pai estar marcado (diferente do Power BI, que expande a árvore hierarquicamente) — os 4 níveis são independentes entre si, cabe a quem monta o widget escolher a combinação que faz sentido. Também não há uma visualização em "árvore expansível" dentro do próprio gráfico (drill-down clicável) — a granularidade é fixada na hora de montar o widget, marcando os níveis desejados.

### 3.4-quater Tabela e Matriz — ordenar clicando no cabeçalho da coluna

Clicar no cabeçalho de qualquer coluna da Tabela **ou da Matriz** ordena as linhas por ela — clicar de novo na mesma coluna inverte a direção (crescente ⇄ decrescente), sem precisar de nenhum modo de edição. Um ícone ao lado do nome da coluna mostra o estado: seta pra cima/baixo na coluna ativa, um ícone neutro (duas setas) nas demais, indicando que também dá pra clicar nelas.

- **Numérico ou alfabético, sozinho**: o app detecta o tipo real do valor da coluna — número ordena menor→maior/maior→menor, texto ordena a→z/z→a (acentuação em português). Não precisa escolher o tipo, nem configurar nada — é automático por coluna. Na Matriz o valor de cada célula é sempre um número agregado, então só a coluna de rótulo da linha (a árvore em si) ordena por texto.
- **Célula vazia sempre por último**, nas duas direções — uma coluna com linhas em branco não empurra elas pro topo ao inverter pra decrescente.
- **Coluna de Hierarquia de datas (3.4-ter)** ordena pela DATA de verdade (cronológica), não pelo texto do rótulo — "Agosto" não vem antes de "Janeiro" só porque "A" vem antes de "J" no alfabeto.
- **Na Matriz, ordena os "irmãos" de cada nível da hierarquia, sem desmontar a árvore**: clicar em "Total" (ou em qualquer coluna) reordena as linhas de nível 1 entre si por aquele valor, E, **dentro de cada uma**, reordena os próprios filhos entre si pelo MESMO critério — o pai continua com seus filhos aninhados debaixo dele, só a ordem entre irmãos muda. Clicar no cabeçalho vazio da própria árvore (a coluna mais à esquerda) ordena por rótulo, igual à Tabela.
- **Não é salvo com o widget** — é uma preferência de quem está OLHANDO a tela no momento, não uma configuração da dashboard; cada pessoa pode ordenar do próprio jeito, sem afetar o que os outros veem, e a ordenação volta ao padrão ao recarregar a página. Funciona em modo visualização e em modo edição, pra qualquer pessoa com acesso à guia — diferente de outras configurações da Tabela (largura de coluna, formatação condicional), que são estruturais e exigem "Salvar" pra valer pra todo mundo.
- Na Tabela, reordena o conjunto **inteiro** de linhas distintas antes de paginar — não só as linhas da página atual — então navegar entre páginas com uma ordenação ativa continua consistente. A Matriz não pagina (ela já tem o próprio teto de linhas, ver seção 5), então isso não se aplica a ela.

### 3.5 Medidas e agregações

Toda medida (Eixo Y, valor da matriz, medida do eixo X do scatter etc.) escolhe um campo e uma forma de agregar:

- **Contagem** — conta linhas (todas, ou só onde um campo não é vazio).
- **Contagem distinta** — conta valores únicos de um campo (ex. protocolos únicos).
- **Soma** — exige um campo numérico.
- **Média** — exige um campo numérico.

Um gráfico de barras/linha/área pode ter **múltiplas medidas** (cada uma vira uma série colorida), ou uma **Legenda** (quebra a mesma medida em várias séries por valor de um 2º campo) — as duas coisas são mutuamente exclusivas no mesmo widget.

### 3.5-bis Medidas nomeadas e reutilizáveis (tabela de medidas)

Além do cálculo simples de sempre (campo + agregação, direto no widget), a dashboard tem sua própria **tabela de medidas**: cálculos nomeados, salvos uma vez, reutilizáveis em qualquer guia/widget dessa mesma dashboard — pensado especialmente pra quem não sabe montar a fórmula sozinho e vai pedir pra IA, mas funciona igual pra quem já sabe exatamente o que quer.

- **Onde**: botão **"Medidas"** na barra do modo edição (ao lado de "Relacionamentos"), abre um modal com a lista de medidas da dashboard — criar, editar, apagar. Cada medida também pode ser criada **conversando com a IA** (3.7-quater): descreva o cálculo em português e ela propõe uma ou mais medidas prontas pra aprovar, do mesmo jeito que já propõe widgets.
- **Duas formas de medida**:
  - **Cálculo simples** — igual ao de sempre (campo + Contagem/Contagem distinta/Soma/Média), com uma **janela de data opcional** por cima: "Últimos N dias", "Últimos N meses", "Ano até a data", "Mês/Trimestre/Ano atual", ou qualquer uma dessas **"comparando com o mesmo período do ano anterior"** — a janela é sempre relativa a AGORA (recalcula sozinha a cada vez que o widget é aberto), nunca uma data fixa. Tem também um **filtro fixo opcional** (por categoria/status/texto — ex. "Status está em Reincidência", ou "Status não está em Cancelado"): diferente do filtro da aba (que quem vê a tela pode mudar a qualquer momento), esse filtro é parte da PRÓPRIA medida e vale sempre que ela é usada, em qualquer widget/fórmula. É o mecanismo que permite algo como "% de reincidência" (uma medida isolando só os registros com aquele status, dividida por outra sem esse recorte).
  - **Fórmula** — combina duas ou mais medidas JÁ nomeadas (nunca um campo cru direto) numa conta. Por padrão é um **construtor passo a passo**, sem escrever nada: "Referência 1" (escolhe uma medida, ou digita um número fixo — útil pra "dividir por 22", "multiplicar por 1,2"), depois "O que fazer" (Somar/Subtrair/Multiplicar/Dividir) e "Referência 2", com um botão "Adicionar mais um cálculo" pra encadear quantos passos quiser (ex.: Referência 1 − Referência 2, o resultado ÷ Referência 3, e assim por diante). Por trás, o construtor sempre calcula na MESMA ordem sequencial mostrada na tela (nunca a precedência matemática normal escondida). Um link **"Modo avançado"** abre a expressão como texto de sempre (`+ - * / % ^` e parênteses, ex. "(atual - anterior) / anterior * 100") pra quem já sabe escrever fórmula ou precisa de `%`/potência, que o construtor simples não expõe de propósito. As medidas combinadas podem ser de **fontes diferentes entre si** — cada uma já virou um número antes de entrar na conta, então não precisa de nenhum "relacionamento" declarado pra isso (diferente do filtro cruzado, 3.2-bis); nesse caso, escrever uma descrição explicando a suposição é **obrigatório**.
- **O exemplo típico** (comparativo entre períodos): pedir "quero uma contagem de protocolo dos últimos 3 meses comparada com o mesmo período do ano passado" vira 3 medidas — uma com a janela "últimos 3 meses", outra com a mesma janela "comparando com o ano anterior", e uma fórmula que combina as duas. Cada uma pode ser usada sozinha (ex. 2 KPIs lado a lado mostrando os 2 números) ou junto com a medida de comparação (um 3º KPI com a diferença/variação).
- **Onde usar uma medida salva**: no seletor de medida de qualquer widget (Eixo Y, Valores da matriz), a MESMA árvore "Selecionar" usada pra escolher uma coluna comum já lista **"Medidas"** como mais uma tabela (ícone de calculadora), ao lado das fontes de dados reais — expandir mostra os nomes das medidas disponíveis pra aquele slot, clicar já cria o card usando aquela medida, sem precisar abrir nada depois. Quem já criou o card pode trocar a medida depois pelo toggle "Cálculo simples"/"Medida salva" dentro dele:
  - **Num Card (KPI)**: qualquer medida — fórmula, cruzando fontes diferentes, sem restrição. É o caso de uso pensado pra comparativos.
  - **Num gráfico/matriz com Eixo X**: só uma medida do tipo "cálculo simples" **da mesma fonte do widget** — uma fórmula, ou uma medida de outra fonte, não tem como virar "uma barra por categoria" sem uma chave de agrupamento em comum, então esses dois casos ficam disponíveis só no Card.
- **Mostrar como percentual**: checkbox opcional (vale pras duas formas de medida) que acrescenta o sinal "%" na exibição — não divide nem multiplica o valor de novo, só assume que o cálculo já entrega o número certo na escala 0-100 (ex. uma razão `* 100`). Definida na MEDIDA, não no widget: uma "Taxa de X" marcada assim mostra "%" em TODO Card que a usar, sem configurar de novo em cada um. **Hoje só afeta o Card (KPI)** — um gráfico com dimensão usando essa medida no Eixo Y ainda mostra o rótulo/tooltip sem o "%" (pendência conhecida).
- **Não é bloqueado apagar/renomear** uma medida ainda em uso — o modal mostra "usada em" (quais widgets/outras medidas dependem dela) pra decidir com informação; um widget que ficar apontando pra uma medida apagada mostra um aviso, sem quebrar a tela.
- Igual a qualquer outra edição de estrutura da dashboard (filtros, relacionamentos, formato): criar/editar uma medida entra no rascunho e só vale pra todo mundo depois de **Salvar**.
- **Fora de escopo por enquanto**: isto cobre números agregados (uma "medida"), não um campo calculado LINHA A LINHA (ex. concatenar dois campos de texto). Sem validação de que uma fórmula cruzando fontes faz sentido de negócio (populações comparáveis, mesma granularidade de tempo) — só a descrição obrigatória força registrar a suposição assumida, não confere se ela está certa.

### 3.6 Formatação visual (aba Formato)

- **Título e Subtítulo**: texto + tamanho de fonte, negrito/itálico/sublinhado, cor do texto (com opacidade), cor de fundo (com opacidade) e **alinhamento** (esquerda/centro/direita).
- **Cor principal**: cor do gráfico quando há uma única série (não afeta título nem séries com cor própria).
- **Alinhamento do valor** (só KPI): posição horizontal do número (e da meta, se houver) dentro do card.
- **Opacidade das colunas/linhas/fatias**: um slider que deixa todo o preenchimento do gráfico mais transparente.
- **Aparência do widget**: cor de fundo do card inteiro (com opacidade), cor dos ícones de editar/duplicar/excluir, e três efeitos visuais fixos — **sombra**, **brilho** e **piscar** — sempre ativos quando ligados (independente do dado), cada um com o próprio seletor de cor (não dá pra ter, por exemplo, sombra numa cor e brilho em outra com um seletor só). Efeito ligado sem cor escolhida usa um padrão neutro (sombra) ou a cor de fundo do widget (brilho).
- **Meta e alertas** (motor de formatação condicional — ver 3.6.2): meta (linha de referência no gráfico) e regras de cor/pisca/brilho conforme o valor.
- **Eixo X / Eixo Y**: mesmo conjunto de opções de texto do título (fonte, estilo, cor, fundo) — os eixos reservam espaço extra automaticamente quando a fonte é grande, para não vazar para fora do card. Um campo **"Recuo"** (inferior no Eixo X, lateral no Eixo Y) soma manualmente mais pixels a esse espaço reservado — use quando o cálculo automático ainda não é suficiente (ex. números grandes que aparecem cortados); aceita valor negativo, para apertar o espaço se o automático estiver reservando mais do que precisa.
- **Linhas de grade**: todas, só horizontal, só vertical, ou nenhuma — com cor e opacidade próprias, opcionais (sem cor escolhida, usa a cor neutra padrão do tema).
- **Legenda**: mesma formatação de texto, aplicada aos rótulos da legenda embaixo do gráfico.
- **Linhas / Colunas (só Matriz)**: formatação de texto para a hierarquia de linhas e o cabeçalho de colunas, incluindo alinhamento.
- **Rótulos de dados**: liga/desliga rótulos sobre o próprio gráfico (valor de cada barra/ponto/fatia), com posição (dentro/fora/em cima/centralizado), conteúdo (só número / nome / percentual / nome+número / tudo), tamanho de fonte, cor e opacidade. Esse é o padrão do **widget inteiro**; quando há mais de uma medida no Eixo Y (ou uma "Eixo Y - Linha" no combo), a mesma seção mostra uma lista **"Por série"**, embaixo do padrão, onde cada série pode sobrescrever individualmente ("Padrão acima" / "Sempre mostrar" / "Nunca mostrar") — sem precisar ligar/desligar tudo junto.
  - **Colunas/Barras empilhadas são um caso à parte**: ligar "Mostrar rótulos" nesses dois tipos sempre mostra a **soma de todos os segmentos**, uma vez, no topo de cada barra (ex. segmentos 5, 8 e 2 mostram "15") — não é uma opção, é o único comportamento disponível, porque um rótulo por segmento se sobrepõe e quebra a leitura assim que a pilha tem várias séries. Por isso "Posição" e o "Por série" não aparecem pra esses dois tipos.
- **Tabela** (só tipo Tabela): tamanho de fonte, alinhamento do texto, cabeçalho em negrito. **Largura das colunas**: em modo edição, arraste a borda direita de qualquer cabeçalho de coluna para ajustar a largura manualmente (estilo planilha) — cada coluna é independente, então encolher uma não afeta a coluna vizinha (pode truncar bastante o texto, inclusive além do que caberia, sem nenhum mínimo além de um valor bem pequeno). Fora do modo edição a alça não aparece; a largura ajustada fica salva junto com o widget. **Formatação condicional por texto**: ver 3.6.3.
- **Gráfico dinâmico** (linha, área, barra/coluna, combo, pizza, funil, dispersão, histograma): ver 3.6.4.

### 3.6.1 Temas prontos (botão "Temas", modo edição)

Quem gerencia a dashboard (admin ou gerente da pasta) tem, na barra do modo edição, um botão **"Temas"** ao lado de "Formato" — abre uma galeria com 10 temas de cores prontos (Padrão, Sebratel, Oceano, Pôr do sol, Floresta, Roxo vibrante, Corporativo, Vibrante, Monocromático azul, Alto contraste). Cada tema define de uma vez:

- A sequência de cores das séries/fatias (barras, linhas, pizza, funil, dispersão) — sempre com matizes diferentes entre si (não é só um degradê da mesma cor), exceto o "Monocromático azul", que é justamente a exceção deliberada para quem quer esse visual.
- A cor de fundo dos cards de widget.
- UMA cor de texto, aplicada em **título, subtítulo, legenda, eixos X/Y, rótulos de dados e célula/coluna/linha de tabela e matriz** — só nos temas que também definem um fundo de card próprio (hoje "Oceano" e "Alto contraste"): esses usam **branco**, porque o fundo é escuro sempre, independente do tema claro/escuro do app. Os demais temas (a maioria, sem fundo próprio) não tocam a cor do texto — o widget continua sobre o fundo padrão do card, que já muda de claro pra escuro sozinho junto com o tema do app, então uma cor fixa aqui poderia ficar ilegível dependendo do modo.
- Um widget **novo criado depois de aplicar um tema** já nasce com essas mesmas cores (em vez do padrão do app) — assim a guia continua consistente sem precisar reaplicar o tema a cada widget adicionado.

Ao escolher e aplicar um tema, essas cores são sobrepostas em **todos os widgets da guia (aba) atual** de uma só vez — sobrescrevendo qualquer cor já customizada individualmente nesses widgets. Só afeta a guia aberta no momento (outras guias da mesma dashboard não mudam). Como é só rascunho até clicar em "Salvar", dá pra usar "Descartar" se o resultado não agradar. Depois de aplicado, cada widget continua editável normalmente — mudar a cor de um widget específico no editor não é desfeito, só fica "fora do tema" a partir daí.

### 3.6.2 Meta e alertas — formatação condicional

Seção "Meta e alertas" em Formato, disponível conforme o tipo de widget:

- **Meta** (KPI, barra/coluna, colunas empilhadas, combo, histograma, linha, área): um número opcional que desenha uma **linha de referência tracejada** no gráfico e, no KPI, aparece ao lado do valor pra comparação direta ("meta: 100"). Fora do KPI (que não desenha linha), a linha tem **cor e opacidade próprias**, opcionais — sem cor escolhida, usa o vermelho padrão.
- **Regras** (KPI, barra/coluna, colunas empilhadas, combo, histograma, matriz): uma lista de "se o valor for {maior que / maior ou igual a / menor que / menor ou igual a / igual a / diferente de} {número}, aplica {cor de fundo / piscar / brilho}" — avaliadas na ordem da lista, a **última que bater vence** (dá pra empilhar regras em cascata, ex. "verde se ≥ meta" seguida de "vermelho se < meta"). O brilho só é visível no KPI (é o card inteiro que brilha); nos demais tipos, o efeito visível é a cor de fundo da barra/célula e o piscar. Com "Piscar" marcado, aparece a **velocidade** (Super lento / Lento / Normal / Rápido / Super rápido) — padrão "Normal", o mesmo ritmo de sempre.
- Onde o efeito aparece, por tipo de widget:
  - **KPI**: o card inteiro (fundo, piscar, brilho) muda conforme o valor.
  - **Barra/coluna, colunas empilhadas, combo, histograma**: cada barra individual muda de cor conforme o próprio valor (uma barra vermelha ao lado de uma verde, por exemplo) — linha e área do combo não coloram por trecho, só a(s) série(s) de barra. Quando essas barras também têm **rótulo de dados** ligado, cada regra tem um campo **"Aplica em"** (Barra / Rótulo / Ambos, padrão "Ambos") que decide onde a cor e o piscar aparecem: só na barra (o número ao lado fica sempre na cor de sempre), só no rótulo (a barra fica sempre na cor de sempre), ou nos dois — e nesse caso o piscar dos dois é **sincronizado** (mesma fase, não cada um piscando por conta própria).
  - **Matriz**: cada célula (linha × coluna) muda de cor e pode piscar conforme o próprio valor.
  - **Linha, área**: só a linha de meta (referência) — sem coloração condicional (uma linha contínua não tem "pedaços" discretos pra colorir).
- Regras e meta são independentes — dá pra usar só uma das duas, ou as duas juntas.

### 3.6.3 Formatação condicional por texto (só Tabela)

Seção **"Formatação condicional (tabela)"** em Formato, só no tipo Tabela — motor separado do de 3.6.2: em vez de comparar um número contra um limiar, compara o **texto** de cada célula contra uma palavra, frase ou valor.

- Cada regra escolhe uma **coluna** (dentre as já adicionadas à tabela), um **operador** ("é igual a" ou "contém"), o **texto** a comparar, e o efeito: **cor da fonte**, **cor de fundo**, e/ou **piscar** — qualquer combinação dos três.
- Não diferencia maiúsculas de minúsculas nem espaço nas pontas: uma regra para "sim" também bate em "Sim", "SIM" ou " sim ".
- Quantas regras quiser, por quantas colunas quiser. Dentro da mesma coluna, se mais de uma regra bater na mesma célula, a **última da lista vence** (mesma lógica de "última regra vence" de 3.6.2). Regras de colunas diferentes nunca competem entre si.
- Exemplo: uma regra "coluna Status é igual a **sim** → fonte verde + piscar" e outra "coluna Status é igual a **não** → fonte vermelha" aplicam o efeito certo em toda célula daquela coluna que tiver exatamente aquele texto — sem precisar editar linha por linha.
- **Aplica em** (Célula / Linha inteira): por padrão a regra colore só a célula que bateu. Trocando para "Linha inteira", quando a coluna escolhida bate, **todas as colunas daquela linha** recebem a mesma cor/fundo/piscar — não só a coluna avaliada. Se uma regra de linha e uma regra de célula (de outra coluna) baterem na mesma linha ao mesmo tempo, a regra de **linha** vence.
- Quando o piscar está ligado em mais de uma célula ao mesmo tempo, todas piscam **sincronizadas** (mesmo mecanismo de 3.6.2/relatado no piscar de barra+rótulo). Com "Piscar" marcado, aparece a mesma **velocidade** de 3.6.2 (Super lento / Lento / Normal / Rápido / Super rápido) — células/linhas de velocidades diferentes continuam cada uma no próprio ritmo, só as do MESMO ritmo ficam em fase.

### 3.6.4 Gráfico dinâmico

Seção **"Gráfico dinâmico"** em Formato — disponível em todo tipo com uma forma pra desenhar: linha, área, barra/coluna (simples e empilhada), combo, pizza, funil, dispersão e histograma. **Não existe em KPI, Tabela e Matriz** (número, texto e grade não têm o que "desenhar" desse jeito).

- **Ativar**: liga um ciclo que se repete sozinho, pra sempre, enquanto o widget estiver na tela — não depende do dado mudar. Cada tipo de gráfico "desenha" à própria maneira:
  - **Linha / Área**: a linha (ou a área preenchida) traça do início ao fim do eixo X e, ao terminar, desaparece e recomeça do início.
  - **Barra / Coluna** (simples, empilhada, e as barras de um combo/histograma): cada categoria cresce até o próprio valor, na ordem em que aparece no gráfico (esquerda → direita) — uma termina de crescer, a próxima começa. Empilhada: os segmentos daquela categoria crescem juntos, como uma coluna só.
  - **Pizza / Funil / Dispersão**: a própria animação de entrada de cada um (a pizza varre as fatias, o funil desce os segmentos, a dispersão distribui os pontos), só que repetindo em loop.
- **Velocidade do ciclo** (Super lento / Lento / Normal / Rápido / Super rápido, aparece só com "Ativar" marcado): controla quanto tempo o ciclo INTEIRO leva — do começo do desenho até o fim, sem pausa parado no cheio; ele termina de desenhar bem na hora de recomeçar.
- Puramente visual: não muda o dado, não afeta o que a IA lê do gráfico (3.7-quater) nem a leitura/explicação do widget (3.14).
- Uma barra que também obedece uma regra de "Meta e alertas" (3.6.2, cor/pisca condicional) continua obedecendo normalmente — as duas animações (crescer + piscar) tocam juntas na mesma barra quando os dois estão ativos.

### 3.7 Fontes de dados — visão geral

Existem **dois** tipos de fonte, e a principal é o Data Hub:

| Tipo | Onde se cadastra | Para quê |
|---|---|---|
| **Data Hub / lakehouse** (3.7-ter) | Configurações | Todo dado corporativo. É o barramento. |
| **Planilha do Google** (3.7-bis) | Editor de widget → Modificadores | Dado que ninguém vai publicar no Data Hub: lista mantida à mão, de-para, apoio. |

> **Não existe mais catálogo de queries SQL.** Até 29/07/2026 esta tela tinha um catálogo de queries que batiam direto no Postgres do ERP e no MariaDB. Ele foi removido: manter os dois caminhos significava consumir duas plataformas grandes pela mesma informação, e o lakehouse existe justamente para ser o ponto único. Hoje o app não tem driver de banco nem credencial de banco — se você precisa de um dado novo, publique o dataset no Data Hub.

Dois recursos valem para qualquer fonte:

- **Campo de fonte relacionada** (qualquer papel do widget — Eixo X, Eixo Y, Legenda, Filtro, coluna de Tabela): declare o relacionamento uma vez na aba "Relacionamentos" (3.2-bis) — a partir daí, os campos da fonte relacionada já aparecem prontos nos seletores deste widget, sem configurar nada aqui em Modificadores.
- **Dicionário & Tipo de dado** (Configurações, só admin edita): uma descrição livre por campo de qualquer fonte — o que ele significa, de onde vem. Aparece automaticamente como um balão de informação (i), igual aos que já explicam Dados/Modificadores/Formato, ao lado do campo em qualquer seletor do Builder (Eixo X/Y, Legenda, Filtro, colunas de tabela) — pra qualquer usuário, não só quem escreveu. Campo sem descrição não mostra nada extra. É também o que a IA lê para entender o significado de cada coluna (3.7-quater).
  - **Tipo de dado** (mesma tela, ao lado da descrição): o app **infere sozinho** se um campo é número, data ou texto/categoria, olhando uma amostra dos dados reais — e às vezes erra (uma data num formato que não é "AAAA-MM-DD" vira texto; um código numérico de identificação vira "número", como se pudesse ser somado). Um seletor **estilo Power BI** (Número Decimal/Decimal fixo/Inteiro/Percentual, Data/Hora/Data e hora/Data-Hora-Fuso/Duração, Texto/Verdadeiro-Falso/Binário) deixa sobrescrever isso campo a campo. A sobrescrita muda de verdade: em quais seletores o campo aparece (medida numérica vs. dimensão), se um filtro daquele campo nasce como intervalo de datas ou seleção múltipla, e como a IA descreve o campo pra si mesma. Selecionar "Automático" de volta remove a sobrescrita. **Limite desta versão**: várias das opções do menu (ex. Decimal/Decimal fixo/Inteiro, ou Data/Data-Hora/Hora) mudam o comportamento da MESMA forma — ainda não existe formatação visual por subtipo (casas decimais, símbolo de %, hora sem data junto); o valor escolhido fica salvo, pronto pra uma formatação futura usar.

### 3.7-bis Fontes de dados — planilhas do Google (qualquer usuário)

**Qualquer usuário autenticado** pode cadastrar a própria planilha do Google Sheets e usar as colunas dela em qualquer gráfico/tabela, sem depender de um administrador:

- No editor de widget, aba **Modificadores** → seção **"Planilhas do Google"**: cole o link da planilha (precisa estar acessível pela sua própria conta Google — ver permissões abaixo), dê um nome, e opcionalmente informe qual aba usar (padrão: a primeira). Dá para cadastrar quantas planilhas quiser.
- Depois de cadastrada, a planilha aparece como mais uma fonte no seletor da aba **Dados** — igual a um dataset do Data Hub — e todos os tipos de gráfico/tabela/matriz funcionam com ela normalmente.
- **Permissão**: o app lê a planilha com a **sua própria conta Google** (mesma conta do login) — só funciona se essa conta já tem acesso à planilha no Drive (compartilhada com você, ou você é o dono). Não é preciso deixar a planilha pública.
- **Atualização**: os dados ficam em cache por até 5 minutos; depois disso, a próxima vez que alguém com acesso à planilha abrir um widget que a usa, ela busca de novo sozinha. Também dá para forçar uma atualização imediata (botão de atualizar, na lista de planilhas em Modificadores).
- **Quem pode editar/remover**: só quem cadastrou a planilha (ou um administrador) — mas qualquer pessoa com acesso ao widget pode **usá-la**, uma vez cadastrada.
- **Requisito único de configuração** (feito uma vez, fora do app): a conta Google usada no login precisa ter concedido a permissão de leitura de planilhas — quem já estava logado antes desse recurso existir precisa **sair e entrar de novo** pra conceder o acesso novo.

### 3.7-ter Fontes de dados — datasets do Data Hub / lakehouse (só administrador)

A fonte **principal** do app, e o caminho para todo dado corporativo. O lakehouse é o **barramento**: cadastra-se aqui um dataset já publicado lá, e o app lê pela API pública dele. Quem consome não precisa de credencial de banco nenhuma — e o app, de propósito, não tem como alcançar banco algum.

- **Onde**: Configurações → seção **"Data Hub (lakehouse)"** → **"Nova fonte"**. **Só administradores** cadastram: desde 30/09/2026 a tela de Configurações não aparece para o usuário Padrão, e as rotas `lakehouse-sources` recusam quem não é admin (403). O usuário Padrão usa, no Builder, as fontes liberadas para as pastas dele.
- **O que preencher**: um nome (é o que aparece no Builder), o **dataset** (o slug publicado no Data Hub, ex. `clientes-cancelados`), o endereço do Data Hub (já vem preenchido) e o **token de acesso** (gerado no Data Hub, em Integrações). Dá para colar a URL inteira do `curl` no campo de dataset — o endereço, o dataset e o token são extraídos dela automaticamente.
- **Botão "Testar conexão"**: bate no Data Hub sem salvar nada e mostra quantas linhas o dataset tem e quais colunas vão aparecer no Builder, com uma amostra. Ao criar ou editar, esse teste é refeito no servidor: se o token não abrir o dataset, **nada é salvo** e o erro real do Data Hub aparece na tela (token revogado, sem acesso àquele dataset, dataset inexistente).
- **Segurança do token**: é enviado uma vez e guardado **cifrado** no servidor (AES-256-GCM). Nunca volta para o navegador — a tela mostra só uma dica (`dhub_…6T97`). Ao editar uma fonte, deixar o campo de token vazio mantém o token que já está salvo.
- **Atualização**: **tempo real** (todo ciclo do ETL) ou **agendada** (a cada X minutos/horas, mantendo o último dado bom entre execuções). O padrão de uma fonte nova é *agendada, a cada 60 minutos*, porque dataset de lakehouse costuma ser materializado de tempo em tempo. Também há **"Sincronizar agora"**, que dispara a busca na hora. Se uma busca falhar, a fonte mantém o último dado bom e a tela mostra um selo "falhou" com o motivo.
- **Volume**: datasets grandes são buscados em páginas até fechar o total informado pelo próprio Data Hub, com teto de segurança de 500 mil linhas por fonte. O Data Hub entrega no máximo 10 mil linhas por requisição (mesmo que se peça mais), então um dataset de 177 mil linhas vem em 18 idas.
- **Pastas onde a fonte pode ser usada** (admin): por padrão a fonte aparece em **qualquer pasta**; um administrador pode restringi-la a pastas específicas — a partir daí só quem monta uma dashboard dentro delas a vê no seletor de fontes. Isso não afeta o ETL (a fonte continua sendo buscada) e não apaga widget já criado; se a pasta removida já tiver widget usando a fonte, aparece um aviso de confirmação listando o que será afetado.
- **Quem pode editar/remover**: administradores — o mesmo vale para ligar/desligar, mudar o ritmo de atualização e sincronizar. Remover a fonte aqui **não** afeta nada no Data Hub — apaga só o cadastro deste app.
- **Quando ela aparece no Builder**: depois do primeiro ciclo do ETL que a buscar (o cadastro já dispara um).

### 3.7-quater Montar widgets conversando com a IA

No modo edição de uma guia existe um botão **"IA"**, ao lado de "+ Widget" (mesma permissão: quem pode adicionar widget na guia pode usar). Ele abre um painel de conversa lateral onde você descreve o que quer ver e a IA monta os widgets.

- **Como se usa**: marque quais fontes a IA pode usar, escreva o pedido ("monte uma tela com os principais indicadores", "compare o volume por equipe nos últimos meses", "quais os 3 gargalos que os dados mostram?") e a resposta vai aparecendo enquanto ela pensa. Ao terminar, ela apresenta os widgets propostos com tipo e título.
- **Convite em guia vazia**: além do botão "IA", qualquer guia sem nenhum widget (ou com só o widget de texto da guia de boas-vindas) mostra um convite com sugestões de pergunta prontas — clicar numa delas já abre o painel com a pergunta preenchida e enviada, sem precisar digitar do zero. O convite some enquanto o painel estiver aberto.
- **Nada é aplicado sozinho**: você clica em **"Adicionar à guia"** (ou "Descartar"). Aprovar coloca os widgets no rascunho da guia — e, como qualquer edição manual, **ainda depende do "Salvar"** da barra de edição. É deliberado: o modelo pode interpretar mal um pedido ambíguo.
- **Depois de aprovado é um widget normal**: abre no editor de sempre, muda cor, tipo, campo, formatação. A IA dá o ponto de partida, não um objeto especial.
- **O que a IA vê**: os **nomes** dos campos das fontes marcadas, o tipo de cada um (número/data/texto), a descrição escrita no dicionário de dados (3.7) e, para campos de texto, alguns valores de exemplo (até 6) já anexados ao catálogo — junto de um aviso quando o campo parece ser um identificador (muitos valores distintos, tipo nome ou número de protocolo), pra ela saber que não faz sentido usá-lo como dimensão. **As linhas de dados nunca são enviadas** — os exemplos vêm de uma amostra, não da base inteira. Quando precisa de um valor que não apareceu nos exemplos — por exemplo, confirmar se o status é "Concluído" ou "CONCLUIDO" antes de montar um filtro — ela ainda pode consultar os valores distintos daquele campo especificamente, e só aquilo sobe. Para escrever uma leitura de gráfico (3.14) ou um insight dentro da conversa, ela lê o resultado **já agregado** (as mesmas dezenas/centenas de números que o gráfico mostra), não o dataset.
- **Não invento campo**: o que a IA propõe é validado contra o catálogo real antes de chegar na tela. Campo ou fonte inexistente é recusado e devolvido pra ela corrigir na mesma conversa — em vez de gerar um widget quebrado.
- **Aparência**: por padrão os widgets nascem com a aparência padrão do app/tema da guia, igual a um widget feito à mão — a IA não mexe nisso sozinha, e widgets "todos no mesmo padrão" é o comportamento esperado quando ninguém pediu nada sobre visual. Se o pedido incluir algo sobre cor, visual, design, tamanho ou variedade ("cores diferentes", "deixa mais variado", "títulos maiores", "fica vermelho se passar de tal valor"), ela tem acesso a **tudo que o editor manual permite ajustar na aba Formato** — cor e paleta de série, fundo do card e sua opacidade, opacidade do gráfico, cor dos ícones, linhas de grade, sombra/brilho/piscar, formatação de texto completa (título, subtítulo, eixos, legenda, linhas/colunas da matriz), rótulos de dado (gerais e por série), formatação de tabela, meta/alertas (3.6.2), formatação condicional por texto da tabela (3.6.3) e Gráfico dinâmico (3.6.4) — e aplica o que fizer sentido pro pedido, variando de verdade entre os widgets propostos. Posição na grade (x/y) nunca é decidida pela IA, sempre pelo mesmo mecanismo anti-sobreposição usado no resto do Builder.
- **Insights**: peça uma análise e ela pode devolver um widget de **texto** com o que os números mostram — que fica salvo na guia como qualquer outro widget.
- **Medidas comparativas e cálculos**: pedidos do tipo "últimos 3 meses comparado com o mesmo período do ano passado", "percentual de X sobre Y", "percentual de reincidência sobre o total" (isolando um status/categoria), ou qualquer conta que combine dois números — inclusive de fontes diferentes — fazem a IA propor **medidas nomeadas** (ver 3.5-bis) em vez de tentar forçar isso num filtro/dimensão comum. Mesmo fluxo de aprovação dos widgets: ela apresenta as medidas propostas, você aprova (ou descarta), e elas entram na tabela de medidas da dashboard — que também depende do "Salvar". Quando o pedido também envolver VER o resultado, ela já propõe um widget (normalmente um Card) usando a medida recém-criada, na mesma resposta. Toda medida que for uma taxa/percentual (nome "Taxa de..."/"% de...", ou fórmula que termina multiplicando por 100) já vem marcada pra mostrar o sinal "%" no Card, sem precisar pedir. **Editar uma medida já existente** ("marca a Taxa de X como percentual", "muda o filtro dessa medida", "renomeia essa medida") é reconhecido como uma ATUALIZAÇÃO — tela de aprovação própria (ícone de lápis) — e não cria uma medida nova; só quando o pedido for claramente sobre algo novo é que uma medida nova é proposta, e se o nome escolhido colidir com uma já existente, ela é salva com um sufixo automático ("Nome (2)") em vez de dar erro. **Não é só sob pedido explícito**: mesmo num pedido vago numa dashboard nova ("monte os principais indicadores"), se o assunto tiver uma taxa/percentual/comparativo óbvio pro domínio (ex. taxa de reincidência, crescimento vs. ano anterior), a IA é instruída a considerar isso como um dos indicadores da resposta, criando a medida por conta própria — a mesma liberdade que ela já tem pra escolher o TIPO de gráfico sem o pedido especificar. **Limites conhecidos** (não é qualquer cálculo): a IA não sabe propor arredondamento, mínimo/máximo nativo, um "se isso então aquilo" com um texto como resultado (ex. "Crítico"/"Normal"), desvio padrão/mediana, nem uma medida como série ao longo do tempo (ex. "acumulado mês a mês") — ver item 2.16 do `MELHORIAS_FUTURAS.md`.
- **Acesso**: a conversa só alcança fontes que você já veria no Builder daquela pasta (as mesmas regras de 3.7 e 3.12 valem, sem exceção).
- **Custo e limite**: cada interação custa centavos e o painel mostra, no canto, quanto você já gastou hoje e qual o limite diário. Batendo o limite, o campo de mensagem bloqueia até o dia seguinte (ajustável em Configurações › Provedor de IA). Passar o mouse no contador diz qual provedor e modelo responderam; um asterisco ao lado avisa que o modelo escolhido está **sem preço cadastrado** — nesse caso o contador fica em zero por falta de tabela, não por a IA ser gratuita.
- **A conversa fica guardada durante a sessão, uma por dashboard**: fechar o painel, trocar de dashboard e voltar, ou recarregar a página (F5) não apaga nada — as mensagens, as propostas (inclusive se já foram adicionadas) e a memória da IA continuam de onde pararam. Fechar o painel no meio de uma resposta também não a perde: ela termina em segundo plano e está lá ao reabrir. Cada dashboard tem a sua conversa. **Sair do sistema, ou fechar a aba do navegador, apaga tudo.** Uma resposta que a conexão ou um F5 cortou no meio fica na tela com o aviso "Resposta interrompida".
- **Nova conversa**: o botão ↺ no topo do painel (com confirmação) apaga a conversa daquela dashboard e reabre a escolha de fontes — o que já foi adicionado à guia continua lá.
- **Trocar de fontes**: a seleção trava depois da primeira mensagem — para mudar, use **Nova conversa**.
- **Onde fica guardada**: o que aparece na tela vive no navegador (`sessionStorage` da aba, apagado no logout); a memória da IA vive no servidor, só em memória — nada vai para disco. O servidor esquece uma conversa depois de 2 horas sem uso ou quando a API reinicia (um redeploy, por exemplo); nesse caso, a próxima mensagem retoma a conversa sozinha, reenviando à IA o que já foi dito na tela (só o texto, com teto de tamanho), e ela segue de onde parou.
- **Requisito de configuração**: uma credencial de provedor cadastrada em Configurações › Provedor de IA (3.7-quinquies). Sem ela o botão continua aparecendo, mas o painel avisa que a IA não está configurada; o resto do app não é afetado.

### 3.7-quinquies Provedor de IA (Configurações, só admin)

Até 10/09/2026 a IA era configurada **só por variável de ambiente** (`ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT`, `AI_DAILY_BUDGET_USD`): trocar de modelo ou de orçamento exigia editar o `.env` do container e reiniciar a API — no Portainer, um redeploy da stack — e quem administra a ferramenta não tem acesso a esse arquivo. Agora é um formulário em **Configurações › Provedor de IA**, visível só para administradores.

- **Provedores**: Anthropic (Claude), OpenAI e Google Gemini. A credencial é guardada **por provedor**, então alternar entre dois para comparar custo não obriga a recadastrar a chave a cada ida e volta. A troca vale a partir do pedido seguinte; conversa já aberta termina no provedor em que começou.
- **Credencial**: cifrada em repouso (mesma chave dos tokens do Data Hub, `SECRETS_KEY`) e **nunca devolvida ao navegador** — o campo mostra só o começo e o fim da chave salva. Apagar o campo e salvar remove a credencial. O botão **Testar** faz uma chamada mínima ao provedor antes de salvar e mostra a resposta dele: é o que diferencia "chave errada" de "modelo inexistente" de "sem saldo".
- **Modelo**: a lista vem do **próprio provedor**, perguntada com a credencial cadastrada (botão **Escolher**, que abre um diálogo com busca) — os três têm endpoint de listagem, e assim a tela mostra o que aquela conta realmente alcança, em vez de uma lista embutida que envelhece em silêncio. Só entram modelos que geram conteúdo: no Gemini, os de embedding são filtrados; na OpenAI, os de áudio/imagem/embedding também. O campo segue **digitável**, para um id que a listagem não devolva. Escolher um modelo conhecido traz o preço dele preenchido; para os demais, o preço entra zerado e a tela avisa.
- **Preço por milhão de tokens**: editável, porque é o que alimenta o medidor de gasto e o orçamento diário — e preço de API muda sem avisar. Modelo sem preço conhecido entra com **zero**, e a tela avisa: um valor plausível e errado somando dinheiro que ninguém gastou é pior que um zero explícito.
- **O que só existe na Anthropic**: o controle de **esforço** e o **cache de prompt** por requisição. Nos outros dois o esforço aparece desabilitado com a explicação (em vez de desaparecer, que enganaria quem clica), e a tela avisa que sem cache de prompt o catálogo de campos é reenviado a cada ida — o custo por conversa fica maior.
- **Endpoint (opcional)**: por provedor. Vazio usa o oficial; serve para gateway/proxy da empresa e para serviço compatível com a API do provedor.
- **Gravação em rascunho**: as alterações ficam locais até você clicar em **Salvar** (com contagem do que mudou e **Descartar** ao lado). São campos que fazem sentido juntos — trocar de provedor implica trocar chave e modelo —, e salvar a cada tecla deixaria o servidor operando meia configuração.
- **Nada vem do ambiente**: nenhuma variável de IA é lida. Houve uma fase de transição em que o `.env` valia como semente; ela foi removida a pedido, porque semente é uma segunda fonte de verdade para a mesma decisão — dois lugares onde procurar "qual modelo está rodando", e um deles mentindo assim que alguém salva pela tela. Consequência aceita: **instalação nova sobe com a IA não configurada**, e alguém cadastra o provedor na tela (é explícito e visível, ao contrário de uma chave herdada de um arquivo que ninguém lembra de ter preenchido). A troca de provedor entra no log de auditoria (aba Acessos) com provedor e modelo — nunca com a credencial.
- **Não versionado**: `data/aiConfig.json` é a única exceção à decisão de versionar `data/` — a chave cifrada mais a `data/.secret-key` versionada, no mesmo repositório, equivalem a publicar a credencial em claro.

### 3.8 Como os dados são atualizados

- Um processo separado ("agendador de ETL") roda o ciclo base de atualização a cada poucos minutos (hoje, 2 minutos por padrão). Nesse ciclo, cada dataset do Data Hub (3.7-ter) decide se é a vez dela de rodar. Planilhas do Google não entram nesse ciclo: elas dependem do login de quem está usando, e por isso são resolvidas dentro da requisição (3.7-bis).
- Editar, criar, remover, ativar ou desativar uma fonte do Data Hub também dispara uma atualização em segundo plano na hora.
- Uma fonte cuja busca falhe **mantém o último dado bom** em vez de zerar, e é tentada de novo no ciclo seguinte. Um dataset cujo token foi revogado, por exemplo, mantém o último dado bom e mostra o motivo da falha na tela.
- **Importante**: a atualização acontece no servidor. Uma aba do navegador já aberta **não recarrega os dados sozinha** — é preciso dar F5, a menos que a aba tenha a opção **"Atualização automática"** ligada (em Configurações de tela, por aba): nesse caso, os widgets da aba buscam dado novo sozinhos, em segundo plano, no intervalo definido, sem piscar a tela — pensado para telas fixas expostas sem interação (ex. TV de um setor).

### 3.9 Autenticação e acesso

- Login com conta Google via **Firebase Authentication** (projeto `authentication-dashboardsia`, um por sistema), restrito a contas do domínio **@sebratel.com.br**.
- **Como funciona**: clicar em "Entrar com Google" abre um popup pelo SDK do Firebase — que vem **no bundle**, pelo npm, e não é baixado do Google em tempo de execução. O Google devolve um **ID token assinado**, o navegador manda esse token ao servidor uma única vez, e o servidor confere a **assinatura localmente**, com a chave pública do Google guardada em cache (inclusive em disco). Fechando, abre-se a sessão: um **cookie HttpOnly** com id opaco.
- **Por que assim** (padrão da casa, skill `padrao-login-sso`): o método anterior — fluxo de código de autorização conduzido pelo servidor — dependia da saída para o Google *a cada* validação. Com a verificação local, depois de buscar os certificados uma vez a API valida login **sem tocar na rede**; se a saída cair, quem tem token válido continua entrando. Foi essa diferença que fez o HUBBI sobreviver a um bloqueio que derrubou outro sistema.
- **O domínio é validado no servidor.** O `hd=sebratel.com.br` que o cliente manda ao Google só filtra o seletor de contas (evita escolher a conta pessoal e tomar "sem acesso" depois) — não é controle de acesso.
- **Duração**: a sessão vale 30 dias por padrão (configurável). O ID token do Firebase vence em 1 h, mas ele só prova quem é **na hora de entrar**; quem sustenta a navegação é a sessão. **Sair** encerra a sessão no servidor e também o vínculo com o Google no navegador — sem isso, "Sair" e "Entrar" voltaria com a mesma conta sem perguntar nada.
- **Fonte por planilha do Google**: o `access_token` capturado no popup é guardado cifrado na sessão e serve por ~1 h (o fluxo web do Firebase não devolve credencial de renovação). Vencido, as planilhas respondem pelo **cache** até o próximo login — e isso **não** derruba a sessão, de propósito.
- A tela de **Configurações** (fontes do Data Hub, provedor de IA, dicionário) é só de administradores: o usuário Padrão não a vê no menu nem na engrenagem do topo, e o endereço `/configuracoes` o devolve para o início (ver 3.7-ter). Dashboards, pastas e guias já têm controle de acesso por usuário — ver 3.1 e 3.12. A aba **Acessos** (3.11) e a gestão de **pastas** (3.1/3.12) também são restritas a administradores.

- **Bypass do login em desenvolvimento** (`AUTH_DISABLED=true` no `.env`, nunca em produção): a API deixa de exigir o cookie de sessão e atende toda requisição como o e-mail de `AUTH_DISABLED_EMAIL` (padrão `misael.cruz@sebratel.com.br`, que precisa ser do `ALLOWED_DOMAIN` — se não for, a API não sobe). Existe para conseguir abrir telas internas no navegador **sem ter uma sessão** — era o motivo de tanta alteração no histórico vir com "não testado num navegador de verdade". (A justificativa original dizia que o login não passava pelo firewall daqui; medido em 12/09/2026, passa — ver o histórico.) Só o `requireAuth()` muda: permissão continua sendo resolvida pelo e-mail (admin, acesso a pasta, acesso a guia), então o que aparece na tela é o que aquela pessoa veria logada — não é "modo deus". Duas consequências durante o teste: não existe token do Google na requisição, então fonte de **planilha** só responde pelo cache (banco e Data Hub funcionam normal); e o botão **Sair** leva pra tela de login, mas um F5 entra de novo (não há sessão pra encerrar). A API avisa em letras garrafais na subida enquanto a flag estiver ligada.

### 3.10 Modo escuro

- Alternável a qualquer momento (ícone de sol/lua no topo), a preferência fica salva no navegador de cada pessoa (não é uma config compartilhada).

### 3.11 Gestão de acessos (aba "Acessos")

- Visível só para administradores; para os demais usuários, a aba fica escondida no menu e a API recusa o acesso (403).
- **Pedidos de acesso a pastas**: o card do topo lista os pedidos feitos pela página Manual de uso (3.15) que esperam resposta — quem pediu, a pasta, a mensagem e a data —, com **Liberar** e **Recusar** (com confirmação). O número de pendentes aparece ao lado de "Acessos" no menu, atualizado a cada minuto.
- **Usuários**: todo mundo que já logou pelo menos uma vez, com primeiro e último acesso.
- **Papel (Admin/Padrão)**: qualquer administrador pode promover ou rebaixar outro usuário direto na tabela (com confirmação antes) — vale só para quem já acessou pelo menos uma vez. Quem entra pela primeira vez entra como **Padrão**. A lista de e-mails em `ADMIN_EMAILS` (env) ou no código de `server/accessLog.mjs` só vale enquanto a instalação não tem **nenhum** administrador salvo (instalação nova, ou `data/users.json` perdido): nesse caso, quem está nela entra como admin, para o sistema não nascer sem ninguém que libere acesso. Existindo um admin, a lista não dá papel a ninguém — um e-mail dela que entre depois é Padrão até ser promovido aqui. O sistema nunca deixa remover o último administrador restante. Esse papel é diferente de "gerente de pasta" (3.1/3.12) — um usuário `padrão` pode ser gerente de uma ou mais pastas sem virar administrador global.
- **Online agora**: calculado por "visto nos últimos 90 segundos" — o navegador manda um sinal (heartbeat) a cada 45s enquanto a aba está visível, então uma tela aberta e parada ainda aparece online.
- **Log de ações**: registra criar/editar/remover/ativar/desativar/reagendar uma fonte do Data Hub, iniciar conversa com a IA, criar/editar/remover pasta ou dashboard, alterar acesso de pasta/guia, salvar guias/widgets e login/logout — com quem fez, quando e o alvo da ação. Guarda as últimas 5.000 ações (as mais antigas são descartadas).
- Não registra leituras (visualizar um gráfico, abrir uma guia) — só ações que mudam alguma configuração, para o log continuar útil e legível.

### 3.12 Permissões por pasta, dashboard e guia

Resumo de quem pode fazer o quê (ver 3.1 pra contexto):

| Ação | Quem pode |
|---|---|
| Criar/editar/remover pasta | Administrador |
| Definir quem acessa uma pasta (aberta a todos ou pessoas escolhidas entre quem já acessou o sistema) | Administrador |
| Nomear gerente(s) de uma pasta | Administrador |
| Criar, renomear e remover dashboard dentro de uma pasta | Administrador ou gerente daquela pasta |
| Gerenciar a estrutura de uma dashboard (guias, filtros, relacionamentos entre fontes, medidas, formato) | Administrador ou gerente da pasta |
| Definir quem vê e quem edita cada guia | Administrador ou gerente da pasta |
| Ver uma guia | Administrador, gerente da pasta, ou usuário liberado (visualização ou edição) naquela guia especificamente |
| Editar os widgets de uma guia | Administrador, gerente da pasta, ou usuário com edição liberada naquela guia |

Duas coisas importantes sobre como esses acessos se combinam:
- **Acesso à pasta é um pré-requisito**: liberar a visualização/edição de uma guia pra alguém só faz efeito se essa pessoa também tiver acesso à pasta onde a dashboard vive — são dois controles em separado, e o de pasta é sempre do administrador.
- **"Ver" e "Editar" são independentes**: dá pra liberar só visualização, ou visualização + edição, pra cada usuário em cada guia. Um usuário pode ter edição numa guia e só visualização (ou nada) em outra da mesma dashboard.

O seletor de e-mails usado pra liberar acesso de guia mostra só quem **já tem acesso à pasta** — nunca a lista de todos os usuários do sistema.

### 3.13 Comentários em widgets

Todo widget tem um ícone de balão de comentário no cabeçalho, visível tanto em modo visualização quanto em edição. Clicar mostra os comentários já deixados (autor, data, texto) e um campo pra escrever um novo. Qualquer usuário autenticado pode comentar — não precisa ter permissão de editar aquele widget, já que é uma anotação de leitura/colaboração ("esse pico em março foi por causa da campanha X"), não uma mudança na configuração do widget. Remover um comentário é restrito a quem escreveu ou a um administrador. Um número no ícone indica quantos comentários existem.

### 3.14 Leitura e explicação de um widget

Ao lado do ícone de comentário, todo widget tem um ícone de leitura no cabeçalho (visível em qualquer modo). Ele abre um popover com duas respostas diferentes, cada uma resolvida do jeito que faz sentido para o que promete:

- **Como foi calculado**: não passa pela IA. É o próprio `WidgetConfig` traduzido em texto — fonte, agregação, agrupamento, filtros (do widget e da guia) e recorte de datas, incluindo as descrições já escritas no dicionário de dados (3.7). Por não depender de nenhum modelo, é instantâneo, grátis, e não é uma explicação plausível do cálculo — é o cálculo.
- **O que os dados dizem**: aqui sim é a IA, sob demanda (um clique, nunca automático ao abrir a tela — um gráfico não pode gerar custo só por estar na dashboard). Sobe pro modelo só o resultado já agregado que o próprio gráfico desenha (as dezenas/centenas de pontos, não a base). Usa o mesmo teto de gasto diário do assistente de montagem (3.7-quater), não um orçamento separado. A resposta fica em cache por alguns minutos — reabrir o mesmo gráfico sem mudar nada responde na hora, sem custo.
- **Fixar a leitura**: em modo edição, a leitura gerada pode ser fixada no widget — passa a ficar salva com a dashboard (depende do "Salvar", como qualquer edição) e todo mundo que abre o widget lê o mesmo texto, sem gerar de novo. Se os dados mudarem depois de fixado, o texto não desaparece nem passa por atual: aparece um aviso de que a leitura pode estar desatualizada.

### 3.15 Manual de uso e pedido de acesso às pastas

- **Onde**: item **Manual de uso** no menu lateral, para qualquer usuário (rota `/manual`).
- **Quando a pessoa cai nele sozinha**: no **primeiro acesso** — antes de qualquer dashboard — e sempre que ela **não tiver nenhuma dashboard liberada**. O primeiro acesso fica marcado em `data/users.json` (`manualPending`) até a página ser aberta; quem já usava o sistema antes desta função não é mandado para o manual.
- **O manual**: um PDF, mostrado um slide por vez (pdf.js) — setas, miniaturas, teclado (← →; em tela cheia também PageUp/PageDown, espaço, Home/End; **F** liga a tela cheia, **Esc** sai), arrastar o dedo no celular e **tela cheia**. Só visualização: não há botão de baixar nem de imprimir.
- **Trocar o material**: substituir `manual/manual-de-uso.pdf` por outro PDF com o mesmo nome e publicar. O número de slides é lido do próprio arquivo — não há lista para manter. `MANUAL_PATH` aponta para outro arquivo, se for preciso trocar sem rebuild. O PDF sai pela API (`GET /api/manual`), atrás do login, e cada abertura revalida o arquivo: o novo vale na próxima vez que alguém abrir a página.
- **Pastas do sistema** — no topo da página, antes do manual, porque pedir acesso é o que precisa fazer primeiro quem cai ali sem nada liberado: lista **todas** as pastas, com o status de quem está vendo — **Liberada** (com atalho "Abrir" para a primeira dashboard), **Pedido enviado em…**, **Recusado em…** ou **Sem acesso**. De quem está de fora, a lista mostra só o nome da pasta: dashboards e guias continuam invisíveis até a liberação.
- **Pedir acesso**: "Solicitar acesso" abre um campo de mensagem opcional (até 500 caracteres) para o administrador. Um pedido pendente por pasta; depois de recusado, dá para pedir de novo. A lista se atualiza sozinha a cada 30 s — uma pasta liberada aparece no menu lateral sem recarregar a página.
- **Responder**: só administrador, no card de pedidos da aba Acessos (3.11). **Liberar** acrescenta o e-mail à lista de acesso da pasta (pasta aberta a todos já atende, sem mudança); as guias restritas da pasta continuam dependendo da liberação por guia (3.12). **Recusar** só fecha o pedido. Pedido, liberação e recusa entram no log de ações.

---

## 4. Regras de funcionamento

1. **Só leitura, por construção**: o app não tem driver de banco nem credencial de banco. Ele só consome a API pública de leitura do Data Hub e a API de leitura do Google Sheets — não existe caminho para escrever em lugar nenhum.
2. **Catálogo de fontes é compartilhado**: um único documento salvo no servidor — um administrador cadastra uma fonte, e ela passa a existir para todos. Dashboards/pastas/guias, por outro lado, têm controle de acesso por usuário (ver 3.1/3.12) — cada uma é seu próprio documento dentro do workspace. Além disso, um admin pode restringir **em quais pastas** cada fonte aparece (3.7-ter) — isso controla visibilidade no Builder, não quem edita o catálogo.
3. **Colunas vêm dos dados, não de um cadastro manual**: o tipo de cada campo (número, data ou texto/categoria) é inferido automaticamente olhando uma amostra dos dados reais do dataset.
4. **Cor principal nunca compete com cor de série**: quando há legenda ou múltiplas medidas, cada série tem sua própria cor — a "Cor principal" só vale para o caso de série única.
5. **Duplicar um widget** cria uma cópia com id novo, marcada "(cópia)" no título, posicionada num espaço livre da grade (ou centralizada, se a grade estiver cheia).
6. **Nenhuma ação destrutiva é silenciosa**: remover widget, guia, pasta ou fonte de dados, e descartar alterações, sempre pedem confirmação antes.
7. **Acesso à pasta é sempre o primeiro filtro**: mesmo que alguém tenha visualização/edição liberada numa guia, isso só faz efeito se a pessoa também tiver acesso à pasta onde a dashboard está — os dois controles são independentes, e o de pasta é sempre do administrador.
8. **A guia de boas-vindas nunca pode ficar bloqueada nem ser removida** — é a única guia com acesso sempre aberto por padrão dentro de uma dashboard.

---

## 5. Limitações técnicas atuais

| Limite | Valor | Onde se aplica |
|---|---|---|
| Linhas por fonte no ETL | 500.000 | Corte de segurança contra um dataset gigante cadastrado por engano. |
| Linhas por requisição ao Data Hub | 10.000 | Teto do próprio Data Hub — um dataset maior vem em várias idas. |
| Linhas na amostra do "Testar conexão" | 5 | Só para confirmar o dataset e ver as colunas. |
| Pontos num gráfico (Top N) | até 100 | Mesmo que o Top N configurado peça mais. |
| Séries de Legenda | até 8 | Valores além do 8º são descartados (não somados a "outros"). |
| Valores distintos listados num filtro | até 500 | Popup de seleção de valores de um filtro/filtro fixo. |
| Linhas/colunas numa Matriz | até 500 linhas (por nível) / 50 colunas dinâmicas | Colunas são rankeadas pelo total geral; o excesso é cortado. |
| Amostra para inferir o tipo de um campo | 300 linhas | Só afeta a detecção do tipo (número/data/texto), não os dados exibidos. |
| Ciclo base do ETL | ~2 minutos | Frequência mínima prática de uma fonte "tempo real". |
| Janela para considerar um usuário "online" | 90 segundos | Aba Acessos — heartbeat do navegador a cada 45s. |
| Ações guardadas no log de acessos | 5.000 mais recentes | As mais antigas são descartadas automaticamente. |

---

## 6. O que é possível configurar/fazer

- Organizar dashboards por setor em pastas, com controle de quem acessa cada uma (admin) e quem gerencia cada uma (gerentes de pasta).
- Ter várias dashboards dentro de uma mesma pasta.
- Liberar visualização e/ou edição de uma guia especificamente para um usuário, sem dar acesso às outras guias da mesma dashboard.
- Criar quantas guias, filtros e widgets quiser dentro de uma dashboard, com qualquer combinação de campos das fontes cadastradas.
- Trocar a fonte de um widget a qualquer momento pelo seletor de campos (reseta os campos dependentes).
- Combinar campos de fontes diferentes num mesmo widget (mesclagem por chave).
- Adicionar um widget de texto livre (sem fonte de dados) pra instruções, avisos ou contexto — usado automaticamente na guia de boas-vindas.
- Personalizar cor, fonte, opacidade, fundo e rótulos de praticamente todo elemento visual de um widget, individualmente.
- Ter fontes com ritmos de atualização diferentes entre si (tempo real vs. agendada, cada uma com seu próprio intervalo).
- Ligar atualização automática só nas guias que precisam (ex. TV de painel), deixando as demais só atualizarem por F5.
- Testar a conexão de uma fonte antes de salvar (mostra total de linhas e colunas detectadas), sem afetar a dashboard em produção.
- Pedir para a **IA montar os widgets** conversando, e aprovar antes de aplicar (3.7-quater).
- Sobrepor widgets deliberadamente na grade (não é bloqueado).

## 7. O que NÃO é possível hoje (impossibilidades conhecidas)

- **Não dá para consultar banco de dados direto** — nem para escrever nem para ler. Todo dado corporativo precisa estar publicado como dataset no Data Hub; o app não alcança o Postgres do ERP nem o MariaDB.
- **O cadastro de fontes não tem permissão por usuário** — qualquer pessoa logada pode cadastrar uma fonte do Data Hub, independente de ter acesso a alguma pasta/dashboard (mas só quem cadastrou, ou um admin, edita/remove a dela).
- **Um gerente de pasta não pode se auto-promover a administrador**, nem alterar quem tem acesso à própria pasta (isso é sempre do admin) — só controla o que acontece dentro dela (dashboards e acesso de guia).
- **Liberar acesso de guia pra alguém sem acesso à pasta não tem efeito nenhum** até um admin liberar a pasta também — não é uma forma de contornar o controle de pasta.
- **"Online" na aba Acessos é uma aproximação** (visto nos últimos 90s), não uma sessão real — não há como saber em qual tela/widget a pessoa está, só que o app está aberto e ativo.
- **Não existe atualização instantânea (sub-minuto)**: mesmo "tempo real" depende do ciclo base do agendador (minutos, não segundos).
- **Uma guia aberta não percebe sozinha que o dado mudou**, a menos que a atualização automática daquela guia esteja ligada — não há aviso de "há dados novos, recarregue".
- **Não dá para desfazer uma alteração já salva** (não existe histórico/versionamento de configurações — só existe "Descartar", que funciona antes de salvar).
- **Não dá para exportar** um widget/dashboard (PDF, imagem, Excel) — a visualização é só na tela.
- **Não há alertas ou notificações** (e-mail, Slack etc.) baseados nos dados.
- **Um widget de Legenda ou Matriz tem tetos rígidos** (8 séries; 500 linhas / 50 colunas) — valores além disso são cortados silenciosamente na tela (mostrados só como contagem/log no servidor), não hesitados nem lançados como aviso pro usuário final.
- **Multiplas medidas e Legenda são mutuamente exclusivas** no mesmo gráfico (bar/line/area) — não dá para ter os dois ao mesmo tempo.
- **Scatter e Funil não têm Legenda nem múltiplas medidas.**
- **O widget de texto não tem markdown/formatação rica** — só texto simples com quebras de linha preservadas.
