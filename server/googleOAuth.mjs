// ─────────────────────────────────────────────────────────────────────────
// Fluxo de CÓDIGO DE AUTORIZAÇÃO do Google (server-side), que substituiu o
// fluxo implícito feito no navegador.
//
// Como era antes: a página pedia um access_token direto ao Google (Google
// Identity Services), guardava esse token no localStorage e mandava em cada
// requisição; o backend validava batendo em /userinfo. Não havia segredo do
// servidor envolvido — e também não havia refresh_token: a sessão só
// sobrevivia enquanto a sessão Google do NAVEGADOR estivesse viva, através de
// uma renovação silenciosa que falhava sem aviso.
//
// Como é agora:
//   1. /api/auth/google/start        → redireciona pro Google (com `state`)
//   2. Google redireciona de volta    → /api/auth/google/callback?code=…
//   3. o servidor troca o `code`      → access_token + refresh_token
//      (é aqui que GOOGLE_CLIENT_SECRET é usado — só o servidor o conhece)
//   4. sessão gravada no servidor     → cookie HttpOnly no navegador
//
// Ganhos: o token nunca passa pelo JavaScript da página; a sessão dura porque
// temos refresh_token de verdade; e o refresh_token guardado abre caminho pra
// atualizar planilhas do Google em segundo plano (hoje impossível, ver o
// comentário em server/sheetSources.mjs).
//
// O escopo é o MESMO de antes, importado de src/lib/googleScopes.ts pra não
// existirem duas listas divergindo (é também por isso que a API sobe com
// `tsx` — ver Dockerfile.api).
// ─────────────────────────────────────────────────────────────────────────
import { GOOGLE_OAUTH_SCOPE } from '../src/lib/googleScopes.ts'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo'

export const CALLBACK_PATH = '/api/auth/google/callback'

function credentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID não configurado no ambiente da API.')
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET não configurado no ambiente da API.')
  return { clientId, clientSecret }
}

export function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID) && !!process.env.GOOGLE_CLIENT_SECRET
}

// O redirect_uri precisa ser IDÊNTICO ao cadastrado no Google Cloud, incluindo
// esquema, host e porta. Preferimos APP_BASE_URL (explícito, à prova de proxy
// mal configurado); sem ela, deriva da requisição respeitando os cabeçalhos
// que o nginx repassa (ver docker/nginx.conf).
export function resolveRedirectUri(req) {
  const base = (process.env.APP_BASE_URL || '').trim()
  if (base) return new URL(CALLBACK_PATH, base).toString()
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  if (!host) throw new Error('Não foi possível determinar o endereço público da aplicação — defina APP_BASE_URL.')
  return `${proto}://${host}${CALLBACK_PATH}`
}

export function buildAuthUrl({ redirectUri, state }) {
  const { clientId } = credentials()
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('include_granted_scopes', 'true')
  // offline + consent é o que GARANTE um refresh_token nesta troca. Sem
  // `prompt=consent`, o Google só devolve refresh_token no primeiro consent de
  // cada usuário — nos logins seguintes viria sem, e a sessão não teria como
  // se renovar. O custo é a tela de consentimento aparecer a cada login, o que
  // é aceitável porque a sessão dura semanas (ver server/sessions.mjs).
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  // Dica de domínio: já abre o seletor de conta filtrado no Workspace.
  const domain = process.env.ALLOWED_DOMAIN
  if (domain) url.searchParams.set('hd', domain)
  return url.toString()
}

async function postToken(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    // O Google devolve { error, error_description } — a descrição costuma
    // dizer exatamente o que está errado (redirect_uri divergente, secret
    // errado, code já usado).
    const detail = body?.error_description || body?.error || `HTTP ${res.status}`
    throw new Error(`O Google recusou a troca de token: ${detail}`)
  }
  return body
}

// Troca o `code` recebido no callback pelos tokens. Devolve também
// `expiresAt` já em epoch ms, que é o formato que a sessão guarda.
export async function exchangeCode({ code, redirectUri }) {
  const { clientId, clientSecret } = credentials()
  const body = await postToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  }
}

// Renova o access_token a partir do refresh_token. O Google normalmente NÃO
// devolve um refresh_token novo aqui — quem chama deve manter o que já tem.
export async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = credentials()
  const body = await postToken({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  }
}

export async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Não foi possível ler os dados da conta Google (HTTP ${res.status}).`)
  const p = await res.json()
  if (!p.email) throw new Error('A conta Google não devolveu um e-mail.')
  if (p.email_verified === false) throw new Error('O e-mail desta conta Google não é verificado.')
  return { email: String(p.email).toLowerCase(), name: p.name || p.email, picture: p.picture ?? null }
}
