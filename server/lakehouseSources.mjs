// ─────────────────────────────────────────────────────────────────────────
// Fontes do Data Hub (lakehouse_sebratel) — o terceiro tipo de fonte de dados
// do Builder, ao lado das queries SQL (server/queryCatalog.mjs) e das
// planilhas do Google (server/sheetSources.mjs).
//
// A ideia é o lakehouse funcionar como BARRAMENTO: em vez de cadastrar uma
// query SQL que bate direto no banco de produção, cadastra-se aqui um
// `dataset` já publicado no Data Hub e um token de acesso próprio. Este
// projeto só consome a API pública de leitura de lá — nada é escrito no
// lakehouse, e nenhuma credencial de banco é necessária.
//
//   GET <baseUrl>/api/public/v1/datasets/<slug>/rows?limit=&offset=
//   header X-Api-Token: <token>          (evita o token no log de acesso)
//   → { dataset, total, limit, offset, rows: [...] }
//
// Cada entrada: { id, label, baseUrl, datasetSlug, tokenEnc, tokenHint,
// enabled, refreshMode: 'realtime'|'scheduled', refreshMinutes, lastRunAt,
// rowCount, lastError, lastErrorAt, folderIds, createdBy, createdAt,
// updatedBy, updatedAt }. Persistido em data/lakehouseSources.json, mesmo
// padrão de arquivo único de queryCatalog.mjs/sheetSources.mjs.
//
// O token NUNCA fica em claro no disco (ver server/secretBox.mjs) e NUNCA
// volta pro navegador — a UI recebe só `tokenHint` ("dhub_…6T97"), o
// suficiente pra reconhecer qual token está ali.
//
// Diferente das planilhas (que só atualizam dentro de uma requisição, porque
// dependem do token OAuth de quem está logado), o token daqui é da própria
// aplicação — então a fonte entra no ciclo do ETL (scripts/fetch-install.mjs)
// e é buscada em segundo plano, exatamente como uma query SQL, com o mesmo
// par realtime/agendada. As linhas caem no snapshot sob a chave `dhub:<id>`,
// e dali em diante o motor de widgets (server/widgetQuery.mjs) não sabe nem
// precisa saber que aquela fonte veio de uma API em vez de um SELECT.
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

// A API pública aceita até 100k linhas por página; 50k é folgado o bastante
// pra trazer um dataset grande em poucas idas e ainda manter cada resposta
// num tamanho sensato de memória/JSON.
const PAGE_SIZE = Math.min(100_000, Math.max(1_000, Number(process.env.DHUB_PAGE_SIZE) || 50_000))
// Teto de linhas por fonte — mesmo espírito do MAX_ETL_ROWS das queries SQL:
// não é pra limitar dataset legítimo, é pra conter um caso patológico.
export const MAX_ROWS = Math.max(1_000, Number(process.env.DHUB_MAX_ROWS) || 500_000)
// Trava anti-loop: mesmo que a API responda de um jeito inesperado (sempre
// devolvendo página cheia, por exemplo), o laço de paginação termina.
const MAX_PAGES = 200
const REQUEST_TIMEOUT_MS = Math.max(10_000, Number(process.env.DHUB_TIMEOUT_MS) || 120_000)
export const PREVIEW_ROW_LIMIT = 5
export const DEFAULT_REFRESH_MINUTES = 60

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

// ─── Leitura do catálogo ───────────────────────────────────────────
// Sem tokenEnc: é o que vai pro navegador. `tokenHint` é o que a UI mostra.
function publicView({ tokenEnc, ...rest }) {
  return { ...rest, hasToken: !!tokenEnc }
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
export function createLakehouseSource({ label, baseUrl, datasetSlug, token, enabled }, userEmail) {
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
// convenção de setQueryFolders em queryCatalog.mjs.
export function setLakehouseFolders(id, folderIds, userEmail) {
  if (folderIds !== null && !Array.isArray(folderIds)) {
    throw new Error('folderIds inválido — use null (todas as pastas) ou uma lista de ids.')
  }
  return patchEntry(id, {
    folderIds: folderIds === null ? null : Array.from(new Set(folderIds.map(String))),
  }, userEmail)
}

// Chamado pelo ETL depois de cada ciclo — um write só pro lote inteiro.
// `error` null limpa a falha anterior (voltou a funcionar).
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
      lastError: run.error ?? null,
      lastErrorAt: run.error ? new Date().toISOString() : null,
    }
  }))
}

// ─── Acesso à API pública do Data Hub ──────────────────────────────
function rowsUrl({ baseUrl, datasetSlug }, { limit, offset }) {
  const url = new URL(`/api/public/v1/datasets/${encodeURIComponent(datasetSlug)}/rows`, baseUrl)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))
  return url
}

async function requestPage({ baseUrl, datasetSlug, token }, { limit, offset }) {
  const url = rowsUrl({ baseUrl, datasetSlug }, { limit, offset })
  let res
  try {
    res = await fetch(url, {
      // O token vai no header, não na query string: assim ele não aparece no
      // log de acesso do lakehouse nem em proxy no caminho.
      headers: { 'X-Api-Token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `sem resposta em ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
      : (e?.message || 'falha de rede')
    throw new Error(`Não foi possível falar com o Data Hub em ${url.origin} (${reason}).`)
  }
  if (!res.ok) {
    // A API pública responde { error: "..." } — a mensagem de lá é bem mais
    // útil que "HTTP 403" (token sem acesso ao dataset, token revogado etc.).
    let detail = ''
    try { detail = (await res.json())?.error || '' } catch { /* corpo não-JSON */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error(detail || 'Token recusado pelo Data Hub (revogado, expirado ou sem acesso a este dataset).')
    }
    if (res.status === 404) {
      throw new Error(detail || `Dataset "${datasetSlug}" não existe no Data Hub.`)
    }
    throw new Error(detail || `O Data Hub respondeu ${res.status} ao buscar "${datasetSlug}".`)
  }
  const body = await res.json()
  if (!Array.isArray(body?.rows)) {
    throw new Error(`Resposta inesperada do Data Hub para "${datasetSlug}" (sem a lista "rows").`)
  }
  return body
}

// Busca o dataset inteiro, paginando por limit/offset até fechar o `total`
// informado pela própria API. Devolve { rows, total, pages }.
export async function fetchDatasetRows(credentials, { maxRows = MAX_ROWS } = {}) {
  const pages = []
  let fetched = 0
  let total = null
  let pageCount = 0

  while (pageCount < MAX_PAGES) {
    const limit = Math.min(PAGE_SIZE, maxRows - fetched)
    if (limit <= 0) break
    const body = await requestPage(credentials, { limit, offset: fetched })
    pageCount += 1
    if (typeof body.total === 'number') total = body.total
    pages.push(body.rows)
    fetched += body.rows.length
    // Página incompleta = acabou. Página vazia idem (protege contra um
    // `total` maior que a quantidade realmente devolvida).
    if (body.rows.length < limit) break
    if (total != null && fetched >= total) break
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
