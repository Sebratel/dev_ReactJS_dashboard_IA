// ─────────────────────────────────────────────────────────────────────────
// O CONTRATO entre a IA e o Builder.
//
// A IA nunca gera código nem SQL: ela emite um `WidgetConfig` — a mesma
// estrutura declarativa que a UI de edição produz (src/features/builder/
// types.ts) e que o motor de agregação já sabe renderizar
// (server/widgetQuery.mjs). Isso é o que torna a feature segura e barata:
// nada é executado, o dado bruto nunca sobe pro modelo, e o resultado é
// determinístico.
//
// Duas coisas vivem aqui:
//
//   1. WIDGET_SCHEMA — o JSON Schema que descreve pro modelo o formato de
//      saída. Cobre o WidgetConfig quase inteiro, incluindo toda a aparência
//      que o editor manual (aba Formato) permite ajustar — cor, paleta,
//      fundo, opacidade, formatação de texto (título/subtítulo/eixos/
//      legenda/linhas e colunas da matriz), rótulos de dado, formatação de
//      tabela, grade, sombra/brilho/piscar e meta/alertas (formatação
//      condicional). Decisão explícita do dono do projeto: "todas as opções
//      de personalização manual devem estar liberadas para a IA usar quando
//      solicitado" — depois de uma 1ª versão que só expunha um subconjunto
//      pequeno (cor/paleta/fundo/título) ter sido considerada insuficiente
//      num teste real.
//      A régua é a mesma em TODO campo de aparência: AUSENTE por padrão — o
//      widget nasce com a aparência padrão do app/tema da guia, igual a um
//      widget feito à mão — e só PRESENTE quando o pedido do usuário, no
//      turno atual ou num anterior da conversa, pediu algo sobre cor/visual/
//      design/tamanho/variedade (ver INSTRUCTIONS em aiAssistant.mjs).
//      Fora do schema, deliberadamente: a POSIÇÃO do widget na grade (x/y)
//      continua sempre calculada no cliente por findFreeSpot, nunca pelo
//      modelo (mudar isso arriscaria widgets sobrepostos); e `columnWidths`
//      de tabela (largura de coluna em px) — é ajuste de arrastar-e-ver que
//      não faz sentido o modelo adivinhar sem ver a tabela renderizada.
//
//   2. validateWidget/normalizeWidget — a checagem que o JSON Schema NÃO
//      consegue fazer: se os campos citados existem de verdade na fonte. O
//      schema garante a forma; só o catálogo real garante o conteúdo. Erros
//      voltam como texto pro modelo (tool_result com is_error), que corrige
//      sozinho na volta — em vez de gravar um widget quebrado.
// ─────────────────────────────────────────────────────────────────────────

// Tipos que o modelo pode propor. É a lista de WidgetType (types.ts) menos
// nada — todos são suportados pelo motor.
const WIDGET_TYPES = [
  'kpi', 'bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine',
  'line', 'area', 'pie', 'scatter', 'funnel', 'table', 'matrix', 'text', 'histogram',
]
const AGGS = ['countDistinct', 'count', 'sum', 'avg']

// Visuais que agregam por dimensão com MÚLTIPLAS séries possíveis (usam
// `measures[]`), versus os de medida única (usam `measure`). Espelha o que
// widgetQuery.mjs/WidgetRenderer.tsx esperam — ver types.ts:131-133.
const MULTI_MEASURE_TYPES = new Set(['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'line', 'area'])
const SINGLE_MEASURE_TYPES = new Set(['kpi', 'pie', 'funnel', 'scatter'])
// Não consomem fonte de dados: texto livre (usado também pelos insights que a
// IA escreve).
const SOURCELESS_TYPES = new Set(['text'])

// Tamanho padrão na grade por tipo, em unidades do react-grid-layout (24
// colunas). A IA pode sugerir outro via w/h; a posição (x/y) é sempre
// calculada no cliente por findFreeSpot, nunca pelo modelo.
// Dobrado (26/08/2026) junto com a resolução da grade (12→24 colunas,
// 56→22px por linha — ver ROW_HEIGHT/GRID_COLS em DashboardBuilder.tsx e a
// migração em server/workspace.mjs::migrateGridResolution) — mesmo tamanho
// VISUAL de sempre, só que expresso na unidade nova, duas vezes mais fina.
const DEFAULT_SIZE = {
  // KPI reduzido (01/09/2026) pra bater com o mesmo tamanho compacto do
  // editor manual (WidgetEditorModal.tsx) — um Card só mostra um número, sem
  // eixo/legenda, então h:8 sobrava visivelmente "enorme" ao lado de um Card
  // redimensionado à mão.
  kpi: { w: 6, h: 6 }, text: { w: 8, h: 8 }, pie: { w: 8, h: 16 }, funnel: { w: 8, h: 16 },
  table: { w: 12, h: 18 }, matrix: { w: 12, h: 18 }, scatter: { w: 12, h: 16 }, histogram: { w: 12, h: 16 },
}
const FALLBACK_SIZE = { w: 12, h: 16 }

// Cor em hexadecimal (#RRGGBB) — mesmo formato que os seletores de cor do
// editor manual produzem. Descrição repete a regra de "só preencha se
// pedido" em cada campo, porque cada um é validado/lido isoladamente pelo
// modelo — repetir custa pouco (fica dentro do prefixo cacheado) e reduz a
// chance de um campo escapar da regra.
const HEX_COLOR = {
  type: 'string',
  pattern: '^#[0-9a-fA-F]{6}$',
  description: 'Cor em hexadecimal, ex. "#2563eb". Só defina se o usuário pediu uma cor específica ou "cores diferentes/variadas" — sem pedido de cor, OMITA este campo.',
}

const OPACITY = { type: 'integer', minimum: 0, maximum: 100, description: 'Opacidade, 0-100.' }

// Formatação de texto genérica — título/subtítulo/legenda/linhas e colunas da
// matriz usam este formato. Espelha TextFormat (types.ts), exceto `margin`
// (só existe nos eixos — ver axisFormatSchema).
const textFormatSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    fontSize: { type: 'integer', minimum: 8, maximum: 48 },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    color: { ...HEX_COLOR, description: 'Cor do texto.' },
    opacity: { ...OPACITY, description: 'Opacidade da cor do texto. Só faz sentido com `color` definido.' },
    backgroundColor: { ...HEX_COLOR, description: 'Fundo desenhado atrás do texto.' },
    backgroundOpacity: { ...OPACITY, description: 'Opacidade do `backgroundColor`. Só faz sentido com `backgroundColor` definido.' },
  },
}

