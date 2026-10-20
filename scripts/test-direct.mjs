// ─────────────────────────────────────────────────────────────────────────
// Teste da LEITURA DIRETA no Data Hub (server/directWidgetQuery.mjs).
// Roda com: npm run test:direct
//
// O que ele prova:
// - para uma bateria de widgets (barras, linha por mês e por hierarquia de
//   datas, várias medidas, combo, legenda, pizza, KPI, medidas nomeadas e
//   fórmula, tabela, matriz com subtotais, dispersão, histograma, valores de
//   filtro, relação como filtro e como campo), a leitura direta devolve o MESMO
//   resultado que o motor em memória devolve sobre as mesmas linhas — é a mesma
//   fonte, lida dos dois jeitos;
// - na leitura direta nenhuma linha bruta é baixada (zero chamadas a /rows) e
//   o que atravessa a rede é só o resultado agregado;
// - o filtro por clique (src/features/builder/clickFilter.ts) dá, nos outros
//   widgets, o mesmo número do item clicado — cidade, mês, hierarquia de
//   datas, campo de outra fonte, célula de matriz, Ctrl+clique e medidas
//   nomeadas —, nos dois modos;
// - o ETL não copia fonte direta (só confere o total) e uma fonte copiada
//   grande demais vira erro NA PRÓPRIA fonte, sem congelar as outras;
// - um Data Hub ainda sem a consulta pública responde com uma mensagem que diz
//   o que fazer, em vez de um 404 cru.
//
// Não toca em data/ nem na rede de fora: catálogo, snapshot, dicionário e
// chave ficam numa pasta temporária, e o Data Hub é um servidor falso em
// 127.0.0.1 que implementa POST /api/public/v1/datasets/:slug/query com a
// semântica do compilador de lá (apps/api/src/modules/query/compile.ts no
// repositório do Data Hub) e as conversões do DuckDB que fazem diferença:
// contagem chega como TEXTO, data como "AAAA-MM-DD HH:MM:SS", nulos por último
// na ordenação, texto ordenado por código de caractere. Dados inventados,
// gerados com semente fixa.
//
// DIRECT_TEST_DUMP=<arquivo> grava o resultado do modo CÓPIA de cada caso em
// JSON — serve para provar que mexer no motor não mudou o modo cópia
// (comparando a saída de antes e a de depois). Com DIRECT_TEST_ONLY_COPY=1 o
// teste para aí, sem tocar em nada da leitura direta.
// ─────────────────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Fuso fixo em UTC, onde os dois modos têm de bater exatamente. O motor em
// memória lê "AAAA-MM-DD HH:MM:SS" no fuso LOCAL do processo (regra do Date do
// JavaScript) e o limite do filtro de período em UTC; o Data Hub compara a data
// como está escrita. Fora de UTC — os containers rodam em America/Sao_Paulo —
// o filtro de período da CÓPIA escorrega 3 horas na virada do dia, e o da
// leitura direta é que está certo.
process.env.TZ = 'UTC'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = resolvePath(AQUI, '..')
const ONLY_COPY = process.env.DIRECT_TEST_ONLY_COPY === '1'
const TOKEN = 'dhub_token_ficticio_de_teste'

const dir = mkdtempSync(join(tmpdir(), 'ind-leitura-direta-'))
const ENV = {
  LAKEHOUSE_SOURCES_PATH: join(dir, 'lakehouseSources.json'),
  SNAPSHOT_PATH: join(dir, 'installData.data'),
  SNAPSHOT_OUT: join(dir, 'installData.data'),
  SHEET_SOURCES_PATH: join(dir, 'sheetSources.json'),
  FIELD_DICTIONARY_PATH: join(dir, 'fieldDictionary.json'),
  SECRETS_KEY: 'chave-de-teste-somente-local',
  SECRETS_KEY_PATH: join(dir, '.secret-key'),
}
Object.assign(process.env, ENV)

