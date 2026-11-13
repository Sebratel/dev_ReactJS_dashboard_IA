// ─────────────────────────────────────────────────────────────────────────
// Filtro por clique — o "filtro cruzado" do Power BI, o mesmo da Visão Geral
// da Agenda do Dia (dev_ReactJS_schedule_dashboard, utils/selecaoCruzada.ts).
//
// Clicar numa barra, fatia, ponto, rótulo do eixo, célula de tabela ou
// linha/coluna/célula de matriz filtra a GUIA inteira por aquele valor. As
// regras são as do Power BI, que quem usa a tela já conhece:
// - o widget onde se clicou NÃO se filtra pelo próprio clique: continua
//   mostrando tudo, com o item aceso e o resto esmaecido — é o que permite
//   clicar em outro;
// - os demais são filtrados, cada um pela seleção dos OUTROS widgets;
// - clicar de novo no mesmo item, ou fora, limpa. Ctrl+clique soma itens no
//   mesmo widget (OU); entre widgets eles se combinam (E).
//
// A diferença para a agenda: lá todos os visuais leem a mesma lista de linhas
// no navegador; aqui cada widget é uma consulta ao servidor, de fontes
// diferentes, com medidas nomeadas e relacionamentos. Por isso o clique vira
// FILTRO DA GUIA — o mesmo `{ filter, values }` dos filtros do topo. O motor já
// sabe propagar filtro de guia pelos relacionamentos (semi-join pela chave),
// aplicá-lo dentro das medidas nomeadas (inclusive fórmulas, com o aviso de
// "filtro parcial") e traduzi-lo para o Data Hub na leitura direta.
//
// O que um filtro de guia expressa: por campo, "está em {valores}" ou "entre
// duas datas", e campos diferentes combinados com E. Daí duas aproximações:
// - no mesmo widget, Ctrl+clique soma valores POR CAMPO — duas células de
//   matriz (Ana às 8h, Bruno às 9h) viram "Ana ou Bruno" e "8h ou 9h";
// - um nível de data (Ano/Trimestre/Mês/Dia) vira período; vários, com Ctrl,
//   viram o período do primeiro ao último.
//
// Tudo aqui é puro (sem React e sem imports com '@/'), para o teste rodar via
// tsx: ver scripts/test-click-filter.mjs.
// ─────────────────────────────────────────────────────────────────────────

export type DateBucket = 'year' | 'quarter' | 'month' | 'day'

/** Uma condição de um item clicado: um campo NATIVO de uma fonte, com um valor ou um período. */
export interface ClickCond {
  source: string
  field: string
  /** Valor exato, comparado como texto (como o filtro de seleção múltipla). '' = célula vazia. */
  value?: string
  /** Nível de data clicado: `key` é a chave dele ("2026-03"), from/to o período que cobre. */
  bucket?: DateBucket
  key?: string
  from?: string
  to?: string
}

/** Um item clicado: uma ou mais condições, todas valendo (a célula da matriz fixa linha E coluna). */
export interface ClickItem { conds: readonly ClickCond[] }

/** Os itens clicados, por widget de origem. Sem chave = nada clicado nele. */
export type ClickSelection = Readonly<Record<string, readonly ClickItem[]>>

export const NO_SELECTION: ClickSelection = Object.freeze({})

export const hasSelection = (sel: ClickSelection) => Object.keys(sel).length > 0

// ─── Do que foi clicado para condições ────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
// Último dia do mês `m` (1–12) — o dia 0 do mês seguinte, em UTC.
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/**
 * O período de um nível de data, a partir da chave que o servidor agrupa
 * (dimensionKeyFn, server/widgetQuery.mjs): "2026", "2026-Q1", "2026-03",
 * "2026-03-05". Chave fora do formato = null (não dá para filtrar por ela).
 */
