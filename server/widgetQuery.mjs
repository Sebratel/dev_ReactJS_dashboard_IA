// ─────────────────────────────────────────────────────────────────────────
// Motor genérico de agregação do Dashboard Builder — executa um WidgetConfig
// + filtros ativos da aba sobre o snapshot em memória:
//   filtra (aba + widget) → agrupa por dimensão → agrega → ordena → limita.
// Toda fonte (widget.source) é uma chave cadastrada na tela — um dataset do
// Data Hub (`dhub:<id>`, ver server/lakehouseSources.mjs) ou uma planilha do
// Google (`sheet:<id>`). Não há fontes "embutidas": o catálogo de campos de
// cada uma é inferido em tempo real a partir de uma amostra dos dados reais
// (ver inferSourceDef), já que a forma vem do dataset publicado e não de um
// tipo TS fixo por trás.
// Espelha os tipos de src/features/builder/types.ts.
// ─────────────────────────────────────────────────────────────────────────
import { getSnapshot } from './dataset.mjs'
import { isSheetSource, sheetSourceId, sourceKey as sheetSourceKey, listSheetSources, resolveSheetRows } from './sheetSources.mjs'
import { listLakehouseSources, sourceKey as lakehouseSourceKey } from './lakehouseSources.mjs'
import { fieldDictionaryMap, DATA_TYPE_KIND } from './fieldDictionary.mjs'

const MAX_POINTS = 100
const MAX_FIELD_VALUES = 500
const MAX_LEGEND_SERIES = 8
const INFER_SAMPLE_SIZE = 300
const MAX_MATRIX_ROWS = 500
const MAX_MATRIX_COLUMNS = 50

const AGG_LABELS = { countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média' }
function defaultMeasureLabel(m) {
  const aggLabel = AGG_LABELS[m.agg] ?? m.agg
  return m.field ? `${aggLabel} de ${m.field}` : aggLabel
}

function sortAndLimitPoints(points, sort, isDateDim, limit) {
  if (sort === 'asc') {
    points.sort(isDateDim ? (a, b) => a.label.localeCompare(b.label) : (a, b) => a.value - b.value)
  } else if (isDateDim) {
    // Séries temporais sem sort explícito: ordem cronológica.
    points.sort((a, b) => a.label.localeCompare(b.label))
  } else {
    points.sort((a, b) => b.value - a.value)
  }
  // Série temporal: limita mantendo os pontos mais recentes.
  return isDateDim && !sort ? points.slice(-limit) : points.slice(0, limit)
}

// Linhas de uma fonte: sempre snap.data[id] (resultado bruto da query).
function getRows(snap, source) {
  return snap?.data?.[source] ?? null
}

// Quantos valores distintos de um campo de texto acompanham o catálogo, e a
// partir de quantos ele é considerado "identificador" (alta cardinalidade) em
// vez de categoria. Serve principalmente à montagem com IA: com exemplos em
// mão, o modelo escreve o filtro com a grafia certa sem precisar consultar o
// campo, e sabe que agrupar por `client_name` não faz sentido.
const SAMPLE_VALUES_PER_FIELD = 6
const HIGH_CARDINALITY_RATIO = 0.5

// Deriva um SourceDef em tempo real a partir de uma amostra dos dados reais
// — não há TS interface hand-escrita, pois a forma vem do dataset publicado.
// kind por valor observado; campos nunca vistos com valor não-nulo ficam
// 'dimension' (comportamento neutro: agrupável/filtrável).
function inferSourceDef(source, rows, label) {
  const fields = new Map()
  const sample = rows.slice(0, INFER_SAMPLE_SIZE)
  for (const r of sample) {
    for (const [k, v] of Object.entries(r)) {
      let f = fields.get(k)
      if (!f) { f = { key: k, label: k, kind: 'dimension', seen: new Set() }; fields.set(k, f) }
      if (v == null) continue
      if (!f.sawValue) {
        f.sawValue = true
        if (typeof v === 'number') f.kind = 'number'
        else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) f.kind = 'date'
      }
      // Só acompanha os distintos de texto, e para de acumular depois que já
      // ficou claro que é identificador — não vale gastar memória contando
      // 300 nomes de cliente diferentes.
      if (f.kind === 'dimension' && f.seen.size <= INFER_SAMPLE_SIZE * HIGH_CARDINALITY_RATIO) {
        f.seen.add(String(v))
      }
    }
  }
  return {
    key: source,
    label: label ?? source,
    fields: Array.from(fields.values()).map(({ sawValue, seen, ...f }) => {
      if (f.kind !== 'dimension' || seen.size === 0) return f
      // Muitos valores distintos numa amostra pequena = identificador (nome,
      // CPF, id): útil pra listar numa tabela, ruim pra agrupar.
      if (seen.size > sample.length * HIGH_CARDINALITY_RATIO) return { ...f, highCardinality: true }
      return { ...f, sampleValues: Array.from(seen).slice(0, SAMPLE_VALUES_PER_FIELD), distinctInSample: seen.size }
    }),
  }
}

function getSourceDef(source, snap) {
  const rows = getRows(snap, source)
  if (!Array.isArray(rows)) return null
  return inferSourceDef(source, rows)
}

// Planilhas do Google (server/sheetSources.mjs) referenciadas por um widget —
// fonte principal, qualquer lookup, E qualquer TabRelation que ligue a fonte
// do widget a uma planilha (ver resolveIndirectFilter) — identificadas pelo
// prefixo `sheet:`. Faltar aqui uma fonte usada só numa relação (nunca como
// source/lookup do próprio widget) é o bug real que motivou este comentário:
// sem carregar a planilha no snapshot, resolveIndirectFilter recebia
// `getRows(...) → null → []` pra ela — um array VAZIO indistinguível de "o
// filtro realmente não bateu com nada" — e zerava o widget relacionado
// inteiro, mesmo com a própria fonte do widget saudável. O caso de uso
// central da feature (uma planilha tipo "Bases" relacionada com várias
// fontes-fato do Data Hub) é justamente onde isso batia.
function collectWidgetSheetKeys(widget, relations = []) {
  const keys = new Set()
  if (isSheetSource(widget?.source)) keys.add(widget.source)
  for (const lk of widget?.lookups ?? []) if (isSheetSource(lk.source)) keys.add(lk.source)
  for (const rel of relations) {
    if (rel.sourceA === widget?.source && isSheetSource(rel.sourceB)) keys.add(rel.sourceB)
    if (rel.sourceB === widget?.source && isSheetSource(rel.sourceA)) keys.add(rel.sourceA)
  }
  return Array.from(keys)
}

