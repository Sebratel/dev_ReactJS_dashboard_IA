// ─────────────────────────────────────────────────────────────────────────
// Catálogo único e editável de queries — não há distinção entre "queries do
// sistema" e "queries do usuário": tudo é a mesma lista, com add/editar/
// remover livre. As 12 queries que o projeto já tinha (scripts/queries/
// registry.mjs) servem só de SEED inicial (mesmo padrão de
// dashboardConfig.mjs: sem arquivo salvo, vale o default; ao editar, grava
// data/queries.json e esse passa a valer).
//
// Cada entrada: { id, title, db: 'postgres'|'mariadb', sql, enabled,
// refreshMode: 'realtime'|'scheduled', refreshMinutes, lastRunAt,
// folderIds, updatedAt, updatedBy }.
// `folderIds` (null|string[]) restringe em quais pastas (workspace.mjs) a
// query aparece como fonte no Builder — null/ausente = todas (ver
// setQueryFolders e o filtro em widgetQuery.mjs::listSourceDefs).
// O resultado de CADA query com enabled!==false vira uma fonte de dados no
// Builder, com as colunas reais retornadas pelo SQL (sem mapeamento manual) —
// ver server/widgetQuery.mjs (inferSourceDef). `enabled` ausente (entradas
// antigas, de antes deste campo existir) conta como true — ver setQueryEnabled
// e o filtro em scripts/fetch-install.mjs.
//
// A atualização é POR QUERY, não global: 'realtime' roda em todo ciclo do
// ETL (curto, ver etl-scheduler.mjs); 'scheduled' só roda a cada
// `refreshMinutes`, mantendo o dado da execução anterior nos ciclos em que
// não é a vez dela (ver fetch-install.mjs). `refreshMode` ausente
// (entradas antigas) conta como 'realtime' — mesmo comportamento de sempre.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { QUERIES as SEED_QUERIES } from '../scripts/queries/registry.mjs'

const STORE_PATH = process.env.QUERY_CATALOG_PATH
  ? resolve(process.env.QUERY_CATALOG_PATH)
  : resolve(process.cwd(), 'data/queries.json')

// Alto o bastante para nunca truncar uma query legítima (histórico de
// protocolos já passa de 95k linhas) — existe só para conter uma query
// realmente patológica (ex. SELECT * sem WHERE numa tabela gigante).
export const MAX_ETL_ROWS = 500_000
export const TEST_ROW_LIMIT = 50
export const DEFAULT_REFRESH_MINUTES = 60

// O seed original tem 'sheets' como 3º valor de db (não é SQL executável) —
// só entram no catálogo unificado as queries realmente executáveis.
function seedList() {
  return SEED_QUERIES
    .filter((q) => q.db === 'postgres' || q.db === 'mariadb')
    .map((q) => ({ id: q.id, title: q.title, db: q.db, sql: q.sql, enabled: true, refreshMode: 'realtime' }))
}

export function loadQueryCatalog() {
  if (!existsSync(STORE_PATH)) return { list: seedList(), isDefault: true }
  try {
    const list = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    if (!Array.isArray(list)) throw new Error('formato inválido — esperado um array')
    return { list, isDefault: false }
  } catch (e) {
    console.error(`[query-catalog] arquivo corrompido (${e.message}) — usando o catálogo padrão`)
    return { list: seedList(), isDefault: true }
  }
}

function persist(list) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8')
}

// Guarda de segurança: só leitura. Não é um parser SQL à prova de tudo, mas
// bloqueia o caso comum (escrita acidental) para uma ferramenta interna.
export function assertSafeSelect(sql) {
  const trimmed = String(sql || '').trim()
  if (!trimmed) throw new Error('SQL vazio.')
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Só são permitidas queries de leitura (SELECT ou WITH). Comandos de escrita não são suportados.')
  }
  if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|call\s|merge|exec|execute)\b/i.test(trimmed)) {
    throw new Error('A query contém uma palavra-chave não permitida (apenas leitura é suportada).')
  }
}

function validateEntry({ id, title, db, sql }) {
  if (!id || !/^[a-zA-Z][a-zA-Z0-9_]{2,63}$/.test(id)) {
    throw new Error('Id inválido — use letras/números/underscore, começando com letra (3 a 64 caracteres).')
  }
  if (!title || !title.trim()) throw new Error('Título é obrigatório.')
  if (db !== 'postgres' && db !== 'mariadb') throw new Error('Banco inválido — use "postgres" ou "mariadb".')
  assertSafeSelect(sql)
}

export function createQuery(def, editorEmail) {
  validateEntry(def)
  const { list } = loadQueryCatalog()
  if (list.some((q) => q.id === def.id)) throw new Error(`Já existe uma query com o id "${def.id}".`)
  const entry = {
    id: def.id, title: def.title.trim(), db: def.db, sql: def.sql, enabled: def.enabled ?? true,
    refreshMode: 'realtime', refreshMinutes: DEFAULT_REFRESH_MINUTES, lastRunAt: null, folderIds: null,
    updatedAt: new Date().toISOString(), updatedBy: editorEmail ?? null,
  }
  persist([...list, entry])
  return entry
}

