// Verificação dos adaptadores de provedor de IA contra um servidor de mentira
// que fala o protocolo de cada um. Prova as duas metades que são código nosso:
// a TRADUÇÃO DE IDA (o corpo que sai) e a NORMALIZAÇÃO DE VOLTA (o que o motor
// recebe). Sem chave real e sem gastar nada.
//
// Rodar:  npm run test:ai
//
// Nao toca na configuracao real: escreve num arquivo temporario (AI_CONFIG_PATH)
// e usa uma SECRETS_KEY de teste, entao nao encosta em data/aiConfig.json nem
// na chave de cifra do projeto.
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// O ambiente é montado AQUI, e não no npm script, por duas razões: sintaxe de
// variável de ambiente em linha não funciona no PowerShell (`VAR=x cmd` é erro
// lá), e assim não entra dependência nova (cross-env) só pra rodar um teste.
// Precisa vir antes do import de aiConfig.mjs, que lê as duas na carga.
const CONFIG_TEMP = join(tmpdir(), `indicadores-ai-config-teste-${process.pid}.json`)
process.env.AI_CONFIG_PATH = process.env.AI_CONFIG_PATH ?? CONFIG_TEMP
process.env.SECRETS_KEY = process.env.SECRETS_KEY ?? 'chave-de-cifra-de-teste'
// A chave real do .env não pode virar semente aqui: o teste afirma sobre a
// máscara da chave que ele mesmo grava.
process.env.ANTHROPIC_API_KEY = ''

const PORT = Number(process.env.AI_TEST_PORT) || 8911
const BASE = `http://127.0.0.1:${PORT}`

// Guarda o que cada adaptador ENVIOU, pra poder afirmar sobre a tradução.
const recebido = []

function sse(res, eventos) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const e of eventos) {
    if (e.event) res.write(`event: ${e.event}\n`)
    res.write(`data: ${JSON.stringify(e.data)}\n\n`)
  }
  res.end()
}

