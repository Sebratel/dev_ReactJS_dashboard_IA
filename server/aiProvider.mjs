// ─────────────────────────────────────────────────────────────────────────
// Adaptador de provedores de IA — Anthropic, OpenAI e Google Gemini por trás
// de UMA interface, para o motor do assistente (server/aiAssistant.mjs) não
// saber com quem está falando.
//
// FORMATO CANÔNICO = O DA ANTHROPIC. Não por preferência: é o formato que o
// histórico de conversa JÁ guarda em memória (conv.messages), é o mais rico
// dos três (blocos tipados, tool_use/tool_result com id, mensagem de sistema
// no meio da conversa) e é o único que suporta cache de prompt explícito —
// que é a maior economia desta feature. Traduzir na BORDA, e só pra quem não
// é Anthropic, mantém o caminho em produção idêntico ao que já funcionava:
// para a Anthropic este arquivo é repasse, sem conversão nenhuma.
//
//   canônico  { role, content: string | bloco[] }
//   blocos    { type:'text', text }
//             { type:'tool_use', id, name, input }
//             { type:'tool_result', tool_use_id, content, is_error? }
//
// O QUE CADA PROVEDOR NÃO TEM, e como isso é tratado:
//
//   • Cache de prompt explícito (`cache_control`): só Anthropic. Nos outros o
//     campo é removido — OpenAI e Gemini fazem cache implícito de prefixo, que
//     não se controla por requisição. Consequência real: o 2º turno em diante
//     custa mais fora da Anthropic. Está dito na tela.
//   • Esforço (`effort`): só Anthropic. Ignorado nos outros.
//   • Mensagem de sistema NO MEIO da conversa (o aviso de "conclua agora" do
//     laço): OpenAI aceita como `role:'system'`; o Gemini não tem esse papel
//     dentro de `contents`, então ela desce como mensagem de usuário marcada
//     com um prefixo. Perde autoridade de operador, mas o aviso chega.
//   • Id de chamada de ferramenta: o Gemini não devolve um. Como o formato
//     canônico exige (tool_result referencia tool_use_id), um id é sintetizado
//     aqui e a volta usa o NOME da função, que é o que o Gemini espera.
//
// SEM SDK NOVO para OpenAI/Gemini, de propósito: as duas APIs são REST
// simples, `fetch` já é usado no projeto (server/googleSheets.mjs) e este
// repositório versiona o node_modules — cada SDK novo entraria como milhares
// de arquivos no histórico. A Anthropic continua no SDK oficial, que já era
// dependência.
// ─────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { aiConfig, PROVIDERS } from './aiConfig.mjs'

// Um turno pode ser longo (o modelo raciocina, chama ferramenta, raciocina de
// novo). Timeout generoso, mas existente: sem nenhum, uma conexão pendurada
// prenderia o SSE do navegador para sempre.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

function usageZero() {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
}

// ─── Anthropic ─────────────────────────────────────────────────────────
// Repasse. O cliente é recriado quando a credencial OU o endpoint mudam (os
// dois vêm da configuração salva, que a tela troca a qualquer momento) — por
// isso o cache é por par chave+endpoint, e não um singleton.
let anthropicCache = { signature: null, client: null }

function anthropicClient(apiKey, baseUrl) {
  const signature = `${apiKey}|${baseUrl ?? ''}`
  if (anthropicCache.signature !== signature) {
    anthropicCache = {
      signature,
      client: new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) }),
    }
  }
  return anthropicCache.client
}

// O canônico pode carregar a thought signature que o Gemini exige de volta
// (ver toGeminiContents). A Anthropic recusa campo desconhecido num bloco, então
// ele sai aqui — é o que mantém a troca de provedor no meio da conversa valendo.
function withoutGeminiFields(messages) {
  return messages.map((m) => (Array.isArray(m.content)
    ? { ...m, content: m.content.map(({ thoughtSignature, ...b }) => b) }
    : m))
}

async function anthropicTurn({ cfg, system, messages, tools, onText }) {
  const stream = anthropicClient(cfg.apiKey, cfg.baseUrl).messages.stream({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    output_config: { effort: cfg.effort },
    system,
    ...(tools?.length ? { tools } : {}),
    messages: withoutGeminiFields(messages),
  })
  if (onText) stream.on('text', (delta) => onText(delta))
  const message = await stream.finalMessage()

  const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  const toolCalls = (message.content ?? [])
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }))

  return {
    text,
    toolCalls,
    stopReason: message.stop_reason,
    // Blocos crus: o histórico canônico guarda exatamente o que a Anthropic
    // devolveu, inclusive blocos que este adaptador não interpreta.
    content: message.content,
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
    },
  }
}

