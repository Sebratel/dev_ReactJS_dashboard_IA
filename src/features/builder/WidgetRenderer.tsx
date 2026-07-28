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
import { fetchWidgetData, ApiError } from './builderApi'
import { WidgetCommentsPopover } from './WidgetCommentsPopover'
import { resolveConditionalEffect } from './conditionalFormat'
import type { ConditionalEffect, ConditionalRule, DataLabelContent, DataLabelFormat, FilterConfig, MatrixResult, SeriesMeta, TextFormat, WidgetConfig, WidgetDataPoint, WidgetDataResponse } from './types'

const PALETTE = ['#ffb000', '#3b82f6', '#10b981', '#7c3aed', '#22d3ee', '#f97316', '#ef4444', '#6366f1']

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
    fontWeight: fmt.bold ? 700 : undefined,
    fontStyle: fmt.italic ? 'italic' : undefined,
    textDecoration: fmt.underline ? 'underline' : undefined,
    color: fmt.color ? hexToRgba(fmt.color, fmt.opacity) : undefined,
    backgroundColor: fmt.backgroundColor ? hexToRgba(fmt.backgroundColor, fmt.backgroundOpacity) : undefined,
  }
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

function barLabelContent(dl: DataLabelFormat, points: WidgetDataPoint[], key: string, vertical: boolean) {
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
    return <text x={cx} y={cy} textAnchor={anchor} fontSize={fontSize} {...labelFillProps(dl, '#9ca3af')}>{text}</text>
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
    return <text x={x} y={y + dy} textAnchor="middle" fontSize={fontSize} {...labelFillProps(dl, '#9ca3af')}>{text}</text>
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
      <text x={x} y={y} {...labelFillProps(dl, inside ? '#fff' : '#9ca3af')} fontSize={dl.fontSize ?? 10} textAnchor={x > cx ? 'start' : x < cx ? 'end' : 'middle'} dominantBaseline="central">
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
    return <text x={x + width + 8} y={cy} textAnchor="start" fontSize={fontSize} {...labelFillProps(dl, '#9ca3af')}>{text}</text>
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
}

