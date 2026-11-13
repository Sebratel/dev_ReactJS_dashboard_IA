// ─────────────────────────────────────────────────────────────────────────
// Dicionário & Tipo de dado: descrição/origem e um "tipo de dado" (opcional,
// estilo Power BI) de UM campo de UMA fonte (SQL ou planilha do Google),
// escritos por administradores em Configurações. A descrição vira um
// InfoHint (i) ao lado do campo em qualquer seletor do Builder — mesmo
// estilo dos "(i)" que já explicam Dados/Modificadores/Formato, só que
// preenchido pelo próprio admin em vez de fixo no código. O tipo de dado
// SOBRESCREVE o `kind` que o motor infere sozinho a partir da amostra real
// (ver inferSourceDef, widgetQuery.mjs) — útil quando a inferência erra (ex.
// uma data num formato que não é ISO "AAAA-MM-DD", ou um código numérico
// que devia ser tratado como texto/dimensão, não como medida somável).
// Persistido em data/fieldDictionary.json, mesmo padrão de arquivo único já
// usado em accessLog.mjs/sheetSources.mjs — lista pequena
// (um admin escreve à mão), sem necessidade de nada mais elaborado.
// ─────────────────────────────────────────────────────────────────────────
import { logger } from './logger.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const STORE_PATH = process.env.FIELD_DICTIONARY_PATH
  ? resolve(process.env.FIELD_DICTIONARY_PATH)
  : resolve(process.cwd(), 'data/fieldDictionary.json')

// Opções de "tipo de dado" (estilo Power BI) — cada uma mapeia pro `kind`
// FUNCIONAL que já existe no catálogo (dimension/date/number), os únicos 3
// valores que hoje realmente mudam comportamento: em quais seletores um
// campo aparece (medida vs. dimensão), se um filtro de aba nasce como
// período ou seleção múltipla, se ganha as opções "por dia"/"por mês", e
// como a IA descreve o campo pra si mesma. Várias opções abaixo mapeiam pro
// MESMO kind de propósito — ainda não existe formatação por subtipo (casas
// decimais, símbolo de %, hora sem data junto) nesta versão; o campo
// `dataType` cru fica salvo mesmo assim, pronto pra uma formatação futura
// usar sem precisar pedir de novo pro usuário. Sem "Usando a localidade…"
// (Power BI): esse é um passo do assistente de IMPORTAÇÃO de arquivo, que
// não existe aqui — os dados são lidos ao vivo da fonte, nunca importados.
export const DATA_TYPES = [
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
export const DATA_TYPE_KIND = Object.fromEntries(DATA_TYPES.map((t) => [t.key, t.kind]))

function load() {
  if (!existsSync(STORE_PATH)) return []
  try {
    const list = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    logger.error(`[field-dictionary] arquivo corrompido (${e.message}) — tratando como vazio`)
    return []
  }
}

function persist(list) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8')
}

export function listFieldDictionary() {
  return load()
}

// Pra widgetQuery.mjs anotar cada campo do catálogo com a descrição e o
// `kind` sobrescrito, sem varrer a lista inteira por campo consultado.
export function fieldDictionaryMap() {
  const map = new Map()
  for (const e of load()) map.set(`${e.source}::${e.field}`, { description: e.description, dataType: e.dataType })
  return map
}

// Descrição vazia E tipo ausente/"auto" REMOVEM a entrada inteira (não faz
// sentido guardar uma entrada sem nada dentro) — assim "limpar tudo e
// salvar" já funciona como "apagar". Qualquer um dos dois presentes sozinho
// mantém a entrada só com o que tem (ex. só o tipo, sem descrição escrita).
export function upsertFieldDictionaryEntry({ source, field, description, dataType }, userEmail) {
  if (!source || !field) throw new Error('Fonte e campo são obrigatórios.')
  if (dataType && !DATA_TYPE_KIND[dataType]) throw new Error(`Tipo de dado desconhecido: ${dataType}`)
  const list = load()
  const idx = list.findIndex((e) => e.source === source && e.field === field)
  const trimmedDescription = String(description ?? '').trim()
  const normalizedType = dataType || undefined
  if (!trimmedDescription && !normalizedType) {
    if (idx === -1) return null
    persist(list.filter((_, i) => i !== idx))
    return null
  }
  const entry = {
    source, field,
    description: trimmedDescription || undefined,
    dataType: normalizedType,
    updatedBy: userEmail ?? null,
    updatedAt: new Date().toISOString(),
  }
  const next = [...list]
  if (idx === -1) next.push(entry); else next[idx] = entry
  persist(next)
  return entry
}
