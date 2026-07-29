# Indicadores Sebratel — Documentação do Projeto

> Documento gerado em 24/07/2026, refletindo o estado do projeto até essa data. Não é atualizado automaticamente — quando o projeto mudar de forma relevante, peça para revisar este arquivo. Para o histórico de mudanças, veja [`HISTORICO_ALTERACOES.md`](HISTORICO_ALTERACOES.md).

---

## 1. Objetivo

O **Indicadores Sebratel** é uma ferramenta interna de **construção manual de dashboards**, no estilo Power BI, para acompanhar indicadores operacionais (hoje focados em Instalação: protocolos, agenda, produtividade, backlog, reincidência, capacidade de equipe etc.).

A ideia central: em vez de páginas fixas de indicadores programadas no código, **qualquer pessoa autorizada monta as próprias telas** — escolhe a query (fonte de dados), o tipo de gráfico/tabela, os campos, a formatação, o layout — sem precisar de um desenvolvedor para cada mudança. O resultado é compartilhado: todo mundo que acessa o sistema vê a mesma dashboard (e as mesmas edições), como um painel de equipe.

---

## 2. Visão geral da arquitetura (resumo)

```
Banco de dados (Postgres "DB_ELLEVEN" e/ou MariaDB "DB_Applicattion")
        │  (queries SQL cadastradas em Configurações)
        │
        │   Data Hub / lakehouse — API pública de leitura
        │   (datasets + token cadastrados em Configurações; o lakehouse
        │    funciona como BARRAMENTO, sem acesso direto à origem)
        │
        ▼
Catálogo de fontes (data/queries.json + data/lakehouseSources.json)
        │  (ETL — roda periodicamente ou sob demanda)
        ▼
Snapshot em memória (public/installData.data, gzip)
        │  (API Express: /api/widget-data, /api/sources, /api/queries, ...)
        ▼
Workspace (data/workspace.json) — Pasta (setor) → Dashboard → Guia → Widgets
        │  (API Express: /api/workspace/*, com checagem de acesso em cada nível)
        ▼
Dashboard Builder (React) — menu de pastas/dashboards, guias, filtros, widgets
```

Não existe um "esquema" fixo de dados: cada query cadastrada vira uma fonte, e as colunas disponíveis para montar gráficos são **inferidas automaticamente** a partir dos dados reais que aquela query retorna (número, data ou texto). Isso significa que qualquer coluna nova no SQL de uma query aparece sozinha no Builder, sem configuração manual.

---

## 3. Funcionalidades

### 3.1 Hierarquia: Pastas → Dashboards → Guias

O conteúdo do app tem 3 níveis, pensados pra organizar setores/equipes diferentes sem misturar tudo numa dashboard só:

- **Pasta** (representa um setor/departamento): o menu lateral tem um cabeçalho **"Dashboards"** que funciona como um dropdown — clique para expandir/recolher a lista de pastas. Dentro dele, cada pasta é ela mesma expansível (mostra suas dashboards) e tem um pequeno **botão de engrenagem** ao lado (só visível pra quem gerencia aquela pasta — admin ou gerente) que abre as configurações daquela pasta específica num modal — não existe uma tela separada "Pastas". Um "+" ao lado do cabeçalho "Dashboards" (só admin) abre o mesmo modal em modo de criação. Só **administradores** criam, renomeiam ou removem uma pasta, e só administradores decidem **quem tem acesso** a ela — sem acesso, a pasta nem aparece no menu de quem não foi liberado.
- **Dashboard**: vive dentro de uma pasta; uma pasta pode ter várias. Cada uma tem seu próprio conjunto de guias.
- **Guia** (o que antes era chamado de "aba"): vive dentro de uma dashboard — é onde ficam os widgets de fato. Ver 3.2 pra funcionalidade da guia em si (inalterada) e 3.12 pra quem pode ver/editar cada uma.

**Gerente de pasta**: o administrador pode nomear um ou mais usuários como gerentes de uma pasta específica (o mesmo usuário pode ser gerente de uma pasta e não ter nenhum poder especial em outra). Dentro da própria pasta, um gerente pode:
- Criar novas dashboards.
- Decidir quem vê e quem edita cada guia das dashboards daquela pasta (ver 3.12).

Um gerente **não** precisa ser administrador global — o poder dele vale só dentro da pasta em que foi nomeado.