export function bucketRange(bucket: DateBucket, key: string): { from: string; to: string } | null {
  if (bucket === 'year') {
    return /^\d{4}$/.test(key) ? { from: `${key}-01-01`, to: `${key}-12-31` } : null
  }
  if (bucket === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(key)
    if (!m) return null
    const end = Number(m[2]) * 3
    return { from: `${m[1]}-${pad(end - 2)}-01`, to: `${m[1]}-${pad(end)}-${pad(lastDay(Number(m[1]), end))}` }
  }
  if (bucket === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key)
    return m ? { from: `${key}-01`, to: `${key}-${pad(lastDay(Number(m[1]), Number(m[2])))}` } : null
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? { from: key, to: key } : null
}

/** De onde vêm os campos de um widget. */
export interface FieldContext {
  /** A fonte do widget. */
  source: string
  /** Fontes cujos campos o widget usa como `${fonte}.${campo}` (relacionamentos e mesclagem antiga). */
  relatedSources: readonly string[]
}

const BUCKET_RE = /^(year|quarter|month|day):(.+)$/

/**
 * Campo do widget → fonte e campo NATIVO dela. "fonte.Região" é a Região da
 * outra fonte: o filtro vai para lá, e o relacionamento o traz de volta aos
 * widgets desta. Só conta como outra fonte um prefixo que É uma fonte
 * relacionada — um campo nativo com ponto no nome continua nativo.
 */
export function resolveField(fieldKey: string, ctx: FieldContext): { source: string; field: string } {
  const other = [...ctx.relatedSources]
    .sort((a, b) => b.length - a.length)
    .find((s) => s !== ctx.source && fieldKey.startsWith(`${s}.`))
  return other ? { source: other, field: fieldKey.slice(other.length + 1) } : { source: ctx.source, field: fieldKey }
}

/** A condição de UMA dimensão do widget ("Cidade", "month:Data", "fonte.Região") com a chave crua do grupo. */
export function condOf(dimension: string, raw: string, ctx: FieldContext): ClickCond | null {
  const m = BUCKET_RE.exec(dimension)
  if (!m) return { ...resolveField(dimension, ctx), value: raw }
  const bucket = m[1] as DateBucket
  const range = bucketRange(bucket, raw)
  return range ? { ...resolveField(m[2], ctx), bucket, key: raw, ...range } : null
}

/**
 * As condições de um grupo a partir da chave dele: com uma dimensão, a chave
 * inteira; com várias, as partes da chave composta ("A / B" nos gráficos, o
 * separador próprio na matriz). Se a contagem de partes não bater (um valor
 * com " / " dentro), não arrisca: null.
 */
export function condsOf(dimensions: readonly string[] | undefined, rawKey: string, ctx: FieldContext, sep = ' / '): ClickCond[] | null {
  if (!dimensions?.length) return null
  const parts = dimensions.length === 1 ? [rawKey] : rawKey.split(sep)
  if (parts.length !== dimensions.length) return null
  const conds: ClickCond[] = []
  for (let i = 0; i < dimensions.length; i++) {
    const c = condOf(dimensions[i], parts[i], ctx)
    if (!c) return null
    conds.push(c)
  }
  return conds
}

// ─── Seleção ──────────────────────────────────────────────────────────────

const condKey = (c: ClickCond) => JSON.stringify([c.source, c.field, c.value ?? null, c.bucket ?? null, c.key ?? null])
const itemKey = (item: ClickItem) => item.conds.map(condKey).sort().join('|')

export const sameItem = (a: ClickItem, b: ClickItem) => itemKey(a) === itemKey(b)

/**
 * A seleção depois de um clique.
 *
 * Sem Ctrl, o clique SUBSTITUI tudo pelo item — e, se a seleção já era
 * exatamente esse item, limpa (clicar de novo no mesmo desfaz).
 *
 * Com Ctrl, o item entra ou sai da seleção DAQUELE widget, sem mexer nos
 * outros. O widget que fica sem itens sai da seleção.
 */
