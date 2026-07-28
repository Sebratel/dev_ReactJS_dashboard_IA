# Histórico de Alterações — Indicadores Sebratel

> Linha do tempo de ajustes e decisões do projeto, da mais recente para a mais antiga. Toda vez que fizermos uma mudança relevante, um novo bloco de data é adicionado no **topo** deste arquivo — não precisa reescrever o que já existe.

---

## 28/07/2026 — Correção: meta sem valor visível e "piscar" sem efeito nas barras

- A linha de meta (`ReferenceLine`) nos gráficos mostrava só a palavra "Meta", sem o número — agora mostra "Meta: 3.000" (o valor formatado de verdade).
- O "Piscar" de uma regra condicional não tinha efeito nenhum nas barras (bar/barH/colunas empilhadas/combo/histograma) — só funcionava no KPI e na matriz. Faltava passar a classe de animação (`animate-pulse`) pra cada `<Cell>` colorida por regra; agora, quando a regra que bateu tem "Piscar" marcado, a barra daquele ponto pisca igual ao card do KPI.
- Verificado a linha de meta no DOM (texto "Meta: 3.000" renderizado corretamente) e, pro piscar, via inspeção do mecanismo do Recharts (`<Cell>` já mescla suas props — incluindo `className` — no elemento renderizado, mesma lógica confirmada visualmente antes pra cor de fundo); `tsc`/`build` limpos.

## 28/07/2026 — Correção: painel de comentários ficava cortado dentro do card do widget

- `WidgetCommentsPopover.tsx` passou a renderizar a lista/formulário de comentários num portal em `document.body` (`ModalPortal`), com posição calculada (`position: fixed`) a partir do próprio ícone, em vez de um `<div>` posicionado dentro do cabeçalho do widget. O card do widget tem `overflow: hidden` (bordas arredondadas) e um layout de grade estreito — o painel antigo, posicionado por dentro, ficava cortado/espremido nos limites do próprio card (relatado pelo usuário com print). Detecção de clique-fora ajustada pra considerar tanto o botão quanto o painel (agora em nós separados da árvore do DOM).
- Verificado com harness visual: painel agora aparece por cima de tudo, com o conteúdo completo, mesmo dentro de um card propositalmente pequeno e com `overflow: hidden`.

## 28/07/2026 — Motor de formatação condicional: meta e alertas (itens 2.1, 11, 12 e 13)

- Novo motor único reaproveitável (item 2.1) — `conditionalFormat.ts` (`resolveConditionalEffect`): uma lista de regras "se o valor for {operador} {número}, aplica {cor de fundo / piscar / brilho}", avaliadas em ordem, a última que bater vence. `WidgetConfig` ganhou `target?: number` (meta) e `conditionalRules?: ConditionalRule[]`, editáveis numa nova seção "Meta e alertas" em Formato.
- **KPI (item 11)**: o card inteiro (fundo/piscar/brilho) muda conforme o valor bate ou não com as regras; a meta aparece ao lado do valor ("meta: 100").
- **Gráficos e matriz (item 12)**: `bar`/`barH`/`barStacked`/`barHStacked`/`comboBarLine`/`histogram` ganharam uma `<ReferenceLine>` tracejada na meta e cada barra individual (via `<Cell>`, mesmo mecanismo já usado no gráfico de pizza) muda de cor conforme o próprio valor; `line`/`area` só desenham a linha de meta (sem coloração por trecho — uma linha contínua não tem "pedaços" discretos); a matriz colore/pisca cada célula individualmente. Escopo assumido deliberadamente: tabela não entrou nesta rodada (fica pra uma extensão futura, se pedido).
- **Formato → Aparência do widget (item 13)**: três novos toggles estáticos, sempre ativos independente do dado — sombra, brilho e piscar do card inteiro — além do "fundo dinâmico" do KPI, que já usa o motor condicional acima.
- Verificado com harness visual (KPI abaixo/acima da meta ficando vermelho/verde, linha de referência desenhada com a cor certa, célula de matriz colorindo/mudando conforme o valor) e `tsc`/`build` limpos.