Toda dashboard nova (criada por um admin ou por um gerente de pasta) já nasce com uma **guia de boas-vindas**, sempre visível pra qualquer um que acesse a pasta, com um texto explicando o funcionamento do app. Todas as outras guias — criadas junto ou depois — nascem **bloqueadas**, e só aparecem pra um usuário padrão depois que um admin ou o gerente da pasta libera o acesso dele especificamente naquela guia.

### 3.2 Guias — filtros e layout

- Cada guia tem seu próprio conjunto de widgets e filtros.
- Cada guia pode ter **filtros no topo** (seleção múltipla de valores, ou intervalo de datas), que afetam todos os widgets daquela guia que usam a mesma fonte de dados.
- **Modo edição**: um botão liga/desliga a edição. Fora dele, a tela é só visualização. O que aparece dentro dele depende de quem está editando (ver 3.12):
  - Quem **gerencia a dashboard** (admin ou gerente da pasta) vê tudo: adicionar/editar/duplicar/remover widgets, arrastar e redimensionar, adicionar/remover filtros, gerenciar guias (criar/renomear/remover/reordenar/controlar acesso), e configurar tamanho de tela/atualização automática.
  - Um usuário padrão com **edição liberada numa guia específica** só vê "+ Widget" e "Salvar" — mexe só nos widgets daquela guia, sem acesso a filtros, outras guias ou configurações de tela.
  - Sobrepor um widget em cima de outro é permitido deliberadamente (a grade não empurra os outros sozinha).
- **Salvar/Descartar**: as edições ficam num rascunho local até clicar em "Salvar" — só aí vão para o servidor e passam a valer pra todo mundo com acesso àquela guia/dashboard. "Descartar" volta ao último estado salvo.
- **Pré-visualização em tempo real**: enquanto o painel de edição de um widget está aberto, o próprio widget na tela (atrás do painel) já mostra o resultado das mudanças (cor, tipo de gráfico, campo, formatação) — sem precisar salvar para ver o efeito. Só o botão "Salvar" persiste de verdade.
- **Indicador visual**: o widget que está sendo editado no momento ganha um contorno colorido na grade, para ficar claro qual card corresponde ao painel aberto.

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
| Tabela | Lista de linhas com colunas escolhidas manualmente, incluindo colunas mescladas de outras fontes. |
| Matriz | Tabela dinâmica (pivot): 1+ campos nas linhas (com hierarquia e subtotal por nível), 1+ campos nas colunas (dinâmicas), uma medida por célula. |
| Texto | Bloco de texto livre, sem ligação com nenhuma fonte de dados — usado, por exemplo, na guia de boas-vindas de cada dashboard. Sem markdown; preserva quebras de linha. |

Cada tipo mostra no editor só os campos que ele realmente usa (ex.: Dispersão não tem Legenda; Tabela/Matriz/Texto não têm Eixo X/Y convencionais; Texto não tem aba "Modificadores", já que não depende de nenhuma fonte).

### 3.5 Medidas e agregações

Toda medida (Eixo Y, valor da matriz, medida do eixo X do scatter etc.) escolhe um campo e uma forma de agregar:

- **Contagem** — conta linhas (todas, ou só onde um campo não é vazio).
- **Contagem distinta** — conta valores únicos de um campo (ex. protocolos únicos).
- **Soma** — exige um campo numérico.
- **Média** — exige um campo numérico.

Um gráfico de barras/linha/área pode ter **múltiplas medidas** (cada uma vira uma série colorida), ou uma **Legenda** (quebra a mesma medida em várias séries por valor de um 2º campo) — as duas coisas são mutuamente exclusivas no mesmo widget.

### 3.6 Formatação visual (aba Formato)

