# Melhorias Futuras — Indicadores Sebratel

> Checklist de ideias e possibilidades de evolução do projeto — **não é um roadmap comprometido**, é um repositório de ideias para priorizarmos juntos quando fizer sentido. Cada item tem uma marcação de complexidade (Baixa/Média/Alta/Muito alta) e uma nota técnica de como se encaixaria na arquitetura atual (catálogo único de queries, ETL genérico, Dashboard Builder, hierarquia Pasta → Dashboard → Guia).
>
> O documento tem duas partes: **Parte 1** são os itens que você já tinha anotado (com minha análise de viabilidade). **Parte 2** são sugestões minhas, que você não pediu — deixadas bem separadas para não se misturarem com o que já era seu.
>
> Convenção: `- [ ]` = ainda não feito. Quando algo for implementado, mover a marca para `- [x]` (ou apagar a linha e registrar no `HISTORICO_ALTERACOES.md`, como já fazemos).

---

## Parte 1 — Itens que você já tinha anotado

### A. Fontes de dados e integrações

- [ ] **1. Fonte de dados via API de outro app (além de conexão direta ao banco)**
  Hoje toda fonte é uma query SQL contra Postgres ou MariaDB (`server/queryCatalog.mjs`). A ideia é permitir cadastrar uma fonte do tipo "API/link" — em vez de SQL, o ETL faz uma chamada HTTP (GET/POST) para o app de tabelas/queries e usa a resposta como as linhas da fonte, do mesmo jeito que hoje usa o resultado de uma query. Os dois tipos convivem: a mesma tela de Configurações passaria a ter um seletor "SQL" ou "API/link" ao criar uma query.
  **Complexidade:** Média. Decisões a tomar: formato de autenticação da API externa (token fixo? OAuth?), formato esperado da resposta (JSON de array de objetos é o caminho mais direto, já que o motor de widgets já trabalha com linhas como objetos), e se o refresh segue o mesmo agendador (tempo real/agendado) que já existe por query.

- [x] **2. Google Sheets como fonte livre pelo próprio usuário** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  Qualquer usuário autenticado cadastra o link da própria planilha do Google (aba Modificadores, no editor de widget) e usa as colunas dela em qualquer gráfico/tabela — leitura via OAuth da própria conta Google do usuário (mesmo escopo pedido no login, ampliado), sem service account. Cada planilha é uma fonte independente (não há mescla automática entre planilhas de um mesmo widget). Upload de Excel (`.xlsx`) **não** foi incluído nesta rodada — pode ser um complemento futuro se surgir a necessidade (parsing de arquivo é uma frente separada da leitura via link).

- [ ] **3. Abrir chamado no ERP Voalle via IA, solicitando ajuste/adição de query**
  Um fluxo dentro do próprio app onde o usuário descreve o que precisa (ex. "preciso de uma coluna X na query Y") e uma IA formata isso como um protocolo/chamado, abrindo automaticamente no Voalle para os administradores.
  **Complexidade:** Alta. Depende diretamente de o Voalle ter uma API de abertura de protocolo (ticket) acessível — isso precisa ser confirmado antes de qualquer estimativa real. Um MVP mais simples e imediato, sem depender do Voalle: uma tela interna de "Solicitações" (lista + status), onde o pedido cai numa fila que os admins veem dentro do próprio Indicadores Sebratel — a IA ajuda só a formatar/estruturar o pedido, sem integrar com um sistema externo. Migrar depois para abrir no Voalle de fato, quando a API existir/for confirmada.

### B. Inteligência Artificial

- [ ] **4. IA (Gemini/Anthropic) gera gráficos e dashboards prontos a partir de uma descrição**
  Usuário descreve o que quer ("quero ver o total instalado por mês, por equipe") e a IA monta o(s) widget(s) ou a dashboard inteira, já usando as fontes/campos reais disponíveis na pasta.
  **Complexidade:** Alta. Tecnicamente dá pra fazer com boa confiabilidade: mandamos pro modelo o catálogo de campos da(s) fonte(s) da pasta (já existe, é o que alimenta o Builder hoje) e pedimos uma saída estruturada no formato exato do `WidgetConfig` (ou de uma lista deles) — o modelo tem boa capacidade de gerar JSON estruturado quando a "gramática" (os tipos, campos, agregações possíveis) é bem definida, que é exatamente o nosso caso. Importante: nunca aplicar direto — sempre mostrar uma pré-visualização e pedir confirmação antes de adicionar de fato à guia, porque o modelo pode interpretar mal um pedido ambíguo.

- [ ] **5. Insights automáticos de IA lendo o que está na tela**
  Um painel (ou um novo tipo de widget) que olha os dados já carregados dos gráficos/tabelas da guia e gera um resumo em texto: tendências, valores fora do padrão, comparações.
  **Complexidade:** Média-alta. Os dados agregados já existem no navegador (é o que os gráficos mostram) — a parte nova é mandar esse resumo (não o dataset bruto, que pode ser grande) pra IA e exibir o texto de volta, num widget tipo "insight". Cuidado a ter: decidir se roda automaticamente (custo de IA a cada carregamento) ou só quando o usuário pedir (um botão "Gerar insight"), que é o caminho mais seguro pra começar.

