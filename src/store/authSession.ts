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
import type { AuthUser } from './authStore'

export async function loadSession(): Promise<AuthUser | null> {
  try {
    const res = await apiFetch('/api/auth/me')
    if (!res.ok) throw new ApiError(res.status, 'Sessão indisponível.')
    const body = await res.json() as { user: AuthUser; isAdmin: boolean }
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

// Redireciona o navegador para o início do fluxo no servidor. Não é fetch: o
// Google precisa de uma navegação de página de verdade (e é ela que traz o
// cookie de volta no callback).
export function startGoogleLogin(): void {
  window.location.href = '/api/auth/google/start'
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' })
  } catch {
    // Falha de rede não deve prender ninguém numa sessão que quis encerrar —
    // o estado local é limpo de qualquer forma.
  }
  useAuthStore.getState().logout()
}
