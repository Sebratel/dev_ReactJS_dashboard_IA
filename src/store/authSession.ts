// Carrega a sessão atual do servidor e alimenta o authStore.
//
// Substitui o que o fluxo antigo fazia: a identidade vinha do localStorage
// (persistida pelo zustand) e o access_token era renovado no navegador. Agora
// o cookie de sessão é HttpOnly — o JavaScript não consegue lê-lo — então a
// única forma de saber quem está logado é perguntar ao servidor.
//
// Chamado uma vez na subida do app (src/main.tsx) e depois do retorno do
// login. Um 401 aqui é o caso normal de "ninguém logado".
import { useAuthStore } from './authStore'
import { apiFetch, ApiError } from '@/lib/apiClient'
import { entrarComGoogle, sairDoGoogle } from '@/lib/firebase'
import { consumeSsoToken, hubSessionToken, isFramed, saveHubSession, clearHubSession } from '@/lib/hubEntry'
import type { AuthUser } from './authStore'

/** Como a tela de login deve se apresentar (rota pública do servidor). */
async function loadAuthConfig(): Promise<{ hubOnly: boolean }> {
  try {
    const res = await fetch('/api/auth/config', { credentials: 'same-origin' })
    if (!res.ok) return { hubOnly: false }
    const body = await res.json() as { hubOnly?: boolean; hubUrl?: string }
    const cfg = { hubOnly: body.hubOnly === true, hubUrl: String(body.hubUrl || '') }
    useAuthStore.getState().setAuthConfig(cfg)
    return cfg
  } catch {
    // Backend fora: a tela segue com o padrão; quem decide é o servidor.
    return { hubOnly: false }
  }
}

/**
 * Entrada pelo Hub Apps (ou pelo Data Hub dentro do Hub): troca o ?sso_token,
 * já tirado da URL por src/lib/hubEntry.ts, por uma sessão do servidor, que
 * fica no sessionStorage do quadro.
 *
 * Com "só pelo Hub", a troca só acontece DENTRO de um quadro: o link aberto
 * numa aba solta cai na tela "Acesse pelo Hub Apps".
 */
async function enterFromHub(token: string, hubOnly: boolean): Promise<void> {
  const store = useAuthStore.getState()
  if (hubOnly && !isFramed()) {
    store.setHubError('Os Indicadores abrem dentro do Hub Apps. Use o botão abaixo.')
    return
  }
  try {
    const res = await fetch('/api/auth/hub', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    let body: any = null
    try { body = await res.json() } catch { /* sem corpo */ }
    if (!res.ok || !body?.token) {
      clearHubSession()
      store.setHubError(body?.error || `Erro ${res.status} ao entrar pelo Hub Apps.`)
      return
    }
    saveHubSession({ token: body.token, expiresAt: body.expiresAt })
    store.setHubError(null)
  } catch {
    store.setHubError('Não foi possível falar com o servidor para entrar pelo Hub Apps.')
  }
}

let booting: Promise<void> | null = null

/**
 * Subida do app, chamada UMA vez em src/main.tsx (fora do React, então o
 * StrictMode não a repete): configuração da tela → troca do token do Hub, se
 * veio um → quem está logado. O router espera o `ready` do authStore, então o
 * guarda de rota nunca manda para o login antes de a troca terminar.
 */
export function bootAuth(): Promise<void> {
  if (!booting) {
    booting = (async () => {
      const token = consumeSsoToken()
      const { hubOnly } = await loadAuthConfig()
      if (token) await enterFromHub(token, hubOnly)
      await loadSession()
    })()
  }
  return booting
}

export async function loadSession(): Promise<AuthUser | null> {
  try {
    const res = await apiFetch('/api/auth/me')
    if (!res.ok) throw new ApiError(res.status, 'Sessão indisponível.')
    const body = await res.json() as { user: AuthUser; isAdmin: boolean; manualPending?: boolean }
    useAuthStore.getState().setSession(body)
    return body.user
  } catch {
    // Sem sessão (401), ou backend fora do ar: nos dois casos o app fica
    // deslogado. `ready` marcado do mesmo jeito, senão a tela travaria num
    // carregamento infinito quando o backend está fora.
    useAuthStore.getState().logout()
    return null
  }
}

/**
 * Login: popup do Google pelo SDK do Firebase e, com o ID token na mão, uma
 * chamada ao servidor pra abrir a sessão (cookie HttpOnly).
 *
 * Não é mais uma navegação de página: o fluxo de código de autorização, que
 * mandava o navegador pro /api/auth/google/start, foi aposentado em 13/09/2026
 * — ver a skill padrao-login-sso e server/firebaseToken.mjs.
 *
 * O ID token vive só o tempo desta função. Quem sustenta a navegação depois é
 * o cookie, que o JavaScript não lê.
 */
export async function loginWithGoogle(): Promise<AuthUser> {
  const { idToken, googleAccessToken, googleAccessTokenExpiresAt } = await entrarComGoogle()

  let res: Response
  try {
    res = await apiFetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, googleAccessToken, googleAccessTokenExpiresAt }),
    })
  } catch (e) {
    // 403 HUB_ONLY (o servidor só aceita quem vem pelo Hub): o vínculo com o
    // Google também não fica de pé.
    await sairDoGoogle()
    throw e
  }
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) {
    // O servidor recusou (domínio errado, e-mail não verificado, token
    // inválido). O vínculo com o Google no navegador não pode ficar de pé:
    // senão a próxima tentativa entra sem popup e falha igual, sem a pessoa
    // entender por quê.
    await sairDoGoogle()
    throw new ApiError(res.status, body?.error || 'Não foi possível entrar.')
  }

  useAuthStore.getState().setSession(body)
  return body.user
}

export async function logout(): Promise<void> {
  // Sessão aberta pelo Hub: não há vínculo com o Google para desfazer.
  const viaHub = !!hubSessionToken()
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' })
  } catch {
    // Falha de rede não deve prender ninguém numa sessão que quis encerrar —
    // o estado local é limpo de qualquer forma.
  }
  // Encerra também o vínculo com o Google: sem isto, "Sair" e "Entrar" de novo
  // voltaria com a MESMA conta sem perguntar nada, e trocar de usuário viraria
  // um mistério.
  if (!viaHub) await sairDoGoogle()
  useAuthStore.getState().logout()
}