// Injeta as rows de cada planilha referenciada num snapshot mesclado, sob a
// própria chave `sheet:<id>` — dali em diante o resto do motor (getRows/
// getSourceDef/buildLookups, tudo síncrono) não precisa saber que aquela
// fonte não vem do snapshot SQL, só lê snap.data normalmente. É a ÚNICA
// função deste módulo com I/O de rede (fetch ao vivo na API do Google,
// através de resolveSheetRows) — por isso runWidgetQuery/runFieldValues/
// listSourceDefs precisaram virar async, mas todo o resto do pipeline
// (agregação, filtros, pivot da matriz etc.) continua 100% síncrono.
async function withSheetSources(baseSnap, sheetKeys, accessToken) {
  if (sheetKeys.length === 0) return baseSnap
  const data = { ...(baseSnap?.data ?? {}) }
  for (const key of sheetKeys) {
    data[key] = await resolveSheetRows(sheetSourceId(key), { accessToken })
  }
  return { ...(baseSnap ?? {}), data }
}

// Catálogo de fontes disponíveis — uma por dataset do Data Hub já
// materializado no snapshot (ver server/lakehouseSources.mjs) e uma por
// planilha do Google cadastrada (ver server/sheetSources.mjs). Usado por
// GET /api/sources para alimentar os pickers do Builder no front
// (fonte/dimensão/medida/filtro/coluna).
// `folderId`: quando informado, só entram fontes do Data Hub liberadas para
// aquela pasta (`folderIds` null/ausente = liberada em todas — ver
// setLakehouseFolders em lakehouseSources.mjs); planilhas do Google não são
// restritas por pasta (sempre aparecem — são de quem cadastrou, não do
// admin). Sem `folderId` (compat), nenhum filtro é aplicado.
// `accessToken`: usado só pra tentar atualizar o cache de cada planilha se
// estiver expirado — falhando (sem acesso, sessão sem o escopo novo etc.),
// a planilha aparece com 0 campos em vez de derrubar a lista inteira.
// Fontes do Data Hub não precisam de nada disso: elas já vêm resolvidas no
// snapshot pelo ETL.
export async function listSourceDefs(folderId, accessToken) {
  const snap = getSnapshot()
  const data = { ...(snap?.data ?? {}) }
  const titles = new Map()
  const folderIdsById = new Map()

  // Só nomeia/filtra: as linhas já estão em `data` sob a chave `dhub:<id>`.
  // Uma fonte recém-cadastrada (ETL ainda não rodou) simplesmente não tem
  // chave no snapshot e portanto não aparece.
  for (const src of listLakehouseSources()) {
    const key = lakehouseSourceKey(src.id)
    titles.set(key, src.label)
    folderIdsById.set(key, src.folderIds ?? null)
  }

  for (const sh of listSheetSources()) {
    const key = sheetSourceKey(sh.id)
    try { data[key] = await resolveSheetRows(sh.id, { accessToken }) }
    catch { data[key] = [] }
    titles.set(key, sh.label)
  }

  // Anota cada campo com a descrição e o tipo de dado escritos no dicionário
  // (admin, Configurações) — ausentes pra maioria dos campos, já que são
  // preenchidos à mão só onde faz sentido. Um `dataType` presente SOBRESCREVE
  // o `kind` inferido sozinho pela amostra (ex. campo de data num formato
  // que a inferência não reconhece, ou código numérico que deve ser tratado
  // como texto/dimensão) — `kindAuto` guarda o valor original inferido, pra
  // a tela do dicionário poder mostrar os dois lado a lado.
  const dict = fieldDictionaryMap()
  return Object.entries(data)
    .filter(([id]) => {
      if (!folderId) return true
      if (isSheetSource(id)) return true
      const allowed = folderIdsById.get(id)
      return allowed == null || allowed.includes(folderId)
    })
    .map(([id, rows]) => {
      const def = inferSourceDef(id, rows ?? [], titles.get(id))
      def.fields = def.fields.map((f) => {
        const entry = dict.get(`${id}::${f.key}`)
        if (!entry) return f
        const next = entry.description ? { ...f, description: entry.description } : { ...f }
        if (entry.dataType && DATA_TYPE_KIND[entry.dataType]) {
          next.kindAuto = f.kind
          next.dataType = entry.dataType
          next.kind = DATA_TYPE_KIND[entry.dataType]
        }
        return next
      })
      return def
    })
}

function assertField(sourceDef, field) {
  if (!sourceDef.fields.some((f) => f.key === field)) {
    throw new Error(`Campo desconhecido para ${sourceDef.key}: ${field}`)
  }
}

// Aplica filtros de aba (multiselect/daterange) + filtros fixos do widget.
function applyFilters(rows, tabFilters = [], widgetFilters = []) {
  let out = rows
  for (const { filter, values } of tabFilters) {
    if (!values || values.length === 0) continue
    if (filter.type === 'daterange') {
      const [from, to] = values
      const fromT = from ? new Date(from).getTime() : -Infinity
      // Fim inclusivo: até o último instante do dia final.
      const toT = to ? new Date(to).getTime() + 86_399_999 : Infinity
      out = out.filter((r) => {
        const v = r[filter.field]
        if (!v) return false
        const t = new Date(v).getTime()
        return !isNaN(t) && t >= fromT && t <= toT
      })
    } else {
      const set = new Set(values)
      out = out.filter((r) => set.has(String(r[filter.field] ?? '')))
    }
  }
  for (const wf of widgetFilters) {
    const set = new Set(wf.values)
    if (wf.op === 'in') out = out.filter((r) => set.has(String(r[wf.field] ?? '')))
    else out = out.filter((r) => !set.has(String(r[wf.field] ?? '')))
  }
  return out
}