- **Título e Subtítulo**: texto + tamanho de fonte, negrito/itálico/sublinhado, cor do texto (com opacidade) e cor de fundo (com opacidade).
- **Cor principal**: cor do gráfico quando há uma única série (não afeta título nem séries com cor própria).
- **Opacidade das colunas/linhas/fatias**: um slider que deixa todo o preenchimento do gráfico mais transparente.
- **Aparência do widget**: cor de fundo do card inteiro (com opacidade), cor dos ícones de editar/duplicar/excluir, e três efeitos visuais fixos — **sombra**, **brilho** e **piscar** — sempre ativos quando ligados (independente do dado).
- **Meta e alertas** (motor de formatação condicional — ver 3.6.2): meta (linha de referência no gráfico) e regras de cor/pisca/brilho conforme o valor.
- **Eixo X / Eixo Y**: mesmo conjunto de opções de texto do título (fonte, estilo, cor, fundo) — os eixos reservam espaço extra automaticamente quando a fonte é grande, para não vazar para fora do card. Um campo **"Recuo"** (inferior no Eixo X, lateral no Eixo Y) soma manualmente mais pixels a esse espaço reservado — use quando o cálculo automático ainda não é suficiente (ex. números grandes que aparecem cortados); aceita valor negativo, para apertar o espaço se o automático estiver reservando mais do que precisa.
- **Linhas de grade**: todas, só horizontal, só vertical, ou nenhuma.
- **Legenda**: mesma formatação de texto, aplicada aos rótulos da legenda embaixo do gráfico.
- **Linhas / Colunas (só Matriz)**: formatação de texto para a hierarquia de linhas e o cabeçalho de colunas.
- **Rótulos de dados**: liga/desliga rótulos sobre o próprio gráfico (valor de cada barra/ponto/fatia), com posição (dentro/fora/em cima/centralizado), conteúdo (só número / nome / percentual / nome+número / tudo), tamanho de fonte, cor e opacidade. Esse é o padrão do **widget inteiro**; quando há mais de uma medida no Eixo Y (ou uma "Eixo Y - Linha" no combo), a mesma seção mostra uma lista **"Por série"**, embaixo do padrão, onde cada série pode sobrescrever individualmente ("Padrão acima" / "Sempre mostrar" / "Nunca mostrar") — sem precisar ligar/desligar tudo junto.
- **Tabela** (só tipo Tabela): tamanho de fonte, alinhamento do texto, cabeçalho em negrito. **Largura das colunas**: em modo edição, arraste a borda direita de qualquer cabeçalho de coluna para ajustar a largura manualmente (estilo planilha) — cada coluna é independente, então encolher uma não afeta a coluna vizinha (pode truncar bastante o texto, inclusive além do que caberia, sem nenhum mínimo além de um valor bem pequeno). Fora do modo edição a alça não aparece; a largura ajustada fica salva junto com o widget.

### 3.6.1 Temas prontos (botão "Temas", modo edição)

Quem gerencia a dashboard (admin ou gerente da pasta) tem, na barra do modo edição, um botão **"Temas"** ao lado de "Formato" — abre uma galeria com 10 temas de cores prontos (Padrão, Sebratel, Oceano, Pôr do sol, Floresta, Roxo vibrante, Corporativo, Vibrante, Monocromático azul, Alto contraste). Cada tema define de uma vez:

- A sequência de cores das séries/fatias (barras, linhas, pizza, funil, dispersão) — sempre com matizes diferentes entre si (não é só um degradê da mesma cor), exceto o "Monocromático azul", que é justamente a exceção deliberada para quem quer esse visual.
- A cor de fundo dos cards de widget.
- UMA cor de texto, aplicada em **título, subtítulo, legenda, eixos X/Y, rótulos de dados e célula/coluna/linha de tabela e matriz** — só nos temas que também definem um fundo de card próprio (hoje "Oceano" e "Alto contraste"): esses usam **branco**, porque o fundo é escuro sempre, independente do tema claro/escuro do app. Os demais temas (a maioria, sem fundo próprio) não tocam a cor do texto — o widget continua sobre o fundo padrão do card, que já muda de claro pra escuro sozinho junto com o tema do app, então uma cor fixa aqui poderia ficar ilegível dependendo do modo.
- Um widget **novo criado depois de aplicar um tema** já nasce com essas mesmas cores (em vez do padrão do app) — assim a guia continua consistente sem precisar reaplicar o tema a cada widget adicionado.

Ao escolher e aplicar um tema, essas cores são sobrepostas em **todos os widgets da guia (aba) atual** de uma só vez — sobrescrevendo qualquer cor já customizada individualmente nesses widgets. Só afeta a guia aberta no momento (outras guias da mesma dashboard não mudam). Como é só rascunho até clicar em "Salvar", dá pra usar "Descartar" se o resultado não agradar. Depois de aplicado, cada widget continua editável normalmente — mudar a cor de um widget específico no editor não é desfeito, só fica "fora do tema" a partir daí.

### 3.6.2 Meta e alertas — formatação condicional

Seção "Meta e alertas" em Formato, disponível conforme o tipo de widget:

