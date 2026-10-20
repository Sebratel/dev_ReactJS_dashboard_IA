// Preferências de cada pedido à IA, escolhidas no painel (passos 3 e 4 — ver
// src/features/builder/ai/AiRequestOptions.tsx):
//   - personalization: quanto da aba Formato a IA usa (mínimo, médio, alto);
//   - deliver: que tipos de widget ela pode entregar — null = padrão (ela
//     decide, como sempre), ou uma lista entre tabelas, gráficos e cards.
// Medidas nomeadas NÃO entram nessa escolha: em qualquer entrega ela cria as
// que a análise pedir (taxa, percentual, comparativo) — limitar isso só
// piorava o resultado.
// Vão como um bloco do prompt de sistema a CADA turno (o pedido seguinte pode
// ter outra escolha), e o "deliver" também é cobrado nas ferramentas: widget de
// tipo não pedido volta como erro pro modelo corrigir — não fica só na boa
// vontade dele.

export const PERSONALIZATION_LEVELS = ['minimal', 'medium', 'high']
export const DELIVERABLES = ['tables', 'charts', 'cards']

const TYPES_BY_DELIVERABLE = {
  tables: ['table', 'matrix'],
  charts: ['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'line', 'area', 'pie', 'scatter', 'funnel', 'histogram'],
  cards: ['kpi'],
}

const LABEL = { tables: 'Tabelas', charts: 'Gráficos', cards: 'Cards' }

export const DEFAULT_REQUEST_OPTIONS = { personalization: 'medium', deliver: null }

// Aceita o que vier do navegador; qualquer coisa estranha cai no padrão.
export function normalizeRequestOptions(raw) {
  const personalization = PERSONALIZATION_LEVELS.includes(raw?.personalization) ? raw.personalization : DEFAULT_REQUEST_OPTIONS.personalization
  const list = Array.isArray(raw?.deliver) ? [...new Set(raw.deliver.filter((d) => DELIVERABLES.includes(d)))] : []
  return { personalization, deliver: list.length ? list : null }
}

// Tipos de widget permitidos neste pedido — null = qualquer um.
export function allowedWidgetTypes(options) {
  if (!options.deliver) return null
  return new Set(options.deliver.flatMap((d) => TYPES_BY_DELIVERABLE[d] ?? []))
}

export function deliverLabel(options) {
  return options.deliver ? options.deliver.map((d) => LABEL[d]).join(', ') : 'Padrão'
}

const PERSONALIZATION_TEXT = {
  minimal: `Personalização: MÍNIMA. Não preencha nenhum campo de aparência — cor, paleta, fundo do card, opacidade, formatação de texto, rótulos de dado, linhas de grade, efeitos, metas/alertas, tamanho fora do padrão. Os widgets nascem com a aparência padrão do app/tema da guia. Só abra exceção para o que o texto do pedido pedir explicitamente.`,
  medium: `Personalização: MÉDIA. Deixe cada widget bem acabado e fácil de ler, sem exagero: título claro e um subtitle curto dizendo o recorte (período, filtro); rótulos de dado onde ajudam a leitura (barras com poucas categorias, pizza/funil com percentual); números e percentuais bem formatados (format "percent" nas taxas); uma paleta coerente, com cores bem distintas entre séries/categorias; e tamanho (w/h) dando destaque ao principal (KPIs menores, o gráfico central maior). NÃO use sombra/brilho/piscar, fundo colorido no card, nem meta/alerta (conditionalRules/target) a menos que o pedido fale de meta ou alerta.`,
  high: `Personalização: ALTA. Use o kit de aparência a fundo, variando de verdade entre os widgets: paleta própria por widget, fundo do card com opacidade suave, hierarquia de títulos (fontSize maior no principal), subtitle explicando o recorte, rótulos de dado, formatação de tabela/matriz (cabeçalho, zebra, alinhamento), meta/alertas (conditionalRules/target) quando houver uma referência natural (ex. uma taxa com limite óbvio), gráfico dinâmico quando ajudar, e sombra/brilho com moderação — no máximo 1 ou 2 destaques. Nunca sacrifique contraste ou legibilidade, e nunca troque o tipo de gráfico só para variar.`,
}

// O bloco do prompt de sistema deste turno.
export function requestOptionsText(options) {
  const lines = [
    'Preferências DESTE pedido, escolhidas pela pessoa no painel (valem só para este turno; substituem a regra "por padrão, NÃO preencha nenhum" das instruções de Aparência; um pedido explícito no texto sempre vence):',
    PERSONALIZATION_TEXT[options.personalization],
  ]
  if (!options.deliver) {
    lines.push('Entrega: PADRÃO — você decide o que montar (widgets de qualquer tipo, medidas nomeadas quando fizerem sentido), como sempre.')
  } else {
    lines.push(`Entrega: SOMENTE ${deliverLabel(options)} — tipos de widget permitidos: ${[...allowedWidgetTypes(options)].join(', ')}. Qualquer outro tipo (inclusive "text") será recusado.`)
    lines.push('Medidas nomeadas: continuam como sempre — crie (propose_measures) ou ajuste (update_measures) as que a sua análise pedir, como taxa, percentual, comparativo ou conta entre dois números, e mostre-as nos widgets permitidos por measureRef. A escolha acima limita só o tipo de widget, nunca as medidas.')
  }
  return lines.join('\n')
}
