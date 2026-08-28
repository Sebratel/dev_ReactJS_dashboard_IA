// Renderiza um WidgetConfig buscando dados via /api/widget-data (reagindo aos
// filtros da aba). Tipos de visual: kpi, bar, barH, barStacked, barHStacked,
// comboBarLine, line, area, pie, scatter, funnel, table, matrix.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertTriangle, Pencil, Trash2, Copy, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, ComposedChart,
  ScatterChart, Scatter, FunnelChart, Funnel, LabelList, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { cn } from '@/utils/cn'
import { getSourceDef } from './fieldCatalog'
import { splitBucket, dimensionLabel } from './explainWidget'
import { fetchWidgetData, ApiError } from './builderApi'
import { WidgetCommentsPopover } from './WidgetCommentsPopover'
import { WidgetInsightPopover } from './WidgetInsightPopover'
import { resolveConditionalEffect, resolveTableCellEffect, resolveTableRowEffect } from './conditionalFormat'
import type { BlinkSpeed, ChartAnimationSpeed, ConditionalEffect, ConditionalRule, DataLabelContent, DataLabelFormat, FilterConfig, MatrixResult, SeriesMeta, TabRelation, TextFormat, PinnedInsight, WidgetConfig, WidgetDataPoint, WidgetDataResponse } from './types'

const PALETTE = ['#ffb000', '#3b82f6', '#10b981', '#7c3aed', '#22d3ee', '#f97316', '#ef4444', '#6366f1']

// Cor padrão dos rótulos de eixo. Antes eram dois hexadecimais fixos (#9ca3af e
// #6b7280) escolhidos olhando só o tema escuro: no claro ficavam lavados sobre o
// card branco, e o #6b7280 do eixo de medida chegava a ~3:1 de contraste NO
// PRÓPRIO tema escuro. Passando pelas variáveis de tema, os dois modos ganham a
// versão certa e o rótulo acompanha a troca de tema sem re-render — `var()` é
// resolvido pelo navegador direto no atributo `fill` do <text>.
// A categoria fica um passo mais clara que a medida: é o texto que se lê,
// enquanto os números do eixo são referência de fundo.
const AXIS_CATEGORY_FILL = 'rgb(var(--gray-500))'
const AXIS_VALUE_FILL = 'rgb(var(--gray-600))'

// ─── Formatação de texto (Título/Subtítulo, Eixo X/Y, Linhas/Colunas) ────