// "Hierarquia de datas" (estilo Power BI) — 4 buckets de data disponíveis:
// 'year' | 'quarter' | 'month' | 'day'. Cada um é CUMULATIVO (inclui o ano
// na própria chave) igual ao 'day'/'month' originais — importante pra não
// mudar o comportamento de widgets JÁ salvos com 'month:'/'day:', e pra
// qualquer um dos 4 continuar correto e sem ambiguidade quando usado
// SOZINHO (sem os níveis "pais" da hierarquia), mesmo numa série cobrindo
// vários anos. BUCKET_RANK é a ordem natural da hierarquia (ano é o nível
// mais "de fora"), usada só pra reordenar níveis quando o usuário marca as
// caixinhas fora de ordem no editor (ver toggleHierarchyLevel no cliente) —
// o motor de agregação em si não presume ordem nenhuma no array.
const BUCKET_RE = /^(year|quarter|month|day):(.+)$/
const BUCKET_RANK = { year: 0, quarter: 1, month: 2, day: 3 }
const MONTH_NAMES_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

// Dimensão: campo puro, ou bucket de data 'year:campo'|'quarter:campo'|
// 'month:campo'|'day:campo'. `prettyOf` é uma versão SÓ do próprio nível
// (sem o ano embutido) — só usada quando 2+ buckets do MESMO campo compõem
// uma hierarquia de verdade (ver compositeDimensionFn) — nesse caso o nível
// "Ano" já aparece como coluna irmã, então repetir o ano dentro de
// "Trimestre"/"Mês"/"Dia" seria redundante. Um bucket usado SOZINHO nunca
// passa por `prettyOf` — mantém a chave cumulativa como rótulo, exatamente
// o comportamento de sempre (não regride widget já salvo com month:/day:).
function dimensionKeyFn(dimension) {
  const m = BUCKET_RE.exec(dimension)
  if (!m) return { field: dimension, bucket: null, keyOf: (r) => (r[dimension] == null ? null : String(r[dimension])), prettyOf: (k) => k }
  const [, bucket, field] = m
  // Extrai ano/mês/dia por regex (não por posição fixa) e sempre zero-
  // preenche mês/dia — robusto mesmo se a string não vier em ISO
  // estritamente 'AAAA-MM-DD' (ex. campo marcado como 'date' manualmente
  // no dicionário de campos sobre uma data 'AAAA-M-D' sem zero à esquerda).
  const parseDate = (v) => {
    const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v))
    if (!dm) return null
    return { y: dm[1], mo: dm[2].padStart(2, '0'), d: dm[3].padStart(2, '0') }
  }
  const keyOf = (r) => {
    const v = r[field]
    if (!v) return null
    const p = parseDate(v)
    if (!p) return null
    if (bucket === 'year') return p.y
    if (bucket === 'quarter') return `${p.y}-Q${Math.ceil(Number(p.mo) / 3)}`
    return bucket === 'day' ? `${p.y}-${p.mo}-${p.d}` : `${p.y}-${p.mo}`
  }
  const prettyOf = (key) => {
    if (bucket === 'year') return key
    if (bucket === 'quarter') return `${key.slice(-1)}º Trim`
    if (bucket === 'month') return MONTH_NAMES_PT[Number(key.slice(5, 7)) - 1] ?? key
    return key.slice(8, 10) // day: só o dia do mês
  }
  return { field, bucket, keyOf, prettyOf }
}

// Eixo X com 1+ campos (estilo Power BI): compõe as chaves de cada campo num
// único rótulo "A / B / C". Se qualquer campo vier vazio na linha, a linha é
// descartada do agrupamento (mesmo comportamento de 1 campo só).
//
// isDateDim (pra ordenação/recorte cronológico automático) vale em dois
// casos: (1) exatamente 1 campo, sendo qualquer um dos 4 buckets de data —
// com múltiplos campos NÃO relacionados não há ordem "natural" nenhuma; (2)
// 2+ campos que são TODOS buckets do MESMO campo-base — uma Hierarquia de
// datas de verdade (ex. ['year:x','month:x','day:x']) — mistura de anos,
// trimestres, meses e dias do mesmo campo continua tendo uma ordem
// cronológica única, só que composta.
//
// `labelOf` só reformata o rótulo (nunca a chave de agrupamento/ordenação,
// que continua sempre a cumulativa de sempre) — e só entra em ação no caso
// (2) acima: uma hierarquia de verdade. Nela, se 'year:' também estiver
// presente entre os campos, os demais níveis mostram só o PRÓPRIO
// incremento (sem repetir o ano, que já é coluna irmã); sem 'year:', cada
// nível mantém a chave cumulativa (com ano embutido) — evita rótulo
// ambíguo numa hierarquia Trimestre+Mês sem Ano cobrindo vários anos.
function compositeDimensionFn(dimensions) {
  const parts = dimensions.map(dimensionKeyFn)
  const bucketFields = parts.filter((p) => p.bucket)
  const isHierarchy = dimensions.length > 1 && bucketFields.length === parts.length
    && new Set(bucketFields.map((p) => p.field)).size === 1
  const hasYearSibling = isHierarchy && parts.some((p) => p.bucket === 'year')
  return {
    fields: parts.map((p) => p.field),
    isDateDim: (dimensions.length === 1 && !!parts[0].bucket) || isHierarchy,
    keyOf: (r) => {
      const vals = parts.map((p) => p.keyOf(r))
      if (vals.some((v) => v == null || v === '')) return null
      return vals.join(' / ')
    },
    labelOf: !isHierarchy ? (label) => label : (label) => {
      const rawVals = label.split(' / ')
      return rawVals.map((v, i) => (hasYearSibling && parts[i].bucket !== 'year' ? parts[i].prettyOf(v) : v)).join(' / ')
    },
  }
}