- **Meta** (KPI, barra/coluna, colunas empilhadas, combo, histograma, linha, área): um número opcional que desenha uma **linha de referência tracejada** no gráfico e, no KPI, aparece ao lado do valor pra comparação direta ("meta: 100").
- **Regras** (KPI, barra/coluna, colunas empilhadas, combo, histograma, matriz): uma lista de "se o valor for {maior que / maior ou igual a / menor que / menor ou igual a / igual a / diferente de} {número}, aplica {cor de fundo / piscar / brilho}" — avaliadas na ordem da lista, a **última que bater vence** (dá pra empilhar regras em cascata, ex. "verde se ≥ meta" seguida de "vermelho se < meta"). O brilho só é visível no KPI (é o card inteiro que brilha); nos demais tipos, o efeito visível é a cor de fundo da barra/célula e o piscar.
- Onde o efeito aparece, por tipo de widget:
  - **KPI**: o card inteiro (fundo, piscar, brilho) muda conforme o valor.
  - **Barra/coluna, colunas empilhadas, combo, histograma**: cada barra individual muda de cor conforme o próprio valor (uma barra vermelha ao lado de uma verde, por exemplo) — linha e área do combo não coloram por trecho, só a(s) série(s) de barra.
  - **Matriz**: cada célula (linha × coluna) muda de cor e pode piscar conforme o próprio valor.
  - **Linha, área**: só a linha de meta (referência) — sem coloração condicional (uma linha contínua não tem "pedaços" discretos pra colorir).
- Regras e meta são independentes — dá pra usar só uma das duas, ou as duas juntas.

### 3.7 Fontes de dados — o catálogo de queries (Configurações)

- Cada **query SQL** cadastrada vira uma fonte de dados selecionável no Builder.
- Cadastro/edição tem um botão **"Testar"**, que roda o SQL ao vivo (capado em 50 linhas) sem salvar nada — só para validar antes de confirmar.
- Cada query pode ser **ativada/desativada** — desativada, ela não é buscada e some do catálogo de fontes até ser reativada de novo (os widgets que a usavam ficam sem dado, mas não são apagados).
- Cada query escolhe, **individualmente**, como é atualizada:
  - **Tempo real**: roda em todo ciclo do motor de atualização (ver 3.8).
  - **Agendada**: só busca dado novo a cada X minutos/horas definidos por ela — entre uma execução e outra, mantém o último dado bom (não some da dashboard).
  - É possível ter várias queries com modos e intervalos diferentes ao mesmo tempo — não existe uma configuração "global" de atualização.
- **Pastas onde a query pode ser usada** (admin): por padrão, uma query aparece como fonte disponível em **qualquer pasta**. Um administrador pode restringi-la a uma ou mais pastas específicas — a partir daí, só quem está montando uma dashboard dentro de uma dessas pastas vê essa query no seletor de fontes do editor de widget (nas outras pastas, ela simplesmente não aparece). A mesma query liberada numa pasta pode ser usada em quantas dashboards/guias quiser dentro dela. Isso não afeta o ETL (a query continua sendo buscada normalmente) nem quem pode editar o catálogo em si — controla só visibilidade como fonte. Se o admin tentar remover uma pasta que já tem widget usando a query de verdade, aparece um aviso de confirmação listando as pastas/dashboards afetadas antes de salvar (widgets já criados continuam funcionando mesmo depois — a restrição só afeta o seletor de fontes para novas edições).
- **Restaurar padrão** apaga as queries customizadas e volta às 12 queries originais do projeto.
- **Mesclar campos entre fontes** (só em widgets de tabela e como campo extra em qualquer papel do widget): funciona como um JOIN simples — casa uma chave em comum entre duas fontes e traz um campo da fonte relacionada.
- **Dicionário de dados** (Configurações, só admin edita): uma descrição livre por campo de qualquer fonte (SQL ou planilha) — o que ele significa, de onde vem. Aparece automaticamente como um balão de informação (i), igual aos que já explicam Dados/Modificadores/Formato, ao lado do campo em qualquer seletor do Builder (Eixo X/Y, Legenda, Filtro, colunas de tabela) — pra qualquer usuário, não só quem escreveu. Campo sem descrição não mostra nada extra.

### 3.7-bis Fontes de dados — planilhas do Google (qualquer usuário)

Diferente das queries SQL acima (só admin cadastra), **qualquer usuário autenticado** pode cadastrar a própria planilha do Google Sheets e usar as colunas dela em qualquer gráfico/tabela, sem depender de um administrador:

