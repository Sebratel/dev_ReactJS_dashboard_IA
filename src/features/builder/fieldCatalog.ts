// Catálogo de fontes/campos do Builder — 100% dinâmico. Cada fonte é o id de
// uma query do catálogo único (Configurações → Queries); os campos são
// inferidos pelo backend a partir dos dados reais (ver server/widgetQuery.mjs
// → inferSourceDef), já que o SQL é livremente editável e não tem um tipo TS
// fixo por trás. `registerDynamicSources` é chamado uma vez, ao carregar o
// Builder (ver DashboardBuilder.tsx), com o resultado de GET /api/sources.
import type { SourceTable } from './types'

export type FieldKind = 'dimension' | 'date' | 'number'

export interface FieldDef {
  key: string
  label: string
  kind: FieldKind
  pk?: boolean
  // Descrição/origem escrita por um admin no dicionário de dados
  // (Configurações) — ausente na maioria dos campos (só preenchido onde
  // faz sentido explicar). Mostrada como InfoHint nos seletores do Builder.
  description?: string
}

export interface SourceDef {
  key: SourceTable
  label: string
  fields: FieldDef[]
}

let sources: SourceDef[] = []

export function registerDynamicSources(list: SourceDef[]) {
  sources = list
}

export function getAllSources(): SourceDef[] {
  return sources
}

export function getSourceDef(source: SourceTable): SourceDef | undefined {
  return sources.find((s) => s.key === source)
}
