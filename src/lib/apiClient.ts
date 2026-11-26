// Cliente HTTP central da API. Duas formas de sessão, cada uma num lugar só:
//
// - Login pelo Google: cookie HttpOnly definido pelo servidor (ver
//   server/sessions.mjs). Não há token para anexar — só pedir ao navegador que
//   envie os cookies (`credentials`).
// - Entrada pelo Hub Apps (ou pelo Data Hub dentro do Hub): o id da sessão fica
//   no sessionStorage do quadro (src/lib/hubEntry.ts) e vai aqui no
//   Authorization: Bearer. Quando ele existe, é ele que vale.
//
// Antes deste desenho, a página guardava o access_token do Google no
// localStorage, mandava num header Authorization e, em cada 401, tentava uma
// renovação silenciosa via Google Identity Services. Agora um 401 significa
// que a sessão realmente acabou, e o caminho é voltar pro login — o mesmo para
// o 403 com `code: 'HUB_ONLY'` (o servidor só aceita quem vem pelo Hub).
import { useAuthStore } from '@/store/authStore'
import { hubSessionToken } from '@/lib/hubEntry'

export class ApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const hub = hubSessionToken()
  if (hub) headers.set('Authorization', `Bearer ${hub}`)

  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Não foi possível falar com o servidor (backend offline?).')
  }

  if (res.status === 403) {
    // Só o 403 do "só pelo Hub" encerra a sessão; os outros (pasta sem acesso,
    // rota de admin) seguem para quem chamou tratar.
    let body: { code?: string; error?: string } | null = null
    try { body = await res.clone().json() } catch { /* sem corpo JSON */ }
    if (body?.code !== 'HUB_ONLY') return res
    useAuthStore.getState().logout()
    throw new ApiError(403, body.error || 'Acesse pelo Hub Apps.', 'HUB_ONLY')
  }
  if (res.status !== 401) return res

  // Sessão morta: limpa o estado local e deixa o RequireAuth do router levar
  // pro /login. Não há retentativa — não existe nada a renovar do lado do
  // cliente.
  useAuthStore.getState().logout()
  throw new ApiError(401, 'Sessão expirada. Entre novamente.')
}
