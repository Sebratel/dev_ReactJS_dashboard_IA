// ─────────────────────────────────────────────────────────────────────────
// Comentários/anotações num widget específico (item 2.6 das sugestões) —
// ex. "esse pico em março foi por causa da campanha X". Não faz parte do
// WidgetConfig em si (não precisa do "Salvar" do editor pra existir) —
// qualquer usuário autenticado com acesso à dashboard pode comentar, mesmo
// sem permissão de EDITAR widgets, já que é uma anotação de leitura/
// colaboração, não uma mudança estrutural do widget.
// Persistido em data/widgetComments.json, mesmo padrão de arquivo único já
// usado em sheetSources.mjs/fieldDictionary.mjs.
// ─────────────────────────────────────────────────────────────────────────
import { logger } from './logger.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const STORE_PATH = process.env.WIDGET_COMMENTS_PATH
  ? resolve(process.env.WIDGET_COMMENTS_PATH)
  : resolve(process.cwd(), 'data/widgetComments.json')

const MAX_COMMENT_LENGTH = 2000

function load() {
  if (!existsSync(STORE_PATH)) return []
  try {
    const list = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    logger.error(`[widget-comments] arquivo corrompido (${e.message}) — tratando como vazio`)
    return []
  }
}

function persist(list) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8')
}

function genId() {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

export function listCommentsForWidget(widgetId) {
  return load()
    .filter((c) => c.widgetId === widgetId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function addComment({ widgetId, text }, user) {
  if (!widgetId) throw new Error('widgetId é obrigatório.')
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('Escreva um comentário antes de enviar.')
  if (trimmed.length > MAX_COMMENT_LENGTH) throw new Error(`Comentário muito longo (máximo ${MAX_COMMENT_LENGTH} caracteres).`)
  const entry = {
    id: genId(), widgetId, text: trimmed,
    authorEmail: user.email, authorName: user.name ?? user.email,
    createdAt: new Date().toISOString(),
  }
  persist([...load(), entry])
  return entry
}

export function deleteComment(id, actorEmail, actorIsAdmin) {
  const list = load()
  const entry = list.find((c) => c.id === id)
  if (!entry) throw new Error('Comentário não encontrado.')
  if (!actorIsAdmin && entry.authorEmail !== actorEmail) {
    throw new Error('Só quem escreveu este comentário (ou um administrador) pode removê-lo.')
  }
  persist(list.filter((c) => c.id !== id))
}

// Quantos comentários cada widget tem — usado só pra decidir se mostra um
// indicador (contador) no ícone, sem precisar buscar o texto de cada um.
export function commentCountsByWidget() {
  const counts = new Map()
  for (const c of load()) counts.set(c.widgetId, (counts.get(c.widgetId) ?? 0) + 1)
  return counts
}