- No editor de widget, aba **Modificadores** → seção **"Planilhas do Google"**: cole o link da planilha (precisa estar acessível pela sua própria conta Google — ver permissões abaixo), dê um nome, e opcionalmente informe qual aba usar (padrão: a primeira). Dá para cadastrar quantas planilhas quiser.
- Depois de cadastrada, a planilha aparece como mais uma fonte no seletor da aba **Dados** — igual a uma query SQL — e todos os tipos de gráfico/tabela/matriz funcionam com ela normalmente.
- **Permissão**: o app lê a planilha com a **sua própria conta Google** (mesma conta do login) — só funciona se essa conta já tem acesso à planilha no Drive (compartilhada com você, ou você é o dono). Não é preciso deixar a planilha pública.
- **Atualização**: os dados ficam em cache por até 5 minutos; depois disso, a próxima vez que alguém com acesso à planilha abrir um widget que a usa, ela busca de novo sozinha. Também dá para forçar uma atualização imediata (botão de atualizar, na lista de planilhas em Modificadores).
- **Quem pode editar/remover**: só quem cadastrou a planilha (ou um administrador) — mas qualquer pessoa com acesso ao widget pode **usá-la**, uma vez cadastrada.
- **Requisito único de configuração** (feito uma vez, fora do app): a conta Google usada no login precisa ter concedido a permissão de leitura de planilhas — quem já estava logado antes desse recurso existir precisa **sair e entrar de novo** pra conceder o acesso novo.

### 3.7-ter Fontes de dados — datasets do Data Hub / lakehouse (qualquer usuário)

O terceiro tipo de fonte, e o caminho preferido para dado que já existe no **Data Hub** (`lakehouse_sebratel`). A ideia é usar o lakehouse como **barramento de dados**: em vez de cadastrar uma query SQL que bate direto no banco de origem, cadastra-se aqui um dataset já publicado lá, e o app lê pela API pública dele. Quem consome não precisa de credencial de banco nenhuma.

- **Onde**: Configurações → seção **"Data Hub (lakehouse)"** → **"Nova fonte"**. Como as planilhas do Google (e diferente das queries SQL), é **auto-serviço**: qualquer usuário autenticado cadastra a própria fonte, com o **próprio token**.
- **O que preencher**: um nome (é o que aparece no Builder), o **dataset** (o slug publicado no Data Hub, ex. `clientes-cancelados`), o endereço do Data Hub (já vem preenchido) e o **token de acesso** (gerado no Data Hub, em Integrações). Dá para colar a URL inteira do `curl` no campo de dataset — o endereço, o dataset e o token são extraídos dela automaticamente.
- **Botão "Testar conexão"**: bate no Data Hub sem salvar nada e mostra quantas linhas o dataset tem e quais colunas vão aparecer no Builder, com uma amostra. Ao criar ou editar, esse teste é refeito no servidor: se o token não abrir o dataset, **nada é salvo** e o erro real do Data Hub aparece na tela (token revogado, sem acesso àquele dataset, dataset inexistente).
- **Segurança do token**: é enviado uma vez e guardado **cifrado** no servidor (AES-256-GCM). Nunca volta para o navegador — a tela mostra só uma dica (`dhub_…6T97`). Ao editar uma fonte, deixar o campo de token vazio mantém o token que já está salvo.
- **Atualização**: igual às queries SQL — **tempo real** (todo ciclo do ETL) ou **agendada** (a cada X minutos/horas, mantendo o último dado bom entre execuções). O padrão de uma fonte nova é *agendada, a cada 60 minutos*, porque dataset de lakehouse costuma ser materializado de tempo em tempo. Também há **"Sincronizar agora"**, que dispara a busca na hora. Se uma busca falhar, a fonte mantém o último dado bom e a tela mostra um selo "falhou" com o motivo.
- **Volume**: datasets grandes são buscados em páginas (padrão: 50 mil linhas por requisição) até fechar o total informado pelo próprio Data Hub, com teto de segurança de 500 mil linhas por fonte.
- **Pastas onde a fonte pode ser usada** (admin): mesma regra das queries SQL (ver 3.7) — por padrão aparece em qualquer pasta; um administrador pode restringi-la.
- **Quem pode editar/remover**: só quem cadastrou (ou um administrador). Ligar/desligar e mudar o ritmo de atualização, qualquer usuário logado. Remover a fonte aqui **não** afeta nada no Data Hub — apaga só o cadastro deste app.
- **Quando ela aparece no Builder**: depois do primeiro ciclo do ETL que a buscar (o cadastro já dispara um). Igual a uma query SQL nova.

