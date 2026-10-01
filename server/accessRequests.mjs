// ─────────────────────────────────────────────────────────────────────────
// Solicitações de acesso a pastas. Quem não tem acesso a uma pasta pede pela
// página "Manual de uso"; um administrador libera ou recusa na aba Acessos.
// Liberar é o que de fato mexe na pasta (grantFolderAccess, em workspace.mjs) —
// este módulo só guarda o pedido e a decisão. Mesmo padrão de persistência de
// accessLog.mjs (JSON em data/, leitura e escrita síncronas).
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const REQUESTS_PATH = process.env.ACCESS_REQUESTS_PATH
  ? resolve(process.env.ACCESS_REQUESTS_PATH)
  : resolve(process.cwd(), 'data/accessRequests.json')

export const MAX_MESSAGE_CHARS = 500
// Teto do arquivo: pendentes nunca saem; das decididas, as mais antigas vão
// embora primeiro. A decisão continua no log de auditoria de qualquer forma.
const MAX_ENTRIES = 2000

// Erro com o status HTTP que a rota deve devolver (409 duplicado, 404...).
function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function load() {
  if (!existsSync(REQUESTS_PATH)) return []
  try {
    const list = JSON.parse(readFileSync(REQUESTS_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    console.error(`[access-requests] arquivo corrompido (${REQUESTS_PATH}): ${e.message} — usando vazio`)
    return []
  }
}

function save(list) {
  let kept = list
  if (kept.length > MAX_ENTRIES) {
    const pending = kept.filter((r) => r.status === 'pending')
    const decided = kept.filter((r) => r.status !== 'pending').slice(-(MAX_ENTRIES - pending.length))
    kept = [...pending, ...decided].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  mkdirSync(dirname(REQUESTS_PATH), { recursive: true })
  writeFileSync(REQUESTS_PATH, JSON.stringify(kept, null, 2), 'utf8')
}

// Mais recentes primeiro. `status` filtra ('pending', 'approved', 'rejected').
export function listRequests({ status } = {}) {
  const list = load()
  return (status ? list.filter((r) => r.status === status) : list)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// Último pedido de um e-mail para cada pasta — o que a página do manual mostra
// ao lado de cada pasta ("solicitado em…", "recusado em…").
export function latestRequestsByFolder(email) {
  const key = String(email).toLowerCase()
  const latest = new Map()
  for (const r of load()) {
    if (r.email !== key) continue
    const current = latest.get(r.folderId)
    if (!current || r.createdAt > current.createdAt) latest.set(r.folderId, r)
  }
  return latest
}

export function getRequest(id) {
  return load().find((r) => r.id === id) ?? null
}

export function createRequest({ email, name, folderId, folderName, message }) {
  const key = String(email).toLowerCase()
  const text = String(message ?? '').trim()
  if (text.length > MAX_MESSAGE_CHARS) {
    throw httpError(400, `A mensagem passou de ${MAX_MESSAGE_CHARS} caracteres.`)
  }
  const list = load()
  if (list.some((r) => r.email === key && r.folderId === folderId && r.status === 'pending')) {
    throw httpError(409, 'Já existe uma solicitação pendente para esta pasta.')
  }
  const request = {
    id: randomUUID(),
    email: key,
    name: name || key,
    folderId,
    // Nome no momento do pedido: se a pasta for renomeada ou removida, o
    // administrador ainda entende o que foi pedido.
    folderName,
    message: text || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
  }
  list.push(request)
  save(list)
  return request
}

// Fecha um pedido pendente como 'approved' ou 'rejected'.
export function decideRequest(id, status, actorEmail) {
  if (status !== 'approved' && status !== 'rejected') throw httpError(400, 'Decisão inválida.')
  const list = load()
  const request = list.find((r) => r.id === id)
  if (!request) throw httpError(404, 'Solicitação não encontrada.')
  if (request.status !== 'pending') throw httpError(409, 'Esta solicitação já foi respondida.')
  request.status = status
  request.decidedAt = new Date().toISOString()
  request.decidedBy = actorEmail ? String(actorEmail).toLowerCase() : null
  save(list)
  return request
}
