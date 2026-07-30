// "Como este gráfico foi calculado", derivado do WidgetConfig — sem IA.
//
// Tudo que responde a pergunta já está na configuração do widget: a fonte, a
// agregação, o agrupamento, os filtros e o recorte. Os nomes em português vêm
// do catálogo de campos (que já carrega as descrições escritas no dicionário
// de dados). Então isso é instantâneo, não custa nada, funciona offline do
// modelo e — o que mais importa — não tem como estar errado: não é uma
// explicação PLAUSÍVEL do cálculo, é o cálculo.
//
// A IA entra depois, e só na parte que é de fato interpretação (ver
// WidgetInsightPopover). Deixar o modelo narrar também o "como" seria pagar
// para arriscar erro numa informação que temos exata.
import { getSourceDef } from './fieldCatalog'
import type { FilterConfig, MeasureConfig, WidgetConfig, WidgetFilter } from './types'

export interface CalcLine {
  label: string
  value: string
  // Descrição do(s) campo(s) citados, escrita por um admin no dicionário de
  // dados (Configurações). O nome do campo é a coluna crua da fonte
  // ("cancellation_motive") em todo o app — mantê-la aqui é o que permite
  // rastrear até o editor do widget, mas sozinha ela não explica nada a quem
  // não conhece a base. Quando existe descrição, ela vem junto.
  hint?: string
}

const AGG_LABEL: Record<string, string> = {
  count: 'Contagem de linhas',
  countDistinct: 'Contagem de valores distintos',
  sum: 'Soma',
  avg: 'Média',
}

// Uma dimensão pode vir como 'month:campo' / 'day:campo' (bucket de data).
function splitBucket(dim: string): { field: string; bucket?: 'day' | 'month' } {
  const m = /^(day|month):(.+)$/.exec(dim)
  return m ? { field: m[2], bucket: m[1] as 'day' | 'month' } : { field: dim }
}

function fieldLabel(source: string | undefined, key: string): string {
  const def = source ? getSourceDef(source as never) : undefined
  return def?.fields.find((f) => f.key === key)?.label ?? key
}

// Descrições do dicionário de dados para os campos citados numa linha — só as
// que existem, unidas quando a linha cita mais de um campo.
function hintFor(source: string | undefined, keys: string[]): string | undefined {
  const def = source ? getSourceDef(source as never) : undefined
  if (!def) return undefined
  const hints = keys
    .map((k) => def.fields.find((f) => f.key === k)?.description?.trim())
    .filter((d): d is string => !!d)
  return hints.length ? Array.from(new Set(hints)).join(' · ') : undefined
}

function dimensionLabel(source: string | undefined, dim: string): string {
  const { field, bucket } = splitBucket(dim)
  const base = fieldLabel(source, field)
  if (bucket === 'month') return `${base} (por mês)`
  if (bucket === 'day') return `${base} (por dia)`
  return base
}

function measureLabel(source: string | undefined, m: MeasureConfig): string {
  const agg = AGG_LABEL[m.agg] ?? m.agg
  // count não tem campo: conta linhas, não valores de uma coluna.
  if (m.agg === 'count' || !m.field) return agg
  return `${agg} de ${fieldLabel(source, m.field)}`
}

// "3 valores" em vez de despejar uma lista de 40 — o texto completo cabe no
// title do elemento, quem precisa passa o mouse.
function filterLine(source: string | undefined, f: WidgetFilter | { field: string; op: string; values: string[] }): string {
  const verb = f.op === 'notIn' ? 'diferente de' : 'igual a'
  const vals = f.values ?? []
  const shown = vals.length <= 2 ? vals.join(' ou ') : `${vals.length} valores selecionados`
  return `${fieldLabel(source, f.field)} ${verb} ${shown}`
}

/**
 * Monta as linhas do "Como foi calculado". Devolve lista vazia para widgets
 * que não consultam dado (texto), onde não há cálculo a explicar.
 */
