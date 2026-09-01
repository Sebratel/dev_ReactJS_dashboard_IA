# Melhorias Futuras — Indicadores Sebratel

> Checklist de ideias e possibilidades de evolução do projeto — **não é um roadmap comprometido**, é um repositório de ideias para priorizarmos juntos quando fizer sentido. Cada item tem uma marcação de complexidade (Baixa/Média/Alta/Muito alta) e uma nota técnica de como se encaixaria na arquitetura atual (catálogo único de queries, ETL genérico, Dashboard Builder, hierarquia Pasta → Dashboard → Guia).
>
> O documento tem duas partes: **Parte 1** são os itens que você já tinha anotado (com minha análise de viabilidade). **Parte 2** são sugestões minhas, que você não pediu — deixadas bem separadas para não se misturarem com o que já era seu.
>
> Convenção: `- [ ]` = ainda não feito. Quando algo for implementado, mover a marca para `- [x]` (ou apagar a linha e registrar no `HISTORICO_ALTERACOES.md`, como já fazemos).

---

## Parte 1 — Itens que você já tinha anotado

### A. Fontes de dados e integrações

- [x] **1. Fonte de dados via API — FEITO (29/07/2026), e virou o caminho único**
  Implementado como as fontes do Data Hub (`server/lakehouseSources.mjs`): cadastra-se um dataset publicado no lakehouse + um token, e o ETL busca pela API pública dele. Foi além do item original: o catálogo de queries SQL contra Postgres/MariaDB foi **removido**, porque manter os dois caminhos consumia duas plataformas grandes pela mesma informação. Hoje o app não tem driver nem credencial de banco.

- [x] **2. Google Sheets como fonte livre pelo próprio usuário** — implementado em 28/07/2026, ver `HISTORICO_ALTERACOES.md`.
  Qualquer usuário autenticado cadastra o link da própria planilha do Google (aba Modificadores, no editor de widget) e usa as colunas dela em qualquer gráfico/tabela — leitura via OAuth da própria conta Google do usuário (mesmo escopo pedido no login, ampliado), sem service account. Cada planilha é uma fonte independente (não há mescla automática entre planilhas de um mesmo widget). Upload de Excel (`.xlsx`) **não** foi incluído nesta rodada — pode ser um complemento futuro se surgir a necessidade (parsing de arquivo é uma frente separada da leitura via link).

- [ ] **3. Abrir chamado no ERP Voalle via IA, solicitando ajuste/adição de query**
  Um fluxo dentro do próprio app onde o usuário descreve o que precisa (ex. "preciso de uma coluna X na query Y") e uma IA formata isso como um protocolo/chamado, abrindo automaticamente no Voalle para os administradores.
  **Complexidade:** Alta. Depende diretamente de o Voalle ter uma API de abertura de protocolo (ticket) acessível — isso precisa ser confirmado antes de qualquer estimativa real. Um MVP mais simples e imediato, sem depender do Voalle: uma tela interna de "Solicitações" (lista + status), onde o pedido cai numa fila que os admins veem dentro do próprio Indicadores Sebratel — a IA ajuda só a formatar/estruturar o pedido, sem integrar com um sistema externo. Migrar depois para abrir no Voalle de fato, quando a API existir/for confirmada.

### B. Inteligência Artificial

- [x] **4. IA gera gráficos e dashboards prontos a partir de uma descrição — FEITO (29/07/2026)**
  Usuário descreve o que quer ("quero ver o total instalado por mês, por equipe") e a IA monta o(s) widget(s) ou a dashboard inteira, já usando as fontes/campos reais disponíveis na pasta.
  **Complexidade:** Alta. Tecnicamente dá pra fazer com boa confiabilidade: mandamos pro modelo o catálogo de campos da(s) fonte(s) da pasta (já existe, é o que alimenta o Builder hoje) e pedimos uma saída estruturada no formato exato do `WidgetConfig` (ou de uma lista deles) — o modelo tem boa capacidade de gerar JSON estruturado quando a "gramática" (os tipos, campos, agregações possíveis) é bem definida, que é exatamente o nosso caso. Importante: nunca aplicar direto — sempre mostrar uma pré-visualização e pedir confirmação antes de adicionar de fato à guia, porque o modelo pode interpretar mal um pedido ambíguo.

- [x] **5. Insights automáticos de IA — FEITO (29/07/2026), via widget de texto**
  Um painel (ou um novo tipo de widget) que olha os dados já carregados dos gráficos/tabelas da guia e gera um resumo em texto: tendências, valores fora do padrão, comparações.
  **Complexidade:** Média-alta. Os dados agregados já existem no navegador (é o que os gráficos mostram) — a parte nova é mandar esse resumo (não o dataset bruto, que pode ser grande) pra IA e exibir o texto de volta, num widget tipo "insight". Cuidado a ter: decidir se roda automaticamente (custo de IA a cada carregamento) ou só quando o usuário pedir (um botão "Gerar insight"), que é o caminho mais seguro pra começar.

- [x] **6. IA para gerar medidas e cálculos personalizados** — implementado em 01/09/2026, ver `HISTORICO_ALTERACOES.md`.
  `propose_measures`/`preview_measure`, novas ferramentas da IA: descreve o cálculo em português (inclusive comparativo entre períodos, cruzando fontes diferentes) e a IA monta uma ou mais medidas nomeadas pra aprovação — mesmo motor de fórmula genérica do item 2.9 abaixo, que virou o pré-requisito real como já era esperado aqui. Uma auditoria (mesmo dia, 18 pedidos verificados contra o código real) confirmou que o exemplo original desta linha — "% de reincidência sobre o total instalado" — não era expressável no dia da entrega, porque faltava um filtro fixo por categoria numa medida `simple`. Fechado no mesmo dia (`filters?: WidgetFilter[]`, ver `HISTORICO_ALTERACOES.md`); os demais gaps que a mesma auditoria confirmou (funções não-aritméticas, condicional/texto, estatística avançada, série temporal) viraram o item **2.16** abaixo.

