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
// O QUE ELE GRAVA: o assistente só entrega widgets e medidas pelas
// ferramentas (nunca escreve no workspace daqui). Quem grava é o navegador,
// assim que o turno termina: primeiro as medidas, depois os widgets, cada um
// salvo direto no servidor sem levar junto o rascunho da pessoa — e cada
// entrega tem "Desfazer" no painel (ver useAiAutoSave.ts). Antes era preciso
// aprovar cartão por cartão e ainda clicar em "Salvar".
// ─────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto'
import { getSnapshot } from './dataset.mjs'
import { isSheetSource } from './sheetSources.mjs'
import { listSourceDefs, runWidgetQuery, runFieldValues, resolveMeasure, withSheetSources } from './widgetQuery.mjs'
import {
  WIDGET_SCHEMA, PROPOSE_TOOL_SCHEMA, UPDATE_WIDGET_TOOL_SCHEMA,
  validateWidget, normalizeWidget, applyWidgetPatch,
} from './aiWidgetSchema.mjs'
import { normalizeRequestOptions, allowedWidgetTypes, requestOptionsText, deliverLabel } from './aiRequestOptions.mjs'
import {
  PROPOSE_MEASURES_TOOL_SCHEMA, validateMeasureBatch, normalizeMeasureBatch,
  UPDATE_MEASURES_TOOL_SCHEMA, validateMeasureUpdates, normalizeMeasureUpdates,
} from './aiMeasureSchema.mjs'

// A configuração da IA — provedor, credencial, modelo, esforço, tetos e
// orçamento — não vive mais em constante de módulo lida do .env: vem de
// server/aiConfig.mjs, que a tela de Configurações grava, e é lida A CADA USO.
// Constante de módulo era exatamente o que obrigava a reiniciar a API pra
// trocar de modelo ou de orçamento; lida por turno, a troca vale na próxima.
//
// Quem fala com o provedor é server/aiProvider.mjs. Este arquivo continua
// raciocinando em blocos no formato da Anthropic (o formato canônico do
// histórico) e não sabe mais quem está do outro lado.
import { aiConfig } from './aiConfig.mjs'
import { streamTurn } from './aiProvider.mjs'

// Reexportado porque quem pergunta "a IA está configurada?" (server/index.mjs,
// server/aiInsight.mjs) já importava daqui.
export { isAiConfigured } from './aiConfig.mjs'

// Quantas idas antes do fim o aviso de "conclua agora" entra. Continua fixo:
// é propriedade do laço, não preferência de quem administra.
const WRAP_UP_AT = 3

// Quanto de amostra de valores distintos mostrar ao modelo.
const FIELD_VALUES_LIMIT = 40
// Teto do JSON de prévia devolvido ao modelo — evita que uma tabela larga
// consuma o contexto inteiro.
const PREVIEW_CHARS = 4000

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

// O navegador guarda a conversa da sessão (src/features/builder/ai/aiChatStore.ts)
// e pergunta antes de cada turno se ela ainda está aqui: 'missing' vira 410, o
// sinal para ele retomá-la mandando o que já foi dito (ver resumeHistory).
export function conversationStatus(conversationId, email) {
  const conv = conversations.get(conversationId)
  if (!conv) return 'missing'
  return conv.email === email ? 'ok' : 'forbidden'
}

// "Nova conversa": libera a anterior na hora, em vez de esperar o prazo.
export function endConversation(conversationId, email) {
  const conv = conversations.get(conversationId)
  if (conv && conv.email === email) conversations.delete(conversationId)
}

// Retomada: quando a conversa sumiu daqui (2 h sem uso, teto de conversas ou a
// API reiniciou), o navegador abre outra mandando o que já foi DITO na tela. Só
// texto — nunca resultado de ferramenta: o modelo relê o diálogo e, se precisar
// de um valor de novo, consulta. Com teto, porque é texto vindo do navegador e
// cada caractere vira token cobrado.
const RESUME_MAX_MESSAGES = 30
const RESUME_MAX_CHARS_EACH = 4000
const RESUME_MAX_CHARS_TOTAL = 24000

export function resumeHistory(history) {
  if (!Array.isArray(history)) return []
  const clean = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role, content: m.text.trim().slice(0, RESUME_MAX_CHARS_EACH) }))
    .slice(-RESUME_MAX_MESSAGES)
  // Teto total cortando do começo: o fim da conversa é o que mais importa.
  const kept = []
  let total = 0
  for (let i = clean.length - 1; i >= 0; i--) {
    total += clean[i].content.length
    if (total > RESUME_MAX_CHARS_TOTAL) break
    kept.unshift(clean[i])
  }
  // Os provedores querem a conversa começando pelo usuário e alternando, e o
  // turno novo entra como usuário — então o histórico termina no assistente.
  const merged = []
  for (const m of kept) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content += `\n\n${m.content}`
    else merged.push({ ...m })
  }
  while (merged.length && merged[0].role !== 'user') merged.shift()
  while (merged.length && merged[merged.length - 1].role !== 'assistant') merged.pop()
  return merged
}

// ─── Teto de gasto por usuário/dia (em memória, zera na virada do dia) ──
const spendByUser = new Map() // email → { day, usd }