export function describeCalculation(
  widget: WidgetConfig,
  tabFilters: { filter: FilterConfig; values: string[] }[] = [],
): CalcLine[] {
  if (widget.type === 'text' || !widget.source) return []
  const src = widget.source
  const lines: CalcLine[] = []

  lines.push({ label: 'Fonte', value: getSourceDef(src as never)?.label ?? src })

  // Medidas: cada tipo de widget guarda a sua em um campo diferente.
  const measures: MeasureConfig[] = []
  if (widget.measureX) measures.push(widget.measureX)
  if (widget.measures?.length) measures.push(...widget.measures)
  else if (widget.measure) measures.push(widget.measure)
  if (widget.measuresLine?.length) measures.push(...widget.measuresLine)
  if (widget.matrixValue) measures.push(widget.matrixValue)

  if (widget.type === 'histogram' && widget.histogramField) {
    lines.push({
      label: 'Cálculo',
      value: `Distribuição de ${fieldLabel(src, widget.histogramField)} em ${widget.histogramBins ?? 10} faixas`,
      hint: hintFor(src, [widget.histogramField]),
    })
  } else if (measures.length) {
    lines.push({
      label: measures.length > 1 ? 'Cálculos' : 'Cálculo',
      value: measures.map((m) => measureLabel(src, m)).join(' · '),
      hint: hintFor(src, measures.map((m) => m.field).filter((f): f is string => !!f)),
    })
  }

  const dims = widget.type === 'matrix' ? widget.matrixRows ?? [] : widget.dimensions ?? []
  if (dims.length) {
    lines.push({
      label: 'Agrupado por',
      value: dims.map((d) => dimensionLabel(src, d)).join(' e '),
      hint: hintFor(src, dims.map((d) => splitBucket(d).field)),
    })
  }
  if (widget.type === 'matrix' && widget.matrixColumns?.length) {
    lines.push({
      label: 'Colunas',
      value: widget.matrixColumns.map((d) => dimensionLabel(src, d)).join(' e '),
      hint: hintFor(src, widget.matrixColumns.map((d) => splitBucket(d).field)),
    })
  }
  if (widget.legendDimension) {
    lines.push({
      label: 'Uma série por',
      value: dimensionLabel(src, widget.legendDimension),
      hint: hintFor(src, [splitBucket(widget.legendDimension).field]),
    })
  }

  // Filtros do widget e da aba são coisas diferentes para quem lê: um está na
  // configuração do gráfico, o outro é o que a pessoa selecionou na tela agora.
  for (const f of widget.widgetFilters ?? []) {
    lines.push({ label: 'Filtro do widget', value: filterLine(src, f), hint: hintFor(src, [f.field]) })
  }
  for (const t of tabFilters) {
    if (!t.values?.length) continue
    lines.push({
      label: 'Filtro da tela',
      value: filterLine(src, { field: t.filter.field, op: 'in', values: t.values }),
      hint: hintFor(src, [t.filter.field]),
    })
  }

  if (widget.limit) {
    const dir = widget.sort === 'asc' ? 'menores' : 'maiores'
    lines.push({ label: 'Recorte', value: `${widget.limit} ${dir} — o resto não aparece` })
  } else if (widget.sort) {
    lines.push({ label: 'Ordem', value: widget.sort === 'asc' ? 'Crescente' : 'Decrescente' })
  }

  if (widget.target != null) {
    lines.push({ label: 'Meta', value: widget.target.toLocaleString('pt-BR') })
  }

  return lines
}

/**
 * Impressão digital dos dados que estão na tela AGORA. Serve para saber se uma
 * leitura fixada ainda corresponde ao gráfico ou se envelheceu depois de um
 * ETL. Roda sobre os pontos que o widget já buscou para desenhar — nenhuma
 * consulta a mais.
 */
export function fingerprintPoints(points: unknown): string {
  const json = JSON.stringify(points ?? null)
  // djb2 — não é criptografia, é detecção de mudança. Colisão aqui custa um
  // aviso de "desatualizado" que não apareceu, não um dado errado.
  let h = 5381
  for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0
  return (h >>> 0).toString(36) + '-' + json.length.toString(36)
}