// Mesclagem de campos de outra fonte (widget.lookups) por chave — usável em
// qualquer papel (Eixo X, Eixo Y, Legenda, filtro, coluna de tabela), não só
// em tabelas: casa "chave aqui" (localKey, na fonte principal) com "chave na
// fonte" (foreignKey, na fonte relacionada) e expõe o campo trazido como
// `${source}.${field}` em cada linha, como se fosse um campo nativo.
function buildLookups(widget, sourceDef, snap) {
  return (widget.lookups ?? []).map((lk) => {
    const lkSourceDef = getSourceDef(lk.source, snap)
    if (!lkSourceDef) throw new Error(`Fonte desconhecida no lookup: ${lk.source}`)
    assertField(sourceDef, lk.localKey)
    assertField(lkSourceDef, lk.foreignKey)
    assertField(lkSourceDef, lk.field)
    const index = new Map()
    for (const r of getRows(snap, lk.source) ?? []) {
      const key = r[lk.foreignKey]
      if (key == null) continue
      const k = String(key)
      if (!index.has(k)) index.set(k, r) // primeira ocorrência quando a chave se repete
    }
    return { ...lk, outKey: `${lk.source}.${lk.field}`, index }
  })
}

function mergeLookups(rows, lookups) {
  if (!lookups.length) return rows
  return rows.map((r) => {
    const o = { ...r }
    for (const lk of lookups) {
      const key = r[lk.localKey]
      const match = key == null ? undefined : lk.index.get(String(key))
      o[lk.outKey] = match ? match[lk.field] ?? null : null
    }
    return o
  })
}

// Valida um campo aceitando tanto campos nativos da fonte principal quanto
// campos mesclados via lookup (`${source}.${field}`).
function assertFieldOrLookup(sourceDef, lookups, field) {
  if (lookups.some((lk) => lk.outKey === field)) return
  assertField(sourceDef, field)
}

// Propaga um filtro de aba entre fontes DIFERENTES, via TabRelation (ver
// types.ts) — o mecanismo que faz "filtrar uma tabela filtra as
// relacionadas", pedido pelo usuário (2 a 10+ fontes relacionadas num
// dashboard, uma delas podendo se relacionar com várias outras ao mesmo
// tempo — ex. BASES recebendo relação de Saldo Voalle, Consumo Produtos,
// Requisições Almox etc.). Simétrica: procura uma `rel` em qualquer ordem
// (sourceA/sourceB) que ligue a fonte do FILTRO à fonte do WIDGET.
//
// Faz um SEMI-JOIN de verdade, não reaplica o texto do filtro cru: filtra a
// fonte do filtro pelos valores escolhidos (mesmo `applyFilters` de sempre,
// então funciona pra multiselect E daterange), e extrai o conjunto de
// chaves REAIS (`filterKeyField`) das linhas que sobraram — evita o risco
// de "Base SP" estar grafado diferente em cada sistema de origem, já que a
// comparação final é por CHAVE (o campo da relação), não pelo valor exibido
// no filtro. Sem relação encontrada pra aquele par de fontes: `undefined`
// — o filtro simplesmente não alcança o widget, mesmo silêncio de sempre
// quando um filtro de aba não bate com a fonte do widget. Não encadeia
// (fato → dimensão → outro fato): só relações DIRETAS entre as duas fontes.
function resolveIndirectFilter(tf, widgetSourceDef, relations, snap) {
  if (!tf.values?.length) return undefined
  for (const rel of relations) {
    let filterKeyField, widgetKeyField
    if (rel.sourceA === tf.filter.source && rel.sourceB === widgetSourceDef.key) {
      filterKeyField = rel.fieldA; widgetKeyField = rel.fieldB
    } else if (rel.sourceB === tf.filter.source && rel.sourceA === widgetSourceDef.key) {
      filterKeyField = rel.fieldB; widgetKeyField = rel.fieldA
    } else continue
    if (!widgetSourceDef.fields.some((f) => f.key === widgetKeyField)) continue // relação mal configurada — ignora em vez de derrubar o widget
    // A fonte do FILTRO pode estar ausente do snapshot agora (ciclo do ETL
    // falhou, planilha desregistrada etc.) — `getRows` devolve `null` nesse
    // caso, DIFERENTE de "a fonte existe mas o filtro bateu em zero linhas".
    // Sem distinguir os dois, um `?? []` colapsava ambos no mesmo array
    // vazio — e um conjunto de chaves vazio ainda é um filtro "está em []"
    // válido pro applyFilters, que zerava TODAS as linhas do widget
    // relacionado mesmo com a fonte do PRÓPRIO widget saudável (o bug real
    // que motivou este comentário). Fonte ausente: `undefined` (o filtro
    // não alcança o widget agora, mesmo silêncio de sempre). Fonte presente
    // com zero linhas batendo: segue normal, filtro "está em []" mesmo —
    // esse zerar é o comportamento CORRETO de um semi-join.
    const sourceRows = getRows(snap, tf.filter.source)
    if (!Array.isArray(sourceRows)) return undefined
    const relatedRows = applyFilters(sourceRows, [tf], [])
    const keySet = new Set()
    for (const r of relatedRows) {
      const v = r[filterKeyField]
      if (v != null) keySet.add(String(v))
    }
    return { field: widgetKeyField, values: [...keySet] }
  }
  return undefined
}