function today() {
  return new Date().toISOString().slice(0, 10)
}

// `usage` chega NORMALIZADO pelo adaptador (server/aiProvider.mjs), e não no
// formato de um provedor específico — é o que permite esta conta ser a mesma
// para os três. O preço vem da configuração: modelo sem preço cadastrado tem
// preço zero, e a tela avisa que falta preencher, em vez de somar um chute.
function costOf(usage) {
  if (!usage) return 0
  const { price } = aiConfig()
  const inTok = usage.inputTokens ?? 0
  const outTok = usage.outputTokens ?? 0
  const cw = usage.cacheWriteTokens ?? 0
  const cr = usage.cacheReadTokens ?? 0
  return (inTok * price.input + outTok * price.output + cw * price.cacheWrite + cr * price.cacheRead) / 1e6
}

export function usageFor(email) {
  const entry = spendByUser.get(email)
  const spentUsd = entry && entry.day === today() ? entry.usd : 0
  const cfg = aiConfig()
  return {
    spentUsd,
    budgetUsd: cfg.dailyBudgetUsd,
    model: cfg.model,
    // O painel de IA passa a mostrar o provedor junto do modelo: com a troca
    // virando um clique na tela, "quem respondeu isso" deixa de ser óbvio.
    provider: cfg.provider,
    // Falso quando o modelo não tem preço cadastrado — a tela usa isso pra
    // dizer que o medidor de gasto está zerado por falta de preço, em vez de
    // deixar o usuário concluir que a IA é gratuita.
    priced: cfg.price.input > 0 || cfg.price.output > 0,
    configured: !!cfg.apiKey && !!cfg.model,
  }
}