- [ ] **6. IA para gerar medidas e cálculos personalizados**
  Usuário descreve um cálculo que quer (ex. "percentual de reincidência sobre o total instalado no mês") e a IA monta a fórmula, usando os campos disponíveis.
  **Complexidade:** Alta — e tem uma dependência real: hoje o motor de agregação só sabe fazer contagem/contagem distinta/soma/média sobre UM campo por vez (`server/widgetQuery.mjs`). Não existe ainda o conceito de "campo calculado" (uma fórmula combinando duas medidas, tipo razão ou diferença percentual). Esse recurso precisaria existir primeiro — ver sugestão 2.9 na Parte 2, que é exatamente esse pré-requisito — e a IA entraria depois como uma forma mais fácil de escrever essa fórmula, não como o motor em si.

### C. Comparações e análise

- [ ] **7. Gráficos/tabelas comparativas (valor no mês 1 x valor no mês 2)**
  Comparar o mesmo indicador em dois períodos (ou dois recortes) lado a lado, com a diferença/variação.
  **Complexidade:** Média. Dá pra encaixar como uma variação do widget de gráfico/tabela existente: em vez de um único período, o usuário escolhe dois períodos (ou dois conjuntos de valores de filtro) e o motor calcula a mesma medida para cada um, mostrando os dois valores e a diferença absoluta/percentual — como séries lado a lado no gráfico, ou colunas extra na tabela/matriz.

### D. Colaboração e uso simultâneo

- [ ] **8. Testar e ajustar limite de edição simultânea na mesma dashboard/guia**
  Hoje, se duas pessoas editam a mesma guia ao mesmo tempo, quem salva por último sobrescreve o que a outra pessoa salvou, sem aviso nenhum.
  **Complexidade:** Baixa-média, e a infraestrutura de apoio já existe em parte: já sabemos quem está online (heartbeat, usado hoje na aba Acessos). O caminho mais simples: ao entrar em modo edição numa guia, avisar se outra pessoa também está editando a mesma guia agora (via o mesmo mecanismo de presença); ao salvar, comparar um "carimbo" de quando a guia foi carregada com o `updatedAt` atual no servidor — se mudou entretanto, avisar antes de sobrescrever, em vez de aplicar direto.

### E. Confiança e explicação do dado

- [x] **9. Explicação e origem de cada coluna, editável pelos administradores** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  Nova seção "Dicionário de dados" em Configurações (admin); a descrição escrita aparece como InfoHint (i) ao lado do campo nos seletores do Builder (Eixo X/Y, Legenda, Filtro, colunas de tabela).

### F. Metas, alertas e formatação condicional

> Nota minha: os itens 10, 11 e 12 abaixo (rótulos por série, alertas por meta, e meta com cor dinâmica no gráfico) são, no fundo, faces do mesmo recurso — o Power BI chama isso de "formatação condicional". Minha sugestão é implementar um único motor de regras (`valor` + `operador` + `cor/efeito`) que sirva pros três de uma vez, em vez de três funcionalidades separadas. Detalhei essa sugestão de motor único na Parte 2 (2.1).

- [x] **10. Ativar rótulos de dados separadamente por série, não só tudo/nada** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  Cada pílula de medida (Eixo Y ou Eixo Y - Linha do combo), quando há mais de uma, tem seu próprio seletor "Padrão do widget / Sempre mostrar / Nunca mostrar" — o toggle geral em Formato continua sendo o padrão.

- [x] **11. Alertas — meta/métrica definida pelo usuário, com cor/efeito quando atingida** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  KPI ganhou `target` (meta, mostrada ao lado do valor) + regras do motor condicional (2.1) — o card inteiro muda de fundo/pisca/brilha conforme o valor.

- [x] **12. Meta dentro do próprio gráfico, com cor dinâmica da coluna/linha/célula** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  `ReferenceLine` na meta pra bar/barH/barStacked/barHStacked/comboBarLine/histogram/line/area; cor dinâmica por barra individual (bar-family + combo/histograma) e por célula da matriz. Line/area só desenham a linha de meta (sem coloração por trecho). Tabela não entrou nesta rodada.

- [x] **13. Formato: sombra de fundo, piscar, brilho, cor de fundo dinâmica** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  Sombra/brilho/piscar como toggles fixos em "Aparência do widget"; "fundo dinâmico" usa o motor condicional (2.1), hoje aplicado ao card do KPI.

---

## Parte 2 — Sugestões adicionais (minhas, não pedidas por você)

Estas são ideias que não estavam na sua lista — coisas que percebo como lacunas ou continuações naturais do que já construímos, olhando pra ferramentas parecidas (Power BI, Looker, Metabase) e pro que já existe no projeto.