let falhas = 0
let total = 0
function check(nome, ok, detalhe = '') {
  total++
  if (!ok) falhas++
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${nome}${!ok && detalhe ? ` — ${detalhe}` : ''}`)
}

// ─── Dados inventados ──────────────────────────────────────────────────────
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pad = (n) => String(n).padStart(2, '0')
function stamp(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

const r = rng(20261001)
const pick = (list) => list[Math.floor(r() * list.length)]
const STATUS = ['Concluído', 'Concluído', 'Concluído', 'Em andamento', 'Cancelado', 'Aguardando cliente']
const CIDADES = ['Porto Alegre', 'Canoas', 'Gravataí', 'Viamão', 'Cachoeirinha']
const INICIO = Date.UTC(2025, 0, 1)
const FIM = Date.UTC(2026, 8, 30, 23, 59, 59)
const PROTOCOLOS = Array.from({ length: 2400 }, (_, i) => ({
  Protocolo: `P${100000 + i}`,
  'Data abertura': r() < 0.03 ? null : stamp(INICIO + Math.floor(r() * (FIM - INICIO))),
  Status: r() < 0.04 ? null : pick(STATUS),
  Cidade: pick(CIDADES),
  Base: `B${1 + Math.floor(r() * 7)}`, // B7 não existe em BASES: relação sem par
  Valor: Math.round(r() * 100000) / 100,
  Cliente: `C${1 + Math.floor(r() * 350)}`,
  Prioridade: 1 + Math.floor(r() * 4),
}))
const BASES = [
  { Base: 'B1', 'Região': 'Sul', Gerente: 'Gerente A' },
  { Base: 'B2', 'Região': 'Sul', Gerente: 'Gerente B' },
  { Base: 'B3', 'Região': 'Norte', Gerente: 'Gerente C' },
  { Base: 'B4', 'Região': 'Norte', Gerente: 'Gerente D' },
  { Base: 'B5', 'Região': 'Leste', Gerente: 'Gerente E' },
  { Base: 'B6', 'Região': 'Oeste', Gerente: 'Gerente F' },
]
// Grande o bastante para pesar se fosse baixada (≈ 120 mil linhas), pequena o
// bastante para o teste rodar rápido.
const GRANDE = Array.from({ length: 120_000 }, (_, i) => ({
  ID: i + 1,
  Data: stamp(INICIO + Math.floor(r() * (FIM - INICIO))),
  Status: pick(STATUS),
  Valor: Math.round(r() * 10000) / 100,
  Obs: `observação ${i % 97}`,
}))

const DATASETS = {
  protocolos: {
    rows: PROTOCOLOS,
    types: new Map([['Protocolo', 'text'], ['Data abertura', 'date'], ['Status', 'text'], ['Cidade', 'text'], ['Base', 'text'], ['Valor', 'number'], ['Cliente', 'text'], ['Prioridade', 'number']]),
  },
  bases: { rows: BASES, types: new Map([['Base', 'text'], ['Região', 'text'], ['Gerente', 'text']]) },
  grande: { rows: GRANDE, types: new Map([['ID', 'number'], ['Data', 'date'], ['Status', 'text'], ['Valor', 'number'], ['Obs', 'text']]) },
}
DATASETS.antigo = DATASETS.bases // Data Hub "de antes": sem POST /query (ver servidor)

// ─── Data Hub falso ────────────────────────────────────────────────────────
// Mesma regra do compile.ts do Data Hub; os comentários dizem de onde vem cada
// detalhe que importa para o resultado.
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status } }

const normTs = (v) => {
  const s = String(v).replace('T', ' ')
  return s.length === 10 ? `${s} 00:00:00` : s.slice(0, 19)
}
function grainOf(v, grain) {
  if (v == null) return null
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(String(v))
  if (!m) return null // try_cast falha → NULL
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  if (grain === 'year') return `${y}-01-01`
  if (grain === 'quarter') return `${y}-${pad(Math.floor((mo - 1) / 3) * 3 + 1)}-01`
  if (grain === 'month') return `${y}-${pad(mo)}-01`
  return `${y}-${pad(mo)}-${pad(d)}`
}
const cmp = (a, b) => {
  if (a == null && b == null) return 0
  if (a == null) return 1 // nulos por último, nos dois sentidos (DuckDB)
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a); const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0 // ordem por código de caractere
}

function evalQuery(ds, def) {
  const types = ds.types
  const need = (k, uso) => {
    if (!types.has(k)) throw new HttpError(400, `Campo desconhecido em ${uso}: "${k}"`)
    return types.get(k)
  }
  const preds = (def.filters ?? []).map((f) => {
    const t = need(f.field, 'filtro')
    const conv = (v) => (v == null ? null : t === 'number' ? Number(v) : t === 'date' ? normTs(v) : t === 'bool' ? String(v) === 'true' : String(v))
    const get = (row) => { const v = row[f.field]; return v == null ? null : t === 'date' ? normTs(v) : v }
    let base
    switch (f.op) {
      case 'is_null': base = (row) => get(row) == null; break
      case 'not_null': base = (row) => get(row) != null; break
      case 'in': case 'not_in': {
        const list = (Array.isArray(f.value) ? f.value : [f.value]).map(conv)
        if (!list.length) { base = () => f.op === 'not_in'; break }
        base = (row) => { const v = get(row); if (v == null) return false; const has = list.includes(v); return f.op === 'in' ? has : !has }
        break
      }
      case 'between': { const [a, b] = f.value.map(conv); base = (row) => { const v = get(row); return v != null && cmp(v, a) >= 0 && cmp(v, b) <= 0 }; break }
      default: {
        const ops = { '=': (x) => x === 0, '!=': (x) => x !== 0, '>': (x) => x > 0, '>=': (x) => x >= 0, '<': (x) => x < 0, '<=': (x) => x <= 0 }
        const op = ops[f.op]
        if (!op) throw new HttpError(400, `Operador inválido: ${f.op}`)
        const x = conv(f.value)
        base = (row) => { const v = get(row); return v != null && x != null && op(cmp(v, x)) }
      }
    }
    if (!f.orNull || f.op === 'is_null' || f.op === 'not_null') return base
    return (row) => get(row) == null || base(row)
  })
  const rows = ds.rows.filter((row) => preds.every((p) => p(row)))

  const groupBy = (def.groupBy ?? []).map((g) => (typeof g === 'string' ? { field: g, grain: null } : { field: g.field, grain: g.grain }))
  for (const g of groupBy) {
    const t = need(g.field, 'agrupamento')
    if (g.grain && !['year', 'quarter', 'month', 'day'].includes(g.grain)) throw new HttpError(400, `Granularidade de data inválida: ${g.grain}`)
    if (g.grain && t !== 'date' && t !== 'text') throw new HttpError(400, `Agrupar por ${g.grain} só vale para campo de data`)
  }
  const select = def.select?.length ? def.select : [...types.keys()]
  const isAgg = (s) => typeof s === 'object' && ('agg' in s || 'metric' in s)
  const bigints = new Set() // contagens: BIGINT no DuckDB → texto no JSON
  let out
  if (groupBy.length || select.some(isAgg)) {
    const groups = new Map()
    for (const row of rows) {
      const vals = groupBy.map((g) => (g.grain ? grainOf(row[g.field], g.grain) : row[g.field] ?? null))
      const k = JSON.stringify(vals)
      let gr = groups.get(k)
      if (!gr) { gr = { vals, rows: [] }; groups.set(k, gr) }
      gr.rows.push(row)
    }
    if (!groupBy.length && groups.size === 0) groups.set('[]', { vals: [], rows: [] })
    out = [...groups.values()].map((gr) => {
      const o = {}
      for (const s of select) {
        if (typeof s === 'string') {
          const i = groupBy.findIndex((g) => !g.grain && g.field === s)
          if (i < 0) throw new HttpError(400, `column "${s}" must appear in the GROUP BY clause`)
          o[s] = gr.vals[i]
        } else if ('grain' in s) {
          const i = groupBy.findIndex((g) => g.grain === s.grain && g.field === s.field)
          if (i < 0) throw new HttpError(400, `"${s.field}" (${s.grain}) precisa estar no GROUP BY`)
          o[s.as || `${s.grain}_${s.field}`] = gr.vals[i]
        } else if (!('field' in s)) {
          const alias = s.as || 'count'
          o[alias] = gr.rows.length
          bigints.add(alias)
        } else {
          const t = need(s.field, 'agregação')
          const alias = s.as || `${s.agg}_${s.field}`
          const vals = gr.rows.map((row) => row[s.field]).filter((v) => v != null)
          if (s.agg === 'count') { o[alias] = vals.length; bigints.add(alias) }
          else if (s.agg === 'count_distinct') { o[alias] = new Set(vals.map((v) => `${typeof v}:${v}`)).size; bigints.add(alias) }
          else if (s.agg === 'sum' || s.agg === 'avg') {
            if (t !== 'number') throw new HttpError(400, `No function matches ${s.agg}(VARCHAR)`)
            const sum = vals.reduce((a, b) => a + b, 0)
            o[alias] = vals.length ? (s.agg === 'sum' ? sum : sum / vals.length) : null
          } else throw new HttpError(400, `Agregação inválida: ${s.agg}`)
        }
      }
      return o
    })
  } else {
    for (const k of select) need(k, 'select')
    out = rows.map((row) => Object.fromEntries(select.map((k) => [k, row[k] ?? null])))
  }

  for (const o of [...(def.orderBy ?? [])].reverse()) {
    const dirSign = o.dir === 'desc' ? -1 : 1
    out.sort((a, b) => {
      const va = a[o.field]; const vb = b[o.field]
      if (va == null || vb == null) return cmp(va, vb) // nulos por último também no desc
      return cmp(va, vb) * dirSign
    })
  }
  const limit = Math.min(Math.max(1, def.limit ?? 100), 10_000)
  const offset = Math.max(0, def.offset ?? 0)
  const totalOut = !groupBy.length ? rows.length : def.withTotal ? out.length : undefined
  const page = out.slice(offset, offset + limit).map((o) => {
    const c = { ...o }
    for (const k of bigints) if (c[k] != null) c[k] = String(c[k])
    return c
  })
  const columns = (page[0] ? Object.keys(page[0]) : select.map((s) => (typeof s === 'string' ? s : s.as ?? '')))
    .map((name) => ({ name, type: types.get(name) ?? 'text' }))
  return { dataset: def.dataset, columns, rows: page, total: totalOut, tookMs: 0 }
}

const trafego = [] // { metodo, slug, bytes }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (status, body) => {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(json)
    return json.length
  }
  if (req.headers['x-api-token'] !== TOKEN) return send(401, { error: 'Token inválido ou revogado.' })
  const rows = /^\/api\/public\/v1\/datasets\/([^/]+)\/rows$/.exec(url.pathname)
  const query = /^\/api\/public\/v1\/datasets\/([^/]+)\/query$/.exec(url.pathname)
  if (req.method === 'GET' && rows) {
    const ds = DATASETS[rows[1]]
    if (!ds) return send(404, { error: 'Conjunto de dados não encontrado.' })
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 10_000), 100_000)
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    const bytes = send(200, { dataset: rows[1], total: ds.rows.length, limit, offset, rows: ds.rows.slice(offset, offset + limit) })
    trafego.push({ metodo: 'rows', slug: rows[1], bytes })
    return
  }
  if (req.method === 'POST' && query && query[1] !== 'antigo') {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const ds = DATASETS[query[1]]
      if (!ds) return send(404, { error: 'Conjunto de dados não encontrado.' })
      try {
        const bytes = send(200, evalQuery(ds, { ...JSON.parse(raw || '{}'), dataset: query[1] }))
        trafego.push({ metodo: 'query', slug: query[1], bytes })
      } catch (e) {
        send(e.status ?? 500, { error: e.message })
      }
    })
    return
  }
  send(404, { error: 'Rota não encontrada.' })
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const BASE_URL = `http://127.0.0.1:${server.address().port}`

// ─── Fontes: a MESMA tabela cadastrada nos dois modos ─────────────────────
const mod = (n) => pathToFileURL(resolvePath(RAIZ, 'server', n)).href
const lake = await import(mod('lakehouseSources.mjs'))
const admin = 'admin.teste@exemplo.test'
const nova = (label, datasetSlug, readMode) =>
  lake.createLakehouseSource({ label, baseUrl: BASE_URL, datasetSlug, token: TOKEN, readMode }, admin)
const protCopia = nova('Protocolos (cópia)', 'protocolos', 'copy')
const protDireta = nova('Protocolos (direta)', 'protocolos', 'direct')
const basesCopia = nova('Bases (cópia)', 'bases', 'copy')
const K = {
  copia: lake.sourceKey(protCopia.id),
  direta: lake.sourceKey(protDireta.id),
  bases: lake.sourceKey(basesCopia.id),
}
// Snapshot do modo cópia, como o ETL deixaria: só as fontes copiadas.
writeFileSync(ENV.SNAPSHOT_PATH, gzipSync(Buffer.from(JSON.stringify({
  meta: { generatedAt: new Date().toISOString() },
  data: { [K.copia]: PROTOCOLOS, [K.bases]: BASES },
}))))

const wq = await import(mod('widgetQuery.mjs'))

// ─── Bateria ───────────────────────────────────────────────────────────────
// Cada caso é montado em função da chave da fonte de Protocolos (`p`), que
// muda de um modo para o outro; Bases é sempre a mesma fonte copiada.
const relacao = (p) => [{ id: 'rel-base', sourceA: p, fieldA: 'Base', sourceB: K.bases, fieldB: 'Base' }]
const REGIAO = `${K.bases}.Região`
const medidas = (p) => [
  { id: 'm_conc', name: 'Concluídos', kind: 'simple', source: p, agg: 'count', filters: [{ field: 'Status', op: 'in', values: ['Concluído'] }] },
  { id: 'm_tot', name: 'Total', kind: 'simple', source: p, agg: 'count' },
  { id: 'm_taxa', name: 'Taxa de conclusão', kind: 'formula', expression: 'conc / tot * 100', refs: { conc: 'm_conc', tot: 'm_tot' } },
  { id: 'm_rec', name: 'Valor recente', kind: 'simple', source: p, agg: 'sum', field: 'Valor', dateWindow: { type: 'lastNMonths', field: 'Data abertura', n: 6 } },
  { id: 'm_ativos', name: 'Não cancelados', kind: 'simple', source: p, agg: 'countDistinct', field: 'Cliente', filters: [{ field: 'Status', op: 'notIn', values: ['Cancelado'] }] },
]
const sulFiltro = { filter: { source: K.bases, field: 'Região', type: 'multiselect' }, values: ['Sul'] }
const W = (p, w) => ({ id: 'w', title: 't', source: p, ...w })

const CASOS = [
  ['KPI padrão (contagem distinta sem campo)', (p) => ({ widget: W(p, { type: 'kpi' }) })],
  ['KPI soma', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'sum', field: 'Valor' } }) })],
  ['KPI média com filtro de aba', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'avg', field: 'Valor' } }), tabFilters: [{ filter: { source: p, field: 'Status', type: 'multiselect' }, values: ['Concluído', 'Cancelado'] }] })],
  ['KPI contagem distinta de cliente', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'countDistinct', field: 'Cliente' } }) })],
  ['barras por status (padrão)', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Status'] }) })],
  ['barras por cidade, soma, crescente', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Cidade'], measures: [{ agg: 'sum', field: 'Valor' }], sort: 'asc' }) })],
  ['barras top 2', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Status'], measures: [{ agg: 'count' }], limit: 2 }) })],
  ['barras por campo numérico', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Prioridade'], measures: [{ agg: 'avg', field: 'Valor' }] }) })],
  ['linha por mês (série temporal fica com os 15 mais recentes)', (p) => ({ widget: W(p, { type: 'line', dimensions: ['month:Data abertura'], measures: [{ agg: 'count' }] }) })],
  ['linha por mês, crescente, limite 6', (p) => ({ widget: W(p, { type: 'line', dimensions: ['month:Data abertura'], measures: [{ agg: 'count' }], sort: 'asc', limit: 6 }) })],
  ['linha por dia, limite 10', (p) => ({ widget: W(p, { type: 'line', dimensions: ['day:Data abertura'], measures: [{ agg: 'sum', field: 'Valor' }], limit: 10 }) })],
  ['hierarquia ano › trimestre › mês', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['year:Data abertura', 'quarter:Data abertura', 'month:Data abertura'], measures: [{ agg: 'count' }], limit: 30 }) })],
  ['duas dimensões (cidade / status)', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Cidade', 'Status'], measures: [{ agg: 'count' }], limit: 40 }) })],
  ['várias medidas', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Status'], measures: [{ agg: 'count' }, { agg: 'sum', field: 'Valor', label: 'Soma' }, { agg: 'avg', field: 'Valor' }, { agg: 'countDistinct', field: 'Cliente' }] }) })],
  ['combo barra + linha por trimestre', (p) => ({ widget: W(p, { type: 'comboBarLine', dimensions: ['quarter:Data abertura'], measures: [{ agg: 'count' }], measuresLine: [{ agg: 'avg', field: 'Valor' }] }) })],
  ['legenda por status, eixo por mês', (p) => ({ widget: W(p, { type: 'barStacked', dimensions: ['month:Data abertura'], legendDimension: 'Status', measures: [{ agg: 'count' }] }) })],
  ['legenda por ano, eixo por cidade, distinta', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Cidade'], legendDimension: 'year:Data abertura', measures: [{ agg: 'countDistinct', field: 'Cliente' }] }) })],
  ['pizza sem Cancelado (vazio continua dentro)', (p) => ({ widget: W(p, { type: 'pie', dimensions: ['Status'], widgetFilters: [{ field: 'Status', op: 'notIn', values: ['Cancelado'] }] }) })],
  ['filtro fixo "está em"', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Cidade'], widgetFilters: [{ field: 'Status', op: 'in', values: ['Concluído', 'Em andamento'] }] }) })],
  ['filtro de período na aba', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Status'] }), tabFilters: [{ filter: { source: p, field: 'Data abertura', type: 'daterange' }, values: ['2026-01-01', '2026-03-31'] }] })],
  ['período só com início', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'count' } }), tabFilters: [{ filter: { source: p, field: 'Data abertura', type: 'daterange' }, values: ['2026-06-15', null] }] })],
  ['relação como filtro (região → protocolos)', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Status'] }), tabFilters: [sulFiltro], relations: relacao(p) })],
  ['relação como filtro num KPI de soma', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'sum', field: 'Valor' } }), tabFilters: [sulFiltro], relations: relacao(p) })],
  ['campo de outra fonte no eixo (região)', (p) => ({ widget: W(p, { type: 'bar', dimensions: [REGIAO], measures: [{ agg: 'count' }, { agg: 'sum', field: 'Valor' }, { agg: 'avg', field: 'Valor' }, { agg: 'countDistinct', field: 'Cliente' }] }), relations: relacao(p) })],
  ['campo de outra fonte na legenda', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Status'], legendDimension: REGIAO, measures: [{ agg: 'count' }] }), relations: relacao(p) })],
  ['filtro fixo em campo de outra fonte', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Cidade'], widgetFilters: [{ field: REGIAO, op: 'in', values: ['Sul'] }] }), relations: relacao(p) })],
  ['filtro fixo "não está em" em campo de outra fonte', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'count' }, widgetFilters: [{ field: REGIAO, op: 'notIn', values: ['Sul'] }] }), relations: relacao(p) })],
  ['KPI com medida-fórmula', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'count', measureRef: 'm_taxa' } }), dashboardMeasures: medidas(p) })],
  ['KPI com janela relativa (últimos 6 meses)', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'sum', measureRef: 'm_rec' } }), dashboardMeasures: medidas(p) })],
  ['KPI fórmula com filtro de aba e relação', (p) => ({ widget: W(p, { type: 'kpi', measure: { agg: 'count', measureRef: 'm_taxa' } }), dashboardMeasures: medidas(p), tabFilters: [sulFiltro], relations: relacao(p) })],
  ['barras com medidas nomeadas de filtros diferentes', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Cidade'], measures: [{ agg: 'count', measureRef: 'm_conc' }, { agg: 'count', measureRef: 'm_tot' }, { agg: 'sum', measureRef: 'm_rec' }, { agg: 'countDistinct', measureRef: 'm_ativos' }] }), dashboardMeasures: medidas(p) })],
  ['legenda com medida nomeada filtrada', (p) => ({ widget: W(p, { type: 'bar', dimensions: ['Cidade'], legendDimension: 'Prioridade', measures: [{ agg: 'count', measureRef: 'm_conc' }] }), dashboardMeasures: medidas(p) })],
  ['dispersão', (p) => ({ widget: W(p, { type: 'scatter', dimensions: ['Cliente'], measureX: { agg: 'sum', field: 'Valor' }, measures: [{ agg: 'count' }], limit: 20 }) })],
  ['histograma', (p) => ({ widget: W(p, { type: 'histogram', histogramField: 'Valor', histogramBins: 12 }) })],
  ['matriz cidade › status × ano', (p) => ({ widget: W(p, { type: 'matrix', matrixRows: ['Cidade', 'Status'], matrixColumns: ['year:Data abertura'], matrixValue: { agg: 'count' } }) })],
  ['matriz por trimestre, soma, ordenada pelo total', (p) => ({ widget: W(p, { type: 'matrix', matrixRows: ['quarter:Data abertura'], matrixValue: { agg: 'sum', field: 'Valor' } }), matrixSort: { column: '__row_total__', direction: 'desc' } })],
  ['matriz com contagem distinta (não soma entre níveis)', (p) => ({ widget: W(p, { type: 'matrix', matrixRows: ['Status', 'Cidade'], matrixColumns: ['Prioridade'], matrixValue: { agg: 'countDistinct', field: 'Cliente' } }), matrixSort: { column: '__row_label__', direction: 'desc' } })],
  ['matriz por região (outra fonte) × status', (p) => ({ widget: W(p, { type: 'matrix', matrixRows: [REGIAO, 'Cidade'], matrixColumns: ['Status'], matrixValue: { agg: 'count' } }), relations: relacao(p) })],
  ['tabela, página 1', (p) => ({ widget: W(p, { type: 'table', columns: ['Cidade', 'Prioridade', 'Base'] }), page: 1, pageSize: 10 })],
  ['tabela, página 3', (p) => ({ widget: W(p, { type: 'table', columns: ['Cidade', 'Prioridade', 'Base'] }), page: 3, pageSize: 10 })],
  ['tabela com período por mês', (p) => ({ widget: W(p, { type: 'table', columns: ['Cidade', 'month:Data abertura'] }), page: 2, pageSize: 15, tabFilters: [{ filter: { source: p, field: 'Data abertura', type: 'daterange' }, values: ['2025-01-01', '2026-12-31'] }] })],
  ['tabela com coluna de outra fonte', (p) => ({ widget: W(p, { type: 'table', columns: ['Base', REGIAO, 'Cidade'] }), relations: relacao(p), page: 1, pageSize: 12 })],
].map(([nome, build]) => ({ nome, build }))