export function assertWithinBudget(email) {
  const { dailyBudgetUsd } = aiConfig()
  if (!(dailyBudgetUsd > 0)) return
  const { spentUsd } = usageFor(email)
  if (spentUsd >= dailyBudgetUsd) {
    throw new Error(
      // A mensagem aponta pra TELA, não pra variável de ambiente: com a
      // configuração editável em Configurações, mandar o usuário procurar
      // AI_DAILY_BUDGET_USD seria mandá-lo pro lugar errado.
      `Você atingiu o limite de uso de IA de hoje (US$ ${dailyBudgetUsd.toFixed(2)}). O limite zera amanhã; um administrador pode ajustá-lo em Configurações › Provedor de IA.`,
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
- Quando o pedido for vago ("principais indicadores"), escolha um conjunto pequeno e bem pensado — 4 a 6 widgets que respondam as perguntas óbvias daquele assunto — em vez de despejar tudo. Comece por um ou dois KPIs, depois quebras por dimensão relevante e uma série temporal se houver campo de data. Se o assunto tiver uma TAXA/PERCENTUAL/COMPARATIVO óbvio (taxa de reincidência, % de conclusão, crescimento vs. mesmo período do ano anterior), pelo menos um dos KPIs deveria ser esse — não só contagens brutas — mesmo que o pedido não tenha usado a palavra "cálculo" ou "medida"; monte-o como medida nomeada (ver abaixo), que é a ferramenta certa pra isso, exatamente como você já escolhe entre bar/line/kpi sem o pedido especificar o tipo de gráfico.
- Prefira o bucket de data mais largo que ainda faça sentido pra série ('year:'/'quarter:'/'month:' antes de 'day:') — 'month:<campo>' a 'day:<campo>' quando cobrir muitos meses, por exemplo. Pra pedidos do tipo "por ano e mês" ou "com essa hierarquia de datas", combine 2+ buckets do MESMO campo em dimensions/matrixRows/matrixColumns na ordem year→quarter→month→day (ex. ['year:Data','month:Data']) — o motor rotula e ordena cronologicamente sozinho.
- Widgets do mesmo assunto têm o mesmo recorte: um filtro fixo (widgetFilters) só entra quando o pedido pede aquele recorte; se entrar, vai em todos os widgets do mesmo assunto e o subtitle diz qual é. Uma pizza e umas barras da mesma coisa, uma filtrada e a outra não, mostram números diferentes e parecem um erro.
- Chame propose_widgets UMA vez, no fim, com tudo que você decidiu montar.

Medidas nomeadas são a MESMA caixa de ferramentas dos widgets comuns, não um recurso à parte só pra quando alguém pede "um cálculo" explicitamente — considere-as em QUALQUER pedido, inclusive numa dashboard nova e num pedido vago (ver bullet acima), sempre que o resultado certo precisar de período relativo a agora, filtro fixo por categoria, ou combinar dois números numa conta (comparativo entre períodos, taxa, percentual — inclusive cruzando fontes diferentes). Filtro e dimensão de widget não têm nenhum desses conceitos — forçar por lá dá um número errado, ou algo impossível de expressar. Use propose_measures nesses casos:
- Período relativo ("últimos N dias/meses", "ano até a data", "mês/trimestre/ano atual", "mesmo período do ano passado") vira o campo dateWindow de uma medida "simple" — nunca um filtro fixo de data absoluta.
- "Mesmo período do ano passado" é sempre dateWindow do tipo shiftYears (years: -1) envolvendo a janela base (ex. shiftYears de years: -1 sobre lastNMonths de n: 3) — não existe um tipo "sameriodLastYear" à parte.
- Um pedido do tipo "contagem de protocolo dos últimos 3 meses comparado com o mesmo período do ano passado" vira 3 medidas na MESMA chamada de propose_measures: uma "simple" com esse dateWindow (período atual), outra "simple" com o mesmo dateWindow envolto em shiftYears (período anterior), e uma "formula" que referencia as duas pelo NOME (diferença, variação percentual, ou o que fizer mais sentido pro pedido — some as duas formas se não tiver certeza de qual a pessoa quer ver, ex. diferença absoluta E percentual como duas medidas "formula" separadas).
- Toda medida "formula" combina outras medidas NOMEADAS — nunca um campo cru direto. Se precisar de um número que ainda não existe como medida, proponha-o primeiro como "simple" na MESMA chamada.
- Cruzar medidas de fontes diferentes numa fórmula é permitido — preencha "description" explicando a suposição assumida (o motor calcula, mas não sabe se a conta faz sentido de negócio; isso é obrigatório, a chamada falha sem isso).
- Quando o pedido isolar um VALOR/CATEGORIA fixo de uma coluna (um status, uma equipe, um tipo — ex. "protocolos com status Reincidência", "total sem contar os cancelados"), use o campo "filters" de uma medida "simple" (op "in" pra manter só esses valores, "notIn" pra excluí-los) — nunca tente simular isso com dateWindow (que é só pra data) nem deixe de fora achando que não dá pra expressar. Ex.: "% de reincidência sobre o total instalado no mês" vira 3 medidas: uma "simple" com filters:[{field:"Status", op:"in", values:["Reincidência"]}] e o mesmo dateWindow do mês, outra "simple" só com o dateWindow (sem filters, o total), e uma "formula" dividindo as duas.
- SEMPRE que o resultado de uma medida for uma taxa/percentual (o nome começa com "Taxa de", "%", "Percentual de", ou a fórmula termina multiplicando por 100 — ex. "atrasados / total * 100"), marque format:"percent" nessa medida. Sem isso o valor aparece certo mas SEM o sinal "%" no Card (ex. "81,9" em vez de "81,9%") — o número calculado já está certo, é só a exibição que fica sem contexto. Não marque format:"percent" numa medida que já é uma contagem/soma pura (isso deixaria "5.326" virar "5.326%", errado).
- O pedido descreve uma mudança numa medida que JÁ aparece no catálogo (ex. "marca a Taxa de encerramento como percentual", "muda o filtro dessa medida", "renomeia a Taxa de X")? Use update_measures (id da medida + só os campos que mudam), nunca propose_measures — chamar propose_measures com o MESMO nome de uma medida existente sempre cria uma medida NOVA parecida (salva como "Nome (2)"), não edita a original, e normalmente não é isso que a pessoa quer. Reserve propose_measures pra quando o pedido é claramente sobre algo que ainda não existe, mesmo que o nome escolhido acabe parecido com uma medida já existente — nesse caso o "(2)" automático é o comportamento certo, não um erro a evitar.
- Se o pedido também pedir pra VER o resultado (ex. "um card comparando"), depois de propose_measures retornar, chame propose_widgets usando o id que voltou na resposta (ex. measure: {agg: "countDistinct", measureRef: "<id devolvido>"}) — nunca invente um id. Quando as duas coisas forem pedidas juntas, chame propose_measures ANTES de propose_widgets, na mesma resposta.
- Uma medida nomeada só cabe INTEIRA (fórmula, fonte cruzada, qualquer tipo) num KPI (measure único, sem dimensions). Num gráfico/matriz com dimensions, só uma medida "simple" da MESMA fonte do widget pode ser referenciada — nunca uma "formula" nem uma medida de outra fonte nesse papel.

Comunicação: seja direto e breve. Uma ou duas frases dizendo o que montou e por quê — a pessoa vai ver os widgets na tela, não precisa de descrição campo por campo. Sem preâmbulo, sem recapitular o pedido.

Escopo: entregue o que foi pedido, no tamanho que foi pedido. Se o pedido for ambíguo, resolva como um colega experiente resolveria e siga; só pergunte quando leituras diferentes levariam a dashboards materialmente diferentes. Não acrescente widgets que ninguém pediu.

Aparência: o schema te dá acesso a TUDO que o editor manual permite ajustar na aba Formato — cor, paleta de série, fundo do card (e opacidade), opacidade das colunas/linhas/fatias, cor dos ícones, linhas de grade, sombra/brilho/piscar estáticos, formatação de texto completa (título, subtítulo, eixo X, eixo Y, legenda, linhas/colunas da matriz — fonte, negrito/itálico/sublinhado, cor, opacidade, fundo), rótulos de dado (geral e por série), formatação de tabela, tamanho do card (w/h) e meta/alertas (conditionalRules).
Regra única para TODOS esses campos (vale no nível de personalização MÍNIMO; os níveis MÉDIO e ALTO, escolhidos pela pessoa no painel, vêm no bloco "Preferências DESTE pedido" e mandam no lugar desta regra): por padrão, NÃO preencha nenhum — omita, e os widgets nascem com a aparência padrão do app/tema da guia. Isso é o comportamento certo quando ninguém pediu nada sobre visual, e widgets "no mesmo padrão" não é um defeito nesse caso.
Só preencha quando a pessoa pedir, no mesmo turno ou num turno anterior da conversa, algo sobre cor, visual, design, tamanho, formatação ou variedade/diversidade entre os widgets (ex.: "cores diferentes", "cada gráfico com um estilo", "deixa mais bonito", "títulos maiores", "tamanhos variados", "alerta quando passar de X"). Quando pedirem, use o quanto do toolkit fizer sentido pro pedido — não se limite a só cor se a pessoa pediu "personalizar" de forma ampla:
- Varie de verdade entre os widgets propostos — não repita a mesma cor/tamanho/formatação em todos; isso derrota o pedido.
- Em gráfico com várias categorias/série (pizza, funil, dispersão, barra sem legenda), prefira \`palette\` (3+ cores bem distintas entre si, não um degradê) a um \`color\` só.
- \`titleFormat.fontSize\` (e o das demais \`*Format\`) dá hierarquia visual — use isso quando pedirem "tamanhos diferentes" (ex. o KPI mais importante com título maior que os demais).
- \`w\`/\`h\` controlam o tamanho do card na grade — varie quando pedirem layout diferente (ex. um widget-destaque maior, KPIs menores).
- \`conditionalRules\`/\`target\` (meta e alertas) só entram se o pedido for sobre ALERTA/DESTAQUE CONDICIONAL/META (ex. "fica vermelho se passar de X") — não é o que "cores diferentes entre os widgets" pede; não misture os dois.
- \`shadow\`/\`glow\`/\`blink\` são efeitos fortes — use com moderação mesmo quando pedido (ex. não ligue \`blink\` em todos os widgets de uma vez só porque pediram "mais chamativo").
- Mesmo com liberdade total de aparência, o dado e a estrutura continuam vindo primeiro: nunca troque um tipo de gráfico por outro só para variar visual, nem sacrifique clareza (contraste, tamanho legível) por variedade.`

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

// Medidas JÁ existentes nesta dashboard (ver DashboardConfig.measures) —
// pra não propor de novo algo que já existe, e pra poder referenciar uma
// delas por NOME numa fórmula nova (ver propose_measures). Não muda de
// turno pra turno dentro da MESMA conversa por si só — é recarregado do
// que o navegador envia a cada turno (mesmo rascunho local que os widgets
// já usam), então uma medida aprovada num turno anterior (ainda sem
// "Salvar" de verdade) já aparece aqui no turno seguinte.
function measuresText(dashboardMeasures) {
  if (!dashboardMeasures.length) return 'Nenhuma medida cadastrada ainda nesta dashboard.'
  const lines = dashboardMeasures.map((m) => {
    const fmt = m.format ? ` · format: ${m.format}` : ''
    if (m.kind === 'simple') {
      const win = m.dateWindow ? ` · janela de data: ${JSON.stringify(m.dateWindow)}` : ''
      const filt = m.filters?.length ? ` · filtro: ${JSON.stringify(m.filters)}` : ''
      return `  - "${m.name}" (simple, id ${m.id}) — ${m.agg}${m.field ? ` de ${m.field}` : ''}, fonte "${m.source}"${win}${filt}${fmt}${m.description ? ` — ${m.description}` : ''}`
    }
    return `  - "${m.name}" (formula, id ${m.id}) — ${m.expression}, refs: ${JSON.stringify(m.refs)}${fmt}${m.description ? ` — ${m.description}` : ''}`
  })
  return `Medidas já existentes nesta dashboard (reutilizáveis por nome numa fórmula nova, ou por id num measureRef):\n${lines.join('\n')}`
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
        'Entrega os widgets montados. Chame exatamente uma vez, no fim do seu raciocínio, com todos os widgets que você decidiu montar. Eles entram na guia e são SALVOS na hora, sem o usuário precisar aprovar — ele pode desfazer. Por isso só entregue widgets testados e coerentes com o pedido.',
      input_schema: PROPOSE_TOOL_SCHEMA,
    },
    {
      name: 'preview_measure',
      description:
        'Calcula o valor de UMA medida ainda não proposta, contra os dados reais — devolve o número final e, se for uma fórmula, o valor de cada medida referenciada. Use pra conferir que uma janela de data ou uma fórmula produz um número plausível ANTES de propor (ex. perceber uma razão com denominador zero ou implausível). Opcional; não precisa ser chamada pra medidas simples e óbvias.',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: {
          measure: { ...PROPOSE_MEASURES_TOOL_SCHEMA.properties.measures.items, description: 'A medida a calcular.' },
          batch: {
            type: 'array', items: PROPOSE_MEASURES_TOOL_SCHEMA.properties.measures.items,
            description: 'Outras medidas ainda não propostas que `measure` referencia por nome (ex. testar uma fórmula "comparativo" sem ainda ter chamado propose_measures pras medidas "atual"/"anterior" que ela usa).',
          },
        },
        required: ['measure'],
      },
    },
    {
      name: 'propose_measures',
      description:
        'Entrega uma ou mais medidas nomeadas NOVAS para o usuário aprovar (ver instruções sobre quando usar isto em vez de measure/measures inline). Pode ser chamada mais de uma vez no mesmo turno se fizer sentido, mas o comum é uma vez só, com o lote inteiro (ex. "atual", "anterior" e "comparativo" juntos). SEMPRE cria uma medida NOVA — se o nome já existir nesta dashboard, ela é salva com um sufixo ("Nome (2)") em vez de editar a original. Se a intenção do pedido for mudar algo numa medida que JÁ existe (não criar uma parecida), use update_measures, nunca isto. As medidas entram na tabela de medidas e são SALVAS na hora, antes dos widgets — o usuário pode desfazer. A resposta traz o id e o nome FINAL (já com sufixo, se houve colisão) de cada medida — use-o depois num measureRef, nunca invente um id.',
      input_schema: PROPOSE_MEASURES_TOOL_SCHEMA,
    },
    {
      name: 'update_measures',
      description:
        'Aplica um ajuste (patch) numa ou mais medidas JÁ EXISTENTES nesta dashboard, encontradas por id (ver catálogo de medidas do prompt) — ex. "marca a Taxa de encerramento como percentual", "muda o filtro dessa medida pra incluir também Cancelado", "renomeia essa medida". Só os campos informados no patch mudam; o resto continua igual. Use isto sempre que o pedido descrever uma mudança em cima de algo que JÁ aparece no catálogo de medidas — chamar propose_measures nesse caso cria uma medida NOVA parecida ("Nome (2)") em vez de editar a original, o que quase nunca é a intenção. A atualização é aplicada e SALVA na hora — o usuário pode desfazer.',
      input_schema: UPDATE_MEASURES_TOOL_SCHEMA,
    },
    {
      // Sempre na lista (mesmo sem widget escolhido): as ferramentas fazem
      // parte do prefixo cacheado, e uma lista que muda de turno pra turno o
      // invalidaria. Sem widget escolhido, a chamada só volta como erro.
      name: 'update_widget',
      description:
        'Ajusta o widget que a pessoa ESCOLHEU (bloco "Widget escolhido" do prompt — só existe quando ela clicou em "Ajustar com IA" num widget). Mande em `changes` só o que muda e em `remove` o que sai; o resto do widget fica como está. O ajuste é aplicado e SALVO na hora, no mesmo lugar da guia — a pessoa pode desfazer. Para um widget a MAIS, use propose_widgets.',
      input_schema: UPDATE_WIDGET_TOOL_SCHEMA,
    },
  ]
}

