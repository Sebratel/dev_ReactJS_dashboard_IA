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
import { parseExpression, evaluateExpression } from './measureExpr.mjs'

const MAX_POINTS = 100
const MAX_FIELD_VALUES = 500
const MAX_LEGEND_SERIES = 8
const INFER_SAMPLE_SIZE = 300
const MAX_MATRIX_ROWS = 500
const MAX_MATRIX_COLUMNS = 50
// Sentinelas de coluna pro clique-pra-ordenar da Matriz — a coluna de
// rótulo da linha e a coluna "Total" não são uma entrada real de
// `MatrixResult.columns[]` (essa só lista as colunas DINÂMICAS, vindas de
// matrixColumns). Espelham exatamente MATRIX_LABEL_SORT_KEY/
// MATRIX_TOTAL_SORT_KEY em src/features/builder/types.ts — mudar um lado
// sem o outro quebra a ordenação por essas duas colunas.
const MATRIX_LABEL_SORT_KEY = '__row_label__'
const MATRIX_TOTAL_SORT_KEY = '__row_total__'

const AGG_LABELS = { countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média' }
// `measuresById` é opcional — só disponível onde a dashboard já foi
// carregada (ver runWidgetQuery); sem ele (ou sem a medida existir mais),
// cai num rótulo genérico em vez de quebrar (m.agg/m.field ficam ausentes
// numa MeasureConfig que só tem measureRef).
function defaultMeasureLabel(m, measuresById) {
  if (m?.measureRef) return measuresById?.get(m.measureRef)?.name ?? 'Medida'
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
export function getRows(snap, source) {
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
export async function withSheetSources(baseSnap, sheetKeys, accessToken) {
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

export function assertField(sourceDef, field) {
  if (!sourceDef.fields.some((f) => f.key === field)) {
    throw new Error(`Campo desconhecido para ${sourceDef.key}: ${field}`)
  }
}

// Aplica filtros de aba (multiselect/daterange) + filtros fixos do widget.
export function applyFilters(rows, tabFilters = [], widgetFilters = []) {
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

// ─── Janela de data relativa (medidas — ver MeasureDef/DateWindowSpec) ────
// Toda aritmética em UTC (nunca hora local do servidor): uma data crua do
// dataset ("AAAA-MM-DD") já é interpretada como meia-noite UTC por
// `new Date(str)` (é assim que `applyFilters` acima já compara), então
// calcular "hoje"/"N meses atrás" em hora local do container criaria um
// descompasso de fuso entre o motor de janela e a comparação de datas de
// sempre. `now` é injetável (parâmetro, não `new Date()` direto dentro da
// função) justamente pra poder testar com uma data fixa.
function addDaysUTC(date, delta) {
  return new Date(date.getTime() + delta * 86_400_000)
}
// Soma/subtrai mês preservando o dia quando possível, e ENCOLHE pro último
// dia do mês de destino quando ele não existe lá (31/jan − 1 mês = 31/dez,
// mas 31/mar − 1 mês = 28/fev ou 29/fev — nunca "3 de março", que é o que o
// rollover automático do JS faria sem esse clamp).
function addMonthsUTC(date, delta) {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + delta
  const targetYear = y + Math.floor(m / 12)
  const targetMonth = ((m % 12) + 12) % 12
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const day = Math.min(date.getUTCDate(), daysInTargetMonth)
  return new Date(Date.UTC(targetYear, targetMonth, day))
}
// Mesmo clamp de dia do mês de destino que addMonthsUTC, pro caso raro de
// 29/fev (ano bissexto) deslocado pra um ano que não é bissexto.
function addYearsUTC(date, years) {
  const targetYear = date.getUTCFullYear() + years
  const daysInTargetMonth = new Date(Date.UTC(targetYear, date.getUTCMonth() + 1, 0)).getUTCDate()
  const day = Math.min(date.getUTCDate(), daysInTargetMonth)
  return new Date(Date.UTC(targetYear, date.getUTCMonth(), day))
}
function toISODate(date) {
  return date.toISOString().slice(0, 10)
}

// resolveDateWindow(spec, now) → { field, from, to } (from/to sempre
// "AAAA-MM-DD", os dois INCLUSIVOS — mesmo formato que um filtro de
// intervalo de datas já usa, ver applyFilters acima). Convenção deliberada,
// a mesma pros dois: "últimos N dias/meses" é uma janela CONTÍNUA que
// termina hoje (`to` = hoje sempre), voltando N dias/meses inteiros a
// partir de hoje — não um recorte alinhado a mês/ano civil. "Este
// mês/trimestre/ano" e "ano até a data" também sempre terminam hoje (nunca
// no fim teórico do período), já que não existe dado além de hoje mesmo —
// é por isso que 'yearToDate' e 'currentYear' calculam exatamente a mesma
// coisa (mantidos como dois nomes aceitos, pela naturalidade de cada frase
// na hora de a IA escolher um).
export function resolveDateWindow(spec, now = new Date()) {
  if (!spec?.type) throw new Error('DateWindowSpec sem "type".')
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (spec.type === 'shiftYears') {
    if (!Number.isInteger(spec.years)) throw new Error('shiftYears exige "years" inteiro.')
    const base = resolveDateWindow(spec.base, now)
    return {
      field: base.field,
      from: toISODate(addYearsUTC(new Date(`${base.from}T00:00:00Z`), spec.years)),
      to: toISODate(addYearsUTC(new Date(`${base.to}T00:00:00Z`), spec.years)),
    }
  }
  if (!spec.field) throw new Error(`DateWindowSpec "${spec.type}" exige "field".`)
  if (spec.type === 'lastNDays') {
    if (!(spec.n > 0)) throw new Error('lastNDays exige "n" > 0.')
    return { field: spec.field, from: toISODate(addDaysUTC(today, -spec.n)), to: toISODate(today) }
  }
  if (spec.type === 'lastNMonths') {
    if (!(spec.n > 0)) throw new Error('lastNMonths exige "n" > 0.')
    return { field: spec.field, from: toISODate(addMonthsUTC(today, -spec.n)), to: toISODate(today) }
  }
  if (spec.type === 'yearToDate' || spec.type === 'currentYear') {
    return { field: spec.field, from: toISODate(new Date(Date.UTC(today.getUTCFullYear(), 0, 1))), to: toISODate(today) }
  }
  if (spec.type === 'currentMonth') {
    return { field: spec.field, from: toISODate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: toISODate(today) }
  }
  if (spec.type === 'currentQuarter') {
    const qStartMonth = Math.floor(today.getUTCMonth() / 3) * 3
    return { field: spec.field, from: toISODate(new Date(Date.UTC(today.getUTCFullYear(), qStartMonth, 1))), to: toISODate(today) }
  }
  throw new Error(`Tipo de janela de data desconhecido "${spec.type}".`)
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
// Extrai ano/mês/dia por regex (não por posição fixa) e sempre zero-
// preenche mês/dia — robusto mesmo se a string não vier em ISO
// estritamente 'AAAA-MM-DD' (ex. campo marcado como 'date' manualmente no
// dicionário de campos sobre uma data 'AAAA-M-D' sem zero à esquerda).
// Compartilhado entre dimensionKeyFn (buckets Ano/Trimestre/Mês/Dia) e a
// resolução de medida (janela de data relativa) — um só lugar de verdade
// pra "o que conta como uma data válida" nas linhas do dataset.
export function parseIsoDate(v) {
  const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v))
  if (!dm) return null
  return { y: dm[1], mo: dm[2].padStart(2, '0'), d: dm[3].padStart(2, '0') }
}

function dimensionKeyFn(dimension) {
  const m = BUCKET_RE.exec(dimension)
  if (!m) return { field: dimension, bucket: null, keyOf: (r) => (r[dimension] == null ? null : String(r[dimension])), prettyOf: (k) => k }
  const [, bucket, field] = m
  const keyOf = (r) => {
    const v = r[field]
    if (!v) return null
    const p = parseIsoDate(v)
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

// Mesclagem de campos de outra fonte por chave — usável em qualquer papel
// (Eixo X, Eixo Y, Legenda, filtro, coluna de tabela), não só em tabelas.
// Duas origens, combinadas numa lista só:
//
// 1) TabRelation (aba "Relacionamentos") — desde 01/09/2026, declarar um
//    relacionamento entre a fonte do widget e outra já torna TODOS os
//    campos da fonte relacionada disponíveis aqui, automaticamente (um
//    índice só por fonte relacionada, reaproveitado por todos os seus
//    campos) — sem precisar configurar campo por campo. É o mesmo
//    relacionamento que já propaga filtro entre fontes (resolveIndirectFilter);
//    agora ele também habilita "usar coluna de uma fonte junto com coluna
//    da outra" no mesmo widget.
// 2) widget.lookups (mesclagem explícita antiga, campo a campo) — mantida
//    só pra WIDGET SALVO ANTES desta mudança continuar funcionando; não há
//    mais UI pra criar um lookup novo assim (ver WidgetEditorModal.tsx). Só
//    entra aqui pra uma fonte que NÃO esteja já coberta por relação (mesmo
//    critério usado no picker do editor) — evita duas entradas divergentes
//    pro mesmo par de fontes com chaves de junção diferentes.
//
// Relação malformada (campo removido da fonte) ou fonte relacionada ausente
// do snapshot agora: ignorada silenciosamente, mesmo espírito de
// resolveIndirectFilter — nunca derruba o widget por causa disso.
function buildLookups(widget, sourceDef, relations, snap) {
  const covered = new Set()
  const out = []
  for (const rel of relations ?? []) {
    let otherSource, localKey, foreignKey
    if (rel.sourceA === widget.source) { otherSource = rel.sourceB; localKey = rel.fieldA; foreignKey = rel.fieldB }
    else if (rel.sourceB === widget.source) { otherSource = rel.sourceA; localKey = rel.fieldB; foreignKey = rel.fieldA }
    else continue
    if (covered.has(otherSource)) continue
    if (!sourceDef.fields.some((f) => f.key === localKey)) continue
    const otherSourceDef = getSourceDef(otherSource, snap)
    if (!otherSourceDef) continue
    if (!otherSourceDef.fields.some((f) => f.key === foreignKey)) continue
    covered.add(otherSource)
    const index = new Map()
    for (const r of getRows(snap, otherSource) ?? []) {
      const key = r[foreignKey]
      if (key == null) continue
      const k = String(key)
      if (!index.has(k)) index.set(k, r) // primeira ocorrência quando a chave se repete
    }
    for (const f of otherSourceDef.fields) {
      if (f.key === foreignKey) continue // a própria chave de junção não precisa virar campo mesclado
      out.push({ source: otherSource, localKey, foreignKey, field: f.key, label: f.label, outKey: `${otherSource}.${f.key}`, index })
    }
  }
  for (const lk of widget.lookups ?? []) {
    if (covered.has(lk.source)) continue
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
    out.push({ ...lk, outKey: `${lk.source}.${lk.field}`, index })
  }
  return out
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
export function resolveIndirectFilter(tf, widgetSourceDef, relations, snap) {
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

export function makeAggregator(measure, pkField) {
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

// ─── Medidas nomeadas/reutilizáveis (ver MeasureDef, DashboardConfig.measures) ───
// Uma medida 'simple' é uma agregação comum (mesmas 4 de sempre) com uma
// janela de data opcional por cima. Uma 'formula' combina outras medidas
// (por id) numa expressão aritmética segura (server/measureExpr.mjs) — nunca
// um campo cru direto, então cruzar fontes diferentes nunca precisa de JOIN
// de linha, só combina os números finais já resolvidos.
const MAX_MEASURE_DEPTH = 12

// Toda 'sheet:' fonte tocada pela árvore de refs de uma medida (recursivo) —
// mesmo espírito de collectWidgetSheetKeys, só que andando por
// MeasureDef.refs em vez de widget.lookups/relations. `visited` evita
// looping infinito numa referência circular (o erro de verdade só aparece
// depois, em resolveMeasure — aqui só não queremos travar coletando chaves).
function collectMeasureRefSheetKeys(measureId, measuresById, visited) {
  if (visited.has(measureId)) return []
  visited.add(measureId)
  const def = measuresById.get(measureId)
  if (!def) return []
  if (def.kind === 'simple') return isSheetSource(def.source) ? [def.source] : []
  const keys = []
  for (const refId of Object.values(def.refs ?? {})) keys.push(...collectMeasureRefSheetKeys(refId, measuresById, visited))
  return keys
}

// resolveMeasure(measureId, ctx) → { value: number, sourcesFiltered: Set<source> }
// `sourcesFiltered` é o conjunto de fontes cujo filtro de aba ATIVO
// realmente alcançou esta medida (direto, ou via relação declarada) — usado
// pra sinalizar "filtro parcial" quando uma fórmula cruza uma fonte pra qual
// existe filtro ativo na aba mas nenhuma relação cobre (ver runWidgetQuery).
//
// ctx = { measuresById, snap, relations, tabFilters, sourceRowsCache,
//         resolvedScalarCache, visiting }, criado uma vez por resolução de
// topo (1 por widget/preview) e passado adiante na recursão.
//
// Detecção de ciclo: `visiting` é "quem está na pilha AGORA" (entra antes de
// recursar num ref, sai ao voltar) — não "já visitado alguma vez", que
// quebraria o losango legítimo de duas medidas-irmãs dependerem da MESMA
// medida-base (ex. "período atual" e "período anterior" ambas vêm de uma
// "medida bruta" comum — não é ciclo, é uma árvore normal com um nó
// repetido). `resolvedScalarCache` (separado de `visiting`) garante que essa
// medida-base comum só é calculada uma vez por resolução — resolve o
// losango E funciona como cache de performance no mesmo mecanismo.
export function resolveMeasure(measureId, ctx, depth = 1) {
  if (depth > MAX_MEASURE_DEPTH) throw new Error(`Cadeia de medidas aninhada demais (máximo ${MAX_MEASURE_DEPTH} níveis).`)
  if (ctx.resolvedScalarCache.has(measureId)) return ctx.resolvedScalarCache.get(measureId)
  if (ctx.visiting.has(measureId)) throw new Error(`Referência circular entre medidas envolvendo "${measureId}".`)

  const def = ctx.measuresById.get(measureId)
  if (!def) throw new Error(`Medida "${measureId}" não encontrada.`)

  ctx.visiting.add(measureId)
  try {
    const result = def.kind === 'simple' ? resolveSimpleMeasure(def, ctx)
      : def.kind === 'formula' ? resolveFormulaMeasure(def, ctx, depth)
      : (() => { throw new Error(`Tipo de medida desconhecido "${def.kind}".`) })()
    ctx.resolvedScalarCache.set(measureId, result)
    return result
  } finally {
    ctx.visiting.delete(measureId)
  }
}

function resolveSimpleMeasure(def, ctx) {
  const sourceDef = getSourceDef(def.source, ctx.snap)
  if (!sourceDef) throw new Error(`Fonte desconhecida na medida "${def.name}": ${def.source}`)
  if (def.field) assertField(sourceDef, def.field)
  for (const f of def.filters ?? []) assertField(sourceDef, f.field)

  // Linhas filtradas (aba + relação) da PRÓPRIA fonte da medida, cacheadas
  // por fonte dentro desta resolução — várias medidas da mesma fonte (ex.
  // "atual" e "anterior" via janelas diferentes) compartilham a parte cara
  // (filtro de aba/relação), só o filtro de janela roda de novo por medida.
  let cached = ctx.sourceRowsCache.get(def.source)
  if (!cached) {
    const relevantTabFilters = ctx.tabFilters.filter((tf) => tf.filter.source === def.source)
    const indirectFilters = []
    const sourcesFiltered = new Set(relevantTabFilters.length ? [def.source] : [])
    for (const tf of ctx.tabFilters) {
      if (tf.filter.source === def.source) continue
      const resolved = resolveIndirectFilter(tf, sourceDef, ctx.relations, ctx.snap)
      if (resolved) { indirectFilters.push({ field: resolved.field, op: 'in', values: resolved.values }); sourcesFiltered.add(tf.filter.source) }
    }
    const rows = applyFilters(getRows(ctx.snap, def.source) ?? [], relevantTabFilters, indirectFilters)
    cached = { rows, sourcesFiltered }
    ctx.sourceRowsCache.set(def.source, cached)
  }

  // Filtro fixo por valor/categoria da PRÓPRIA medida (def.filters) — separado
  // do cache por fonte acima porque é específico desta medida, não
  // compartilhável com outras medidas da mesma fonte (ex. "instalados" e
  // "agendados" via um mesmo campo de status, cada uma com seu próprio
  // filtro). Aplica ANTES do dateWindow — ordem não importa entre os dois
  // (interseção de filtros), mas mantém o mesmo padrão de "cache barato,
  // filtro específico por cima" já usado pro dateWindow logo abaixo.
  let rows = cached.rows
  if (def.filters?.length) rows = applyFilters(rows, [], def.filters)
  if (def.dateWindow) {
    const w = resolveDateWindow(def.dateWindow, ctx.now)
    rows = applyFilters(rows, [{ filter: { type: 'daterange', field: w.field }, values: [w.from, w.to] }], [])
  }

  const pkField = sourceDef.fields.find((f) => f.pk)?.key ?? null
  const aggregator = makeAggregator({ agg: def.agg, field: def.field }, pkField)
  const acc = aggregator.init()
  for (const r of rows) aggregator.add(acc, r)
  return { value: aggregator.value(acc), sourcesFiltered: cached.sourcesFiltered }
}

function resolveFormulaMeasure(def, ctx, depth) {
  const scope = {}
  const sourcesFiltered = new Set()
  for (const [alias, refId] of Object.entries(def.refs ?? {})) {
    const sub = resolveMeasure(refId, ctx, depth + 1)
    scope[alias] = sub.value
    for (const s of sub.sourcesFiltered) sourcesFiltered.add(s)
  }
  const ast = parseExpression(def.expression)
  const value = evaluateExpression(ast, scope)
  return { value, sourcesFiltered }
}

// Verdadeiro quando algum filtro de aba ATIVO mira uma fonte que a árvore
// da medida tocou mas não conseguiu de fato filtrar (nem direto, nem por
// relação) — o widget mostra um aviso pequeno "filtro parcial" nesse caso,
// já que o número pode não refletir um filtro que a pessoa vê ligado na
// tela. Não impede o cálculo, só avisa (mesmo espírito do aviso âmbar já
// existente pra relação apontando pra fonte removida, ver 3.2-bis).
export function isPartialMeasureFilter(tabFilters, sourcesFiltered) {
  const activeSources = new Set(tabFilters.map((tf) => tf.filter.source))
  for (const s of activeSources) if (!sourcesFiltered.has(s)) return true
  return false
}

// "Nível 2" de medida nomeada: um slot COM dimensão (Eixo Y de gráfico) só
// aceita uma medida 'simple' da MESMA fonte do widget — sem isso não existe
// uma chave de agrupamento comum entre fontes diferentes, e uma 'formula'
// não tem um {agg,field} de verdade pra rodar dentro do loop de agrupamento
// já existente (ver o comentário maior em runWidgetQuery). Preserva
// label/color/dataLabels do slot do WIDGET (customização por série), só
// agg/field/dateWindow vêm da medida referenciada.
function resolveLevel2Measure(measureConfig, widgetSource, measuresById) {
  if (!measureConfig?.measureRef) return measureConfig
  const def = measuresById.get(measureConfig.measureRef)
  if (!def) throw new Error(`Medida "${measureConfig.measureRef}" não encontrada.`)
  if (def.kind !== 'simple') {
    throw new Error(`Medida "${def.name}" é uma fórmula — só pode ser usada no KPI (medida única, sem eixo com dimensão). Fórmulas não têm um {campo, agregação} pra rodar num eixo agrupado.`)
  }
  if (def.source !== widgetSource) {
    throw new Error(`Medida "${def.name}" é da fonte "${def.source}" — num widget com dimensão só pode usar medida da MESMA fonte do widget ("${widgetSource}"). Use-a num KPI, ou crie uma medida da fonte "${widgetSource}".`)
  }
  return { agg: def.agg, field: def.field, dateWindow: def.dateWindow, filters: def.filters, label: measureConfig.label, color: measureConfig.color, dataLabels: measureConfig.dataLabels }
}

// Predicado por linha equivalente ao ramo 'daterange' de applyFilters (mesmo
// cálculo de limite em ms, fim de dia inclusivo) — usado quando só UMA
// medida, dentro de um loop que soma várias, precisa da própria janela sem
// re-filtrar o array de linhas inteiro a cada medida.
function makeDateWindowRowPredicate(dateWindowSpec) {
  if (!dateWindowSpec) return () => true
  const w = resolveDateWindow(dateWindowSpec)
  const fromT = new Date(w.from).getTime()
  const toT = new Date(w.to).getTime() + 86_399_999
  return (r) => {
    const v = r[w.field]
    if (!v) return false
    const t = new Date(v).getTime()
    return !isNaN(t) && t >= fromT && t <= toT
  }
}

// Combina a janela de data (acima) com o filtro fixo por valor/categoria
// (`resolved.filters`, ver MeasureDef 'simple') de uma medida "Nível 2" — mesmo
// espírito de applyFilters, mas por linha (o loop de agrupamento já existente
// não re-filtra o array inteiro por medida, só testa cada linha na hora de
// somar). Uma medida sem `filters` se comporta exatamente como antes (só a
// janela de data importa).
function makeMeasureRowPredicate(resolved) {
  const inWindow = makeDateWindowRowPredicate(resolved.dateWindow)
  const filters = resolved.filters ?? []
  if (!filters.length) return inWindow
  return (r) => {
    if (!inWindow(r)) return false
    for (const f of filters) {
      const has = new Set(f.values).has(String(r[f.field] ?? ''))
      if (f.op === 'in' ? !has : has) return false
    }
    return true
  }
}

// Tabela Matriz (pivot) — estilo Power BI: 1+ campos em "Linhas" (hierarquia
// aninhada com subtotal em cada nível), 0+ campos em "Colunas" (cada
// combinação distinta de valores vira uma coluna dinâmica) e 1 medida em
// "Valores" (uma célula por linha × coluna). Sem "Colunas" configurado, cai
// numa única coluna (`value`) — vira uma tabela agrupada simples com
// subtotais, útil mesmo sem quebra por coluna.
function buildMatrix(rows, matrixRowFields, matrixColumnFields, measure, pkField, matrixSort) {
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

  // Valor de um nó pra ordenar por clique de cabeçalho (ver MATRIX_*_SORT_KEY):
  // "Total" usa o próprio total da linha; qualquer outra chave é uma coluna
  // dinâmica de verdade, lida do mesmo `perCol` que `nodeValues` usa (nunca
  // null/undefined — cai em 0 igual lá).
  const sortValueOf = (node, column) => (
    column === MATRIX_TOTAL_SORT_KEY ? aggregator.value(node.rowAcc)
      : (node.perCol.get(column) ? aggregator.value(node.perCol.get(column)) : 0)
  )

  // Monta a árvore: nível 0 é a raiz; cada nível seguinte aninha sob o
  // prefixo (chave completa) do nó-pai no nível anterior. Ordena as linhas
  // IRMÃS de cada nível — nunca a árvore inteira "achatada" — preservando o
  // aninhamento pai/filho intacto; só a ORDEM entre irmãos muda. Sem clique
  // ainda: rótulo (alfabético/cronológico pra bucket de data — mesma chave
  // CRUA de sempre), igual ao padrão de uma matriz do Power BI. Com clique
  // (`matrixSort`): rótulo da linha (MATRIX_LABEL_SORT_KEY, mesma chave crua,
  // só que com direção configurável) ou o valor da coluna/"Total" clicada.
  function buildLevel(depth, parentPrefix) {
    const dir = matrixSort?.direction === 'desc' ? -1 : 1
    const comparator = !matrixSort
      ? (a, b) => a[1].labelParts[depth].localeCompare(b[1].labelParts[depth], 'pt-BR')
      : matrixSort.column === MATRIX_LABEL_SORT_KEY
        ? (a, b) => a[1].labelParts[depth].localeCompare(b[1].labelParts[depth], 'pt-BR') * dir
        : (a, b) => (sortValueOf(a[1], matrixSort.column) - sortValueOf(b[1], matrixSort.column)) * dir
    const entries = Array.from(levels[depth].entries())
      .filter(([key]) => depth === 0 || key.startsWith(parentPrefix + SEP))
      .sort(comparator)
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

export async function runWidgetQuery({ widget, tabFilters = [], relations = [], page = 1, pageSize = 50, accessToken, tableSort, matrixSort, dashboardMeasures = [] }) {
  const measuresById = new Map(dashboardMeasures.map((m) => [m.id, m]))
  // Toda 'sheet:' fonte tocada por uma medida referenciada (measureRef) em
  // qualquer papel do widget — mesmo motivo de collectWidgetSheetKeys pra
  // lookups/relations: buscar TUDO antes, uma vez só, evita ida repetida à
  // API do Google se duas medidas de fórmula tocarem a mesma planilha.
  const measureRefIds = [widget.measure, ...(widget.measures ?? []), widget.measureX, widget.matrixValue]
    .map((m) => m?.measureRef).filter(Boolean)
  const measureSheetKeys = measureRefIds.flatMap((id) => collectMeasureRefSheetKeys(id, measuresById, new Set()))
  // measureX (scatter) e matrixValue ainda não suportam medida nomeada nesta
  // rodada (ver HISTORICO_ALTERACOES.md) — falha explícita aqui em vez de
  // makeAggregator silenciosamente ignorar measureRef e calcular um número
  // sem sentido nenhum (measure.agg/field ficam ausentes numa MeasureConfig
  // que só tem measureRef).
  if (widget.measureX?.measureRef) throw new Error('Medida nomeada ainda não é suportada no eixo X de dispersão (measureX) — use um cálculo simples aqui, ou mova pra um KPI.')
  if (widget.matrixValue?.measureRef) throw new Error('Medida nomeada ainda não é suportada no valor da Matriz — use um cálculo simples aqui, ou mova pra um KPI.')
  const snap = await withSheetSources(getSnapshot(), [...collectWidgetSheetKeys(widget, relations), ...measureSheetKeys], accessToken)
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
  const lookups = buildLookups(widget, sourceDef, relations, snap)

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
  // Mescla ANTES de filtrar (não depois): "Filtro fixo do widget" pode mirar
  // um campo mesclado (`${outraFonte}.${campo}`, via relação ou lookup
  // legado) — filtrar sobre as linhas CRUAS faria `r[wf.field]` bater sempre
  // `undefined` pra esse campo (ele só existe depois do merge), zerando o
  // widget inteiro em vez de aplicar o filtro de verdade. Filtro de aba e
  // indireto sempre miram campo NATIVO da própria fonte do widget, então
  // mesclar primeiro não muda o resultado deles — só corrige o caso do
  // filtro fixo sobre campo mesclado.
  const rows = applyFilters(mergeLookups(getRows(snap, widget.source) ?? [], lookups), relevantTabFilters, [...(widget.widgetFilters ?? []), ...indirectFilters])

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
      // outKey de lookup entra em `sortVals` também — não faz parte da chave
      // de dedup (ver comentário acima), mas o cabeçalho dela é clicável que
      // nem qualquer outra coluna (ver clique-pra-ordenar), então precisa de
      // um valor comparável igual às colunas nativas.
      for (const lk of lookups) { projected[lk.outKey] = r[lk.outKey] ?? null; sortVals[lk.outKey] = projected[lk.outKey] }
      const key = JSON.stringify(cols.map((c) => sortVals[c]))
      if (!seen.has(key)) seen.set(key, { projected, sortVals })
    }
    const entries = Array.from(seen.values())
    // Clique num cabeçalho de coluna (front): ordena só por AQUELA coluna,
    // numérico se o valor for número (`typeof`, o tipo real já preservado em
    // `sortVals` — nunca comparação de texto pra número), alfabético (pt-BR)
    // senão. Vazio sempre por último, nas duas direções — senão "decrescente"
    // jogaria toda célula vazia pro topo, o oposto do que se espera.
    if (tableSort?.column && (cols.includes(tableSort.column) || lookups.some((lk) => lk.outKey === tableSort.column))) {
      const col = tableSort.column
      const dir = tableSort.direction === 'desc' ? -1 : 1
      entries.sort((a, b) => {
        const av = a.sortVals[col]
        const bv = b.sortVals[col]
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv), 'pt-BR') * dir
      })
    } else {
      // Ordem padrão (sem clique ainda): mesmo critério alfabético (pt-BR)
      // de sempre, coluna por coluna na ordem declarada — só pra uma lista
      // de valores distintos ficar previsível em vez de espelhar a ordem
      // arbitrária do dataset de origem.
      entries.sort((a, b) => {
        for (const c of cols) {
          const cmp = String(a.sortVals[c] ?? '').localeCompare(String(b.sortVals[c] ?? ''), 'pt-BR')
          if (cmp !== 0) return cmp
        }
        return 0
      })
    }
    const distinctRows = entries.map((e) => e.projected)

    const total = distinctRows.length
    const startIdx = (page - 1) * pageSize
    const pageRows = distinctRows.slice(startIdx, startIdx + pageSize)
    return { rows: pageRows, total, page, pageSize }
  }

  const pkField = sourceDef.fields.find((f) => f.pk)?.key ?? null

  // Matriz: estrutura própria (linhas hierárquicas × colunas dinâmicas),
  // nada a ver com o pipeline de pontos/séries usado pelos gráficos abaixo.
  if (widget.type === 'matrix') {
    const matrix = buildMatrix(rows, widget.matrixRows ?? [], widget.matrixColumns ?? [], widget.matrixValue ?? { agg: 'countDistinct' }, pkField, matrixSort)
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
  // "Nível 1" da medida nomeada (ver MeasureDef): o único slot que aceita
  // QUALQUER medida — 'formula', cruzando fontes diferentes, o que for —
  // porque um KPI é sempre 1 número só, sem agrupamento nenhum pra respeitar.
  if (!widget.dimensions?.length) {
    if (measuresIn[0]?.measureRef) {
      // `now` fixado uma vez por resolução (não "new Date()" de novo a cada
      // medida com janela) — evita duas medidas do mesmo pedido calculando
      // "hoje" com um milissegundo de diferença.
      const mctx = { measuresById, snap, relations, tabFilters, now: new Date(), sourceRowsCache: new Map(), resolvedScalarCache: new Map(), visiting: new Set() }
      const resolved = resolveMeasure(measuresIn[0].measureRef, mctx)
      const point = { label: 'total', value: resolved.value }
      if (isPartialMeasureFilter(tabFilters, resolved.sourcesFiltered)) point.measureWarning = 'filtro parcial'
      return { points: [point] }
    }
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
    const resolvedMeasure = resolveLevel2Measure(measuresIn[0], widget.source, measuresById)
    const aggregator = makeAggregator(resolvedMeasure, pkField)
    const inWindow = makeMeasureRowPredicate(resolvedMeasure)
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
      if (!inWindow(r)) continue

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
  // "Nível 2" de medida nomeada (ver resolveLevel2Measure): cada série pode
  // referenciar uma medida 'simple' da MESMA fonte — sua própria janela de
  // data (se houver) é um filtro A MAIS só para ELA, verificado linha a
  // linha no MESMO loop de agrupamento (sem re-filtrar `rows` por medida).
  const measuresLineIn = widget.type === 'comboBarLine' ? (widget.measuresLine ?? []) : []
  const resolvedMeasures = measuresIn.map((m) => resolveLevel2Measure(m, widget.source, measuresById))
  const resolvedLineMeasures = measuresLineIn.map((m) => resolveLevel2Measure(m, widget.source, measuresById))
  const aggregators = resolvedMeasures.map((m) => makeAggregator(m, pkField))
  const lineAggregators = resolvedLineMeasures.map((m) => makeAggregator(m, pkField))
  const inWindow = resolvedMeasures.map((m) => makeMeasureRowPredicate(m))
  const lineInWindow = resolvedLineMeasures.map((m) => makeMeasureRowPredicate(m))
  const groups = new Map() // primaryKey -> { bar: acc[], line: acc[] }
  for (const r of rows) {
    const key = keyOf(r)
    if (key == null || key === '') continue
    let g = groups.get(key)
    if (!g) { g = { bar: aggregators.map((a) => a.init()), line: lineAggregators.map((a) => a.init()) }; groups.set(key, g) }
    aggregators.forEach((a, i) => { if (inWindow[i](r)) a.add(g.bar[i], r) })
    lineAggregators.forEach((a, i) => { if (lineInWindow[i](r)) a.add(g.line[i], r) })
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
    ? measuresIn.map((m, i) => ({ key: `s${i}`, label: m.label ?? defaultMeasureLabel(m, measuresById), color: m.color, role: 'bar', dataLabels: m.dataLabels }))
    : [{ key: 'value', label: measuresIn[0].label ?? defaultMeasureLabel(measuresIn[0], measuresById), color: measuresIn[0].color, role: 'bar', dataLabels: measuresIn[0].dataLabels }]
  measuresLineIn.forEach((m, i) => seriesKeys.push({ key: `l${i}`, label: m.label ?? defaultMeasureLabel(m, measuresById), color: m.color, role: 'line', dataLabels: m.dataLabels }))
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