export function updateQuery(id, patch, editorEmail) {
  const { list } = loadQueryCatalog()
  const idx = list.findIndex((q) => q.id === id)
  if (idx === -1) throw new Error(`Query "${id}" não encontrada.`)
  const merged = {
    ...list[idx],
    title: patch.title ?? list[idx].title,
    db: patch.db ?? list[idx].db,
    sql: patch.sql ?? list[idx].sql,
  }
  validateEntry(merged)
  merged.updatedAt = new Date().toISOString()
  merged.updatedBy = editorEmail ?? null
  const next = [...list]
  next[idx] = merged
  persist(next)
  return merged
}

export function deleteQuery(id) {
  const { list } = loadQueryCatalog()
  const next = list.filter((q) => q.id !== id)
  if (next.length === list.length) throw new Error(`Query "${id}" não encontrada.`)
  persist(next)
}

// Ativa/desativa sem reexecutar as validações de SQL/título — troca só o
// enabled. Desativada = não roda no próximo ETL e some do catálogo de fontes
// (widgetQuery.mjs infere as fontes a partir do que está no snapshot).
export function setQueryEnabled(id, enabled, editorEmail) {
  const { list } = loadQueryCatalog()
  const idx = list.findIndex((q) => q.id === id)
  if (idx === -1) throw new Error(`Query "${id}" não encontrada.`)
  const next = [...list]
  next[idx] = { ...next[idx], enabled: !!enabled, updatedAt: new Date().toISOString(), updatedBy: editorEmail ?? next[idx].updatedBy ?? null }
  persist(next)
  return next[idx]
}

// Define o ritmo de atualização de UMA query — 'realtime' (todo ciclo do
// ETL) ou 'scheduled' (só a cada `minutes`). Não mexe em `enabled`: são
// eixos independentes (dá pra ter uma query desativada e agendada ao mesmo
// tempo, por exemplo).
export function setQueryRefresh(id, { mode, minutes }, editorEmail) {
  if (mode !== 'realtime' && mode !== 'scheduled') {
    throw new Error('Modo inválido — use "realtime" ou "scheduled".')
  }
  const refreshMinutes = mode === 'scheduled' ? Number(minutes) : undefined
  if (mode === 'scheduled' && !(refreshMinutes > 0)) {
    throw new Error('Informe um intervalo (em minutos) maior que zero para a atualização agendada.')
  }
  const { list } = loadQueryCatalog()
  const idx = list.findIndex((q) => q.id === id)
  if (idx === -1) throw new Error(`Query "${id}" não encontrada.`)
  const next = [...list]
  next[idx] = {
    ...next[idx],
    refreshMode: mode,
    refreshMinutes: mode === 'scheduled' ? refreshMinutes : (next[idx].refreshMinutes ?? DEFAULT_REFRESH_MINUTES),
    updatedAt: new Date().toISOString(), updatedBy: editorEmail ?? next[idx].updatedBy ?? null,
  }
  persist(next)
  return next[idx]
}

// Define em quais pastas (workspace.mjs) esta query pode aparecer como fonte
// no Builder — `null` (padrão, inclusive pra queries antigas sem esse campo)
// = liberada em todas; um array = só nas pastas listadas. Mesma convenção de
// `folder.accessEmails` em workspace.mjs. Não afeta o ETL nem `enabled` —
// controla só visibilidade como fonte, não execução.
export function setQueryFolders(id, folderIds, editorEmail) {
  if (folderIds !== null && !Array.isArray(folderIds)) {
    throw new Error('folderIds inválido — use null (todas as pastas) ou uma lista de ids.')
  }
  const { list } = loadQueryCatalog()
  const idx = list.findIndex((q) => q.id === id)
  if (idx === -1) throw new Error(`Query "${id}" não encontrada.`)
  const next = [...list]
  next[idx] = {
    ...next[idx],
    folderIds: folderIds === null ? null : Array.from(new Set(folderIds.map(String))),
    updatedAt: new Date().toISOString(), updatedBy: editorEmail ?? next[idx].updatedBy ?? null,
  }
  persist(next)
  return next[idx]
}

// Chamado pelo ETL (scripts/fetch-install.mjs) depois de rodar — grava
// quando cada query rodou de verdade, pra próxima vez saber se já é a vez
// dela de novo (queries 'scheduled'). Um write só pro lote inteiro do ciclo,
// não um por query.
export function recordQueryRuns(runs) {
  if (!runs.length) return
  const { list } = loadQueryCatalog()
  const byId = new Map(runs.map((r) => [r.id, r.lastRunAt]))
  const next = list.map((q) => (byId.has(q.id) ? { ...q, lastRunAt: byId.get(q.id) } : q))
  persist(next)
}

export function resetQueryCatalog() {
  if (existsSync(STORE_PATH)) unlinkSync(STORE_PATH)
  return seedList()
}

// Executa contra o pool fornecido pelo chamador — este módulo não gerencia
// ciclo de vida de conexão, já que é usado tanto pelo servidor Express (vida
// longa, pools próprios) quanto pelo script de ETL (vida curta, um pool por
// execução, fechado ao final).
export async function executeQuery({ db, sql }, { pgPool, mariaPool, limit } = {}) {
  assertSafeSelect(sql)
  if (db === 'postgres') {
    if (!pgPool) throw new Error('Pool Postgres não disponível.')
    const { rows } = await pgPool.query(sql)
    return limit ? rows.slice(0, limit) : rows
  }
  if (db === 'mariadb') {
    if (!mariaPool) throw new Error('Pool MariaDB não disponível.')
    const [rows] = await mariaPool.query({ sql, timeout: 60_000 })
    return limit ? rows.slice(0, limit) : rows
  }
  throw new Error(`Banco inválido: ${db}`)
}