const VALORES = ['Status', 'Cidade', 'Prioridade']

// Números com a mesma tolerância nos dois lados: a ordem da soma muda o
// último dígito de um ponto flutuante, e isso não é diferença de resultado.
function normaliza(v) {
  if (typeof v === 'number') return Number(v.toPrecision(10))
  if (Array.isArray(v)) return v.map(normaliza)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normaliza(x)]))
  return v
}
// Linhas de tabela: só as colunas pedidas. O motor em memória pendura em cada
// linha também os campos de TODA fonte relacionada (mesmo fora de `columns`),
// e a tela só desenha as colunas — comparar o resto seria comparar o que
// ninguém vê.
function soColunas(caso, out, p) {
  const spec = caso.build(p)
  if (spec.widget.type !== 'table' || !out?.rows) return out
  return { ...out, rows: out.rows.map((row) => Object.fromEntries(spec.widget.columns.map((c) => [c, row[c] ?? null]))) }
}
const roda = (caso, p) => {
  const spec = caso.build(p)
  return wq.runWidgetQuery({
    widget: spec.widget, tabFilters: spec.tabFilters ?? [], relations: spec.relations ?? [],
    page: spec.page ?? 1, pageSize: spec.pageSize ?? 50, tableSort: spec.tableSort, matrixSort: spec.matrixSort,
    dashboardMeasures: spec.dashboardMeasures ?? [],
  })
}

