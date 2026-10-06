// ─────────────────────────────────────────────────────────────────────────
// LEITURA DIRETA de uma fonte do Data Hub: o widget vira uma ou mais
// consultas (QueryDef) executadas lá — o DuckDB do Data Hub agrega sobre o
// Parquet e só o resultado atravessa a rede (até 10 mil linhas por consulta).
// Nenhuma linha da fonte é copiada para cá: um gráfico por mês de uma tabela
// de 1,8 milhão de linhas chega como uma dúzia de linhas.
//
// A saída tem EXATAMENTE a forma que o motor em memória (server/
// widgetQuery.mjs) devolve — points/seriesKeys, matrix, rows/total —, e as
// regras de lá (rótulo, hierarquia de datas, ordenação, top N, legenda,
// subtotais da matriz, tabela, histograma) são reaproveitadas, não reescritas:
// o que muda é QUEM agrega. scripts/test-direct.mjs roda a mesma bateria de
// widgets nos dois modos e compara as saídas.
//
// Cada agrupamento sai por um de dois caminhos (fetchGroups):
//   • direto — o Data Hub agrupa pelos campos do widget e calcula cada
//     medida, inclusive a contagem distinta. É o caso comum, e o único que
//     aguenta dimensão de cardinalidade alta, porque o top N é cortado lá;
//   • com campo de OUTRA fonte (relação usada como eixo, legenda, medida ou
//     coluna) — o Data Hub agrupa pelos campos daqui MAIS a chave da
//     relação e devolve partes que se somam (linhas, soma, contagem); a
//     junção com a outra fonte e o reagrupamento acontecem aqui. Vale
//     enquanto essa combinação couber em 10 mil grupos. Passou disso, o erro
//     diz o que fazer — nunca um número incompleto.
//
// Diferenças conhecidas para o motor em memória, todas a favor do que se
// espera de uma ferramenta de BI (ver DOCUMENTACAO.md):
//   • média ignora campo vazio (lá, vazio entrava como zero);
//   • "Contagem de X" conta texto vazio ('') como preenchido (regra do SQL);
//   • contagem distinta SEM campo conta linhas (lá, linhas distintas);
//   • tabela sem coluna de outra fonte é paginada no Data Hub: o vazio vai
//     para o fim da ordem padrão e um empate na coluna clicada é desfeito
//     pelas demais colunas (paginar no servidor exige ordem total).
// ─────────────────────────────────────────────────────────────────────────
import { directQuery, directEntry } from './datahubQuery.mjs'
import { getSnapshot } from './dataset.mjs'
import {
  MAX_POINTS, MAX_FIELD_VALUES, MAX_LEGEND_SERIES, INFER_SAMPLE_SIZE, MATRIX_SEP, MATRIX_SINGLE_COL, BUCKET_RE,
  dimensionKeyFn, compositeDimensionFn, sortAndLimitPoints, defaultMeasureLabel, resolveLevel2Measure,
  resolveDateWindow, resolveMeasure, isPartialMeasureFilter, resolveIndirectFilter, renderMatrix,
  buildTableResult, histogramResult, inferSourceDef, getSourceDef, getRows, withSheetSources,
  collectWidgetSheetKeys, assertField, assertFieldOrLookup,
} from './widgetQuery.mjs'

// Teto de linhas de uma resposta do Data Hub (MAX_LIMIT do compile.ts de lá).
const CAP = 10_000
// Folga do top N cortado lá: um grupo que só se revela vazio aqui (data em
// texto que não se lê) não pode deixar o gráfico com um ponto a menos.
const TOP_MARGIN = 5
const DH_KIND = { number: 'number', date: 'date' }
const fmt = (n) => n.toLocaleString('pt-BR')
const num = (v) => {
  const n = v == null ? 0 : Number(v) // contagem chega como texto (BIGINT no DuckDB)
  return Number.isFinite(n) ? n : 0
}

// ─── Catálogo da fonte ─────────────────────────────────────────────────────
// Campos e tipos pedidos ao Data Hub. Com `sample`, vêm junto as mesmas
// INFER_SAMPLE_SIZE primeiras linhas que o modo cópia usaria, para o catálogo
// do Builder e a IA receberem os mesmos exemplos; para rodar um widget basta
// uma linha (os campos e tipos vêm em `columns`) — numa tabela de 150 colunas
// a amostra inteira já passa de 1 MB. O tipo DECLARADO lá vence a inferência
// pela amostra: um campo numérico sem valor nas primeiras linhas continua número.
async function sourceInfo(source, { label, sample = false } = {}) {
  const { columns, rows, total } = await directQuery(source, { limit: sample ? INFER_SAMPLE_SIZE : 1 })
  const types = new Map(columns.map((c) => [c.name, c.type]))
  const inferred = inferSourceDef(source, rows, label ?? directEntry(source)?.label)
  const byKey = new Map(inferred.fields.map((f) => [f.key, f]))
  const fields = columns.map(({ name, type }) => {
    const f = byKey.get(name) ?? { key: name, label: name, kind: 'dimension' }
    const kind = DH_KIND[type] ?? (f.kind === 'date' ? 'date' : 'dimension')
    if (kind === f.kind) return f
    // Amostra e cardinalidade só existem para dimensão de texto.
    const { sampleValues, distinctInSample, highCardinality, ...rest } = f
    return kind === 'dimension' ? { ...f, kind } : { ...rest, kind }
  })
  return { def: { key: source, label: inferred.label, fields, direct: true, rowCount: total }, types }
}

export async function directSourceDef(source, label) {
  return (await sourceInfo(source, { label, sample: true })).def
}

