// ─────────────────────────────────────────────────────────────────────────
// Assistente de IA do Builder — conversa que monta widgets e escreve insights.
//
// COMO ISSO NÃO PESA NO SERVIDOR (era o requisito central):
//
//   • O dado bruto nunca sobe pro modelo. Sobem duas coisas: o CATÁLOGO DE
//     CAMPOS das fontes selecionadas (nomes, tipo inferido e a descrição do
//     dicionário de dados — alguns milhares de tokens, não as 177 mil linhas)
//     e, quando o modelo pede uma prévia, o RESULTADO JÁ AGREGADO, que o motor
//     de widgets ainda capa em MAX_POINTS/MAX_MATRIX_ROWS. São centenas de
//     números.
//   • Sem RAG: nenhum índice vetorial, nenhum embedding, nada em disco nem
//     residente em RAM. O catálogo cabe inteiro no prompt, então o índice
//     simplesmente não existe. Essa é a maior economia da abordagem.
//   • Conversas só em MEMÓRIA, com TTL e teto de itens (ver conversationStore
//     abaixo). Nada de transcrição em disco: o que persiste é só o widget
//     aprovado, no workspace.json, como qualquer widget feito à mão.
//   • Prompt caching: instruções + catálogo formam um prefixo estável com
//     `cache_control`, então do 2º turno em diante o prefixo custa ~10% e
//     chega mais rápido.
//
// COMO ISSO NÃO INVENTA DADO: o modelo não gera SQL nem código — ele devolve
// um WidgetConfig (ver server/aiWidgetSchema.mjs), que é validado contra o
// catálogo REAL antes de chegar na tela. Campo inexistente volta como erro
// pro modelo, que corrige na mesma conversa.
//
// COMO ISSO NÃO GRAVA NADA SOZINHO: o assistente só PROPÕE. Quem aplica na
// guia é o usuário, clicando em aprovar — e daí em diante é um rascunho
// normal do Builder, que ainda depende do "Salvar".
// ─────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import { listSourceDefs, runWidgetQuery, runFieldValues } from './widgetQuery.mjs'
import { WIDGET_SCHEMA, PROPOSE_TOOL_SCHEMA, validateWidget, normalizeWidget } from './aiWidgetSchema.mjs'

// `claude-opus-5` é o padrão deliberado: a tarefa é raciocinar sobre um
// catálogo de campos e produzir JSON estruturado correto, onde errar custa a
// confiança do usuário na feature. Trocável por env se você quiser medir
// custo/qualidade com outro modelo.
export const MODEL = process.env.AI_MODEL || 'claude-opus-5'
// `high` é o padrão recomendado para trabalho sensível a inteligência. Vale
// testar 'medium' e até 'low' depois com os seus casos reais — neste modelo os
// níveis baixos rendem bem e são o principal controle de custo/latência.
const EFFORT = process.env.AI_EFFORT || 'high'
// Teto do que o modelo pode gerar por resposta. Cobre raciocínio + texto +
// o JSON dos widgets junto; proposta de dashboard inteira cabe folgado.
const MAX_TOKENS = Math.max(2000, Number(process.env.AI_MAX_TOKENS) || 16000)
// Orçamento de idas ao modelo por turno. 8 era apertado demais: com uma fonte
// de 31 campos e um pedido aberto ("KPIs que contam uma história"), o modelo
// gastava as idas explorando e estourava sem nunca propor nada — o usuário
// pagava e não recebia widget. Além de subir o teto, agora o modelo é AVISADO
// quando está perto do fim (ver WRAP_UP_AT) pra fechar com o que tem.
const MAX_ITERATIONS = Math.max(3, Number(process.env.AI_MAX_ITERATIONS) || 14)
// Quantas idas antes do fim o aviso de "conclua agora" entra.
const WRAP_UP_AT = 3
// Teto de gasto por usuário por dia, em dólares. Zero desliga o teto.
const DAILY_BUDGET_USD = Number(process.env.AI_DAILY_BUDGET_USD ?? 5)

// Preço por milhão de tokens (Claude Opus 5). Usado só para o teto de gasto e
// para mostrar o custo na tela — se você trocar de modelo por env, ajuste.
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }

// Quanto de amostra de valores distintos mostrar ao modelo.
const FIELD_VALUES_LIMIT = 40
// Teto do JSON de prévia devolvido ao modelo — evita que uma tabela larga
// consuma o contexto inteiro.
const PREVIEW_CHARS = 4000

let client = null
// Exportado porque a leitura de gráfico (server/aiInsight.mjs) usa o MESMO
// cliente, o MESMO modelo e — o que mais importa — o MESMO teto de gasto
// diário. Um orçamento por feature seria um teto que não segura nada: o
// usuário estouraria o dobro só por usar as duas.
export function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY não configurada no ambiente da API — a montagem com IA fica indisponível.')
  }
  if (!client) client = new Anthropic()
  return client
}

export function isAiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY
}

// ─── Conversas em memória (nada em disco) ──────────────────────────────
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_CONVERSATIONS = 200
const conversations = new Map() // id → { email, folderId, sourceKeys, messages, lastUsedAt }

function pruneConversations() {
  const now = Date.now()
  for (const [id, c] of conversations) {
    if (now - c.lastUsedAt > CONVERSATION_TTL_MS) conversations.delete(id)
  }
  // Teto duro: se ainda estourou, descarta as mais antigas. Uma conversa
  // perdida custa ao usuário recomeçar o pedido; um vazamento de memória
  // custa o servidor.
  while (conversations.size > MAX_CONVERSATIONS) {
    let oldestId = null
    let oldest = Infinity
    for (const [id, c] of conversations) if (c.lastUsedAt < oldest) { oldest = c.lastUsedAt; oldestId = id }
    if (oldestId === null) break
    conversations.delete(oldestId)
  }
}

// ─── Teto de gasto por usuário/dia (em memória, zera na virada do dia) ──
const spendByUser = new Map() // email → { day, usd }

function today() {
  return new Date().toISOString().slice(0, 10)
}

function costOf(usage) {
  if (!usage) return 0
  const inTok = usage.input_tokens ?? 0
  const outTok = usage.output_tokens ?? 0
  const cw = usage.cache_creation_input_tokens ?? 0
  const cr = usage.cache_read_input_tokens ?? 0
  return (inTok * PRICE.input + outTok * PRICE.output + cw * PRICE.cacheWrite + cr * PRICE.cacheRead) / 1e6
}

export function usageFor(email) {
  const entry = spendByUser.get(email)
  const spentUsd = entry && entry.day === today() ? entry.usd : 0
  return { spentUsd, budgetUsd: DAILY_BUDGET_USD, model: MODEL, configured: isAiConfigured() }
}

export function assertWithinBudget(email) {
  if (!(DAILY_BUDGET_USD > 0)) return
  const { spentUsd } = usageFor(email)
  if (spentUsd >= DAILY_BUDGET_USD) {
    throw new Error(
      `Você atingiu o limite de uso de IA de hoje (US$ ${DAILY_BUDGET_USD.toFixed(2)}). O limite zera amanhã; um administrador pode ajustá-lo em AI_DAILY_BUDGET_USD.`,
    )
  }
}

export function recordSpend(email, usage) {
  const usd = costOf(usage)
  const entry = spendByUser.get(email)
  if (entry && entry.day === today()) entry.usd += usd
  else spendByUser.set(email, { day: today(), usd })
  return usd
}

// ─── Prompt ────────────────────────────────────────────────────────────
// Instruções ESTÁVEIS. Ficam num bloco separado do catálogo pra render order
// (tools → system → messages) manter o prefixo cacheável intacto: nada aqui
// muda entre requisições.
const INSTRUCTIONS = `Você monta widgets de dashboard no "Indicadores Sebratel", uma ferramenta interna estilo Power BI.

Seu trabalho é traduzir o que a pessoa pede em WidgetConfig — a mesma estrutura declarativa que o editor manual produz. Você não escreve SQL nem código: descreve o visual, e o motor do app agrega os dados.

Como trabalhar:
- Use SOMENTE as fontes e os campos listados no catálogo. Nunca invente nome de campo nem de fonte.
- Quando o pedido for vago ("principais indicadores"), escolha um conjunto pequeno e bem pensado — 4 a 6 widgets que respondam as perguntas óbvias daquele assunto — em vez de despejar tudo. Comece por um ou dois KPIs, depois quebras por dimensão relevante e uma série temporal se houver campo de data.
- Prefira 'month:<campo>' a 'day:<campo>' quando a série cobrir muitos meses.
- Chame propose_widgets UMA vez, no fim, com tudo que você decidiu montar.

Comunicação: seja direto e breve. Uma ou duas frases dizendo o que montou e por quê — a pessoa vai ver os widgets na tela, não precisa de descrição campo por campo. Sem preâmbulo, sem recapitular o pedido.

Escopo: entregue o que foi pedido, no tamanho que foi pedido. Se o pedido for ambíguo, resolva como um colega experiente resolveria e siga; só pergunte quando leituras diferentes levariam a dashboards materialmente diferentes. Não acrescente widgets que ninguém pediu.`

