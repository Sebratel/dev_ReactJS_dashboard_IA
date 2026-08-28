// Catálogo de fontes/campos do Builder — 100% dinâmico. Cada fonte é o id de
// uma query do catálogo único (Configurações → Queries); os campos são
// inferidos pelo backend a partir dos dados reais (ver server/widgetQuery.mjs
// → inferSourceDef), já que o SQL é livremente editável e não tem um tipo TS
// fixo por trás. `registerDynamicSources` é chamado uma vez, ao carregar o
// Builder (ver DashboardBuilder.tsx), com o resultado de GET /api/sources.
import type { SourceTable } from './types'

export type FieldKind = 'dimension' | 'date' | 'number'

// Tipo de dado (estilo Power BI, ver Configurações → Dicionário & Tipo de
// dado) que um admin pode atribuir a um campo, sobrescrevendo o `kind` que
// o backend infere sozinho a partir da amostra real (ver inferSourceDef,
// server/widgetQuery.mjs). Espelha EXATAMENTE server/fieldDictionary.mjs —
// mesmas chaves, mesmo `kind` de destino — mudar um lado sem o outro quebra
// a tradução. Só o `kind` de destino (dimension/date/number) muda
// comportamento hoje (em quais seletores o campo aparece, tipo de filtro,
// como a IA o descreve); várias opções aqui mapeiam pro mesmo `kind` de
// propósito — não existe formatação por subtipo (casas decimais, %, hora
// sem data) nesta versão, ver DOCUMENTACAO.md.
export type DataTypeKey =
  | 'decimal' | 'fixedDecimal' | 'wholeNumber' | 'percentage'
  | 'dateTime' | 'date' | 'time' | 'dateTimeTz' | 'duration'
  | 'text' | 'boolean' | 'binary'

export const DATA_TYPES: { key: DataTypeKey; label: string; group: string; kind: FieldKind }[] = [
  { key: 'decimal', label: 'Número Decimal', group: 'Número', kind: 'number' },
  { key: 'fixedDecimal', label: 'Número decimal fixo', group: 'Número', kind: 'number' },
  { key: 'wholeNumber', label: 'Número Inteiro', group: 'Número', kind: 'number' },
  { key: 'percentage', label: 'Percentual', group: 'Número', kind: 'number' },
  { key: 'dateTime', label: 'Data/hora', group: 'Data e hora', kind: 'date' },
  { key: 'date', label: 'Data', group: 'Data e hora', kind: 'date' },
  { key: 'time', label: 'Hora', group: 'Data e hora', kind: 'date' },
  { key: 'dateTimeTz', label: 'Data/Hora/Fuso Horário', group: 'Data e hora', kind: 'date' },
  { key: 'duration', label: 'Duração', group: 'Data e hora', kind: 'number' },
  { key: 'text', label: 'Texto', group: 'Outros', kind: 'dimension' },
  { key: 'boolean', label: 'Verdadeiro/Falso', group: 'Outros', kind: 'dimension' },
  { key: 'binary', label: 'Binário', group: 'Outros', kind: 'dimension' },
]

export const FIELD_KIND_LABEL: Record<FieldKind, string> = { dimension: 'Texto/Categoria', date: 'Data', number: 'Número' }

export interface FieldDef {
  key: string
  label: string
  kind: FieldKind
  pk?: boolean
  // Descrição/origem escrita por um admin no dicionário de dados
  // (Configurações) — ausente na maioria dos campos (só preenchido onde
  // faz sentido explicar). Mostrada como InfoHint nos seletores do Builder.
  description?: string
  // Tipo de dado escolhido à mão (ver DataTypeKey acima) — presente só
  // quando um admin sobrescreveu o tipo. `kindAuto` guarda o que a
  // inferência automática tinha decidido ANTES da sobrescrita, só pra
  // mostrar os dois lado a lado na tela do dicionário.
  dataType?: DataTypeKey
  kindAuto?: FieldKind
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
