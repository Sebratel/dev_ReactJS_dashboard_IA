// ─────────────────────────────────────────────────────────────────────────
// Fontes do Data Hub (lakehouse_sebratel) — a fonte de dados PRINCIPAL do
// Builder, ao lado das planilhas do Google (server/sheetSources.mjs).
//
// O lakehouse é o BARRAMENTO: cadastra-se aqui um `dataset` já publicado lá
// mais um token de acesso próprio, e este projeto só consome a API pública de
// leitura — nada é escrito no lakehouse, e nenhuma credencial de banco é
// necessária. Existia antes um catálogo de queries SQL que batia direto no
// Postgres do ERP e no MariaDB; manter os dois caminhos consumia duas
// plataformas grandes pela mesma informação, então o SQL foi removido e este
// módulo passou a ser o caminho único para dado corporativo.
//
// Duas formas de ler uma fonte (`readMode`):
//
//   'direct' — DIRETO NO DATA HUB, o padrão das fontes novas. Nada é copiado:
//              cada widget vira uma consulta agregada lá (POST /query, ver
//              server/datahubQuery.mjs e server/directWidgetQuery.mjs) e só o
//              resultado atravessa a rede. É o que deixa uma tabela de
//              milhões de linhas, ou de centenas de colunas, ser usada aqui:
//              copiar tudo para a memória da API não para em pé com isso.
//   'copy'   — CÓPIA LOCAL, o jeito de antes: o ETL baixa a tabela inteira
//              para o snapshot e o motor em memória agrega aqui. Continua
//              servindo a tabela pequena que precisa cruzar campo a campo com
//              outra fonte. Fonte cadastrada antes da leitura direta existir
//              não tem o campo e segue copiada até alguém trocar na tela.
//
//   GET <baseUrl>/api/public/v1/datasets/<slug>/rows?limit=&offset=   (cópia)
//   → { dataset, total, limit, offset, rows: [...] }
//   POST <baseUrl>/api/public/v1/datasets/<slug>/query               (direta)
//   corpo: QueryDef do Data Hub → { dataset, columns, rows, total, tookMs }
//   header X-Api-Token: <token> nas duas  (evita o token no log de acesso)
//
// Cada entrada: { id, label, baseUrl, datasetSlug, tokenEnc, tokenHint,
// enabled, readMode: 'direct'|'copy', refreshMode: 'realtime'|'scheduled',
// refreshMinutes, lastRunAt, rowCount, rowTotal, lastError, lastErrorAt,
// folderIds, createdBy, createdAt, updatedBy, updatedAt }. Persistido em
// data/lakehouseSources.json, mesmo padrão de arquivo único de
// accessLog.mjs/sheetSources.mjs.
//
// O token NUNCA fica em claro no disco (ver server/secretBox.mjs) e NUNCA
// volta pro navegador — a UI recebe só `tokenHint` ("dhub_…6T97"), o
// suficiente pra reconhecer qual token está ali.
//
// Diferente das planilhas (que só atualizam dentro de uma requisição, porque
// dependem do token OAuth de quem está logado), o token daqui é da própria
// aplicação — então o ciclo do ETL (scripts/fetch-install.mjs) cuida da
// fonte em segundo plano, no par realtime/agendada configurável por fonte: na
// CÓPIA ele baixa as linhas para o snapshot (chave `dhub:<id>`, e dali em
// diante o motor de widgets não sabe que aquela fonte veio de uma API HTTP);
// na DIRETA ele só confere que o Data Hub responde e anota o total de linhas.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { encryptSecret, decryptSecret, maskSecret } from './secretBox.mjs'

const STORE_PATH = process.env.LAKEHOUSE_SOURCES_PATH
  ? resolve(process.env.LAKEHOUSE_SOURCES_PATH)
  : resolve(process.cwd(), 'data/lakehouseSources.json')

export const SOURCE_PREFIX = 'dhub:'

