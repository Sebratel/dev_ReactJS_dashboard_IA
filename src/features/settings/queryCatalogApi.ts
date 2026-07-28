import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export interface QueryDef {
  id: string
  title: string
  db: 'postgres' | 'mariadb'
  sql: string
  enabled?: boolean // ausente = ativa (compatibilidade com entradas antigas)
  refreshMode?: 'realtime' | 'scheduled' // ausente = 'realtime' (compatibilidade)
  refreshMinutes?: number // só relevante quando refreshMode === 'scheduled'
  lastRunAt?: string | null
  folderIds?: string[] | null // null/ausente = liberada em todas as pastas
  updatedAt?: string
  updatedBy?: string | null
}

export interface QueryTestResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

export async function fetchQueryCatalog(): Promise<{ list: QueryDef[]; isDefault: boolean }> {
  return parse(await apiFetch('/api/queries'))
}

export async function testQuery(db: string, sql: string): Promise<QueryTestResult> {
  return parse(await apiFetch('/api/queries/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ db, sql }),
  }))
}

export async function createQuery(def: { id: string; title: string; db: string; sql: string }): Promise<QueryDef> {
  const body = await parse<{ query: QueryDef }>(await apiFetch('/api/queries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def),
  }))
  return body.query
}

export async function updateQuery(id: string, patch: { title?: string; db?: string; sql?: string }): Promise<QueryDef> {
  const body = await parse<{ query: QueryDef }>(await apiFetch(`/api/queries/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }))
  return body.query
}

export async function deleteQuery(id: string): Promise<void> {
  await parse(await apiFetch(`/api/queries/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export async function resetQueryCatalog(): Promise<QueryDef[]> {
  const body = await parse<{ queries: QueryDef[] }>(await apiFetch('/api/queries/reset', { method: 'POST' }))
  return body.queries
}

export async function setQueryEnabled(id: string, enabled: boolean): Promise<QueryDef> {
  const body = await parse<{ query: QueryDef }>(await apiFetch(`/api/queries/${encodeURIComponent(id)}/enabled`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  }))
  return body.query
}

// Ritmo de atualização de UMA query — não é uma config global: cada query
// escolhe 'realtime' (todo ciclo do ETL) ou 'scheduled' (só a cada X min).
export async function setQueryRefresh(id: string, refresh: { mode: 'realtime' | 'scheduled'; minutes?: number }): Promise<QueryDef> {
  const body = await parse<{ query: QueryDef }>(await apiFetch(`/api/queries/${encodeURIComponent(id)}/refresh`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refresh),
  }))
  return body.query
}

export interface QueryFolderUsage {
  folderId: string
  folderName: string
  dashboardNames: string[]
}

// Em quais pastas (e dashboards dentro delas) esta query já está em uso de
// fato — independente da restrição atual de `folderIds`. Usado pra avisar
// antes de remover uma pasta que já depende dela.
export async function fetchQueryUsage(id: string): Promise<QueryFolderUsage[]> {
  const body = await parse<{ folders: QueryFolderUsage[] }>(await apiFetch(`/api/queries/${encodeURIComponent(id)}/usage`))
  return body.folders
}

// Em quais pastas esta query pode ser usada como fonte no Builder — null =
// todas. Só admin (rota protegida no servidor).
export async function setQueryFolders(id: string, folderIds: string[] | null): Promise<QueryDef> {
  const body = await parse<{ query: QueryDef }>(await apiFetch(`/api/queries/${encodeURIComponent(id)}/folders`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderIds }),
  }))
  return body.query
}
