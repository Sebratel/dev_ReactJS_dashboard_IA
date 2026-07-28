// ─────────────────────────────────────────────────────────────────────────
// Gestão de acessos: quem já entrou no app, quem está online agora, e um log
// de ações administrativas. Mesmo padrão de persistência de queryCatalog.mjs
// / dashboardConfig.mjs (JSON em data/, leitura/escrita síncrona).
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const USERS_PATH = process.env.ACCESS_USERS_PATH
  ? resolve(process.env.ACCESS_USERS_PATH)
  : resolve(process.cwd(), 'data/users.json')
const LOG_PATH = process.env.ACCESS_LOG_PATH
  ? resolve(process.env.ACCESS_LOG_PATH)
  : resolve(process.cwd(), 'data/audit-log.json')

// Lista de administradores "de fábrica" — só usada como fallback pra quem
// ainda não tem um papel salvo em data/users.json (bootstrap inicial e rede
// de segurança se o arquivo for perdido). Uma vez que alguém troca o papel de
// um usuário pela aba Acessos, o valor salvo manda e essa lista deixa de
// valer pra aquele e-mail — ver resolveRole().
const DEFAULT_ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || [
    'gustavo.santos@sebratel.com.br',
    'bruno.soares@sebratel.com.br',
    'erick.azambuja@sebratel.com.br',
    'fabricio.machado@sebratel.com.br',
    'israel.barcelos@sebratel.com.br',
    'misael.cruz@sebratel.com.br',
    'daniel.menezes@sebratel.com.br',
  ].join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

function resolveRole(users, key) {
  const saved = users[key]?.role
  if (saved === 'admin' || saved === 'standard') return saved
  return DEFAULT_ADMIN_EMAILS.has(key) ? 'admin' : 'standard'
}

export function isAdmin(email) {
  if (!email) return false
  const key = String(email).toLowerCase()
  return resolveRole(loadJson(USERS_PATH, {}), key) === 'admin'
}

// Um usuário é considerado "online" se foi visto nos últimos 90s — coberto
// tanto pelo heartbeat periódico do front (a cada 45s) quanto por qualquer
// chamada normal de API, então uma aba aberta e ociosa ainda aparece online.
export const ONLINE_THRESHOLD_MS = 90_000
// Throttle de escrita em disco por usuário — evita um writeFileSync a cada
// requisição de API (o app faz muitas por minuto); ainda assim o dado
// persistido fica bem dentro do ONLINE_THRESHOLD_MS acima.
const WRITE_THROTTLE_MS = 20_000
const MAX_LOG_ENTRIES = 5000

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`[access-log] arquivo corrompido (${path}): ${e.message} — usando vazio`)
    return fallback
  }
}

function saveJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

const lastWrite = new Map() // email -> timestamp da última escrita em disco

export function touchUser(email, name) {
  const key = String(email).toLowerCase()
  const now = Date.now()
  const last = lastWrite.get(key) || 0
  if (now - last < WRITE_THROTTLE_MS) return
  lastWrite.set(key, now)

  const users = loadJson(USERS_PATH, {})
  const existing = users[key]
  users[key] = {
    email: key,
    name: name || existing?.name || key,
    // Papel só é decidido uma vez, no primeiro acesso (a lista de fallback é
    // só o ponto de partida) — depois disso, só muda pela aba Acessos.
    role: existing?.role ?? (DEFAULT_ADMIN_EMAILS.has(key) ? 'admin' : 'standard'),
    firstSeenAt: existing?.firstSeenAt || new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  }
  saveJson(USERS_PATH, users)
}

export function listUsers() {
  const users = loadJson(USERS_PATH, {})
  const now = Date.now()
  return Object.entries(users)
    .map(([key, u]) => ({ ...u, role: resolveRole(users, key), online: now - new Date(u.lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS }))
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))
}

// Troca o papel de um usuário que já acessou pelo menos uma vez. Bloqueia
// remover o último administrador (só entre quem já tem registro em
// users.json — alguém da lista de fallback que nunca logou não conta),
// pra não travar o acesso à própria aba que gerencia isso.
export function setUserRole(email, role) {
  if (role !== 'admin' && role !== 'standard') throw new Error('Papel inválido — use "admin" ou "standard".')
  const key = String(email).toLowerCase()
  const users = loadJson(USERS_PATH, {})
  if (!users[key]) throw new Error('Usuário ainda não acessou o sistema.')
  if (role === 'standard') {
    const otherAdmins = Object.keys(users).filter((k) => k !== key && resolveRole(users, k) === 'admin')
    if (otherAdmins.length === 0) throw new Error('Não é possível remover o último administrador.')
  }
  users[key] = { ...users[key], role }
  saveJson(USERS_PATH, users)
  return { ...users[key], online: Date.now() - new Date(users[key].lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS }
}

export function appendAuditLog({ email, name, action, target, meta }) {
  const log = loadJson(LOG_PATH, [])
  log.push({
    ts: new Date().toISOString(),
    email: email ? String(email).toLowerCase() : null,
    name: name || null,
    action,
    target: target ?? null,
    meta: meta ?? null,
  })
  const trimmed = log.length > MAX_LOG_ENTRIES ? log.slice(log.length - MAX_LOG_ENTRIES) : log
  saveJson(LOG_PATH, trimmed)
}

export function listAuditLog({ limit = 200 } = {}) {
  const log = loadJson(LOG_PATH, [])
  return log.slice(-Math.max(1, Math.min(1000, limit))).reverse()
}

// Alguém já acessou o sistema pelo menos uma vez (tem registro em
// users.json)? Usado pra validar gerentes (server/workspace.mjs) — mesma
// exigência de setUserRole() acima, só que reutilizável fora deste módulo.
export function isKnownUser(email) {
  if (!email) return false
  const users = loadJson(USERS_PATH, {})
  return !!users[String(email).toLowerCase()]
}

// Resolve uma lista de e-mails pra {email, name} usando o cadastro conhecido
// (quem já logou) — usado pela rota de "membros de uma pasta", pra exibir
// nome em vez de só e-mail no seletor de acesso por guia. E-mails sem
// registro ainda aparecem (o admin pode liberar acesso antes do 1º login),
// só sem nome (name = o próprio e-mail).
export function resolveUsers(emails) {
  const users = loadJson(USERS_PATH, {})
  return emails.map((email) => {
    const key = String(email).toLowerCase()
    const u = users[key]
    return { email: key, name: u?.name || key }
  })
}

// Todos os usuários já conhecidos (alimentam o seletor de membros de uma
// pasta sem restrição de acesso — accessEmails === null).
export function listKnownEmails() {
  return Object.keys(loadJson(USERS_PATH, {}))
}
