import { apiFetch, ApiError } from '@/lib/apiClient'
import type { SourceDef } from './fieldCatalog'
import type { FilterConfig, TabRelation, WidgetConfig, WidgetDataResponse } from './types'

export { ApiError }

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) {
    const msg = body?.error
    if (res.status === 503) throw new ApiError(503, msg || 'Base ainda não materializada no backend.')
    throw new ApiError(res.status, msg || `Erro ${res.status} no servidor.`)
  }
  return body as T
}

export async function fetchWidgetData(
  widget: WidgetConfig,
  tabFilters: { filter: FilterConfig; values: string[] }[],
  page = 1,
  pageSize = 50,
  relations: TabRelation[] = [],
): Promise<WidgetDataResponse> {
  const res = await apiFetch('/api/widget-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widget, tabFilters, page, pageSize, relations }),
  })
  const body = await parse<{ data: WidgetDataResponse }>(res)
  return body.data
}

export async function fetchFieldValues(source: string, field: string): Promise<string[]> {
  const res = await apiFetch('/api/field-values', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, field }),
  })
  const body = await parse<{ values: string[] }>(res)
  return body.values
}

// folderId filtra pra só as fontes liberadas naquela pasta (ver
// server/queryCatalog.mjs::setQueryFolders) — sem ele, devolve tudo.
export async function fetchSources(folderId?: string): Promise<SourceDef[]> {
  const res = await apiFetch(folderId ? `/api/sources?folderId=${encodeURIComponent(folderId)}` : '/api/sources')
  const body = await parse<{ sources: SourceDef[] }>(res)
  return body.sources
}