// Título/subtítulo/linhas/colunas da matriz também têm alinhamento
// horizontal — eixo e legenda não entram aqui de propósito: rótulo de eixo é
// ancorado à escala, e a legenda é uma linha de itens lado a lado — nenhum
// dos dois tem uma "largura" clara pra alinhar dentro (mesma régua do editor
// manual, ver `showAlign` em TextFormatEditor, WidgetEditorModal.tsx).
const alignedTextFormatSchema = {
  ...textFormatSchema,
  properties: {
    ...textFormatSchema.properties,
    align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Alinhamento horizontal do texto.' },
  },
}

// Eixo X/Eixo Y usam o mesmo formato de texto, mais `margin` (recuo manual em
// px — soma ao espaço reservado automaticamente pro rótulo do eixo; aceita
// negativo pra apertar o espaço quando o automático reserva mais do que
// precisa).
const axisFormatSchema = {
  ...textFormatSchema,
  properties: {
    ...textFormatSchema.properties,
    margin: { type: 'integer', description: 'Recuo manual em px (inferior no Eixo X, lateral no Eixo Y). Só use se um rótulo estiver sendo cortado ou sobrando espaço demais — não é um campo de "estilo".' },
  },
}

// Rótulos de dado sobre o próprio gráfico (valor/nome/% em cada barra/ponto/
// fatia) — espelha DataLabelFormat.
// `position` é ignorado pelo motor em barStacked/barHStacked: rótulo
// empilhado é sempre o TOTAL da pilha, sempre acima dela — não é uma opção
// (um rótulo por segmento se sobrepõe e quebra a leitura com várias séries).
// Não precisa de campo próprio pra isso: `dataLabels.show=true` num widget
// desses dois tipos já basta, o motor decide sozinho.
const dataLabelFormatSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    show: { type: 'boolean' },
    position: { type: 'string', enum: ['inside', 'outside', 'top', 'center'] },
    content: { type: 'string', enum: ['value', 'name', 'percent', 'valueAndName', 'all'] },
    fontSize: { type: 'integer', minimum: 8, maximum: 32 },
    color: { ...HEX_COLOR },
    opacity: OPACITY,
  },
}

const measureSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agg: { type: 'string', enum: AGGS, description: 'Agregação. sum/avg exigem `field`.' },
    field: { type: 'string', description: 'Campo numérico. Obrigatório para sum/avg; para count/countDistinct é opcional (sem campo = conta linhas).' },
    label: { type: 'string', description: 'Rótulo da série. Só relevante com múltiplas medidas.' },
    color: { ...HEX_COLOR, description: 'Cor desta série. Só defina se o usuário pediu cores diferentes por série — sem pedido, OMITA.' },
    dataLabels: { ...dataLabelFormatSchema, description: 'Override de rótulo de dado só desta série (ausente = usa o `dataLabels` do widget, que é o padrão de todas). Só relevante com múltiplas medidas/legenda, e só se foi pedido.' },
  },
  required: ['agg'],
}

// Regra de formatação condicional ("meta e alertas") — espelha
// Velocidade do piscar — compartilhada pelos dois motores de regra (numérico
// e de texto da tabela) abaixo. Ausente = 'normal'.
const BLINK_SPEED_SCHEMA = {
  type: 'string', enum: ['slower', 'slow', 'normal', 'fast', 'faster'],
  description: "Velocidade do piscar: slower=super lento, slow=lento, normal=padrão, fast=rápido, faster=super rápido. Só faz sentido com blink=true. Omita pra usar 'normal'.",
}