function ChartFrame({ widget, editMode, onEdit, onRemove, onDuplicate, cardEffect, children }: {
  widget: WidgetConfig; editMode: boolean; onEdit?: () => void; onRemove?: () => void; onDuplicate?: () => void
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
  // Sombra/brilho estáticos (Formato → Aparência do widget) OU do efeito
  // condicional (que tem prioridade quando bate) — glow usa a cor de fundo
  // ativa como tint, caindo pro azul padrão do app se não houver nenhuma.
  const glowOn = cardEffect?.glow ?? widget.glow
  if (glowOn) cardStyle.boxShadow = `0 0 22px ${hexToRgba(bgColor ?? '#ffb000', 55)}`
  else if (widget.shadow) cardStyle.boxShadow = '0 12px 32px -8px rgba(0,0,0,0.35)'
  const blinkOn = cardEffect?.blink ?? widget.blink
  // Ícone sem cor customizada usa a cor padrão via classe (text-gray-500);
  // com cor customizada, sobrepõe via style (a classe continua definindo o
  // hover, já que style inline não afeta pseudo-classes).
  const iconStyle: React.CSSProperties | undefined = widget.iconColor ? { color: widget.iconColor } : undefined
  return (
    <div className={cn('h-full flex flex-col border border-app-border rounded-2xl shadow-card overflow-hidden transition-colors', !bgColor && 'bg-app-card', blinkOn && 'animate-pulse')} style={cardStyle}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-app-border shrink-0">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-100 truncate" style={textFormatStyle(widget.titleFormat)}>{widget.title}</p>
          {widget.subtitle && <p className="text-[10px] text-gray-500 truncate" style={textFormatStyle(widget.subtitleFormat)}>{widget.subtitle}</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <WidgetCommentsPopover widgetId={widget.id} iconStyle={iconStyle} iconClassName={!widget.iconColor ? 'text-gray-500' : undefined} />
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

function KpiBody({ value, color, target }: { value: number; color?: string; target?: number }) {
  const formatted = Number.isInteger(value) ? value.toLocaleString('pt-BR') : value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  return (
    <div className="h-full flex items-center gap-2 px-3">
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

// Uma <Cell> por ponto, colorida pela regra que bater (ver conditionalFormat.ts)
// — sem regras, `null` (deixa o <Bar fill={s.color}> normal cuidar de tudo).
// Cada barra vira independente da série quanto à cor, estilo Power BI.
// `animate-pulse` (Tailwind) funciona em qualquer elemento SVG — a Cell do
// Recharts repassa `className` direto pro <path>/<rect> renderizado.
function conditionalCells(points: WidgetDataPoint[], dataKey: string, rules: ConditionalRule[] | undefined, fallbackColor: string) {
  if (!rules?.length) return null
  return points.map((p, i) => {
    const raw = (p as unknown as Record<string, unknown>)[dataKey] ?? p.value
    const effect = resolveConditionalEffect(Number(raw), rules)
    return <Cell key={i} fill={effect?.backgroundColor ?? fallbackColor} className={effect?.blink ? 'animate-pulse' : undefined} />
  })
}

const TARGET_LINE_COLOR = '#ef4444'
function targetLineLabel(target: number) {
  return `Meta: ${target.toLocaleString('pt-BR')}`
}

function PointsChart({ type, points, color, seriesKeys, axisXFormat, axisYFormat, dataLabels, seriesOpacity, gridLines, legendFormat, palette, target, conditionalRules }: {
  type: WidgetConfig['type']; points: WidgetDataPoint[]; color?: string; seriesKeys?: SeriesMeta[]
  axisXFormat?: TextFormat; axisYFormat?: TextFormat; dataLabels?: DataLabelFormat; seriesOpacity?: number
  gridLines?: WidgetConfig['gridLines']; legendFormat?: TextFormat; palette?: string[]
  target?: number; conditionalRules?: ConditionalRule[]
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
  const legendStyle = legendWrapperStyle(legendFormat)
  const legendFormatter = legendTextFormatter(legendFormat)
  if (type === 'pie') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={points} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="75%" paddingAngle={2}
            label={dl ? pieLabelRenderer(dl) : undefined} labelLine={!!dl}
          >
            {points.map((_, i) => <Cell key={i} fill={pal[i % pal.length]} fillOpacity={opacity} />)}
          </Pie>
          <Tooltip />
          <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
        </PieChart>
      </ResponsiveContainer>
    )
  }
  if (type === 'barH' || type === 'barHStacked') {
    const stacked = type === 'barHStacked'
    // Aqui os papéis dos eixos se invertem visualmente: XAxis (embaixo) é a
    // medida (axisYFormat), YAxis (esquerda) é a categoria (axisXFormat).
    const catWidth = axisSize(120, axisXFormat, 9, 3)
    const valHeight = axisSize(24, axisYFormat, 10, 2)
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--app-border))" {...grid} />}
          <XAxis type="number" height={valHeight} tick={makeAxisTick(axisYFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" tick={makeAxisTick(axisXFormat, '#9ca3af', 9)} axisLine={false} tickLine={false} width={catWidth} />
          <Tooltip />
          {showLegend && <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />}
          {target != null && <ReferenceLine x={target} stroke={TARGET_LINE_COLOR} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'top', fontSize: 10, fill: TARGET_LINE_COLOR }} />}
          {series.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity} radius={stacked ? [0, 0, 0, 0] : [0, 4, 4, 0]} barSize={12} stackId={stacked ? 'stack' : undefined}>
                {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0])}
                {sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, false)} />}
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
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--app-border))" {...grid} />}
          <XAxis type="number" dataKey="x" name="Eixo X" height={xHeight} tick={makeAxisTick(axisXFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <YAxis type="number" dataKey="value" name="Eixo Y" width={yWidth} tick={makeAxisTick(axisYFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v: number) => v.toLocaleString('pt-BR')} labelFormatter={() => ''} />
          <Scatter data={points} fill={color ?? pal[0]} fillOpacity={opacity}>
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
          <Tooltip />
          <Funnel data={points} dataKey="value" nameKey="label" isAnimationActive={false}>
            {points.map((_, i) => <Cell key={i} fill={pal[i % pal.length]} fillOpacity={opacity} />)}
            {dl ? <LabelList dataKey="value" content={funnelLabelContent(dl, points)} /> : <LabelList dataKey="label" position="right" fill="#9ca3af" fontSize={10} />}
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
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--app-border))" {...grid} />}
          <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, '#9ca3af', 9)} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" />
          <YAxis yAxisId="left" width={yWidth} tick={makeAxisTick(axisYFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <YAxis yAxisId="right" orientation="right" width={yWidth} tick={makeAxisTick(axisYFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <Tooltip />
          <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
          {target != null && <ReferenceLine yAxisId="left" y={target} stroke={TARGET_LINE_COLOR} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: TARGET_LINE_COLOR }} />}
          {barSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Bar key={s.key} yAxisId="left" dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity} radius={[4, 4, 0, 0]}>
                {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0])}
                {sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, true)} />}
              </Bar>
            )
          })}
          {lineSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Line key={s.key} yAxisId="right" type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} strokeWidth={2} dot={false}>
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
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 4, right: 8, left: -10, bottom: 0 }} barCategoryGap="0%" barGap="0%">
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--app-border))" {...grid} />}
          <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, '#9ca3af', 9)} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" />
          <YAxis width={yWidth} tick={makeAxisTick(axisYFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <Tooltip />
          <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
          {target != null && <ReferenceLine y={target} stroke={TARGET_LINE_COLOR} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: TARGET_LINE_COLOR }} />}
          {barSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity}>
                {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0])}
                {sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, true)} />}
              </Bar>
            )
          })}
          {lineSeries.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} strokeWidth={2} dot={false} connectNulls>
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
          {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--app-border))" {...grid} />}
          <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <YAxis width={yWidth} tick={makeAxisTick(axisYFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
          <Tooltip />
          {showLegend && <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />}
          {target != null && <ReferenceLine y={target} stroke={TARGET_LINE_COLOR} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: TARGET_LINE_COLOR }} />}
          {series.map((s) => {
            const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
            return type === 'line'
              ? (
                <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} strokeWidth={2} dot={false}>
                  {sDl && <LabelList dataKey={s.key} content={pointLabelContent(sDl, points, s.key)} />}
                </Line>
              )
              : (
                <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeOpacity={opacity} fill={s.color} fillOpacity={0.2 * (opacity ?? 1)} strokeWidth={2}>
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
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={points} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
        {gridLines !== 'none' && <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--app-border))" {...grid} />}
        <XAxis dataKey="label" height={xHeight} tick={makeAxisTick(axisXFormat, '#9ca3af', 9)} axisLine={false} tickLine={false} interval={0} angle={-15} textAnchor="end" />
        <YAxis width={yWidth} tick={makeAxisTick(axisYFormat, '#6b7280', 10)} axisLine={false} tickLine={false} />
        <Tooltip />
        {showLegend && <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />}
        {target != null && <ReferenceLine y={target} stroke={TARGET_LINE_COLOR} strokeDasharray="6 4" label={{ value: targetLineLabel(target), position: 'right', fontSize: 10, fill: TARGET_LINE_COLOR }} />}
        {series.map((s) => {
          const sDl = resolveSeriesDataLabel(s.dataLabels, dataLabels)
          return (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={opacity} radius={stackedV ? [0, 0, 0, 0] : [4, 4, 0, 0]} stackId={stackedV ? 'stack' : undefined}>
              {conditionalCells(points, s.key, conditionalRules, s.color ?? pal[0])}
              {sDl && <LabelList dataKey={s.key} content={barLabelContent(sDl, points, s.key, true)} />}
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
  const labelOf = (c: string) => format?.columnLabels?.[c] ?? lookups.find((lk) => `${lk.source}.${lk.field}` === c)?.label ?? sourceDef?.fields.find((f) => f.key === c)?.label ?? c
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
            {(data.rows ?? []).map((r, i) => (
              <tr key={i} className="border-b border-app-border/60 hover:bg-app-surface/50">
                {cols.map((c) => {
                  const v = r[c]
                  const text = v == null ? '—'
                    : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? new Date(String(v)).toLocaleDateString('pt-BR')
                    : String(v)
                  return <td key={c} className={cn('px-3 py-1.5 text-gray-300 truncate', alignCls)} style={{ color: format?.color }}>{text}</td>
                })}
              </tr>
            ))}
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
            <span className="flex items-center gap-1">
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
export function WidgetRenderer({ widget, tabFilters, editMode, refreshKey, onEdit, onRemove, onDuplicate, onColumnWidthsChange }: WidgetRendererProps) {
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
      legendFormat: undefined, gridLines: undefined, iconColor: undefined, palette: undefined, tableFormat: undefined,
    },
    f: tabFilters.map((tf) => ({ id: tf.filter.id, v: tf.values })),
    page,
  }), [widget, tabFilters, page])

  useEffect(() => {
    // Widget de texto não tem fonte de dados — nunca chama a API.
    if (widget.type === 'text') { setLoading(false); return }
    let alive = true
    // Só mostra o spinner na 1ª carga — um refresh automático em segundo
    // plano (refreshKey) troca o dado no lugar, sem apagar o gráfico atual.
    setLoading((prev) => prev || !data)
    fetchWidgetData(widget, tabFilters, page)
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
    body = <KpiBody value={data.points[0]?.value ?? 0} color={widget.color} target={widget.target} />
  } else if (data?.points) {
    body = (
      <PointsChart
        type={widget.type} points={data.points} color={widget.color} seriesKeys={data.seriesKeys}
        axisXFormat={widget.axisXFormat} axisYFormat={widget.axisYFormat} dataLabels={widget.dataLabels}
        seriesOpacity={widget.seriesOpacity} gridLines={widget.gridLines} legendFormat={widget.legendFormat}
        palette={widget.palette} target={widget.target} conditionalRules={widget.conditionalRules}
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

  return (
    <ChartFrame widget={widget} editMode={editMode} onEdit={onEdit} onRemove={onRemove} onDuplicate={onDuplicate} cardEffect={cardEffect}>
      {body}
    </ChartFrame>
  )
}
