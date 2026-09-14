// ─────────────────────────────────────────────────────────────────────────
// Sessões de login, guardadas NO SERVIDOR (data/sessions.json) e referenciadas
// pelo navegador por um cookie HttpOnly com um id opaco.
//
// Por que no servidor e não num JWT: um logout de verdade invalida a sessão
// (com JWT só daria pra esperar expirar), e aqui fica também o access_token do
// Google usado para ler planilha em nome de quem entrou — que o navegador não
// precisa guardar.
//
// Desde a migração para o Firebase (13/09/2026) NÃO há mais refresh_token: o ID
// token do Firebase prova a identidade uma vez, no login, e quem sustenta a
// navegação daí em diante é esta sessão. Ver server/firebaseToken.mjs.
//
// Persistido em arquivo — e não em memória — para um restart do container (ou
// um redeploy da stack no Portainer) não deslogar todo mundo. Mesmo padrão de
// arquivo único de accessLog.mjs/lakehouseSources.mjs.
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
// Tempo de vida ABSOLUTO da sessão. Generoso de propósito: o ID token do
// Firebase prova a identidade só no momento de entrar, e é esta sessão que
// sustenta a navegação depois — 30 dias evita pedir login toda semana.
const TTL_DAYS = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30)
export const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000
// Margem de segurança: um token que vence nos próximos 2 minutos já conta como
// vencido, o que evita a corrida de usá-lo e ele expirar no meio da chamada.
const TOKEN_SKEW_MS = 2 * 60 * 1000

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
  }
}

function unpack(entry) {
  if (!entry) return null
  try {
    return {
      ...entry,
      accessToken: entry.accessToken ? decryptSecret(entry.accessToken) : null,
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
    // Só o access_token do Google (planilhas), quando o login trouxe um.
    // Não há refresh_token no fluxo web do Firebase — ver validAccessToken().
    accessToken: tokens.accessToken ?? null,
    accessTokenExpiresAt: tokens.expiresAt ?? 0,
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

// Um write por chamada. Hoje só o "visto por último" usa — a gravação de token
// renovado sumiu junto com o refresh_token.
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

/**
 * O access_token do Google guardado no login, se ainda valer — ou `null`.
 *
 * Serve só para ler PLANILHA em nome de quem entrou (sheetSources/googleSheets).
 * Com o Firebase, o fluxo web não devolve refresh_token, então não há o que
 * renovar: o token dura ~1h e depois disso simplesmente não existe mais.
 *
 * VENCIDO VALE COMO AUSENTE, NUNCA COMO SESSÃO MORTA. Derrubar a sessão aqui
 * seria repetir o erro que a skill padrao-login-sso chama de mais caro — quem
 * está logado há uma semana perderia o acesso ao app inteiro porque uma
 * credencial acessória, usada por um recurso opcional, envelheceu.
 */
export function validAccessToken(session) {
  if (!session?.accessToken) return null
  const expira = Number(session.accessTokenExpiresAt ?? 0)
  if (!(expira > Date.now() + TOKEN_SKEW_MS)) return null
  return session.accessToken
}