### 3.7-quater Montar widgets conversando com a IA

No modo edição de uma guia existe um botão **"IA"**, ao lado de "+ Widget" (mesma permissão: quem pode adicionar widget na guia pode usar). Ele abre um painel de conversa lateral onde você descreve o que quer ver e a IA monta os widgets.

- **Como se usa**: marque quais fontes a IA pode usar, escreva o pedido ("monte uma tela com os principais indicadores", "compare o volume por equipe nos últimos meses", "quais os 3 gargalos que os dados mostram?") e a resposta vai aparecendo enquanto ela pensa. Ao terminar, ela apresenta os widgets propostos com tipo e título.
- **Nada é aplicado sozinho**: você clica em **"Adicionar à guia"** (ou "Descartar"). Aprovar coloca os widgets no rascunho da guia — e, como qualquer edição manual, **ainda depende do "Salvar"** da barra de edição. É deliberado: o modelo pode interpretar mal um pedido ambíguo.
- **Depois de aprovado é um widget normal**: abre no editor de sempre, muda cor, tipo, campo, formatação. A IA dá o ponto de partida, não um objeto especial.
- **O que a IA vê**: apenas os **nomes** dos campos das fontes marcadas, o tipo de cada um (número/data/texto) e a descrição escrita no dicionário de dados (3.7). **As linhas de dados nunca são enviadas.** Quando ela precisa de valores reais — por exemplo, para saber se o status é "Concluído" ou "CONCLUIDO" antes de criar um filtro — ela consulta os valores distintos daquele campo, e só aquilo sobe. Para escrever um insight, ela lê o resultado **já agregado** do widget (as mesmas centenas de números que o gráfico mostra), não o dataset.
- **Não invento campo**: o que a IA propõe é validado contra o catálogo real antes de chegar na tela. Campo ou fonte inexistente é recusado e devolvido pra ela corrigir na mesma conversa — em vez de gerar um widget quebrado.
- **Insights**: peça uma análise e ela pode devolver um widget de **texto** com o que os números mostram — que fica salvo na guia como qualquer outro widget.
- **Acesso**: a conversa só alcança fontes que você já veria no Builder daquela pasta (as mesmas regras de 3.7 e 3.12 valem, sem exceção).
- **Custo e limite**: cada interação custa centavos e o painel mostra, no canto, quanto você já gastou hoje e qual o limite diário. Batendo o limite, o campo de mensagem bloqueia até o dia seguinte (ajustável em `AI_DAILY_BUDGET_USD`).
- **Trocar de fontes**: a seleção trava depois da primeira mensagem — para mudar, comece uma conversa nova. As conversas ficam só em memória e expiram em 2 horas; nada de transcrição salva em disco.
- **Requisito de configuração**: a variável `ANTHROPIC_API_KEY` no servidor. Sem ela o botão continua aparecendo, mas o painel avisa que a IA não está configurada; o resto do app não é afetado.

### 3.8 Como os dados são atualizados

- Um processo separado ("agendador de ETL") roda o ciclo base de atualização a cada poucos minutos (hoje, 2 minutos por padrão). Nesse ciclo, cada fonte de segundo plano — query SQL (3.7) ou dataset do Data Hub (3.7-ter) — decide se é a vez dela de rodar. Planilhas do Google não entram nesse ciclo: elas dependem do login de quem está usando, e por isso são resolvidas dentro da requisição (3.7-bis).
- Editar, criar, remover, ativar ou desativar uma query ou uma fonte do Data Hub também dispara uma atualização em segundo plano na hora.
- Uma fonte cuja busca falhe **mantém o último dado bom** em vez de zerar, e é tentada de novo no ciclo seguinte. Isso vale para as duas: uma query cujo banco está fora do ar e um dataset cujo token foi revogado se comportam igual.
- **Importante**: a atualização acontece no servidor. Uma aba do navegador já aberta **não recarrega os dados sozinha** — é preciso dar F5, a menos que a aba tenha a opção **"Atualização automática"** ligada (em Configurações de tela, por aba): nesse caso, os widgets da aba buscam dado novo sozinhos, em segundo plano, no intervalo definido, sem piscar a tela — pensado para telas fixas expostas sem interação (ex. TV de um setor).

### 3.9 Autenticação e acesso