// Converte #rrggbb + opacidade (0-100) em rgba(...) — usado em todo lugar que
// aplica cor via CSS comum (style.color/backgroundColor), onde não existe um
// atributo de opacidade separado como o `fillOpacity` do SVG.
function hexToRgba(hex: string, opacityPct: number | undefined): string {
  if (opacityPct == null || opacityPct >= 100) return hex
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return hex
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(100, opacityPct)) / 100})`
}

// Estilo CSS simples (usado nas células <td>/<th> da Matriz e no
// título/subtítulo do widget, que já têm background/color nativos via CSS).
// Para eixos de gráfico (SVG <text>), ver makeAxisTick.
function textFormatStyle(fmt: TextFormat | undefined): React.CSSProperties {
  if (!fmt) return {}
  return {
    fontSize: fmt.fontSize,
    // Título/eixos/legenda/matriz nascem de classes Tailwind com line-height
    // FIXO em px (ex. `text-xs` = 12px de fonte / 16px de linha) — sobrescrever
    // só `fontSize` deixava esse line-height antigo valendo, pequeno demais
    // pro texto maior. Isso não aparecia como "texto espremido": o
    // `line-clamp-2` do título/subtítulo usa line-height × linhas pra decidir
    // quanto é visível, então o resultado era CORTAR a própria linha (ou a
    // segunda inteira) em vez de dar espaço a ela — reproduzido com título e
    // subtítulo em 24px (fontSize sozinho não bastava pra reproduzir; line-
    // height preso em 16px, sim). Só entra em ação quando `fontSize` é
    // customizado — sem customização, a classe base continua no controle.
    lineHeight: fmt.fontSize != null ? 1.3 : undefined,
    fontWeight: fmt.bold ? 700 : undefined,
    fontStyle: fmt.italic ? 'italic' : undefined,
    textDecoration: fmt.underline ? 'underline' : undefined,
    color: fmt.color ? hexToRgba(fmt.color, fmt.opacity) : undefined,
    backgroundColor: fmt.backgroundColor ? hexToRgba(fmt.backgroundColor, fmt.backgroundOpacity) : undefined,
    textAlign: fmt.align,
  }
}

// Tooltip único pra todos os gráficos. O padrão do Recharts é uma caixa branca
// de borda clara: passável no tema claro, um bloco estourado no escuro. Como
// tudo aqui é construído sobre as variáveis de tema, a mesma definição atende
// os dois sem precisar saber qual está ativo.
//
// `maxWidth` + `whiteSpace: normal` fazem um rótulo longo quebrar em linhas em
// vez de esticar a caixa pra fora do card — é aqui que o nome truncado no eixo
// aparece por inteiro.
const TOOLTIP_PROPS = {
  contentStyle: {
    backgroundColor: 'rgb(var(--app-card))',
    border: '1px solid rgb(var(--app-border))',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
    padding: '8px 10px',
    maxWidth: 260,
    whiteSpace: 'normal' as const,
  },
  labelStyle: {
    color: 'rgb(var(--gray-300))',
    fontSize: 11,
    fontWeight: 600,
    marginBottom: 4,
    whiteSpace: 'normal' as const,
  },
  itemStyle: { color: 'rgb(var(--gray-200))', fontSize: 11, padding: 0 },
}

// Rótulo de CATEGORIA no eixo vertical (barras horizontais), em uma linha só,
// truncado ao que cabe na largura reservada do eixo.
//
// Sem isso, um nome longo — "Cancelamento de contrato - Endereço com pendência
// - Justificativa: quando o endereço de ativação possui pendências..." — é
// quebrado pelo Recharts em várias linhas, que invadem o espaço do rótulo
// vizinho. Com meia dúzia de categorias assim o eixo vira um borrão ilegível,
// que é exatamente o que acontecia em "Top motivos de cancelamento".
//
// O texto completo não se perde: vai num <title>, que o navegador mostra ao
// passar o mouse. O rótulo truncado continua legível por si — a dica no hover
// complementa, não é a única forma de ler.
// Quantos caracteres cabem na faixa reservada. 0.58em por caractere é a média
// medida no pior caso desta base (nomes de plano em CAIXA ALTA, que são mais
// largos que a média de um texto normal) — com 0.55 o rótulo mais longo
// estourava a faixa em alguns pixels e encostava na borda do card.
function labelBudget(axisWidth: number, fontSize: number): number {
  return Math.max(6, Math.floor(axisWidth / (fontSize * 0.58)))
}

function truncEnd(s: string, budget: number): string {
  return s.length > budget ? `${s.slice(0, budget - 1).trimEnd()}…` : s
}

// Cortar sempre pelo fim resolve a colisão e cria outra: nesta base, quatro
// motivos começam com "Cancelamento de contrato - Cancelamento - " e viram o
// MESMO rótulo truncado. Quatro barras de tamanhos diferentes com o mesmo nome
// não identificam nada — trocamos ilegível por ambíguo.
//
// Então: quando um grupo de rótulos colide, a janela desliza até onde eles
// passam a divergir e o corte à esquerda vira reticência. Sai
// "…Endereço com pendência - Justi…", "…Desistência - Justificativa: Cl…",
// que é exatamente a parte que distingue um do outro. Como o corte é feito no
// primeiro caractere diferente do grupo, o resultado é único por construção.
function elideCategoryLabels(labels: string[], budget: number): Map<string, string> {
  const offsets = new Map<string, number>()

  // O que sobra do rótulo depois de descartar `offset` caracteres de prefixo
  // comum. Agrupa pelo que APARECERIA na tela — é essa string que colide, não
  // o texto cru (dois rótulos podem divergir no caractere que a reticência come).
  const show = (l: string, offset: number) =>
    offset > 0 ? `…${truncEnd(l.slice(offset).trimStart(), budget - 1)}` : truncEnd(l, budget)

  const groupBy = (group: string[], offset: number) => {
    const m = new Map<string, string[]>()
    for (const l of group) {
      const key = show(l, offset)
      const g = m.get(key)
      if (g) g.push(l); else m.set(key, [l])
    }
    return m
  }

  // Um nível de cada vez: um único corte não basta quando dois rótulos do grupo
  // compartilham MAIS prefixo que o grupo inteiro (aqui, dois "Endereço com
  // pendência" continuam iguais depois de cortar o "Cancelamento de contrato -
  // Cancelamento - " comum aos quatro). Cada nível avança o offset, então isso
  // sempre termina.
  const place = (group: string[], offset: number) => {
    if (group.length === 1) { offsets.set(group[0], offset); return }
    let skip = offset
    while (group.every((l) => l[skip] != null && l[skip] === group[0][skip])) skip++
    // Prefixo comum curto demais pra pagar o "…" na frente: o empate não se
    // resolve deslizando a janela. Fica o corte normal.
    if (skip - offset < 4) { for (const l of group) offsets.set(l, offset); return }
    for (const g of groupBy(group, skip).values()) place(g, skip)
  }

  const unique = [...new Set(labels)]
  for (const g of groupBy(unique, 0).values()) place(g, 0)

  const out = new Map<string, string>()
  for (const l of unique) out.set(l, show(l, offsets.get(l) ?? 0))

  // Cada grupo cortou o SEU prefixo comum, sem saber dos outros — e dois grupos
  // podem cair no mesmo texto ("Cancelamento de contrato - …" e "Contrato
  // Cancelado. …" ambos terminam em "Quando endereço de ativação possui…").
  // Nesses casos devolvemos o começo distintivo na frente: "Cancelamento…Quando
  // endereço…" contra "Contrato Can…Quando endereço…". É uma repescagem só; o
  // que sobrar depois dela é rótulo genuinamente quase-idêntico, e aí o hover
  // com o texto completo é o desempate.
  const byShown = new Map<string, string[]>()
  for (const [l, s] of out) {
    const g = byShown.get(s)
    if (g) g.push(l); else byShown.set(s, [l])
  }
  const HEAD = 12
  for (const group of byShown.values()) {
    if (group.length === 1) continue
    for (const l of group) {
      const offset = offsets.get(l) ?? 0
      if (offset === 0) continue
      const rest = truncEnd(l.slice(offset).trimStart(), budget - HEAD - 1)
      out.set(l, `${l.slice(0, HEAD).trimEnd()}…${rest}`)
    }
  }
  return out
}

function CategoryTick(props: any) {
  const { x, y, payload, display, fmt, fallbackFill, fallbackFontSize } = props
  const fontSize = fmt?.fontSize ?? fallbackFontSize
  const full = String(payload?.value ?? '')
  const shown = display.get(full) ?? full
  return (
    <text
      x={x}
      y={y}
      dy={fontSize / 3}
      textAnchor="end"
      fontSize={fontSize}
      fontWeight={fmt?.bold ? 700 : 400}
      fontStyle={fmt?.italic ? 'italic' : 'normal'}
      textDecoration={fmt?.underline ? 'underline' : 'none'}
      fill={fmt?.color ?? fallbackFill}
      fillOpacity={fmt?.color && fmt?.opacity != null ? fmt.opacity / 100 : undefined}
    >
      <title>{full}</title>
      {shown}
    </text>
  )
}

// Tick customizado do Eixo X/Y do Recharts — recebe x/y/payload/angle/textAnchor
// já calculados pelo eixo (inclusive quando o XAxis pede rotação, ex. -15°).
// Só desenha o <rect> de fundo quando `backgroundColor` está definido, já que
// SVG <text> não tem fundo nativo — nos demais casos é só texto estilizado.
function AxisTick(props: any) {
  const { x, y, payload, angle = 0, textAnchor = 'middle', fmt, fallbackFill, fallbackFontSize } = props
  const fontSize = fmt?.fontSize ?? fallbackFontSize
  const fill = fmt?.color ?? fallbackFill
  const fillOpacity = fmt?.color && fmt?.opacity != null ? fmt.opacity / 100 : undefined
  const fontWeight = fmt?.bold ? 700 : 400
  const fontStyle = fmt?.italic ? 'italic' : 'normal'
  const textDecoration = fmt?.underline ? 'underline' : 'none'
  const text = String(payload.value)
  const textProps = { fontSize, fontWeight, fontStyle, textDecoration, fill, fillOpacity }
  if (!fmt?.backgroundColor) {
    return (
      <text x={x} y={y} dy={4} textAnchor={textAnchor} transform={angle ? `rotate(${angle},${x},${y})` : undefined} {...textProps}>
        {text}
      </text>
    )
  }
  const paddingX = 4
  const w = text.length * fontSize * 0.62 + paddingX * 2
  const h = fontSize + 4
  const rectX = textAnchor === 'end' ? -w : textAnchor === 'start' ? 0 : -w / 2
  const textX = textAnchor === 'end' ? -paddingX : textAnchor === 'start' ? paddingX : 0
  const rectOpacity = fmt.backgroundOpacity != null ? fmt.backgroundOpacity / 100 : undefined
  return (
    <g transform={`translate(${x},${y})${angle ? ` rotate(${angle})` : ''}`}>
      <rect x={rectX} y={-h / 2 + 4} width={w} height={h} rx={2} fill={fmt.backgroundColor} fillOpacity={rectOpacity} />
      <text x={textX} y={4} textAnchor={textAnchor} {...textProps}>{text}</text>
    </g>
  )
}

// Sem backgroundColor, um objeto simples basta (Recharts aplica como atributos
// SVG do <text> padrão) — só vira componente customizado quando precisa do <rect>.
function makeAxisTick(fmt: TextFormat | undefined, fallbackFill: string, fallbackFontSize: number) {
  if (!fmt?.backgroundColor) {
    return {
      fill: fmt?.color ?? fallbackFill,
      fillOpacity: fmt?.color && fmt?.opacity != null ? fmt.opacity / 100 : undefined,
      fontSize: fmt?.fontSize ?? fallbackFontSize,
      fontWeight: fmt?.bold ? 700 : 400,
      fontStyle: fmt?.italic ? 'italic' : 'normal',
      textDecoration: fmt?.underline ? 'underline' : 'none',
    }
  }
  return (props: any) => <AxisTick {...props} fmt={fmt} fallbackFill={fallbackFill} fallbackFontSize={fallbackFontSize} />
}

// Recharts calcula a área reservada pro eixo assumindo o tamanho de fonte
// padrão (não sabe medir nosso tick customizado) — sem isso, aumentar a fonte
// (ainda mais com fundo, que desenha um <rect> maior que o próprio texto) faz
// o rótulo vazar pra fora da área do gráfico e ficar cortado/saindo do card.
// `mult` pesa mais em eixos rotacionados (o rótulo cresce na diagonal).
// `fmt.margin` é o ajuste manual (Formato → Eixo X/Eixo Y → "Recuo") — soma
// direto por cima do cálculo automático, pra cobrir os casos que o cálculo
// não prevê (ex. números grandes que ainda cortam mesmo na fonte padrão).
function tickExtra(fmt: TextFormat | undefined, fallbackFontSize: number, mult = 1): number {
  const fs = fmt?.fontSize ?? fallbackFontSize
  const bg = fmt?.backgroundColor ? 6 : 0
  return Math.max(0, fs - fallbackFontSize) * mult + bg + (fmt?.margin ?? 0)
}

// `base + tickExtra(...)`, nunca menor que `min` — protege contra um recuo
// manual bem negativo colapsar a área do eixo a ponto do gráfico quebrar.
function axisSize(base: number, fmt: TextFormat | undefined, fallbackFontSize: number, mult = 1, min = 16): number {
  return Math.max(min, base + tickExtra(fmt, fallbackFontSize, mult))
}

// ─── Rótulos de dados sobre o gráfico ─────────────────────────────────────

function formatLabelValue(v: number) {
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}
function labelText(content: DataLabelContent | undefined, value: number, name: string, percent: number) {
  switch (content) {
    case 'name': return name
    case 'percent': return `${percent.toFixed(1)}%`
    case 'valueAndName': return `${name}: ${formatLabelValue(value)}`
    case 'all': return `${name}: ${formatLabelValue(value)} (${percent.toFixed(1)}%)`
    default: return formatLabelValue(value)
  }
}
function sumSeries(points: WidgetDataPoint[], key: string) {
  return points.reduce((sum, p) => sum + (Number((p as unknown as Record<string, unknown>)[key] ?? p.value) || 0), 0) || 1
}

// Barras verticais (bar/barStacked/comboBarLine) — LabelList `content` recebe
// x/y/width/height/value/index já calculados pelo Recharts para aquele
// segmento; a posição escolhida decide se o texto vai por dentro/no topo/fora.
// `fillOpacity` é um atributo SVG separado do `fill` — não precisa converter
// pra rgba aqui (diferente do textFormatStyle, que escreve CSS comum).
function labelFillProps(dl: DataLabelFormat, defaultFill: string) {
  return { fill: dl.color ?? defaultFill, fillOpacity: dl.color && dl.opacity != null ? dl.opacity / 100 : undefined }
}

// `.animate-pulse` (Tailwind: `pulse 2s cubic-bezier(...) infinite`) começa
// do zero sempre que o ELEMENTO monta — a barra (<Cell>) e o rótulo (<text>
// de um LabelList) são desenhados por caminhos internos separados do
// Recharts, e nem sempre montam no mesmíssimo instante; cada um cai na
// própria fase, piscando fora de sincronia (relatado pelo usuário). Em vez
// de depender de montarem juntos, ancora o delay num relógio ABSOLUTO — o
// ciclo de 2s mais próximo desde a época Unix — pra qualquer elemento, não
// importa quando montou de verdade, cair sempre na mesma fase que qualquer
// outro com este mesmo delay.
// Velocidade do piscar (ver BlinkSpeed, types.ts) — cada uma é o próprio
// período do ciclo, tanto pro `animationDuration` quanto pro relógio
// ABSOLUTO do delay de sincronia acima (mudar a duração sem mudar a base do
// delay dessincronizaria de novo). 'normal' = 2000ms, o `animate-pulse` de
// sempre, igual a antes deste campo existir.
const BLINK_SPEED_MS: Record<BlinkSpeed, number> = { slower: 4000, slow: 3000, normal: 2000, fast: 1000, faster: 500 }
function pulseSyncStyle(speed?: BlinkSpeed): React.CSSProperties {
  const ms = BLINK_SPEED_MS[speed ?? 'normal']
  return { animationDelay: `${-(Date.now() % ms)}ms`, animationDuration: `${ms}ms` }
}

// "Gráfico dinâmico" (WidgetConfig.dynamicAnimation) — o gráfico inteiro se
// desenha do zero até o valor e reinicia em loop, sem o dado mudar. Um
// ciclo mais longo que o do piscar (que só desbota opacidade) porque aqui
// é o desenho INTEIRO do gráfico — precisa dar tempo de acompanhar visualmente.
const CHART_ANIM_MS: Record<ChartAnimationSpeed, number> = { slower: 6000, slow: 4000, normal: 2500, fast: 1500, faster: 800 }
// Incrementa um contador a cada ciclo — usado como parte da `key` de cada
// série animada (Line/Area/Pie/Funnel/Scatter/Bar) pra forçar o Recharts a
// REMONTAR e tocar a animação de entrada de novo (mudar só `animationId`
// não bastaria: o Bar/Line/Pie interpolam do estado ANTERIOR pro atual — se
// o dado não mudou, os dois são iguais e não haveria nada visível pra
// animar; só um remonte de verdade zera essa memória e faz o "desenhar do
// zero" acontecer de novo). Roda só enquanto `enabled`; desligado, o
// contador para (e volta pro `key` estável de sempre nos pontos de uso).
function useAnimationCycle(enabled: boolean | undefined, speed: ChartAnimationSpeed | undefined): number {
  const [cycle, setCycle] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const ms = CHART_ANIM_MS[speed ?? 'normal']
    const id = setInterval(() => setCycle((c) => c + 1), ms)
    return () => clearInterval(id)
  }, [enabled, speed])
  return cycle
}

// `conditionalRules`: o rótulo pode seguir a MESMA regra que colore a barra
// (ver conditionalCells, chamado ao lado deste em cada <Bar>) — sem isso, a
// barra piscava/mudava de cor conforme a meta batia, mas o número do lado
// continuava na cor/estado padrão, como se a regra não tivesse alcançado ali
// (relatado pelo usuário com print: 3 barras vermelhas piscando, números do
// lado continuando brancos parados). `effect.applyTo` decide se isso vale
// aqui: 'bar' = só a barra muda (rótulo fica no padrão de sempre — pula pra
// fora deste bloco), 'label'/'both' (padrão quando ausente) = o rótulo
// também muda, vencendo a cor manual (`dl.color`) com a mesma prioridade que
// já vale pra cor da barra.
function barLabelContent(dl: DataLabelFormat, points: WidgetDataPoint[], key: string, vertical: boolean, conditionalRules?: ConditionalRule[]) {
  const total = sumSeries(points, key)
  const fontSize = dl.fontSize ?? 10
  return (props: any) => {
    const { x, y, width, height, value, index } = props
    if (value == null || value === '') return null
    const name = points[index]?.label ?? ''
    const text = labelText(dl.content, Number(value), name, (Number(value) / total) * 100)
    let cx: number, cy: number
    let anchor: 'middle' | 'start' | 'end' = 'middle'
    if (vertical) {
      cx = x + width / 2
      cy = dl.position === 'inside' || dl.position === 'center' ? y + height / 2 + 4 : y - 4
    } else {
      cy = y + height / 2 + 4
      if (dl.position === 'inside') { cx = x + width - 4; anchor = 'end' }
      else if (dl.position === 'center') { cx = x + width / 2 }
      else { cx = x + width + 4; anchor = 'start' } // 'top'/'outside' — fora, à direita
    }
    const rawEffect = resolveConditionalEffect(Number(value), conditionalRules)
    const effect = rawEffect && (rawEffect.applyTo ?? 'both') !== 'bar' ? rawEffect : undefined
    const fillProps = effect?.backgroundColor ? { fill: effect.backgroundColor } : labelFillProps(dl, AXIS_CATEGORY_FILL)
    return (
      <text
        x={cx} y={cy} textAnchor={anchor} fontSize={fontSize}
        className={effect?.blink ? 'animate-pulse' : undefined}
        style={effect?.blink ? pulseSyncStyle(effect.blinkSpeed) : undefined}
        {...fillProps}
      >
        {text}
      </text>
    )
  }
}

// Rótulo ÚNICO por categoria numa barra empilhada (barStacked/barHStacked) —
// soma todos os segmentos em vez de um rótulo por segmento, que se sobrepõe/
// quebra com muitas séries empilhadas (ver HISTORICO_ALTERACOES.md). Anexado
// só à ÚLTIMA série do `series.map()` — em Recharts, a última série declarada
// é o segmento do TOPO da pilha (as anteriores empilham por baixo dela), e é
// exatamente esse segmento que dá x/y/width/height do topo pra posicionar o
// texto. O `value`/`dataKey` que o Recharts entrega aqui é só dessa última
// série — por isso o total é recalculado direto de `points`, somando todas
// as chaves em `seriesKeys`, em vez de usar o `value` recebido.
function stackTotalLabelContent(dl: DataLabelFormat, points: WidgetDataPoint[], seriesKeys: SeriesMeta[], vertical: boolean) {
  const fontSize = dl.fontSize ?? 10
  return (props: any) => {
    const { x, y, width, height, index } = props
    const point = points[index] as unknown as Record<string, unknown> | undefined
    if (!point) return null
    const total = seriesKeys.reduce((sum, s) => sum + (Number(point[s.key]) || 0), 0)
    if (total === 0) return null
    const text = labelText(dl.content, total, String(point.label ?? ''), 100)
    // Sempre "fora"/acima do topo da pilha — "dentro"/"centro" não tem um
    // segmento real pra pousar em cima, já que é a soma de todos.
    return vertical
      ? <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={fontSize} {...labelFillProps(dl, AXIS_CATEGORY_FILL)}>{text}</text>
      : <text x={x + width + 4} y={y + height / 2 + 4} textAnchor="start" fontSize={fontSize} {...labelFillProps(dl, AXIS_CATEGORY_FILL)}>{text}</text>
  }
}

// Pontos de linha/área/dispersão — não têm "dentro"/"fora" real; dentro/centro
// pousa o texto sobre o ponto, os demais ficam acima.
function pointLabelContent(dl: DataLabelFormat, points: WidgetDataPoint[], key: string) {
  const total = sumSeries(points, key)
  const fontSize = dl.fontSize ?? 10
  return (props: any) => {
    const { x, y, value, index } = props
    if (value == null || value === '') return null
    const name = points[index]?.label ?? ''
    const text = labelText(dl.content, Number(value), name, (Number(value) / total) * 100)
    const dy = dl.position === 'inside' || dl.position === 'center' ? 4 : -8
    return <text x={x} y={y + dy} textAnchor="middle" fontSize={fontSize} {...labelFillProps(dl, AXIS_CATEGORY_FILL)}>{text}</text>
  }
}

const RADIAN = Math.PI / 180
// Pie usa seu próprio callback `label`, que já entrega cx/cy/midAngle/raios —
// posiciona o texto num raio intermediário (dentro/centro) ou além da borda
// externa (fora/em cima), com cor clara sobre a fatia quando fica por dentro
// (a menos que o usuário tenha escolhido uma cor explícita).
function pieLabelRenderer(dl: DataLabelFormat) {
  return (props: any) => {
    const { cx, cy, midAngle, innerRadius, outerRadius, percent, name, value } = props
    const inside = dl.position === 'inside' || dl.position === 'center'
    const radius = inside ? innerRadius + (outerRadius - innerRadius) * 0.55 : outerRadius + 16
    const x = cx + radius * Math.cos(-midAngle * RADIAN)
    const y = cy + radius * Math.sin(-midAngle * RADIAN)
    const text = labelText(dl.content, value, name, (percent ?? 0) * 100)
    return (
      <text x={x} y={y} {...labelFillProps(dl, inside ? '#fff' : AXIS_CATEGORY_FILL)} fontSize={dl.fontSize ?? 10} textAnchor={x > cx ? 'start' : x < cx ? 'end' : 'middle'} dominantBaseline="central">
        {text}
      </text>
    )
  }
}

// Funil — mesma lógica de posição da barra horizontal (cada estágio é uma
// faixa x/y/width/height), calculando % sobre o valor do primeiro estágio.
function funnelLabelContent(dl: DataLabelFormat, points: WidgetDataPoint[]) {
  const total = points[0]?.value || 1
  const fontSize = dl.fontSize ?? 10
  return (props: any) => {
    const { x, y, width, height, value, index } = props
    if (value == null || value === '') return null
    const name = points[index]?.label ?? ''
    const text = labelText(dl.content, Number(value), name, (Number(value) / total) * 100)
    const cy = y + height / 2 + 4
    if (dl.position === 'inside' || dl.position === 'center') {
      return <text x={x + width / 2} y={cy} textAnchor="middle" fontSize={fontSize} {...labelFillProps(dl, '#fff')}>{text}</text>
    }
    return <text x={x + width + 8} y={cy} textAnchor="start" fontSize={fontSize} {...labelFillProps(dl, AXIS_CATEGORY_FILL)}>{text}</text>
  }
}

// Rótulo de dados por série (MeasureConfig.dataLabels, ver types.ts) — cada
// medida/linha pode ligar/desligar e estilizar seu próprio rótulo; quando não
// define nada, cai no padrão do widget inteiro (dataLabels da aba Formato).
// Só faz sentido pra bar/barH/barStacked/barHStacked/comboBarLine/line/area
// (as únicas com múltiplas medidas editáveis) — nas demais, `s.dataLabels`
// nunca vem preenchido, então isto sempre cai no comportamento de sempre.
function resolveSeriesDataLabel(seriesOverride: DataLabelFormat | undefined, widgetLevel: DataLabelFormat | undefined): DataLabelFormat | undefined {
  const show = seriesOverride?.show ?? widgetLevel?.show
  if (!show) return undefined
  return { ...widgetLevel, ...seriesOverride, show: true }
}

interface WidgetRendererProps {
  widget: WidgetConfig
  tabFilters: { filter: FilterConfig; values: string[] }[]
  relations: TabRelation[]
  editMode: boolean
  // Incrementado pelo timer de atualização automática da aba (Configurações
  // de tela) — não entra na query em si, só força o efeito de busca a rodar
  // de novo (mesmo widget/filtros, dado mais recente do snapshot).
  refreshKey?: number
  onEdit?: () => void
  onRemove?: () => void
  onDuplicate?: () => void
  // Arrasto de largura de coluna (só type 'table', só em editMode) — ver
  // TableBody. Reporta o mapa completo de larguras a cada solto de coluna;
  // quem usa isso (DashboardBuilder) grava direto em tableFormat.columnWidths.
  onColumnWidthsChange?: (widths: Record<string, number>) => void
  // Fixar/remover a leitura da IA deste gráfico (ver WidgetInsightPopover) —
  // como o arrasto de coluna acima, o widget pede e o DashboardBuilder grava.
  onPinInsight?: (insight: PinnedInsight | undefined) => void
}

function ChartFrame({ widget, tabFilters, relations, dataShape, editMode, onEdit, onRemove, onDuplicate, onPinInsight, cardEffect, children }: {
  widget: WidgetConfig; editMode: boolean; onEdit?: () => void; onRemove?: () => void; onDuplicate?: () => void
  tabFilters: { filter: FilterConfig; values: string[] }[]
  relations: TabRelation[]
  // Recorte do resultado que serve de impressão digital pra saber se uma
  // leitura fixada envelheceu. Deliberadamente SEM as linhas paginadas da
  // tabela: virar a página não muda o dado, e marcaria a leitura como
  // desatualizada à toa.
  dataShape: unknown
  onPinInsight?: (insight: PinnedInsight | undefined) => void
  // Efeito já avaliado pelo motor de formatação condicional (ver
  // conditionalFormat.ts) contra o valor do KPI — ausente pros demais tipos
  // de widget (a coloração condicional deles é por barra/célula, não pelo
  // card inteiro, ver PointsChart/MatrixBody).
  cardEffect?: ConditionalEffect
  children: React.ReactNode
}) {
  // Cor de fundo: a do efeito condicional (dinâmica, vence) ou a fixa do
  // widget (Aparência do widget) — nunca as duas juntas.
  const bgColor = cardEffect?.backgroundColor ?? widget.backgroundColor
  const cardStyle: React.CSSProperties = {}
  if (bgColor) cardStyle.backgroundColor = cardEffect?.backgroundColor ?? hexToRgba(widget.backgroundColor!, widget.backgroundOpacity)
  // Sombra/brilho/piscar estáticos (Formato → Aparência do widget) OU do
  // efeito condicional (que tem prioridade quando bate). Uma regra
  // condicional não tem cor própria pra cada efeito (ConditionalEffect só
  // tem `backgroundColor`) — nesses casos o comportamento de sempre continua
  // valendo (brilho usa o fundo ativo, sombra/piscar são neutros). Os
  // estáticos ganharam cor própria (shadowColor/glowColor/blinkColor) porque
  // um seletor só pros três juntos não dava pra expressar, por exemplo,
  // "sombra cinza padrão mas brilho azul" — sem cor escolhida (widget salvo
  // antes dessa mudança), cada um cai no próprio padrão de sempre.
  const glowOn = cardEffect?.glow ?? widget.glow
  if (glowOn) {
    const glowTint = cardEffect?.glow ? bgColor : (widget.glowColor ?? bgColor)
    cardStyle.boxShadow = `0 0 22px ${hexToRgba(glowTint ?? '#ffb000', 55)}`
  } else if (widget.shadow) {
    cardStyle.boxShadow = widget.shadowColor ? `0 12px 32px -8px ${hexToRgba(widget.shadowColor, 45)}` : '0 12px 32px -8px rgba(0,0,0,0.35)'
  }
  const blinkOn = cardEffect?.blink ?? widget.blink
  // Piscar com cor: em vez do `animate-pulse` genérico (só desbota a
  // opacidade do card inteiro, sem cor nenhuma), um anel que cresce/some ao
  // redor do card na cor escolhida — mais visível e realmente "com a cor
  // certa". Só entra quando é o toggle ESTÁTICO com cor definida; uma regra
  // condicional (sem campo de cor) continua no `animate-pulse` de sempre.
  const blinkColored = blinkOn && !cardEffect?.blink && !!widget.blinkColor
  if (blinkColored) (cardStyle as Record<string, string>)['--blink-color'] = hexToRgba(widget.blinkColor!, 70)
  // Velocidade do piscar (ver BlinkSpeed) só existe na regra condicional —
  // o toggle estático (Aparência do widget) não tem esse campo, continua na
  // duração de sempre.
  if (cardEffect?.blink) Object.assign(cardStyle, pulseSyncStyle(cardEffect.blinkSpeed))
  // Ícone sem cor customizada usa a cor padrão via classe (text-gray-500);
  // com cor customizada, sobrepõe via style (a classe continua definindo o
  // hover, já que style inline não afeta pseudo-classes).
  const iconStyle: React.CSSProperties | undefined = widget.iconColor ? { color: widget.iconColor } : undefined
  return (
    <div
      className={cn(
        'h-full flex flex-col border border-app-border rounded-2xl shadow-card overflow-hidden transition-colors',
        !bgColor && 'bg-app-card',
        blinkOn && (blinkColored ? 'animate-blink-color' : 'animate-pulse'),
      )}
      style={cardStyle}
    >
      {/* `group` serve ao cabeçalho: em modo edição os ícones de LEITURA
          (leitura da IA, comentários) só aparecem no hover. São cinco ícones
          somados aos três de edição, e num card estreito — um KPI — sobravam
          40px pro título, que virava "Total ...". Enquanto se arrasta e
          redimensiona, ler não é o que se está fazendo; fora do modo edição os
          dois voltam a ficar sempre visíveis, que é quando importam. */}
      <div className="group flex items-center justify-between px-4 pt-3 pb-2 border-b border-app-border shrink-0">
        {/* `flex-1`: sem crescer pra preencher a largura disponível, o texto
            fica sempre colado ao próprio conteúdo (a caixa do <p> nunca sobra
            espaço) e `text-align: center/right` (titleFormat.align) não tem
            efeito nenhum — teria que centralizar/alinhar dentro de uma caixa
            do tamanho do próprio texto. */}
        <div className="min-w-0 flex-1">
          {/* `truncate` (uma linha só) cortava o título com reticências assim
              que a fonte crescia — `titleFormat.fontSize` sempre foi
              ajustável (editor manual, e agora a IA também — ver
              HISTORICO_ALTERACOES.md 26/08/2026), então isso não era caso
              raro. `line-clamp-2` deixa quebrar até 2 linhas antes de
              truncar; o cabeçalho é `shrink-0` (ver container do card
              abaixo), então cresce sozinho pra acomodar — quem perde o
              espaço que sobra é o corpo do widget (`flex-1 min-h-0`), não o
              título. */}
          <p className="text-xs font-semibold text-gray-100 line-clamp-2 break-words" style={textFormatStyle(widget.titleFormat)}>{widget.title}</p>
          {widget.subtitle && <p className="text-[10px] text-gray-500 line-clamp-2 break-words" style={textFormatStyle(widget.subtitleFormat)}>{widget.subtitle}</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* `w-0 overflow-hidden` em vez de `hidden`/`opacity-0`: opacidade
              zero continuaria ocupando a largura (que é justamente o que falta),
              e `display:none` tiraria os botões da ordem de tabulação. Clipados,
              eles somem do layout mas seguem alcançáveis pelo teclado — daí o
              `focus-within`. */}
          <div className={cn('flex items-center gap-1', editMode && 'w-0 overflow-hidden transition-[width] focus-within:w-auto group-hover:w-auto')}>
            <WidgetInsightPopover
              widget={widget} tabFilters={tabFilters} relations={relations} points={dataShape} editMode={editMode} onPin={onPinInsight}
              iconStyle={iconStyle} iconClassName={!widget.iconColor ? 'text-gray-500' : undefined}
            />
            <WidgetCommentsPopover widgetId={widget.id} iconStyle={iconStyle} iconClassName={!widget.iconColor ? 'text-gray-500' : undefined} />
          </div>
          {editMode && (
            <>
              <button onClick={onEdit} style={iconStyle} className={cn('h-6 w-6 flex items-center justify-center rounded-md hover:text-brand-blue hover:bg-brand-blue/10', !widget.iconColor && 'text-gray-500')} title="Editar widget"><Pencil size={11} /></button>
              <button onClick={onDuplicate} style={iconStyle} className={cn('h-6 w-6 flex items-center justify-center rounded-md hover:text-brand-blue hover:bg-brand-blue/10', !widget.iconColor && 'text-gray-500')} title="Duplicar widget"><Copy size={11} /></button>
              <button onClick={onRemove} style={iconStyle} className={cn('h-6 w-6 flex items-center justify-center rounded-md hover:text-risk-critical hover:bg-risk-critical/10', !widget.iconColor && 'text-gray-500')} title="Remover widget"><Trash2 size={11} /></button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 p-2 overflow-hidden">{children}</div>
    </div>
  )
}

function KpiBody({ value, color, target, align }: { value: number; color?: string; target?: number; align?: 'left' | 'center' | 'right' }) {
  const formatted = Number.isInteger(value) ? value.toLocaleString('pt-BR') : value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  // O valor (+ a meta, se houver) é alinhado como GRUPO, não cada `<span>`
  // isolado — "centralizar" um card com meta significa centralizar o par
  // "5.326  meta: 100" junto, não jogar cada pedaço pra um canto diferente.
  const justify = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'
  return (
    <div className="h-full flex items-center gap-2 px-3" style={{ justifyContent: justify }}>
      <span className={cn('text-2xl font-semibold tabular-nums tracking-tight', !color && 'text-white')} style={color ? { color } : undefined}>
        {formatted}
      </span>
      {target != null && (
        <span className="text-[10px] text-gray-400">
          meta: {Number.isInteger(target) ? target.toLocaleString('pt-BR') : target.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}
        </span>
      )}
    </div>
  )
}

// Uma série por medida (widget.measures) ou por valor de legenda
// (widget.legendDimension); sem nenhuma das duas, uma única série "value".
// `palette` é a sequência de cores do widget (ver WidgetConfig.palette,
// preenchida ao aplicar um tema) — ausente/vazia = paleta padrão do app.
function resolveSeries(seriesKeys: SeriesMeta[] | undefined, fallbackColor?: string, palette?: string[]): SeriesMeta[] {
  const pal = palette?.length ? palette : PALETTE
  if (seriesKeys?.length) {
    // "Cor principal" (Formato) só faz sentido quando há uma única série de
    // coluna pra colorir — com legenda/múltiplas medidas cada série precisa
    // da sua própria cor (senão tudo vira uma cor só); a série de linha do
    // combo também nunca usa a cor principal (senão coincidiria com a barra).
    const barLikeCount = seriesKeys.filter((s) => s.role !== 'line').length
    return seriesKeys.map((s, i) => ({
      ...s,
      color: s.color ?? (barLikeCount === 1 && s.role !== 'line' ? fallbackColor : undefined) ?? pal[i % pal.length],
    }))
  }
  return [{ key: 'value', label: 'Valor', color: fallbackColor ?? pal[0] }]
}

// `gridLines` (padrão 'both' quando ausente) controla as linhas pontilhadas
// de fundo — Recharts já suporta desligar cada direção via prop própria.
function gridProps(gridLines: WidgetConfig['gridLines']) {
  return { horizontal: gridLines !== 'vertical' && gridLines !== 'none', vertical: gridLines !== 'horizontal' && gridLines !== 'none' }
}

function legendWrapperStyle(fmt: TextFormat | undefined): React.CSSProperties {
  return { ...textFormatStyle(fmt), fontSize: fmt?.fontSize ?? 10 }
}

// O Recharts colore cada texto da legenda com a MESMA cor do próprio swatch
// (série), sempre — `wrapperStyle.color` (legendWrapperStyle acima) só afeta
// o <div> que envolve a legenda, nunca o texto de cada item, já que o
// DefaultLegendContent aplica `style={{ color: entry.color }}` direto no
// <span>, sobrepondo qualquer cor herdada. Pra realmente forçar uma cor de
// texto (ex. branco no tema "Alto contraste"), é preciso o `formatter`, que
// troca o conteúdo renderizado de cada item por um <span> com cor explícita.
function legendTextFormatter(fmt: TextFormat | undefined) {
  if (!fmt?.color) return undefined
  const color = hexToRgba(fmt.color, fmt.opacity)
  return (value: React.ReactNode) => <span style={{ color }}>{value}</span>
}

// Atraso/duração do crescimento de UMA barra dentro do ciclo do "Gráfico
// dinâmico" (ver useAnimationCycle acima) — cada barra ganha sua própria
// fatia do ciclo total, na ordem em que aparece (esquerda → direita), e fica
// "crescida" (fill-mode: both) até a próxima remontagem. `horizontal` decide
// o eixo do crescimento: barra vertical cresce em Y (de baixo pra cima),
// barra horizontal cresce em X (da esquerda pro fim da barra).
interface BarGrowAnim { perBarMs: number; horizontal: boolean }

// Uma <Cell> por ponto — cor condicional (ver conditionalFormat.ts) e/ou
// crescimento escalonado do "Gráfico dinâmico" (`growAnim`). Sem os dois,
// `null` (deixa o <Bar fill={s.color}> normal cuidar de tudo). Cada barra
// vira independente da série quanto à cor, estilo Power BI.
function conditionalCells(points: WidgetDataPoint[], dataKey: string, rules: ConditionalRule[] | undefined, fallbackColor: string, growAnim?: BarGrowAnim) {
  if (!rules?.length && !growAnim) return null
  return points.map((p, i) => {
    const raw = (p as unknown as Record<string, unknown>)[dataKey] ?? p.value
    const rawEffect = resolveConditionalEffect(Number(raw), rules)
    // `applyTo === 'label'`: esta regra é só pro rótulo (ver barLabelContent)
    // — a barra em si fica na cor de sempre, sem piscar.
    const effect = rawEffect && (rawEffect.applyTo ?? 'both') !== 'label' ? rawEffect : undefined
    if (!growAnim) {
      // Caminho de sempre — sem Gráfico dinâmico, nada mudou aqui.
      return (
        <Cell
          key={i}
          fill={effect?.backgroundColor ?? fallbackColor}
          className={effect?.blink ? 'animate-pulse' : undefined}
          style={effect?.blink ? pulseSyncStyle(effect.blinkSpeed) : undefined}
        />
      )
    }
    // Com Gráfico dinâmico: o crescimento é um `@keyframes` PRÓPRIO
    // (chartBarGrowV/H, globals.css), não a classe `.animate-pulse` do
    // Tailwind — se a MESMA barra também pisca por regra, as duas animações
    // têm que ir juntas na property `animation` (uma string só, separada por
    // vírgula): combinar duas classes que cada uma define `animation`
    // inteira por si (shorthand) pisaria uma por cima da outra, e só UMA
    // delas realmente animaria. `transform-box:fill-box` faz o
    // `transform-origin` usar a caixa do próprio retângulo (não do SVG
    // inteiro) — sem isso a barra cresceria a partir do canto do gráfico.
    const growName = growAnim.horizontal ? 'chartBarGrowH' : 'chartBarGrowV'
    const layers = [`${growName} ${growAnim.perBarMs}ms ease-out ${i * growAnim.perBarMs}ms both`]
    if (effect?.blink) {
      const ms = BLINK_SPEED_MS[effect.blinkSpeed ?? 'normal']
      layers.push(`pulse ${ms}ms cubic-bezier(0.4,0,0.6,1) ${-(Date.now() % ms)}ms infinite`)
    }
    return (
      <Cell
        key={i}
        fill={effect?.backgroundColor ?? fallbackColor}
        style={{ animation: layers.join(', '), transformBox: 'fill-box', transformOrigin: growAnim.horizontal ? 'left' : 'bottom' } as React.CSSProperties}
      />
    )
  })
}

const TARGET_LINE_COLOR = '#ef4444'
function targetLineLabel(target: number) {
  return `Meta: ${target.toLocaleString('pt-BR')}`
}

function PointsChart({ type, points, color, seriesKeys, axisXFormat, axisYFormat, dataLabels, seriesOpacity, gridLines, gridLinesColor, gridLinesOpacity, legendFormat, palette, target, targetLineColor, targetLineOpacity, conditionalRules, dynamicAnimation, dynamicAnimationSpeed }: {
  type: WidgetConfig['type']; points: WidgetDataPoint[]; color?: string; seriesKeys?: SeriesMeta[]
  axisXFormat?: TextFormat; axisYFormat?: TextFormat; dataLabels?: DataLabelFormat; seriesOpacity?: number
  gridLines?: WidgetConfig['gridLines']; gridLinesColor?: string; gridLinesOpacity?: number
  legendFormat?: TextFormat; palette?: string[]
  target?: number; targetLineColor?: string; targetLineOpacity?: number; conditionalRules?: ConditionalRule[]
  dynamicAnimation?: boolean; dynamicAnimationSpeed?: ChartAnimationSpeed
}) {
  const pal = palette?.length ? palette : PALETTE
  const series = resolveSeries(seriesKeys, color, palette)
  const showLegend = series.length > 1
  const dl = dataLabels?.show ? dataLabels : undefined
  // undefined = deixa o Recharts usar o próprio padrão (1 pra colunas/pizza/
  // funil/dispersão, 0.2 pra área — por isso a área multiplica em vez de
  // substituir, senão perderia o efeito de "preenchimento leve" por padrão).
  const opacity = seriesOpacity != null ? seriesOpacity / 100 : undefined
  const grid = gridProps(gridLines)
  // Sem `gridLinesColor`, mantém a cor neutra do tema (`--app-border`) de
  // sempre — só troca pra cor fixa quando o usuário escolhe uma.
  const gridStroke = gridLinesColor ? hexToRgba(gridLinesColor, gridLinesOpacity) : 'rgb(var(--app-border))'
  // Mesma ideia pra linha de meta — sem `targetLineColor`, mantém o vermelho
  // padrão de sempre (TARGET_LINE_COLOR).
  const targetStroke = targetLineColor ? hexToRgba(targetLineColor, targetLineOpacity) : TARGET_LINE_COLOR
  const legendStyle = legendWrapperStyle(legendFormat)
  const legendFormatter = legendTextFormatter(legendFormat)
  // "Gráfico dinâmico" — chamado incondicionalmente (regra dos hooks), mesmo
  // nos tipos sem a opção (a seção some no editor pra esses, então
  // `dynamicAnimation` já chega `undefined`/`false` e o hook fica inerte).
  const animCycle = useAnimationCycle(dynamicAnimation, dynamicAnimationSpeed)
  const drawMs = CHART_ANIM_MS[dynamicAnimationSpeed ?? 'normal']
  // Chave de cada série animada: só incorpora o ciclo quando ligado — desligado,
  // fica estável (`s.key` puro), sem remontar à toa. Precisa mudar de VERDADE
  // a cada ciclo pra zerar a memória de "estado anterior" que Line/Area/Bar/
  // Pie/Funil/Scatter usam pra interpolar (ver useAnimationCycle acima).
  const animKey = (key: string) => (dynamicAnimation ? `${key}-${animCycle}` : key)
  // Line/Area/Pie/Funil/Scatter já têm animação de entrada NATIVA do Recharts
  // (desenha a linha, varre a pizza, etc.) — só falta ela REPETIR; remontar
  // via `animKey` já faz isso tocar de novo, então só precisa ficar ativa e
  // com a duração escolhida. Bar é diferente (ver conditionalCells/growAnim
  // abaixo) — a Recharts cresce TODAS as barras juntas, não uma de cada vez.
  const nativeAnimProps = dynamicAnimation ? { isAnimationActive: true, animationDuration: drawMs, animationEasing: 'linear' as const } : {}
  if (type === 'pie') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            key={animKey('pie')}
            data={points} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="75%" paddingAngle={2}
            label={dl ? pieLabelRenderer(dl) : undefined} labelLine={!!dl}
            {...nativeAnimProps}
          >
            {points.map((_, i) => <Cell key={i} fill={pal[i % pal.length]} fillOpacity={opacity} />)}
          </Pie>
          <Tooltip {...TOOLTIP_PROPS} />
          <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
        </PieChart>
      </ResponsiveContainer>
    )
  }
  if (type === 'barH' || type === 'barHStacked') {
    const stacked = type === 'barHStacked'
    // Aqui os papéis dos eixos se invertem visualmente: XAxis (embaixo) é a
    // medida (axisYFormat), YAxis (esquerda) é a categoria (axisXFormat).
    // A faixa da categoria cresce com o rótulo mais longo, entre 96 e 176px:
    // "Sul" não precisa de 120px, e um motivo de cancelamento escrito por
    // extenso não cabe neles. O teto existe pra faixa nunca comer a barra —
    // passando dele, o CategoryTick trunca com reticência (texto inteiro no hover).
    const catLabels = points.map((p: any) => String(p?.label ?? ''))
    const longestLabel = catLabels.reduce((m: number, l: string) => Math.max(m, l.length), 0)
    const catWidth = axisSize(Math.min(176, Math.max(96, Math.round(longestLabel * 9 * 0.55) + 10)), axisXFormat, 9, 3)
    const catDisplay = elideCategoryLabels(catLabels, labelBudget(catWidth - 12, axisXFormat?.fontSize ?? 9))
    const valHeight = axisSize(24, axisYFormat, 10, 2)
    // Horizontal: cresce em X, da esquerda (eixo) até o fim da barra.
    const growAnim = dynamicAnimation ? { perBarMs: drawMs / Math.max(1, points.length), horizontal: true } : undefined
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} {...grid} />}
          <XAxis type="number" height={valHeight} tick={makeAxisTick(axisYFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="label"
            tick={(props: any) => <CategoryTick {...props} display={catDisplay} fmt={axisXFormat} fallbackFill={AXIS_CATEGORY_FILL} fallbackFontSize={9} />}
            axisLine={false}
            tickLine={false}
            width={catWidth}
          />
          <Tooltip {...TOOLTIP_PROPS} />
          {showLegend && <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />}
          {target != null && <ReferenceLine x={target} stroke={targetStroke} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'top', fontSize: 10, fill: targetStroke }} />}
          {series.map((s, i) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Bar
                key={animKey(s.key)} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity}
                radius={stacked ? [0, 0, 0, 0] : [0, 4, 4, 0]} maxBarSize={22} stackId={stacked ? 'stack' : undefined}
                isAnimationActive={dynamicAnimation ? false : undefined}
              >
                {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0], growAnim)}
                {/* Empilhada: sempre o total da pilha (nunca por segmento —
                    quebra a leitura com várias séries) — anexado só à
                    última série, o segmento do TOPO da pilha em Recharts. */}
                {stacked
                  ? dl && i === series.length - 1 && <LabelList dataKey={s.key} content={stackTotalLabelContent(dl, points, series, false)} />
                  : sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, false, conditionalRules)} />}
              </Bar>
            )
          })}
        </BarChart>
      </ResponsiveContainer>
    )
  }
  if (type === 'scatter') {
    const xHeight = axisSize(24, axisXFormat, 10, 2)
    const yWidth = axisSize(40, axisYFormat, 10, 3)
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} {...grid} />}
          <XAxis type="number" dataKey="x" name="Eixo X" height={xHeight} tick={makeAxisTick(axisXFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <YAxis type="number" dataKey="value" name="Eixo Y" width={yWidth} tick={makeAxisTick(axisYFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <Tooltip {...TOOLTIP_PROPS} cursor={{ strokeDasharray: '3 3' }} formatter={(v: number) => v.toLocaleString('pt-BR')} labelFormatter={() => ''} />
          <Scatter key={animKey('scatter')} data={points} fill={color ?? pal[0]} fillOpacity={opacity} {...nativeAnimProps}>
            {dl && <LabelList dataKey="value" content={pointLabelContent(dl, points, 'value')} />}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    )
  }
  if (type === 'funnel') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <FunnelChart>
          <Tooltip {...TOOLTIP_PROPS} />
          <Funnel
            key={animKey('funnel')} data={points} dataKey="value" nameKey="label"
            {...(dynamicAnimation ? nativeAnimProps : { isAnimationActive: false })}
          >
            {points.map((_, i) => <Cell key={i} fill={pal[i % pal.length]} fillOpacity={opacity} />)}
            {dl ? <LabelList dataKey="value" content={funnelLabelContent(dl, points)} /> : <LabelList dataKey="label" position="right" fill={AXIS_CATEGORY_FILL} fontSize={10} />}
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    )
  }
  if (type === 'comboBarLine') {
    // Quando há só 1 medida de coluna, o backend não gera chave s0 (o valor
    // fica direto em point.value) — cai no mesmo fallback do resolveSeries.
    const barSeriesRaw = series.filter((s) => s.role !== 'line')
    const barSeries = barSeriesRaw.length ? barSeriesRaw : [{ key: 'value', label: 'Valor', color: color ?? pal[0] }]
    const lineSeries = series.filter((s) => s.role === 'line')
    const xHeight = axisSize(46, axisXFormat, 9, 2)
    const yWidth = axisSize(40, axisYFormat, 10, 3)
    const growAnim = dynamicAnimation ? { perBarMs: drawMs / Math.max(1, points.length), horizontal: false } : undefined
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} {...grid} />}
          <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, AXIS_CATEGORY_FILL, 9)} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" />
          <YAxis yAxisId="left" width={yWidth} tick={makeAxisTick(axisYFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <YAxis yAxisId="right" orientation="right" width={yWidth} tick={makeAxisTick(axisYFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <Tooltip {...TOOLTIP_PROPS} />
          <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
          {target != null && <ReferenceLine yAxisId="left" y={target} stroke={targetStroke} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: targetStroke }} />}
          {barSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Bar
                key={animKey(s.key)} yAxisId="left" dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity} radius={[4, 4, 0, 0]}
                isAnimationActive={dynamicAnimation ? false : undefined}
              >
                {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0], growAnim)}
                {sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, true, conditionalRules)} />}
              </Bar>
            )
          })}
          {lineSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Line key={animKey(s.key)} yAxisId="right" type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} strokeWidth={2} dot={false} {...nativeAnimProps}>
                {sDl && <LabelList dataKey={s.key} content={pointLabelContent(sDl, points, s.key)} />}
              </Line>
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>
    )
  }
  if (type === 'histogram') {
    // Estilo Excel/Power BI: barra (frequência) e linha (curva normal
    // ajustada) compartilham o MESMO eixo Y — não é um combo de 2 escalas.
    // Barras encostadas (sem gap) porque representam faixas contínuas de um
    // único campo, não categorias distintas.
    const barSeriesRaw = series.filter((s) => s.role !== 'line')
    const barSeries = barSeriesRaw.length ? barSeriesRaw : [{ key: 'value', label: 'Frequência', color: color ?? pal[0] }]
    const lineSeries = series.filter((s) => s.role === 'line')
    const xHeight = axisSize(46, axisXFormat, 9, 2)
    const yWidth = axisSize(40, axisYFormat, 10, 3)
    const growAnim = dynamicAnimation ? { perBarMs: drawMs / Math.max(1, points.length), horizontal: false } : undefined
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: -10, bottom: 0 }} barCategoryGap="0%" barGap="0%">
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} {...grid} />}
          <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, AXIS_CATEGORY_FILL, 9)} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" />
          <YAxis width={yWidth} tick={makeAxisTick(axisYFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <Tooltip {...TOOLTIP_PROPS} />
          <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
          {target != null && <ReferenceLine y={target} stroke={targetStroke} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: targetStroke }} />}
          {barSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Bar key={animKey(s.key)} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity} isAnimationActive={dynamicAnimation ? false : undefined}>
                {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0], growAnim)}
                {sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, true, conditionalRules)} />}
              </Bar>
            )
          })}
          {lineSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Line key={animKey(s.key)} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} strokeWidth={2} dot={false} connectNulls {...nativeAnimProps}>
                {sDl && <LabelList dataKey={s.key} content={pointLabelContent(sDl, points, s.key)} />}
              </Line>
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>
    )
  }
  if (type === 'line' || type === 'area') {
    const Comp = type === 'line' ? LineChart : AreaChart
    const xHeight = axisSize(24, axisXFormat, 10, 1.5)
    const yWidth = axisSize(40, axisYFormat, 10, 3)
    return (
      <ResponsiveContainer width="100%" height="100%">
        <Comp data={points} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} {...grid} />}
          <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <YAxis width={yWidth} tick={makeAxisTick(axisYFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
          <Tooltip {...TOOLTIP_PROPS} />
          {showLegend && <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />}
          {target != null && <ReferenceLine y={target} stroke={targetStroke} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: targetStroke }} />}
          {series.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return type === 'line'
              ? (
                <Line key={animKey(s.key)} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} strokeWidth={2} dot={false} {...nativeAnimProps}>
                  {sDl && <LabelList dataKey={s.key} content={pointLabelContent(sDl, points, s.key)} />}
                </Line>
              )
              : (
                <Area key={animKey(s.key)} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} fill={s.color} fillOpacity={0.2 * (opacity ?? 1)} strokeWidth={2} {...nativeAnimProps}>
                  {sDl && <LabelList dataKey={s.key} content={pointLabelContent(sDl, points, s.key)} />}
                </Area>
              )
          })}
        </Comp>
      </ResponsiveContainer>
    )
  }
  // bar / barStacked (colunas verticais)
  const stackedV = type === 'barStacked'
  const xHeight = axisSize(46, axisXFormat, 9, 2)
  const yWidth = axisSize(40, axisYFormat, 10, 3)
  // Vertical: cresce em Y, de baixo pra cima — mesma fatia do ciclo por
  // categoria (esquerda → direita), compartilhada entre as séries da MESMA
  // posição quando empilhado (a pilha inteira daquela categoria cresce
  // junto, como "uma coluna só").
  const growAnim = dynamicAnimation ? { perBarMs: drawMs / Math.max(1, points.length), horizontal: false } : undefined
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={points} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
        {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} {...grid} />}
        <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, AXIS_CATEGORY_FILL, 9)} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" />
        <YAxis width={yWidth} tick={makeAxisTick(axisYFormat, AXIS_VALUE_FILL, 10)} axisLine={false} tickLine={false} />
        <Tooltip {...TOOLTIP_PROPS} />
        {showLegend && <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />}
        {target != null && <ReferenceLine y={target} stroke={targetStroke} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: targetStroke }} />}
        {series.map((s, i) => {
          const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
          return (
            <Bar
              key={animKey(s.key)} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity}
              radius={stackedV ? [0, 0, 0, 0] : [4, 4, 0, 0]} stackId={stackedV ? 'stack' : undefined}
              isAnimationActive={dynamicAnimation ? false : undefined}
            >
              {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0], growAnim)}
              {/* Empilhada: sempre o total da pilha — ver comentário
                  equivalente no bloco barH/barHStacked acima. */}
              {stackedV
                ? dl && i === series.length - 1 && <LabelList dataKey={s.key} content={stackTotalLabelContent(dl, points, series, true)} />
                : sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, true, conditionalRules)} />}
            </Bar>
          )
        })}
      </BarChart>
    </ResponsiveContainer>
  )
}

const TABLE_COL_DEFAULT_WIDTH = 150
const TABLE_COL_MIN_WIDTH = 24

function TableBody({ widget, data, page, setPage, editMode, onColumnWidthsChange }: {
  widget: WidgetConfig; data: WidgetDataResponse; page: number; setPage: (p: number) => void
  editMode?: boolean; onColumnWidthsChange?: (widths: Record<string, number>) => void
}) {
  const sourceDef = widget.source ? getSourceDef(widget.source) : undefined
  const lookups = widget.lookups ?? []
  const baseCols = widget.columns?.length ? widget.columns : Object.keys(data.rows?.[0] ?? {}).filter((c) => !c.includes('.'))
  const cols = [...baseCols, ...lookups.map((lk) => `${lk.source}.${lk.field}`)]
  const format = widget.tableFormat
  // Coluna de bucket ('year:'/'quarter:'/'month:'/'day:', ver Hierarquia de
  // datas): sem `columnLabels` customizado, cai em "Campo · Ano" etc (mesmo
  // texto que o seletor de colunas já mostrou ao adicionar) — sem isso, uma
  // coluna assim mostraria a chave crua ("month:campo") como cabeçalho, já
  // que nenhum campo do catálogo é literalmente chamado "month:campo".
  const labelOf = (c: string) => format?.columnLabels?.[c] ?? lookups.find((lk) => `${lk.source}.${lk.field}` === c)?.label
    ?? sourceDef?.fields.find((f) => f.key === c)?.label
    ?? (splitBucket(c).bucket ? dimensionLabel(widget.source, c) : c)
  // Regras com `applyTo: 'row'` são resolvidas uma vez POR LINHA (ver
  // resolveTableRowEffect) — separadas aqui das de célula pra não competir
  // duas vezes pela mesma regra (uma como linha inteira, outra como célula
  // isolada da própria coluna que a originou).
  const rowRules = widget.tableConditionalRules?.filter((r) => r.applyTo === 'row')
  const cellRules = widget.tableConditionalRules?.filter((r) => r.applyTo !== 'row')
  const alignCls = format?.align === 'center' ? 'text-center' : format?.align === 'right' ? 'text-right' : 'text-left'
  const totalPages = Math.max(1, Math.ceil((data.total ?? 0) / (data.pageSize ?? 50)))
  // `sticky` precisa de um fundo OPACO pra não deixar as linhas por trás
  // "vazando" durante o scroll — `bg-app-card` cobre o caso padrão, mas um
  // widget com `backgroundColor` próprio (tema de fundo escuro) precisa do
  // MESMO fundo aqui, senão o cabeçalho fica com uma faixa clara destoante
  // (e, com o texto branco do tema por cima, ilegível).
  const headerBg = widget.backgroundColor ? hexToRgba(widget.backgroundColor, widget.backgroundOpacity) : undefined

  // Largura por coluna, arrastável pela borda direita do cabeçalho (só em
  // modo edição). Fica em ref (não state) pra não re-renderizar a cada pixel
  // arrastado via setState — `bump` força o re-render manualmente durante o
  // arrasto; o valor final só é reportado pro widget (via onColumnWidthsChange,
  // que o DashboardBuilder grava em tableFormat.columnWidths) no soltar do
  // mouse. Sem clamp contra a coluna vizinha de propósito: encolher bastante
  // é permitido, mesmo que trunque o texto ou deixe a tabela mais estreita
  // que o card (aí só sobra espaço em branco, não afeta as outras colunas).
  const widthsRef = useRef<Record<string, number>>(format?.columnWidths ?? {})
  const [, bump] = useState(0)
  const draggingRef = useRef(false)
  useEffect(() => {
    if (!draggingRef.current) { widthsRef.current = format?.columnWidths ?? {}; bump((n) => n + 1) }
  }, [format?.columnWidths])

  const startResize = (col: string, e: React.MouseEvent) => {
    if (!editMode) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = widthsRef.current[col] ?? TABLE_COL_DEFAULT_WIDTH
    draggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(TABLE_COL_MIN_WIDTH, startWidth + (ev.clientX - startX))
      widthsRef.current = { ...widthsRef.current, [col]: next }
      bump((n) => n + 1)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      draggingRef.current = false
      onColumnWidthsChange?.(widthsRef.current)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const widthOf = (c: string) => widthsRef.current[c] ?? TABLE_COL_DEFAULT_WIDTH
  const totalWidth = cols.reduce((sum, c) => sum + widthOf(c), 0)

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto">
        <table style={{ fontSize: format?.fontSize ?? 11, tableLayout: 'fixed', width: totalWidth }}>
          <colgroup>
            {cols.map((c) => <col key={c} style={{ width: widthOf(c) }} />)}
          </colgroup>
          <thead className={cn('sticky top-0', !headerBg && 'bg-app-card')} style={{ background: headerBg }}>
            <tr className="border-b border-app-border text-gray-500" style={{ color: format?.color }}>
              {cols.map((c) => (
                <th key={c} className={cn('relative px-3 py-2 truncate', alignCls, (format?.headerBold ?? true) ? 'font-bold' : 'font-normal')}>
                  {labelOf(c)}
                  {editMode && (
                    <span
                      onMouseDown={(e) => startResize(c, e)}
                      title="Arrastar para redimensionar"
                      className="absolute top-0 right-0 h-full w-2 cursor-col-resize hover:bg-brand-blue/40 active:bg-brand-blue/60"
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data.rows ?? []).map((r, i) => {
              // Calculado uma vez por linha (não por célula) — ver
              // resolveTableRowEffect: quando bate, vence pra TODA célula
              // desta linha, sobrepondo qualquer regra de célula individual.
              const rowRule = resolveTableRowEffect(r, rowRules)
              return (
                <tr key={i} className="border-b border-app-border/60 hover:bg-app-surface/50">
                  {cols.map((c) => {
                    const v = r[c]
                    const text = v == null ? '—'
                      : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? new Date(String(v)).toLocaleDateString('pt-BR')
                      : String(v)
                    // Formatação condicional por coluna (ver TableConditionalRule,
                    // types.ts) — motor SEPARADO do de Meta e alertas, compara o
                    // TEXTO da célula (não um valor numérico agregado).
                    const rule = rowRule ?? resolveTableCellEffect(text, c, cellRules)
                    const cellStyle: React.CSSProperties = { color: rule?.color ?? format?.color }
                    if (rule?.backgroundColor) cellStyle.backgroundColor = rule.backgroundColor
                    if (rule?.blink) Object.assign(cellStyle, pulseSyncStyle(rule.blinkSpeed))
                    return (
                      <td key={c} className={cn('px-3 py-1.5 text-gray-300 truncate', alignCls, rule?.blink && 'animate-pulse')} style={cellStyle}>
                        {text}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between px-3 py-2 border-t border-app-border text-[10px] text-gray-500 shrink-0" style={{ color: format?.color }}>
        <span>{(data.total ?? 0).toLocaleString('pt-BR')} linhas · pág. {page}/{totalPages}</span>
        <div className="flex gap-1">
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="h-5 w-5 flex items-center justify-center rounded border border-app-border disabled:opacity-40"><ChevronLeft size={10} /></button>
          <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className="h-5 w-5 flex items-center justify-center rounded border border-app-border disabled:opacity-40"><ChevronRight size={10} /></button>
        </div>
      </div>
    </div>
  )
}

// Tabela Matriz (pivot) — linhas em árvore (expandir/colapsar por grupo,
// com subtotal), colunas dinâmicas + coluna "Total", linha "Total" geral.
function MatrixBody({ matrix, rowFormat, columnFormat, backgroundColor, backgroundOpacity, conditionalRules }: {
  matrix: MatrixResult; rowFormat?: TextFormat; columnFormat?: TextFormat; backgroundColor?: string; backgroundOpacity?: number
  conditionalRules?: ConditionalRule[]
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const fmt = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  const rowStyle = textFormatStyle(rowFormat)
  const columnStyle = textFormatStyle(columnFormat)
  // O rótulo da linha (label) vive dentro de um `<span>` FLEX (junto do
  // chevron de expandir/colapsar) — `text-align` no `<td>` (rowStyle) não
  // afeta item de flex, só conteúdo inline normal. Precisa de
  // `justify-content` no próprio flex pra "Centro"/"Direita" terem efeito.
  const rowJustify = rowFormat?.align === 'center' ? 'center' : rowFormat?.align === 'right' ? 'flex-end' : 'flex-start'
  // Mesma lógica do cabeçalho da tabela (ver TableBody) — o `sticky` do
  // cabeçalho da matriz também precisa herdar o fundo customizado do widget.
  const headerBg = backgroundColor ? hexToRgba(backgroundColor, backgroundOpacity) : undefined

  const renderRows = (nodes: MatrixResult['rows'], depth: number): React.ReactNode[] =>
    nodes.flatMap((node) => {
      const hasChildren = !!node.children?.length
      const isCollapsed = collapsed.has(node.key)
      const row = (
        <tr key={node.key} className={cn('border-b border-app-border/60', depth === 0 && 'bg-app-surface/40')}>
          <td className={cn('py-1.5 pr-2 text-gray-200 whitespace-nowrap', depth === 0 && 'font-semibold')} style={{ paddingLeft: 8 + depth * 16, ...rowStyle }}>
            {/* `w-full`: um <span> flex não é largo por padrão (encolhe pro
                conteúdo) — sem isso, `justifyContent` não tem espaço nenhum
                pra redistribuir e "Centro"/"Direita" não fariam efeito. */}
            <span className="flex items-center gap-1 w-full" style={{ justifyContent: rowJustify }}>
              {hasChildren ? (
                <button onClick={() => toggle(node.key)} className="text-gray-500 hover:text-gray-200 shrink-0">
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                </button>
              ) : <span className="w-[11px] shrink-0" />}
              <span className="truncate">{node.label}</span>
            </span>
          </td>
          {matrix.columns.map((c) => {
            const cellValue = node.values[c.key] ?? 0
            const cellEffect = resolveConditionalEffect(cellValue, conditionalRules)
            const cellStyle: React.CSSProperties = { ...rowStyle }
            if (cellEffect?.backgroundColor) cellStyle.backgroundColor = cellEffect.backgroundColor
            if (cellEffect?.blink) Object.assign(cellStyle, pulseSyncStyle(cellEffect.blinkSpeed))
            return (
              <td key={c.key} className={cn('px-2 py-1.5 text-right text-gray-300 tabular-nums', cellEffect?.blink && 'animate-pulse')} style={cellStyle}>
                {fmt(cellValue)}
              </td>
            )
          })}
          <td className="px-2 py-1.5 text-right text-gray-100 font-semibold tabular-nums" style={rowStyle}>{fmt(node.total)}</td>
        </tr>
      )
      return hasChildren && !isCollapsed ? [row, ...renderRows(node.children!, depth + 1)] : [row]
    })

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[11px]">
        <thead className={cn('sticky top-0', !headerBg && 'bg-app-card')} style={{ background: headerBg }}>
          <tr className="border-b border-app-border text-gray-500">
            <th className="py-2 pr-2 text-left font-semibold" style={columnStyle} />
            {matrix.columns.map((c) => <th key={c.key} className="px-2 py-2 text-right font-semibold whitespace-nowrap" style={columnStyle}>{c.label}</th>)}
            <th className="px-2 py-2 text-right font-semibold" style={columnStyle}>Total</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.length === 0 && (
            <tr><td colSpan={matrix.columns.length + 2} className="px-2 py-6 text-center text-gray-500">Sem dados para essa configuração.</td></tr>
          )}
          {renderRows(matrix.rows, 0)}
        </tbody>
        {matrix.rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-app-border font-bold bg-app-surface/60">
              <td className="py-1.5 pr-2 text-gray-100" style={rowStyle}>Total</td>
              {matrix.columns.map((c) => <td key={c.key} className="px-2 py-1.5 text-right text-gray-100 tabular-nums" style={rowStyle}>{fmt(matrix.grandTotal[c.key] ?? 0)}</td>)}
              <td className="px-2 py-1.5 text-right text-gray-100 tabular-nums" style={rowStyle}>{fmt(matrix.grandTotalAll)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

// Widget de texto — conteúdo livre, sem fonte de dados nenhuma (não passa
// por fetchWidgetData). white-space: pre-wrap preserva quebras de linha
// digitadas no editor sem precisar de markdown.
function TextBody({ content }: { content?: string }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin px-4 py-3 text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
      {content || <span className="text-gray-500">Sem conteúdo — edite o widget para adicionar um texto.</span>}
    </div>
  )
}

// ─── Componente principal ────────────────────────────────────────
export function WidgetRenderer({ widget, tabFilters, relations, editMode, refreshKey, onEdit, onRemove, onDuplicate, onColumnWidthsChange, onPinInsight }: WidgetRendererProps) {
  const [data, setData] = useState<WidgetDataResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  // Assinatura estável dos inputs de dados — refetch quando muda config/filtros.
  const querySignature = useMemo(() => JSON.stringify({
    w: {
      ...widget, layout: undefined, title: undefined, subtitle: undefined, color: undefined,
      axisXFormat: undefined, axisYFormat: undefined, matrixRowFormat: undefined, matrixColumnFormat: undefined, dataLabels: undefined,
      titleFormat: undefined, subtitleFormat: undefined, backgroundColor: undefined, backgroundOpacity: undefined, seriesOpacity: undefined,
      legendFormat: undefined, gridLines: undefined, gridLinesColor: undefined, gridLinesOpacity: undefined,
      iconColor: undefined, palette: undefined, tableFormat: undefined, valueAlign: undefined,
      tableConditionalRules: undefined, targetLineColor: undefined, targetLineOpacity: undefined,
      dynamicAnimation: undefined, dynamicAnimationSpeed: undefined,
      // Fixar uma leitura não muda o dado — sem isto, cada "Fixar" disparava
      // uma consulta nova ao servidor de graça.
      insight: undefined,
    },
    f: tabFilters.map((tf) => ({ id: tf.filter.id, v: tf.values })),
    // Relação em si (não só o filtro) pode mudar o dado — editar/remover uma
    // relação enquanto um filtro de outra fonte está ativo muda o semi-join.
    r: relations,
    page,
  }), [widget, tabFilters, relations, page])

  useEffect(() => {
    // Widget de texto não tem fonte de dados — nunca chama a API.
    if (widget.type === 'text') { setLoading(false); return }
    let alive = true
    // Só mostra o spinner na 1ª carga — um refresh automático em segundo
    // plano (refreshKey) troca o dado no lugar, sem apagar o gráfico atual.
    setLoading((prev) => prev || !data)
    fetchWidgetData(widget, tabFilters, page, 50, relations)
      .then((d) => { if (alive) { setData(d); setError(null) } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e.message : 'Erro inesperado.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySignature, refreshKey, widget.type])

  let body: React.ReactNode
  if (widget.type === 'text') {
    body = <TextBody content={widget.content} />
  } else if (loading && !data) {
    body = <div className="h-full flex items-center justify-center text-gray-500"><Loader2 size={14} className="animate-spin" /></div>
  } else if (error) {
    body = <div className="h-full flex items-center justify-center gap-1.5 text-[11px] text-risk-critical px-3 text-center"><AlertTriangle size={12} className="shrink-0" /> {error}</div>
  } else if (widget.type === 'table' && data) {
    body = <TableBody widget={widget} data={data} page={page} setPage={setPage} editMode={editMode} onColumnWidthsChange={onColumnWidthsChange} />
  } else if (widget.type === 'matrix' && data?.matrix) {
    body = (
      <MatrixBody
        matrix={data.matrix} rowFormat={widget.matrixRowFormat} columnFormat={widget.matrixColumnFormat}
        backgroundColor={widget.backgroundColor} backgroundOpacity={widget.backgroundOpacity}
        conditionalRules={widget.conditionalRules}
      />
    )
  } else if (widget.type === 'kpi' && data?.points) {
    body = <KpiBody value={data.points[0]?.value ?? 0} color={widget.color} target={widget.target} align={widget.valueAlign} />
  } else if (data?.points) {
    body = (
      <PointsChart
        type={widget.type} points={data.points} color={widget.color} seriesKeys={data.seriesKeys}
        axisXFormat={widget.axisXFormat} axisYFormat={widget.axisYFormat} dataLabels={widget.dataLabels}
        seriesOpacity={widget.seriesOpacity} gridLines={widget.gridLines}
        gridLinesColor={widget.gridLinesColor} gridLinesOpacity={widget.gridLinesOpacity} legendFormat={widget.legendFormat}
        palette={widget.palette} target={widget.target}
        targetLineColor={widget.targetLineColor} targetLineOpacity={widget.targetLineOpacity} conditionalRules={widget.conditionalRules}
        dynamicAnimation={widget.dynamicAnimation} dynamicAnimationSpeed={widget.dynamicAnimationSpeed}
      />
    )
  } else {
    body = null
  }

  // Efeito condicional do CARD inteiro — só faz sentido pro KPI (1 valor só,
  // igual à meta em si); gráficos/matriz coloram por barra/célula dentro do
  // próprio corpo (ver PointsChart/MatrixBody), não o card como um todo.
  const cardEffect = widget.type === 'kpi' && data?.points
    ? resolveConditionalEffect(data.points[0]?.value ?? 0, widget.conditionalRules)
    : undefined

  // Só o que representa o DADO, sem as linhas paginadas da tabela (virar a
  // página não é mudança de dado — `total` já denuncia se a base mudou).
  const dataShape = { points: data?.points, matrix: data?.matrix, total: data?.total }

  return (
    <ChartFrame
      widget={widget} tabFilters={tabFilters} relations={relations} dataShape={dataShape} editMode={editMode}
      onEdit={onEdit} onRemove={onRemove} onDuplicate={onDuplicate} onPinInsight={onPinInsight} cardEffect={cardEffect}
    >
      {body}
    </ChartFrame>
  )
}