// ─── Servidor de mentira ───────────────────────────────────────────────
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : null
    recebido.push({ url: req.url, headers: req.headers, body: parsed })

    // ── Listagem de modelos (GET), no formato de cada provedor.
    if (req.method === 'GET' && req.url.startsWith('/anthropic/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        data: [
          { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
        ],
        has_more: false,
        first_id: 'claude-opus-5',
        last_id: 'claude-sonnet-5',
      }))
    }
    if (req.method === 'GET' && req.url.startsWith('/openai/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        data: [
          { id: 'modelo-de-conversa-b' },
          { id: 'modelo-de-conversa-a' },
          // Os três abaixo NÃO servem pra conversa com ferramenta e devem ser
          // filtrados: escolher um deles falharia na primeira mensagem.
          { id: 'text-embedding-3-large' },
          { id: 'whisper-1' },
          { id: 'dall-e-3' },
        ],
      }))
    }
    if (req.method === 'GET' && req.url.startsWith('/gemini/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        models: [
          { name: 'models/gemini-teste-pro', displayName: 'Gemini Teste Pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/gemini-teste-flash', displayName: 'Gemini Teste Flash', supportedGenerationMethods: ['generateContent'] },
          // Só embedding: não responde conversa, tem que sair da lista.
          { name: 'models/embedding-teste', displayName: 'Embedding Teste', supportedGenerationMethods: ['embedContent'] },
        ],
      }))
    }

    // Anthropic: SSE no formato que o SDK oficial espera montar.
    if (req.url.startsWith('/anthropic/v1/messages')) {
      return sse(res, [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 30, cache_read_input_tokens: 90 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vou olhar os valores.' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_abc', name: 'field_values', input: {} } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"source":"protocolos",' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"field":"status"}' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ])
    }

    // OpenAI: chunks de Chat Completions, com a chamada de ferramenta fatiada
    // em dois pedaços de `arguments` (é assim que chega de verdade).
    if (req.url.startsWith('/openai/chat/completions')) {
      return sse(res, [
        { data: { choices: [{ index: 0, delta: { content: 'Vou olhar os valores.' } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_xyz', function: { name: 'field_values', arguments: '{"source":"protoc' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'olos","field":"status"}' } }] } }] } },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
        { data: { choices: [], usage: { prompt_tokens: 210, completion_tokens: 33, prompt_tokens_details: { cached_tokens: 64 } } } },
      ])
    }

    // Gemini: streamGenerateContent com functionCall e usageMetadata.
    if (req.url.includes(':streamGenerateContent')) {
      return sse(res, [
        { data: { candidates: [{ content: { parts: [{ text: 'Vou olhar os valores.' }] } }] } },
        { data: { candidates: [{ content: { parts: [{ functionCall: { name: 'field_values', args: { source: 'protocolos', field: 'status' } }, thoughtSignature: 'assinatura-nova' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 190, candidatesTokenCount: 27, cachedContentTokenCount: 40 } } },
      ])
    }

    res.writeHead(404).end('nao encontrado')
  })
})

await new Promise((r) => server.listen(PORT, r))

// Importado DEPOIS do listen e depois de AI_CONFIG_PATH estar no ambiente.
// Caminho absoluto vindo do PROJETO (passado em argv[2]) — este arquivo mora
// fora do repositório, então import relativo aqui seria uma contagem de "../"
// esperando pra dar errado.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve as resolvePath, dirname } from 'node:path'

// Raiz do projeto a partir da localizacao deste arquivo (scripts/..). argv[2]
// continua aceito, pra rodar de qualquer lugar.
const AQUI = dirname(fileURLToPath(import.meta.url))
const PROJETO = process.argv[2] ?? resolvePath(AQUI, '..')
const mod = (nome) => pathToFileURL(resolvePath(PROJETO, 'server', nome)).href

const { saveAiConfig } = await import(mod('aiConfig.mjs'))
const { streamTurn, listProviderModels } = await import(mod('aiProvider.mjs'))

// ─── Conversa canônica de entrada (formato Anthropic) ──────────────────
// De propósito exercita TUDO que é difícil de traduzir: texto, chamada de
// ferramenta do assistente, resultado de ferramenta (inclusive um com erro) e
// mensagem de sistema no meio da conversa.
const SYSTEM = [
  { type: 'text', text: 'INSTRUÇÕES ESTÁVEIS' },
  { type: 'text', text: 'CATÁLOGO DE CAMPOS', cache_control: { type: 'ephemeral' } },
]

const MESSAGES = [
  { role: 'user', content: 'monte 3 KPIs de instalação' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Preciso ver os valores primeiro.' },
      // Assinatura como a que o Gemini 3 manda: tem de voltar pro Gemini e NÃO
      // pode ir pra Anthropic (lá é campo desconhecido e derruba a chamada).
      { type: 'tool_use', id: 'toolu_1', name: 'field_values', input: { source: 'protocolos', field: 'status' }, thoughtSignature: 'assinatura-de-volta' },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Concluído, Cancelado, Em aberto' },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_2', name: 'preview_widget', input: { widget: {} } }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'campo inexistente', is_error: true }],
  },
  { role: 'system', content: 'Você tem poucas idas restantes. Conclua agora.' },
]

const TOOLS = [
  {
    name: 'field_values',
    description: 'Lista valores distintos de um campo.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { source: { type: 'string' }, field: { type: 'string' } },
      required: ['source', 'field'],
    },
  },
]

// ─── Verificações ──────────────────────────────────────────────────────
let falhas = 0
let checagens = 0

function ok(condicao, descricao, detalhe = '') {
  checagens += 1
  if (condicao) {
    console.log(`  PASS  ${descricao}`)
  } else {
    falhas += 1
    console.log(`  FALHA ${descricao}${detalhe ? `\n        → ${detalhe}` : ''}`)
  }
}

async function rodar(provider, model, baseUrl) {
  saveAiConfig({ provider, model, apiKey: 'chave-de-teste', baseUrl }, { email: 'teste@sebratel.com.br' })
  recebido.length = 0
  const textos = []
  const turno = await streamTurn({
    system: SYSTEM,
    messages: MESSAGES,
    tools: TOOLS,
    onText: (t) => textos.push(t),
  })
  return { turno, enviado: recebido[0], textos }
}