- Login via Google OAuth (**SSO**), restrito a contas do domínio **@sebratel.com.br**.
- O login é conduzido **pelo servidor** (fluxo de código de autorização): clicar em "Entrar com Google" leva ao Google, e o retorno é tratado pelo backend, que troca o código por tokens usando o *client secret* da aplicação. A sessão fica num **cookie HttpOnly** — o navegador nunca tem acesso a token do Google, e nada de credencial é guardado no `localStorage`.
- **Duração**: a sessão vale 30 dias por padrão (configurável). Enquanto ela existe, o servidor renova o acesso ao Google sozinho, então não há mais aquele efeito de "cair" depois de uma hora. **Sair** encerra a sessão de verdade no servidor, não só na aba.
- Por conta de como o Google entrega a credencial de renovação, a **tela de consentimento do Google aparece a cada login** — em troca, logins são raros (a sessão dura semanas).
- O catálogo de queries continua igualmente aberto a qualquer pessoa logada (ver 3.7). Dashboards, pastas e guias já têm controle de acesso por usuário — ver 3.1 e 3.12. A aba **Acessos** (3.11) e a gestão de **pastas** (3.1/3.12) são restritas a administradores.

### 3.10 Modo escuro

- Alternável a qualquer momento (ícone de sol/lua no topo), a preferência fica salva no navegador de cada pessoa (não é uma config compartilhada).

### 3.11 Gestão de acessos (aba "Acessos")

- Visível só para administradores; para os demais usuários, a aba fica escondida no menu e a API recusa o acesso (403).
- **Usuários**: todo mundo que já logou pelo menos uma vez, com primeiro e último acesso.
- **Papel (Admin/Padrão)**: qualquer administrador pode promover ou rebaixar outro usuário direto na tabela (com confirmação antes) — vale só para quem já acessou pelo menos uma vez. A lista de e-mails em `ADMIN_EMAILS` (env) ou no código de `server/accessLog.mjs` agora é só o **ponto de partida** (bootstrap): assim que alguém troca o papel de um usuário pela tela, esse valor salvo manda, mesmo que a pessoa estivesse ou não naquela lista original. O sistema nunca deixa remover o último administrador restante. Esse papel é diferente de "gerente de pasta" (3.1/3.12) — um usuário `padrão` pode ser gerente de uma ou mais pastas sem virar administrador global.
- **Online agora**: calculado por "visto nos últimos 90 segundos" — o navegador manda um sinal (heartbeat) a cada 45s enquanto a aba está visível, então uma tela aberta e parada ainda aparece online.
- **Log de ações**: registra criar/editar/remover/ativar/desativar/reagendar uma query, restaurar o catálogo de queries, criar/editar/remover pasta ou dashboard, alterar acesso de pasta/guia, salvar guias/widgets e login/logout — com quem fez, quando e o alvo da ação. Guarda as últimas 5.000 ações (as mais antigas são descartadas).
- Não registra leituras (visualizar um gráfico, abrir uma guia) — só ações que mudam alguma configuração, para o log continuar útil e legível.

### 3.12 Permissões por pasta, dashboard e guia

Resumo de quem pode fazer o quê (ver 3.1 pra contexto):

| Ação | Quem pode |
|---|---|
| Criar/editar/remover pasta | Administrador |
| Definir quem acessa uma pasta (aberta a todos ou lista de e-mails) | Administrador |
| Nomear gerente(s) de uma pasta | Administrador |
| Criar dashboard dentro de uma pasta | Administrador ou gerente daquela pasta |
| Gerenciar a estrutura de uma dashboard (guias, filtros, formato) | Administrador ou gerente da pasta |
| Definir quem vê e quem edita cada guia | Administrador ou gerente da pasta |
| Ver uma guia | Administrador, gerente da pasta, ou usuário liberado (visualização ou edição) naquela guia especificamente |
| Editar os widgets de uma guia | Administrador, gerente da pasta, ou usuário com edição liberada naquela guia |

Duas coisas importantes sobre como esses acessos se combinam:
- **Acesso à pasta é um pré-requisito**: liberar a visualização/edição de uma guia pra alguém só faz efeito se essa pessoa também tiver acesso à pasta onde a dashboard vive — são dois controles em separado, e o de pasta é sempre do administrador.
- **"Ver" e "Editar" são independentes**: dá pra liberar só visualização, ou visualização + edição, pra cada usuário em cada guia. Um usuário pode ter edição numa guia e só visualização (ou nada) em outra da mesma dashboard.

