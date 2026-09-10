// ─────────────────────────────────────────────────────────────────────────
// Leitura de um gráfico pela IA — "que história este gráfico conta".
//
// O QUE ESTE MÓDULO NÃO FAZ, DE PROPÓSITO: explicar o CÁLCULO. Isso sai do
// próprio WidgetConfig, no navegador, de graça e sem chance de erro (ver
// src/features/builder/explainWidget.ts). Pagar o modelo para narrar algo que
// sabemos com exatidão só criaria uma explicação plausível onde havia uma
// correta. Aqui a IA faz só a parte que é de fato interpretação.
//
// CUSTO E PESO: uma única ida ao modelo, sem loop de ferramentas. O que sobe é
// o resultado JÁ AGREGADO — as dezenas de pontos que o gráfico desenha, nunca
// as linhas da base. Um top 10 são ~10 pares rótulo/valor. Cache em memória
// por (widget + impressão digital dos dados), com TTL e teto de itens: reabrir
// o mesmo gráfico não paga de novo, e nada disso toca o disco.
//
// ORÇAMENTO: compartilhado com o assistente do Builder (ver aiAssistant.mjs) —
// é o mesmo teto diário por usuário, não um teto por feature.
// ─────────────────────────────────────────────────────────────────────────
import { runWidgetQuery } from './widgetQuery.mjs'
// `recordSpend`/`assertWithinBudget` vêm de lá porque o teto diário é o mesmo
// das duas features (ver o cabeçalho).
import { assertWithinBudget, recordSpend } from './aiAssistant.mjs'
import { isAiConfigured } from './aiConfig.mjs'
import { completeOnce } from './aiProvider.mjs'

// A tarefa é curta e fechada (ler algumas dezenas de números e escrever três
// parágrafos), não é o raciocínio aberto de montar uma dashboard. `medium` dá
// resultado equivalente aqui por uma fração do custo e da espera.
const EFFORT = process.env.AI_INSIGHT_EFFORT || 'medium'
const MAX_TOKENS = Math.max(500, Number(process.env.AI_INSIGHT_MAX_TOKENS) || 1200)
// Teto de pontos enviados. Acima disso o gráfico já não é legível de qualquer
// forma, e a leitura interessa sobre os maiores.
const MAX_POINTS = 60

const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 200
const cache = new Map() // chave → { text, usd, at }

function pruneCache() {
  const now = Date.now()
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL_MS) cache.delete(k)
  while (cache.size > CACHE_MAX) {
    // Map preserva ordem de inserção: o primeiro é o mais antigo.
    const first = cache.keys().next()
    if (first.done) break
    cache.delete(first.value)
  }
}

const SYSTEM = `Você lê UM gráfico de uma dashboard interna da Sebratel (telecom, provedor de internet) e explica que história ele conta, em português do Brasil.

Você recebe: como o gráfico foi calculado (isso já foi mostrado ao usuário, não repita) e os pontos que ele desenha.

Escreva 2 ou 3 parágrafos curtos, direto ao ponto, sem título e sem lista:
1. O que salta aos olhos — a concentração, o pico, a quebra de tendência. Cite os números que sustentam a afirmação e, quando ajudar, a participação no total ("64,9 mil de 177,5 mil, ~37%").
2. A leitura de negócio: o que isso sugere sobre a operação. Seja específico; "precisa de atenção" não diz nada.
3. Só se houver algo concreto: o limite do que este gráfico permite concluir — um recorte que esconde o resto, um campo de texto livre com grafias repetidas, um período incompleto.

Regras rígidas:
- Use SOMENTE os números que estão nos dados recebidos. Nunca estime, complete nem invente valor que não esteja ali.
- Você vê o resultado agregado, não a base. Não afirme causa a partir de correlação, e não fale de campos que não estão neste gráfico.
- Se os dados não sustentarem nenhuma leitura interessante (poucos pontos, valores achatados, tudo zero), diga isso em uma frase em vez de forçar uma narrativa.
- Números no formato brasileiro (1.234,5). Nada de markdown.`