// ── Anthropic: repasse (nenhuma tradução), com cache_control preservado
console.log('\n── Anthropic (repasse) ──')
{
  const { turno, enviado, textos } = await rodar('anthropic', 'claude-opus-5', `${BASE}/anthropic`)
  const b = enviado.body
  ok(b.model === 'claude-opus-5', 'modelo vai no corpo')
  ok(b.output_config?.effort === 'high', 'esforço vai no corpo (só Anthropic tem)')
  ok(b.system?.[1]?.cache_control?.type === 'ephemeral', 'cache_control PRESERVADO no provedor que o suporta')
  ok(b.tools?.[0]?.input_schema?.additionalProperties === false, 'schema vai inteiro (Anthropic aceita additionalProperties)')
  ok(b.messages?.length === MESSAGES.length, `histórico vai inteiro (${b.messages?.length} de ${MESSAGES.length})`)
  ok(b.messages?.[5]?.role === 'system', 'mensagem de sistema no meio segue como system')
  ok(!JSON.stringify(b.messages).includes('thoughtSignature'), 'assinatura do Gemini NÃO vai pra Anthropic (campo desconhecido lá)')
  ok(b.messages?.[1]?.content?.[1]?.id === 'toolu_1', 'resto do bloco tool_use preservado depois de tirar a assinatura')
  ok(enviado.headers['x-api-key'] === 'chave-de-teste', 'credencial vai no cabeçalho x-api-key')

  ok(turno.stopReason === 'tool_use', 'stopReason normalizado = tool_use')
  ok(turno.toolCalls.length === 1 && turno.toolCalls[0].name === 'field_values', 'chamada de ferramenta extraída')
  ok(turno.toolCalls[0].input?.field === 'status', 'input remontado do JSON fatiado', JSON.stringify(turno.toolCalls[0].input))
  ok(turno.usage.inputTokens === 120 && turno.usage.outputTokens === 42, 'tokens de entrada/saída normalizados', JSON.stringify(turno.usage))
  ok(turno.usage.cacheWriteTokens === 30 && turno.usage.cacheReadTokens === 90, 'tokens de cache normalizados')
  ok(textos.join('') === 'Vou olhar os valores.', 'texto chegou por streaming')
}

// ── OpenAI: tradução completa
console.log('\n── OpenAI (tradução) ──')
{
  const { turno, enviado, textos } = await rodar('openai', 'modelo-de-teste', `${BASE}/openai`)
  const m = enviado.body.messages
  ok(enviado.headers.authorization === 'Bearer chave-de-teste', 'credencial vai como Bearer')
  ok(m[0].role === 'system' && m[0].content.includes('CATÁLOGO'), 'blocos de system viram uma mensagem system só')
  ok(!JSON.stringify(enviado.body).includes('cache_control'), 'cache_control REMOVIDO (não existe fora da Anthropic)')
  ok(m[1].role === 'user' && m[1].content === 'monte 3 KPIs de instalação', 'pedido do usuário preservado')
  ok(m[2].role === 'assistant' && m[2].tool_calls?.[0]?.function?.name === 'field_values', 'tool_use vira tool_calls do assistente')
  ok(m[2].tool_calls[0].function.arguments === JSON.stringify({ source: 'protocolos', field: 'status' }), 'argumentos serializados como string JSON')
  ok(m[3].role === 'tool' && m[3].tool_call_id === 'toolu_1', 'tool_result vira mensagem role=tool com o id da chamada')
  ok(m[5].role === 'tool' && m[5].content === 'campo inexistente', 'resultado com erro também desce como tool')
  ok(m[6].role === 'system' && m[6].content.includes('Conclua agora'), 'aviso de operador continua system')
  ok(enviado.body.tools?.[0]?.function?.parameters?.additionalProperties === undefined, 'additionalProperties retirado do schema')
  ok(enviado.body.stream_options?.include_usage === true, 'pede usage no stream (senão o medidor de gasto fica em zero)')
  ok(!JSON.stringify(m).includes('thoughtSignature'), 'assinatura do Gemini NÃO vai pra OpenAI')

  ok(turno.stopReason === 'tool_use', 'finish_reason=tool_calls vira stopReason=tool_use')
  ok(turno.toolCalls.length === 1 && turno.toolCalls[0].id === 'call_xyz', 'id da chamada preservado')
  ok(turno.toolCalls[0].input?.source === 'protocolos', 'arguments fatiado em 2 chunks foi remontado e parseado', JSON.stringify(turno.toolCalls[0].input))
  ok(turno.usage.inputTokens === 210 && turno.usage.outputTokens === 33, 'usage normalizado', JSON.stringify(turno.usage))
  ok(turno.usage.cacheReadTokens === 64, 'cached_tokens vira cacheReadTokens')
  ok(textos.join('') === 'Vou olhar os valores.', 'texto chegou por streaming')
  ok(turno.content[0].type === 'text' && turno.content[1].type === 'tool_use', 'conteúdo devolvido em blocos canônicos')
}