// Mesma escala de 5 níveis de BLINK_SPEED_SCHEMA, tipo próprio — ver
// ChartAnimationSpeed em types.ts (piscar e Gráfico dinâmico são conceitos
// independentes, mantidos separados de propósito).
const CHART_ANIM_SPEED_SCHEMA = {
  type: 'string', enum: ['slower', 'slow', 'normal', 'fast', 'faster'],
  description: "Velocidade do ciclo do Gráfico dinâmico: slower=super lento, slow=lento, normal=padrão, fast=rápido, faster=super rápido. Omita pra usar 'normal'.",
}

// ConditionalRule. Sem `id`: o modelo não inventa (schema não aceita), o
// normalizeWidget gera um id de verdade pra cada regra na proposta.
const conditionalRuleSchema = {
  type: 'object', additionalProperties: false,
  description: 'Regra "se o valor for {operator} {value}, aplica {effect}". Avaliadas em ORDEM — a ÚLTIMA que bater vence (dá pra empilhar em cascata, ex. "verde se >= meta" seguida de "vermelho se < meta").',
  properties: {
    operator: { type: 'string', enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'], description: 'gt=maior que, gte=maior ou igual, lt=menor que, lte=menor ou igual, eq=igual, neq=diferente.' },
    value: { type: 'number' },
    effect: {
      type: 'object', additionalProperties: false,
      properties: {
        backgroundColor: { ...HEX_COLOR, description: 'Cor de fundo quando a regra bate (card do KPI / barra do gráfico / célula da matriz).' },
        blink: { type: 'boolean' },
        blinkSpeed: BLINK_SPEED_SCHEMA,
        glow: { type: 'boolean', description: 'Brilho — só visível no KPI (é o card inteiro que brilha).' },
        applyTo: {
          type: 'string', enum: ['bar', 'label', 'both'],
          description: "Só em bar/barH/barStacked/barHStacked/comboBarLine/histogram (os únicos com barra E rótulo de dados separados): onde a cor/piscar aparecem — 'bar' só na barra (rótulo fica no padrão), 'label' só no rótulo (barra fica no padrão), 'both' nos dois. Omita pra usar 'both' — só defina se o usuário pediu especificamente só a barra ou só o número piscando/colorindo.",
        },
      },
    },
  },
  required: ['operator', 'value', 'effect'],
}

// Formatação condicional POR COLUNA da tabela — espelha TableConditionalRule.
// Motor separado de conditionalRuleSchema acima: compara TEXTO de célula
// (palavra/frase/valor), não número. Sem `id`, mesma razão de conditionalRuleSchema.
const tableConditionalRuleSchema = {
  type: 'object', additionalProperties: false,
  description: 'Regra "se o texto da célula, na coluna {column}, {operator} {match}, aplica {color}/{backgroundColor}/{blink}". Avaliadas em ORDEM por coluna — a ÚLTIMA que bater, na mesma coluna, vence. Não diferencia maiúsculas de minúsculas.',
  properties: {
    column: { type: 'string', description: 'Chave da coluna (deve estar em `columns`).' },
    operator: { type: 'string', enum: ['equals', 'contains'], description: 'equals=texto igual (ignorando maiúsculas/espaço nas pontas), contains=texto contém a palavra/frase.' },
    match: { type: 'string', description: 'Palavra, frase ou valor a comparar com o texto da célula.' },
    color: { ...HEX_COLOR, description: 'Cor da fonte quando a regra bate.' },
    backgroundColor: { ...HEX_COLOR, description: 'Cor de fundo da célula quando a regra bate.' },
    blink: { type: 'boolean' },
    blinkSpeed: BLINK_SPEED_SCHEMA,
    applyTo: {
      type: 'string', enum: ['cell', 'row'],
      description: "'cell' (padrão, use quando ausente) = só a célula que bateu muda. 'row' = a LINHA INTEIRA (todas as colunas daquela linha) recebe a mesma cor/fundo/pisca quando a coluna da regra bate. Só use 'row' se o usuário pediu destacar a linha toda, não só o valor de uma coluna.",
    },
  },
  required: ['column', 'operator', 'match'],
}

const tableFormatSchema = {
  type: 'object', additionalProperties: false,
  description: "Só em type='table'.",
  properties: {
    fontSize: { type: 'integer', minimum: 8, maximum: 24 },
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    headerBold: { type: 'boolean' },
    color: { ...HEX_COLOR, description: 'Cor do texto (cabeçalho + corpo).' },
    columnLabels: {
      type: 'object', additionalProperties: { type: 'string' },
      description: 'Renomeia o cabeçalho exibido de uma coluna, por chave do campo (a chave real do dado não muda) — ex. {"numeroProtocolo": "Protocolo"}.',
    },
  },
}

export const WIDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: WIDGET_TYPES, description: 'Tipo do visual.' },
    title: { type: 'string', description: 'Título curto e específico, em português.' },
    subtitle: { type: 'string' },
    content: { type: 'string', description: "Só para type='text': o texto/insight a exibir. Não use markdown." },
    source: { type: 'string', description: "Chave da fonte, exatamente como no catálogo (ex. 'Q_PROTOCOLOS_GERAL' ou 'dhub:dh_abc'). Obrigatório em tudo menos type='text'." },
    dimensions: {
      type: 'array', items: { type: 'string' },
      description: "Eixo X. Um campo, ou 'year:<campo>' / 'quarter:<campo>' / 'month:<campo>' / 'day:<campo>' pra agrupar uma data por ano/trimestre/mês/dia. Vários campos = agrupamento composto — combine 2+ buckets do MESMO campo de data pra formar uma Hierarquia de datas de verdade (ex. ['year:Data','month:Data'] = uma barra por mês, já rotulada '2026 / Agosto'; acrescentar 'day:Data' desce até o dia). Prefira o bucket mais largo que ainda faça sentido pra série (month: pra cobrir vários meses/anos, day: só quando o intervalo é curto) — muitas categorias deixam o gráfico ilegível.",
    },
    legendDimension: { type: 'string', description: 'Campo que quebra o gráfico em uma série por valor (barras/linha/área). Não combine com múltiplas medidas.' },
    measure: { ...measureSchema, description: 'Medida única — use em kpi, pie, funnel, scatter (eixo Y) e table.' },
    measures: { type: 'array', items: measureSchema, description: 'Séries — use em bar*, line, area, comboBarLine. Ignorado se legendDimension estiver definido.' },
    measuresLine: { type: 'array', items: measureSchema, description: "Só em comboBarLine: as séries desenhadas como LINHA no eixo Y direito." },
    measureX: { ...measureSchema, description: 'Só em scatter: a medida do eixo X.' },
    widgetFilters: {
      type: 'array',
      description: 'Filtro fixo do widget. Use field_values antes para conferir a grafia exata dos valores. Só filtre quando o pedido pedir esse recorte (ou ele for indispensável) — e então diga o recorte no subtitle (ex. "Só protocolos encerrados") e use o MESMO filtro nos outros widgets do mesmo assunto: dois gráficos da mesma coisa, um com filtro e outro sem, mostram números diferentes e parecem errados.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          field: { type: 'string' },
          op: { type: 'string', enum: ['in', 'notIn'] },
          values: { type: 'array', items: { type: 'string' } },
        },
        required: ['field', 'op', 'values'],
      },
    },
    columns: { type: 'array', items: { type: 'string' }, description: "Só em table: colunas exibidas, na ordem. Um campo de data pode entrar puro (valor linha a linha) E/OU como bucket 'year:<campo>'/'quarter:<campo>'/'month:<campo>'/'day:<campo>' — cada um vira uma coluna própria (ex. Ano e Mês como 2 colunas separadas do mesmo campo)." },
    matrixRows: { type: 'array', items: { type: 'string' }, description: "Só em matrix: campos nas linhas (hierarquia, com subtotal por nível). Aceita bucket de data ('year:'/'quarter:'/'month:'/'day:<campo>') — combine 2+ do MESMO campo, na ordem year→quarter→month→day, pra uma Hierarquia de datas de verdade (Ano como nível 1, Mês aninhado dentro, etc.)." },
    matrixColumns: { type: 'array', items: { type: 'string' }, description: "Só em matrix: campos nas colunas. Mesma regra de bucket de data de matrixRows." },
    matrixValue: { ...measureSchema, description: 'Só em matrix: a medida de cada célula.' },
    histogramField: { type: 'string', description: 'Só em histogram: o campo numérico a distribuir em faixas.' },
    histogramBins: { type: 'integer', description: 'Só em histogram: quantidade de faixas (padrão 10).' },
    limit: { type: 'integer', description: 'Top N — quantos pontos/linhas manter.' },
    sort: { type: 'string', enum: ['asc', 'desc'] },
    target: { type: 'number', description: 'Meta: desenha uma linha de referência no gráfico e é o valor comparado no KPI. Só defina se o usuário pediu uma meta/alvo — não é um campo de estilo.' },
    targetLineColor: { ...HEX_COLOR, description: 'Cor da linha de meta (não afeta o KPI, que não desenha linha). Ausente = vermelho padrão. Só faz sentido com `target` definido — só defina se foi pedido.' },
    targetLineOpacity: { ...OPACITY, description: 'Opacidade de `targetLineColor`. Só faz sentido com `targetLineColor` definido.' },
    w: { type: 'integer', description: 'Largura na grade de 24 colunas. Omita para usar o padrão do tipo — a menos que o usuário tenha pedido tamanhos/layout variados, aí varie de propósito entre os widgets propostos (ex. um KPI menor, um gráfico-destaque maior).' },
    h: { type: 'integer', description: 'Altura na grade. Omita para usar o padrão do tipo — mesma regra de `w`.' },
    // Daqui pra baixo: TODA a aparência que o editor manual (aba Formato)
    // permite ajustar. Mesma régua em cada campo, repetida na descrição de
    // propósito (custa pouco — fica dentro do prefixo cacheado; reduz a
    // chance de um campo escapar da regra): AUSENTE por padrão, PRESENTE só
    // quando o usuário pediu algo sobre cor/visual/design/tamanho/variedade.
    color: { ...HEX_COLOR, description: 'Cor principal do widget (usada quando há uma série só). Só defina se foi pedido — sem pedido, OMITA.' },
    palette: {
      type: 'array', items: HEX_COLOR, minItems: 2, maxItems: 8,
      description: 'Sequência de cores pras séries/fatias sem cor própria (pizza, funil, dispersão, ou barra/linha com várias categorias). Só defina se foi pedido. Quando definir, use cores realmente distintas entre si (matizes diferentes, não um degradê da mesma cor).',
    },
    backgroundColor: { ...HEX_COLOR, description: 'Cor de fundo do card do widget inteiro. Só defina se foi pedido.' },
    backgroundOpacity: { ...OPACITY, description: 'Opacidade do `backgroundColor`. Só faz sentido com `backgroundColor` definido.' },
    seriesOpacity: { ...OPACITY, description: 'Opacidade do preenchimento das colunas/linhas/fatias do gráfico. Só defina se foi pedido.' },
    iconColor: { ...HEX_COLOR, description: 'Cor dos ícones de editar/duplicar/excluir no cabeçalho (só aparecem em modo edição). Raramente vale a pena definir — só se foi pedido especificamente.' },
    gridLines: { type: 'string', enum: ['both', 'horizontal', 'vertical', 'none'], description: 'Linhas de grade pontilhadas do fundo do gráfico. Padrão do app: both. Só defina se foi pedido.' },
    gridLinesColor: { ...HEX_COLOR, description: 'Cor das linhas de grade. Ausente = cor neutra padrão do tema. Só defina se foi pedido.' },
    gridLinesOpacity: { ...OPACITY, description: 'Opacidade de `gridLinesColor`. Só faz sentido com `gridLinesColor` definido.' },
    dynamicAnimation: {
      type: 'boolean',
      description: "\"Gráfico dinâmico\": o gráfico se desenha sozinho do início ao fim e reinicia em loop (linha/área traçando, barra crescendo uma de cada vez da esquerda pra direita, pizza/funil/dispersão desenhando), sem o dado mudar. Só em tipos com forma pra desenhar (bar/barH/barStacked/barHStacked/comboBarLine/line/area/scatter/pie/funnel/histogram) — não existe em kpi/table/matrix/text. Puramente visual. Só defina se o usuário pediu algo do tipo 'gráfico animado', 'que fica se desenhando', 'dinâmico', 'em loop'.",
    },
    dynamicAnimationSpeed: { ...CHART_ANIM_SPEED_SCHEMA, description: "Velocidade do ciclo do Gráfico dinâmico. Só faz sentido com `dynamicAnimation: true`. Omita pra usar 'normal'." },
    shadow: { type: 'boolean', description: 'Sombra no card do widget — efeito estático, sempre visível quando ligado (não depende do dado). Só defina se foi pedido.' },
    shadowColor: { ...HEX_COLOR, description: 'Cor da sombra. Só defina junto com `shadow: true` — sem `shadow`, este campo não tem efeito.' },
    glow: { type: 'boolean', description: 'Brilho estático no card do widget — sempre visível quando ligado. Diferente de `conditionalRules[].effect.glow`, que só liga quando uma regra bate. Só defina se foi pedido.' },
    glowColor: { ...HEX_COLOR, description: 'Cor do brilho. Só defina junto com `glow: true` — sem `glow`, este campo não tem efeito. Sem esta cor, o brilho usa `backgroundColor` do widget (ou âmbar padrão).' },
    blink: { type: 'boolean', description: 'Piscar estático no card do widget — sempre ativo quando ligado. Use com moderação (é bem chamativo); só defina se foi pedido.' },
    blinkColor: { ...HEX_COLOR, description: 'Cor do anel que pisca. Só defina junto com `blink: true` — sem `blink`, este campo não tem efeito.' },
    titleFormat: { ...alignedTextFormatSchema, description: 'Formatação do título do widget. Só defina se foi pedido tamanho/visual/alinhamento de texto diferente.' },
    subtitleFormat: { ...alignedTextFormatSchema, description: 'Formatação do subtítulo do widget. Só relevante se `subtitle` estiver definido. Só defina se foi pedido.' },
    axisXFormat: { ...axisFormatSchema, description: 'Formatação do texto do Eixo X (gráficos com eixo). Só defina se foi pedido.' },
    axisYFormat: { ...axisFormatSchema, description: 'Formatação do texto do Eixo Y. Só defina se foi pedido.' },
    legendFormat: { ...textFormatSchema, description: 'Formatação do texto da legenda (embaixo do gráfico, quando há `legendDimension` ou múltiplas medidas). Só defina se foi pedido.' },
    matrixRowFormat: { ...alignedTextFormatSchema, description: "Só em matrix: formatação do texto da hierarquia de linhas. Só defina se foi pedido." },
    matrixColumnFormat: { ...alignedTextFormatSchema, description: "Só em matrix: formatação do cabeçalho das colunas dinâmicas. Só defina se foi pedido." },
    valueAlign: { type: 'string', enum: ['left', 'center', 'right'], description: 'Só em kpi: alinhamento horizontal do número (e da meta, se houver) dentro do card. Só defina se foi pedido.' },
    dataLabels: { ...dataLabelFormatSchema, description: 'Rótulos de dado sobre o gráfico (padrão do widget inteiro — cada série pode sobrescrever via measure.dataLabels). Só defina se foi pedido (ex. "mostra o valor em cima de cada barra"). Em barStacked/barHStacked, `show=true` já mostra o TOTAL da pilha (não um rótulo por série) — não é configurável, `position` é ignorado nesses dois tipos.' },
    tableFormat: { ...tableFormatSchema, description: "Só em type='table': fonte, alinhamento, cabeçalho em negrito, cor, renomear coluna. Só defina se foi pedido." },
    tableConditionalRules: {
      type: 'array', items: tableConditionalRuleSchema,
      description: "Só em type='table': formatação condicional por coluna — cor de fonte/fundo/pisca quando o TEXTO da célula bate com uma palavra/frase/valor (ex. \"sim\" fica verde e pisca, \"não\" fica com a fonte vermelha). Não é o mesmo que `conditionalRules` (que compara NÚMERO, não é usado em table). Só defina se o usuário pediu algo do tipo 'destaca quando a coluna X for Y'.",
    },
    conditionalRules: {
      type: 'array', items: conditionalRuleSchema,
      description: 'Meta e alertas: regras de cor/pisca/brilho conforme o valor (KPI, barra/coluna, colunas empilhadas, combo, histograma, matriz). Só defina se o usuário pediu ALERTA, DESTAQUE CONDICIONAL ou algo do tipo "fica vermelho se passar de X" — não é o mesmo que só pedir "cores diferentes" entre widgets (isso é `color`/`palette`).',
    },
  },
  required: ['type', 'title'],
}