O seletor de e-mails usado pra liberar acesso de guia mostra só quem **já tem acesso à pasta** — nunca a lista de todos os usuários do sistema.

### 3.13 Comentários em widgets

Todo widget tem um ícone de balão de comentário no cabeçalho, visível tanto em modo visualização quanto em edição. Clicar mostra os comentários já deixados (autor, data, texto) e um campo pra escrever um novo. Qualquer usuário autenticado pode comentar — não precisa ter permissão de editar aquele widget, já que é uma anotação de leitura/colaboração ("esse pico em março foi por causa da campanha X"), não uma mudança na configuração do widget. Remover um comentário é restrito a quem escreveu ou a um administrador. Um número no ícone indica quantos comentários existem.

---

## 4. Regras de funcionamento

1. **Só leitura no banco**: uma query só pode ser `SELECT`/`WITH`. Qualquer palavra-chave de escrita (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, etc.) é bloqueada ao salvar.
2. **Catálogo de queries é compartilhado e sem restrição por usuário**: um único documento salvo no servidor — qualquer pessoa logada edita, e a mudança vale pra todos. Dashboards/pastas/guias, por outro lado, têm controle de acesso por usuário (ver 3.1/3.12) — cada uma é seu próprio documento dentro do workspace. A única exceção parcial é a restrição de **pastas onde a query pode ser usada como fonte** (3.7, admin) — controla visibilidade da query no Builder, não quem edita o catálogo.
3. **Colunas vêm dos dados, não de um cadastro manual**: o tipo de cada campo (número, data ou texto/categoria) é inferido automaticamente olhando uma amostra dos dados reais retornados pela query.
4. **Cor principal nunca compete com cor de série**: quando há legenda ou múltiplas medidas, cada série tem sua própria cor — a "Cor principal" só vale para o caso de série única.
5. **Duplicar um widget** cria uma cópia com id novo, marcada "(cópia)" no título, posicionada num espaço livre da grade (ou centralizada, se a grade estiver cheia).
6. **Nenhuma ação destrutiva é silenciosa**: remover widget, guia, pasta, query, descartar alterações ou restaurar o padrão sempre pedem confirmação antes.
7. **Acesso à pasta é sempre o primeiro filtro**: mesmo que alguém tenha visualização/edição liberada numa guia, isso só faz efeito se a pessoa também tiver acesso à pasta onde a dashboard está — os dois controles são independentes, e o de pasta é sempre do administrador.
8. **A guia de boas-vindas nunca pode ficar bloqueada nem ser removida** — é a única guia com acesso sempre aberto por padrão dentro de uma dashboard.

---

## 5. Limitações técnicas atuais

| Limite | Valor | Onde se aplica |
|---|---|---|
| Linhas por query no ETL | 500.000 | Corte de segurança contra uma query sem `WHERE` numa tabela gigante. |
| Linhas na pré-visualização/teste de uma query | 50 | Botão "Testar" em Configurações. |
| Pontos num gráfico (Top N) | até 100 | Mesmo que o Top N configurado peça mais. |
| Séries de Legenda | até 8 | Valores além do 8º são descartados (não somados a "outros"). |
| Valores distintos listados num filtro | até 500 | Popup de seleção de valores de um filtro/filtro fixo. |
| Linhas/colunas numa Matriz | até 500 linhas (por nível) / 50 colunas dinâmicas | Colunas são rankeadas pelo total geral; o excesso é cortado. |
| Amostra para inferir o tipo de um campo | 300 linhas | Só afeta a detecção do tipo (número/data/texto), não os dados exibidos. |
| Ciclo base do ETL | ~2 minutos | Frequência mínima prática de uma query "tempo real". |
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
- Ter queries com ritmos de atualização diferentes entre si (tempo real vs. agendada, cada uma com seu próprio intervalo).
- Ligar atualização automática só nas guias que precisam (ex. TV de painel), deixando as demais só atualizarem por F5.
- Testar uma query antes de salvar, sem afetar a dashboard em produção.
- Restaurar o catálogo de queries ao estado padrão a qualquer momento.
- Sobrepor widgets deliberadamente na grade (não é bloqueado).

## 7. O que NÃO é possível hoje (impossibilidades conhecidas)

- **Não dá para escrever no banco** por uma query (só leitura) — não é uma ferramenta de manutenção de dados.
- **O catálogo de queries continua sem permissão por usuário** — qualquer pessoa logada pode criar/editar/remover queries, independente de ter acesso a alguma pasta/dashboard.
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