- [x] **2.1. Motor único de "formatação condicional" (meta + regra + efeito)** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  `conditionalFormat.ts` — lista de regras "se o valor for {operador} {número}, aplica {cor de fundo / piscar / brilho}", reaproveitada por KPI (11), gráficos/matriz (12) e fundo dinâmico (13). Não incluiu "cor da série" nem "mostrar ícone" como efeitos separados nesta rodada (cor de fundo já cobre o caso de uso principal); pode ser estendido depois se fizer falta.

- [ ] **2.2. Exportar e compartilhar**
  Hoje a única forma de "levar" um dado pra fora do app é print de tela. Seria valioso: exportar um widget ou a guia inteira como PDF/imagem/Excel, e um link direto pra uma guia específica já com os filtros aplicados (pra mandar pra alguém sem precisar explicar "vai em tal pasta, tal dashboard, filtra por tal coisa").

- [ ] **2.3. Envio agendado por e-mail**
  Uma guia (ou um widget) sendo enviado automaticamente por e-mail em um horário/frequência definida — útil pra quem só precisa ver o número toda segunda de manhã, sem entrar no app.

- [ ] **2.4. Modo apresentação / TV com rotação entre guias**
  Já existe atualização automática de dados numa guia fixa (pensado pra TV de painel). O próximo passo natural é rotacionar automaticamente entre várias guias de uma dashboard (ou de várias dashboards), tipo um carrossel — sem precisar de alguém clicando manualmente pra trocar de tela.

- [ ] **2.5. Histórico de versões da guia (poder reverter)**
  Hoje "Descartar" só desfaz o que ainda não foi salvo. Depois de salvo, não tem como voltar pra uma versão anterior se alguém salvar algo errado por engano. Guardar as últimas N versões salvas de cada guia (com quem salvou e quando) resolveria isso, e também se conecta com o item 8 da Parte 1 (edição simultânea).

- [x] **2.6. Comentários/anotações em um widget** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  Ícone de comentário no cabeçalho de todo widget, em qualquer modo — qualquer usuário autenticado lê/comenta; remover é só de quem escreveu ou admin.

- [ ] **2.7. Busca global (pastas, dashboards, guias, widgets)**
  Conforme o número de pastas e dashboards crescer, vai ficar mais difícil achar onde está um gráfico específico só navegando pelo menu. Uma busca rápida (atalho de teclado, tipo "Ctrl+K") ajudaria bastante.

- [ ] **2.8. Favoritos / fixar no topo do menu**
  Deixar uma dashboard "favorita" pra aparecer sempre no topo do menu, sem precisar navegar pela hierarquia de pastas toda vez.

- [ ] **2.9. Campos calculados reutilizáveis**
  Um campo derivado de uma fórmula simples (razão entre duas medidas, diferença percentual entre dois períodos, concatenação de dois campos de texto...), calculado uma vez e disponível como se fosse mais um campo da fonte, reutilizável em qualquer widget. Isso é, na prática, o pré-requisito técnico do item 6 da Parte 1 (IA gerando cálculos) — e também tem valor sozinho, sem IA nenhuma, pra quem já sabe exatamente a fórmula que quer.

- [ ] **2.10. Papel de acesso intermediário ("editor de dados")**
  Hoje só existem três níveis: admin, gerente de pasta, e usuário padrão. Pode fazer sentido um papel que só cuida do catálogo de queries (cadastra/edita fontes de dados) sem precisar ser administrador completo (que também gerencia pastas, usuários, temas etc.) — separando "quem cuida do dado" de "quem cuida da estrutura".

- [ ] **2.11. Auditoria com detalhe do que mudou**
  O log de auditoria (aba Acessos) já registra quem fez o quê e quando, mas não o que mudou de fato num "Salvar" de dashboard. Guardar um resumo de diferença (ex. "3 widgets adicionados, 1 removido") deixaria a auditoria mais útil pra investigar problemas.

- [ ] **2.12. Testes automatizados**
  Hoje toda verificação de uma funcionalidade nova é manual (harness temporário no navegador, probes isolados). Conforme o app cresce, vale a pena formalizar isso em uma suíte de testes automatizados (pelo menos pros pontos mais sensíveis: motor de agregação, permissões de acesso), pra pegar regressões sem precisar testar tudo de novo na mão a cada mudança.

- [ ] **2.13. Performance em dashboards com muitos widgets**
  Hoje cada widget busca seus próprios dados de forma independente. Numa guia com muitos widgets pesados, isso pode gerar bastante carga simultânea no servidor. Vale medir e, se necessário, agrupar/paralelizar com algum limite (parecido com o que já fazemos no ETL, que roda as queries em sequência de propósito).

- [ ] **2.14. Link público somente leitura (sem login)**
  Pra relatórios não sensíveis, permitir gerar um link de visualização pública (sem exigir login Google) — útil pra compartilhar com alguém de fora da empresa, ou num painel público, sem abrir uma conta pra essa pessoa.

- [ ] **2.15. Revisão de responsividade (mobile)**
  O Builder hoje é claramente pensado pra tela grande (grade arrastável, painéis laterais). Vale uma passada específica pra ver como fica num celular/tablet — pelo menos o modo visualização, já que o modo edição provavelmente vai continuar sendo mais natural no desktop.