export const PROPOSE_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    widgets: { type: 'array', items: WIDGET_SCHEMA, description: 'Os widgets propostos, na ordem em que devem aparecer.' },
    summary: { type: 'string', description: 'Uma ou duas frases dizendo ao usuário o que você montou e por quê.' },
  },
  required: ['widgets', 'summary'],
}

// ─── Ajustar UM widget que já existe (botão "Ajustar com IA") ────────────
// O modelo manda só o que muda (`changes`) e o que sai (`remove`); o resto do
// widget fica como está — inclusive o que o schema nem descreve (posição,
// leitura fixada, larguras de coluna). Um patch, e não o widget inteiro de
// novo, porque copiar 40 campos de formatação a cada ajuste é onde o modelo
// esquece um e apaga a personalização da pessoa sem ninguém pedir.
const NOT_REMOVABLE = new Set(['type', 'title', 'source', 'w', 'h'])
export const REMOVABLE_WIDGET_FIELDS = Object.keys(WIDGET_SCHEMA.properties).filter((k) => !NOT_REMOVABLE.has(k))

const { required: _widgetRequired, ...WIDGET_PATCH_SCHEMA } = WIDGET_SCHEMA

export const UPDATE_WIDGET_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    changes: {
      ...WIDGET_PATCH_SCHEMA,
      description: 'Só os campos que mudam, cada um com o valor novo COMPLETO — uma lista (widgetFilters, measures, columns, conditionalRules…) vai inteira: o que fica mais o que entra. Campos ausentes continuam como estão.',
    },
    remove: {
      type: 'array', items: { type: 'string', enum: REMOVABLE_WIDGET_FIELDS },
      description: 'Campos a TIRAR do widget (ex. ["widgetFilters"] para tirar todos os filtros fixos, ["legendDimension"], ["target"]). Para tirar só um filtro entre vários, mande widgetFilters em `changes` sem ele.',
    },
    summary: { type: 'string', description: 'Uma frase dizendo à pessoa o que mudou e por quê.' },
  },
  required: ['summary'],
}

