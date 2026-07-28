// Cliente HTTP das planilhas do Google cadastradas livremente pelo usuário
// (server/sheetSources.mjs) — diferente das queries SQL (admin-only, ver
// src/features/settings/queryCatalogApi.ts), qualquer usuário autenticado
// pode criar/usar; só quem cadastrou (ou um admin) pode editar/remover.
import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export interface SheetSource {
  id: string
  label: string
  url: string
  spreadsheetId: string
  sheetName: string | null
  createdBy: string | null
  createdAt: string
  updatedBy: string | null
  updatedAt: string
  hasCache: boolean
  rowCount: number | null
  fetchedAt: number | null
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

export async function fetchSheetSources(): Promise<SheetSource[]> {
  const body = await parse<{ sheets: SheetSource[] }>(await apiFetch('/api/sheet-sources'))
  return body.sheets
}

export async function createSheetSource(def: { label: string; url: string; sheetName?: string }): Promise<SheetSource> {
  const body = await parse<{ sheet: SheetSource }>(await apiFetch('/api/sheet-sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def),
  }))
  return body.sheet
}

export async function updateSheetSource(id: string, patch: { label?: string; url?: string; sheetName?: string }): Promise<SheetSource> {
  const body = await parse<{ sheet: SheetSource }>(await apiFetch(`/api/sheet-sources/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }))
  return body.sheet
}

export async function deleteSheetSource(id: string): Promise<void> {
  await parse(await apiFetch(`/api/sheet-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export async function refreshSheetSource(id: string): Promise<{ rowCount: number }> {
  return parse(await apiFetch(`/api/sheet-sources/${encodeURIComponent(id)}/refresh`, { method: 'PATCH' }))
}

export interface SheetSourceUsage {
  folderId: string
  folderName: string
  dashboardNames: string[]
}

export async function fetchSheetSourceUsage(id: string): Promise<SheetSourceUsage[]> {
  const body = await parse<{ folders: SheetSourceUsage[] }>(await apiFetch(`/api/sheet-sources/${encodeURIComponent(id)}/usage`))
  return body.folders
}