// ── Gemini: tradução completa
console.log('\n── Gemini (tradução) ──')
{
  const { turno, enviado, textos } = await rodar('gemini', 'modelo-de-teste', `${BASE}/gemini`)
  const c = enviado.body.contents
  ok(enviado.headers['x-goog-api-key'] === 'chave-de-teste', 'credencial vai em cabeçalho, não na URL')
  ok(!enviado.url.includes('chave-de-teste'), 'credencial NÃO aparece na URL (log de proxy)')
  ok(enviado.body.systemInstruction?.parts?.[0]?.text?.includes('CATÁLOGO'), 'system vira systemInstruction')
  ok(c[1].role === 'model', 'assistente vira role=model')
  ok(c[1].parts?.[1]?.functionCall?.name === 'field_values', 'tool_use vira functionCall')
  ok(c[1].parts?.[1]?.thoughtSignature === 'assinatura-de-volta', 'thought signature volta na mesma parte do functionCall (Gemini 3 exige)')
  ok(c[3].parts?.[0]?.functionCall && c[3].parts[0].thoughtSignature === undefined, 'chamada sem assinatura no histórico não ganha uma inventada')
  ok(c[2].parts?.[0]?.functionResponse?.name === 'field_values', 'tool_result vira functionResponse COM O NOME (o id não serve)')
  ok(c[2].parts[0].functionResponse.response?.result === 'Concluído, Cancelado, Em aberto', 'conteúdo do resultado embrulhado em objeto')
  ok(c[4].parts?.[0]?.functionResponse?.response?.error === 'campo inexistente', 'resultado com erro vai como {error}')
  ok(c[5].role === 'user' && c[5].parts[0].text.startsWith('[instrução do sistema]'), 'system do meio vira user marcado (Gemini não tem esse papel)')
  ok(enviado.body.tools?.[0]?.functionDeclarations?.[0]?.parameters?.additionalProperties === undefined, 'additionalProperties retirado (o Gemini recusa)')

  ok(turno.stopReason === 'tool_use', 'functionCall presente vira stopReason=tool_use')
  ok(turno.toolCalls.length === 1 && turno.toolCalls[0].name === 'field_values', 'chamada extraída')
  ok(typeof turno.toolCalls[0].id === 'string' && turno.toolCalls[0].id.startsWith('gem_'), 'id sintetizado (o Gemini não manda um)')
  ok(turno.content?.find((b) => b.type === 'tool_use')?.thoughtSignature === 'assinatura-nova', 'thought signature da resposta guardada no histórico canônico')
  ok(turno.usage.inputTokens === 190 && turno.usage.outputTokens === 27, 'usageMetadata normalizado', JSON.stringify(turno.usage))
  ok(turno.usage.cacheReadTokens === 40, 'cachedContentTokenCount vira cacheReadTokens')
  ok(textos.join('') === 'Vou olhar os valores.', 'texto chegou por streaming')
}

// ── Catálogo de modelos vindo do provedor
console.log('\n── Listagem de modelos ──')
{
  const anth = await listProviderModels({ provider: 'anthropic', apiKey: 'chave-de-teste', baseUrl: `${BASE}/anthropic` })
  ok(anth.length === 2 && anth[0].id === 'claude-opus-5', 'Anthropic: ids lidos pela paginação do SDK', JSON.stringify(anth))
  ok(anth[0].label === 'Claude Opus 5', 'Anthropic: display_name vira o rótulo')

  const oai = await listProviderModels({ provider: 'openai', apiKey: 'chave-de-teste', baseUrl: `${BASE}/openai` })
  ok(oai.length === 2, 'OpenAI: embedding/whisper/dall-e ficam fora da lista', JSON.stringify(oai.map((m) => m.id)))
  ok(oai[0].id === 'modelo-de-conversa-a', 'OpenAI: lista vem ordenada')

  const gem = await listProviderModels({ provider: 'gemini', apiKey: 'chave-de-teste', baseUrl: `${BASE}/gemini` })
  ok(gem.length === 2, 'Gemini: só o que suporta generateContent entra', JSON.stringify(gem.map((m) => m.id)))
  ok(gem.every((m) => !m.id.startsWith('models/')), 'Gemini: prefixo "models/" removido (é o que vai na URL de geração)', JSON.stringify(gem.map((m) => m.id)))
  ok(gem[0].label === 'Gemini Teste Flash', 'Gemini: displayName vira o rótulo')

  let erro = null
  try { await listProviderModels({ provider: 'gemini', apiKey: '', baseUrl: `${BASE}/gemini` }) } catch (e) { erro = e.message }
  ok(!!erro && erro.includes('chave'), 'sem credencial, a listagem recusa dizendo o que falta', String(erro))
}

