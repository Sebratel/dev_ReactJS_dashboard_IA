// Cliente HTTP central da API. A sessão é um cookie HttpOnly definido pelo
// servidor (ver server/sessions.mjs), então não há token para anexar aqui —
// só é preciso pedir ao navegador que envie os cookies (`credentials`).
//
// Antes deste desenho, a página guardava o access_token do Google no
// localStorage, mandava num header Authorization e, em cada 401, tentava uma
// renovação silenciosa via Google Identity Services. Agora a renovação é
// responsabilidade do servidor (que tem o refresh_token): um 401 aqui significa
// que a sessão realmente acabou, e o caminho é voltar pro login.
import { useAuthStore } from '@/store/authStore'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(path, { ...init, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Não foi possível falar com o servidor (backend offline?).')
  }
  if (res.status !== 401) return res

  // Sessão morta: limpa o estado local e deixa o RequireAuth do router levar
  // pro /login. Não há retentativa — não existe nada a renovar do lado do
  // cliente.
  useAuthStore.getState().logout()
  throw new ApiError(401, 'Sessão expirada. Entre novamente.')
}