## 28/07/2026 — Comentários em widgets (item 2.6 das minhas sugestões)

- Novo ícone de balão de comentário no cabeçalho de todo widget (visível em qualquer modo, não só edição) — clique abre uma lista dos comentários já deixados (autor, data, texto) + um campo pra escrever um novo. Qualquer usuário autenticado pode ler e comentar (não exige permissão de editar o widget); remover um comentário é só de quem escreveu ou um admin. Contador no ícone quando há 1+ comentário.
- Novo módulo `server/widgetComments.mjs` (persistido em `data/widgetComments.json`, plano — não faz parte do `WidgetConfig`/não depende do "Salvar" do editor). Rotas `GET /api/widget-comments/:widgetId`, `POST /api/widget-comments`, `DELETE /api/widget-comments/:id`, `GET /api/widget-comments/counts?ids=...`.
- Novo componente `WidgetCommentsPopover.tsx`, plugado no `ChartFrame` (WidgetRenderer.tsx).
- Verificado com `tsc`/`build` limpos e um probe isolado (criar, listar, contar por widget, bloqueio de remoção por quem não é autor/admin, validação de texto vazio).

## 28/07/2026 — Dicionário de dados (item 9 da lista de melhorias)

- Nova seção "Dicionário de dados" em Configurações (visível só pra admin) — lista todas as fontes e campos (SQL e planilhas do Google), com um campo de texto por coluna pra escrever o que ela significa/de onde vem. Salva ao sair do campo (blur); descrição vazia remove a entrada.
- O texto escrito aparece automaticamente como um InfoHint (i) ao lado do campo em qualquer seletor do Builder onde ele já apareceria — AxisFieldPicker (Eixo X/Legenda), MeasureWell (Eixo Y/medidas), FieldWell (filtro fixo) e TableColumnsWell (colunas de tabela) — pra qualquer usuário, não só admin. Campo sem descrição continua exatamente como antes (sem InfoHint extra).
- Novo módulo `server/fieldDictionary.mjs` (persistido em `data/fieldDictionary.json`, chave `fonte::campo`); `server/widgetQuery.mjs::listSourceDefs` anota cada campo do catálogo com a descrição correspondente antes de devolver pro front. Rotas `GET /api/field-dictionary` (qualquer autenticado) e `PUT /api/field-dictionary` (`requireAdmin`).
- Verificado com `tsc`/`build` limpos e um probe isolado do CRUD (criar, atualizar sem duplicar, remover ao limpar a descrição, validação de campos obrigatórios).

## 28/07/2026 — Rótulos de dados por série (item 10 da lista de melhorias)

- Cada medida do Eixo Y (ou da "Eixo Y - Linha" do combo), quando há mais de uma, ganhou um override próprio de rótulo de dados — "Padrão acima", "Sempre mostrar" ou "Nunca mostrar". "Rótulos de dados" (Formato) continua sendo o padrão do widget inteiro; a lista "Por série" aparece embaixo dele, na mesma seção — não na pílula da medida em Dados, correção feita no mesmo dia a pedido do usuário (fica junto de onde o resto da formatação de rótulo já vive, em vez de espalhado pelas pílulas).
- `MeasureConfig` (types.ts) ganhou `dataLabels?: DataLabelFormat`; o backend (`widgetQuery.mjs`) já copia esse campo pra dentro de `seriesKeys` (mesmo padrão que já fazia com `color`); `WidgetRenderer.tsx` resolve, por série, o override antes de decidir se desenha o `LabelList` daquela barra/linha/área; `WidgetEditorModal.tsx` monta a lista combinando as medidas do Eixo Y com as da "Eixo Y - Linha".
- Verificado com `tsc --noEmit`/`build` limpos.