export function applyClick(sel: ClickSelection, widgetId: string, item: ClickItem, { multi }: { multi: boolean }): ClickSelection {
  if (!multi) {
    const widgets = Object.keys(sel)
    const current = sel[widgetId] ?? []
    const wasOnlyThis = widgets.length === 1 && widgets[0] === widgetId && current.length === 1 && sameItem(current[0], item)
    return wasOnlyThis ? NO_SELECTION : { [widgetId]: [item] }
  }
  const current = sel[widgetId] ?? []
  const had = current.some((i) => sameItem(i, item))
  const next = had ? current.filter((i) => !sameItem(i, item)) : [...current, item]
  const { [widgetId]: _previous, ...others } = sel
  if (next.length > 0) return { ...others, [widgetId]: next }
  return hasSelection(others) ? others : NO_SELECTION
}

/** Todos os itens clicados, de todos os widgets, sem repetição — o que o balão mostra. */
export function selectionItems(sel: ClickSelection): ClickItem[] {
  const out: ClickItem[] = []
  for (const item of Object.values(sel).flat()) {
    if (!out.some((i) => sameItem(i, item))) out.push(item)
  }
  return out
}

// ─── Seleção de um widget → filtros ───────────────────────────────────────

/** Um campo filtrado pelo que se clicou num widget: valores (OU) ou um período. */
export interface VisualFilter {
  source: string
  field: string
  values?: string[]
  from?: string
  to?: string
}

const BUCKET_RANK: Record<DateBucket, number> = { year: 0, quarter: 1, month: 2, day: 3 }
// Um campo de uma fonte, como valor ou como período — as duas chaves da
// condição e do filtro precisam bater.
const refOf = (source: string, field: string, period: boolean) => `${source}\u0001${field}\u0001${period ? 'p' : 'v'}`
const condRef = (c: ClickCond) => refOf(c.source, c.field, !!c.bucket)
const filterRef = (f: VisualFilter) => refOf(f.source, f.field, !f.values)

/**
 * As condições de UM item, uma por campo. Duas no mesmo campo de data (Ano
 * 2026 e Mês 2026-03, numa hierarquia de datas) se cruzam: fica o período
 * comum, com o nível mais fino. Dois valores do mesmo campo num item só não
 * acontecem (uma dimensão por campo); se acontecer, vale o primeiro.
 */
function mergeItem(conds: readonly ClickCond[]): Map<string, ClickCond> {
  const out = new Map<string, ClickCond>()
  for (const c of conds) {
    const ref = condRef(c)
    const prev = out.get(ref)
    if (!prev) { out.set(ref, c); continue }
    if (c.bucket && prev.bucket && c.from && c.to && prev.from && prev.to) {
      const finer = BUCKET_RANK[c.bucket] > BUCKET_RANK[prev.bucket] ? c : prev
      out.set(ref, { ...finer, from: c.from > prev.from ? c.from : prev.from, to: c.to < prev.to ? c.to : prev.to })
    }
  }
  return out
}

/**
 * Os filtros que a seleção de UM widget impõe aos outros: por campo, os
 * valores clicados (OU) ou o período do primeiro ao último nível de data.
 */
export function visualFilters(items: readonly ClickItem[]): VisualFilter[] {
  const byRef = new Map<string, VisualFilter>()
  for (const item of items) {
    for (const [ref, c] of mergeItem(item.conds)) {
      const f = byRef.get(ref)
      if (c.bucket) {
        if (!c.from || !c.to) continue
        if (!f) byRef.set(ref, { source: c.source, field: c.field, from: c.from, to: c.to })
        else {
          if (c.from < f.from!) f.from = c.from
          if (c.to > f.to!) f.to = c.to
        }
      } else {
        const v = c.value ?? ''
        if (!f) byRef.set(ref, { source: c.source, field: c.field, values: [v] })
        else if (!f.values!.includes(v)) f.values!.push(v)
      }
    }
  }
  return [...byRef.values()]
}