function makeAggregator(measure, pkField) {
  const agg = measure?.agg ?? 'countDistinct'
  if (agg === 'countDistinct') {
    const keyField = measure?.field ?? pkField
    return {
      init: () => new Set(),
      add: (acc, r) => { const v = keyField ? r[keyField] : JSON.stringify(r); if (v != null) acc.add(String(v)) },
      value: (acc) => acc.size,
    }
  }
  if (agg === 'count') {
    // Sem campo: conta todas as linhas. Com campo: conta só as ocorrências
    // não-nulas/não-vazias daquele campo (Contagem de X, estilo Power BI).
    const field = measure?.field
    return field
      ? { init: () => ({ n: 0 }), add: (acc, r) => { const v = r[field]; if (v != null && v !== '') acc.n++ }, value: (acc) => acc.n }
      : { init: () => ({ n: 0 }), add: (acc) => { acc.n++ }, value: (acc) => acc.n }
  }
  // sum / avg exigem campo numérico
  const field = measure.field
  if (!field) throw new Error(`Agregação ${agg} exige um campo numérico.`)
  if (agg === 'sum') {
    return { init: () => ({ s: 0 }), add: (acc, r) => { const v = Number(r[field]); if (!isNaN(v)) acc.s += v }, value: (acc) => acc.s }
  }
  return {
    init: () => ({ s: 0, n: 0 }),
    add: (acc, r) => { const v = Number(r[field]); if (!isNaN(v)) { acc.s += v; acc.n++ } },
    value: (acc) => (acc.n > 0 ? acc.s / acc.n : 0),
  }
}

// Tabela Matriz (pivot) — estilo Power BI: 1+ campos em "Linhas" (hierarquia
// aninhada com subtotal em cada nível), 0+ campos em "Colunas" (cada
// combinação distinta de valores vira uma coluna dinâmica) e 1 medida em
// "Valores" (uma célula por linha × coluna). Sem "Colunas" configurado, cai
// numa única coluna (`value`) — vira uma tabela agrupada simples com
// subtotais, útil mesmo sem quebra por coluna.
function buildMatrix(rows, matrixRowFields, matrixColumnFields, measure, pkField) {
  if (!matrixRowFields.length) return { columns: [], rows: [], grandTotal: {}, grandTotalAll: 0 }

  const rowKeyFns = matrixRowFields.map(dimensionKeyFn)
  const colFn = matrixColumnFields.length ? compositeDimensionFn(matrixColumnFields) : null
  const aggregator = makeAggregator(measure, pkField)
  const SINGLE_COL = 'value'
  const SEP = ''

  // levels[depth] = Map<prefixKey, { labelParts, perCol: Map<colKey,acc>, rowAcc }>
  const levels = rowKeyFns.map(() => new Map())
  const grandPerCol = new Map() // colKey -> acc (total geral por coluna, pra ranquear/capar colunas)
  let grandAcc = aggregator.init()

  for (const r of rows) {
    const rowVals = rowKeyFns.map((fn) => fn.keyOf(r))
    if (rowVals.some((v) => v == null || v === '')) continue
    const colKey = colFn ? colFn.keyOf(r) : SINGLE_COL
    if (colKey == null || colKey === '') continue

    aggregator.add(grandAcc, r)
    let gAcc = grandPerCol.get(colKey)
    if (!gAcc) { gAcc = aggregator.init(); grandPerCol.set(colKey, gAcc) }
    aggregator.add(gAcc, r)

    for (let depth = 0; depth < rowKeyFns.length; depth++) {
      const prefixKey = rowVals.slice(0, depth + 1).join(SEP)
      let node = levels[depth].get(prefixKey)
      if (!node) {
        node = { labelParts: rowVals.slice(0, depth + 1), perCol: new Map(), rowAcc: aggregator.init() }
        levels[depth].set(prefixKey, node)
      }
      aggregator.add(node.rowAcc, r)
      let cAcc = node.perCol.get(colKey)
      if (!cAcc) { cAcc = aggregator.init(); node.perCol.set(colKey, cAcc) }
      aggregator.add(cAcc, r)
    }
  }

  // Colunas dinâmicas: rankeadas pelo total geral, capadas em MAX_MATRIX_COLUMNS
  // (evita explosão quando o campo de coluna tem cardinalidade alta).
  const columnKeys = colFn
    ? Array.from(grandPerCol.keys())
      .sort((a, b) => aggregator.value(grandPerCol.get(b)) - aggregator.value(grandPerCol.get(a)))
      .slice(0, MAX_MATRIX_COLUMNS)
    : [SINGLE_COL]

  const nodeValues = (node) => {
    const values = {}
    for (const ck of columnKeys) {
      const acc = node.perCol.get(ck)
      values[ck] = acc ? aggregator.value(acc) : 0
    }
    return values
  }

  // Monta a árvore: nível 0 é a raiz; cada nível seguinte aninha sob o
  // prefixo (chave completa) do nó-pai no nível anterior. Ordena por rótulo
  // (alfabética) — igual ao comportamento padrão de uma matriz do Power BI.
  function buildLevel(depth, parentPrefix) {
    const entries = Array.from(levels[depth].entries())
      .filter(([key]) => depth === 0 || key.startsWith(parentPrefix + SEP))
      .sort((a, b) => a[1].labelParts[depth].localeCompare(b[1].labelParts[depth], 'pt-BR'))
      .slice(0, MAX_MATRIX_ROWS)
    return entries.map(([key, node]) => {
      // Ordena pela chave CRUA (zero-padded, cronológica pra bucket de data)
      // mas EXIBE a versão bonita (Ano/Trimestre por extenso/nome do mês/dia
      // do mês) — cada nível já é sua própria linha/sub-linha na árvore, sem
      // o risco de string composta ambígua que o rótulo de gráfico tem (ver
      // compositeDimensionFn), então prettifica sempre, incondicionalmente.
      const label = rowKeyFns[depth].prettyOf(node.labelParts[depth])
      const result = { key, label, level: depth, values: nodeValues(node), total: aggregator.value(node.rowAcc) }
      if (depth + 1 < rowKeyFns.length) {
        const children = buildLevel(depth + 1, key)
        if (children.length) result.children = children
      }
      return result
    })
  }

  const grandTotal = {}
  for (const ck of columnKeys) grandTotal[ck] = grandPerCol.has(ck) ? aggregator.value(grandPerCol.get(ck)) : 0

  return {
    columns: colFn ? columnKeys.map((k) => ({ key: k, label: colFn.labelOf(k) })) : [{ key: SINGLE_COL, label: defaultMeasureLabel(measure) }],
    rows: buildLevel(0, ''),
    grandTotal,
    grandTotalAll: aggregator.value(grandAcc),
  }
}