// O catálogo carrega VALORES DE EXEMPLO dos campos de texto e marca os de alta
// cardinalidade (ver inferSourceDef em widgetQuery.mjs). Isso é o que evita a
// maior parte das idas e voltas: com os valores em mão o modelo escreve o
// filtro com a grafia certa sem chamar field_values, e sabe de saída que
// agrupar por nome de cliente não produz gráfico útil.
function catalogText(sources) {
  const lines = sources.map((s) => {
    const fields = s.fields.map((f) => {
      const kind = f.kind === 'number' ? 'número' : f.kind === 'date' ? 'data' : 'texto'
      const parts = [`    - ${f.key} (${kind})`]
      if (f.highCardinality) parts.push(' [muitos valores distintos — identificador, não use como dimensão de gráfico]')
      else if (f.sampleValues?.length) {
        const more = f.distinctInSample > f.sampleValues.length ? ', …' : ''
        parts.push(` — valores: ${f.sampleValues.map((v) => JSON.stringify(v)).join(', ')}${more}`)
      }
      if (f.description) parts.push(` — ${f.description}`)
      return parts.join('')
    }).join('\n')
    return `  Fonte "${s.key}" — ${s.label} (${s.fields.length} campos)\n${fields}`
  })
  return `Catálogo de fontes disponíveis nesta conversa:\n\n${lines.join('\n\n')}\n\nOs valores mostrados vêm de uma amostra dos dados reais — use-os para escrever filtros com a grafia exata. Só chame field_values quando precisar de um valor que não está aí.`
}

function buildTools() {
  return [
    {
      name: 'field_values',
      // Descrição prescritiva de propósito: diz QUANDO chamar, não só o que
      // faz. Modelos recentes são conservadores em alcançar ferramentas
      // customizadas, e o gatilho explícito na descrição é o que dá alcance.
      description:
        'Lista os valores distintos que um campo de texto realmente tem nos dados. Chame ANTES de criar qualquer widgetFilters sobre um campo de texto, para usar a grafia exata (ex.: descobrir se o status é "Concluído", "CONCLUIDO" ou "concluido"). Também útil para saber quantas categorias uma dimensão tem antes de escolher o tipo de gráfico.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', description: 'Chave da fonte, como no catálogo.' },
          field: { type: 'string', description: 'Campo cujos valores você quer ver.' },
        },
        required: ['source', 'field'],
      },
    },
    {
      name: 'preview_widget',
      description:
        'Executa um WidgetConfig contra os dados reais e devolve o resultado já agregado. Chame quando quiser confirmar que a combinação escolhida retorna dado (não vem vazia) ou quando precisar dos números para escrever um insight. Não é obrigatório para widgets simples e óbvios.',
      input_schema: { type: 'object', additionalProperties: false, properties: { widget: WIDGET_SCHEMA }, required: ['widget'] },
    },
    {
      name: 'propose_widgets',
      description:
        'Entrega os widgets para o usuário aprovar. Chame exatamente uma vez, no fim do seu raciocínio, com todos os widgets que você decidiu montar. Nada é gravado na dashboard por esta chamada: o usuário revê e decide.',
      input_schema: PROPOSE_TOOL_SCHEMA,
    },
  ]
}

