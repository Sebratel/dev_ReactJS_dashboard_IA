// ─────────────────────────────────────────────────────────────────────────
// Entrada pelo Hub Apps (Indicadores aberto DENTRO do Hub, em iframe).
//
// Como funciona:
//   1. A pessoa clica no card no Hub. O Hub confere se ela tem acesso ao app e
//      emite um token de 5 min (JWT HS256 assinado com o SSO_JWT_SECRET dele,
//      com { sub, email, name, appId, iat, exp }).
//   2. O iframe abre https://dashia…/login?sso_token=<token>. A tela tira o
//      token da URL ANTES de montar o React (src/lib/hubEntry.ts) e o manda
//      para POST /api/auth/hub.
//   3. Aqui o token é conferido (assinatura em tempo constante, só HS256,
//      validade, appId, domínio, uso único) e trocado por uma SESSÃO do
//      servidor (server/sessions.mjs) marcada `via: 'hub'`. O id dela volta no
//      corpo da resposta — NUNCA em cookie — e o front o guarda no
//      sessionStorage do quadro e o manda no Authorization: Bearer.
//
// Segundo emissor confiável: o Data Hub. O menu "Painéis" do Data Hub abre
// este app num iframe DENTRO do Hub (Hub → Data Hub → Indicadores). O Hub não
// emite token para esse quadro, então quem prova a identidade é o próprio Data
// Hub, com um segredo SÓ desta ligação (DATAHUB_SSO_SECRET, diferente do
// segredo do Hub) e um token { iss: 'data-hub', aud: 'dashia', via, … }. A
// sessão aberta assim fica marcada `via: 'datahub'`. Com HUB_ONLY, o token do
// Data Hub só vale se a sessão de LÁ também veio do Hub (`via: 'hub'`): o
// master que entra direto no Data Hub não atravessa para cá.
//
// HUB_ONLY ("só pelo Hub") recusa todo outro meio de login e toda sessão que
// não veio do Hub — SEM exceção para administrador, master ou lista de
// e-mails. Só vale com HUB_SSO_SECRET preenchido: sem o segredo ninguém
// entraria pelo Hub e ligar o modo trancaria todo mundo do lado de fora.
//
// O papel (admin/padrão) e as pastas continuam vindo de data/users.json e do
// workspace, como no login pelo Google — nunca do token.
// ─────────────────────────────────────────────────────────────────────────
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// id do card "Indicadores Sebratel" no cadastro do Hub Apps. O segredo do Hub é
// um só para todos os apps, então sem conferir o appId um token emitido para
// OUTRO app do Hub abriria sessão aqui.
export const DEFAULT_HUB_APP_ID = 'f03eb408-086d-495b-a4dc-1cbe3b539b28'
export const DEFAULT_HUB_URL = 'https://hub-apps.sebratel.net.br'

// Tempo de vida da sessão aberta pelo Hub. Ela vive no sessionStorage do quadro
// e o Hub emite um token novo a cada "Recarregar", então perder a sessão nunca
// custa mais que um clique. 8 h cobre o expediente.
export const HUB_SESSION_TTL_MS = 8 * 60 * 60 * 1000

// Origens de sessão que vêm de um quadro confiável (Hub ou Data Hub dentro do
// Hub). São as únicas que andam no Authorization: Bearer, e as únicas aceitas
// com HUB_ONLY.
export const EMBEDDED_VIAS = new Set(['hub', 'datahub'])

const DATAHUB_ISS = 'data-hub'
const DATAHUB_AUD = 'dashia'
// Folga para relógio adiantado de quem emitiu, e vida máxima aceita de um token
// de entrada (o Hub emite com 300 s).
const MAX_IAT_SKEW_S = 60
const MAX_LIFETIME_S = 600
// Segredo da ligação com o Data Hub: curto demais é adivinhável.
const MIN_DATAHUB_SECRET = 32

// ─── Configuração (lida a cada chamada: os testes mudam o ambiente) ─────────
const truthy = (v) => ['1', 'true', 'sim', 'yes'].includes(String(v ?? '').trim().toLowerCase())

function hubSecret() {
  return String(process.env.HUB_SSO_SECRET ?? '').trim()
}

export function hubAppId() {
  return String(process.env.HUB_APP_ID || DEFAULT_HUB_APP_ID).trim()
}

export function hubUrl() {
  return String(process.env.HUB_URL || DEFAULT_HUB_URL).trim().replace(/\/+$/, '')
}

function allowedDomain() {
  return String(process.env.ALLOWED_DOMAIN || 'sebratel.com.br').trim().toLowerCase()
}

