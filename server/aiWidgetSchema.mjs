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
//      saída. É deliberadamente um SUBCONJUNTO do WidgetConfig real (~20 dos
//      ~45 campos): só o que define O DADO e a estrutura do visual. Cor,
//      fonte, opacidade, grade, rótulos e afins ficam de fora — são dezenas
//      de campos de aparência que encareceriam o prompt, aumentariam a chance
//      de alucinação e já têm padrão bom no app. Quem quiser ajustar
//      aparência usa o editor normal depois.
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

// Tamanho padrão na grade por tipo, em unidades do react-grid-layout (12
// colunas). A IA pode sugerir outro via w/h; a posição (x/y) é sempre
// calculada no cliente por findFreeSpot, nunca pelo modelo.
const DEFAULT_SIZE = {
  kpi: { w: 3, h: 4 }, text: { w: 4, h: 4 }, pie: { w: 4, h: 8 }, funnel: { w: 4, h: 8 },
  table: { w: 6, h: 9 }, matrix: { w: 6, h: 9 }, scatter: { w: 6, h: 8 }, histogram: { w: 6, h: 8 },
}
const FALLBACK_SIZE = { w: 6, h: 8 }

const measureSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agg: { type: 'string', enum: AGGS, description: 'Agregação. sum/avg exigem `field`.' },
    field: { type: 'string', description: 'Campo numérico. Obrigatório para sum/avg; para count/countDistinct é opcional (sem campo = conta linhas).' },
    label: { type: 'string', description: 'Rótulo da série. Só relevante com múltiplas medidas.' },
  },
  required: ['agg'],
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
      description: "Eixo X. Um campo, ou 'day:<campo>' / 'month:<campo>' para agrupar uma data por dia/mês. Vários campos = agrupamento composto.",
    },
    legendDimension: { type: 'string', description: 'Campo que quebra o gráfico em uma série por valor (barras/linha/área). Não combine com múltiplas medidas.' },
    measure: { ...measureSchema, description: 'Medida única — use em kpi, pie, funnel, scatter (eixo Y) e table.' },
    measures: { type: 'array', items: measureSchema, description: 'Séries — use em bar*, line, area, comboBarLine. Ignorado se legendDimension estiver definido.' },
    measuresLine: { type: 'array', items: measureSchema, description: "Só em comboBarLine: as séries desenhadas como LINHA no eixo Y direito." },
    measureX: { ...measureSchema, description: 'Só em scatter: a medida do eixo X.' },
    widgetFilters: {
      type: 'array',
      description: 'Filtro fixo do widget. Use field_values antes para conferir a grafia exata dos valores.',
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
    columns: { type: 'array', items: { type: 'string' }, description: "Só em table: colunas exibidas, na ordem." },
    matrixRows: { type: 'array', items: { type: 'string' }, description: 'Só em matrix: campos nas linhas (hierarquia).' },
    matrixColumns: { type: 'array', items: { type: 'string' }, description: 'Só em matrix: campos nas colunas.' },
    matrixValue: { ...measureSchema, description: 'Só em matrix: a medida de cada célula.' },
    histogramField: { type: 'string', description: 'Só em histogram: o campo numérico a distribuir em faixas.' },
    histogramBins: { type: 'integer', description: 'Só em histogram: quantidade de faixas (padrão 10).' },
    limit: { type: 'integer', description: 'Top N — quantos pontos/linhas manter.' },
    sort: { type: 'string', enum: ['asc', 'desc'] },
    target: { type: 'number', description: 'Meta: desenha uma linha de referência no gráfico e é o valor comparado no KPI.' },
    w: { type: 'integer', description: 'Largura na grade de 12 colunas. Omita para usar o padrão do tipo.' },
    h: { type: 'integer', description: 'Altura na grade. Omita para usar o padrão do tipo.' },
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

// Uma dimensão pode vir como 'day:campo' ou 'month:campo' (bucket de data) —
// o campo real é o que vem depois dos dois-pontos. Espelha dimensionKeyFn em
// server/widgetQuery.mjs.
function baseField(dimension) {
  const m = /^(day|month):(.+)$/.exec(String(dimension ?? ''))
  return m ? m[2] : String(dimension ?? '')
}

// ─── Validação contra o catálogo REAL ──────────────────────────────────
// `sources`: [{ key, label, fields: [{key, kind}] }] — o que listSourceDefs
// devolve. Só as fontes que o usuário selecionou pra conversa entram aqui,
// então isto também é a barreira de acesso: um `source` fora da lista é
// recusado, não importa o que o modelo tenha pedido.
export function validateWidget(widget, sources) {
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
    if (!fieldKeys.has(field)) {
      errors.push(`${where}: a fonte "${source.key}" não tem o campo "${field}".`)
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

  for (const d of w.dimensions ?? []) requireField(d, 'dimensions')
  if (w.legendDimension) requireField(w.legendDimension, 'legendDimension')
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
  }
  if (type === 'matrix') {
    for (const [i, r] of (w.matrixRows ?? []).entries()) requireField(r, `matrixRows[${i}]`)
    for (const [i, c] of (w.matrixColumns ?? []).entries()) requireField(c, `matrixColumns[${i}]`)
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
// o tamanho padrão do tipo e descarta as chaves auxiliares (w/h) que não
// existem no WidgetConfig real. A posição na grade NÃO é definida aqui — o
// cliente calcula com findFreeSpot ao aprovar, pra não sobrepor o que já
// existe na guia.
export function normalizeWidget(widget, index = 0) {
  const { w, h, ...rest } = widget
  const size = DEFAULT_SIZE[widget.type] ?? FALLBACK_SIZE
  return {
    ...rest,
    id: `ai-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    layout: {
      x: 0, y: 0,
      w: Math.min(12, Math.max(2, Number(w) || size.w)),
      h: Math.max(3, Number(h) || size.h),
    },
  }
}
