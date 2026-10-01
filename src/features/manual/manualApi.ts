// Manual de uso: o PDF (GET /api/manual, atrás do login) e o aviso de que o
// usuário novo já o abriu (POST /api/manual/seen) — ver server/index.mjs.
import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export async function fetchManualPdf(): Promise<ArrayBuffer> {
  const res = await apiFetch('/api/manual')
  if (!res.ok) {
    let message = `Erro ${res.status} ao carregar o manual.`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch { /* sem corpo JSON */ }
    throw new ApiError(res.status, message)
  }
  return res.arrayBuffer()
}

export async function markManualSeen(): Promise<void> {
  const res = await apiFetch('/api/manual/seen', { method: 'POST' })
  if (!res.ok) throw new ApiError(res.status, 'Não foi possível registrar a leitura do manual.')
}