## 28/07/2026 — Planilhas do Google como fonte de dados (self-service)

- Qualquer usuário autenticado (não só admin) agora pode cadastrar a própria planilha do Google Sheets e usá-la em qualquer gráfico/tabela do Builder — item 2 da Parte 1 de `MELHORIAS_FUTURAS.md`, implementado. Entrada no editor de widget, aba **Modificadores** → "Planilhas do Google": cola o link, dá um nome, opcionalmente escolhe a aba; a planilha passa a aparecer no seletor de fonte da aba Dados, igual a uma query SQL.
- **Decisões tomadas com o usuário** antes de implementar: (1) leitura via **OAuth da própria conta Google do usuário** (não link público nem service account) — o app só consegue ler o que a conta logada já tem acesso no Drive; (2) cada planilha cadastrada é **uma fonte própria e independente** (não uma mesclagem/join automática entre várias planilhas de um mesmo widget) — dá pra cadastrar quantas quiser, cada uma aparece separada no seletor de fontes.
- **Backend novo**: `server/googleSheets.mjs` (busca a planilha via API REST v4 do Google Sheets, com o `access_token` da própria requisição — sem SDK, mesmo padrão de fetch direto já usado pra validar identidade no login); `server/sheetSources.mjs` (catálogo próprio, `data/sheetSources.json`, com cache de 5 min por planilha — CRUD livre pra qualquer usuário criar, só quem criou ou um admin pode editar/remover). `server/widgetQuery.mjs` ganhou uma etapa assíncrona de resolução (`sheet:<id>` como prefixo da fonte) que injeta as rows da planilha no snapshot mesclado antes do resto do motor de agregação (100% síncrono, sem nenhuma mudança) rodar — por isso `runWidgetQuery`/`runFieldValues`/`listSourceDefs` passaram a ser `async`.
- **Escopo OAuth novo**: o login (Google Identity Services) passou a pedir também `spreadsheets.readonly`, além de `openid email profile` — mesmo Client ID de sempre, sem service account. **Requer, uma vez, no Google Cloud do Client ID**: habilitar a API do Google Sheets. Quem já estava logado antes precisa sair e entrar de novo pra conceder a permissão nova.
- Rotas novas (`GET/POST /api/sheet-sources`, `PUT/DELETE /api/sheet-sources/:id`, `PATCH /api/sheet-sources/:id/refresh`, `GET /api/sheet-sources/:id/usage`) — todas só exigem login (`requireAuth`), nenhuma é admin-only, ao contrário do catálogo de queries SQL.
- Verificado com `tsc`/`build` limpos e um probe isolado (extração do id da planilha a partir do link, rejeição de link inválido, CRUD do catálogo, e a mensagem de erro correta com um token inválido) — o fluxo completo (adicionar uma planilha real, ver as colunas aparecerem, montar um gráfico) depende de login real do usuário (Google OAuth não pode ser automatizado por aqui) — pendente validação do usuário logado.

## 28/07/2026 — Novo tipo de gráfico: Histograma

- Novo tipo de visual **"Histograma"** no editor de widget: escolha um campo numérico e a quantidade de faixas (padrão 10) — o app divide os valores automaticamente em faixas de tamanho igual e conta quantos registros caem em cada uma (barra).
- A linha mostra a **curva normal (gaussiana)** ajustada à média e ao desvio-padrão reais dos dados, na mesma escala/eixo das barras — estilo do histograma padrão do Excel/Power BI ("distribuição normalizada"), útil pra comparar visualmente a forma real da distribuição com uma normal teórica. Barra e linha compartilham um único eixo Y (não é um combo de 2 escalas) e as barras ficam encostadas, sem espaço entre si, já que representam faixas contínuas de um mesmo campo.
- Correção no mesmo dia: a 1ª versão tinha implementado a linha como percentual acumulado (estilo Pareto, eixo direito 0-100%) — trocada pela curva normal depois que o usuário compartilhou uma imagem de referência de histograma (Excel) mostrando a curva "Distribuição Gaussiana Normalizada" sobre as barras de frequência, no mesmo eixo.