// Aplica um ajuste (`update_widget`) ao widget atual: junta `changes`, tira o
// que está em `remove`, valida e normaliza. O widget mantém o id e o lugar na
// guia — só largura/altura mudam, se vierem. O que não está no schema (a
// leitura fixada, larguras de coluna, a posição) passa intacto.
// → { widget } ou { errors: [...] }.
export function applyWidgetPatch(current, input, sources) {
  const changes = input?.changes && typeof input.changes === 'object' ? input.changes : {}
  const remove = (Array.isArray(input?.remove) ? input.remove : []).filter((k) => REMOVABLE_WIDGET_FIELDS.includes(k))
  const { w, h, ...fieldChanges } = changes
  if (!Object.keys(fieldChanges).length && !remove.length && w == null && h == null) {
    return { errors: ['Nada a mudar: informe o que muda em `changes` e/ou o que sai em `remove`.'] }
  }
  const merged = { ...current, ...fieldChanges }
  for (const k of remove) delete merged[k]
  // O que o widget já usava vale (pode ser campo de fonte relacionada, que não
  // está no catálogo); o que entra de novo tem de estar no catálogo.
  const errors = validateWidget(merged, sources, { knownFields: fieldsUsedBy(current) })
  if (errors.length) return { errors }
  // normalizeWidget dá id às regras de alerta novas; o id e a posição do
  // widget ficam os de antes.
  const { id: _newId, layout: _newLayout, ...normalized } = normalizeWidget({ ...merged, w, h })
  const old = current.layout ?? { x: 0, y: 0, w: 12, h: 10 }
  return {
    widget: {
      ...normalized,
      id: current.id,
      layout: {
        ...old,
        ...(w != null ? { w: Math.min(24, Math.max(4, Number(w) || old.w)) } : {}),
        ...(h != null ? { h: Math.max(6, Number(h) || old.h) } : {}),
      },
    },
  }
}

