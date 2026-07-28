// ─────────────────────────────────────────────────────────────────────────
// Sessões de login, guardadas NO SERVIDOR (data/sessions.json) e referenciadas
// pelo navegador por um cookie HttpOnly com um id opaco.
//
// Por que no servidor e não num JWT: aqui ficam o access_token e o
// refresh_token do Google. Guardá-los no cliente é exatamente o que o fluxo
// antigo fazia (localStorage) e o que esta migração elimina. Ficando no
// servidor, o navegador nunca vê token do Google, e um logout de verdade
// invalida a sessão (com JWT só daria pra esperar expirar).
//
// Persistido em arquivo — e não em memória — para um restart do container (ou
// um redeploy da stack no Portainer) não deslogar todo mundo. Mesmo padrão de
// arquivo único de accessLog.mjs/queryCatalog.mjs.
//
// Os tokens são cifrados em repouso com a mesma chave dos tokens do Data Hub
// (server/secretBox.mjs). Um vazamento do volume `data` não entrega acesso à
// conta Google de ninguém sem a chave.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { encryptSecret, decryptSecret } from './secretBox.mjs'

const STORE_PATH = process.env.SESSIONS_PATH
  ? resolve(process.env.SESSIONS_PATH)
  : resolve(process.cwd(), 'data/sessions.json')

export const COOKIE_NAME = 'ind_sessao'
// Tempo de vida ABSOLUTO da sessão. Generoso de propósito: como o
// `prompt=consent` do fluxo faz a tela de consentimento aparecer a cada login
// (ver server/googleOAuth.mjs), logins raros são o comportamento desejado.
const TTL_DAYS = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30)
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000
// Margem para renovar o access_token antes de ele realmente vencer — evita a
// corrida de usar um token que expira no meio da chamada ao Google.
const REFRESH_SKEW_MS = 2 * 60 * 1000

function load() {
  if (!existsSync(STORE_PATH)) return []
  try {
    const list = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    // Sessões são descartáveis: arquivo ilegível = todo mundo loga de novo,
    // o que é bem melhor que derrubar a API.
    console.error(`[sessions] arquivo corrompido (${e.message}) — tratando como vazio`)
    return []
  }
}

function persist(list) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8')
}

function alive(entry, now) {
  return entry && typeof entry.expiresAt === 'number' && entry.expiresAt > now
}

// Guarda os campos secretos cifrados; o resto em claro (é o que a API precisa
// ler a cada requisição, sem custo de decifra).
function pack(entry) {
  return {
    ...entry,
    accessToken: entry.accessToken ? encryptSecret(entry.accessToken) : null,
    refreshToken: entry.refreshToken ? encryptSecret(entry.refreshToken) : null,
  }
}

function unpack(entry) {
  if (!entry) return null
  try {
    return {
      ...entry,
      accessToken: entry.accessToken ? decryptSecret(entry.accessToken) : null,
      refreshToken: entry.refreshToken ? decryptSecret(entry.refreshToken) : null,
    }
  } catch (e) {
    // Chave de cifra trocada — a sessão é inutilizável, então vale como
    // inexistente (a pessoa loga de novo).
    console.error(`[sessions] sessão ilegível (${e.message}) — tratando como expirada`)
    return null
  }
}

export function createSession({ email, name, picture }, tokens) {
  const now = Date.now()
  const entry = {
    id: randomBytes(32).toString('base64url'),
    email, name, picture: picture ?? null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.expiresAt,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + TTL_MS,
  }
  // Aproveita a escrita para varrer as expiradas — não precisa de job separado.
  const kept = load().filter((s) => alive(s, now))
  persist([...kept, pack(entry)])
  return entry
}

export function getSession(id) {
  if (!id) return null
  const entry = load().find((s) => s.id === id)
  if (!alive(entry, Date.now())) return null
  return unpack(entry)
}

export function destroySession(id) {
  if (!id) return
  const now = Date.now()
  persist(load().filter((s) => s.id !== id && alive(s, now)))
}

// Um write por chamada; usado tanto pelo "visto por último" quanto pela
// gravação do access_token renovado.
function patch(id, fields) {
  const list = load()
  const idx = list.findIndex((s) => s.id === id)
  if (idx === -1) return null
  const merged = { ...list[idx], ...fields }
  const next = [...list]
  next[idx] = merged
  persist(next)
  return merged
}

export function touchSession(id) {
  patch(id, { lastSeenAt: Date.now() })
}

// Garante um access_token válido para a sessão, renovando pelo refresh_token
// quando necessário. Devolve o token, ou null se a sessão não tem mais como se
// renovar (refresh revogado no Google, consentimento retirado etc.) — nesse
// caso o chamador deve tratar como sessão morta.
export async function ensureAccessToken(session, refreshFn) {
  const now = Date.now()
  if (session.accessToken && session.accessTokenExpiresAt > now + REFRESH_SKEW_MS) {
    return session.accessToken
  }
  if (!session.refreshToken) return null
  try {
    const renewed = await refreshFn(session.refreshToken)
    const refreshToken = renewed.refreshToken ?? session.refreshToken
    patch(session.id, pack({
      ...session,
      accessToken: renewed.accessToken,
      refreshToken,
      accessTokenExpiresAt: renewed.expiresAt,
    }))
    session.accessToken = renewed.accessToken
    session.refreshToken = refreshToken
    session.accessTokenExpiresAt = renewed.expiresAt
    return renewed.accessToken
  } catch (e) {
    console.error(`[sessions] falha ao renovar a sessão de ${session.email}: ${e.message}`)
    destroySession(session.id)
    return null
  }
}