## 27/07/2026 — Recuo manual de eixo + colunas de tabela redimensionáveis

- **Formato → Eixo X/Eixo Y**: novo campo "Recuo" (inferior no X, lateral no Y) — soma manualmente pixels ao espaço reservado automaticamente pro rótulo do eixo, pra cobrir casos onde o número ainda aparece cortado (aceita negativo, pra apertar o espaço quando o automático reserva mais do que precisa).
- **Tabela**: colunas agora são redimensionáveis arrastando a borda direita do cabeçalho, em modo edição — largura livre por coluna, sem mínimo além de um valor pequeno pra alça continuar arrastável, e sem afetar a largura das colunas vizinhas (encolher uma não expande nem empurra as outras). Antes, a largura era sempre automática (cabe todo o texto do conteúdo).

## 27/07/2026 — Temas prontos de cores no Builder

- Novo botão **"Temas"** na barra do modo edição (ao lado de "Formato"), para quem gerencia a dashboard: abre uma galeria com temas de cores prontos (Sebratel, Oceano, Pôr do sol, Floresta, Roxo vibrante, Corporativo, Vibrante, Monocromático azul, Alto contraste, além do padrão do app).
- Cada tema define de uma vez a cor das barras/linhas/fatias, o fundo dos cards de widget e a cor da legenda — aplicando em todos os widgets da guia atual com um clique, em vez de configurar cada widget manualmente.
- Sobrescreve cores já customizadas por widget (é um "aplicar tema", não um preenchimento seletivo); como fica em rascunho até "Salvar", dá pra "Descartar" se não gostar do resultado. Cada widget continua editável individualmente depois de aplicar.
- **Ajuste (mesmo dia)**: os temas com um "matiz-mãe" (Sebratel, Oceano, Pôr do sol, Floresta, Roxo vibrante) tinham a paleta muito parecida a variações de uma única cor — refeitos com matizes de verdade diferentes entre si, mais fáceis de distinguir série por série. Adicionados 2 temas novos ("Corporativo" e "Vibrante") para mais variedade. "Monocromático azul" continua sendo a exceção deliberada (o nome já avisa). "Alto contraste" agora também deixa legenda, eixos X/Y e rótulos de dados em **branco**, para se destacar de verdade contra o fundo escuro.
- **Correção (mesmo dia)**: a cor do texto da legenda nunca tinha efeito de verdade — o Recharts sempre pinta o texto de cada item da legenda com a MESMA cor da própria série/fatia, ignorando a formatação configurada; corrigido forçando a cor certa via um `formatter` customizado na legenda. Também corrigido o modal "Temas": ao reabrir, ele sempre mostrava "Padrão do app" pré-selecionado mesmo com outro tema já aplicado na guia — agora detecta o tema atual pela paleta já gravada nos widgets e abre com o card certo marcado. **Quem já aplicou "Alto contraste" antes desse ajuste precisa reabrir "Temas" e aplicar de novo** para os textos ficarem brancos de verdade (a correção não muda widgets já salvos sozinha).
- **Correção 2 (mesmo dia)**: a cor de tema não alcançava o texto de widgets **tabela e matriz** (cabeçalho e corpo continuavam na cor padrão, mesmo com "Alto contraste" aplicado) — corrigido aplicando a cor do tema também nessas células. Além disso, um widget **novo criado depois de já ter um tema aplicado** nascia sempre com as cores padrão do app, destoando do resto da guia — corrigido: agora o widget novo já nasce com a paleta/fundo/cores de texto do tema atual da guia.
- **Correção 3 (mesmo dia)**: a regra de cor de texto era específica demais (só "Alto contraste" forçava branco, e só em legenda/eixos/rótulos/tabela — faltava título, subtítulo, e o "Oceano", que também tem fundo escuro, não tinha sido incluído). Generalizada: todo tema com fundo de card customizado (hoje "Oceano" e "Alto contraste") usa uma única cor de texto branca, aplicada de vez em título, subtítulo, legenda, eixos X/Y, rótulos de dados e célula/coluna/linha de tabela/matriz — em vez de 4 campos de cor separados e parcialmente cobertos.
- **Correção 4 (mesmo dia)**: essa cor de texto branca tinha sido erroneamente estendida (com tons mais claros, tipo cinza-azulado) para os temas SEM fundo próprio (Sebratel, Pôr do sol, Floresta, Roxo vibrante, Corporativo, Vibrante, Monocromático azul) — como esses widgets continuam sobre o fundo padrão do card (que muda de claro pra escuro junto com o tema do app), uma cor de texto fixa ficava ilegível toda vez que o app estivesse no modo claro. Corrigido removendo a cor de texto fixa desses temas — eles voltam a usar as classes cinza padrão do app, que já se adaptam automaticamente aos dois modos. Só "Oceano" e "Alto contraste" (que têm fundo de card fixo, sempre escuro) continuam forçando texto branco.
- **Correção 5 (mesmo dia)**: nos temas de fundo escuro, o cabeçalho de tabela/matriz (fixo no topo ao rolar) mantinha um fundo claro próprio, deixando uma faixa clara destoante no topo — com o texto branco do tema por cima, ficava invisível. Corrigido: o cabeçalho agora herda o mesmo fundo customizado do widget.