// Base sugerida no cadastro — o usuário pode apontar pra outra instância do
// Data Hub, mas na prática é sempre esta.
export const DEFAULT_BASE_URL = process.env.DHUB_BASE_URL || 'https://data-hub.sebratel.net.br'

// O Data Hub CAPA em 10 mil linhas por página, mesmo que você peça mais — e
// ecoa no corpo o `limit` que você pediu, não o que ele aplicou. Medido contra
// a instância real: limit=20000 e limit=60000 devolvem 10000 linhas as duas.
// Por isso o padrão é 10 mil (pedir mais só gasta round-trip) e por isso o fim
// da paginação é decidido pelo `total`, nunca pelo tamanho da página — ver
// fetchDatasetRows.
const PAGE_SIZE = Math.min(100_000, Math.max(1_000, Number(process.env.DHUB_PAGE_SIZE) || 10_000))
// Teto de linhas por fonte — não é pra limitar dataset legítimo,
// é pra conter um caso patológico (um dataset gigante por engano).
export const MAX_ROWS = Math.max(1_000, Number(process.env.DHUB_MAX_ROWS) || 500_000)
// Trava anti-loop: mesmo que a API responda de um jeito inesperado (sempre
// devolvendo página cheia, por exemplo), o laço de paginação termina.
const MAX_PAGES = 200
const REQUEST_TIMEOUT_MS = Math.max(10_000, Number(process.env.DHUB_TIMEOUT_MS) || 120_000)
// Consulta de painel: o Data Hub corta a dele em 30s (DUCK_QUERY_TIMEOUT_MS
// lá); a folga cobre a rede e a fila de vagas do motor.
const QUERY_TIMEOUT_MS = Math.max(5_000, Number(process.env.DHUB_QUERY_TIMEOUT_MS) || 45_000)
// Teto do que UMA fonte copiada pode ocupar no snapshot, em JSON. A API carrega
// o snapshot inteiro na memória e ele ocupa ali umas três vezes o tamanho do
// texto: 359 MB de JSON já passaram de 1,8 GB de memória no container, e a
// memória do Node não aceita um texto acima de ~512 MB. Medido na 1ª página,
// antes de baixar o resto (ver fetchDatasetRows).
export const COPY_MAX_BYTES = Math.max(1, Number(process.env.DHUB_COPY_MAX_MB) || 100) * 1_048_576
export const PREVIEW_ROW_LIMIT = 5
export const DEFAULT_REFRESH_MINUTES = 60

export const READ_MODES = ['direct', 'copy']
// Sem o campo = cadastrada antes da leitura direta existir: segue copiada,
// como sempre foi, até alguém trocar na tela.
export function readModeOf(entry) {
  return entry?.readMode === 'direct' ? 'direct' : 'copy'
}

export function sourceKey(id) {
  return `${SOURCE_PREFIX}${id}`
}

export function isLakehouseSource(source) {
  return typeof source === 'string' && source.startsWith(SOURCE_PREFIX)
}

export function lakehouseSourceId(source) {
  return source.slice(SOURCE_PREFIX.length)
}

function load() {
  if (!existsSync(STORE_PATH)) return []
  try {
    const list = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    console.error(`[lakehouse] arquivo corrompido (${e.message}) — tratando como vazio`)
    return []
  }
}

function persist(list) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8')
}

