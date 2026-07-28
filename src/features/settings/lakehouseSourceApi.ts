// Cliente HTTP das fontes do Data Hub / lakehouse (server/lakehouseSources.mjs).
// Auto-serviço como as planilhas do Google: qualquer usuário autenticado
// cadastra a sua fonte; só quem cadastrou (ou um admin) edita/remove; só admin
// restringe em quais pastas ela aparece.
//
// O token NUNCA volta do servidor — a lista traz só `tokenHint`
// ("dhub_…6T97"). Por isso `token` é opcional no update: vazio = mantém o
// token já salvo.
import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export interface LakehouseSource {
  id: string
  label: string
  baseUrl: string
  datasetSlug: string
  tokenHint: string | null
  hasToken: boolean
  enabled: boolean
  refreshMode: 'realtime' | 'scheduled'
  refreshMinutes: number
  lastRunAt: string | null
  rowCount: number | null
  lastError: string | null
  lastErrorAt: string | null
  folderIds: string[] | null
  createdBy: string | null
  createdAt: string
  updatedBy: string | null
  updatedAt: string
}

export interface LakehousePreview {
  dataset: string
  baseUrl: string
  total: number | null
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface LakehouseSourceInput {
  label: string
  baseUrl: string
  datasetSlug: string
  token?: string
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

function send(path: string, method: string, payload?: unknown) {
  return apiFetch(path, {
    method,
    ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  })
}

const at = (id: string, suffix = '') => `/api/lakehouse-sources/${encodeURIComponent(id)}${suffix}`

export async function fetchLakehouseSources(): Promise<{ sources: LakehouseSource[]; defaultBaseUrl: string }> {
  return parse(await apiFetch('/api/lakehouse-sources'))
}

// Valida credenciais ainda não salvas (ou revalida as de uma fonte existente,
// passando só o `id`) e devolve total de linhas + colunas detectadas.
export async function testLakehouseSource(
  input: { baseUrl?: string; datasetSlug?: string; token?: string; id?: string },
): Promise<LakehousePreview> {
  return parse(await send('/api/lakehouse-sources/test', 'POST', input))
}

export async function createLakehouseSource(def: LakehouseSourceInput): Promise<LakehouseSource> {
  const body = await parse<{ source: LakehouseSource }>(await send('/api/lakehouse-sources', 'POST', def))
  return body.source
}

export async function updateLakehouseSource(id: string, patch: Partial<LakehouseSourceInput>): Promise<LakehouseSource> {
  const body = await parse<{ source: LakehouseSource }>(await send(at(id), 'PUT', patch))
  return body.source
}

export async function deleteLakehouseSource(id: string): Promise<void> {
  await parse(await send(at(id), 'DELETE'))
}

export async function setLakehouseEnabled(id: string, enabled: boolean): Promise<LakehouseSource> {
  const body = await parse<{ source: LakehouseSource }>(await send(at(id, '/enabled'), 'PATCH', { enabled }))
  return body.source
}

export async function setLakehouseRefresh(
  id: string, refresh: { mode: 'realtime' | 'scheduled'; minutes?: number },
): Promise<LakehouseSource> {
  const body = await parse<{ source: LakehouseSource }>(await send(at(id, '/refresh'), 'PATCH', refresh))
  return body.source
}

export async function setLakehouseFolders(id: string, folderIds: string[] | null): Promise<LakehouseSource> {
  const body = await parse<{ source: LakehouseSource }>(await send(at(id, '/folders'), 'PATCH', { folderIds }))
  return body.source
}

// Dispara o ETL agora — responde na hora, a busca acontece em segundo plano.
export async function syncLakehouseSource(id: string): Promise<void> {
  await parse(await send(at(id, '/sync'), 'PATCH'))
}

export interface LakehouseSourceUsage { folderId: string; folderName: string; dashboardNames: string[] }

export async function fetchLakehouseSourceUsage(id: string): Promise<LakehouseSourceUsage[]> {
  const body = await parse<{ folders: LakehouseSourceUsage[] }>(await apiFetch(at(id, '/usage')))
  return body.folders
}