## 27/07/2026 — Queries liberadas por pasta

- Cada query do catálogo (Configurações) agora pode ser restrita a **uma ou mais pastas específicas** — por padrão continua aparecendo como fonte em qualquer pasta, mas um administrador pode marcar "só nestas" e escolher quais. Só quem está montando uma dashboard dentro de uma pasta liberada vê aquela query no seletor de fontes; nas outras pastas ela simplesmente não aparece.
- A mesma query liberada numa pasta pode ser usada em quantas dashboards/guias quiser dentro dela — a restrição é só por pasta, não por dashboard individual.
- Não afeta o ETL (a query continua rodando normalmente) nem quem pode editar/criar/remover queries no catálogo — controla só visibilidade como fonte no Builder.
- Cada query mostra um pequeno indicador (ícone de pasta + número) quando está restrita, visível pra todo mundo; o controle de editar essa restrição é só de administradores.
- **Confirmação antes de remover uma pasta em uso**: se o admin tentar tirar o acesso de uma pasta que já tem widget de verdade usando aquela query em alguma dashboard, aparece um aviso listando quais pastas (e dashboards dentro delas) seriam afetadas antes de salvar — dá pra cancelar ou confirmar mesmo assim. Não afeta widgets já criados (eles continuam funcionando), só deixa de oferecer a query no seletor de fontes daquela pasta para novas edições. Amplia acesso (ou remove uma pasta sem uso real) continua salvando direto, sem aviso.

## 24/07/2026 — Hierarquia Pasta → Dashboard → Guia, com permissões por setor

Mudança estrutural grande: a dashboard deixou de ser um documento único e compartilhado e virou uma hierarquia de 3 níveis, pensada para equipes de setores e hierarquias diferentes.