// Os campos que um widget usa (base, sem o nível de data) — num ajuste, o que
// ele JÁ usava vale mesmo que não esteja no catálogo da conversa (ex. um
// campo de fonte relacionada, "fonte.campo", posto à mão no editor).
export function fieldsUsedBy(widget) {
  const w = widget ?? {}
  const out = new Set()
  const add = (raw) => { const f = baseField(raw); if (f) out.add(f) }
  const addMeasure = (m) => { if (m?.field) add(m.field) }
  for (const d of w.dimensions ?? []) add(d)
  if (w.legendDimension) add(w.legendDimension)
  for (const f of w.widgetFilters ?? []) add(f?.field)
  addMeasure(w.measure)
  for (const m of w.measures ?? []) addMeasure(m)
  for (const m of w.measuresLine ?? []) addMeasure(m)
  addMeasure(w.measureX)
  addMeasure(w.matrixValue)
  for (const c of w.columns ?? []) add(c)
  for (const r of w.matrixRows ?? []) add(r)
  for (const c of w.matrixColumns ?? []) add(c)
  if (w.histogramField) add(w.histogramField)
  return out
}

// Uma dimensão pode vir como 'year:campo'/'quarter:campo'/'month:campo'/
// 'day:campo' (bucket de data — Hierarquia de datas) — o campo real é o que
// vem depois dos dois-pontos. Espelha BUCKET_RE/dimensionKeyFn em server/widgetQuery.mjs.
const BUCKET_RE = /^(year|quarter|month|day):(.+)$/
function baseField(dimension) {
  const m = BUCKET_RE.exec(String(dimension ?? ''))
  return m ? m[2] : String(dimension ?? '')
}