function genId() {
  return `dh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

// ─── Validação ─────────────────────────────────────────────────────
function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim() || DEFAULT_BASE_URL
  let url
  try { url = new URL(raw) } catch { throw new Error(`Endereço inválido: "${raw}". Use algo como ${DEFAULT_BASE_URL}.`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('O endereço do Data Hub precisa começar com http:// ou https://.')
  }
  // Guarda só a origem: o caminho da API pública é montado por este módulo,
  // então colar a URL inteira do curl (com /api/public/v1/... e ?token=) também
  // funciona — o excedente é descartado em vez de duplicar o caminho.
  return url.origin
}

// Aceita tanto o slug puro ("clientes-cancelados") quanto a URL inteira
// copiada do curl — nesse caso o slug é extraído do caminho.
function normalizeSlug(datasetSlug) {
  let raw = String(datasetSlug ?? '').trim()
  const fromUrl = /\/datasets\/([^/?#]+)/.exec(raw)
  if (fromUrl) raw = decodeURIComponent(fromUrl[1])
  raw = raw.replace(/^\/+|\/+$/g, '')
  if (!raw) throw new Error('Informe o dataset (ex.: clientes-cancelados).')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(raw)) {
    throw new Error(`Dataset inválido: "${raw}". Use o slug publicado no Data Hub, ex.: clientes-cancelados.`)
  }
  return raw
}

// Aceita o token puro ou a URL inteira do curl (extrai do ?token=).
function normalizeToken(token) {
  const raw = String(token ?? '').trim()
  if (!raw) throw new Error('Informe o token de acesso ao Data Hub.')
  if (/^https?:\/\//i.test(raw)) {
    try {
      const fromUrl = new URL(raw).searchParams.get('token')
      if (fromUrl) return fromUrl.trim()
    } catch { /* não é URL válida — cai no tratamento de token puro */ }
  }
  if (/\s/.test(raw)) throw new Error('O token não pode conter espaços.')
  return raw
}

// Vazio = não mexe (o chamador decide o padrão).
function normalizeReadMode(mode) {
  if (mode === undefined || mode === null || mode === '') return null
  if (!READ_MODES.includes(mode)) {
    throw new Error('Modo de leitura inválido — use "direct" (direto no Data Hub) ou "copy" (cópia local).')
  }
  return mode
}

// ─── Leitura do catálogo ───────────────────────────────────────────
// Sem tokenEnc: é o que vai pro navegador. `tokenHint` é o que a UI mostra.
// `readMode` sempre preenchido, mesmo na fonte antiga que não tem o campo.
function publicView({ tokenEnc, ...rest }) {
  return { ...rest, readMode: readModeOf(rest), hasToken: !!tokenEnc }
}

export function listLakehouseSources() {
  return load().map(publicView)
}

export function getLakehouseSource(id) {
  return load().find((s) => s.id === id) ?? null
}

// Só o servidor chama — devolve a entrada com o token já decifrado, pronto
// pra usar numa requisição. Nunca exponha o retorno disso numa rota.
export function resolveCredentials(id) {
  const entry = getLakehouseSource(id)
  if (!entry) throw new Error(`Fonte "${id}" não encontrada.`)
  if (!entry.tokenEnc) throw new Error(`A fonte "${entry.label}" está sem token — edite e informe um.`)
  let token
  try {
    token = decryptSecret(entry.tokenEnc)
  } catch (e) {
    // A saída, neste caso, é recadastrar o token — a mensagem de secretBox é
    // genérica porque ele também guarda as sessões de login.
    throw new Error(`${e.message} Edite a fonte "${entry.label}" e informe o token novamente.`)
  }
  return { baseUrl: entry.baseUrl, datasetSlug: entry.datasetSlug, token }
}

// ─── Escrita do catálogo ───────────────────────────────────────────
export function createLakehouseSource({ label, baseUrl, datasetSlug, token, enabled, readMode }, userEmail) {
  if (!label || !String(label).trim()) throw new Error('Dê um nome pra esta fonte.')
  const plainToken = normalizeToken(token)
  const now = new Date().toISOString()
  const entry = {
    id: genId(),
    label: String(label).trim(),
    baseUrl: normalizeBaseUrl(baseUrl),
    datasetSlug: normalizeSlug(datasetSlug),
    tokenEnc: encryptSecret(plainToken),
    tokenHint: maskSecret(plainToken),
    enabled: enabled ?? true,
    readMode: normalizeReadMode(readMode) ?? 'direct',
    refreshMode: 'scheduled',
    refreshMinutes: DEFAULT_REFRESH_MINUTES,
    lastRunAt: null,
    rowCount: null,
    lastError: null,
    lastErrorAt: null,
    folderIds: null,
    createdBy: userEmail ?? null,
    createdAt: now,
    updatedBy: userEmail ?? null,
    updatedAt: now,
  }
  persist([...load(), entry])
  return publicView(entry)
}

// `token` ausente/vazio no patch = mantém o token atual (a UI nunca recebe o
// token de volta, então não teria como reenviá-lo a cada edição).
export function updateLakehouseSource(id, patch, userEmail) {
  const list = load()
  const idx = list.findIndex((s) => s.id === id)
  if (idx === -1) throw new Error(`Fonte "${id}" não encontrada.`)
  const merged = { ...list[idx] }
  if (patch.label !== undefined) {
    if (!String(patch.label).trim()) throw new Error('Dê um nome pra esta fonte.')
    merged.label = String(patch.label).trim()
  }
  if (patch.baseUrl !== undefined) merged.baseUrl = normalizeBaseUrl(patch.baseUrl)
  if (patch.datasetSlug !== undefined) merged.datasetSlug = normalizeSlug(patch.datasetSlug)
  if (patch.readMode !== undefined) merged.readMode = normalizeReadMode(patch.readMode) ?? readModeOf(merged)
  if (patch.token) {
    const plainToken = normalizeToken(patch.token)
    merged.tokenEnc = encryptSecret(plainToken)
    merged.tokenHint = maskSecret(plainToken)
  }
  merged.updatedAt = new Date().toISOString()
  merged.updatedBy = userEmail ?? null
  const next = [...list]
  next[idx] = merged
  persist(next)
  return publicView(merged)
}

// Só quem cadastrou (ou um admin) remove — mesma regra das planilhas.
export function deleteLakehouseSource(id, actorEmail, actorIsAdmin) {
  const list = load()
  const entry = list.find((s) => s.id === id)
  if (!entry) throw new Error(`Fonte "${id}" não encontrada.`)
  if (!actorIsAdmin && entry.createdBy !== actorEmail) {
    throw new Error('Só quem cadastrou esta fonte (ou um administrador) pode removê-la.')
  }
  persist(list.filter((s) => s.id !== id))
}

function patchEntry(id, fields, userEmail) {
  const list = load()
  const idx = list.findIndex((s) => s.id === id)
  if (idx === -1) throw new Error(`Fonte "${id}" não encontrada.`)
  const next = [...list]
  next[idx] = {
    ...next[idx], ...fields,
    updatedAt: new Date().toISOString(),
    updatedBy: userEmail ?? next[idx].updatedBy ?? null,
  }
  persist(next)
  return publicView(next[idx])
}

// Desativada = não é buscada no próximo ciclo do ETL e some do catálogo de
// fontes do Builder (as linhas deixam de entrar no snapshot).
export function setLakehouseEnabled(id, enabled, userEmail) {
  return patchEntry(id, { enabled: !!enabled }, userEmail)
}

// Mesma semântica das queries SQL: 'realtime' busca em todo ciclo do ETL,
// 'scheduled' só a cada `minutes`. Dataset de lakehouse costuma ser
// materializado de tempo em tempo, então o padrão no cadastro é 'scheduled'.
export function setLakehouseRefresh(id, { mode, minutes }, userEmail) {
  if (mode !== 'realtime' && mode !== 'scheduled') {
    throw new Error('Modo inválido — use "realtime" ou "scheduled".')
  }
  const refreshMinutes = mode === 'scheduled' ? Number(minutes) : undefined
  if (mode === 'scheduled' && !(refreshMinutes > 0)) {
    throw new Error('Informe um intervalo (em minutos) maior que zero para a atualização agendada.')
  }
  const current = getLakehouseSource(id)
  if (!current) throw new Error(`Fonte "${id}" não encontrada.`)
  return patchEntry(id, {
    refreshMode: mode,
    refreshMinutes: mode === 'scheduled' ? refreshMinutes : (current.refreshMinutes ?? DEFAULT_REFRESH_MINUTES),
  }, userEmail)
}

// Em quais pastas esta fonte aparece no Builder — null = todas. Mesma
// convenção de `folder.accessEmails` em workspace.mjs.
export function setLakehouseFolders(id, folderIds, userEmail) {
  if (folderIds !== null && !Array.isArray(folderIds)) {
    throw new Error('folderIds inválido — use null (todas as pastas) ou uma lista de ids.')
  }
  return patchEntry(id, {
    folderIds: folderIds === null ? null : Array.from(new Set(folderIds.map(String))),
  }, userEmail)
}

// Chamado pelo ETL depois de cada ciclo — um write só pro lote inteiro.
// `error` null limpa a falha anterior (voltou a funcionar). `rowTotal` é o
// total que o Data Hub informou: maior que `rowCount` = a cópia foi cortada
// no teto de linhas (MAX_ROWS), e a tela precisa dizer isso.
export function recordLakehouseRuns(runs) {
  if (!runs.length) return
  const list = load()
  const byId = new Map(runs.map((r) => [r.id, r]))
  persist(list.map((s) => {
    const run = byId.get(s.id)
    if (!run) return s
    return {
      ...s,
      lastRunAt: run.lastRunAt ?? s.lastRunAt,
      rowCount: run.rowCount ?? s.rowCount,
      rowTotal: run.rowTotal ?? run.rowCount ?? s.rowTotal ?? null,
      lastError: run.error ?? null,
      lastErrorAt: run.error ? new Date().toISOString() : null,
    }
  }))
}

// ─── Acesso à API pública do Data Hub ──────────────────────────────
// O Data Hub de antes da consulta pública não tem POST /query: quem responde é
// o roteador da aplicação dele ("Rota não encontrada."), não o conjunto.
export class QueryUnavailableError extends Error {}

// A fonte copiada não cabe no snapshot — erro da própria fonte, não do ciclo.
export class CopyTooLargeError extends Error {}

function apiUrl({ baseUrl, datasetSlug }, action) {
  return new URL(`/api/public/v1/datasets/${encodeURIComponent(datasetSlug)}/${action}`, baseUrl)
}

function networkError(e, url, timeoutMs) {
  const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    ? `sem resposta em ${Math.round(timeoutMs / 1000)}s`
    : (e?.message || 'falha de rede')
  return new Error(`Não foi possível falar com o Data Hub em ${url.origin} (${reason}).`)
}

// Resposta HTTP de erro → Error com a mensagem que ajuda.
//
// A API pública responde { error: "..." } — a mensagem de lá é bem mais útil
// que "HTTP 403" (token sem acesso ao dataset, token revogado, limite por
// minuto do token, campo sensível etc.).
//
// E quando NÃO vem JSON, isso é a informação mais importante da falha:
// significa que quem respondeu não foi o Data Hub, e sim algo no caminho
// (proxy da empresa, firewall, um nginx errado). Antes essa pista era engolida
// e a tela dizia "token recusado" — mandando investigar o token, que podia
// estar perfeito. Agora o corpo cru aparece.
async function httpFailure(res, url, datasetSlug) {
  const corpo = await res.text().catch(() => '')
  let detail = ''
  try { detail = JSON.parse(corpo)?.error || '' } catch { /* corpo não-JSON */ }

  if (!detail) {
    const trecho = corpo.replace(/\s+/g, ' ').trim().slice(0, 160)
    console.error(`[data-hub] ${res.status} em ${url.origin} sem JSON de erro — corpo: ${trecho || '(vazio)'}`)
    return new Error(
      `O Data Hub respondeu ${res.status} ao buscar "${datasetSlug}", mas o corpo não é JSON — ` +
      'sinal de que quem respondeu não foi ele, e sim algo no caminho (proxy ou firewall da rede onde a API roda). ' +
      (trecho ? `Começo da resposta: "${trecho}".` : 'A resposta veio vazia.'),
    )
  }
  if (res.status === 404 && url.pathname.endsWith('/query') && /rota não encontrada/i.test(detail)) {
    return new QueryUnavailableError(
      `O Data Hub em ${url.origin} ainda não tem a consulta direta (POST /api/public/v1/datasets/:slug/query). ` +
      'Atualize o Data Hub, ou mude esta fonte para "Cópia local" enquanto isso.',
    )
  }
  // Com a mensagem de lá, o status ainda importa pra saber se é credencial
  // (401), permissão (403), dataset (404) ou limite do token (429).
  return new Error(`${detail} (HTTP ${res.status} em ${url.origin})`)
}

async function requestPage({ baseUrl, datasetSlug, token }, { limit, offset }) {
  const url = apiUrl({ baseUrl, datasetSlug }, 'rows')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))
  let res
  try {
    res = await fetch(url, {
      // O token vai no header, não na query string: assim ele não aparece no
      // log de acesso do lakehouse nem em proxy no caminho.
      headers: { 'X-Api-Token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw networkError(e, url, REQUEST_TIMEOUT_MS)
  }
  if (!res.ok) throw await httpFailure(res, url, datasetSlug)
  const body = await res.json()
  if (!Array.isArray(body?.rows)) {
    throw new Error(`Resposta inesperada do Data Hub para "${datasetSlug}" (sem a lista "rows").`)
  }
  return body
}

// Leitura direta: um QueryDef do Data Hub (o mesmo contrato dos painéis de lá)
// executado no lake, devolvendo só o resultado. Quem chama com cache, fila e
// tradução de widget é server/datahubQuery.mjs — isto aqui é só o HTTP.
export async function queryDataset({ baseUrl, datasetSlug, token }, def) {
  const url = apiUrl({ baseUrl, datasetSlug }, 'query')
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Api-Token': token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    })
  } catch (e) {
    throw networkError(e, url, QUERY_TIMEOUT_MS)
  }
  if (!res.ok) throw await httpFailure(res, url, datasetSlug)
  const body = await res.json()
  if (!Array.isArray(body?.rows)) {
    throw new Error(`Resposta inesperada do Data Hub para "${datasetSlug}" (sem a lista "rows").`)
  }
  return body
}

const mb = (bytes) => (bytes / 1_048_576).toLocaleString('pt-BR', { maximumFractionDigits: 0 })

// Busca o dataset inteiro, paginando por limit/offset até fechar o `total`
// informado pela própria API. Devolve { rows, total, pages }.
//
// `maxBytes`: a 1ª página dá o tamanho médio da linha, e com o `total` já dá
// para saber se o resto cabe — sem baixar nada além dela. Não cabendo, é
// CopyTooLargeError: antes, a fonte grande era baixada inteira a cada ciclo e
// derrubava o processo do ETL na hora de gravar, sem erro em lugar nenhum, e
// as fontes pequenas paravam de atualizar junto.
export async function fetchDatasetRows(credentials, { maxRows = MAX_ROWS, maxBytes = Infinity } = {}) {
  const pages = []
  let fetched = 0
  let total = null
  let pageCount = 0

  while (pageCount < MAX_PAGES) {
    const want = Math.min(PAGE_SIZE, maxRows - fetched)
    if (want <= 0) break
    const body = await requestPage(credentials, { limit: want, offset: fetched })
    pageCount += 1
    if (typeof body.total === 'number') total = body.total
    const got = body.rows.length
    // Página vazia é o único fim inequívoco: acabaram as linhas, ou o offset
    // passou do fim.
    if (got === 0) break
    if (pageCount === 1 && Number.isFinite(maxBytes)) {
      const perRow = JSON.stringify(body.rows).length / got
      const rows = Math.min(total ?? got, maxRows)
      const estimate = perRow * rows
      if (estimate > maxBytes) {
        const cols = Object.keys(body.rows[0] ?? {}).length
        throw new CopyTooLargeError(
          `Grande demais para cópia local: ${rows.toLocaleString('pt-BR')} linhas × ${cols} colunas ≈ ${mb(estimate)} MB ` +
          `(o teto da cópia é ${mb(maxBytes)} MB). Mude a fonte para "Direto no Data Hub" — os painéis passam a ` +
          'consultar o Data Hub em vez de baixar a tabela.',
        )
      }
    }
    pages.push(body.rows)
    fetched += got

    if (total != null) {
      // Quem decide o fim é o `total` informado pela própria API. NÃO dá pra
      // usar "página menor que o pedido" como sinal: o Data Hub capa em 10 mil
      // por página e devolve menos que o pedido sem que os dados tenham
      // acabado — tratar isso como fim truncava todo dataset grande.
      if (fetched >= Math.min(total, maxRows)) break
    } else if (got < want) {
      // Sem `total`, só aí o tamanho da página serve de pista.
      break
    }
  }

  if (pageCount >= MAX_PAGES) {
    console.warn(`[lakehouse] ${credentials.datasetSlug}: parei em ${MAX_PAGES} páginas (${fetched} linhas) — teto de segurança da paginação`)
  }
  return { rows: pages.flat(), total: total ?? fetched, pages: pageCount }
}

// Teste de conexão do cadastro: uma página curtinha só pra provar que o
// token abre o dataset e mostrar as colunas que vão aparecer no Builder.
// Recebe as credenciais em claro (a tela acabou de digitá-las) — não depende
// de a fonte já existir no catálogo.
export async function previewDataset({ baseUrl, datasetSlug, token }) {
  const credentials = {
    baseUrl: normalizeBaseUrl(baseUrl),
    datasetSlug: normalizeSlug(datasetSlug),
    token: normalizeToken(token),
  }
  const body = await requestPage(credentials, { limit: PREVIEW_ROW_LIMIT, offset: 0 })
  return {
    dataset: credentials.datasetSlug,
    baseUrl: credentials.baseUrl,
    total: typeof body.total === 'number' ? body.total : null,
    columns: body.rows.length ? Object.keys(body.rows[0]) : [],
    rows: body.rows,
  }
}

// A leitura direta depende de o Data Hub ter a consulta pública (POST /query)
// e de o token alcançar o conjunto por ela. Conferido no teste de conexão, no
// cadastro e na edição: sem isso a fonte entraria "conectada" e todo widget
// dela falharia. Nunca lança — devolve o diagnóstico.
export async function testDirectQuery({ baseUrl, datasetSlug, token }) {
  try {
    const credentials = {
      baseUrl: normalizeBaseUrl(baseUrl),
      datasetSlug: normalizeSlug(datasetSlug),
      token: normalizeToken(token),
    }
    const body = await queryDataset(credentials, { limit: 1 })
    return { available: true, total: typeof body.total === 'number' ? body.total : null, error: null }
  } catch (e) {
    return { available: false, total: null, error: e.message, missingRoute: e instanceof QueryUnavailableError }
  }
}

// Mesma regra de isDue das queries SQL (scripts/fetch-install.mjs), aplicada
// às fontes daqui: realtime sempre vence; scheduled só quando o intervalo
// dela já passou desde a última execução de verdade.
export function isDue(entry, now) {
  if (entry.refreshMode !== 'scheduled') return true
  if (!entry.lastRunAt) return true
  const minutes = Number(entry.refreshMinutes) > 0 ? Number(entry.refreshMinutes) : DEFAULT_REFRESH_MINUTES
  return now - new Date(entry.lastRunAt).getTime() >= minutes * 60_000
}

// Lista crua (com tokenEnc) — só para o ETL, que precisa decifrar.
export function listForEtl() {
  return load()
}