- **Pastas** (setores) aparecem como um item expansível no menu lateral. Só administradores criam/editam/removem uma pasta e decidem quem tem acesso a ela (aberta a todos ou lista de e-mails específica).
- Cada pasta pode ter **várias dashboards**; cada dashboard continua tendo guias (o antigo conceito de "aba"), exatamente com a mesma funcionalidade de sempre.
- Novo papel **gerente de pasta**: um admin pode nomear um usuário comum como gerente de uma pasta específica — sem virar administrador global, esse gerente pode criar dashboards e controlar o acesso das guias dentro daquela pasta.
- Toda dashboard nova nasce com uma **guia de boas-vindas** (sempre aberta, explica o app) — todas as outras guias nascem **bloqueadas** até o gerente da pasta ou um admin liberar visualização e/ou edição, usuário por usuário.
- Novo widget **Texto**: bloco de texto livre sem fonte de dados, usado na guia de boas-vindas.
- A dashboard/catálogo de queries existentes antes dessa mudança foram migrados automaticamente para uma pasta "Geral" com todas as guias mantidas **abertas** — ninguém perdeu acesso ao que já usava.
- **Ajuste de UX**: em vez de uma tela separada "Pastas", o cabeçalho "Dashboards" no menu virou um dropdown (clique pra expandir/recolher as pastas), e cada pasta ganhou um botão de engrenagem ao lado (visível pra quem a gerencia) que abre as configurações daquela pasta específica — acesso, gerentes, dashboards — direto num modal. Um "+" ao lado do cabeçalho cria uma pasta nova (só admin).

## 24/07/2026 — Aba de gestão de acessos (Acessos)

- Nova aba **"Acessos"** no menu lateral, visível só para administradores: lista todo mundo que já entrou no app (nome, e-mail, primeiro e último acesso), quem está **online agora** (heartbeat do navegador a cada 45s) e um **log de ações** (criar/editar/remover/ativar/desativar/agendar query, restaurar catálogo, salvar/restaurar dashboard, login/logout), com usuário e horário de cada ação.
- Lista de administradores fixa no início (por e-mail, configurável via variável de ambiente/código) — sem conceito de perfis/papéis no restante do app ainda.
- Dados guardados em dois arquivos no servidor (mesmo padrão dos outros dados do app), sem impacto no ETL nem nas queries existentes.
- **Promover/rebaixar usuário direto na tela**: cada linha da tabela de usuários ganhou um controle "Padrão / Admin" — qualquer administrador pode dar ou tirar o acesso de administrador de quem já logou pelo menos uma vez, com confirmação antes. O sistema bloqueia remover o último administrador restante, pra ninguém ficar trancado para fora da própria tela que gerencia isso.

## 24/07/2026 — Modo escuro

- Adicionado tema escuro alternável (ícone sol/lua no topo), com preferência salva no navegador de cada pessoa.
- Corrigido um bug real do navegador (Chromium): a Sidebar usava `transition-all`, e trocar de tema (cor vinda de variável CSS mudando no elemento pai) às vezes deixava ela "travada" na cor do tema anterior. Corrigido restringindo a transição só à largura, e adicionada uma proteção geral (desliga toda transição da página por 1 quadro ao trocar de tema) para blindar o resto do app do mesmo problema.

## 24/07/2026 — Atualização de dados por query (não mais global)

- Cada query agora escolhe **individualmente** o próprio ritmo de atualização: **Tempo real** (roda em todo ciclo do ETL) ou **Agendada** (só a cada X minutos/horas, mantendo o último dado bom entre execuções).
- Removida uma primeira versão que tinha sido feita como configuração **global** (liga/desliga + intervalo únicos para todas as queries) — corrigido a pedido do usuário, já que é preciso ter queries com ritmos diferentes ao mesmo tempo.
- Cada query também pode ser **ativada/desativada** individualmente — desativada, não roda no ETL e some do catálogo de fontes do Builder até ser reativada.
- Agendador de ETL (processo separado) simplificado para um ciclo base curto e fixo (2 min por padrão); a decisão de rodar ou não cada query é interna ao próprio ETL.

## 24/07/2026 — Atualização automática por aba (sem F5)

- Nova opção em "Configurações de tela" (por aba): liga atualização automática dos widgets daquela aba, num intervalo em minutos, sem recarregar a página — pensada para telas fixas sem interação (ex. TV de um setor).
- Só funciona fora do modo edição; a troca de dado é silenciosa (sem apagar o gráfico enquanto busca).

