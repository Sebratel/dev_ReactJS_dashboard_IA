// Cliente HTTP central da API. Anexa o Bearer e, em 401, RENOVA o token
// silenciosamente e repete a chamada 1x. Só desloga se a sessão Google morreu
// de verdade (aí o RequireAuth manda pro /login). Todos os helpers de API usam.
import { useAuthStore } from '@/store/authStore'
import { refreshGoogleToken } from '@/store/googleAuth'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function withAuth(init: RequestInit | undefined, token: string | null): RequestInit {
  return { ...init, headers: { ...(init?.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = useAuthStore.getState().accessToken
  let res: Response
  try {
    res = await fetch(path, withAuth(init, token))
  } catch {
    throw new ApiError(0, 'Não foi possível falar com o servidor (backend offline?).')
  }
  if (res.status !== 401) return res

  let newToken: string | null = null
  try { newToken = await refreshGoogleToken() } catch { /* sessão Google indisponível */ }
  if (newToken) {
    try {
      res = await fetch(path, withAuth(init, newToken))
    } catch {
      throw new ApiError(0, 'Não foi possível falar com o servidor (backend offline?).')
    }
    if (res.status !== 401) return res
  }

  useAuthStore.getState().logout()
  throw new ApiError(401, 'Sessão expirada. Entre novamente.')
}