/** O formato de um filtro de guia (FilterConfig + valores), que o servidor já sabe aplicar. */
export interface ClickTabFilter {
  filter: { id: string; source: string; field: string; label: string; type: 'multiselect' | 'daterange' }
  values: string[]
}

export const CLICK_FILTER_PREFIX = 'click:'
export const isClickFilterId = (id: string) => id.startsWith(CLICK_FILTER_PREFIX)

/**
 * A seleção vista por um widget: os filtros de guia que valem para ele — os
 * de todos os widgets MENOS ele mesmo (`exceptWidgetId`), que não se filtra
 * pelo próprio clique. `labelOf` dá o nome do campo, para o "Como foi
 * calculado" e a leitura da IA dizerem por que o número mudou.
 */
export function selectionToTabFilters(
  sel: ClickSelection,
  exceptWidgetId: string | undefined,
  labelOf: (f: VisualFilter) => string,
): ClickTabFilter[] {
  const out: ClickTabFilter[] = []
  for (const [widgetId, items] of Object.entries(sel)) {
    if (widgetId === exceptWidgetId || !items.length) continue
    for (const f of visualFilters(items)) {
      const kind = f.values ? 'v' : 'p'
      const filter = { id: `${CLICK_FILTER_PREFIX}${widgetId}:${f.source}:${f.field}:${kind}`, source: f.source, field: f.field, label: labelOf(f) }
      out.push(f.values
        ? { filter: { ...filter, type: 'multiselect' }, values: f.values }
        : { filter: { ...filter, type: 'daterange' }, values: [f.from!, f.to!] })
    }
  }
  return out
}

/**
 * Aceso = nada clicado neste widget, ou o elemento passa pelo que se clicou
 * nele: em cada campo filtrado que o elemento também tem, o valor dele está
 * entre os clicados (ou o período dele encosta no clicado). Campo que o
 * elemento não tem não conta — a linha da matriz acende pela linha, mesmo com
 * uma célula (linha E coluna) clicada. Sem condições, não há o que comparar:
 * fica aceso.
 */
export function isLit(items: readonly ClickItem[], conds: readonly ClickCond[] | null): boolean {
  if (!items.length || !conds?.length) return true
  const own = mergeItem(conds)
  return visualFilters(items).every((f) => {
    const c = own.get(filterRef(f))
    if (!c) return true
    if (f.values) return f.values.includes(c.value ?? '')
    return !!c.from && !!c.to && c.from <= f.to! && c.to >= f.from!
  })
}

// ─── Texto ────────────────────────────────────────────────────────────────

/** "2026", "1º tri/2026", "03/2026", "05/03/2026". */
export function bucketText(bucket: DateBucket, key: string): string {
  if (bucket === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(key)
    return m ? `${m[2]}º tri/${m[1]}` : key
  }
  if (bucket === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key)
    return m ? `${m[2]}/${m[1]}` : key
  }
  if (bucket === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
    return m ? `${m[3]}/${m[2]}/${m[1]}` : key
  }
  return key
}

/** O valor de uma condição como a tela mostra: data em dd/mm/aaaa, vazio como "(vazio)". */
export function condValueText(c: ClickCond): string {
  if (c.bucket && c.key) return bucketText(c.bucket, c.key)
  const v = c.value ?? ''
  if (!v) return '(vazio)'
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(v)
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : v
}

/**
 * "Cidade: Natal", ou "Natal · 03/2026" quando o item fixa mais de um campo.
 * É o texto do balão do filtro por clique.
 */
export function describeItem(item: ClickItem, fieldLabel: (c: ClickCond) => string): string {
  const conds = [...mergeItem(item.conds).values()]
  if (conds.length === 1) return `${fieldLabel(conds[0])}: ${condValueText(conds[0])}`
  return conds.map(condValueText).join(' · ')
}