// ─── Validação contra o catálogo REAL ──────────────────────────────────
// `sources`: [{ key, label, fields: [{key, kind}] }] — o que listSourceDefs
// devolve. Só as fontes que o usuário selecionou pra conversa entram aqui,
// então isto também é a barreira de acesso: um `source` fora da lista é
// recusado, não importa o que o modelo tenha pedido.
// `knownFields`: campos aceitos além dos da fonte — num ajuste, os que o
// widget já usava (ver fieldsUsedBy).
export function validateWidget(widget, sources, { knownFields } = {}) {
  const errors = []
  const w = widget ?? {}
  const type = w.type

  if (!WIDGET_TYPES.includes(type)) {
    return [`type inválido: ${JSON.stringify(type)}. Use um de: ${WIDGET_TYPES.join(', ')}.`]
  }
  if (!w.title || !String(w.title).trim()) errors.push('title é obrigatório.')

  if (SOURCELESS_TYPES.has(type)) {
    if (!w.content || !String(w.content).trim()) errors.push("type='text' exige `content` com o texto a exibir.")
    return errors
  }

  const source = sources.find((s) => s.key === w.source)
  if (!source) {
    errors.push(
      `source ${JSON.stringify(w.source)} não está disponível. Fontes desta conversa: ${sources.map((s) => s.key).join(', ') || '(nenhuma)'}.`,
    )
    return errors // sem fonte não há como validar campo nenhum
  }

  const fieldKeys = new Set(source.fields.map((f) => f.key))
  const requireField = (raw, where) => {
    const field = baseField(raw)
    if (!field) { errors.push(`${where}: campo vazio.`); return }
    if (!fieldKeys.has(field) && !knownFields?.has(field)) {
      errors.push(`${where}: a fonte "${source.key}" não tem o campo "${field}".`)
    }
  }
  // Igual a requireField, mas pra papéis onde o editor manual NUNCA deixa
  // escolher um campo de data puro (Eixo X, Legenda, Linhas/Colunas da
  // Matriz) — só os 4 níveis de bucket. Sem essa checagem o modelo podia
  // propor um campo de data cru nesses papéis: passa na validação, mas o
  // motor de query perde a ordenação cronológica e o recorte por
  // recência (isDateDim exige bucket), podendo virar 1 categoria por
  // timestamp exato num campo com granularidade de hora/minuto.
  const requireDateBucketField = (raw, where) => {
    requireField(raw, where)
    const field = baseField(raw)
    const fieldDef = source.fields.find((f) => f.key === field)
    if (fieldDef?.kind === 'date' && !BUCKET_RE.test(String(raw ?? ''))) {
      errors.push(`${where}: campo de data "${field}" precisa de um nível de hierarquia — use "year:${field}", "quarter:${field}", "month:${field}" ou "day:${field}" (nunca o campo puro). Combine 2+ níveis do mesmo campo, na ordem year→quarter→month→day, pra uma hierarquia de verdade.`)
    }
  }
  const checkMeasure = (m, where) => {
    if (!m) return
    if (!AGGS.includes(m.agg)) { errors.push(`${where}: agg inválida ${JSON.stringify(m.agg)}.`); return }
    if (m.agg === 'sum' || m.agg === 'avg') {
      if (!m.field) { errors.push(`${where}: agg "${m.agg}" exige \`field\`.`); return }
      requireField(m.field, where)
    } else if (m.field) {
      requireField(m.field, where)
    }
  }

  for (const d of w.dimensions ?? []) requireDateBucketField(d, 'dimensions')
  if (w.legendDimension) requireDateBucketField(w.legendDimension, 'legendDimension')
  for (const [i, f] of (w.widgetFilters ?? []).entries()) {
    requireField(f?.field, `widgetFilters[${i}]`)
    if (!Array.isArray(f?.values) || f.values.length === 0) errors.push(`widgetFilters[${i}]: values não pode ser vazio.`)
  }

  checkMeasure(w.measure, 'measure')
  for (const [i, m] of (w.measures ?? []).entries()) checkMeasure(m, `measures[${i}]`)
  for (const [i, m] of (w.measuresLine ?? []).entries()) checkMeasure(m, `measuresLine[${i}]`)
  checkMeasure(w.measureX, 'measureX')
  checkMeasure(w.matrixValue, 'matrixValue')

  // Coerência por tipo — o motor espera `measure` em uns e `measures[]` em
  // outros; propor o campo errado renderiza um widget vazio.
  if (MULTI_MEASURE_TYPES.has(type) && !(w.measures?.length || w.legendDimension || w.measure)) {
    errors.push(`type "${type}" precisa de \`measures\` (uma ou mais séries).`)
  }
  if (SINGLE_MEASURE_TYPES.has(type) && !w.measure) {
    errors.push(`type "${type}" precisa de \`measure\` (medida única), não \`measures\`.`)
  }
  if (MULTI_MEASURE_TYPES.has(type) && !w.dimensions?.length) {
    errors.push(`type "${type}" precisa de \`dimensions\` (o eixo X).`)
  }
  if (type === 'comboBarLine' && !w.measuresLine?.length) {
    errors.push('comboBarLine precisa de `measuresLine` (a série de linha no eixo direito).')
  }
  if (type === 'scatter' && !w.measureX) errors.push('scatter precisa de `measureX` (medida do eixo X).')
  if (type === 'table') {
    for (const [i, c] of (w.columns ?? []).entries()) requireField(c, `columns[${i}]`)
    if (!w.columns?.length) errors.push('table precisa de `columns`.')
    // Compara a chave LITERAL (com prefixo de bucket, se houver) — é assim
    // que a linha projetada da tabela e o motor de formatação condicional
    // (resolveTableCellEffect/resolveTableRowEffect) casam a coluna: por
    // igualdade estrita contra `columns`, nunca contra o campo-base.
    const columnSet = new Set(w.columns ?? [])
    for (const [i, r] of (w.tableConditionalRules ?? []).entries()) {
      if (!columnSet.has(r?.column)) errors.push(`tableConditionalRules[${i}]: coluna "${r?.column}" não está em \`columns\`.`)
      if (!r?.match || !String(r.match).trim()) errors.push(`tableConditionalRules[${i}]: match não pode ser vazio.`)
    }
  }
  if (type === 'matrix') {
    for (const [i, r] of (w.matrixRows ?? []).entries()) requireDateBucketField(r, `matrixRows[${i}]`)
    for (const [i, c] of (w.matrixColumns ?? []).entries()) requireDateBucketField(c, `matrixColumns[${i}]`)
    if (!w.matrixRows?.length) errors.push('matrix precisa de `matrixRows`.')
    if (!w.matrixValue) errors.push('matrix precisa de `matrixValue`.')
  }
  if (type === 'histogram') {
    if (!w.histogramField) errors.push('histogram precisa de `histogramField`.')
    else requireField(w.histogramField, 'histogramField')
  }

  return errors
}