function datahubSecret() {
  const s = String(process.env.DATAHUB_SSO_SECRET ?? '').trim()
  if (s.length < MIN_DATAHUB_SECRET) return ''
  // O mesmo valor do segredo do Hub faria o token de um valer como o do outro.
  if (s === hubSecret()) return ''
  return s
}

/** Entrada pelo Hub pronta (segredo e appId presentes)? */
export function hubSsoConfigured() {
  return !!(hubSecret() && hubAppId())
}

/** Entrada pelo Data Hub (menu "Painéis") pronta? */
export function datahubSsoConfigured() {
  return !!datahubSecret()
}

/**
 * "Só pelo Hub" valendo. Exige as duas pontas prontas: HUB_ONLY sem o segredo
 * do Hub é IGNORADO (senão ninguém entraria por lugar nenhum).
 */
export function hubOnlyActive() {
  return truthy(process.env.HUB_ONLY) && hubSsoConfigured()
}

/** Por que a entrada pelo Data Hub está desligada, para o log de subida. */
export function datahubSsoProblem() {
  const raw = String(process.env.DATAHUB_SSO_SECRET ?? '').trim()
  if (!raw) return null
  if (raw.length < MIN_DATAHUB_SECRET) return `DATAHUB_SSO_SECRET tem menos de ${MIN_DATAHUB_SECRET} caracteres — entrada pelo Data Hub desligada.`
  if (raw === hubSecret()) return 'DATAHUB_SSO_SECRET é igual ao HUB_SSO_SECRET — use um valor só desta ligação. Entrada pelo Data Hub desligada.'
  return null
}

// ─── JWT HS256 ─────────────────────────────────────────────────────────────
function decodePart(raw) {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

/**
 * Confere forma, algoritmo e assinatura de um JWT HS256 e devolve o payload,
 * ou null. O algoritmo é FIXO: o `alg` do cabeçalho só é comparado, nunca
 * escolhe nada — aceitar o que vem nele abriria o "alg: none".
 */
export function verifyHs256(token, key) {
  if (typeof token !== 'string' || !key) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSig] = parts
  if (!rawHeader || !rawPayload || !rawSig) return null
  const header = decodePart(rawHeader)
  const payload = decodePart(rawPayload)
  if (!header || !payload) return null
  if (header.alg !== 'HS256') return null
  const esperado = createHmac('sha256', key).update(`${rawHeader}.${rawPayload}`).digest()
  const recebido = Buffer.from(rawSig, 'base64url')
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null
  return payload
}

// ─── Uso único ─────────────────────────────────────────────────────────────
// O token viaja na URL do iframe, então pode parar em histórico ou log de
// proxy. Quem o encontrar depois não reaproveita, mesmo dentro dos 5 minutos.
// Em memória basta: a API roda num contêiner só (a memória da IA e o
// bloqueio de guia já exigem isso), e depois de um restart o token já está
// perto de vencer. Guarda só o HASH, até o `exp`.
const usados = new Map()

function marcarUso(token, expS) {
  const agoraMs = Date.now()
  for (const [k, exp] of usados) if (exp <= agoraMs) usados.delete(k)
  const id = createHash('sha256').update(token).digest('hex')
  if (usados.has(id)) return false
  usados.set(id, expS * 1000)
  return true
}

/** Só para teste: esquece os tokens já usados. */
export function __resetReplayForTest() {
  usados.clear()
}

// ─── Conferências comuns ───────────────────────────────────────────────────
const recusa = (error, status = 401, code) => ({ ok: false, status, error, ...(code ? { code } : {}) })
const agoraS = () => Math.floor(Date.now() / 1000)

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** E-mail normalizado se for do domínio permitido; senão ''. */
function emailDoDominio(raw) {
  if (typeof raw !== 'string') return ''
  const email = raw.trim().toLowerCase()
  const re = new RegExp(`^[a-z0-9._%+'-]+@${escapeRegex(allowedDomain())}$`)
  return re.test(email) ? email : ''
}

/** exp no futuro, iat presente e não no futuro, vida curta. Devolve exp ou erro. */
function conferirTempo(p, abraDeNovo) {
  const now = agoraS()
  const exp = Number(p.exp)
  const iat = Number(p.iat)
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) return recusa(`Token de acesso inválido. ${abraDeNovo}`)
  if (exp <= now) return recusa(`O link de acesso venceu. ${abraDeNovo}`)
  if (iat > now + MAX_IAT_SKEW_S) return recusa(`Token de acesso inválido. ${abraDeNovo}`)
  if (exp - iat > MAX_LIFETIME_S || exp <= iat) return recusa(`Token de acesso inválido. ${abraDeNovo}`)
  return { ok: true, exp }
}