// ─── Execução das ferramentas ──────────────────────────────────────────
async function runTool(name, input, ctx) {
  if (name === 'field_values') {
    // A barreira de acesso: só as fontes que o usuário selecionou (e que
    // listSourceDefs já filtrou pela pasta) são alcançáveis.
    if (!ctx.sources.some((s) => s.key === input.source)) {
      return { isError: true, text: `Fonte "${input.source}" não está disponível nesta conversa.` }
    }
    const values = await runFieldValues({ source: input.source, field: input.field, accessToken: ctx.accessToken })
    if (!values) return { isError: true, text: 'Base ainda não materializada no servidor.' }
    const shown = values.slice(0, FIELD_VALUES_LIMIT)
    return {
      text: `${values.length} valor(es) distinto(s)${values.length > shown.length ? ` (mostrando ${shown.length})` : ''}:\n${shown.map((v) => `- ${v}`).join('\n')}`,
    }
  }

  if (name === 'preview_widget') {
    const errors = validateWidget(input.widget, ctx.sources)
    if (errors.length) return { isError: true, text: `Widget inválido:\n${errors.map((e) => `- ${e}`).join('\n')}` }
    const data = await runWidgetQuery({
      widget: normalizeWidget(input.widget), tabFilters: [], page: 1, pageSize: 50, accessToken: ctx.accessToken,
    })
    if (!data) return { isError: true, text: 'Base ainda não materializada no servidor.' }
    const json = JSON.stringify(data)
    return {
      text: json.length > PREVIEW_CHARS
        ? `${json.slice(0, PREVIEW_CHARS)}\n… (resultado truncado; use limit para reduzir)`
        : json,
    }
  }

  if (name === 'propose_widgets') {
    const list = Array.isArray(input.widgets) ? input.widgets : []
    if (list.length === 0) return { isError: true, text: 'Nenhum widget na proposta.' }
    const problems = []
    list.forEach((w, i) => {
      const errors = validateWidget(w, ctx.sources)
      if (errors.length) problems.push(`widgets[${i}] ("${w?.title ?? '?'}"):\n${errors.map((e) => `  - ${e}`).join('\n')}`)
    })
    // Devolver o erro em vez de gravar lixo: o modelo corrige e chama de novo.
    if (problems.length) {
      return { isError: true, text: `Corrija e chame propose_widgets de novo:\n${problems.join('\n')}` }
    }
    const widgets = list.map((w, i) => normalizeWidget(w, i))
    // Efeito colateral deliberado: a proposta vai pro navegador por SSE, não
    // pelo texto da resposta — o front recebe JSON pronto pra renderizar.
    ctx.emit({ type: 'widgets', widgets, summary: String(input.summary ?? '') })
    ctx.proposed += 1
    return { text: `${widgets.length} widget(s) enviados para aprovação do usuário. Não repita o conteúdo deles na sua resposta — a pessoa já os está vendo.` }
  }

  return { isError: true, text: `Ferramenta desconhecida: ${name}` }
}

// ─── Conversa ──────────────────────────────────────────────────────────
export async function startConversation({ email, folderId, sourceKeys, accessToken }) {
  const all = await listSourceDefs(folderId, accessToken)
  const selected = all.filter((s) => sourceKeys.includes(s.key))
  if (selected.length === 0) {
    throw new Error('Selecione pelo menos uma fonte de dados para conversar com a IA.')
  }
  pruneConversations()
  const id = randomUUID()
  conversations.set(id, {
    email, folderId, sourceKeys: selected.map((s) => s.key), messages: [], lastUsedAt: Date.now(),
  })
  return {
    conversationId: id,
    sources: selected.map((s) => ({ key: s.key, label: s.label, fieldCount: s.fields.length })),
  }
}