## 24/07/2026 — Diálogos de confirmação no estilo do app

- Todos os `confirm()`/pop-ups nativos do navegador (remover widget, remover aba, descartar alterações, restaurar padrão, remover query) foram trocados por um diálogo com a cara do app.

## 24/07/2026 — Duplicar widget, cor dos ícones, linhas de grade, legenda

- Novo botão "duplicar" no cabeçalho do widget (ao lado de editar/excluir) — cria uma cópia num espaço livre da grade, ou centralizada se não houver espaço.
- Nova opção de cor para os ícones de editar/duplicar/excluir.
- Novo controle de linhas de grade do gráfico: todas, só horizontal, só vertical, ou nenhuma.
- Nova formatação de texto para a legenda (fonte, cor, estilo).
- Corrigido: rótulos dos eixos com fonte grande (principalmente com fundo colorido) vazavam para fora do card do widget — os eixos agora reservam espaço extra automaticamente.

## 24/07/2026 — Painel de Formato: seções recolhíveis, cores, opacidade e mais

Pacote grande de melhorias na aba **Formato** do editor de widget:

- Todas as seções passaram a vir **fechadas por padrão** (clique no cabeçalho expande), para não sobrecarregar a tela.
- Formatação de **Título e Subtítulo** (fonte, negrito/itálico/sublinhado, cor do texto e de fundo).
- **Opacidade** (slider 0–100%) para cor do texto, cor de fundo e para o preenchimento de colunas/linhas/fatias do gráfico.
- **Aparência do widget**: cor de fundo do card inteiro, com opacidade.
- Corrigido: swatches de cor branca ficavam "invisíveis" quando selecionadas (o indicador de seleção era uma borda clara demais) — trocado por um contorno colorido com espaçamento real, visível em qualquer cor.
- **Rótulos de dados** sobre o gráfico: mostrar/ocultar, posição (dentro/fora/em cima/centralizado), conteúdo (número/nome/percentual/combinações), tamanho de fonte, cor e opacidade — implementado para barras, linhas, área, dispersão, pizza e funil.
- Pequeno botão de informação (ícone "i") adicionado ao lado de cada campo/seção do editor, explicando o que ele faz.

## 24/07/2026 — Live preview no Builder

- Enquanto o painel de edição de um widget está aberto, o widget real na grade (atrás do painel) passa a refletir as mudanças **em tempo real**, sem precisar salvar — inclusive para um widget novo, que aparece como uma prévia num espaço livre da grade.
- O botão "Salvar" (do widget e da dashboard) continua sendo o único jeito de persistir de verdade a alteração.

## 23/07/2026 — Ajustes rápidos (lista resumida)

- Renomeação da marca do projeto para **"Indicadores Sebratel"** (antes "Instalação Sebratel") — título, textos internos, identificadores.
- Editor de widget reorganizado no estilo Power BI: ordem Tipo de visual → Eixo X → Eixo Y → Legenda; nova aba **Modificadores** (mesclar campo de outra fonte, filtro fixo, Top N); nova árvore "Selecionar" (fonte → coluna) para escolher campos, reutilizada em Eixo X/Y/Legenda.
- Corrigido: não dava para trocar a fonte de dados de um widget pelo seletor de eixo (clicar só expandia a árvore) — adicionada opção explícita "usar esta fonte".
- Eixo Y reescrito para funcionar igual ao Eixo X (mesma árvore de seleção), com escolha de agregação (contagem, contagem distinta, soma, média) por campo escolhido.
- Corrigido: um widget novo vinha com um rótulo fantasma "Contagem distinta" no Eixo Y antes de qualquer campo ser escolhido.
- Corrigido: widgets novos sempre nasciam no canto superior esquerdo, por cima de outros — agora nascem num espaço livre da grade, e arrastar um widget por cima de outro deliberadamente passou a ser permitido.
- Adicionados os tipos de gráfico **Colunas/Barras empilhadas** (V/H), **Colunas + linha (combo)**, **Matriz** (tabela dinâmica com hierarquia de linhas e colunas dinâmicas) e, como sugestão extra, **Dispersão (scatter)** e **Funil**.
- Corrigido: cor e rótulo customizados de uma medida não apareciam no gráfico quando havia só uma série (sem legenda) — o backend só montava essa informação a partir de 2 séries em diante.
- Adicionado um pequeno botão de informação ("i") ao lado de cada campo/seção do editor, explicando o que ele faz — com ajuste de posição do balão pra não vazar da tela em ícones perto da borda direita.

