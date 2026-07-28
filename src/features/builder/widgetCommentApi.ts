// Cliente HTTP dos comentários/anotações de widget (server/widgetComments.mjs)
// — qualquer usuário autenticado lê/comenta; remover é só de quem escreveu
// (ou admin), checado no servidor.
import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export interface WidgetComment {
  id: string
  widgetId: string
  text: string
  authorEmail: string
  authorName: string
  createdAt: string
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

export async function fetchWidgetComments(widgetId: string): Promise<WidgetComment[]> {
  const body = await parse<{ comments: WidgetComment[] }>(await apiFetch(`/api/widget-comments/${encodeURIComponent(widgetId)}`))
  return body.comments
}

export async function addWidgetComment(widgetId: string, text: string): Promise<WidgetComment> {
  const body = await parse<{ comment: WidgetComment }>(await apiFetch('/api/widget-comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ widgetId, text }),
  }))
  return body.comment
}

export async function deleteWidgetComment(id: string): Promise<void> {
  await parse(await apiFetch(`/api/widget-comments/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

export async function fetchWidgetCommentCounts(widgetIds: string[]): Promise<Record<string, number>> {
  if (widgetIds.length === 0) return {}
  const body = await parse<{ counts: Record<string, number> }>(
    await apiFetch(`/api/widget-comments/counts?ids=${widgetIds.map(encodeURIComponent).join(',')}`),
  )
  return body.counts
}
