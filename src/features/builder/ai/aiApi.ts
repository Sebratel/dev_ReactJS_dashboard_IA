// Cliente da montagem com IA (server/aiAssistant.mjs).
//
// O turno é lido como STREAM: a resposta do servidor é SSE, então o texto
// aparece digitando e os widgets propostos chegam como um evento próprio, sem
// esperar o modelo terminar. Não uso EventSource porque ele só faz GET — e o
// turno precisa mandar a mensagem no corpo; então é fetch + leitura do corpo.
import { apiFetch, ApiError } from '@/lib/apiClient'
import type { TabRelation, WidgetConfig } from '../types'

export { ApiError }

export interface AiStatus {
  configured: boolean
  model: string
  spentUsd: number
  budgetUsd: number
}

export interface AiConversation {
  conversationId: string
  sources: { key: string; label: string; fieldCount: number }[]
}

export type AiEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'widgets'; widgets: WidgetConfig[]; summary: string }
  | { type: 'done'; usd: number; usage: AiStatus }
  | { type: 'error'; message: string }

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

export async function fetchAiStatus(): Promise<AiStatus> {
  return parse(await apiFetch('/api/ai/status'))
}

export async function startAiConversation(folderId: string, sourceKeys: string[]): Promise<AiConversation> {
  return parse(await apiFetch('/api/ai/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId, sourceKeys }),
  }))
}

export interface WidgetInsight {
  text: string
  usd: number
  cached: boolean
}

// Leitura de um gráfico. Sem streaming: são três parágrafos, esperar por eles
// inteiros é mais simples que montar SSE pra ganhar meio segundo.
// `calc` são as linhas do "Como foi calculado" que a tela já está mostrando —
// vão junto pra que o modelo interprete exatamente o gráfico que a pessoa vê.
export async function fetchWidgetInsight(body: {
  widget: WidgetConfig
  tabFilters: unknown[]
  relations?: TabRelation[]
  calc: { label: string; value: string }[]
  force?: boolean
}): Promise<WidgetInsight> {
  return parse(await apiFetch('/api/ai/insight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
}

// Gerador dos eventos de um turno. Quem consome faz `for await (const ev of
// streamAiTurn(...))` e reage a cada tipo.
export async function* streamAiTurn(conversationId: string, text: string): AsyncGenerator<AiEvent> {
  const res = await apiFetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })
  // Erro antes do stream começar (400/403/503) vem como JSON normal.
  if (!res.ok || !res.body) {
    let body: any = null
    try { body = await res.json() } catch { /* sem corpo */ }
    throw new ApiError(res.status, body?.error || 'Não foi possível falar com a IA.')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Eventos SSE são separados por linha em branco; um chunk da rede pode
    // cortar no meio de um, então só consumo os completos e guardo o resto.
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      try {
        yield JSON.parse(line.slice(6)) as AiEvent
      } catch { /* pedaço malformado — ignora em vez de derrubar a conversa */ }
    }
  }
}