// ── Validação da configuração
console.log('\n── Configuração ──')
{
  let erro = null
  try { saveAiConfig({ provider: 'openai', model: 'm', baseUrl: 'ftp://x' }) } catch (e) { erro = e.message }
  ok(!!erro && erro.includes('http://'), 'endpoint com esquema inválido é recusado na entrada', String(erro))

  const salvo = saveAiConfig({ provider: 'openai', model: 'm', baseUrl: `${BASE}/openai/` })
  ok(salvo.baseUrls.openai === `${BASE}/openai`, 'barra final do endpoint é removida', salvo.baseUrls.openai)

  erro = null
  try { saveAiConfig({ provider: 'anthropic', model: '   ' }) } catch (e) { erro = e.message }
  ok(!!erro, 'modelo vazio é recusado', String(erro))

  erro = null
  try { saveAiConfig({ provider: 'inexistente', model: 'm' }) } catch (e) { erro = e.message }
  ok(!!erro, 'provedor desconhecido é recusado', String(erro))

  const semPreco = saveAiConfig({ provider: 'openai', model: 'modelo-sem-preco-conhecido' })
  ok(semPreco.price.input === 0 && semPreco.price.output === 0, 'modelo sem preço conhecido fica com preço ZERO (não um chute)')

  const comPreco = saveAiConfig({ provider: 'anthropic', model: 'claude-sonnet-5' })
  ok(comPreco.price.input === 2 && comPreco.price.output === 10, 'modelo conhecido traz o preço da tabela')

  // A chave nunca volta em claro: só a máscara.
  const pub = saveAiConfig({ provider: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-super-secreta-1234567890' })
  ok(!JSON.stringify(pub).includes('super-secreta'), 'a resposta da tela NUNCA contém a chave em claro')
  ok(/^sk-an.*7890$/.test(pub.keyMasks.anthropic), 'a tela recebe a chave mascarada', pub.keyMasks.anthropic)
}

// Retomada: quando o servidor esqueceu a conversa, o navegador manda o que já
// foi dito (server/aiAssistant.mjs › resumeHistory). Isso vira histórico de
// provedor, então tem de começar no usuário, alternar e terminar no assistente
// (o turno novo entra como usuário) — e respeitar os tetos, porque é texto
// vindo do navegador e cada caractere é token cobrado.
console.log('\n── Retomada de conversa ──')
{
  const { resumeHistory } = await import(mod('aiAssistant.mjs'))
  const r = resumeHistory([
    { role: 'assistant', text: 'resto sem pergunta' },
    { role: 'user', text: 'primeiro' },
    { role: 'user', text: 'segundo' },
    { role: 'assistant', text: 'resposta' },
    { role: 'user', text: 'pergunta sem resposta' },
  ])
  ok(r.length === 2 && r[0].role === 'user' && r[0].content === 'primeiro\n\nsegundo' && r[1].role === 'assistant' && r[1].content === 'resposta',
    'começa no usuário, junta falas seguidas do mesmo papel e termina no assistente', JSON.stringify(r))
  ok(resumeHistory('não é lista').length === 0 && resumeHistory([{ role: 'system', text: 'x' }, { role: 'tool', text: 'y' }, { role: 'user', text: '   ' }]).length === 0,
    'ignora entrada que não é lista, papel estranho e texto vazio')
  const longa = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(5000) }))
  const cortada = resumeHistory(longa)
  const total = cortada.reduce((n, m) => n + m.content.length, 0)
  ok(cortada.length > 0 && cortada.every((m) => m.content.length <= 4000) && total <= 24000,
    'respeita os tetos (4.000 por fala, 24.000 no total)', `${cortada.length} falas, ${total} caracteres`)
  ok(cortada[0].role === 'user' && cortada[cortada.length - 1].role === 'assistant' && cortada.every((m, i) => i === 0 || m.role !== cortada[i - 1].role),
    'mesmo cortada, alterna do jeito que os provedores exigem')
}

server.close()
// Limpa a configuração de teste — só a que ESTE processo criou (se alguém
// passou AI_CONFIG_PATH de fora, o arquivo é dele).
if (process.env.AI_CONFIG_PATH === CONFIG_TEMP) {
  try { rmSync(CONFIG_TEMP, { force: true }) } catch { /* o arquivo é descartável */ }
}
console.log(`\n${checagens - falhas}/${checagens} checagens passaram`)
process.exit(falhas ? 1 : 0)