## 22/07/2026 — Pivô arquitetural: catálogo único de queries

Mudança estrutural grande, a pedido do usuário ("prefiro que essa função seja nativa... da pra montar manualmente qualquer projeto que eu quiser"):

- Fim do conjunto fixo de métricas pré-calculadas (lógica DAX portada) e das 11 abas fixas de indicadores — tudo passou a ser montado manualmente no Builder.
- Catálogo único e editável de queries SQL (tela de Configurações), com as 12 queries originais como ponto de partida. Cada query vira uma fonte de dados no Builder, com colunas inferidas em tempo real a partir dos dados reais (sem mapeamento manual).
- ETL reescrito para rodar qualquer query do catálogo (não mais um conjunto fixo de tabelas mapeadas).
- Removidas as rotas antigas por aba fixa (`/api/visao-geral`, `/api/relatorio-mes` etc.) e o motor de métricas.

## 20/07/2026 — Personalização avançada de gráficos

- Gráficos de barra/linha/área ganharam suporte a **múltiplas medidas** (uma série por medida) e a **Legenda** (quebra por 2ª dimensão, até 8 séries) — mutuamente exclusivos entre si.
- Tabelas já eram totalmente abertas (qualquer coluna); catálogo de campos das demais fontes foi bem ampliado (de ~10–15 campos por fonte para todos os campos reais existentes).
- Adicionada a mesclagem de campos entre fontes ("JOIN" simples por chave em comum), inicialmente só para tabelas.

## 17/07/2026 — Correções pós-validação do usuário logado

- **Drag & resize não funcionava**: causa raiz era um erro de `process.env` não definido no navegador (dependência interna do `react-grid-layout`), que abortava o início do arraste silenciosamente. Corrigido expondo `process.env.NODE_ENV` no build (Vite).
- **Catálogo de campos restritivo**: reescrito para listar todos os campos reais de cada fonte (antes só uma amostra pequena por tabela).

## Fase inicial — Construção do Dashboard Builder

- Arquitetura decidida com o usuário: configuração compartilhada (uma só para todos), abas/widgets editáveis por drag & drop (`react-grid-layout`), com um botão de "restaurar padrão".
- Implementado: motor de agregação genérico no backend (`widgetQuery.mjs`), catálogo de campos, config declarativa de widgets/abas/filtros, editor de widget e renderer no front, persistência da configuração no servidor.
- Nesta fase, os widgets ainda usavam um catálogo fixo de fontes (tabelas do snapshot ETL) e métricas pré-calculadas — substituído depois pelo catálogo único de queries (ver 22/07/2026).

## Origem do projeto

- Projeto nasceu como uma dashboard de indicadores de Instalação com **11 abas fixas** (Visão Geral, Relatório do Mês/Ano, Premiação, Diário, Telefonia, Manutenção Inicial, Reincidência de Fibra, Field/Agenda, Risco & IA, Protocolos Detalhados), com métricas portadas de um modelo em Power BI/DAX existente, validadas contra um snapshot real de ~95 mil protocolos.
- ETL multi-tabela contra Postgres (DB_ELLEVEN) e MariaDB (DB_Applicattion), com um scheduler de atualização periódica.
- Autenticação Google OAuth restrita ao domínio @sebratel.com.br.
