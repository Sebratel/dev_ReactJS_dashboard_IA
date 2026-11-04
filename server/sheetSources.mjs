// ─────────────────────────────────────────────────────────────────────────
// Catálogo de planilhas do Google Sheets cadastradas pelos próprios usuários
// — qualquer usuário autenticado pode colar um link e usar as colunas da
// planilha em qualquer widget, como se fosse mais uma fonte. Persistido em
// data/sheetSources.json, mesmo padrão de arquivo único já usado em
// accessLog.mjs/lakehouseSources.mjs.
//
// É a fonte para dado que ninguém vai publicar no Data Hub (uma lista mantida
// à mão, um de-para): dado corporativo entra pelo barramento, ver
// server/lakehouseSources.mjs.
//
// Cada entrada: { id, label, url, spreadsheetId, sheetName (aba — null = a
// 1ª), createdBy, createdAt, updatedBy, updatedAt, cache }. `cache` guarda o
// ÚLTIMO resultado bom { rows, fetchedAt } — não há refresh automático em
// segundo plano (não há token de usuário disponível fora de uma requisição),
// então os dados atualizam sozinhos sempre que alguém com acesso à planilha
// abre um widget que a usa e o cache expira (ver resolveSheetRows).
//
// A fonte, pro resto do motor de widgets (widgetQuery.mjs), é identificada
// como `sheet:<id>` — o prefixo evita qualquer colisão com ids de query SQL
// e deixa a dispatch (SQL vs. planilha) inequívoca a partir só da string.
// ─────────────────────────────────────────────────────────────────────────
import { logger } from './logger.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { extractSpreadsheetId, fetchSheetRows } from './googleSheets.mjs'

const STORE_PATH = process.env.SHEET_SOURCES_PATH
  ? resolve(process.env.SHEET_SOURCES_PATH)
  : resolve(process.cwd(), 'data/sheetSources.json')

export const SOURCE_PREFIX = 'sheet:'
// Planilha é dado mantido manualmente — não precisa da agressividade de
// atualização de uma fonte SQL; 5 min equilibra "abrir a dashboard já vê o
// que mudou há pouco" com "não bater na API do Google a cada widget/render".
export const CACHE_TTL_MS = 5 * 60 * 1000

export function sourceKey(id) {
  return `${SOURCE_PREFIX}${id}`
}

export function isSheetSource(source) {
  return typeof source === 'string' && source.startsWith(SOURCE_PREFIX)
}

export function sheetSourceId(source) {
  return source.slice(SOURCE_PREFIX.length)
}

function load() {
  if (!existsSync(STORE_PATH)) return []
  try {
    const list = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    logger.error(`[sheet-sources] arquivo corrompido (${e.message}) — tratando como vazio`)
    return []
  }
}

function persist(list) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8')
}

function genId() {
  return `sh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

// Metadados só (sem as rows do cache) — é o que alimenta a lista de
// gerenciamento no editor de widget.
export function listSheetSources() {
  return load().map(({ cache, ...rest }) => ({ ...rest, hasCache: !!cache, rowCount: cache?.rows?.length ?? null, fetchedAt: cache?.fetchedAt ?? null }))
}

export function getSheetSource(id) {
  return load().find((s) => s.id === id) ?? null
}

function validateLabelUrl({ label, url }) {
  if (!label || !label.trim()) throw new Error('Dê um nome pra planilha.')
  extractSpreadsheetId(url) // já lança um erro claro se o link for inválido
}

export function createSheetSource({ label, url, sheetName }, userEmail) {
  validateLabelUrl({ label, url })
  const spreadsheetId = extractSpreadsheetId(url)
  const list = load()
  const now = new Date().toISOString()
  const entry = {
    id: genId(), label: label.trim(), url: String(url).trim(), spreadsheetId, sheetName: sheetName || null,
    createdBy: userEmail ?? null, createdAt: now, updatedBy: userEmail ?? null, updatedAt: now,
    cache: null,
  }
  persist([...list, entry])
  return entry
}

export function updateSheetSource(id, patch, userEmail) {
  const list = load()
  const idx = list.findIndex((s) => s.id === id)
  if (idx === -1) throw new Error(`Planilha "${id}" não encontrada.`)
  const merged = { ...list[idx] }
  if (patch.label !== undefined) merged.label = patch.label
  if (patch.url !== undefined) {
    merged.url = String(patch.url).trim()
    merged.spreadsheetId = extractSpreadsheetId(patch.url)
    merged.cache = null // link mudou — cache antigo não vale mais
  }
  if (patch.sheetName !== undefined) {
    merged.sheetName = patch.sheetName || null
    merged.cache = null
  }
  validateLabelUrl(merged)
  merged.label = merged.label.trim()
  merged.updatedAt = new Date().toISOString()
  merged.updatedBy = userEmail ?? null
  const next = [...list]
  next[idx] = merged
  persist(next)
  return merged
}

// Só quem cadastrou (ou um admin) pode remover — qualquer usuário autenticado
// pode CRIAR uma planilha nova, mas não apagar a de outra pessoa.
export function deleteSheetSource(id, actorEmail, actorIsAdmin) {
  const list = load()
  const entry = list.find((s) => s.id === id)
  if (!entry) throw new Error(`Planilha "${id}" não encontrada.`)
  if (!actorIsAdmin && entry.createdBy !== actorEmail) {
    throw new Error('Só quem cadastrou esta planilha (ou um administrador) pode removê-la.')
  }
  persist(list.filter((s) => s.id !== id))
}

// Devolve as rows da planilha — do cache, se ainda fresco, ou buscando ao
// vivo (usando o access_token OAuth de QUEM está fazendo a requisição atual)
// quando expirado/ausente. Sem token disponível (ou se a busca ao vivo
// falhar), cai pro último cache bom que existir — só lança erro se nunca
// houve nenhum fetch bem-sucedido.
export async function resolveSheetRows(id, { accessToken, force = false } = {}) {
  const list = load()
  const idx = list.findIndex((s) => s.id === id)
  if (idx === -1) throw new Error(`Planilha "${id}" não encontrada.`)
  const entry = list[idx]
  const fresh = entry.cache && Date.now() - entry.cache.fetchedAt < CACHE_TTL_MS
  if (fresh && !force) return entry.cache.rows

  if (!accessToken) {
    if (entry.cache) return entry.cache.rows
    throw new Error(`Planilha "${entry.label}" ainda não foi carregada — abra um widget que a use enquanto estiver logado.`)
  }

  try {
    const { rows } = await fetchSheetRows({ spreadsheetId: entry.spreadsheetId, sheetName: entry.sheetName }, accessToken)
    const next = [...list]
    next[idx] = { ...entry, cache: { rows, fetchedAt: Date.now() } }
    persist(next)
    return rows
  } catch (e) {
    if (entry.cache) return entry.cache.rows
    throw e
  }
}