// ─── Utilidades comuns aos provedores REST ─────────────────────────────

// Texto plano de um `system` canônico (string ou lista de blocos), já sem
// `cache_control` — que não existe fora da Anthropic.
function systemToText(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n')
}

function blocksOf(content) {
  if (content == null) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : [content]
}

// Mapa id da chamada → nome da função, varrendo o histórico. O Gemini precisa
// do nome na volta do resultado, e o canônico só carrega o id.
function toolNamesById(messages) {
  const map = new Map()
  for (const m of messages) {
    for (const b of blocksOf(m.content)) {
      if (b.type === 'tool_use') map.set(b.id, b.name)
    }
  }
  return map
}

// JSON Schema aceito por todos: o Gemini recusa `additionalProperties` e
// palavras-chave que não conhece, e devolve 400 com uma mensagem que não diz
// qual campo — então a limpeza é recursiva e conservadora.
const SCHEMA_KEYS_UNSUPPORTED = new Set(['additionalProperties', '$schema', '$id', 'definitions', '$defs'])

function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (SCHEMA_KEYS_UNSUPPORTED.has(k)) continue
    out[k] = sanitizeSchema(v)
  }
  return out
}

// Todo provedor devolve o motivo dentro de um envelope JSON próprio. Mostrar o
// JSON cru na tela obriga quem administra a garimpar a única frase que importa
// ("chave inválida", "modelo não existe", "sem saldo") — então ela é extraída
// aqui, com o corpo bruto como último recurso.
function describeErrorBody(body) {
  try {
    const j = JSON.parse(body)
    return j.error?.message ?? j.error?.error?.message ?? j.message ?? body.slice(0, 400)
  } catch {
    return body.slice(0, 400)
  }
}

// Mesma ideia para o erro que o SDK da Anthropic levanta: ele guarda o corpo
// já desempacotado em `.error`, e o `.message` traz o JSON inteiro colado.
function providerErrorMessage(e) {
  return e?.error?.error?.message ?? e?.error?.message ?? e?.message ?? String(e)
}