// ─── Filtros: formato do widget → formato do Data Hub ─────────────────────
// Mesma semântica de applyFilters (widgetQuery.mjs), que compara
// String(valor ?? ''): por isso o `orNull` (Data Hub) aparece onde lá o vazio
// passaria.
function inFilter(field, values) {
  const list = values.map(String)
  return list.includes('') ? { field, op: 'in', value: list, orNull: true } : { field, op: 'in', value: list }
}
// No SQL, `not in` descarta a linha vazia; lá ela só sai se '' estiver na lista.
function notInFilter(field, values) {
  const list = values.map(String)
  return list.includes('') ? { field, op: 'not_in', value: list } : { field, op: 'not_in', value: list, orNull: true }
}
const widgetFilterToDh = (wf) => (wf.op === 'in' ? inFilter(wf.field, wf.values ?? []) : notInFilter(wf.field, wf.values ?? []))

function nextDay(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
// Fim INCLUSIVO (até o último instante do dia final), como lá. Sem início nem
// fim, a linha sem data continua de fora — lá ela também não passava.
function dateRange(field, from, to) {
  const out = []
  if (from) out.push({ field, op: '>=', value: String(from).slice(0, 10) })
  if (to) out.push({ field, op: '<', value: nextDay(to) })
  if (!out.length) out.push({ field, op: 'not_null' })
  return out
}

function tabFilterToDh(tf) {
  if (!tf.values?.length) return []
  if (tf.filter.type === 'daterange') return dateRange(tf.filter.field, tf.values[0], tf.values[1])
  return [inFilter(tf.filter.field, tf.values)]
}

// Filtro próprio de uma medida nomeada: janela de data relativa + filtro fixo.
function measureExtra(m, now) {
  const out = []
  if (m?.dateWindow) {
    const w = resolveDateWindow(m.dateWindow, now)
    out.push(...dateRange(w.field, w.from, w.to))
  }
  for (const f of m?.filters ?? []) out.push(widgetFilterToDh(f))
  return out
}

// "Preenchido" do jeito daqui (nem nulo nem ''). Em texto, `!= ''` já descarta
// o nulo junto (regra do SQL).
function nonEmpty(types, field) {
  return (types.get(field) ?? 'text') === 'text' ? { field, op: '!=', value: '' } : { field, op: 'not_null' }
}
function nonEmptyFilters(types, specs) {
  const seen = new Set()
  const out = []
  for (const s of specs) {
    if (s.lookup || seen.has(s.field)) continue
    seen.add(s.field)
    out.push(nonEmpty(types, s.field))
  }
  return out
}

// ─── Campos e medidas ──────────────────────────────────────────────────────
// Dimensão/coluna do widget. `lookup` = campo de outra fonte, via relação.
function fieldSpec(d, lookups) {
  const fn = dimensionKeyFn(d)
  return { d, field: fn.field, bucket: fn.bucket, keyOf: fn.keyOf, lookup: lookups.find((lk) => lk.outKey === fn.field) ?? null }
}
// Parte da chave do grupo pela MESMA regra de lá: o keyOf da dimensão aplicado
// a uma linha que só tem aquele campo. Período chega como 'AAAA-MM-DD' do
// início, e parseIsoDate lê isso igual a uma data crua.
const partOf = (spec, raw) => spec.keyOf({ [spec.field]: raw })

function measureSpec(m, lookups, extra = []) {
  const agg = m?.agg ?? 'countDistinct'
  const field = m?.field ?? null
  if (agg !== 'countDistinct' && agg !== 'count' && !field) throw new Error(`Agregação ${agg} exige um campo numérico.`)
  return {
    agg, field, extra, extraKey: JSON.stringify(extra),
    lookup: field ? lookups.find((lk) => lk.outKey === field) ?? null : null,
  }
}
// makeAggregator trata qualquer agregação fora das quatro como média — aqui também.
function measureSelect({ agg, field }, as) {
  if (agg === 'countDistinct') return field ? { field, agg: 'count_distinct', as } : { agg: 'count', as }
  if (agg === 'count') return field ? { field, agg: 'count', as } : { agg: 'count', as }
  return { field, agg: agg === 'sum' ? 'sum' : 'avg', as }
}

function tooManyGroups(ctx) {
  return new Error(
    `Este widget passa de ${fmt(CAP)} combinações na fonte "${ctx.sourceDef.label}", e a leitura direta não traz mais ` +
    'que isso de uma vez. Filtre mais (período, status…), use um top N, ou crie no Data Hub um conjunto calculado já agregado.',
  )
}

// ─── Relações (campo de outra fonte) ───────────────────────────────────────
// Mesma descoberta de buildLookups (widgetQuery.mjs). A diferença é que a
// outra fonte pode também ser direta: aí o catálogo e o índice dela vêm do
// Data Hub, só com os campos que o widget usa.
async function anySourceDef(source, snap) {
  if (directEntry(source)) return (await sourceInfo(source)).def
  return getSourceDef(source, snap)
}

async function buildDirectLookups(widget, ctx) {
  const covered = new Set()
  const out = []
  for (const rel of ctx.relations) {
    let other, localKey, foreignKey
    if (rel.sourceA === widget.source) { other = rel.sourceB; localKey = rel.fieldA; foreignKey = rel.fieldB }
    else if (rel.sourceB === widget.source) { other = rel.sourceA; localKey = rel.fieldB; foreignKey = rel.fieldA }
    else continue
    if (covered.has(other)) continue
    if (!ctx.sourceDef.fields.some((f) => f.key === localKey)) continue
    const otherDef = await anySourceDef(other, ctx.snap)
    if (!otherDef || !otherDef.fields.some((f) => f.key === foreignKey)) continue
    covered.add(other)
    for (const f of otherDef.fields) {
      if (f.key === foreignKey) continue
      out.push({ source: other, localKey, foreignKey, field: f.key, label: f.label, outKey: `${other}.${f.key}` })
    }
  }
  for (const lk of widget.lookups ?? []) {
    if (covered.has(lk.source)) continue
    const otherDef = await anySourceDef(lk.source, ctx.snap)
    if (!otherDef) throw new Error(`Fonte desconhecida no lookup: ${lk.source}`)
    assertField(ctx.sourceDef, lk.localKey)
    assertField(otherDef, lk.foreignKey)
    assertField(otherDef, lk.field)
    out.push({ ...lk, outKey: `${lk.source}.${lk.field}` })
  }
  return out
}

// Todo campo que o widget toca, em qualquer papel — para saber quais
// relações precisam de índice.
function usedFields(widget) {
  const out = new Set()
  const add = (f) => { if (f) out.add(dimensionKeyFn(f).field) }
  for (const d of widget.dimensions ?? []) add(d)
  add(widget.legendDimension)
  for (const m of [...(widget.measures ?? []), widget.measure, ...(widget.measuresLine ?? []), widget.measureX, widget.matrixValue]) {
    if (m?.field) out.add(m.field)
  }
  add(widget.histogramField)
  for (const f of [...(widget.matrixRows ?? []), ...(widget.matrixColumns ?? [])]) add(f)
  for (const wf of widget.widgetFilters ?? []) out.add(wf.field)
  for (const c of widget.columns ?? []) add(c)
  return out
}

const indexKey = (lk) => `${lk.source}|${lk.foreignKey}`

// Índice chave → linha da outra fonte, com a mesma regra de buildLookups:
// primeira ocorrência quando a chave se repete. Feito uma vez por widget, com
// todos os campos que ele usa daquela fonte.
async function buildIndexes(ctx, lookups) {
  const bySource = new Map()
  for (const lk of lookups) {
    const k = indexKey(lk)
    if (!bySource.has(k)) bySource.set(k, { lk, fields: new Set() })
    bySource.get(k).fields.add(lk.field)
  }
  for (const [k, { lk, fields }] of bySource) {
    const index = new Map()
    if (directEntry(lk.source)) {
      const cols = [lk.foreignKey, ...fields]
      const { rows } = await directQuery(lk.source, {
        select: cols, groupBy: cols, filters: [{ field: lk.foreignKey, op: 'not_null' }], limit: CAP,
      })
      if (rows.length >= CAP) {
        throw new Error(`A fonte relacionada "${lk.source}" tem mais de ${fmt(CAP)} chaves — grande demais para ser trazida campo a campo. Crie no Data Hub um conjunto calculado com a junção.`)
      }
      for (const r of rows) { const key = String(r[lk.foreignKey]); if (!index.has(key)) index.set(key, r) }
    } else {
      for (const r of getRows(ctx.snap, lk.source) ?? []) {
        const key = r[lk.foreignKey]
        if (key == null) continue
        const s = String(key)
        if (!index.has(s)) index.set(s, r)
      }
    }
    ctx.indexes.set(k, index)
  }
}

function mappedValue(ctx, lk, vrow) {
  const key = vrow[lk.localKey]
  const match = key == null ? undefined : ctx.indexes.get(indexKey(lk))?.get(String(key))
  return match ? match[lk.field] ?? null : null
}

// Filtro fixo sobre campo de outra fonte vira filtro sobre a CHAVE da relação
// daqui — as chaves cujo valor de lá passa no filtro. Assim ele continua sendo
// resolvido no Data Hub, com contagem distinta e top N exatos. Só não dá
// quando a lista aceita o vazio (''): aí também passaria a linha SEM par na
// outra fonte, que não tem chave para listar — esse vai pelo caminho virtual.
function lookupFilterToNative(ctx, wf, lk) {
  const values = (wf.values ?? []).map(String)
  if (values.includes('')) return null
  const set = new Set(values)
  const keys = []
  for (const [key, row] of ctx.indexes.get(indexKey(lk)) ?? []) if (set.has(String(row[lk.field] ?? ''))) keys.push(key)
  return wf.op === 'in'
    ? { field: lk.localKey, op: 'in', value: keys }
    : { field: lk.localKey, op: 'not_in', value: keys, orNull: true }
}

// ─── Agrupamento ───────────────────────────────────────────────────────────
// Agrupa a fonte direta por `dims` e calcula `measures` em cada grupo.
//   filters       — filtros de base, já no formato do Data Hub;
//   lookupFilters — filtros fixos sobre campo de outra fonte que não deu para
//                   converter (ver lookupFilterToNative);
//   mustHave      — campos que precisam estar preenchidos para a linha contar,
//                   sem fazer parte do grupo (na Matriz, linha sem coluna não
//                   entra em total nenhum);
//   dropEmpty     — descarta grupo com parte vazia (gráficos);
//   order/limit   — top N cortado no Data Hub, quando o chamador vai cortar
//                   exatamente nessa ordem.
// → [{ parts, values }] na ordem em que o Data Hub devolveu: é a ordem de
// chegada, que o motor em memória também usa para desempatar.
function fetchGroups(ctx, opts) {
  const virtual = opts.dims.some((s) => s.lookup) || opts.measures.some((m) => m.lookup)
    || (opts.mustHave ?? []).some((s) => s.lookup) || (opts.lookupFilters ?? []).length > 0
  return virtual ? fetchGroupsVirtual(ctx, opts) : fetchGroupsDirect(ctx, opts)
}

// Medidas com filtro próprio diferente (medida nomeada com janela/filtro) vão
// em consultas separadas; os GRUPOS saem sempre da consulta sem filtro extra,
// como lá, onde um grupo existe se alguma linha passa no filtro de base.
function signatures(measures) {
  const sigs = new Map([['[]', { extra: [], items: [] }]])
  measures.forEach((m, i) => {
    if (!sigs.has(m.extraKey)) sigs.set(m.extraKey, { extra: m.extra, items: [] })
    sigs.get(m.extraKey).items.push(i)
  })
  return [...sigs.entries()].map(([key, sig]) => ({ key, ...sig }))
}

async function fetchGroupsDirect(ctx, { dims, measures, filters, mustHave = [], dropEmpty = true, order = null, limit = CAP }) {
  const base = [...filters, ...nonEmptyFilters(ctx.types, dropEmpty ? [...dims, ...mustHave] : mustHave)]
  const dimSel = dims.map((s, j) => (s.bucket ? { field: s.field, grain: s.bucket, as: `__d${j}` } : s.field))
  const groupBy = dims.map((s) => (s.bucket ? { field: s.field, grain: s.bucket } : s.field))
  const sigs = signatures(measures)
  const pushOrder = order && sigs.length === 1
  const queries = sigs.map((sig) => {
    const select = [...dimSel, ...sig.items.map((i) => measureSelect(measures[i], `__m${i}`))]
    if (!sig.items.length) select.push({ agg: 'count', as: '__n' }) // só para trazer os grupos
    const def = { select, filters: [...base, ...sig.extra], limit: CAP }
    if (groupBy.length) def.groupBy = groupBy
    if (pushOrder) {
      def.orderBy = order.by === 'measure'
        ? [{ field: `__m${order.index}`, dir: order.dir }]
        : dims.map((s, j) => ({ field: s.bucket ? `__d${j}` : s.field, dir: order.dir }))
      def.limit = limit
    }
    return { sig, def }
  })
  const results = await Promise.all(queries.map((q) => directQuery(ctx.source, q.def)))

  const groups = new Map()
  results.forEach((res, qi) => {
    const { sig, def } = queries[qi]
    if (def.limit === CAP && res.rows.length >= CAP) throw tooManyGroups(ctx)
    for (const row of res.rows) {
      const parts = dims.map((s, j) => partOf(s, s.bucket ? row[`__d${j}`] : row[s.field]))
      if (dropEmpty && parts.some((p) => p == null || p === '')) continue
      const key = JSON.stringify(parts)
      let g = groups.get(key)
      if (!g) {
        if (sig.key !== '[]') continue
        g = { parts, values: measures.map(() => 0) }
        groups.set(key, g)
      }
      for (const i of sig.items) g.values[i] = num(row[`__m${i}`])
    }
  })
  return { groups: [...groups.values()] }
}

// Partes somáveis de uma medida, por linha virtual (um grupo do Data Hub).
function partSelects(m, i) {
  if (m.lookup) return []
  if (m.agg === 'count' && m.field) return [{ field: m.field, agg: 'count', as: `__c${i}` }]
  if (m.agg === 'sum') return [{ field: m.field, agg: 'sum', as: `__s${i}` }]
  if (m.agg !== 'count' && m.agg !== 'countDistinct') {
    return [{ field: m.field, agg: 'sum', as: `__s${i}` }, { field: m.field, agg: 'count', as: `__c${i}` }]
  }
  return []
}
const newAcc = () => ({ n: 0, s: 0, c: 0, set: new Set() })
// Mesma conta de makeAggregator, com o peso da linha virtual (quantas linhas
// de verdade ela representa).
function accAdd(acc, m, i, vrow, ctx) {
  const n = num(vrow.__n)
  if (m.lookup) {
    const v = mappedValue(ctx, m.lookup, vrow)
    if (m.agg === 'countDistinct') { if (v != null) acc.set.add(String(v)) }
    else if (m.agg === 'count') { if (v != null && v !== '') acc.n += n }
    else { const x = Number(v); if (!Number.isNaN(x)) { acc.s += x * n; acc.c += n } }
    return
  }
  if (m.agg === 'countDistinct') {
    if (!m.field) acc.n += n
    else if (vrow[m.field] != null) acc.set.add(String(vrow[m.field]))
    return
  }
  if (m.agg === 'count') { acc.n += m.field ? num(vrow[`__c${i}`]) : n; return }
  acc.s += num(vrow[`__s${i}`])
  if (m.agg !== 'sum') acc.c += num(vrow[`__c${i}`])
}
function accValue(acc, m) {
  if (m.agg === 'countDistinct') return m.field ? acc.set.size : acc.n
  if (m.agg === 'count') return acc.n
  if (m.agg === 'sum') return acc.s
  return acc.c > 0 ? acc.s / acc.c : 0
}

// Colunas daqui que cada linha virtual precisa trazer.
function carryColumns(specs, extraFields = []) {
  const cols = new Map()
  const add = (field, grain = null) => {
    const name = grain ? `__g${grain}:${field}` : field
    if (!cols.has(name)) cols.set(name, { field, grain, name })
  }
  for (const s of specs) {
    if (s.lookup) add(s.lookup.localKey)
    else add(s.field, s.bucket)
  }
  for (const f of extraFields) add(f)
  return [...cols.values()]
}
const carrySelect = (cols) => cols.map((c) => (c.grain ? { field: c.field, grain: c.grain, as: c.name } : c.field))
const carryGroupBy = (cols) => cols.map((c) => (c.grain ? { field: c.field, grain: c.grain } : c.field))
const rawOf = (ctx, s, vrow) => (s.lookup ? mappedValue(ctx, s.lookup, vrow) : vrow[s.bucket ? `__g${s.bucket}:${s.field}` : s.field])

// Filtro do widget sobre campo de outra fonte, aplicado na linha virtual já
// mesclada — com a mesma comparação de applyFilters.
function passesLookupFilters(ctx, lookupFilters, vrow) {
  for (const lf of lookupFilters) {
    const has = new Set(lf.values ?? []).has(String(mappedValue(ctx, lf.lookup, vrow) ?? ''))
    if (lf.op === 'in' ? !has : has) return false
  }
  return true
}

async function fetchGroupsVirtual(ctx, { dims, measures, filters, lookupFilters = [], mustHave = [], dropEmpty = true }) {
  const required = dropEmpty ? [...dims, ...mustHave] : mustHave
  const cols = carryColumns([...dims, ...mustHave], [
    ...measures.map((m) => (m.lookup ? m.lookup.localKey : m.agg === 'countDistinct' ? m.field : null)).filter(Boolean),
    ...lookupFilters.map((lf) => lf.lookup.localKey),
  ])
  const base = [...filters, ...nonEmptyFilters(ctx.types, required)]
  const sigs = signatures(measures)
  const results = await Promise.all(sigs.map((sig) => {
    const def = {
      select: [...carrySelect(cols), { agg: 'count', as: '__n' }, ...sig.items.flatMap((i) => partSelects(measures[i], i))],
      filters: [...base, ...sig.extra],
      limit: CAP,
    }
    if (cols.length) def.groupBy = carryGroupBy(cols)
    return directQuery(ctx.source, def)
  }))

  const groups = new Map()
  results.forEach((res, qi) => {
    const sig = sigs[qi]
    if (res.rows.length >= CAP) throw tooManyGroups(ctx)
    for (const vrow of res.rows) {
      if (!passesLookupFilters(ctx, lookupFilters, vrow)) continue
      const parts = dims.map((s) => partOf(s, rawOf(ctx, s, vrow)))
      if (dropEmpty && parts.some((p) => p == null || p === '')) continue
      if (mustHave.some((s) => { const p = partOf(s, rawOf(ctx, s, vrow)); return p == null || p === '' })) continue
      const key = JSON.stringify(parts)
      let g = groups.get(key)
      if (!g) {
        if (sig.key !== '[]') continue
        g = { parts, accs: measures.map(newAcc) }
        groups.set(key, g)
      }
      for (const i of sig.items) accAdd(g.accs[i], measures[i], i, vrow, ctx)
    }
  })
  return { groups: [...groups.values()].map((g) => ({ parts: g.parts, values: g.accs.map((acc, i) => accValue(acc, measures[i])) })) }
}

// ─── Widgets ───────────────────────────────────────────────────────────────
export async function runDirectWidgetQuery({
  widget, tabFilters = [], relations = [], page = 1, pageSize = 50, accessToken, tableSort, matrixSort,
  measuresById = new Map(), measureSheetKeys = [],
}) {
  const info = await sourceInfo(widget.source)
  const sourceDef = info.def
  const snap = await withSheetSources(getSnapshot(), [...collectWidgetSheetKeys(widget, relations), ...measureSheetKeys], accessToken)
  const ctx = { source: widget.source, sourceDef, types: info.types, snap, relations, indexes: new Map() }

  const measuresIn = widget.measures?.length ? widget.measures : [widget.measure ?? { agg: 'countDistinct' }]
  const lookups = await buildDirectLookups(widget, ctx)

  // Mesmas validações do motor em memória, com as mesmas mensagens.
  for (const d of widget.dimensions ?? []) assertFieldOrLookup(sourceDef, lookups, dimensionKeyFn(d).field)
  if (widget.legendDimension) assertFieldOrLookup(sourceDef, lookups, dimensionKeyFn(widget.legendDimension).field)
  for (const m of measuresIn) if (m.field) assertFieldOrLookup(sourceDef, lookups, m.field)
  if (widget.measureX?.field) assertFieldOrLookup(sourceDef, lookups, widget.measureX.field)
  for (const m of widget.measuresLine ?? []) if (m.field) assertFieldOrLookup(sourceDef, lookups, m.field)
  if (widget.histogramField) assertFieldOrLookup(sourceDef, lookups, widget.histogramField)
  if (widget.type === 'matrix') {
    for (const f of widget.matrixRows ?? []) assertFieldOrLookup(sourceDef, lookups, dimensionKeyFn(f).field)
    for (const f of widget.matrixColumns ?? []) assertFieldOrLookup(sourceDef, lookups, dimensionKeyFn(f).field)
    if (widget.matrixValue?.field) assertFieldOrLookup(sourceDef, lookups, widget.matrixValue.field)
  }
  for (const wf of widget.widgetFilters ?? []) assertFieldOrLookup(sourceDef, lookups, wf.field)
  for (const tf of tabFilters) {
    if (tf.filter.source === widget.source) assertField(sourceDef, tf.filter.field)
  }

  const used = usedFields(widget)
  await buildIndexes(ctx, lookups.filter((lk) => used.has(lk.outKey)))

  // Filtros de base: aba (desta fonte), aba de outra fonte via relação
  // (semi-join, ver resolveIndirectFilter) e filtro fixo do widget.
  const filters = []
  for (const tf of tabFilters) if (tf.filter.source === widget.source) filters.push(...tabFilterToDh(tf))
  for (const tf of tabFilters) {
    if (tf.filter.source === widget.source) continue
    const resolved = await resolveIndirectFilter(tf, sourceDef, relations, snap)
    if (resolved) filters.push(inFilter(resolved.field, resolved.values))
  }
  const lookupFilters = []
  for (const wf of widget.widgetFilters ?? []) {
    const lk = lookups.find((x) => x.outKey === wf.field)
    if (!lk) { filters.push(widgetFilterToDh(wf)); continue }
    const native = lookupFilterToNative(ctx, wf, lk)
    if (native) filters.push(native)
    else lookupFilters.push({ ...wf, lookup: lk })
  }
  const base = { filters, lookupFilters }

  if (widget.type === 'table') return directTable(ctx, widget, lookups, used, base, { page, pageSize, tableSort })
  if (widget.type === 'matrix') return directMatrix(ctx, widget, lookups, base, matrixSort)
  if (widget.type === 'scatter') return directScatter(ctx, widget, lookups, base, measuresIn)
  if (widget.type === 'histogram') return directHistogram(ctx, widget, lookups, base)

  // KPI (sem dimensão). Medida nomeada vai pela mesma resolução do motor em
  // memória — ela sabe pedir ao Data Hub a medida de fonte direta.
  if (!widget.dimensions?.length) {
    if (measuresIn[0]?.measureRef) {
      const mctx = { measuresById, snap, relations, tabFilters, now: new Date(), sourceRowsCache: new Map(), resolvedScalarCache: new Map(), visiting: new Set() }
      const resolved = await resolveMeasure(measuresIn[0].measureRef, mctx)
      const point = { label: 'total', value: resolved.value }
      if (isPartialMeasureFilter(tabFilters, resolved.sourcesFiltered)) point.measureWarning = 'filtro parcial'
      return { points: [point] }
    }
    const { groups } = await fetchGroups(ctx, { dims: [], measures: [measureSpec(measuresIn[0], lookups)], ...base })
    return { points: [{ label: 'total', value: groups[0]?.values[0] ?? 0 }] }
  }

  if (widget.legendDimension) return directLegend(ctx, widget, lookups, base, measuresIn, measuresById)
  return directSeries(ctx, widget, lookups, base, measuresIn, measuresById)
}

// Uma série por medida (e as de linha do combo), como no fim de runWidgetQuery.
async function directSeries(ctx, widget, lookups, base, measuresIn, measuresById) {
  const dims = widget.dimensions.map((d) => fieldSpec(d, lookups))
  const { isDateDim, labelOf } = compositeDimensionFn(widget.dimensions)
  const limit = Math.min(widget.limit ?? 15, MAX_POINTS)
  const measuresLineIn = widget.type === 'comboBarLine' ? (widget.measuresLine ?? []) : []
  const bars = measuresIn.map((m) => resolveLevel2Measure(m, widget.source, measuresById))
  const lines = measuresLineIn.map((m) => resolveLevel2Measure(m, widget.source, measuresById))
  const specs = [...bars, ...lines].map((m) => measureSpec(m, lookups, measureExtra(m)))
  // A ordem que sortAndLimitPoints vai aplicar, para o corte acontecer lá:
  // série temporal sem ordem pega os mais RECENTES; com ordem (qualquer uma),
  // os mais antigos; o resto vai pelo valor da 1ª medida.
  const order = isDateDim
    ? { by: 'dims', dir: widget.sort ? 'asc' : 'desc' }
    : { by: 'measure', index: 0, dir: widget.sort === 'asc' ? 'asc' : 'desc' }
  const { groups } = await fetchGroups(ctx, { dims, measures: specs, ...base, order, limit: limit + TOP_MARGIN })

  const multi = measuresIn.length > 1
  let points = groups.map((g) => {
    const point = { label: g.parts.join(' / '), value: g.values[0] }
    if (multi) measuresIn.forEach((_, i) => { point[`s${i}`] = g.values[i] })
    lines.forEach((_, i) => { point[`l${i}`] = g.values[bars.length + i] })
    return point
  })
  points = sortAndLimitPoints(points, widget.sort, isDateDim, limit)
  points = points.map((p) => ({ ...p, label: labelOf(p.label) }))
  const seriesKeys = multi
    ? measuresIn.map((m, i) => ({ key: `s${i}`, label: m.label ?? defaultMeasureLabel(m, measuresById), color: m.color, role: 'bar', dataLabels: m.dataLabels }))
    : [{ key: 'value', label: measuresIn[0].label ?? defaultMeasureLabel(measuresIn[0], measuresById), color: measuresIn[0].color, role: 'bar', dataLabels: measuresIn[0].dataLabels }]
  measuresLineIn.forEach((m, i) => seriesKeys.push({ key: `l${i}`, label: m.label ?? defaultMeasureLabel(m, measuresById), color: m.color, role: 'line', dataLabels: m.dataLabels }))
  return { points, seriesKeys }
}

// Quebra por legenda: uma consulta dá o total de cada valor da legenda (para
// escolher as 8 séries), outra dá cada célula eixo × legenda. Contagem
// distinta não se soma entre células, por isso o total vem de consulta própria.
async function directLegend(ctx, widget, lookups, base, measuresIn, measuresById) {
  const resolved = resolveLevel2Measure(measuresIn[0], widget.source, measuresById)
  // Lá, a linha fora da janela/filtro da medida nomeada sai antes de tudo —
  // então aqui o filtro dela vale para as duas consultas inteiras.
  const filters = [...base.filters, ...measureExtra(resolved)]
  const m = measureSpec(resolved, lookups)
  const dims = widget.dimensions.map((d) => fieldSpec(d, lookups))
  const legend = fieldSpec(widget.legendDimension, lookups)
  const { isDateDim, labelOf } = compositeDimensionFn(widget.dimensions)
  const limit = Math.min(widget.limit ?? 15, MAX_POINTS)
  const [totals, cells] = await Promise.all([
    fetchGroups(ctx, { dims: [legend], measures: [m], filters, lookupFilters: base.lookupFilters, mustHave: dims }),
    fetchGroups(ctx, { dims: [...dims, legend], measures: [m], filters, lookupFilters: base.lookupFilters }),
  ])
  const topLegendKeys = totals.groups
    .map((g) => [g.parts[0], g.values[0]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LEGEND_SERIES)
    .map(([k]) => k)
  const primary = new Map()
  for (const g of cells.groups) {
    const pKey = g.parts.slice(0, dims.length).join(' / ')
    if (!primary.has(pKey)) primary.set(pKey, new Map())
    primary.get(pKey).set(g.parts[dims.length], g.values[0])
  }
  let points = [...primary.entries()].map(([label, byLegend]) => {
    const point = { label, value: 0 }
    for (const k of topLegendKeys) {
      const v = byLegend.has(k) ? byLegend.get(k) : 0
      point[k] = v
      point.value += v
    }
    return point
  })
  points = sortAndLimitPoints(points, widget.sort, isDateDim, limit)
  points = points.map((p) => ({ ...p, label: labelOf(p.label) }))
  return { points, seriesKeys: topLegendKeys.map((k) => ({ key: k, label: k })) }
}

async function directScatter(ctx, widget, lookups, base, measuresIn) {
  if (!widget.dimensions?.length) return { points: [] }
  const dims = widget.dimensions.map((d) => fieldSpec(d, lookups))
  const { labelOf } = compositeDimensionFn(widget.dimensions)
  const x = measureSpec(widget.measureX ?? { agg: 'countDistinct' }, lookups)
  const y = measureSpec(measuresIn[0], lookups)
  const limit = Math.min(widget.limit ?? 15, MAX_POINTS)
  const { groups } = await fetchGroups(ctx, { dims, measures: [x, y], ...base, order: { by: 'measure', index: 1, dir: 'desc' }, limit: limit + TOP_MARGIN })
  const points = groups
    .map((g) => ({ label: labelOf(g.parts.join(' / ')), value: g.values[1], x: g.values[0] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
  return { points }
}

// Cada valor distinto chega já contado; a conta das faixas e da curva é a de
// histogramResult (a mesma do modo cópia).
async function directHistogram(ctx, widget, lookups, base) {
  const field = widget.histogramField
  if (!field) return { points: [] }
  if (lookups.some((lk) => lk.outKey === field) || base.lookupFilters.length) {
    throw new Error('Histograma sobre campo de outra fonte ainda não funciona em fonte de leitura direta.')
  }
  const { rows } = await directQuery(ctx.source, { select: [field, { agg: 'count', as: '__n' }], groupBy: [field], filters: base.filters, limit: CAP })
  if (rows.length >= CAP) {
    throw new Error(
      `O campo "${field}" tem mais de ${fmt(CAP)} valores diferentes, e o histograma em leitura direta conta cada valor no ` +
      'Data Hub. Filtre por período, ou use um campo com menos variação.',
    )
  }
  const pairs = rows.map((r) => [Number(r[field]), num(r.__n)]).filter(([v]) => Number.isFinite(v))
  return histogramResult(pairs, widget.histogramBins)
}

// Matriz: cada nível de linha (e o total geral, e o total por coluna) é uma
// consulta própria — contagem distinta e média não se somam de um nível para
// o outro, então o subtotal precisa vir pronto. Daí em diante é a mesma
// renderMatrix do modo cópia.
async function directMatrix(ctx, widget, lookups, base, matrixSort) {
  const rowFields = widget.matrixRows ?? []
  const colFields = widget.matrixColumns ?? []
  if (!rowFields.length) return { matrix: { columns: [], rows: [], grandTotal: {}, grandTotalAll: 0 } }
  const measureCfg = widget.matrixValue ?? { agg: 'countDistinct' }
  const m = measureSpec(measureCfg, lookups)
  const rowSpecs = rowFields.map((f) => fieldSpec(f, lookups))
  const colSpecs = colFields.map((f) => fieldSpec(f, lookups))
  // Lá, linha com qualquer campo de linha OU de coluna vazio não entra em
  // total nenhum — por isso todo nível exige todos eles.
  const mustHave = [...rowSpecs, ...colSpecs]
  const q = (dims) => fetchGroups(ctx, { dims, measures: [m], ...base, mustHave })
  const depths = rowSpecs.map((_, d) => rowSpecs.slice(0, d + 1))
  const [perRow, perCol, grandCols, grand] = await Promise.all([
    Promise.all(depths.map((dims) => q(dims))),
    colSpecs.length ? Promise.all(depths.map((dims) => q([...dims, ...colSpecs]))) : null,
    colSpecs.length ? q(colSpecs) : null,
    q([]),
  ])
  const colKeyOf = (parts) => parts.join(' / ')
  const levels = depths.map((_, d) => {
    const level = new Map()
    for (const { parts, values } of perRow[d].groups) {
      level.set(parts.join(MATRIX_SEP), { labelParts: parts, perCol: new Map(), rowAcc: values[0] })
    }
    if (perCol) {
      for (const { parts, values } of perCol[d].groups) {
        level.get(parts.slice(0, d + 1).join(MATRIX_SEP))?.perCol.set(colKeyOf(parts.slice(d + 1)), values[0])
      }
    } else {
      for (const node of level.values()) node.perCol.set(MATRIX_SINGLE_COL, node.rowAcc)
    }
    return level
  })
  const grandAcc = grand.groups[0]?.values[0] ?? 0
  const grandPerCol = grandCols
    ? new Map(grandCols.groups.map(({ parts, values }) => [colKeyOf(parts), values[0]]))
    : new Map([[MATRIX_SINGLE_COL, grandAcc]])
  return { matrix: renderMatrix({ levels, grandPerCol, grandAcc, valueOf: (v) => v }, rowFields, colFields, measureCfg, matrixSort) }
}

// Tabela. Só com colunas daqui: paginada no próprio Data Hub (combinações
// distintas = GROUP BY, total de grupos = withTotal) — funciona com milhões de
// linhas. Com coluna de outra fonte: os grupos (colunas daqui + chave da
// relação) viram linhas mescladas e passam pela mesma buildTableResult do
// modo cópia.
async function directTable(ctx, widget, lookups, used, base, { page, pageSize, tableSort }) {
  const cols = widget.columns?.length ? widget.columns : ctx.sourceDef.fields.map((f) => f.key)
  for (const c of cols) assertFieldOrLookup(ctx.sourceDef, lookups, BUCKET_RE.test(c) ? dimensionKeyFn(c).field : c)
  const specs = cols.map((c) => fieldSpec(c, lookups))

  if (specs.some((s) => s.lookup) || base.lookupFilters.length) {
    const tableLookups = lookups.filter((lk) => used.has(lk.outKey))
    // Período sem a data crua entre as colunas: traz o início do período sob
    // o nome do campo — o keyOf da coluna lê isso igual a uma data. Com mais
    // de um período do mesmo campo, vale o mais fino.
    const RANK = { year: 0, quarter: 1, month: 2, day: 3 }
    const plain = new Set(specs.filter((s) => !s.lookup && !s.bucket).map((s) => s.field))
    const grainOf = new Map()
    for (const s of specs) {
      if (s.lookup || !s.bucket || plain.has(s.field)) continue
      if (!grainOf.has(s.field) || RANK[s.bucket] > RANK[grainOf.get(s.field)]) grainOf.set(s.field, s.bucket)
    }
    const carry = new Map()
    for (const f of plain) carry.set(f, f)
    for (const [field, grain] of grainOf) carry.set(field, { field, grain, as: field })
    for (const lk of tableLookups) if (!carry.has(lk.localKey)) carry.set(lk.localKey, lk.localKey)
    for (const lf of base.lookupFilters) if (!carry.has(lf.lookup.localKey)) carry.set(lf.lookup.localKey, lf.lookup.localKey)
    const select = [...carry.values()]
    const groupBy = select.map((c) => (typeof c === 'string' ? c : { field: c.field, grain: c.grain }))
    const { rows } = await directQuery(ctx.source, { select, groupBy, filters: base.filters, limit: CAP })
    if (rows.length >= CAP) throw tooManyGroups(ctx)
    const merged = []
    for (const vrow of rows) {
      if (!passesLookupFilters(ctx, base.lookupFilters, vrow)) continue
      const row = { ...vrow }
      for (const lk of tableLookups) row[lk.outKey] = mappedValue(ctx, lk, vrow)
      merged.push(row)
    }
    return buildTableResult(merged, cols, tableLookups, { page, pageSize, tableSort })
  }

  const alias = (j) => (specs[j].bucket ? `__d${j}` : specs[j].field)
  const clicked = tableSort?.column ? cols.indexOf(tableSort.column) : -1
  const orderBy = clicked >= 0
    ? [
        { field: alias(clicked), dir: tableSort.direction === 'desc' ? 'desc' : 'asc' },
        ...cols.map((_, j) => j).filter((j) => j !== clicked).map((j) => ({ field: alias(j), dir: 'asc' })),
      ]
    : cols.map((_, j) => ({ field: alias(j), dir: 'asc' }))
  const res = await directQuery(ctx.source, {
    select: specs.map((s, j) => (s.bucket ? { field: s.field, grain: s.bucket, as: `__d${j}` } : s.field)),
    groupBy: specs.map((s) => (s.bucket ? { field: s.field, grain: s.bucket } : s.field)),
    filters: base.filters,
    orderBy,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    withTotal: true,
  })
  const rows = res.rows.map((row) => Object.fromEntries(cols.map((c, j) => {
    const s = specs[j]
    if (!s.bucket) return [c, row[s.field] ?? null]
    const raw = partOf(s, row[`__d${j}`])
    return [c, raw == null ? null : dimensionKeyFn(c).prettyOf(raw)]
  })))
  return { rows, total: res.total ?? rows.length, page, pageSize }
}

// ─── Valores de filtro, relação e medida nomeada ───────────────────────────
export async function runDirectFieldValues({ source, field }) {
  const info = await sourceInfo(source)
  assertField(info.def, field)
  const { rows } = await directQuery(source, {
    select: [field], groupBy: [field], filters: [nonEmpty(info.types, field)],
    orderBy: [{ field, dir: 'asc' }], limit: MAX_FIELD_VALUES,
  })
  return rows.map((r) => String(r[field])).filter((v) => v !== '').sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

// Chaves da relação que sobram na fonte do FILTRO (direta) depois de aplicar
// o filtro de aba — o semi-join de resolveIndirectFilter. Mais de 10 mil
// chaves não dá para repassar inteiro: aí erro, nunca um filtro pela metade.
export async function directSemiJoinKeys(tf, keyField) {
  const source = tf.filter.source
  const { rows } = await directQuery(source, {
    select: [keyField], groupBy: [keyField], filters: [...tabFilterToDh(tf), { field: keyField, op: 'not_null' }], limit: CAP,
  })
  if (rows.length >= CAP) {
    throw new Error(
      `O filtro "${tf.filter.label ?? tf.filter.field}" alcança mais de ${fmt(CAP)} chaves da relação na fonte ` +
      `"${directEntry(source)?.label ?? source}" — é chave demais para repassar a outra fonte. Escolha menos valores, ` +
      'ou relacione por um campo com menos variação.',
    )
  }
  return rows.map((r) => String(r[keyField]))
}

// resolveSimpleMeasure (widgetQuery.mjs) de uma medida de fonte direta: o
// mesmo número, calculado no Data Hub — filtro de aba da fonte, filtro de
// aba de outra fonte via relação, filtro próprio e janela da medida.
export async function directMeasureValue(def, ctx) {
  const info = await sourceInfo(def.source)
  if (def.field) assertField(info.def, def.field)
  for (const f of def.filters ?? []) assertField(info.def, f.field)
  ctx.directFilters ??= new Map()
  let cached = ctx.directFilters.get(def.source)
  if (!cached) {
    const relevant = ctx.tabFilters.filter((tf) => tf.filter.source === def.source)
    const filters = relevant.flatMap(tabFilterToDh)
    const sourcesFiltered = new Set(relevant.length ? [def.source] : [])
    for (const tf of ctx.tabFilters) {
      if (tf.filter.source === def.source) continue
      const resolved = await resolveIndirectFilter(tf, info.def, ctx.relations, ctx.snap)
      if (resolved) { filters.push(inFilter(resolved.field, resolved.values)); sourcesFiltered.add(tf.filter.source) }
    }
    cached = { filters, sourcesFiltered }
    ctx.directFilters.set(def.source, cached)
  }
  const { rows } = await directQuery(def.source, {
    select: [measureSelect({ agg: def.agg ?? 'countDistinct', field: def.field ?? null }, '__v')],
    filters: [...cached.filters, ...measureExtra(def, ctx.now)],
  })
  return { value: num(rows[0]?.__v), sourcesFiltered: cached.sourcesFiltered }
}
