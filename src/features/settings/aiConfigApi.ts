// Configuração do provedor de IA (Configurações › Provedor de IA).
//
// A credencial NUNCA vem inteira do servidor: o que chega é `keyMasks`, uma
// máscara por provedor (ou null quando não há chave salva, ou 'ilegível'
// quando existe algo salvo que a chave de cifra atual não abre). Ao salvar,
// `apiKey` só é enviada quando a pessoa digitou uma nova — mandar a máscara de
// volta destruiria a credencial no servidor.
import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export type ProviderId = 'anthropic' | 'openai' | 'gemini'

export interface AiPrice {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface ProviderModel {
  id: string
  label: string
  price: AiPrice
}

export interface ProviderMeta {
  label: string
  keyLabel: string
  keyUrl: string
  defaultModel: string
  supportsEffort: boolean
  supportsPromptCache: boolean
  models: ProviderModel[]
}

export interface AiConfig {
  provider: ProviderId
  model: string
  effort: string
  maxTokens: number
  maxIterations: number
  dailyBudgetUsd: number
  price: AiPrice
  baseUrls: Record<ProviderId, string>
  keyMasks: Record<ProviderId, string | null>
  updatedAt: string | null
  updatedBy: string | null
  providers: Record<ProviderId, ProviderMeta>
  effortLevels: string[]
}

// O que o formulário envia. `apiKey` ausente = não mexer na credencial;
// string vazia = remover.
export interface AiConfigPatch {
  provider: ProviderId
  model: string
  effort: string
  maxTokens: number
  maxIterations: number
  dailyBudgetUsd: number
  price: AiPrice
  baseUrl: string
  apiKey?: string
}

export interface TestResult {
  ok: boolean
  ms?: number
  model?: string
  reply?: string
  error?: string
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

export async function fetchAiConfig(): Promise<AiConfig> {
  return parse<AiConfig>(await apiFetch('/api/ai/config'))
}

export async function saveAiConfig(patch: AiConfigPatch): Promise<AiConfig> {
  return parse<AiConfig>(await apiFetch('/api/ai/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }))
}

// Modelos vindos do PRÓPRIO provedor, com a credencial informada. Devolve 200
// com `error` quando o provedor recusa a listagem — a lista vazia mais a frase
// dele é o resultado útil, não uma falha da nossa API.
export async function listAiModels(input: { provider: ProviderId; baseUrl: string; apiKey?: string }): Promise<{ models: ProviderModel[]; error?: string }> {
  const body = await parse<{ models: { id: string; label: string }[]; error?: string }>(await apiFetch('/api/ai/config/models', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }))
  return {
    // O preço não vem do provedor (a API dele não expõe tabela de preço), então
    // entra zerado e quem escolhe preenche — ou vem da tabela conhecida, que o
    // servidor já aplica ao salvar.
    models: body.models.map((m) => ({ ...m, price: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } })),
    error: body.error,
  }
}

// O teste devolve 200 mesmo quando falha (ok:false + a mensagem do provedor):
// credencial errada é o RESULTADO esperado da ação, não erro da nossa API — e
// é o texto do provedor que diz o que está errado.
export async function testAiProvider(input: { provider: ProviderId; model: string; baseUrl: string; apiKey?: string }): Promise<TestResult> {
  return parse<TestResult>(await apiFetch('/api/ai/config/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }))
}