// Converte a proposta do modelo num WidgetConfig completo: gera o id, aplica
// o tamanho padrão do tipo, descarta as chaves auxiliares (w/h) que não
// existem no WidgetConfig real, e dá um id de verdade pra cada regra de
// conditionalRules (o schema não deixa o modelo inventar um — ver
// conditionalRuleSchema — porque não é um dado que ele tenha como escolher
// com sentido; só precisa existir e ser único, pro editor manual poder
// editar/remover uma regra específica depois). A posição na grade NÃO é
// definida aqui — o cliente calcula com findFreeSpot ao aprovar, pra não
// sobrepor o que já existe na guia.
export function normalizeWidget(widget, index = 0) {
  const { w, h, ...rest } = widget
  const size = DEFAULT_SIZE[widget.type] ?? FALLBACK_SIZE
  const conditionalRules = rest.conditionalRules?.length
    ? rest.conditionalRules.map((r, i) => ({
      ...r,
      id: `ai-rule-${Date.now().toString(36)}-${index}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    }))
    : rest.conditionalRules
  const tableConditionalRules = rest.tableConditionalRules?.length
    ? rest.tableConditionalRules.map((r, i) => ({
      ...r,
      id: `ai-trule-${Date.now().toString(36)}-${index}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    }))
    : rest.tableConditionalRules
  return {
    ...rest,
    ...(conditionalRules ? { conditionalRules } : {}),
    ...(tableConditionalRules ? { tableConditionalRules } : {}),
    id: `ai-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    layout: {
      x: 0, y: 0,
      w: Math.min(24, Math.max(4, Number(w) || size.w)),
      h: Math.max(6, Number(h) || size.h),
    },
  }
}