// Roda um turno da conversa, emitindo eventos conforme acontecem. `emit` é o
// canal SSE pro navegador; a função só retorna quando o turno acabou.
export async function runTurn({ conversationId, email, userText, accessToken, emit }) {
  const conv = conversations.get(conversationId)
  if (!conv) throw new Error('Esta conversa expirou. Comece uma nova.')
  if (conv.email !== email) throw new Error('Esta conversa pertence a outro usuário.')
  assertWithinBudget(email)

  // Recarrega o catálogo a cada turno: uma fonte pode ter sido atualizada
  // pelo ETL no meio da conversa, e é mais barato relê-lo do snapshot em
  // memória do que arriscar propor um campo que deixou de existir.
  const all = await listSourceDefs(conv.folderId, accessToken)
  const sources = all.filter((s) => conv.sourceKeys.includes(s.key))
  if (sources.length === 0) throw new Error('As fontes desta conversa não estão mais disponíveis.')

  conv.lastUsedAt = Date.now()
  conv.messages.push({ role: 'user', content: userText })

  //  conta as propostas aceitas no turno — é o que decide se um
  // estouro de orçamento é perda total ou entrega parcial.
  const ctx = { sources, accessToken, emit, proposed: 0 }
  const tools = buildTools()
  const system = [
    { type: 'text', text: INSTRUCTIONS },
    // Breakpoint no ÚLTIMO bloco de system: cacheia ferramentas + instruções +
    // catálogo de uma vez (render order é tools → system → messages).
    { type: 'text', text: catalogText(sources), cache_control: { type: 'ephemeral' } },
  ]

  let totalUsd = 0
  // `finish` centraliza a saída pra garantir que o custo SEMPRE chegue ao
  // painel. Antes o caminho de erro só emitia a mensagem, então o contador de
  // gasto ficava em US$ 0,00 mesmo depois de o turno ter consumido tokens —
  // exatamente o que aconteceu no primeiro uso real.
  const finish = (extra = {}) => {
    emit({ type: 'done', usd: totalUsd, usage: usageFor(email), ...extra })
    return { usd: totalUsd }
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const remaining = MAX_ITERATIONS - iteration
    // Aviso de fechamento como mensagem de sistema no meio da conversa: entra
    // DEPOIS do histórico, então não invalida o prefixo cacheado, e é canal de
    // operador (o modelo trata como instrução, não como texto do usuário).
    if (remaining === WRAP_UP_AT && ctx.proposed === 0) {
      conv.messages.push({
        role: 'system',
        content: `Você tem poucas idas restantes neste turno. Pare de explorar e chame propose_widgets AGORA, com o melhor conjunto que você já consegue montar a partir do catálogo. É melhor entregar 3 widgets sólidos do que não entregar nada.`,
      })
    }

    const stream = anthropic().messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT },
      system,
      tools,
      messages: conv.messages,
    })

    stream.on('text', (delta) => emit({ type: 'text', text: delta }))

    const message = await stream.finalMessage()
    totalUsd += recordSpend(email, message.usage)
    conv.messages.push({ role: 'assistant', content: message.content })

    if (message.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'O modelo recusou este pedido. Reformule ou tente um recorte diferente.' })
      return finish()
    }
    if (message.stop_reason !== 'tool_use') {
      console.log(`[ai] turno concluído em ${iteration + 1} ida(s) · ${ctx.proposed} proposta(s) · US$ ${totalUsd.toFixed(4)}`)
      return finish()
    }

    const toolUses = message.content.filter((b) => b.type === 'tool_use')
    const results = []
    for (const call of toolUses) {
      emit({ type: 'tool', name: call.name })
      let out
      try {
        out = await runTool(call.name, call.input ?? {}, ctx)
      } catch (e) {
        out = { isError: true, text: e.message }
      }
      console.log(`[ai] ida ${iteration + 1}/${MAX_ITERATIONS} · ${call.name}${out.isError ? ' (erro: ' + out.text.split('\n')[0] + ')' : ''}`)
      results.push({
        type: 'tool_result', tool_use_id: call.id, content: out.text,
        ...(out.isError ? { is_error: true } : {}),
      })
    }
    // TODOS os resultados numa única mensagem de usuário — separá-los ensina
    // o modelo a parar de pedir ferramentas em paralelo.
    conv.messages.push({ role: 'user', content: results })
  }

  // Estourou o orçamento. Se ele JÁ propôs algo, aquilo vale — o usuário
  // recebe os widgets em vez de perder o turno inteiro (e o dinheiro).
  console.log(`[ai] orçamento de ${MAX_ITERATIONS} idas esgotado · ${ctx.proposed} proposta(s) · US$ ${totalUsd.toFixed(4)}`)
  if (ctx.proposed === 0) {
    emit({
      type: 'error',
      message: 'A IA explorou os dados mas não fechou uma proposta neste turno. Peça de novo — de preferência mais específico (ex.: "3 KPIs de churn e um gráfico por motivo de cancelamento").',
    })
  }
  return finish()
}