// O widget em que a pessoa clicou "Ajustar com IA", e os outros da mesma
// guia — esses só para comparar (o caso que motivou: uma pizza e umas barras
// da mesma coisa, 79 × 80, e a diferença era um filtro fixo só na pizza).
// Vem do navegador a cada envio; o tamanho é limitado porque cada caractere
// é token cobrado.
const TARGET_MAX_CHARS = 6000
const OTHERS_MAX_CHARS = 8000
const SUMMARY_KEYS = ['id', 'type', 'title', 'subtitle', 'source', 'dimensions', 'legendDimension', 'measure', 'measures', 'measuresLine', 'widgetFilters', 'columns', 'matrixRows', 'matrixColumns', 'matrixValue', 'limit', 'sort']

export function sanitizeTarget(raw) {
  const w = raw?.widget
  if (!w || typeof w !== 'object' || typeof w.id !== 'string' || typeof w.type !== 'string') return null
  if (JSON.stringify(w).length > TARGET_MAX_CHARS * 4) return null
  const others = (Array.isArray(raw.others) ? raw.others : [])
    .filter((o) => o && typeof o === 'object' && typeof o.id === 'string' && o.id !== w.id)
    .slice(0, 30)
    .map((o) => Object.fromEntries(SUMMARY_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])))
  return { widget: w, others }
}

