// ─────────────────────────────────────────────────────────────────────────
// Verificação do ID token do Firebase — feita AQUI, com a chave pública do
// Google, em vez de perguntar ao Google a cada login.
//
// Portado de `apps/api/src/modules/auth/firebaseToken.ts` do lakehouse_sebratel
// (a implementação de referência da casa, citada na skill padrao-login-sso),
// adaptado para `.mjs` — este servidor roda sob tsx, sem etapa de build.
//
// POR QUE VERIFICAR LOCALMENTE: o ID token do Firebase é um JWT ASSINADO —
// dentro dele já vem o e-mail, e a assinatura prova que foi o Google que
// emitiu. Basta ter a chave pública, e ela vale horas. Depois de buscar os
// certificados uma vez, a API valida login sem tocar na rede: se a saída para o
// Google cair, quem tem token válido continua entrando. É essa a diferença
// entre o HUBBI sobreviver ao firewall e o fluxo antigo não.
//
// POR QUE NÃO `firebase-admin`: ele faria exatamente isto, mas arrasta uma
// árvore grande de dependências (google-auth-library, gcp-metadata, gtoken…) —
// e este repositório versiona o node_modules, então cada dependência entra como
// milhares de arquivos no histórico. O que precisamos são ~80 linhas de
// node:crypto.
// ─────────────────────────────────────────────────────────────────────────
import { logger } from './logger.mjs'
import { createVerify, X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

// Onde o Google publica as chaves públicas que assinam os ID tokens do Firebase.
const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'

// Cópia em disco dos certificados, no MESMO volume `data` da stack. Sem isto,
// um restart do container com a saída bloqueada deixaria a API sem conseguir
// validar nada — justamente o cenário que este módulo existe para evitar.
const CACHE_FILE = process.env.FIREBASE_CERTS_PATH
  ? resolve(process.env.FIREBASE_CERTS_PATH)
  : resolve(process.cwd(), 'data/.firebase-certs.json')

const SOFT_TTL_MS = 6 * 60 * 60 * 1000        // renova depois disso, se der
const HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000  // além disso, não confia mais

let memo = null
let inFlight = null

export function firebaseProjectId() {
  return process.env.FIREBASE_PROJECT_ID || ''
}

function loadFromDisk() {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    return c?.keys && Object.keys(c.keys).length ? c : null
  } catch {
    return null
  }
}

function saveToDisk(c) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8')
  } catch {
    /* cache é otimização; falhar aqui não pode derrubar o login */
  }
}

async function fetchCerts() {
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`certificados do Google responderam ${r.status}`)
  const keys = await r.json()
  if (!keys || !Object.keys(keys).length) throw new Error('lista de certificados vazia')
  const c = { keys, fetchedAt: Date.now() }
  saveToDisk(c)
  return c
}

/**
 * Certificados válidos. A ordem importa: serve o que está em memória, renova em
 * segundo plano quando envelhece, e SÓ bloqueia esperando a rede quando não há
 * nada utilizável. Uma renovação que falha não invalida o que já temos — essa é
 * a regra que impede uma oscilação de rede de virar "ninguém mais entra".
 */
async function getCerts() {
  if (!memo) memo = loadFromDisk()

  const age = memo ? Date.now() - memo.fetchedAt : Infinity
  if (memo && age < SOFT_TTL_MS) return memo

  if (memo && age < HARD_TTL_MS) {
    if (!inFlight) {
      inFlight = fetchCerts()
        .then((c) => { memo = c; return c })
        .catch((e) => {
          logger.warn(`[auth] não consegui renovar os certificados do Google (${e.message}); seguindo com os que estão em cache.`)
          return memo
        })
        .finally(() => { inFlight = null })
    }
    return memo
  }

  if (!inFlight) {
    inFlight = fetchCerts().then((c) => { memo = c; return c }).finally(() => { inFlight = null })
  }
  return inFlight
}

const b64urlToBuf = (s) => Buffer.from(s, 'base64url')

// X509Certificate valida o PEM de verdade; createPublicKey direto no
// certificado não funciona em todas as versões do Node.
function publicKeyOf(certPem) {
  return new X509Certificate(certPem).publicKey
}

/**
 * Valida o ID token e devolve as claims, ou `null` se algo não fecha.
 * Nunca lança por token inválido — só por falha de infraestrutura (certificados
 * inalcançáveis na primeira vez).
 */
export async function verifyFirebaseIdToken(token) {
  const projectId = firebaseProjectId()
  if (!projectId) return null
  if (typeof token !== 'string' || !token) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSig] = parts

  let header
  let payload
  try {
    header = JSON.parse(b64urlToBuf(rawHeader).toString('utf8'))
    payload = JSON.parse(b64urlToBuf(rawPayload).toString('utf8'))
  } catch {
    return null
  }

  // O Firebase assina ID token com RS256. Aceitar o algoritmo que o CABEÇALHO
  // pede abriria a porta clássica do "alg: none" (e a do HS256 assinado com a
  // chave pública como segredo).
  if (header.alg !== 'RS256' || !header.kid) return null

  // Emissor e público têm de ser ESTE projeto: sem isso, um token válido de
  // qualquer outro projeto Firebase do mundo entraria aqui.
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null
  if (payload.aud !== projectId) return null

  const now = Math.floor(Date.now() / 1000)
  const exp = Number(payload.exp ?? 0)
  const iat = Number(payload.iat ?? 0)
  if (!exp || exp <= now) return null
  // 5 min de tolerância para relógio adiantado do servidor.
  if (iat && iat > now + 300) return null
  // `sub` é o uid; token sem dono não serve.
  if (typeof payload.sub !== 'string' || !payload.sub) return null

  const certs = await getCerts()
  const pem = certs.keys[header.kid]
  if (!pem) return null

  const ok = createVerify('RSA-SHA256')
    .update(`${rawHeader}.${rawPayload}`)
    .verify(publicKeyOf(pem), b64urlToBuf(rawSig))
  if (!ok) return null

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
  if (!email) return null

  return {
    uid: payload.sub,
    email,
    emailVerified: payload.email_verified !== false,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  }
}

/** Só para teste: injeta certificados sem tocar na rede. */
export function __setCertsForTest(keys) {
  memo = { keys, fetchedAt: Date.now() }
}
