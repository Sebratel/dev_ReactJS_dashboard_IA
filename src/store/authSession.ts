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
import type { AuthUser } from './authStore'

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

  const res = await apiFetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, googleAccessToken, googleAccessTokenExpiresAt }),
  })
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
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' })
  } catch {
    // Falha de rede não deve prender ninguém numa sessão que quis encerrar —
    // o estado local é limpo de qualquer forma.
  }
  // Encerra também o vínculo com o Google: sem isto, "Sair" e "Entrar" de novo
  // voltaria com a MESMA conta sem perguntar nada, e trocar de usuário viraria
  // um mistério.
  await sairDoGoogle()
  useAuthStore.getState().logout()
}