export async function runWidgetQuery({ widget, tabFilters = [], relations = [], page = 1, pageSize = 50, accessToken }) {
  const snap = await withSheetSources(getSnapshot(), collectWidgetSheetKeys(widget, relations), accessToken)
  if (!snap) return null
  if (!widget?.source) throw new Error('Widget sem fonte de dados (source).')
  const sourceDef = getSourceDef(widget.source, snap)
  if (!sourceDef) throw new Error(`Fonte desconhecida: ${widget.source}`)

  // Uma ou mais medidas (widget.measures = séries múltiplas; widget.measure = legado/single).
  const measuresIn = widget.measures?.length ? widget.measures : [widget.measure ?? { agg: 'countDistinct' }]
  // legendKeyFn preserva bucket/keyOf — legendField (só o campo-base) segue
  // existindo à parte pra validação de campo (assertFieldOrLookup).
  const legendKeyFn = widget.legendDimension ? dimensionKeyFn(widget.legendDimension) : null
  const legendField = legendKeyFn ? legendKeyFn.field : null
  const lookups = buildLookups(widget, sourceDef, snap)

  // Valida campos referenciados contra o catálogo (dimensão, legenda, medidas,
  // filtros) — aceita tanto campo nativo da fonte principal quanto campo
  // mesclado via lookup de outra fonte (widget.lookups), em qualquer papel.
  for (const d of widget.dimensions ?? []) assertFieldOrLookup(sourceDef, lookups, dimensionKeyFn(d).field)
  if (legendField) assertFieldOrLookup(sourceDef, lookups, legendField)
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

  const relevantTabFilters = tabFilters.filter((tf) => tf.filter.source === widget.source)
  // Filtros de aba de OUTRA fonte, propagados via relação da aba (ver
  // TabRelation/resolveIndirectFilter) — semi-join real contra a chave,
  // devolvido como um filtro "in" comum, no mesmo formato de widgetFilters.
  const indirectFilters = []
  for (const tf of tabFilters) {
    if (tf.filter.source === widget.source) continue
    const resolved = resolveIndirectFilter(tf, sourceDef, relations, snap)
    if (resolved) indirectFilters.push({ field: resolved.field, op: 'in', values: resolved.values })
  }
  const filteredRows = applyFilters(getRows(snap, widget.source) ?? [], relevantTabFilters, [...(widget.widgetFilters ?? []), ...indirectFilters])
  // Mescla os campos de widget.lookups em cada linha (${source}.${field}),
  // disponíveis a partir daqui como se fossem campos nativos.
  const rows = mergeLookups(filteredRows, lookups)

  // Tabela: SEMPRE combinações DISTINTAS das colunas escolhidas — não linha
  // crua. Com 1 coluna, já é o mesmo espírito de uma "Linha" da Matriz
  // (valores únicos); cada coluna a mais amplia a granularidade (o produto
  // dos valores distintos de cada uma, só que limitado às combinações que
  // realmente existem nos dados — nunca inventa uma combinação que não
  // ocorre). Chega a listar tudo cru sozinho se as colunas escolhidas, juntas,
  // já identificam cada registro (ex. um id único entre elas). Decisão
  // deliberada (a pedido do usuário): sem toggle — todo widget de tabela,
  // novo ou já salvo, passa a se comportar assim.
  if (widget.type === 'table') {
    const cols = widget.columns?.length ? widget.columns : sourceDef.fields.map((f) => f.key)
    // Coluna com prefixo de bucket ('year:'/'quarter:'/'month:'/'day:', ver
    // Hierarquia de datas) valida contra o campo-base, não a chave literal
    // (que não existe em nenhuma linha crua).
    for (const c of cols) assertFieldOrLookup(sourceDef, lookups, BUCKET_RE.test(c) ? dimensionKeyFn(c).field : c)

    // Chave de dedup é só `cols` (o que aparece na tela) — os outKeys de
    // lookup abaixo continuam sendo carregados na linha projetada mesmo
    // quando não estão em `cols` (mesmo comportamento de sempre), mas não
    // participam da chave: senão duas linhas visualmente idênticas nas
    // colunas mostradas poderiam aparecer separadas por causa de um valor
    // que não está nem sendo exibido. Primeira ocorrência vence quando a
    // combinação se repete (mesmo padrão já usado no índice de lookup).
    const seen = new Map()
    for (const r of rows) {
      const projected = {}
      const sortVals = {}
      for (const c of cols) {
        // Coluna de bucket: computa o valor (não existe como chave literal
        // na linha crua) e SEMPRE mostra a forma "bonita" (Ano/Trimestre
        // por extenso/nome do mês/dia do mês) — diferente do rótulo de
        // gráfico (ver compositeDimensionFn), aqui não tem ambiguidade de
        // "esconder o ano redundante": cada bucket é a PRÓPRIA coluna,
        // separada de qualquer coluna-irmã de Ano que exista ao lado. Mas
        // dedup/ordenação usam a chave CRUA (cumulativa, com ano embutido),
        // NUNCA a "bonita" — senão datas de anos diferentes com o mesmo
        // trimestre/mês/dia colidiriam e uma sumiria silenciosamente da
        // tabela, e 'month:' ordenaria pelo NOME do mês (alfabético, não
        // cronológico).
        if (BUCKET_RE.test(c)) {
          const dimFn = dimensionKeyFn(c)
          const raw = dimFn.keyOf(r)
          projected[c] = raw == null ? null : dimFn.prettyOf(raw)
          sortVals[c] = raw
        } else {
          projected[c] = r[c] ?? null
          sortVals[c] = projected[c]
        }
      }
      for (const lk of lookups) projected[lk.outKey] = r[lk.outKey] ?? null
      const key = JSON.stringify(cols.map((c) => sortVals[c]))
      if (!seen.has(key)) seen.set(key, { projected, sortVals })
    }
    // Ordenado (não na ordem de chegada dos dados crus) — mesmo critério
    // alfabético (pt-BR) já usado pras linhas da Matriz, pra uma lista de
    // valores distintos ficar previsível em vez de espelhar a ordem
    // arbitrária do dataset de origem. Compara coluna por coluna (não um
    // texto único concatenado) — sem separador nenhum, então sem risco de
    // colisão entre valores de colunas vizinhas.
    const distinctRows = Array.from(seen.values())
      .sort((a, b) => {
        for (const c of cols) {
          const cmp = String(a.sortVals[c] ?? '').localeCompare(String(b.sortVals[c] ?? ''), 'pt-BR')
          if (cmp !== 0) return cmp
        }
        return 0
      })
      .map((e) => e.projected)

    const total = distinctRows.length
    const startIdx = (page - 1) * pageSize
    const pageRows = distinctRows.slice(startIdx, startIdx + pageSize)
    return { rows: pageRows, total, page, pageSize }
  }

  const pkField = sourceDef.fields.find((f) => f.pk)?.key ?? null

  // Matriz: estrutura própria (linhas hierárquicas × colunas dinâmicas),
  // nada a ver com o pipeline de pontos/séries usado pelos gráficos abaixo.
  if (widget.type === 'matrix') {
    const matrix = buildMatrix(rows, widget.matrixRows ?? [], widget.matrixColumns ?? [], widget.matrixValue ?? { agg: 'countDistinct' }, pkField)
    return { matrix }
  }

  // Dispersão: 1 ponto por valor de dimensão, com X (measureX) e Y (measure)
  // agregados independentemente sobre as mesmas linhas do grupo.
  if (widget.type === 'scatter') {
    if (!widget.dimensions?.length) return { points: [] }
    const { keyOf: scatterKeyOf, labelOf: scatterLabelOf } = compositeDimensionFn(widget.dimensions)
    const xAgg = makeAggregator(widget.measureX ?? { agg: 'countDistinct' }, pkField)
    const yAgg = makeAggregator(measuresIn[0], pkField)
    const groups = new Map()
    for (const r of rows) {
      const key = scatterKeyOf(r)
      if (key == null || key === '') continue
      let g = groups.get(key)
      if (!g) { g = { x: xAgg.init(), y: yAgg.init() }; groups.set(key, g) }
      xAgg.add(g.x, r); yAgg.add(g.y, r)
    }
    const scatterLimit = Math.min(widget.limit ?? 15, MAX_POINTS)
    const points = Array.from(groups.entries())
      .map(([label, g]) => ({ label: scatterLabelOf(label), value: yAgg.value(g.y), x: xAgg.value(g.x) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, scatterLimit)
    return { points }
  }

  // Histograma: divide os valores de UM campo numérico em faixas (bins) de
  // largura igual e conta quantos registros caem em cada uma — a barra é a
  // frequência, a linha é uma curva normal (gaussiana) ajustada à média e ao
  // desvio-padrão reais dos dados, na MESMA escala das barras (estilo do
  // histograma padrão do Excel/Power BI, "distribuição normalizada").
  // Não usa widget.dimensions (agrupa por FAIXA de valor, não por categoria),
  // por isso precisa ficar antes do bloco "sem dimensão" abaixo.
  if (widget.type === 'histogram') {
    const field = widget.histogramField
    if (!field) return { points: [] }
    const bins = Math.max(2, Math.min(50, widget.histogramBins ?? 10))
    const values = rows.map((r) => Number(r[field])).filter((v) => Number.isFinite(v))
    if (values.length === 0) return { points: [] }
    const min = Math.min(...values)
    const max = Math.max(...values)
    const width = (max - min) / bins || 1 // todos os valores iguais — cai tudo na 1ª faixa
    const counts = new Array(bins).fill(0)
    for (const v of values) {
      const idx = Math.min(bins - 1, Math.floor((v - min) / width))
      counts[idx]++
    }
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
    const stddev = Math.sqrt(variance)
    // Densidade normal no ponto central de cada faixa, escalada para a mesma
    // unidade da barra (contagem esperada na faixa se os dados fossem
    // perfeitamente normais): pdf(x) * N * largura_da_faixa.
    const gaussianAt = (mid) => {
      if (!(stddev > 0)) return null
      const pdf = Math.exp(-0.5 * ((mid - mean) / stddev) ** 2) / (stddev * Math.sqrt(2 * Math.PI))
      return pdf * values.length * width
    }
    const fmtEdge = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 1 })
    const points = counts.map((count, i) => {
      const from = min + i * width
      const to = i === bins - 1 ? max : from + width
      const mid = (from + to) / 2
      const gaussian = gaussianAt(mid)
      return { label: `${fmtEdge(from)}–${fmtEdge(to)}`, value: count, l0: gaussian === null ? null : Math.round(gaussian * 10) / 10 }
    })
    const seriesKeys = [
      { key: 'value', label: 'Frequência', role: 'bar' },
      { key: 'l0', label: 'Distribuição normal', role: 'line' },
    ]
    return { points, seriesKeys }
  }

  // Sem dimensão (KPI/pie sem quebra): agregado único sobre as linhas filtradas,
  // sempre com a 1ª medida (múltiplas medidas só fazem sentido com dimensão).
  if (!widget.dimensions?.length) {
    const aggregator = makeAggregator(measuresIn[0], pkField)
    const acc = aggregator.init()
    for (const r of rows) aggregator.add(acc, r)
    return { points: [{ label: 'total', value: aggregator.value(acc) }] }
  }

  const { keyOf, isDateDim, labelOf } = compositeDimensionFn(widget.dimensions)
  const limit = Math.min(widget.limit ?? 15, MAX_POINTS)

  // Quebra por legenda (2ª dimensão): uma série por valor distinto da legenda,
  // sempre com a 1ª medida (evita explosão legenda × múltiplas medidas).
  if (legendField) {
    const aggregator = makeAggregator(measuresIn[0], pkField)
    const primaryGroups = new Map() // primaryKey -> Map(legendKey -> acc)
    const legendTotals = new Map()  // legendKey -> acc (para ranquear os top N globalmente)
    for (const r of rows) {
      const pKey = keyOf(r)
      if (pKey == null || pKey === '') continue
      // keyOf (não o valor cru da célula) — respeita o bucket de data se
      // a legenda for 'year:'/'quarter:'/'month:'/'day:<campo>'; senão a
      // quebra por legenda ignorava o bucket e agrupava pelo valor exato da
      // célula (ex. timestamp completo em vez do mês).
      const lVal = legendKeyFn.keyOf(r)
      if (lVal == null || lVal === '') continue
      const lKey = String(lVal)

      let legendMap = primaryGroups.get(pKey)
      if (!legendMap) { legendMap = new Map(); primaryGroups.set(pKey, legendMap) }
      let acc = legendMap.get(lKey)
      if (!acc) { acc = aggregator.init(); legendMap.set(lKey, acc) }
      aggregator.add(acc, r)

      let tAcc = legendTotals.get(lKey)
      if (!tAcc) { tAcc = aggregator.init(); legendTotals.set(lKey, tAcc) }
      aggregator.add(tAcc, r)
    }
    // Top N valores de legenda por total agregado — evita explosão de séries
    // no gráfico; valores fora do top N são descartados (não somados a "outros").
    const topLegendKeys = Array.from(legendTotals.entries())
      .map(([k, acc]) => [k, aggregator.value(acc)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LEGEND_SERIES)
      .map(([k]) => k)

    let points = Array.from(primaryGroups.entries()).map(([label, legendMap]) => {
      const point = { label, value: 0 }
      for (const lKey of topLegendKeys) {
        const v = legendMap.has(lKey) ? aggregator.value(legendMap.get(lKey)) : 0
        point[lKey] = v
        point.value += v
      }
      return point
    })
    points = sortAndLimitPoints(points, widget.sort, isDateDim, limit)
    // Reformata o RÓTULO só depois de ordenar/recortar — a ordenação usa a
    // chave cumulativa de sempre (ver compositeDimensionFn); só o texto
    // exibido muda numa Hierarquia de datas de verdade (sem efeito nos
    // demais casos, `labelOf` é a identidade).
    points = points.map((p) => ({ ...p, label: labelOf(p.label) }))
    return { points, seriesKeys: topLegendKeys.map((k) => ({ key: k, label: k })) }
  }

  // Sem legenda: cada medida é sua própria série (widget.measures) ou há só uma
  // (legado). Em comboBarLine, measuresLine[] soma séries de LINHA (eixo Y
  // secundário) às séries de coluna acima — mesmo agrupamento, medidas
  // independentes; `role` no seriesKey diz ao front qual elemento renderizar.
  const measuresLineIn = widget.type === 'comboBarLine' ? (widget.measuresLine ?? []) : []
  const aggregators = measuresIn.map((m) => makeAggregator(m, pkField))
  const lineAggregators = measuresLineIn.map((m) => makeAggregator(m, pkField))
  const groups = new Map() // primaryKey -> { bar: acc[], line: acc[] }
  for (const r of rows) {
    const key = keyOf(r)
    if (key == null || key === '') continue
    let g = groups.get(key)
    if (!g) { g = { bar: aggregators.map((a) => a.init()), line: lineAggregators.map((a) => a.init()) }; groups.set(key, g) }
    aggregators.forEach((a, i) => a.add(g.bar[i], r))
    lineAggregators.forEach((a, i) => a.add(g.line[i], r))
  }
  const multi = measuresIn.length > 1
  let points = Array.from(groups.entries()).map(([label, g]) => {
    const barValues = aggregators.map((a, i) => a.value(g.bar[i]))
    const lineValues = lineAggregators.map((a, i) => a.value(g.line[i]))
    const point = { label, value: barValues[0] }
    if (multi) measuresIn.forEach((m, i) => { point[`s${i}`] = barValues[i] })
    lineAggregators.forEach((a, i) => { point[`l${i}`] = lineValues[i] })
    return point
  })
  points = sortAndLimitPoints(points, widget.sort, isDateDim, limit)
  // Ver comentário equivalente no bloco de legenda acima.
  points = points.map((p) => ({ ...p, label: labelOf(p.label) }))
  // Sempre gera o(s) seriesKey(s) do lado das colunas — mesmo com 1 medida só
  // (usa a chave 'value', que já é onde o valor mora no ponto) — senão o
  // rótulo/cor customizados na pílula do Eixo Y ficam sem efeito (só
  // apareciam quando havia 2+ medidas, já que só aí o front olha seriesKeys).
  const seriesKeys = multi
    ? measuresIn.map((m, i) => ({ key: `s${i}`, label: m.label ?? defaultMeasureLabel(m), color: m.color, role: 'bar', dataLabels: m.dataLabels }))
    : [{ key: 'value', label: measuresIn[0].label ?? defaultMeasureLabel(measuresIn[0]), color: measuresIn[0].color, role: 'bar', dataLabels: measuresIn[0].dataLabels }]
  measuresLineIn.forEach((m, i) => seriesKeys.push({ key: `l${i}`, label: m.label ?? defaultMeasureLabel(m), color: m.color, role: 'line', dataLabels: m.dataLabels }))
  return { points, seriesKeys }
}

export async function runFieldValues({ source, field, accessToken }) {
  const snap = await withSheetSources(getSnapshot(), isSheetSource(source) ? [source] : [], accessToken)
  if (!snap) return null
  const sourceDef = getSourceDef(source, snap)
  if (!sourceDef) throw new Error(`Fonte desconhecida: ${source}`)
  assertField(sourceDef, field)
  const seen = new Set()
  for (const r of getRows(snap, source) ?? []) {
    const v = r[field]
    if (v == null || v === '') continue
    seen.add(String(v))
    if (seen.size >= MAX_FIELD_VALUES) break
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b, 'pt-BR'))
}