function targetText(target) {
  const clip = (s, max) => (s.length > max ? `${s.slice(0, max)} …(cortado)` : s)
  const { layout: _layout, insight: _insight, ...shown } = target.widget
  const others = target.others.length
    ? target.others.map((o) => `  - ${clip(JSON.stringify(o), 900)}`).join('\n')
    : '  (nenhum)'
  return [
    'Pedido sobre UM widget específico: a pessoa clicou em "Ajustar com IA" neste widget, e o que ela escrever é sobre ele.',
    `Widget escolhido (configuração atual): ${clip(JSON.stringify(shown), TARGET_MAX_CHARS)}`,
    `Outros widgets da mesma guia — só para comparar, NÃO os altere:\n${clip(others, OTHERS_MAX_CHARS)}`,
    'Como agir:',
    '- Ajuste-o com update_widget (só o que muda). Não crie um widget novo com propose_widgets, a não ser que a pessoa peça um widget a mais.',
    '- Se a pergunta for por que um número difere do de outro widget, compare as configurações (filtros fixos, medida e agregação, campo, Top N, nível de data) e diga a diferença em uma frase. Mude só o que a pessoa pediu — ou, se ela pediu para "corrigir"/"deixar igual", o que causa a diferença.',
    '- Mantenha título e subtítulo coerentes com o que o widget passa a mostrar (um filtro fixo novo aparece no subtítulo; um que saiu, sai do subtítulo).',
  ].join('\n')
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
    // A escolha "o que entregar" do painel (ver aiRequestOptions.mjs) — limita
    // só o tipo de widget; medidas nomeadas seguem livres.
    const allowed = allowedWidgetTypes(ctx.options)
    if (allowed) {
      const outside = list.filter((w) => !allowed.has(w?.type)).map((w) => `"${w?.title ?? '?'}" (${w?.type})`)
      if (outside.length) {
        return { isError: true, text: `A pessoa pediu só ${deliverLabel(ctx.options)} neste pedido — tipos permitidos: ${[...allowed].join(', ')}. Troque ou tire: ${outside.join('; ')}. Chame propose_widgets de novo.` }
      }
    }
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
    return { text: `${widgets.length} widget(s) entregues: entram na guia e são salvos automaticamente. Não repita o conteúdo deles na sua resposta — a pessoa já os está vendo.` }
  }

  if (name === 'update_widget') {
    const target = ctx.target
    if (!target) {
      return { isError: true, text: 'Não há widget escolhido neste pedido — update_widget só vale quando a pessoa clica em "Ajustar com IA" num widget. Para montar widgets, use propose_widgets.' }
    }
    const out = applyWidgetPatch(target.widget, input, ctx.sources)
    if (out.errors) {
      return { isError: true, text: `Corrija e chame update_widget de novo:\n${out.errors.map((e) => `- ${e}`).join('\n')}` }
    }
    const { widget } = out
    ctx.emit({ type: 'widgetUpdate', widgetId: widget.id, widget, summary: String(input.summary ?? '') })
    // Uma segunda chamada no mesmo turno parte do que acabou de ser ajustado.
    ctx.target = { ...target, widget }
    ctx.proposed += 1
    return { text: `Widget "${widget.title}" ajustado e salvo. Diga em uma frase o que mudou — a pessoa já está vendo o widget.` }
  }

  if (name === 'preview_measure' || name === 'propose_measures') {
    const isPreview = name === 'preview_measure'
    const list = isPreview
      ? [...(Array.isArray(input.batch) ? input.batch : []), input.measure].filter(Boolean)
      : (Array.isArray(input.measures) ? input.measures : [])
    if (list.length === 0) return { isError: true, text: isPreview ? 'Nenhuma medida informada.' : 'Nenhuma medida na proposta.' }

    const errors = validateMeasureBatch(list, ctx.sources, ctx.dashboardMeasures)
    if (errors.length) {
      return { isError: true, text: `Corrija e chame ${name} de novo:\n${errors.map((e) => `- ${e}`).join('\n')}` }
    }
    const normalized = normalizeMeasureBatch(list, ctx.dashboardMeasures)

    if (isPreview) {
      const target = normalized[normalized.length - 1] // sempre a última — `batch` (se houver) vem antes de `measure`
      const allMeasures = [...ctx.dashboardMeasures, ...normalized]
      const sheetKeys = [...new Set(allMeasures.filter((m) => m.kind === 'simple' && isSheetSource(m.source)).map((m) => m.source))]
      const snap = await withSheetSources(getSnapshot(), sheetKeys, ctx.accessToken)
      if (!snap) return { isError: true, text: 'Base ainda não materializada no servidor.' }
      const mctx = {
        measuresById: new Map(allMeasures.map((m) => [m.id, m])), snap, relations: [], tabFilters: [], now: new Date(),
        sourceRowsCache: new Map(), resolvedScalarCache: new Map(), visiting: new Set(),
      }
      try {
        const result = await resolveMeasure(target.id, mctx)
        const resolvedRefs = {}
        if (target.kind === 'formula') {
          for (const [alias, refId] of Object.entries(target.refs)) resolvedRefs[alias] = (await resolveMeasure(refId, mctx)).value
        }
        return { text: JSON.stringify({ value: result.value, resolvedRefs: Object.keys(resolvedRefs).length ? resolvedRefs : undefined }) }
      } catch (e) {
        return { isError: true, text: e.message }
      }
    }

    // Efeito colateral deliberado, mesmo padrão de propose_widgets: a
    // proposta vai pro navegador por SSE, não pelo texto da resposta.
    ctx.emit({ type: 'measures', measures: normalized, summary: String(input.summary ?? '') })
    // Acumula na MESMA conversa (mesmo turno ou um seguinte) — permite
    // referenciar por nome numa fórmula depois, ou usar o id real num
    // measureRef de propose_widgets no mesmo turno, antes de qualquer
    // "Salvar" de verdade (aprovar só entra no rascunho local, como sempre).
    ctx.dashboardMeasures = [...ctx.dashboardMeasures, ...normalized]
    ctx.proposed += 1
    const idList = normalized.map((m) => `"${m.name}" = ${m.id}`).join(', ')
    return { text: `${normalized.length} medida(s) entregue(s): entram na tabela de medidas e são salvas automaticamente. IDs pra usar em measureRef: ${idList}. Não repita o conteúdo delas na sua resposta — a pessoa já as está vendo.` }
  }

  if (name === 'update_measures') {
    const list = Array.isArray(input.updates) ? input.updates : []
    if (list.length === 0) return { isError: true, text: 'Nenhuma atualização na proposta.' }

    const errors = validateMeasureUpdates(list, ctx.sources, ctx.dashboardMeasures)
    if (errors.length) {
      return { isError: true, text: `Corrija e chame update_measures de novo:\n${errors.map((e) => `- ${e}`).join('\n')}` }
    }
    const updated = normalizeMeasureUpdates(list, ctx.dashboardMeasures)

    // Efeito colateral deliberado, mesmo padrão de propose_measures — só que
    // aqui a proposta é uma EDIÇÃO no lugar (mesmo id de sempre), não uma
    // medida nova; o front faz upsert por id em vez de acrescentar.
    ctx.emit({ type: 'measureUpdates', measures: updated, summary: String(input.summary ?? '') })
    // Upsert por id no rascunho DESTA conversa também — uma chamada seguinte
    // no mesmo turno (ex. um preview_measure depois) já vê a versão nova.
    const updatedIds = new Set(updated.map((m) => m.id))
    ctx.dashboardMeasures = [...ctx.dashboardMeasures.filter((m) => !updatedIds.has(m.id)), ...updated]
    ctx.proposed += 1
    const idList = updated.map((m) => `"${m.name}" = ${m.id}`).join(', ')
    return { text: `${updated.length} medida(s) atualizada(s), aplicadas e salvas automaticamente: ${idList}. Não repita o conteúdo delas na sua resposta — a pessoa já as está vendo.` }
  }

  return { isError: true, text: `Ferramenta desconhecida: ${name}` }
}