console.log('\n── modo cópia (motor em memória) ──')
const copia = {}
for (const caso of CASOS) {
  try { copia[caso.nome] = soColunas(caso, await roda(caso, K.copia), K.copia) } catch (e) { copia[caso.nome] = { erro: e.message } }
  check(`roda em cópia: ${caso.nome}`, !copia[caso.nome]?.erro, copia[caso.nome]?.erro)
}
const valoresCopia = {}
for (const f of VALORES) valoresCopia[f] = await wq.runFieldValues({ source: K.copia, field: f })

if (process.env.DIRECT_TEST_DUMP) {
  writeFileSync(process.env.DIRECT_TEST_DUMP, JSON.stringify(normaliza({ widgets: copia, valores: valoresCopia }), null, 1))
  console.log(`\nmodo cópia gravado em ${process.env.DIRECT_TEST_DUMP}`)
}
if (ONLY_COPY) {
  server.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${total - falhas}/${total} verificações ok (só o modo cópia).`)
  process.exit(falhas ? 1 : 0)
}

// ─── Leitura direta: mesma bateria, mesma resposta ────────────────────────
console.log('\n── leitura direta (Data Hub agrega) ──')
trafego.length = 0
for (const caso of CASOS) {
  let direta
  try { direta = soColunas(caso, await roda(caso, K.direta), K.direta) } catch (e) { direta = { erro: e.message } }
  const a = JSON.stringify(normaliza(copia[caso.nome]))
  const b = JSON.stringify(normaliza(direta))
  check(`igual ao modo cópia: ${caso.nome}`, a === b, `\n      cópia:  ${a.slice(0, 400)}\n      direta: ${b.slice(0, 400)}`)
}
for (const f of VALORES) {
  const v = await wq.runFieldValues({ source: K.direta, field: f })
  check(`valores do filtro de "${f}" iguais`, JSON.stringify(v) === JSON.stringify(valoresCopia[f]), `${JSON.stringify(v)} × ${JSON.stringify(valoresCopia[f])}`)
}
check('nenhuma linha bruta baixada na leitura direta (zero chamadas a /rows)',
  trafego.every((t) => t.metodo !== 'rows'), JSON.stringify(trafego.filter((t) => t.metodo === 'rows')))

const defs = await wq.listSourceDefs()
const defCopia = defs.find((s) => s.key === K.copia)
const defDireta = defs.find((s) => s.key === K.direta)
check('fonte direta aparece no catálogo do Builder', !!defDireta && defDireta.direct === true)
check('com os mesmos campos e tipos da cópia',
  JSON.stringify(defDireta?.fields.map((f) => [f.key, f.kind])) === JSON.stringify(defCopia?.fields.map((f) => [f.key, f.kind])),
  `${JSON.stringify(defDireta?.fields.map((f) => [f.key, f.kind]))} × ${JSON.stringify(defCopia?.fields.map((f) => [f.key, f.kind]))}`)
check('e as mesmas amostras de valor (para a IA)',
  JSON.stringify(defDireta?.fields.map((f) => f.sampleValues ?? f.highCardinality ?? null)) === JSON.stringify(defCopia?.fields.map((f) => f.sampleValues ?? f.highCardinality ?? null)))
check('com o total de linhas do Data Hub', defDireta?.rowCount === PROTOCOLOS.length, String(defDireta?.rowCount))

// Tabela por clique numa coluna: na leitura direta o desempate é pelas demais
// colunas (a paginação no servidor precisa de ordem total, senão uma linha
// pode aparecer em duas páginas); no motor em memória é a ordem de chegada. O
// que se compara é a coluna clicada e o conjunto de linhas.
{
  const spec = (p) => ({ widget: W(p, { type: 'table', columns: ['Cidade', 'Prioridade', 'Base'] }), page: 1, pageSize: 500, tableSort: { column: 'Prioridade', direction: 'desc' } })
  const run = (p) => wq.runWidgetQuery({ ...spec(p), tabFilters: [], relations: [] })
  const c = await run(K.copia)
  const d = await run(K.direta)
  const chave = (row) => JSON.stringify([row.Cidade, row.Prioridade, row.Base])
  check('tabela ordenada por clique: mesma coluna em ordem e mesmo conjunto de linhas',
    JSON.stringify(c.rows.map((x) => x.Prioridade)) === JSON.stringify(d.rows.map((x) => x.Prioridade))
      && JSON.stringify(c.rows.map(chave).sort()) === JSON.stringify(d.rows.map(chave).sort())
      && c.total === d.total)
  check('desempate determinístico (demais colunas em ordem crescente)',
    d.rows.every((row, i) => i === 0 || row.Prioridade !== d.rows[i - 1].Prioridade || chave(d.rows[i - 1]) <= chave(row)))
}

// ─── Filtro por clique ─────────────────────────────────────────────────────
// O clique numa barra/célula vira filtro da guia (src/features/builder/
// clickFilter.ts). Prova, nos dois modos, que o widget filtrado pelo clique dá
// o MESMO número que o item clicado mostrava: por cidade, por mês, por
// hierarquia de datas (via a chave crua do ponto), por campo de outra fonte
// (a relação traz o filtro de volta), por célula de matriz, com Ctrl+clique e
// com medidas nomeadas — simples e fórmula.
console.log('\n── filtro por clique ──')
{
  const cf = await import(pathToFileURL(resolvePath(RAIZ, 'src', 'features', 'builder', 'clickFilter.ts')).href)
  // Os itens clicados no widget 'origem', vistos pelo widget 'alvo'.
  const filtrosDoClique = (itens) => cf.selectionToTabFilters({ origem: itens.map((conds) => ({ conds })) }, 'alvo', (f) => f.field)
  const kpi = async (p, itens, measure = { agg: 'count' }) => (await wq.runWidgetQuery({
    widget: W(p, { id: 'alvo', type: 'kpi', measure }),
    tabFilters: filtrosDoClique(itens), relations: relacao(p), dashboardMeasures: medidas(p),
  })).points[0].value
  const perto = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b))
  for (const [modo, p] of [['cópia', K.copia], ['direta', K.direta]]) {
    const ctx = { source: p, relatedSources: [K.bases] }
    const conds = (dims, ponto) => cf.condsOf(dims, ponto.key ?? ponto.label, ctx)

    const porCidade = await wq.runWidgetQuery({ widget: W(p, { type: 'bar', dimensions: ['Cidade'], measures: [{ agg: 'count' }] }) })
    const [c0, c1] = porCidade.points
    const v0 = await kpi(p, [conds(['Cidade'], c0)])
    check(`${modo}: clique numa cidade dá ao KPI a contagem da barra`, v0 === c0.value, `${v0} × ${c0.value}`)
    const v01 = await kpi(p, [conds(['Cidade'], c0), conds(['Cidade'], c1)])
    check(`${modo}: Ctrl+clique em duas cidades soma as duas`, v01 === c0.value + c1.value, `${v01} × ${c0.value + c1.value}`)

    const porMes = await wq.runWidgetQuery({ widget: W(p, { type: 'bar', dimensions: ['month:Data abertura'], measures: [{ agg: 'count' }] }) })
    const m = porMes.points[Math.floor(porMes.points.length / 2)]
    const vm = await kpi(p, [conds(['month:Data abertura'], m)])
    check(`${modo}: clique num mês (${m.label}) vira período e dá a contagem da barra`, vm === m.value, `${vm} × ${m.value}`)

    const hierDims = ['year:Data abertura', 'month:Data abertura']
    const porHier = await wq.runWidgetQuery({ widget: W(p, { type: 'bar', dimensions: hierDims, measures: [{ agg: 'count' }] }) })
    const h = porHier.points[0]
    check(`${modo}: hierarquia de datas devolve a chave crua junto do rótulo bonito`, !!h.key && h.key !== h.label && /^\d{4} \/ \d{4}-\d{2}$/.test(h.key), JSON.stringify(h))
    const vh = await kpi(p, [conds(hierDims, h)])
    check(`${modo}: clique na hierarquia (${h.label}) dá a contagem da barra`, vh === h.value, `${vh} × ${h.value}`)

    const porRegiao = await wq.runWidgetQuery({ widget: W(p, { type: 'bar', dimensions: [REGIAO], measures: [{ agg: 'count' }] }), relations: relacao(p) })
    const r = porRegiao.points[0]
    const filtroR = filtrosDoClique([conds([REGIAO], r)])[0]
    check(`${modo}: região (campo de Bases) vira filtro em Bases`, filtroR.filter.source === K.bases && filtroR.filter.field === 'Região', JSON.stringify(filtroR.filter))
    const vr = await kpi(p, [conds([REGIAO], r)])
    check(`${modo}: e a relação traz o clique de volta aos protocolos (${r.label})`, vr === r.value, `${vr} × ${r.value}`)

    const matriz = (await wq.runWidgetQuery({ widget: W(p, { type: 'matrix', matrixRows: ['Cidade'], matrixColumns: ['Status'], matrixValue: { agg: 'count' } }) })).matrix
    const linha = matriz.rows[0]
    const coluna = matriz.columns[0]
    const celula = [...cf.condsOf(['Cidade'], linha.key, ctx, wq.MATRIX_SEP), ...cf.condsOf(['Status'], coluna.key, ctx)]
    const vc = await kpi(p, [celula])
    check(`${modo}: célula da matriz (${linha.label} × ${coluna.label}) dá o valor da célula`, vc === linha.values[coluna.key], `${vc} × ${linha.values[coluna.key]}`)

    const medidasPorCidade = await wq.runWidgetQuery({
      widget: W(p, { type: 'bar', dimensions: ['Cidade'], measures: [{ agg: 'count', measureRef: 'm_conc' }, { agg: 'count', measureRef: 'm_tot' }] }),
      dashboardMeasures: medidas(p),
    })
    const mc = medidasPorCidade.points.find((x) => x.label === c0.label)
    const conc = await kpi(p, [conds(['Cidade'], c0)], { agg: 'count', measureRef: 'm_conc' })
    check(`${modo}: medida nomeada com filtro próprio (Concluídos) respeita o clique`, conc === mc.s0, `${conc} × ${mc.s0}`)
    const taxa = await kpi(p, [conds(['Cidade'], c0)], { agg: 'count', measureRef: 'm_taxa' })
    check(`${modo}: medida-fórmula (taxa de conclusão) calcula sobre a cidade clicada`, perto(taxa, (mc.s0 / mc.s1) * 100), `${taxa} × ${(mc.s0 / mc.s1) * 100}`)
  }
}

// ─── O que passa pela rede ─────────────────────────────────────────────────
console.log('\n── tamanho do tráfego ──')
const grande = nova('Grande (direta)', 'grande', 'direct')
const kGrande = lake.sourceKey(grande.id)
trafego.length = 0
const porMes = await wq.runWidgetQuery({ widget: W(kGrande, { type: 'line', dimensions: ['month:Data'], measures: [{ agg: 'count' }, { agg: 'avg', field: 'Valor' }] }) })
const bytes = trafego.reduce((s, t) => s + t.bytes, 0)
check('120 mil linhas viram 15 pontos', porMes.points.length === 15 && porMes.points.reduce((s, x) => s + x.value, 0) > 0)
check(`e atravessam a rede em poucos KB (${(bytes / 1024).toFixed(1)} KB, a tabela inteira teria ~${(JSON.stringify(GRANDE).length / 1048576).toFixed(0)} MB)`, bytes < 10_000)
trafego.length = 0
await wq.runWidgetQuery({ widget: W(kGrande, { type: 'line', dimensions: ['month:Data'], measures: [{ agg: 'count' }, { agg: 'avg', field: 'Valor' }] }) })
check('o mesmo widget de novo sai do cache (nenhuma ida ao Data Hub)', trafego.length === 0, `${trafego.length} chamada(s)`)

// ─── Data Hub de antes (sem a consulta pública) ────────────────────────────
console.log('\n── Data Hub sem a consulta pública ──')
const antigo = nova('Antigo (direta)', 'antigo', 'direct')
let erroAntigo = ''
try { await wq.runWidgetQuery({ widget: W(lake.sourceKey(antigo.id), { type: 'kpi' }) }) } catch (e) { erroAntigo = e.message }
check('erro diz que falta a consulta direta no Data Hub e o que fazer', /consulta direta/i.test(erroAntigo) && /Cópia local/.test(erroAntigo), erroAntigo)

// ─── ETL ───────────────────────────────────────────────────────────────────
console.log('\n── ETL ──')
const grandeCopia = nova('Grande (cópia)', 'grande', 'copy')
// Assíncrono de propósito: o Data Hub falso roda NESTE processo, e um
// spawnSync o deixaria sem poder responder ao ETL — os dois esperariam um ao
// outro até o tempo limite da requisição.
const etl = await new Promise((ok) => {
  const child = spawn(process.execPath, [join(RAIZ, 'scripts', 'fetch-install.mjs')], {
    cwd: dir, env: { ...process.env, ...ENV, DHUB_COPY_MAX_MB: '5', ETL_FORCE_IDS: '' },
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  child.on('close', (status) => ok({ status, out }))
})
const saida = etl.out
check('ciclo do ETL termina sem erro', etl.status === 0, saida.slice(-600))
const snap = JSON.parse(gunzipSync(readFileSync(ENV.SNAPSHOT_PATH)).toString())
const catalogo = new Map(JSON.parse(readFileSync(ENV.LAKEHOUSE_SOURCES_PATH, 'utf8')).map((s) => [s.id, s]))
check('fonte direta não entra no snapshot', !(K.direta in snap.data) && !(kGrande in snap.data))
check('e ganha o total de linhas do Data Hub no catálogo, sem erro',
  catalogo.get(protDireta.id)?.rowCount === PROTOCOLOS.length && !catalogo.get(protDireta.id)?.lastError
    && catalogo.get(grande.id)?.rowCount === GRANDE.length, JSON.stringify(catalogo.get(protDireta.id)))
check('fonte copiada grande demais vira erro NELA, com a saída sugerida',
  /Grande demais para cópia local.*Direto no Data Hub/.test(catalogo.get(grandeCopia.id)?.lastError ?? '') && !(lake.sourceKey(grandeCopia.id) in snap.data),
  catalogo.get(grandeCopia.id)?.lastError)
check('e não congela as outras: as fontes copiadas pequenas foram gravadas',
  snap.data[K.copia]?.length === PROTOCOLOS.length && snap.data[K.bases]?.length === BASES.length)
check('a grande demais não volta a ser baixada a cada ciclo (fica com a hora da tentativa)', !!catalogo.get(grandeCopia.id)?.lastRunAt)
check('fonte direta num Data Hub sem a consulta pública vira erro claro na fonte',
  /consulta direta/i.test(catalogo.get(antigo.id)?.lastError ?? ''), catalogo.get(antigo.id)?.lastError)

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${total - falhas}/${total} verificações ok.`)
process.exit(falhas ? 1 : 0)