function nomeDe(p, email) {
  const n = typeof p.name === 'string' ? p.name.trim().slice(0, 120) : ''
  return n || email
}

// ─── Token do Hub Apps ─────────────────────────────────────────────────────
const ABRA_PELO_HUB = 'Abra os Indicadores de novo pelo Hub Apps.'

/**
 * Confere o token de lançamento emitido pelo Hub Apps.
 * @returns {{ok:true,email:string,name:string,via:'hub'} | {ok:false,status:number,error:string}}
 */
export function verifyHubLaunchToken(token) {
  if (!hubSsoConfigured()) {
    return recusa('A entrada pelo Hub Apps não está configurada neste servidor (HUB_SSO_SECRET).', 503)
  }
  const p = verifyHs256(token, hubSecret())
  if (!p) return recusa(`Token do Hub inválido. ${ABRA_PELO_HUB}`)

  const t = conferirTempo(p, ABRA_PELO_HUB)
  if (!t.ok) return t

  if (String(p.appId ?? '') !== hubAppId()) {
    return recusa('Este token do Hub foi emitido para outro aplicativo.', 403)
  }
  const email = emailDoDominio(p.email)
  if (!email) return recusa(`Somente contas @${allowedDomain()} acessam os Indicadores.`, 403)
  if (!marcarUso(token, t.exp)) return recusa(`Este link de acesso já foi usado. ${ABRA_PELO_HUB}`)

  return { ok: true, email, name: nomeDe(p, email), via: 'hub' }
}

// ─── Token do Data Hub (menu "Painéis") ────────────────────────────────────
const ABRA_PELO_DATAHUB = 'Abra os Painéis de novo pelo Data Hub, dentro do Hub Apps.'

/**
 * Confere o token emitido pelo Data Hub para o quadro "Painéis".
 * Contrato: HS256 com DATAHUB_SSO_SECRET e
 *   { iss: 'data-hub', aud: 'dashia', sub, email, name, via: 'hub'|'google', iat, exp }
 * com exp - iat <= 600 (o Data Hub deve emitir com 300 s).
 */
export function verifyDatahubLaunchToken(token) {
  if (!datahubSsoConfigured()) {
    return recusa('A entrada pelo Data Hub não está configurada neste servidor (DATAHUB_SSO_SECRET).', 503)
  }
  const p = verifyHs256(token, datahubSecret())
  if (!p) return recusa(`Token do Data Hub inválido. ${ABRA_PELO_DATAHUB}`)
  if (p.iss !== DATAHUB_ISS || p.aud !== DATAHUB_AUD) {
    return recusa(`Token do Data Hub inválido. ${ABRA_PELO_DATAHUB}`)
  }

  const t = conferirTempo(p, ABRA_PELO_DATAHUB)
  if (!t.ok) return t

  const email = emailDoDominio(p.email)
  if (!email) return recusa(`Somente contas @${allowedDomain()} acessam os Indicadores.`, 403)

  // Só pelo Hub: a sessão do Data Hub que pediu este token também precisa ter
  // vindo do Hub. Sem exceção — o master que entra direto no Data Hub (o
  // caminho de recuperação de lá) não ganha passagem para cá.
  if (hubOnlyActive() && p.via !== 'hub') {
    return recusa('Os Indicadores são acessados pelo Hub Apps. Abra o Data Hub pelo Hub e depois os Painéis.', 403, 'HUB_ONLY')
  }
  if (!marcarUso(token, t.exp)) return recusa(`Este link de acesso já foi usado. ${ABRA_PELO_DATAHUB}`)

  return { ok: true, email, name: nomeDe(p, email), via: 'datahub' }
}

/**
 * Troca um token de entrada (do Hub ou do Data Hub) pela identidade.
 *
 * Quem emitiu é lido do `iss` SEM conferir — só para escolher a chave. A
 * conferência de verdade é a da função escolhida, com a chave daquele emissor:
 * um token do Data Hub assinado com o segredo do Hub (ou o contrário) não
 * fecha em nenhuma das duas.
 */
export function verifyLaunchToken(token) {
  if (typeof token !== 'string' || !token) return recusa('Token de acesso ausente.', 400)
  const parts = token.split('.')
  const payload = parts.length === 3 ? decodePart(parts[1]) : null
  if (payload?.iss === DATAHUB_ISS) return verifyDatahubLaunchToken(token)
  return verifyHubLaunchToken(token)
}
