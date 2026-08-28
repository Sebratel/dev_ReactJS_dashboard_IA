import { apiFetch, ApiError } from '@/lib/apiClient'
import type { DataTypeKey } from '@/features/builder/fieldCatalog'

export { ApiError }

export interface FieldDictionaryEntry {
  source: string
  field: string
  description?: string
  dataType?: DataTypeKey
  updatedBy: string | null
  updatedAt: string
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

export async function fetchFieldDictionary(): Promise<FieldDictionaryEntry[]> {
  const body = await parse<{ entries: FieldDictionaryEntry[] }>(await apiFetch('/api/field-dictionary'))
  return body.entries
}

// Descrição vazia E tipo ausente juntos removem a entrada no servidor (ver
// server/fieldDictionary.mjs) — os dois valores sempre viajam juntos aqui
// (a linha inteira é uma unidade), pra uma mudança num não apagar o outro.
export async function saveFieldDictionaryEntry(source: string, field: string, description: string, dataType: DataTypeKey | undefined): Promise<FieldDictionaryEntry | null> {
  const body = await parse<{ entry: FieldDictionaryEntry | null }>(await apiFetch('/api/field-dictionary', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, field, description, dataType }),
  }))
  return body.entry
}