### C. Comparações e análise

- [x] **7. Gráficos/tabelas comparativas (valor no mês 1 x valor no mês 2)** — implementado em 01/09/2026, ver `HISTORICO_ALTERACOES.md`.
  Não como uma variação separada do widget (como a nota original imaginava), e sim via medidas nomeadas com `dateWindow` relativo (ex. "últimos 3 meses" e "mesmo período do ano passado" como duas medidas) combinadas numa medida "formula" (diferença, variação %, o que fizer sentido) — qualquer widget existente (a começar pelo KPI) já sabe mostrar o resultado via `MeasureConfig.measureRef`, sem precisar de um tipo de widget novo.

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
  **Atualização 26/08/2026:** Tabela ganhou o próprio motor de formatação condicional — não o mesmo (o dado de tabela costuma ser texto/categoria, não número contra um limiar), um motor separado por TEXTO de célula (palavra/frase/valor por coluna). Ver `HISTORICO_ALTERACOES.md` (26/08/2026) e `DOCUMENTACAO.md` 3.6.3.

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

- [x] **2.9. Campos calculados reutilizáveis** — implementado em 01/09/2026, ver `HISTORICO_ALTERACOES.md`.
  Virou "medidas nomeadas" (`MeasureDef`, tabela de medidas por DASHBOARD) em vez de "campo da fonte": `kind: 'simple'` (agregação + janela de data relativa opcional) ou `kind: 'formula'` (combina outras medidas nomeadas, inclusive de fontes diferentes, numa expressão aritmética segura). Reutilizável em qualquer widget da mesma dashboard via `MeasureConfig.measureRef`, com ou sem IA — o CRUD manual (`MeasuresEditorModal.tsx`) funciona sozinho, pra quem já sabe a fórmula que quer. Só a parte de "concatenação de dois campos de texto" citada aqui NÃO entrou — isso seria um campo calculado POR LINHA, não uma medida agregada, e não foi pedido nesta rodada.

- [ ] **2.10. Papel de acesso intermediário ("editor de dados")**
  Hoje só existem três níveis: admin, gerente de pasta, e usuário padrão. Pode fazer sentido um papel que só cuida do catálogo de fontes (cadastra/edita fontes de dados) sem precisar ser administrador completo (que também gerencia pastas, usuários, temas etc.) — separando "quem cuida do dado" de "quem cuida da estrutura".

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

- [ ] **2.16. Gaps confirmados do motor de medidas (round/min/max, condicional, estatística avançada, série temporal)**
  Auditoria de 01/09/2026 (18 pedidos de cálculo diversos, verificados contra o código real — ver `HISTORICO_ALTERACOES.md`) confirmou que o motor de medidas (item 6/2.9) NÃO aceita qualquer pedido de cálculo, apesar de a aritmética entre medidas nomeadas (mesma fonte ou cruzando fontes) ser genuinamente aberta. Gaps reais, cada um exigindo uma extensão diferente:
  - **Funções não-aritméticas** (`round`/`floor`/`ceil`/`abs`/`min`/`max`): a gramática de `measureExpr.mjs` só tem `+ - * / % ^ ( )`, sem chamada de função. `abs`/`min`/`max` dão pra simular hoje via identidade algébrica com `^` (ex. `((a-b)^2)^0.5` = valor absoluto) — funciona, mas é gambiarra. `round` não tem workaround nenhum, nem algébrico. Extensão: um nó de AST `{type:'call', name, args}` no parser + `evaluateExpression` + uma allowlist pequena, exposta em `aiMeasureSchema.mjs`.
  - **Lógica condicional/limiar com saída em texto** (ex. "se SLA > 5 dias, mostra 'Crítico'"): não dá pra fazer — não existe comparação (`>`, `<` etc.) na gramática, e uma medida sempre resolve pra `number`, nunca `string`, em toda a cadeia (`resolveMeasure`/`resolveFormulaMeasure`/scope de fórmula). Extensão maior: operadores relacionais + condicional na gramática, e um novo `kind` de medida com saída categórica (texto), não só numérica — mexe em mais lugares do motor do que os outros itens desta lista.
  - **Estatística além de count/countDistinct/sum/avg** (desvio padrão, variância, mediana): `AggKind` e `makeAggregator` (`server/widgetQuery.mjs`) só têm essas 4 agregações streaming de 1 passada. Extensão contida: novo(s) valor(es) em `AggKind` + branch em `makeAggregator` acumulando soma e soma-dos-quadrados + espelhar em `AGGS` (`aiMeasureSchema.mjs`) — não precisa mexer na gramática de fórmula.
  - **Medida como série ao longo do tempo** (ex. "acumulado mês a mês ao longo do ano"): fora de escopo de `MeasureDef` por design — uma medida sempre resolve pra 1 escalar (`resolveMeasure` retorna `{value: number, ...}`), nunca uma lista de pontos. A extensão certa é ortogonal a medidas: um flag de pós-agregação no WIDGET (ex. `cumulative?: boolean` numa série), aplicado no loop que já monta os pontos do gráfico — não em `resolveMeasure`/`measureExpr.mjs`.
  - Já fora de escopo desde a entrega original (item 2.9): campo calculado POR LINHA (ex. concatenar texto de duas colunas) — não é uma medida agregada, precisaria de um mecanismo novo e paralelo (ex. `computedColumns` em `WidgetConfig`, só pra tabelas).