async function fetchJson(url, init) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} — ${describeErrorBody(body) || res.statusText}`)
    }
    return res
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Lê um corpo SSE linha a linha e entrega cada JSON de `data:`.
 * Escrito à mão porque é o único pedaço de protocolo que OpenAI e Gemini têm
 * em comum, e porque um leitor de 20 linhas é menos superfície que uma
 * dependência nova.
 */
async function* sseEvents(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Evento SSE termina em linha vazia; mas os dois provedores mandam um
    // `data:` por linha, então quebrar por linha basta e é mais tolerante.
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        yield JSON.parse(payload)
      } catch {
        // Fragmento inválido: ignorar é o certo aqui. Um chunk perdido degrada
        // a resposta; derrubar o turno perde o dinheiro já gasto nele.
      }
    }
  }
}

// ─── OpenAI (Chat Completions) ─────────────────────────────────────────

function toOpenAiMessages(system, messages) {
  const out = []
  const sys = systemToText(system)
  if (sys) out.push({ role: 'system', content: sys })

  for (const m of messages) {
    // Mensagem de sistema no meio da conversa: a OpenAI aceita o papel, então
    // o aviso de operador chega como operador.
    if (m.role === 'system') { out.push({ role: 'system', content: systemToText(m.content) || String(m.content ?? '') }); continue }

    const blocks = blocksOf(m.content)
    const results = blocks.filter((b) => b.type === 'tool_result')
    if (results.length) {
      // Resultados de ferramenta viram UMA mensagem `tool` cada — é o formato
      // da OpenAI. O canônico junta todos numa mensagem de usuário só.
      for (const r of results) {
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: String(r.content ?? '') })
      }
      const extraText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (extraText) out.push({ role: 'user', content: extraText })
      continue
    }

    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const calls = blocks.filter((b) => b.type === 'tool_use')
    if (m.role === 'assistant' && calls.length) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        })),
      })
      continue
    }
    out.push({ role: m.role, content: text })
  }
  return out
}

async function openAiTurn({ cfg, system, messages, tools, onText }) {
  const body = {
    model: cfg.model,
    max_completion_tokens: cfg.maxTokens,
    messages: toOpenAiMessages(system, messages),
    stream: true,
    // Sem isto o chunk final não traz `usage`, e o medidor de gasto ficaria
    // sempre em zero fora da Anthropic.
    stream_options: { include_usage: true },
    ...(tools?.length
      ? {
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: sanitizeSchema(t.input_schema) },
        })),
      }
      : {}),
  }

  // Endpoint configurável: além de proxy/gateway corporativo, é o que permite
  // apontar pra um serviço compatível com a API da OpenAI.
  const base = cfg.baseUrl || 'https://api.openai.com/v1'
  const res = await fetchJson(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  })

  let text = ''
  let finish = null
  const usage = usageZero()
  // Chamadas chegam fatiadas: `arguments` vem em pedaços, identificados pelo
  // índice dentro do array. Acumular por índice é a única forma de remontar.
  const byIndex = new Map()

  for await (const evt of sseEvents(res)) {
    if (evt.usage) {
      usage.inputTokens = evt.usage.prompt_tokens ?? 0
      usage.outputTokens = evt.usage.completion_tokens ?? 0
      usage.cacheReadTokens = evt.usage.prompt_tokens_details?.cached_tokens ?? 0
    }
    const choice = evt.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finish = choice.finish_reason

    const delta = choice.delta ?? {}
    if (delta.content) { text += delta.content; onText?.(delta.content) }
    for (const call of delta.tool_calls ?? []) {
      const idx = call.index ?? 0
      const acc = byIndex.get(idx) ?? { id: null, name: '', args: '' }
      if (call.id) acc.id = call.id
      if (call.function?.name) acc.name = call.function.name
      if (call.function?.arguments) acc.args += call.function.arguments
      byIndex.set(idx, acc)
    }
  }

  const toolCalls = [...byIndex.values()].filter((c) => c.name).map((c) => ({
    id: c.id ?? `call_${randomUUID()}`,
    name: c.name,
    // Argumento inválido não pode derrubar o turno: vira objeto vazio, a
    // ferramenta reclama do que falta e o modelo corrige na próxima ida —
    // que é exatamente o laço de correção que o motor já tem.
    input: safeJson(c.args),
  }))

  return {
    text,
    toolCalls,
    stopReason: mapOpenAiFinish(finish, toolCalls.length),
    content: canonicalAssistantContent(text, toolCalls),
    usage,
  }
}

function safeJson(raw) {
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

function mapOpenAiFinish(finish, toolCount) {
  if (finish === 'tool_calls' || toolCount > 0) return 'tool_use'
  if (finish === 'length') return 'max_tokens'
  if (finish === 'content_filter') return 'refusal'
  return 'end_turn'
}

// ─── Google Gemini ─────────────────────────────────────────────────────

function toGeminiContents(messages) {
  const names = toolNamesById(messages)
  const out = []
  for (const m of messages) {
    const blocks = blocksOf(m.content)

    if (m.role === 'system') {
      // O Gemini não tem papel de sistema dentro de `contents`. O aviso desce
      // como usuário, marcado, pra não se confundir com pedido da pessoa.
      const t = systemToText(m.content) || String(m.content ?? '')
      if (t) out.push({ role: 'user', parts: [{ text: `[instrução do sistema] ${t}` }] })
      continue
    }

    const results = blocks.filter((b) => b.type === 'tool_result')
    if (results.length) {
      out.push({
        role: 'user',
        parts: results.map((r) => ({
          functionResponse: {
            name: names.get(r.tool_use_id) ?? 'unknown',
            // A resposta precisa ser objeto. O canônico carrega texto (é o que
            // as ferramentas deste app devolvem), então vai embrulhado.
            response: r.is_error ? { error: String(r.content ?? '') } : { result: String(r.content ?? '') },
          },
        })),
      })
      continue
    }

    // A thought signature volta na MESMA parte em que chegou. Os modelos
    // Gemini 3 recusam (HTTP 400) um histórico cuja chamada de ferramenta do
    // turno atual veio sem ela — e quase todo turno da montagem chama uma.
    const sig = (b) => (b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : {})
    const parts = []
    for (const b of blocks) {
      if (b.type === 'text' && b.text) parts.push({ text: b.text, ...sig(b) })
      if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input ?? {} }, ...sig(b) })
    }
    if (!parts.length) continue
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }
  return out
}

async function geminiTurn({ cfg, system, messages, tools, onText }) {
  const sys = systemToText(system)
  const body = {
    contents: toGeminiContents(messages),
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    generationConfig: { maxOutputTokens: cfg.maxTokens },
    ...(tools?.length
      ? {
        tools: [{
          functionDeclarations: tools.map((t) => ({
            name: t.name, description: t.description, parameters: sanitizeSchema(t.input_schema),
          })),
        }],
      }
      : {}),
  }

  const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`
  const res = await fetchJson(url, {
    method: 'POST',
    // Chave em cabeçalho, não na query: evita a credencial cair em log de
    // proxy ou de acesso, que é onde URL costuma ir parar.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify(body),
  })

  let text = ''
  let textSignature = null
  let finish = null
  const usage = usageZero()
  const toolCalls = []

  for await (const evt of sseEvents(res)) {
    if (evt.usageMetadata) {
      usage.inputTokens = evt.usageMetadata.promptTokenCount ?? 0
      usage.outputTokens = evt.usageMetadata.candidatesTokenCount ?? 0
      usage.cacheReadTokens = evt.usageMetadata.cachedContentTokenCount ?? 0
    }
    const cand = evt.candidates?.[0]
    if (!cand) continue
    if (cand.finishReason) finish = cand.finishReason
    for (const part of cand.content?.parts ?? []) {
      if (part.text) { text += part.text; onText?.(part.text) }
      // Modelos com raciocínio mandam uma assinatura junto da parte; ela é
      // guardada no canônico pra voltar na próxima ida (ver toGeminiContents).
      if (part.thoughtSignature && !part.functionCall) textSignature = part.thoughtSignature
      if (part.functionCall) {
        toolCalls.push({
          // Id sintético: o Gemini não manda um, e o formato canônico precisa
          // dele pra casar tool_result com tool_use.
          id: `gem_${randomUUID()}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        })
      }
    }
  }

  return {
    text,
    toolCalls,
    stopReason: mapGeminiFinish(finish, toolCalls.length),
    content: canonicalAssistantContent(text, toolCalls, textSignature),
    usage,
  }
}

function mapGeminiFinish(finish, toolCount) {
  if (toolCount > 0) return 'tool_use'
  if (finish === 'MAX_TOKENS') return 'max_tokens'
  if (finish === 'SAFETY' || finish === 'BLOCKLIST' || finish === 'PROHIBITED_CONTENT') return 'refusal'
  return 'end_turn'
}

// Reconstrói o conteúdo do assistente no formato CANÔNICO, pro histórico ficar
// igual independente de quem respondeu — é isso que permite trocar de provedor
// no meio de uma conversa sem corromper o que já foi dito.
function canonicalAssistantContent(text, toolCalls, textSignature = null) {
  const content = []
  if (text) content.push({ type: 'text', text, ...(textSignature ? { thoughtSignature: textSignature } : {}) })
  for (const c of toolCalls) {
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input,
      ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) })
  }
  return content
}

// ─── Catálogo de modelos, perguntado ao provedor ───────────────────────
// Os três expõem um endpoint que lista os modelos da conta. Perguntar é melhor
// que embutir uma lista: catálogo de modelo muda toda hora, e uma lista fixa no
// código envelhece em silêncio — some um modelo que ainda existe, ou oferece um
// que a conta não tem acesso.

// Ids que a OpenAI devolve mas não servem pra conversa com ferramenta (áudio,
// imagem, embedding, moderação). Sem esse filtro a lista vem com ~80 entradas e
// convida a escolher um modelo que falharia na primeira mensagem.
const OPENAI_FORA = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search|codex-mini)/i

async function anthropicModels({ apiKey, baseUrl }) {
  const client = anthropicClient(apiKey, baseUrl)
  const out = []
  // O SDK pagina sozinho no for await.
  for await (const m of client.models.list({ limit: 100 })) {
    out.push({ id: m.id, label: m.display_name ?? m.id })
    if (out.length >= 200) break
  }
  return out
}

async function openAiModels({ apiKey, baseUrl }) {
  const base = baseUrl || 'https://api.openai.com/v1'
  const res = await fetchJson(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const body = await res.json()
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id) => id && !OPENAI_FORA.test(id))
    .sort()
    .map((id) => ({ id, label: id }))
}

async function geminiModels({ apiKey, baseUrl }) {
  const base = baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
  const res = await fetchJson(`${base}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
  })
  const body = await res.json()
  return (body.models ?? [])
    // Só o que sabe gerar conteúdo: a mesma lista traz modelos de embedding e
    // de contagem de token, que não respondem a uma conversa.
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => ({
      // O nome vem como "models/gemini-x"; o que vai na URL de geração é só a
      // parte depois da barra (ver geminiTurn).
      id: String(m.name ?? '').replace(/^models\//, ''),
      label: m.displayName || String(m.name ?? '').replace(/^models\//, ''),
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id))
}

const LISTADORES = { anthropic: anthropicModels, openai: openAiModels, gemini: geminiModels }

/**
 * Lista os modelos que a credencial informada alcança. Recebe os valores do
 * FORMULÁRIO (chave ainda não salva incluída) porque o caso de uso é: colei a
 * chave, agora me mostre o que posso escolher.
 */
export async function listProviderModels({ provider, apiKey, baseUrl = '' }) {
  if (!LISTADORES[provider]) throw new Error(`Provedor desconhecido: ${provider}.`)
  if (!apiKey) throw new Error('Cadastre a chave da API para listar os modelos.')
  try {
    return await LISTADORES[provider]({ apiKey, baseUrl })
  } catch (e) {
    throw new Error(providerErrorMessage(e))
  }
}

// ─── Interface pública ─────────────────────────────────────────────────

const ADAPTERS = { anthropic: anthropicTurn, openai: openAiTurn, gemini: geminiTurn }

/**
 * Um turno com o provedor configurado.
 *
 * Devolve sempre a mesma forma, qualquer que seja o provedor:
 *   { text, toolCalls:[{id,name,input}], stopReason, content, usage }
 *
 * `stopReason` é o vocabulário da Anthropic ('tool_use' | 'end_turn' |
 * 'refusal' | 'max_tokens') porque é o que o motor já entende.
 *
 * `maxTokens`/`effort` sobrepõem a configuração salva. Existe porque a leitura
 * de gráfico (server/aiInsight.mjs) é deliberadamente mais barata que a
 * montagem de widget: mesmo provedor e mesma credencial, teto menor.
 */
export async function streamTurn({ system, messages, tools, onText, maxTokens, effort }) {
  const saved = aiConfig()
  const cfg = {
    ...saved,
    ...(Number.isFinite(Number(maxTokens)) ? { maxTokens: Number(maxTokens) } : {}),
    ...(effort ? { effort } : {}),
  }
  if (!cfg.apiKey) {
    throw new Error(`IA não configurada: falta a credencial de ${PROVIDERS[cfg.provider]?.label ?? cfg.provider}. Cadastre em Configurações.`)
  }
  if (!cfg.model) throw new Error('IA não configurada: falta o modelo. Escolha em Configurações.')
  const adapter = ADAPTERS[cfg.provider]
  if (!adapter) throw new Error(`Provedor sem adaptador: ${cfg.provider}.`)

  // Fora da Anthropic, `cache_control` é ruído que alguns provedores recusam.
  const cleanSystem = cfg.provider === 'anthropic' ? system : stripCacheControl(system)
  return adapter({ cfg, system: cleanSystem, messages, tools, onText })
}

function stripCacheControl(system) {
  if (!system || typeof system === 'string') return system
  return system.map(({ cache_control, ...rest }) => rest)
}

/** Uma resposta só, sem ferramenta — usado pela leitura de gráfico. */
export async function completeOnce({ system, userText, maxTokens, effort }) {
  const out = await streamTurn({
    system,
    messages: [{ role: 'user', content: userText }],
    tools: [],
    maxTokens,
    effort,
  })
  return { text: out.text.trim(), usage: out.usage, stopReason: out.stopReason }
}

/**
 * Testa credencial + modelo com a chamada mais barata possível: um "ping" de
 * poucos tokens. Existe porque descobrir que a chave está errada no meio de
 * uma montagem de dashboard é caro em confiança — e porque o campo de modelo
 * é texto livre, então errar o id é fácil.
 *
 * Recebe os valores do FORMULÁRIO (ainda não salvos): testar antes de gravar
 * é o ponto.
 */
export async function testConnection({ provider, apiKey, model, baseUrl = '', maxTokens = 64 }) {
  if (!PROVIDERS[provider]) throw new Error(`Provedor desconhecido: ${provider}.`)
  if (!apiKey) throw new Error('Informe a chave da API para testar.')
  if (!model) throw new Error('Informe o modelo para testar.')

  const cfg = { provider, apiKey, model, baseUrl, maxTokens, effort: 'low' }
  const adapter = ADAPTERS[provider]
  const started = Date.now()
  try {
    const out = await adapter({
      cfg,
      system: 'Responda apenas: ok',
      messages: [{ role: 'user', content: 'ok' }],
      tools: [],
    })
    return {
      ok: true,
      ms: Date.now() - started,
      model,
      reply: out.text.slice(0, 120),
      usage: out.usage,
    }
  } catch (e) {
    // A frase do provedor é o conteúdo útil deste teste — é ela que diz se o
    // problema é chave, modelo, saldo ou rede. Reembrulhar em texto nosso
    // ("falha ao testar") apagaria justamente isso.
    throw new Error(providerErrorMessage(e))
  }
}