// ─── Conversa ──────────────────────────────────────────────────────────
// `history` só vem numa retomada (ver resumeHistory): conversa nova começa vazia.
export async function startConversation({ email, folderId, sourceKeys, accessToken, history }) {
  const all = await listSourceDefs(folderId, accessToken)
  const selected = all.filter((s) => sourceKeys.includes(s.key))
  if (selected.length === 0) {
    throw new Error('Selecione pelo menos uma fonte de dados para conversar com a IA.')
  }
  pruneConversations()
  const id = randomUUID()
  const messages = resumeHistory(history)
  conversations.set(id, {
    email, folderId, sourceKeys: selected.map((s) => s.key), messages, lastUsedAt: Date.now(),
  })
  return {
    conversationId: id,
    resumed: messages.length > 0,
    sources: selected.map((s) => ({ key: s.key, label: s.label, fieldCount: s.fields.length })),
  }
}

// Roda um turno da conversa, emitindo eventos conforme acontecem. `emit` é o
// canal SSE pro navegador; a função só retorna quando o turno acabou.
// `sourceKeys`: as fontes marcadas no painel neste envio. A pessoa pode pôr ou
// tirar fonte no meio da conversa — só valem as que a pasta libera
// (listSourceDefs já filtra), e a troca entra no histórico como aviso, pro
// modelo não seguir propondo com a fonte que saiu.
// `options`: as preferências deste pedido (personalização e o que entregar —
// ver aiRequestOptions.mjs). `target`: o widget em que a pessoa clicou
// "Ajustar com IA", e os outros da guia (ver sanitizeTarget/targetText).
export async function runTurn({ conversationId, email, userText, accessToken, emit, dashboardMeasures = [], sourceKeys, options, target }) {
  const conv = conversations.get(conversationId)
  if (!conv) throw new Error('Esta conversa expirou. Comece uma nova.')
  if (conv.email !== email) throw new Error('Esta conversa pertence a outro usuário.')
  assertWithinBudget(email)

  // Recarrega o catálogo a cada turno: uma fonte pode ter sido atualizada
  // pelo ETL no meio da conversa, e é mais barato relê-lo do snapshot em
  // memória do que arriscar propor um campo que deixou de existir.
  const all = await listSourceDefs(conv.folderId, accessToken)
  let sourcesNote = null
  if (Array.isArray(sourceKeys) && sourceKeys.length > 0) {
    const wanted = all.filter((s) => sourceKeys.includes(s.key)).map((s) => s.key)
    if (wanted.length === 0) throw new Error('Nenhuma das fontes marcadas está liberada para esta pasta.')
    const before = new Set(conv.sourceKeys)
    if (wanted.length !== before.size || wanted.some((k) => !before.has(k))) {
      const label = (k) => all.find((s) => s.key === k)?.label ?? k
      const added = wanted.filter((k) => !before.has(k)).map(label)
      const removed = conv.sourceKeys.filter((k) => !wanted.includes(k)).map(label)
      conv.sourceKeys = wanted
      sourcesNote = [
        'As fontes desta conversa mudaram a pedido do usuário.',
        added.length ? `Entraram: ${added.join(', ')}.` : '',
        removed.length ? `Saíram: ${removed.join(', ')} — o que já foi montado com elas continua na dashboard, mas não proponha nada novo com essas fontes.` : '',
        'O catálogo do sistema já mostra só as fontes atuais.',
      ].filter(Boolean).join(' ')
    }
  }
  const sources = all.filter((s) => conv.sourceKeys.includes(s.key))
  if (sources.length === 0) throw new Error('As fontes desta conversa não estão mais disponíveis.')

  conv.lastUsedAt = Date.now()
  if (sourcesNote) conv.messages.push({ role: 'system', content: sourcesNote })
  conv.messages.push({ role: 'user', content: userText })

  //  conta as propostas aceitas no turno — é o que decide se um
  // estouro de orçamento é perda total ou entrega parcial. `dashboardMeasures`
  // acumula propose_measures dentro do MESMO turno (ver runTool) — permite
  // uma fórmula do turno referenciar, por nome, uma medida proposta poucas
  // idas antes, no mesmo turno, sem precisar já estar salva de verdade.
  const ctx = { sources, accessToken, emit, proposed: 0, dashboardMeasures: [...dashboardMeasures], options: normalizeRequestOptions(options), target: sanitizeTarget(target) }
  const tools = buildTools()
  const system = [
    { type: 'text', text: INSTRUCTIONS },
    // Breakpoint no ÚLTIMO bloco ESTÁVEL de system: cacheia ferramentas +
    // instruções + catálogo de uma vez (render order é tools → system →
    // messages). O bloco de medidas vem DEPOIS, sem cache_control — muda a
    // cada turno (uma medida aprovada no turno anterior já aparece aqui),
    // então não pode fazer parte do prefixo cacheado sem invalidá-lo toda
    // vez que alguém aprova uma medida.
    { type: 'text', text: catalogText(sources), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: measuresText(ctx.dashboardMeasures) },
    // Preferências deste pedido (passos 3 e 4 do painel) — também mudam a cada
    // turno, então ficam fora do prefixo cacheado, como as medidas.
    { type: 'text', text: requestOptionsText(ctx.options) },
    // O widget escolhido para ajustar — também muda a cada turno.
    ...(ctx.target ? [{ type: 'text', text: targetText(ctx.target) }] : []),
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

  // Lido UMA vez por turno, não por ida: se alguém trocar o orçamento de idas
  // na tela no meio de um turno, o turno em andamento termina com a regra com
  // que começou. Reler por ida faria o "ida 3/14" do log mudar de
  // denominador no meio do caminho.
  const { maxIterations } = aiConfig()

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const remaining = maxIterations - iteration
    // Aviso de fechamento como mensagem de sistema no meio da conversa: entra
    // DEPOIS do histórico, então não invalida o prefixo cacheado, e é canal de
    // operador (o modelo trata como instrução, não como texto do usuário).
    if (remaining === WRAP_UP_AT && ctx.proposed === 0) {
      conv.messages.push({
        role: 'system',
        content: ctx.target
          ? 'Você tem poucas idas restantes neste turno. Pare de explorar e chame update_widget AGORA com o ajuste pedido no widget escolhido.'
          : `Você tem poucas idas restantes neste turno. Pare de explorar e chame propose_widgets AGORA, com o melhor conjunto que você já consegue montar a partir do catálogo. É melhor entregar 3 widgets sólidos do que não entregar nada.`,
      })
    }

    const turn = await streamTurn({
      system,
      tools,
      messages: conv.messages,
      onText: (delta) => emit({ type: 'text', text: delta }),
    })
    totalUsd += recordSpend(email, turn.usage)
    // `turn.content` já vem em blocos no formato canônico, montado pelo
    // adaptador mesmo para provedor que não fala em blocos — é isso que deixa
    // o histórico idêntico independente de quem respondeu, e o que permite
    // trocar de provedor no meio de uma conversa sem corrompê-la.
    conv.messages.push({ role: 'assistant', content: turn.content })

    if (turn.stopReason === 'refusal') {
      emit({ type: 'error', message: 'O modelo recusou este pedido. Reformule ou tente um recorte diferente.' })
      return finish()
    }
    if (turn.stopReason !== 'tool_use') {
      console.log(`[ai] turno concluído em ${iteration + 1} ida(s) · ${ctx.proposed} proposta(s) · US$ ${totalUsd.toFixed(4)}`)
      return finish()
    }

    const toolUses = turn.toolCalls
    const results = []
    for (const call of toolUses) {
      emit({ type: 'tool', name: call.name })
      let out
      try {
        out = await runTool(call.name, call.input ?? {}, ctx)
      } catch (e) {
        out = { isError: true, text: e.message }
      }
      console.log(`[ai] ida ${iteration + 1}/${maxIterations} · ${call.name}${out.isError ? ' (erro: ' + out.text.split('\n')[0] + ')' : ''}`)
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
  console.log(`[ai] orçamento de ${maxIterations} idas esgotado · ${ctx.proposed} proposta(s) · US$ ${totalUsd.toFixed(4)}`)
  if (ctx.proposed === 0) {
    emit({
      type: 'error',
      message: 'A IA explorou os dados mas não fechou uma proposta neste turno. Peça de novo — de preferência mais específico (ex.: "3 KPIs de churn e um gráfico por motivo de cancelamento").',
    })
  }
  return finish()
}
