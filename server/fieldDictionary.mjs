// ─────────────────────────────────────────────────────────────────────────
// Dicionário de dados: descrição/origem de UM campo de UMA fonte (SQL ou
// planilha do Google), escrita por administradores em Configurações e
// mostrada como um InfoHint (i) ao lado do campo em qualquer seletor do
// Builder — mesmo estilo dos "(i)" que já explicam Dados/Modificadores/
// Formato, só que preenchido pelo próprio admin em vez de fixo no código.
// Persistido em data/fieldDictionary.json, mesmo padrão de arquivo único já
// usado em accessLog.mjs/queryCatalog.mjs/sheetSources.mjs — lista pequena
// (um admin escreve à mão), sem necessidade de nada mais elaborado.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const STORE_PATH = process.env.FIELD_DICTIONARY_PATH
  ? resolve(process.env.FIELD_DICTIONARY_PATH)
  : resolve(process.cwd(), 'data/fieldDictionary.json')

function load() {
  if (!existsSync(STORE_PATH)) return []
  try {
    const list = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    console.error(`[field-dictionary] arquivo corrompido (${e.message}) — tratando como vazio`)
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

// Pra widgetQuery.mjs anotar cada campo do catálogo com a descrição, sem
// varrer a lista inteira por campo consultado.
export function fieldDictionaryMap() {
  const map = new Map()
  for (const e of load()) map.set(`${e.source}::${e.field}`, e.description)
  return map
}

// Descrição vazia REMOVE a entrada (não faz sentido guardar uma descrição
// em branco) — assim "limpar o texto e salvar" já funciona como "apagar".
export function upsertFieldDescription({ source, field, description }, userEmail) {
  if (!source || !field) throw new Error('Fonte e campo são obrigatórios.')
  const list = load()
  const idx = list.findIndex((e) => e.source === source && e.field === field)
  const trimmed = String(description ?? '').trim()
  if (!trimmed) {
    if (idx === -1) return null
    persist(list.filter((_, i) => i !== idx))
    return null
  }
  const entry = { source, field, description: trimmed, updatedBy: userEmail ?? null, updatedAt: new Date().toISOString() }
  const next = [...list]
  if (idx === -1) next.push(entry); else next[idx] = entry
  persist(next)
  return entry
}