// Compacta os pontos: o modelo não precisa das chaves repetidas de um JSON de
// objetos, e cada token economizado aqui é custo direto.
function pointsForPrompt(data) {
  if (data?.matrix) {
    const cols = data.matrix.columns ?? []
    const rows = (data.matrix.rows ?? []).slice(0, MAX_POINTS)
    return [
      `Colunas: ${cols.map((c) => c.label).join(' | ')}`,
      ...rows.map((r) => `${r.label}: ${cols.map((c) => `${c.label}=${r.values?.[c.key] ?? 0}`).join(', ')} (total ${r.total})`),
    ].join('\n')
  }
  if (data?.rows?.length) {
    const rows = data.rows.slice(0, MAX_POINTS)
    return rows.map((r) => JSON.stringify(r)).join('\n')
  }
  const points = data?.points ?? []
  const series = data?.seriesKeys ?? []
  const shown = points.slice(0, MAX_POINTS)
  if (series.length > 1) {
    return [
      `Séries: ${series.map((s) => s.label).join(' | ')}`,
      ...shown.map((p) => `${p.label}: ${series.map((s) => `${s.label}=${p[s.key] ?? 0}`).join(', ')}`),
    ].join('\n')
  }
  return shown.map((p) => `${p.label}: ${p.value}`).join('\n')
}

/**
 * Gera (ou devolve do cache) a leitura de um gráfico.
 *
 * `calc` são as linhas do "Como foi calculado" que o navegador está exibindo.
 * Vêm do cliente de propósito: assim o modelo vê exatamente o que o usuário vê,
 * sem duplicar aqui a montagem dos rótulos em português. Isso NÃO é um vetor de
 * ataque — quem mentir no payload só engana a própria leitura, e os NÚMEROS não
 * vêm daí: a consulta é refeita aqui no servidor, contra a base real.
 */
export async function explainWidgetData({ email, widget, tabFilters = [], relations = [], calc = [], accessToken, force = false }) {
  if (!isAiConfigured()) throw new Error('IA não configurada — um administrador precisa cadastrar o provedor em Configurações › Provedor de IA.')
  if (!widget?.source) throw new Error('Este widget não consulta dados — não há o que ler.')
  assertWithinBudget(email)

  const data = await runWidgetQuery({ widget, tabFilters, relations, page: 1, pageSize: MAX_POINTS, accessToken })
  if (!data) throw new Error('Base ainda não materializada no backend.')

  const body = pointsForPrompt(data)
  if (!body.trim()) throw new Error('O gráfico não retornou dados para ler.')

  const calcText = (calc ?? []).map((l) => `- ${l.label}: ${l.value}`).join('\n')
  const key = JSON.stringify([widget.type, widget.title, calcText, body])

  pruneCache()
  if (!force) {
    const hit = cache.get(key)
    // Reinsere para o descarte por idade valer sobre o último uso, não sobre
    // a primeira geração.
    if (hit) { cache.delete(key); cache.set(key, hit); return { text: hit.text, usd: 0, cached: true } }
  }

  // Mesmo provedor e mesma credencial da montagem de widget, mas teto e
  // esforço próprios: ler um gráfico é uma tarefa pequena, e pagar preço de
  // montagem de dashboard por um parágrafo seria desperdício.
  const out = await completeOnce({
    system: SYSTEM,
    maxTokens: MAX_TOKENS,
    effort: EFFORT,
    userText: `Gráfico: ${widget.title}${widget.subtitle ? ` — ${widget.subtitle}` : ''}
Tipo de visual: ${widget.type}

Como foi calculado:
${calcText || '(não informado)'}

Dados que o gráfico desenha:
${body}`,
  })

  const text = out.text
  const usd = recordSpend(email, out.usage)
  if (!text) throw new Error('O modelo não devolveu texto.')

  cache.set(key, { text, usd, at: Date.now() })
  return { text, usd, cached: false }
}
