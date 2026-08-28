// Painel de criação/edição de widget — estilo Power BI: painel fixo à
// direita (não bloqueia o resto da dashboard), abas "Dados" (tipo de visual +
// Eixo X/Eixo Y/Legenda via AxisFieldPicker/MeasureWell), "Modificadores"
// (mesclar fonte, filtro fixo, top N) e "Formato" (título/cor/tabela).
import { useEffect, useMemo, useState } from 'react'
import {
  X, Eye, Plus, Minus, Link2, Gauge, BarChart3, BarChart2, BarChartBig, BarChartHorizontalBig,
  Combine, LineChart, AreaChart, PieChart, ScatterChart, Filter as FunnelIcon, Table2, TableProperties, ChevronDown, Type,
  BarChart4, Sheet, RefreshCw, Trash2, ExternalLink,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { useAuthStore } from '@/store/authStore'
import { FieldWell } from './FieldWell'
import { MeasureWell } from './MeasureWell'
import { AxisFieldPicker, type AxisFieldGroup } from './AxisFieldPicker'
import { TableColumnsWell } from './TableColumnsWell'
import { InfoHint } from './InfoHint'
import { getAllSources, getSourceDef, type FieldKind } from './fieldCatalog'
import { fetchWidgetData, fetchFieldValues } from './builderApi'
import { fetchSheetSources, createSheetSource, deleteSheetSource, refreshSheetSource, ApiError as SheetApiError, type SheetSource } from './sheetSourceApi'
import { OPERATOR_LABELS } from './conditionalFormat'
import type { BlinkSpeed, ChartAnimationSpeed, ConditionalOperator, ConditionalRule, DataLabelFormat, LookupColumn, MeasureConfig, SourceTable, TableConditionalRule, TableRuleOperator, TextFormat, WidgetConfig, WidgetDataPoint, WidgetType } from './types'

const TYPE_LABELS: Record<WidgetType, string> = {
  kpi: 'Card (KPI)',
  bar: 'Barras (v)',
  barH: 'Barras (h)',
  barStacked: 'Empilhadas (v)',
  barHStacked: 'Empilhadas (h)',
  comboBarLine: 'Colunas + linha',
  line: 'Linha',
  area: 'Área',
  pie: 'Pizza',
  scatter: 'Dispersão',
  funnel: 'Funil',
  table: 'Tabela',
  matrix: 'Matriz',
  text: 'Texto',
  histogram: 'Histograma',
}

const TYPE_ICONS: Record<WidgetType, typeof BarChart3> = {
  kpi: Gauge,
  bar: BarChart3,
  barH: BarChart2,
  barStacked: BarChartBig,
  barHStacked: BarChartHorizontalBig,
  comboBarLine: Combine,
  line: LineChart,
  area: AreaChart,
  pie: PieChart,
  scatter: ScatterChart,
  funnel: FunnelIcon,
  table: Table2,
  matrix: TableProperties,
  text: Type,
  histogram: BarChart4,
}

// Tipos que suportam múltiplas medidas no Eixo Y (uma série por medida).
const MULTI_MEASURE_TYPES: WidgetType[] = ['bar', 'barH', 'barStacked', 'barHStacked', 'line', 'area', 'comboBarLine']
// Tipos que suportam quebra por Legenda (2ª dimensão) — comboBarLine e
// scatter ficam de fora: legenda + eixo secundário/2 medidas juntos vira
// complexo demais pra v1.
const LEGEND_TYPES: WidgetType[] = ['bar', 'barH', 'barStacked', 'barHStacked', 'line', 'area']
// Tipos com Eixo X/Eixo Y cartesianos — só esses ganham as seções de
// formatação de eixo no Formato (pie/funnel/kpi/table/matrix não têm eixo).
const AXIS_TYPES: WidgetType[] = ['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'line', 'area', 'scatter', 'histogram']
// Tipos que suportam rótulos de dados sobre o próprio gráfico.
const DATA_LABEL_TYPES: WidgetType[] = ['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'line', 'area', 'scatter', 'pie', 'funnel', 'histogram']
// Tipos que mostram legenda (quadradinho + nome da série) embaixo do gráfico
// — scatter e funnel nunca mostram (não fazem sentido: 1 série só, sem nome).
const LEGEND_DISPLAY_TYPES: WidgetType[] = ['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'line', 'area', 'pie', 'histogram']
// Motor de formatação condicional (item 2.1) — "Meta" (linha de referência no
// gráfico) só existe nos tipos com eixo de valor contínuo; "Regras" (cor de
// fundo/pisca condicional) só tem efeito visual onde há barra/célula/card pra
// colorir — line/area desenham a meta mas não coloram a linha por trecho.
const TARGET_LINE_TYPES: WidgetType[] = ['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'histogram', 'line', 'area']
const CONDITIONAL_RULES_TYPES: WidgetType[] = ['kpi', 'bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'histogram', 'matrix']
// Subconjunto de CONDITIONAL_RULES_TYPES que tem barra E rótulo de dados como
// elementos separados na tela — só nesses o "Aplica em" (barra/rótulo/ambos)
// faz sentido. KPI é um card só; a célula da Matriz JÁ é o rótulo.
const BAR_LABEL_TARGET_TYPES: WidgetType[] = ['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'histogram']

const GRID_LINE_OPTIONS: { key: NonNullable<WidgetConfig['gridLines']>; label: string }[] = [
  { key: 'both', label: 'Todas' },
  { key: 'horizontal', label: 'Horizontal' },
  { key: 'vertical', label: 'Vertical' },
  { key: 'none', label: 'Nenhuma' },
]

const COLORS = ['#ffb000', '#3b82f6', '#10b981', '#7c3aed', '#22d3ee', '#f97316', '#ef4444', '#6366f1', '#6b7280', '#000000', '#ffffff']

interface Props {
  initial: WidgetConfig | null // null = criar novo
  // Cores do tema já aplicado na guia (ver newWidgetThemeDefaults em
  // themePresets.ts) — só usado quando `initial` é null, pra um widget novo
  // já nascer combinando com o resto da guia em vez de cair no padrão do app.
  newWidgetDefaults?: Partial<WidgetConfig>
  onSave: (widget: WidgetConfig) => void
  onClose: () => void
  // Dispara a cada alteração no rascunho (não só ao salvar) — quem usa isso
  // (DashboardBuilder) substitui o widget real pelo rascunho na hora de
  // renderizar a grade, dando pré-visualização em tempo real por trás do
  // painel. O botão "Salvar" continua sendo o único jeito de persistir de
  // verdade a alteração (aqui é só uma prévia visual, descartável).
  onChange?: (widget: WidgetConfig) => void
  // Chamado depois de cadastrar/remover uma planilha do Google (ver seção
  // "Planilhas do Google" em Modificadores) — quem usa isso (DashboardBuilder)
  // recarrega o catálogo de fontes (GET /api/sources) pra ela aparecer no
  // seletor de fonte da aba Dados sem precisar fechar e reabrir o editor.
  onSourcesChanged?: () => Promise<void>
}

function Field({ label, info, children }: { label: string; info?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="flex items-center gap-1">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
        {info && <InfoHint text={info} />}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

// Seção recolhível do Formato — fecha por padrão (só o cabeçalho aparece);
// clicar expande pra ajustar. Com tantas seções de formatação acumuladas
// (título, eixos, legenda, rótulos, matriz, tabela...), manter tudo sempre
// aberto tornava a aba enorme — cada uma abre só quando o usuário precisa.
function CollapsibleSection({ label, info, open, onToggle, children }: {
  label: string; info?: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div className="pt-2 border-t border-app-border">
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between gap-1 text-left py-0.5">
        <span className="flex items-center gap-1">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
          {info && <InfoHint text={info} />}
        </span>
        <ChevronDown size={12} className={cn('shrink-0 text-gray-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  )
}

// Borda preta constante (visível mesmo pra branco/preto contra o fundo escuro
// do painel) + um contorno colorido COM offset real (não box-shadow simulado)
// pro estado selecionado — assim a seleção nunca "desaparece" quando a cor é
// branca/clara (um anel `border-gray-100` sobre um preenchimento branco fica
// invisível; um `outline` com gap real não depende da cor do preenchimento).
const swatchCls = (active: boolean, big = false) => cn(
  big ? 'h-6 w-6' : 'h-5 w-5',
  'rounded-full border border-black/40',
  active && 'outline outline-2 outline-offset-1 outline-brand-blue',
)

function OpacitySlider({ label, value, onChange }: { label?: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  const v = value ?? 100
  return (
    <label className="flex items-center gap-2">
      <span className="text-[9px] text-gray-500 shrink-0">{label ?? 'Opacidade'}</span>
      <input
        type="range" min={0} max={100} step={5} value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1 accent-brand-blue"
      />
      <span className="text-[10px] text-gray-400 w-8 text-right tabular-nums shrink-0">{v}%</span>
    </label>
  )
}

// Substitui o <input type="number"> nu (seta nativa do navegador — minúscula,
// inconsistente entre Chrome/Firefox/Safari, relatada como "feia" pelo
// usuário com print) por um controle com botões −/+ de verdade, do tamanho
// de qualquer outro botão do editor. Clique incrementa/decrementa por `step`;
// o número também aceita digitação direta (útil pra pular de 8 pra 22 sem
// clicar 14 vezes). `unsetAt`, quando definido, é o valor que faz o campo
// voltar a "ausente" (undefined) em vez de um número — mesmo espírito de 0 =
// "sem recuo manual" no Eixo X/Eixo Y.
function NumberStepper({ value, defaultValue, min, max, step = 1, unsetAt, onChange, suffix, className }: {
  value: number | undefined
  defaultValue: number
  min?: number
  max?: number
  step?: number
  unsetAt?: number
  onChange: (v: number | undefined) => void
  suffix?: string
  className?: string
}) {
  const v = value ?? defaultValue
  const clamp = (n: number) => {
    let x = n
    if (min != null) x = Math.max(min, x)
    if (max != null) x = Math.min(max, x)
    return x
  }
  const commit = (n: number) => {
    const clamped = clamp(n)
    onChange(unsetAt != null && clamped === unsetAt ? undefined : clamped)
  }
  return (
    <div className={cn('inline-flex h-7 items-center rounded-lg border border-app-border bg-app-surface overflow-hidden', className)}>
      <button
        type="button" onClick={() => commit(v - step)} disabled={min != null && v <= min}
        className="h-full w-7 flex items-center justify-center shrink-0 text-gray-400 hover:text-gray-100 hover:bg-app-cardHover disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400"
      >
        <Minus size={11} />
      </button>
      <input
        type="number"
        value={v}
        onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n)) commit(n) }}
        className="w-9 shrink-0 border-x border-app-border bg-transparent text-center text-xs text-gray-200 outline-none tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="px-1.5 text-[10px] text-gray-500 shrink-0">{suffix}</span>}
      <button
        type="button" onClick={() => commit(v + step)} disabled={max != null && v >= max}
        className="h-full w-7 flex items-center justify-center shrink-0 text-gray-400 hover:text-gray-100 hover:bg-app-cardHover disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400"
      >
        <Plus size={11} />
      </button>
    </div>
  )
}

// Alinhamento horizontal (esquerda/centro/direita) — usado pelo Título/
// Subtítulo/Linhas/Colunas (via TextFormatEditor abaixo), pelo valor do KPI e
// pela Tabela (tableFormat.align). `undefined` = padrão de cada consumidor
// (o próprio botão "Esquerda" já marca como ativo nesse caso, mas o valor
// salvo continua ausente até alguém clicar de propósito).
function AlignButtons({ value, onChange }: { value: 'left' | 'center' | 'right' | undefined; onChange: (a: 'left' | 'center' | 'right') => void }) {
  return (
    <div className="flex gap-1.5">
      {(['left', 'center', 'right'] as const).map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onChange(a)}
          className={cn(
            'flex-1 px-2 py-1.5 rounded-lg border text-[11px] font-medium capitalize',
            (value ?? 'left') === a ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400',
          )}
        >
          {a === 'left' ? 'Esquerda' : a === 'center' ? 'Centro' : 'Direita'}
        </button>
      ))}
    </div>
  )
}

// Editor genérico de TextFormat — reusado pelo Título/Subtítulo, Eixo X/Eixo Y
// (gráficos) e Linhas/Colunas (Matriz). Cada botão "nenhuma"/"padrão" (X)
// volta o campo pra undefined em vez de fixar uma cor, deixando o renderer
// usar o padrão dele. O slider de opacidade só aparece quando a cor
// correspondente está definida (senão não haveria nada pra "desbotar").
// `showAlign`: só Título/Subtítulo/Linhas/Colunas mostram o controle de
// alinhamento — Eixo X/Y (rótulo ancorado à escala) e Legenda (linha de
// itens lado a lado) não têm um "dentro de que largura alinhar" que faça
// sentido, então ficam sem a opção em vez de mostrar um controle sem efeito.
function TextFormatEditor({ value, onChange, showAlign }: { value: TextFormat | undefined; onChange: (v: TextFormat | undefined) => void; showAlign?: boolean }) {
  const v = value ?? {}
  const patch = (p: Partial<TextFormat>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <NumberStepper value={v.fontSize} defaultValue={11} min={8} max={24} onChange={(n) => patch({ fontSize: n })} />
        <button type="button" onClick={() => patch({ bold: !v.bold })} className={cn('h-7 w-7 rounded-lg border text-[11px] font-bold', v.bold ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}>N</button>
        <button type="button" onClick={() => patch({ italic: !v.italic })} className={cn('h-7 w-7 rounded-lg border text-[11px] italic', v.italic ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}>I</button>
        <button type="button" onClick={() => patch({ underline: !v.underline })} className={cn('h-7 w-7 rounded-lg border text-[11px] underline', v.underline ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}>S</button>
      </div>
      <div>
        <span className="text-[9px] text-gray-500">Cor do texto</span>
        <div className="flex gap-1 mt-0.5 flex-wrap">
          <button type="button" onClick={() => patch({ color: undefined, opacity: undefined })} title="Padrão" className={cn(swatchCls(!v.color), 'bg-app-surface flex items-center justify-center')}>
            {!v.color && <X size={9} className="text-gray-500" />}
          </button>
          {COLORS.map((c) => (<button type="button" key={c} onClick={() => patch({ color: c })} className={swatchCls(v.color === c)} style={{ background: c }} />))}
        </div>
        {v.color && <div className="mt-1"><OpacitySlider value={v.opacity} onChange={(o) => patch({ opacity: o })} /></div>}
      </div>
      <div>
        <span className="text-[9px] text-gray-500">Cor de fundo</span>
        <div className="flex gap-1 mt-0.5 flex-wrap">
          <button type="button" onClick={() => patch({ backgroundColor: undefined, backgroundOpacity: undefined })} title="Nenhuma" className={cn(swatchCls(!v.backgroundColor), 'bg-app-surface flex items-center justify-center')}>
            {!v.backgroundColor && <X size={9} className="text-gray-500" />}
          </button>
          {COLORS.map((c) => (<button type="button" key={c} onClick={() => patch({ backgroundColor: c })} className={swatchCls(v.backgroundColor === c)} style={{ background: c }} />))}
        </div>
        {v.backgroundColor && <div className="mt-1"><OpacitySlider value={v.backgroundOpacity} onChange={(o) => patch({ backgroundOpacity: o })} /></div>}
      </div>
      {showAlign && (
        <div>
          <span className="text-[9px] text-gray-500">Alinhamento</span>
          <div className="mt-0.5"><AlignButtons value={v.align} onChange={(a) => patch({ align: a })} /></div>
        </div>
      )}
    </div>
  )
}

// Recuo manual do eixo (TextFormat.margin) — some por cima do espaço
// reservado calculado automaticamente (ver axisSize em WidgetRenderer.tsx).
// Fica fora do TextFormatEditor genérico porque só faz sentido pra Eixo X/
// Eixo Y (Título/Subtítulo/Matriz não reservam espaço nenhum pro próprio
// texto). 0 = sem ajuste manual (undefined), pra não gravar um valor "vazio".
function AxisMarginField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <div className="pt-2 mt-2 border-t border-app-border">
      <Field label={label} info="Some (ou, com valor negativo, subtrai) pixels ao espaço reservado automaticamente para o texto do eixo — use quando um número grande ainda aparecer cortado, ou pra apertar o espaço se o automático estiver reservando mais do que precisa.">
        <NumberStepper value={value} defaultValue={0} step={4} unsetAt={0} suffix="px" onChange={onChange} />
      </Field>
    </div>
  )
}

const OPERATOR_OPTIONS: ConditionalOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq']

const APPLY_TO_OPTIONS: { key: NonNullable<ConditionalRule['effect']['applyTo']>; label: string }[] = [
  { key: 'bar', label: 'Barra' },
  { key: 'label', label: 'Rótulo' },
  { key: 'both', label: 'Ambos' },
]

// Velocidade do piscar (ver BlinkSpeed, types.ts) — compartilhado pelos dois
// motores de regra (numérico e de texto da tabela), sempre ao lado do
// checkbox "Piscar", só visível com ele marcado.
const BLINK_SPEED_OPTIONS: { key: BlinkSpeed; label: string }[] = [
  { key: 'slower', label: 'Super lento' },
  { key: 'slow', label: 'Lento' },
  { key: 'normal', label: 'Normal' },
  { key: 'fast', label: 'Rápido' },
  { key: 'faster', label: 'Super rápido' },
]

function BlinkSpeedSelect({ value, onChange }: { value: BlinkSpeed | undefined; onChange: (v: BlinkSpeed | undefined) => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-gray-300">
      Velocidade
      <select
        value={value ?? 'normal'}
        onChange={(e) => { const v = e.target.value as BlinkSpeed; onChange(v === 'normal' ? undefined : v) }}
        className={cn(inputCls, 'text-[11px] w-auto py-0.5')}
      >
        {BLINK_SPEED_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    </label>
  )
}

// Mesma escala de 5 níveis do piscar (BLINK_SPEED_OPTIONS), mantida como
// lista própria — tipo (ChartAnimationSpeed) e duração-base (CHART_ANIM_MS,
// WidgetRenderer.tsx) são independentes do piscar de propósito.
const CHART_ANIMATION_SPEED_OPTIONS: { key: ChartAnimationSpeed; label: string }[] = [
  { key: 'slower', label: 'Super lento' },
  { key: 'slow', label: 'Lento' },
  { key: 'normal', label: 'Normal' },
  { key: 'fast', label: 'Rápido' },
  { key: 'faster', label: 'Super rápido' },
]

// "Gráfico dinâmico" — liga/desliga + velocidade, mesmo par de controles em
// todo tipo com forma pra desenhar (ver hasDataLabels no ponto de uso).
function DynamicAnimationEditor({ enabled, speed, onChange }: {
  enabled: boolean | undefined
  speed: ChartAnimationSpeed | undefined
  onChange: (enabled: boolean, speed: ChartAnimationSpeed | undefined) => void
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Ativar</span>
        <button
          type="button"
          onClick={() => onChange(!enabled, enabled ? undefined : speed)}
          className={cn('relative h-5 w-9 rounded-full transition-colors', enabled ? 'bg-brand-blue' : 'bg-app-border')}
        >
          <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform" style={{ transform: enabled ? 'translateX(16px)' : 'translateX(0)' }} />
        </button>
      </label>
      {enabled && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-gray-500 shrink-0">Velocidade do ciclo</span>
          <select
            value={speed ?? 'normal'}
            onChange={(e) => { const v = e.target.value as ChartAnimationSpeed; onChange(true, v === 'normal' ? undefined : v) }}
            className={cn(inputCls, 'text-[11px] w-auto py-0.5')}
          >
            {CHART_ANIMATION_SPEED_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}

// Lista de regras do motor de formatação condicional (ver conditionalFormat.ts)
// — cada uma "se o valor for {operador} {número}, aplica {efeito}". `showGlow`
// só faz sentido pro KPI (é a única forma de widget onde o brilho realmente
// aparece — ver ChartFrame/conditionalStyle no WidgetRenderer). `showTarget`
// só faz sentido nos tipos de barra que têm barra E rótulo de dados como
// elementos SEPARADOS (bar/barH/barStacked/barHStacked/comboBarLine/
// histograma) — KPI (é um card só) e Matriz (a célula É o rótulo) não têm
// essa distinção, então não mostram o controle.
function ConditionalRulesEditor({ rules, onChange, showGlow, showTarget }: {
  rules: ConditionalRule[]
  onChange: (rules: ConditionalRule[]) => void
  showGlow?: boolean
  showTarget?: boolean
}) {
  const update = (i: number, patch: Partial<ConditionalRule>) =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const updateEffect = (i: number, patch: Partial<ConditionalRule['effect']>) =>
    update(i, { effect: { ...rules[i].effect, ...patch } })
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i))
  const add = () => onChange([...rules, { id: `r-${Date.now().toString(36)}`, operator: 'gte', value: 0, effect: { backgroundColor: '#10b981' } }])

  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Regras</span>
      <p className="text-[10px] text-gray-500 -mt-0.5">Avaliadas na ordem da lista — a última que bater vence.</p>
      {rules.length === 0 && <p className="text-[10px] text-gray-500 py-1">Nenhuma regra ainda.</p>}
      {rules.map((r, i) => (
        <div key={r.id} className="rounded-lg border border-dashed border-app-border p-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 shrink-0">Se o valor for</span>
            <select value={r.operator} onChange={(e) => update(i, { operator: e.target.value as ConditionalOperator })} className={cn(inputCls, 'text-[11px] w-auto')}>
              {OPERATOR_OPTIONS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
            </select>
            <input
              type="number" value={r.value}
              onChange={(e) => update(i, { value: Number(e.target.value) || 0 })}
              className={cn(inputCls, 'w-20 text-[11px]')}
            />
            <button onClick={() => remove(i)} className="ml-auto h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical shrink-0"><X size={12} /></button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-gray-500">aplica:</span>
            <div className="flex gap-1 flex-wrap">
              <button type="button" onClick={() => updateEffect(i, { backgroundColor: undefined })} title="Nenhuma" className={cn(swatchCls(!r.effect.backgroundColor), 'bg-app-surface flex items-center justify-center')}>
                {!r.effect.backgroundColor && <X size={9} className="text-gray-500" />}
              </button>
              {COLORS.map((c) => (
                <button type="button" key={c} onClick={() => updateEffect(i, { backgroundColor: c })} className={swatchCls(r.effect.backgroundColor === c)} style={{ background: c }} />
              ))}
            </div>
            <label className="flex items-center gap-1 text-[11px] text-gray-300">
              <input type="checkbox" checked={!!r.effect.blink} onChange={(e) => updateEffect(i, { blink: e.target.checked || undefined, blinkSpeed: e.target.checked ? r.effect.blinkSpeed : undefined })} className="accent-[#ffb000]" />
              Piscar
            </label>
            {r.effect.blink && <BlinkSpeedSelect value={r.effect.blinkSpeed} onChange={(v) => updateEffect(i, { blinkSpeed: v })} />}
            {showGlow && (
              <label className="flex items-center gap-1 text-[11px] text-gray-300">
                <input type="checkbox" checked={!!r.effect.glow} onChange={(e) => updateEffect(i, { glow: e.target.checked || undefined })} className="accent-[#ffb000]" />
                Brilho
              </label>
            )}
          </div>
          {showTarget && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="flex items-center gap-1 text-[10px] text-gray-500 shrink-0">
                Aplica em
                <InfoHint text="Onde a cor e o piscar desta regra aparecem: só na barra (o rótulo fica na cor de sempre), só no rótulo (a barra fica na cor de sempre), ou nos dois — sincronizados." />
              </span>
              <div className="flex gap-1">
                {APPLY_TO_OPTIONS.map((o) => (
                  <button
                    key={o.key} type="button"
                    onClick={() => updateEffect(i, { applyTo: o.key })}
                    className={cn(
                      'px-2 py-1 rounded-lg border text-[10px] font-medium',
                      (r.effect.applyTo ?? 'both') === o.key ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
      <button onClick={add} className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight">
        <Plus size={12} /> Adicionar regra
      </button>
    </div>
  )
}

const TABLE_RULE_OPERATORS: { key: TableRuleOperator; label: string }[] = [
  { key: 'equals', label: 'é igual a' },
  { key: 'contains', label: 'contém' },
]

const TABLE_RULE_APPLY_TO_OPTIONS: { key: NonNullable<TableConditionalRule['applyTo']>; label: string }[] = [
  { key: 'cell', label: 'Célula' },
  { key: 'row', label: 'Linha inteira' },
]

// Formatação condicional da Tabela — motor separado do ConditionalRulesEditor
// acima: compara TEXTO de célula por coluna, não valor numérico (ver
// conditionalFormat.ts). Sem diferenciar maiúsculas/minúsculas de propósito.
function TableConditionalRulesEditor({ rules, onChange, columns }: {
  rules: TableConditionalRule[]
  onChange: (rules: TableConditionalRule[]) => void
  columns: { key: string; label: string }[]
}) {
  const update = (i: number, patch: Partial<TableConditionalRule>) =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i))
  const add = () => onChange([...rules, { id: `tr-${Date.now().toString(36)}`, column: columns[0]?.key ?? '', operator: 'equals', match: '', color: '#10b981' }])

  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Regras por coluna</span>
      <p className="text-[10px] text-gray-500 -mt-0.5">Avaliadas na ordem da lista — a última que bater, na mesma coluna, vence. Não diferencia maiúsculas de minúsculas.</p>
      {columns.length === 0 && <p className="text-[10px] text-gray-500 py-1">Adicione colunas à tabela primeiro.</p>}
      {rules.length === 0 && columns.length > 0 && <p className="text-[10px] text-gray-500 py-1">Nenhuma regra ainda.</p>}
      {rules.map((r, i) => (
        <div key={r.id} className="rounded-lg border border-dashed border-app-border p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <select value={r.column} onChange={(e) => update(i, { column: e.target.value })} className={cn(inputCls, 'text-[11px] w-auto')}>
              {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <select value={r.operator} onChange={(e) => update(i, { operator: e.target.value as TableRuleOperator })} className={cn(inputCls, 'text-[11px] w-auto')}>
              {TABLE_RULE_OPERATORS.map((op) => <option key={op.key} value={op.key}>{op.label}</option>)}
            </select>
            <input
              value={r.match} onChange={(e) => update(i, { match: e.target.value })}
              placeholder="palavra, frase ou valor" className={cn(inputCls, 'flex-1 min-w-[8rem] text-[11px]')}
            />
            <button onClick={() => remove(i)} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical shrink-0"><X size={12} /></button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-gray-500 shrink-0">cor da fonte:</span>
            <div className="flex gap-1 flex-wrap">
              <button type="button" onClick={() => update(i, { color: undefined })} title="Padrão" className={cn(swatchCls(!r.color), 'bg-app-surface flex items-center justify-center')}>
                {!r.color && <X size={9} className="text-gray-500" />}
              </button>
              {COLORS.map((c) => (
                <button type="button" key={c} onClick={() => update(i, { color: c })} className={swatchCls(r.color === c)} style={{ background: c }} />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-gray-500 shrink-0">cor de fundo:</span>
            <div className="flex gap-1 flex-wrap">
              <button type="button" onClick={() => update(i, { backgroundColor: undefined })} title="Nenhuma" className={cn(swatchCls(!r.backgroundColor), 'bg-app-surface flex items-center justify-center')}>
                {!r.backgroundColor && <X size={9} className="text-gray-500" />}
              </button>
              {COLORS.map((c) => (
                <button type="button" key={c} onClick={() => update(i, { backgroundColor: c })} className={swatchCls(r.backgroundColor === c)} style={{ background: c }} />
              ))}
            </div>
            <label className="flex items-center gap-1 text-[11px] text-gray-300">
              <input type="checkbox" checked={!!r.blink} onChange={(e) => update(i, { blink: e.target.checked || undefined, blinkSpeed: e.target.checked ? r.blinkSpeed : undefined })} className="accent-[#ffb000]" />
              Piscar
            </label>
            {r.blink && <BlinkSpeedSelect value={r.blinkSpeed} onChange={(v) => update(i, { blinkSpeed: v })} />}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="flex items-center gap-1 text-[10px] text-gray-500 shrink-0">
              Aplica em
              <InfoHint text="Célula: só a célula que bateu com a regra muda de cor/pisca. Linha inteira: quando a coluna escolhida bate, a linha toda (todas as colunas) recebe a mesma cor/pisca." />
            </span>
            <div className="flex gap-1">
              {TABLE_RULE_APPLY_TO_OPTIONS.map((o) => (
                <button
                  key={o.key} type="button"
                  onClick={() => update(i, { applyTo: o.key })}
                  className={cn(
                    'px-2 py-1 rounded-lg border text-[10px] font-medium',
                    (r.applyTo ?? 'cell') === o.key ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ))}
      <button onClick={add} disabled={columns.length === 0} className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight disabled:opacity-40">
        <Plus size={12} /> Adicionar regra
      </button>
    </div>
  )
}

const LABEL_POSITIONS: { key: NonNullable<DataLabelFormat['position']>; label: string }[] = [
  { key: 'inside', label: 'Dentro' },
  { key: 'outside', label: 'Fora' },
  { key: 'top', label: 'Em cima' },
  { key: 'center', label: 'Centro' },
]
const LABEL_CONTENTS: { key: NonNullable<DataLabelFormat['content']>; label: string }[] = [
  { key: 'value', label: 'Só números' },
  { key: 'name', label: 'Nome do rótulo' },
  { key: 'percent', label: 'Percentual (%)' },
  { key: 'valueAndName', label: 'Nome + número' },
  { key: 'all', label: 'Nome + número + %' },
]

function DataLabelsEditor({ value, onChange, isStacked }: { value: DataLabelFormat | undefined; onChange: (v: DataLabelFormat | undefined) => void; isStacked?: boolean }) {
  const v = value ?? {}
  const patch = (p: Partial<DataLabelFormat>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-gray-400">Mostrar rótulos sobre o gráfico</span>
        {/* transform via style (não classe arbitrária do Tailwind) e type="button"
            explícito — o mesmo padrão de toggle acima quebrava visualmente em
            alguns casos; isso remove qualquer dependência de geração de classe
            em runtime pro deslocamento do círculo. */}
        <button
          type="button"
          onClick={() => patch({ show: !v.show })}
          className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0', v.show ? 'bg-brand-blue' : 'bg-app-border')}
        >
          <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform" style={{ transform: v.show ? 'translateX(16px)' : 'translateX(0)' }} />
        </button>
      </label>
      {v.show && isStacked && (
        <p className="flex items-start gap-1 text-[10px] text-gray-500 pt-1 border-t border-app-border">
          <InfoHint text="Empilhada com várias séries, um rótulo por segmento se sobrepõe e quebra a leitura — por isso, aqui, é sempre o total da pilha, sem opção de mostrar por segmento." />
          Colunas/barras empilhadas sempre mostram o <strong className="text-gray-400">total da pilha</strong>, não um rótulo por série.
        </p>
      )}
      {v.show && (
        <>
          {/* Empilhado é sempre o total, sempre acima da pilha inteira — não
              existe "dentro"/"centro" de um total que não é um segmento
              real, então "Posição" some (controle sem efeito é pior que
              nenhum controle). */}
          {!isStacked && (
          <div>
            <span className="text-[9px] text-gray-500">Posição</span>
            <div className="grid grid-cols-4 gap-1 mt-0.5">
              {LABEL_POSITIONS.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  onClick={() => patch({ position: p.key })}
                  className={cn('px-1 py-1 rounded-lg border text-[10px] font-medium', (v.position ?? 'outside') === p.key ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          )}
          <div>
            <span className="text-[9px] text-gray-500">Conteúdo</span>
            <div className="grid grid-cols-2 gap-1 mt-0.5">
              {LABEL_CONTENTS.map((c) => (
                <button
                  type="button"
                  key={c.key}
                  onClick={() => patch({ content: c.key })}
                  className={cn('px-1.5 py-1 rounded-lg border text-[10px] font-medium', (v.content ?? 'value') === c.key ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-[9px] text-gray-500">Cor da fonte</span>
            <div className="flex gap-1 mt-0.5 flex-wrap">
              <button type="button" onClick={() => patch({ color: undefined, opacity: undefined })} title="Padrão" className={cn(swatchCls(!v.color), 'bg-app-surface flex items-center justify-center')}>
                {!v.color && <X size={9} className="text-gray-500" />}
              </button>
              {COLORS.map((c) => (<button type="button" key={c} onClick={() => patch({ color: c })} className={swatchCls(v.color === c)} style={{ background: c }} />))}
            </div>
            {v.color && <div className="mt-1"><OpacitySlider value={v.opacity} onChange={(o) => patch({ opacity: o })} /></div>}
          </div>
          <Field label="Tamanho da fonte (px)">
            <NumberStepper value={v.fontSize} defaultValue={10} min={8} max={24} onChange={(n) => patch({ fontSize: n })} />
          </Field>
        </>
      )}
    </div>
  )
}

const AGG_LABELS_SHORT: Record<string, string> = { countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média' }
function seriesLabelFallback(m: MeasureConfig): string {
  if (m.label) return m.label
  const agg = AGG_LABELS_SHORT[m.agg] ?? m.agg
  return m.field ? `${agg} de ${m.field}` : agg
}

// Override do "Rótulos de dados" (acima) por série — só aparece com 2+ séries
// (Eixo Y com múltiplas medidas e/ou "Eixo Y - Linha" do combo), já que com
// uma série só o padrão do widget já É o rótulo daquela série.
function SeriesLabelOverridesEditor({ items }: {
  items: { key: string; label: string; dataLabels: DataLabelFormat | undefined; onChange: (v: DataLabelFormat | undefined) => void }[]
}) {
  if (items.length < 2) return null
  return (
    <div className="mt-3 pt-3 border-t border-app-border space-y-1.5">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Por série</span>
      <p className="text-[10px] text-gray-500 -mt-0.5">Sobrescreve o padrão acima só numa série específica.</p>
      {items.map((it) => (
        <label key={it.key} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-gray-300 truncate">{it.label}</span>
          <select
            value={it.dataLabels?.show === undefined ? 'default' : it.dataLabels.show ? 'on' : 'off'}
            onChange={(e) => {
              const v = e.target.value
              it.onChange(v === 'default' ? undefined : { ...it.dataLabels, show: v === 'on' })
            }}
            className={cn(inputCls, 'w-36 text-[11px]')}
          >
            <option value="default">Padrão acima</option>
            <option value="on">Sempre mostrar</option>
            <option value="off">Nunca mostrar</option>
          </select>
        </label>
      ))}
    </div>
  )
}

// [&::-webkit-*-spin-button] / [appearance:textfield]: tira a seta nativa de
// aumentar/diminuir do navegador em <input type="number"> — inconsistente
// entre navegadores e minúscula demais pra clicar de propósito (relatado
// pelo usuário com print). Não afeta input de texto (a regra só bate em
// number). Onde faz sentido incrementar/decrementar, ver NumberStepper.
const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
const tabBtnCls = (active: boolean) => cn(
  'flex-1 px-3 py-2 text-[11px] font-semibold border-b-2 transition-colors',
  active ? 'border-brand-blue text-brand-blue' : 'border-transparent text-gray-500 hover:text-gray-300',
)

// "Hierarquia de datas" (estilo Power BI) — os 4 níveis de um campo de data,
// sempre nesta ordem (Ano é a "raiz", os demais entram indentados e
// marcados `toggle: true` — ver AxisFieldGroup, AxisFieldPicker.tsx — pra
// dar pra marcar/desmarcar qualquer combinação direto na árvore, sem
// precisar achar o chip lá em cima pra remover). Mesma lista de campos pra
// qualquer papel que aceite bucket de data (Eixo X, Legenda, Linhas/Colunas
// da Matriz — todos usam `dateBuckets: true` em buildGroups, e Colunas da
// Tabela via tableColumnFields). Função pura de módulo (não do componente)
// de propósito — não depende de nada do widget sendo editado.
export const HIERARCHY_LEVELS: { bucket: 'year' | 'quarter' | 'month' | 'day'; label: string }[] = [
  { bucket: 'year', label: 'Ano' },
  { bucket: 'quarter', label: 'Trimestre' },
  { bucket: 'month', label: 'Mês' },
  { bucket: 'day', label: 'Dia' },
]
export function hierarchyFields(outKey: string, fieldLabel: string, description: string | undefined) {
  return HIERARCHY_LEVELS.map(({ bucket, label }) => ({
    key: `${bucket}:${outKey}`,
    label: `${fieldLabel} · ${label}`,
    description,
    indent: bucket !== 'year',
    toggle: bucket !== 'year',
  }))
}

const HIERARCHY_KEY_RE = /^(year|quarter|month|day):(.+)$/
const HIERARCHY_RANK: Record<string, number> = { year: 0, quarter: 1, month: 2, day: 3 }

// Adiciona uma chave a um array de dimensões (Eixo X/Linhas/Colunas da
// Matriz) — se for um nível da Hierarquia de datas, reordena TODOS os
// níveis já presentes do MESMO campo pra ordem canônica Ano→Trimestre→
// Mês→Dia, não importa em que ordem o usuário marcou as caixinhas. Sem
// isso, marcar "Dia" antes de "Ano" deixaria o rótulo composto ao
// contrário ("05 / 2026" em vez de "2026 / 05") — a AGREGAÇÃO continuaria
// correta (compositeDimensionFn não depende de ordem pra detectar
// hierarquia), só o texto exibido ficaria estranho. Campo comum (sem
// prefixo de bucket) só é anexado no fim, como sempre. Preserva a posição
// de qualquer campo NÃO relacionado (ex. misturar uma categoria com a
// hierarquia no mesmo Eixo X).
export function addDimensionKey(current: string[], newKey: string): string[] {
  const m = HIERARCHY_KEY_RE.exec(newKey)
  if (!m) return [...current, newKey]
  const field = m[2]
  const isSibling = (k: string) => HIERARCHY_KEY_RE.exec(k)?.[2] === field
  const rankOf = (k: string) => HIERARCHY_RANK[HIERARCHY_KEY_RE.exec(k)![1]]
  const siblings = [...current.filter(isSibling), newKey].sort((a, b) => rankOf(a) - rankOf(b))
  if (!current.some(isSibling)) return [...current, ...siblings]
  const result: string[] = []
  let inserted = false
  for (const k of current) {
    if (isSibling(k)) { if (!inserted) { result.push(...siblings); inserted = true } }
    else result.push(k)
  }
  return result
}

// Colunas da Tabela: diferente do Eixo X/Legenda/Matriz (nunca oferecem a
// data CRUA, só os buckets — um eixo com 1 bar por timestamp exato não serve
// pra nada), a Tabela pode querer as DUAS coisas: a data linha a linha (ex.
// "Data Criado" como está) E/OU a Hierarquia de datas como colunas extras
// (Ano/Trimestre/Mês/Dia) — por isso aqui o campo de data continua na
// lista, com os 4 níveis logo depois dele. Inclui campo mesclado de outra
// fonte (lookups) com o mesmo tratamento — senão um campo trazido via
// "Mesclar campo de outra fonte" nunca aparecia como coluna da Tabela,
// ainda que já funcionasse normalmente em Eixo X/Legenda/Matriz.
export function buildTableColumnFields(
  sourceDef: { fields: { key: string; label: string; kind: FieldKind; description?: string }[] } | undefined,
  lookups: LookupColumn[] | undefined,
  resolveLookupSource: (source: SourceTable) => { fields: { key: string; kind: FieldKind; description?: string }[] } | undefined,
) {
  const fields: { key: string; label: string; description?: string }[] = []
  if (sourceDef) {
    for (const f of sourceDef.fields) {
      fields.push({ key: f.key, label: f.label, description: f.description })
      if (f.kind === 'date') fields.push(...hierarchyFields(f.key, f.label, f.description))
    }
  }
  for (const lk of lookups ?? []) {
    const lkDef = resolveLookupSource(lk.source)
    const lkField = lkDef?.fields.find((f) => f.key === lk.field)
    const outKey = `${lk.source}.${lk.field}`
    fields.push({ key: outKey, label: lk.label, description: lkField?.description })
    if (lkField?.kind === 'date') fields.push(...hierarchyFields(outKey, lk.label, lkField?.description))
  }
  return fields
}

// Filtra os grupos da Legenda a partir dos mesmos grupos do Eixo X
// (axisGroups): remove a chave exata já usada como dimensão do Eixo X E
// qualquer OUTRO nível da Hierarquia de datas do MESMO campo (ex. Eixo X =
// Ano+Mês não pode deixar Trimestre/Dia do mesmo campo ainda escolhíveis na
// Legenda — seria uma 2ª quebra da mesma data já usada pra agrupar o
// próprio gráfico, sem nenhum sentido).
export function filterLegendGroups(axisGroups: AxisFieldGroup[], dimensions: string[] | undefined): AxisFieldGroup[] {
  const usedKeys = new Set(dimensions ?? [])
  const usedHierarchyFields = new Set(
    Array.from(usedKeys, (k) => HIERARCHY_KEY_RE.exec(k)?.[2]).filter((f): f is string => !!f),
  )
  return axisGroups
    .map((g) => ({
      ...g,
      fields: g.fields.filter((f) => {
        if (usedKeys.has(f.key)) return false
        const base = HIERARCHY_KEY_RE.exec(f.key)?.[2]
        return !(base && usedHierarchyFields.has(base))
      }),
    }))
    .filter((g) => g.foreign || g.fields.length > 0)
}

export function WidgetEditorModal({ initial, newWidgetDefaults, onSave, onClose, onChange, onSourcesChanged }: Props) {
  const sources = getAllSources()
  const currentEmail = useAuthStore((s) => s.user?.email ?? null)
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const [tabView, setTabView] = useState<'dados' | 'modificadores' | 'formato'>('dados')
  const [draft, setDraft] = useState<WidgetConfig>(initial ?? {
    id: `w-${Date.now().toString(36)}`,
    type: 'bar',
    title: 'Novo widget',
    source: sources[0]?.key,
    limit: 15,
    // Dobrado (26/08/2026) junto com a resolução da grade — ver ROW_HEIGHT/
    // GRID_COLS em DashboardBuilder.tsx.
    layout: { x: 0, y: 0, w: 12, h: 10 },
    ...newWidgetDefaults,
    // Widget novo: se o tipo suporta rótulo de dados, já nasce ativado —
    // hoje o usuário tinha que entrar em Formato > Rótulos de dados e ligar
    // manualmente toda vez.
    dataLabels: { show: true, ...newWidgetDefaults?.dataLabels },
  })
  const [preview, setPreview] = useState<WidgetDataPoint[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // Edição de UM filtro fixo (v1 pragmática: um filtro por widget cobre os
  // casos do default, ex. "status in [Cancelado]"; múltiplos via JSON depois).
  const [filterValues, setFilterValues] = useState<string[] | null>(null)
  // Rascunho de uma nova coluna mesclada (lookup) — só para widgets 'table'.
  const [lookupDraft, setLookupDraft] = useState<{ source: SourceTable | ''; localKey: string; foreignKey: string; field: string }>(
    { source: '', localKey: '', foreignKey: '', field: '' },
  )

  // Planilhas do Google já cadastradas (qualquer usuário pode adicionar a
  // sua — ver server/sheetSources.mjs) — carregadas uma vez, ao abrir o
  // editor, pra alimentar a seção "Planilhas do Google" em Modificadores.
  const [sheetSources, setSheetSources] = useState<SheetSource[]>([])
  const [sheetForm, setSheetForm] = useState<{ open: boolean; label: string; url: string; sheetName: string }>(
    { open: false, label: '', url: '', sheetName: '' },
  )
  const [sheetSaving, setSheetSaving] = useState(false)
  const [sheetError, setSheetError] = useState<string | null>(null)
  const [sheetBusyId, setSheetBusyId] = useState<string | null>(null)

  const loadSheetSources = () => { fetchSheetSources().then(setSheetSources).catch(() => {}) }
  useEffect(loadSheetSources, [])

  const handleAddSheet = async () => {
    setSheetError(null)
    setSheetSaving(true)
    try {
      await createSheetSource({ label: sheetForm.label, url: sheetForm.url, sheetName: sheetForm.sheetName || undefined })
      setSheetForm({ open: false, label: '', url: '', sheetName: '' })
      loadSheetSources()
      await onSourcesChanged?.()
    } catch (e) {
      setSheetError(e instanceof SheetApiError ? e.message : 'Não foi possível adicionar a planilha.')
    } finally {
      setSheetSaving(false)
    }
  }

  const handleRemoveSheet = async (id: string) => {
    setSheetBusyId(id)
    setSheetError(null)
    try {
      await deleteSheetSource(id)
      loadSheetSources()
      await onSourcesChanged?.()
    } catch (e) {
      setSheetError(e instanceof SheetApiError ? e.message : 'Não foi possível remover a planilha.')
    } finally {
      setSheetBusyId(null)
    }
  }

  const handleRefreshSheet = async (id: string) => {
    setSheetBusyId(id)
    setSheetError(null)
    try {
      await refreshSheetSource(id)
      loadSheetSources()
      await onSourcesChanged?.()
    } catch (e) {
      setSheetError(e instanceof SheetApiError ? e.message : 'Não foi possível atualizar a planilha.')
    } finally {
      setSheetBusyId(null)
    }
  }

  // Seções do Formato começam todas fechadas — só o cabeçalho some visível
  // até o usuário clicar pra ajustar (evita uma aba gigante e sempre expandida).
  const [openSections, setOpenSections] = useState<Set<string>>(new Set())
  const toggleSection = (id: string) => setOpenSections((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const set = (patch: Partial<WidgetConfig>) => setDraft((d) => ({ ...d, ...patch }))

  // Toda alteração no rascunho já sobe pro pai (pré-visualização em tempo
  // real no gráfico/tabela por trás do painel) — independente de "canSave"
  // (ex. título vazio), já que a prévia é só visual e nunca persiste nada.
  useEffect(() => { onChange?.(draft) }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const sourceDef = draft.source ? getSourceDef(draft.source) : undefined
  const isHistogram = draft.type === 'histogram'
  const isTable = draft.type === 'table'
  const isMatrix = draft.type === 'matrix'
  const isText = draft.type === 'text'
  const isKpi = draft.type === 'kpi'
  // Widget de texto não tem fonte de dados — a aba "Modificadores" (mesclar
  // fonte, filtro fixo) não se aplica, então some do editor pra esse tipo.
  useEffect(() => { if (isText && tabView === 'modificadores') setTabView('dados') }, [isText, tabView])
  const hasAxes = AXIS_TYPES.includes(draft.type)
  const hasDataLabels = DATA_LABEL_TYPES.includes(draft.type)
  const wf = draft.widgetFilters?.[0]

  // Campos mesclados de outras fontes (widget.lookups) — cada um vira uma
  // opção a mais nos pickers de Eixo X/Eixo Y/Legenda/Filtro, como se fosse
  // um campo nativo da fonte principal. `kind` é resolvido no catálogo da
  // fonte relacionada (já carregado no front via getAllSources/registerDynamicSources).
  const lookupFieldMeta = useMemo(() => (draft.lookups ?? []).map((lk) => {
    const f = getSourceDef(lk.source)?.fields.find((f) => f.key === lk.field)
    return { key: `${lk.source}.${lk.field}`, label: lk.label, kind: f?.kind, description: f?.description }
  }), [draft.lookups])

  const filterableFields = useMemo(() => [
    ...(sourceDef?.fields.filter((f) => f.kind === 'dimension') ?? []),
    ...lookupFieldMeta.filter((lk) => lk.kind !== 'number'),
  ], [sourceDef, lookupFieldMeta])

  // Agrupa os campos disponíveis por FONTE (a principal do widget + cada uma
  // já mesclada em Modificadores) — alimenta o picker "Selecionar" de
  // Eixo X/Eixo Y/Legenda: clicar abre as fontes, clicar na fonte abre suas
  // colunas. `kindFilter` decide quais campos de cada fonte entram no papel
  // (dimensão/data para eixo/legenda; numérico só para soma/média; qualquer
  // um para contagem/contagem distinta). `dateBuckets` expande campo de data
  // na Hierarquia de datas (Ano/Trimestre/Mês/Dia — só faz sentido pra
  // eixo/legenda/matriz, não pra medida).
  const buildGroups = (kindFilter: (kind: FieldKind) => boolean, dateBuckets: boolean): AxisFieldGroup[] => {
    const groups: AxisFieldGroup[] = []
    if (sourceDef) {
      const fields: AxisFieldGroup['fields'] = []
      for (const f of sourceDef.fields) {
        if (!kindFilter(f.kind)) continue
        if (f.kind === 'date' && dateBuckets) fields.push(...hierarchyFields(f.key, f.label, f.description))
        else fields.push({ key: f.key, label: f.label, description: f.description })
      }
      if (fields.length) groups.push({ key: sourceDef.key, label: sourceDef.label, fields })
    }
    const bySource = new Map<string, AxisFieldGroup>()
    for (const lk of draft.lookups ?? []) {
      const lkDef = getSourceDef(lk.source)
      const lkField = lkDef?.fields.find((f) => f.key === lk.field)
      const kind = lkField?.kind ?? 'dimension'
      if (!kindFilter(kind)) continue
      const outKey = `${lk.source}.${lk.field}`
      let g = bySource.get(lk.source)
      if (!g) { g = { key: lk.source, label: lkDef?.label ?? lk.source, fields: [] }; bySource.set(lk.source, g) }
      if (kind === 'date' && dateBuckets) g.fields.push(...hierarchyFields(outKey, lk.label, lkField?.description))
      else g.fields.push({ key: outKey, label: lk.label, description: lkField?.description })
    }
    groups.push(...bySource.values())

    // Demais fontes cadastradas, ainda não usadas neste widget (nem
    // principal, nem mesclada) — aparecem pra deixar claro que existem, mas
    // sem colunas navegáveis: clicar troca a fonte principal do widget
    // (buildGroups reage a `sourceDef`, então os campos aparecem no lugar).
    const usedKeys = new Set([sourceDef?.key, ...bySource.keys()].filter(Boolean))
    for (const s of sources) {
      if (usedKeys.has(s.key)) continue
      groups.push({ key: s.key, label: s.label, fields: [], foreign: true })
    }
    return groups
  }

  // Troca a fonte principal do widget — reseta tudo que dependia da fonte
  // anterior (eixos, medidas, colunas, mesclagens, formatação de tabela e os
  // campos específicos da Matriz), já que nada disso é garantido existir na
  // nova fonte. Mesmo reset que o antigo picker de "Dados (fonte)" fazia.
  const switchSource = (key: string) => set({
    source: key,
    dimensions: undefined, legendDimension: undefined,
    measure: undefined, measures: undefined, measuresLine: undefined, measureX: undefined,
    widgetFilters: undefined, columns: undefined, lookups: undefined, tableFormat: undefined,
    matrixRows: undefined, matrixColumns: undefined, matrixValue: undefined,
    histogramField: undefined,
  })

  const axisGroups = useMemo(
    () => buildGroups((k) => k === 'dimension' || k === 'date', true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceDef, draft.lookups],
  )
  const legendGroups = useMemo(
    () => filterLegendGroups(axisGroups, draft.dimensions),
    [axisGroups, draft.dimensions],
  )
  const numberGroups = useMemo(
    () => buildGroups((k) => k === 'number', false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceDef, draft.lookups],
  )
  const countGroups = useMemo(
    () => buildGroups(() => true, false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceDef, draft.lookups],
  )
  // Colunas da Tabela: diferente do Eixo X/Legenda (buildGroups nunca
  // oferece a data CRUA, só os buckets — um eixo com 1 bar por timestamp
  // exato não serve pra nada), a Tabela pode querer as DUAS coisas: a data
  // linha a linha (ex. "Data Criado" como está) E/OU a Hierarquia de datas
  // como colunas extras (Ano/Trimestre/Mês/Dia) — por isso aqui o campo de
  // data continua na lista, com os 4 níveis logo depois dele.
  const tableColumnFields = useMemo(
    () => buildTableColumnFields(sourceDef, draft.lookups, getSourceDef),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceDef, draft.lookups],
  )

  // bar*/line/area/comboBarLine suportam múltiplas medidas (várias séries);
  // dentre esses, só bar*/line/area suportam também quebra por Legenda.
  // kpi/pie/scatter/funnel continuam com 1 medida só (draft.measure).
  const isBreakdownChart = MULTI_MEASURE_TYPES.includes(draft.type)
  const supportsLegend = LEGEND_TYPES.includes(draft.type)
  const hasLegend = supportsLegend && !!draft.legendDimension
  // Sem fallback pra placeholder — Eixo Y começa vazio (igual ao Eixo X) até
  // o usuário escolher um campo pela árvore "Selecionar"; o backend já lida
  // bem com measure/measures ausentes (assume contagem distinta da linha).
  const measuresList: MeasureConfig[] = draft.measures?.length ? draft.measures : (draft.measure ? [draft.measure] : [])
  const setMeasuresList = (list: MeasureConfig[]) => set({ measures: list.length ? list : undefined, measure: list[0] })
  const measuresLineList: MeasureConfig[] = draft.measuresLine ?? []
  const setMeasuresLineList = (list: MeasureConfig[]) => set({ measuresLine: list.length ? list : undefined })

  // Alimenta o "Por série" da seção Rótulos de dados (Formato) — junta as
  // medidas do Eixo Y (quando cada uma vira uma série de verdade, ou seja,
  // sem Legenda) com as da "Eixo Y - Linha" do combo, cada uma com seu
  // próprio setter de volta pro array certo (measures vs. measuresLine).
  const seriesLabelItems = useMemo(() => {
    const items: { key: string; label: string; dataLabels: DataLabelFormat | undefined; onChange: (v: DataLabelFormat | undefined) => void }[] = []
    if (isBreakdownChart && !hasLegend) {
      measuresList.forEach((m, i) => items.push({
        key: `m-${i}`, label: seriesLabelFallback(m), dataLabels: m.dataLabels,
        onChange: (v) => setMeasuresList(measuresList.map((mm, idx) => (idx === i ? { ...mm, dataLabels: v } : mm))),
      }))
    }
    if (draft.type === 'comboBarLine') {
      measuresLineList.forEach((m, i) => items.push({
        key: `l-${i}`, label: seriesLabelFallback(m), dataLabels: m.dataLabels,
        onChange: (v) => setMeasuresLineList(measuresLineList.map((mm, idx) => (idx === i ? { ...mm, dataLabels: v } : mm))),
      }))
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBreakdownChart, hasLegend, measuresList, measuresLineList, draft.type])

  useEffect(() => {
    setFilterValues(null)
    if (!wf || !draft.source) return
    fetchFieldValues(draft.source, wf.field).then(setFilterValues).catch(() => setFilterValues([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.source, wf?.field])

  const runPreview = () => {
    setPreview(null); setPreviewError(null)
    fetchWidgetData(draft, [], 1, 5)
      .then((d) => setPreview(d.points ?? (
        d.rows ? [{ label: `${d.total} linhas`, value: d.total ?? 0 }]
          : d.matrix ? [{ label: `${d.matrix.rows.length} linha(s) · ${d.matrix.columns.length} coluna(s)`, value: d.matrix.grandTotalAll }]
          : []
      )))
      .catch((e) => setPreviewError(e.message))
  }

  const lookupSourceDef = lookupDraft.source ? getSourceDef(lookupDraft.source) : undefined
  // Mesma fonte + mesmo campo já mesclado (chaves de junção diferentes ou
  // não) produziria um outKey e um rótulo idênticos aos de um lookup já
  // existente — duas entradas indistinguíveis na árvore de campos, e em
  // dobro pra cada nível da Hierarquia de datas se o campo for de data.
  const isDuplicateLookup = (draft.lookups ?? []).some((lk) => lk.source === lookupDraft.source && lk.field === lookupDraft.field)
  const canAddLookup = !!lookupDraft.source && !!lookupDraft.localKey && !!lookupDraft.foreignKey && !!lookupDraft.field && !isDuplicateLookup
  const addLookup = () => {
    if (!canAddLookup || !lookupDraft.source) return
    const fieldLabel = lookupSourceDef?.fields.find((f) => f.key === lookupDraft.field)?.label ?? lookupDraft.field
    const lookup: LookupColumn = {
      source: lookupDraft.source,
      localKey: lookupDraft.localKey,
      foreignKey: lookupDraft.foreignKey,
      field: lookupDraft.field,
      label: `${fieldLabel} (${lookupSourceDef?.label ?? lookupDraft.source})`,
    }
    set({ lookups: [...(draft.lookups ?? []), lookup] })
    setLookupDraft({ source: '', localKey: '', foreignKey: '', field: '' })
  }
  const removeLookup = (idx: number) => set({ lookups: (draft.lookups ?? []).filter((_, i) => i !== idx) })

  const canSave = draft.title.trim().length > 0 && (isText || !!draft.source)

  return (
    <ModalPortal>
      {/* Sem overlay escuro — painel fixo à direita, dashboard continua
          visível/interativo por trás (mesmo padrão do Power BI). O wrapper
          é pointer-events-none pra não bloquear cliques fora do painel. */}
      <div className="fixed inset-0 z-50 pointer-events-none">
        <div className="pointer-events-auto absolute top-0 right-0 h-full w-full max-w-[440px] bg-app-card border-l border-app-border shadow-2xl flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
            <h2 className="text-sm font-bold text-gray-100">{initial ? 'Editar widget' : 'Novo widget'}</h2>
            <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
          </div>

          <div className="flex border-b border-app-border shrink-0">
            <button onClick={() => setTabView('dados')} className={tabBtnCls(tabView === 'dados')}>Dados</button>
            {!isText && <button onClick={() => setTabView('modificadores')} className={tabBtnCls(tabView === 'modificadores')}>Modificadores</button>}
            <button onClick={() => setTabView('formato')} className={tabBtnCls(tabView === 'formato')}>Formato</button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {tabView === 'dados' ? (
              <>
                <Field label="Tipo de visual" info="Escolha como os dados serão exibidos. Cada tipo mostra abaixo só os campos que ele realmente usa.">
                  <div className="grid grid-cols-4 gap-1.5">
                    {(Object.keys(TYPE_LABELS) as WidgetType[]).map((t) => {
                      const Icon = TYPE_ICONS[t]
                      return (
                        <button
                          key={t}
                          onClick={() => set({
                            type: t,
                            legendDimension: LEGEND_TYPES.includes(t) ? draft.legendDimension : undefined,
                            measures: MULTI_MEASURE_TYPES.includes(t) ? draft.measures : undefined,
                            measuresLine: t === 'comboBarLine' ? draft.measuresLine : undefined,
                            measureX: t === 'scatter' ? draft.measureX : undefined,
                            matrixRows: t === 'matrix' ? draft.matrixRows : undefined,
                            matrixColumns: t === 'matrix' ? draft.matrixColumns : undefined,
                            matrixValue: t === 'matrix' ? draft.matrixValue : undefined,
                            histogramField: t === 'histogram' ? draft.histogramField : undefined,
                            histogramBins: t === 'histogram' ? draft.histogramBins : undefined,
                          })}
                          title={TYPE_LABELS[t]}
                          className={cn(
                            'flex flex-col items-center gap-1 py-2 rounded-lg border text-[9px] font-medium transition-colors',
                            draft.type === t ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400 hover:border-app-borderLight',
                          )}
                        >
                          <Icon size={15} />
                          {TYPE_LABELS[t]}
                        </button>
                      )
                    })}
                  </div>
                </Field>

                {isText && (
                  <Field label="Texto" info="Conteúdo livre exibido no widget, sem ligação com nenhuma fonte de dados — útil para instruções, avisos ou explicações.">
                    <textarea
                      value={draft.content ?? ''}
                      onChange={(e) => set({ content: e.target.value })}
                      rows={10}
                      placeholder="Digite o texto…"
                      className={cn(inputCls, 'resize-y font-sans')}
                    />
                  </Field>
                )}

                {!isText && isMatrix && (
                  <>
                    <AxisFieldPicker
                      label="Linhas"
                      hint="1+ campos — cada um cria um nível de hierarquia, com subtotal"
                      info="Cada campo adicionado aqui vira um nível de agrupamento nas linhas da tabela, com subtotal automático. Ex.: Cidade + Bairro mostra o total por cidade e, expandindo, o detalhe por bairro. Campo de data expande em Ano/Trimestre/Mês/Dia (Hierarquia de datas) — marque a combinação desejada pra virar níveis aninhados de verdade (Ano por fora, Mês dentro, etc.)."
                      groups={axisGroups}
                      selectedKeys={draft.matrixRows ?? []}
                      multiple
                      onAdd={(k) => set({ matrixRows: addDimensionKey(draft.matrixRows ?? [], k) })}
                      onRemove={(k) => set({ matrixRows: (draft.matrixRows ?? []).filter((d) => d !== k) })}
                      onSwitchSource={switchSource}
                    />
                    <AxisFieldPicker
                      label="Colunas"
                      hint="opcional — cada combinação de valores vira uma coluna"
                      info="Cada valor distinto (ou combinação, se adicionar mais de um campo) vira uma coluna dinâmica da tabela. Deixe vazio pra ter uma única coluna de valores, sem quebrar por coluna."
                      groups={axisGroups}
                      selectedKeys={draft.matrixColumns ?? []}
                      multiple
                      onAdd={(k) => set({ matrixColumns: addDimensionKey(draft.matrixColumns ?? [], k) })}
                      onRemove={(k) => set({ matrixColumns: (draft.matrixColumns ?? []).filter((d) => d !== k) })}
                      onSwitchSource={switchSource}
                    />
                    <MeasureWell
                      label="Valores"
                      info="O número calculado em cada célula da tabela (linha × coluna) — escolha o campo e como agregá-lo (contagem, contagem distinta, soma ou média)."
                      measures={draft.matrixValue ? [draft.matrixValue] : []}
                      numberGroups={numberGroups}
                      countGroups={countGroups}
                      onChange={(list) => set({ matrixValue: list[0] })}
                      onSwitchSource={switchSource}
                    />
                  </>
                )}

                {!isText && !isTable && !isMatrix && !isHistogram && (
                  <AxisFieldPicker
                    label={draft.type === 'kpi' ? 'Agrupar por' : draft.type === 'scatter' ? 'Detalhes' : 'Eixo X'}
                    hint={draft.type === 'kpi' ? 'vazio = total geral' : draft.type === 'scatter' ? '1 ponto por valor' : 'pode adicionar mais de um campo — agrupamento composto'}
                    info={draft.type === 'kpi'
                      ? 'Campo usado pra agrupar o valor do card. Deixe vazio para mostrar o total geral, sem quebrar por categoria.'
                      : draft.type === 'scatter'
                        ? 'Cada valor distinto deste campo vira um ponto no gráfico de dispersão.'
                        : 'Define como os dados são agrupados — cada valor distinto do campo escolhido vira uma categoria (barra, ponto, fatia etc.). Adicionar mais de um campo cria um agrupamento composto (ex.: "Cidade / Status"). Campo de data expande em Ano/Trimestre/Mês/Dia (Hierarquia de datas) — marque qualquer combinação: só Ano+Mês agrupa por mês, acrescentar Dia desce até o dia.'}
                    groups={axisGroups}
                    selectedKeys={draft.dimensions ?? []}
                    multiple={draft.type !== 'kpi'}
                    onAdd={(k) => set({ dimensions: addDimensionKey(draft.dimensions ?? [], k) })}
                    onRemove={(k) => set({ dimensions: (draft.dimensions ?? []).filter((d) => d !== k) })}
                    onSwitchSource={switchSource}
                  />
                )}

                {isHistogram && (
                  <>
                    <AxisFieldPicker
                      label="Campo numérico"
                      hint="os valores serão divididos em faixas automaticamente"
                      info="Escolha um campo numérico — o histograma divide os valores automaticamente em faixas de tamanho igual e conta quantos registros caem em cada uma. A linha mostra a curva normal (gaussiana) ajustada à média e ao desvio-padrão dos dados, para comparar a distribuição real com uma normal teórica."
                      groups={numberGroups}
                      selectedKeys={draft.histogramField ? [draft.histogramField] : []}
                      multiple={false}
                      onAdd={(k) => set({ histogramField: k })}
                      onRemove={() => set({ histogramField: undefined })}
                      onSwitchSource={switchSource}
                    />
                    <Field label="Quantidade de faixas" info="Em quantos intervalos de tamanho igual os valores serão divididos (padrão: 10).">
                      <NumberStepper value={draft.histogramBins} defaultValue={10} min={2} max={50} onChange={(n) => set({ histogramBins: n })} />
                    </Field>
                  </>
                )}

                {draft.type === 'scatter' && (
                  <MeasureWell
                    label="Eixo X"
                    info="Valor numérico usado como posição horizontal de cada ponto — escolha o campo e como agregá-lo."
                    measures={draft.measureX ? [draft.measureX] : []}
                    numberGroups={numberGroups}
                    countGroups={countGroups}
                    onChange={(list) => set({ measureX: list[0] })}
                    onSwitchSource={switchSource}
                  />
                )}

                {!isText && !isTable && !isMatrix && !isHistogram && (
                  <MeasureWell
                    label="Eixo Y"
                    hint={isBreakdownChart && !hasLegend ? 'cada medida adicionada vira uma série' : undefined}
                    info={draft.type === 'scatter'
                      ? 'Valor numérico usado como posição vertical de cada ponto.'
                      : 'A medida calculada para cada categoria do Eixo X — escolha o campo e como agregá-lo: contagem, contagem distinta, soma ou média.'}
                    measures={hasLegend || !isBreakdownChart ? (draft.measure ? [draft.measure] : []) : measuresList}
                    numberGroups={numberGroups}
                    countGroups={countGroups}
                    allowMultiple={isBreakdownChart && !hasLegend}
                    showColor={isBreakdownChart && !hasLegend}
                    onChange={(list) => (hasLegend || !isBreakdownChart) ? set({ measure: list[0] }) : setMeasuresList(list)}
                    onSwitchSource={switchSource}
                  />
                )}

                {draft.type === 'comboBarLine' && (
                  <MeasureWell
                    label="Eixo Y - Linha"
                    hint="série(s) de linha, no eixo secundário (à direita)"
                    info="Medida(s) extra desenhadas como linha, num eixo à direita separado do das colunas — útil pra comparar grandezas diferentes (ex.: quantidade × tempo médio) no mesmo gráfico."
                    measures={measuresLineList}
                    numberGroups={numberGroups}
                    countGroups={countGroups}
                    allowMultiple
                    showColor
                    onChange={setMeasuresLineList}
                    onSwitchSource={switchSource}
                  />
                )}

                {supportsLegend && (
                  <AxisFieldPicker
                    label="Legenda"
                    hint="opcional — cria uma série por valor, até 8"
                    info="Quebra cada categoria do Eixo X em várias séries, uma por valor distinto deste campo (no máximo 8 — os demais valores são descartados, não somados a 'outros')."
                    groups={legendGroups}
                    selectedKeys={draft.legendDimension ? [draft.legendDimension] : []}
                    onSwitchSource={switchSource}
                    onAdd={(k) => set({ legendDimension: k, measures: undefined })}
                    onRemove={() => set({ legendDimension: undefined })}
                  />
                )}

                {isTable && sourceDef && (
                  <TableColumnsWell
                    allFields={tableColumnFields}
                    columns={draft.columns ?? []}
                    columnLabels={draft.tableFormat?.columnLabels ?? {}}
                    onChangeColumns={(cols) => set({ columns: cols })}
                    onChangeLabel={(key, label) => {
                      const next = { ...(draft.tableFormat?.columnLabels ?? {}) }
                      if (label) next[key] = label; else delete next[key]
                      set({ tableFormat: { ...draft.tableFormat, columnLabels: next } })
                    }}
                  />
                )}

                {!isText && (
                  <div className="rounded-lg border border-app-border p-3">
                    <button onClick={runPreview} className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight">
                      <Eye size={12} /> Pré-visualizar dados
                    </button>
                    {previewError && <p className="mt-2 text-[11px] text-risk-critical">{previewError}</p>}
                    {preview && (
                      <div className="mt-2 space-y-0.5">
                        {preview.slice(0, 5).map((p) => (
                          <p key={p.label} className="text-[11px] text-gray-400 font-mono">{p.label}: <span className="text-gray-200">{p.value.toLocaleString('pt-BR')}</span></p>
                        ))}
                        {preview.length === 0 && <p className="text-[11px] text-gray-500">Sem dados para essa configuração.</p>}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : tabView === 'modificadores' && !isText ? (
              <>
                <Field
                  label="Planilhas do Google"
                  info="Cole o link de uma planilha do Google Sheets (precisa estar acessível pela sua conta Google) e use as colunas dela em qualquer gráfico ou tabela, como se fosse mais uma fonte — escolha-a no seletor de fonte da aba Dados. Fica disponível pra qualquer widget, não só este."
                >
                  {sheetSources.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {sheetSources.map((s) => {
                        const canManage = isAdmin || s.createdBy === currentEmail
                        const busy = sheetBusyId === s.id
                        return (
                          <div key={s.id} className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-app-border bg-app-surface text-[11px]">
                            <Sheet size={12} className="text-emerald-500 shrink-0" />
                            <span className="flex-1 truncate text-gray-300" title={s.label}>{s.label}</span>
                            <span className="text-[10px] text-gray-500 shrink-0">{s.rowCount != null ? `${s.rowCount} linhas` : 'não carregada'}</span>
                            <a href={s.url} target="_blank" rel="noreferrer" className="text-gray-500 hover:text-brand-blue shrink-0" title="Abrir planilha"><ExternalLink size={11} /></a>
                            <button onClick={() => handleRefreshSheet(s.id)} disabled={busy} className="text-gray-500 hover:text-brand-blue disabled:opacity-40 shrink-0" title="Atualizar agora"><RefreshCw size={11} className={cn(busy && 'animate-spin')} /></button>
                            {canManage && (
                              <button onClick={() => handleRemoveSheet(s.id)} disabled={busy} className="text-gray-500 hover:text-risk-critical disabled:opacity-40 shrink-0" title="Remover"><Trash2 size={11} /></button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {sheetError && <p className="mb-1.5 text-[10px] text-rose-400">{sheetError}</p>}

                  {sheetForm.open ? (
                    <div className="space-y-1.5 rounded-lg border border-app-border p-2">
                      <input
                        value={sheetForm.label} onChange={(e) => setSheetForm((f) => ({ ...f, label: e.target.value }))}
                        placeholder="Nome (ex.: Metas do time)" className={cn(inputCls, 'text-[11px]')}
                      />
                      <input
                        value={sheetForm.url} onChange={(e) => setSheetForm((f) => ({ ...f, url: e.target.value }))}
                        placeholder="Link da planilha (https://docs.google.com/spreadsheets/d/...)" className={cn(inputCls, 'text-[11px]')}
                      />
                      <input
                        value={sheetForm.sheetName} onChange={(e) => setSheetForm((f) => ({ ...f, sheetName: e.target.value }))}
                        placeholder="Aba (opcional — padrão: a primeira)" className={cn(inputCls, 'text-[11px]')}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleAddSheet}
                          disabled={sheetSaving || !sheetForm.label.trim() || !sheetForm.url.trim()}
                          className="px-2.5 py-1 rounded-md bg-brand-blue text-white text-[11px] font-semibold disabled:opacity-40"
                        >
                          {sheetSaving ? 'Adicionando…' : 'Adicionar'}
                        </button>
                        <button onClick={() => { setSheetForm({ open: false, label: '', url: '', sheetName: '' }); setSheetError(null) }} className="text-[11px] text-gray-500 hover:text-gray-300">
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSheetForm((f) => ({ ...f, open: true }))}
                      className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight"
                    >
                      <Plus size={12} /> Adicionar planilha
                    </button>
                  )}
                </Field>

                {sourceDef && (
                  <p className="text-[10px] text-gray-500 flex items-start gap-1">
                    <span>Fonte principal: <span className="text-gray-300 font-medium">{sourceDef.label}</span> — definida automaticamente; pra usar outra fonte, mescle-a abaixo.</span>
                    <InfoHint text="A fonte principal é a primeira tabela cadastrada, ou a fonte de onde você já escolheu algum campo. Pra trocar, abra o seletor de qualquer eixo e clique numa fonte marcada 'usar esta fonte' — isso reseta os campos já escolhidos, já que eles pertenciam à fonte anterior." />
                  </p>
                )}

                {sourceDef && (
                  <Field
                    label="Mesclar campo de outra fonte (opcional)"
                    info="Funciona como um 'JOIN': casa uma chave em comum entre esta fonte e outra tabela, e traz um campo dela pra usar em qualquer parte deste widget (Eixo X, Eixo Y, Legenda, Filtro, coluna de tabela) como se fosse um campo nativo."
                  >
                    <p className="text-[10px] text-gray-500 mt-0.5 mb-1.5">
                      Traz um campo de qualquer outra fonte pra usar em qualquer papel (Eixo X, Eixo Y, Legenda, Filtro, coluna de tabela) — basta casar uma chave em comum entre as duas.
                    </p>
                    {(draft.lookups ?? []).length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {(draft.lookups ?? []).map((lk, i) => (
                          <span key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-brand-blue/30 bg-brand-blue/10 text-[10px] text-brand-blue">
                            <Link2 size={10} /> {lk.label}
                            <button onClick={() => removeLookup(i)} className="text-brand-blue/70 hover:text-brand-blue"><X size={10} /></button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-1.5">
                      <select
                        value={lookupDraft.source}
                        onChange={(e) => setLookupDraft({ source: e.target.value as SourceTable, localKey: '', foreignKey: '', field: '' })}
                        className={cn(inputCls, 'text-[10px]')}
                      >
                        <option value="">Fonte relacionada…</option>
                        {sources.filter((s) => s.key !== draft.source).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                      <select
                        value={lookupDraft.localKey}
                        onChange={(e) => setLookupDraft((d) => ({ ...d, localKey: e.target.value }))}
                        disabled={!lookupDraft.source}
                        className={cn(inputCls, 'text-[10px]')}
                      >
                        <option value="">Chave aqui…</option>
                        {sourceDef.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                      <select
                        value={lookupDraft.foreignKey}
                        onChange={(e) => setLookupDraft((d) => ({ ...d, foreignKey: e.target.value }))}
                        disabled={!lookupSourceDef}
                        className={cn(inputCls, 'text-[10px]')}
                      >
                        <option value="">Chave na fonte…</option>
                        {lookupSourceDef?.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                      <select
                        value={lookupDraft.field}
                        onChange={(e) => setLookupDraft((d) => ({ ...d, field: e.target.value }))}
                        disabled={!lookupSourceDef}
                        className={cn(inputCls, 'text-[10px]')}
                      >
                        <option value="">Campo a trazer…</option>
                        {lookupSourceDef?.fields
                          .filter((f) => !(draft.lookups ?? []).some((lk) => lk.source === lookupDraft.source && lk.field === f.key))
                          .map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </div>
                    {isDuplicateLookup && (
                      <p className="mt-1 text-[10px] text-risk-critical">Esse campo já foi mesclado desta fonte.</p>
                    )}
                    <button
                      onClick={addLookup}
                      disabled={!canAddLookup}
                      className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight disabled:opacity-40"
                    >
                      <Plus size={12} /> Adicionar campo mesclado
                    </button>
                  </Field>
                )}

                <FieldWell
                  label="Filtro fixo do widget"
                  hint="opcional — não reage aos filtros da aba"
                  info="Restringe os dados deste widget a um subconjunto fixo, sempre — diferente dos filtros da aba (que ficam no topo da dashboard), que o usuário pode mudar a qualquer momento."
                  allOptions={filterableFields}
                  selectedKeys={wf ? [wf.field] : []}
                  onAdd={(field) => set({ widgetFilters: [{ field, op: 'in', values: [] }] })}
                  onRemove={() => set({ widgetFilters: undefined })}
                />
                {wf && (
                  <div>
                    <select value={wf.op} onChange={(e) => set({ widgetFilters: [{ ...wf, op: e.target.value as any }] })} className={cn(inputCls, 'mb-1.5')}>
                      <option value="in">está em</option>
                      <option value="notIn">não está em</option>
                    </select>
                    <div className="max-h-32 overflow-auto flex flex-wrap gap-1.5 rounded-lg border border-app-border p-2">
                      {filterValues === null && <span className="text-[10px] text-gray-500">Carregando valores…</span>}
                      {(filterValues ?? []).map((v) => {
                        const on = wf.values.includes(v)
                        return (
                          <button
                            key={v}
                            onClick={() => set({ widgetFilters: [{ ...wf, values: on ? wf.values.filter((x) => x !== v) : [...wf.values, v] }] })}
                            className={cn('px-2 py-0.5 rounded-md border text-[10px]', on ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-500')}
                          >
                            {v}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {!isTable && (
                  <Field
                    label="Top N (limite)"
                    info="Quantas categorias aparecem no gráfico (padrão 15, máximo 100). Se o Eixo X é uma data, mantém os N períodos mais recentes; pra qualquer outro campo, mantém só os N maiores valores — o resto não aparece (não é somado a 'outros')."
                  >
                    <NumberStepper value={draft.limit} defaultValue={15} min={1} max={100} onChange={(n) => set({ limit: n })} />
                  </Field>
                )}
              </>
            ) : (
              <>
                <CollapsibleSection label="Título" open={openSections.has('titulo')} onToggle={() => toggleSection('titulo')}>
                  <input value={draft.title} onChange={(e) => set({ title: e.target.value })} className={inputCls} />
                  <TextFormatEditor value={draft.titleFormat} onChange={(v) => set({ titleFormat: v })} showAlign />
                </CollapsibleSection>

                <CollapsibleSection
                  label="Subtítulo (opcional)" info="Texto pequeno exibido abaixo do título, no cabeçalho do widget."
                  open={openSections.has('subtitulo')} onToggle={() => toggleSection('subtitulo')}
                >
                  <input value={draft.subtitle ?? ''} onChange={(e) => set({ subtitle: e.target.value || undefined })} className={inputCls} placeholder="Sem subtítulo" />
                  <TextFormatEditor value={draft.subtitleFormat} onChange={(v) => set({ subtitleFormat: v })} showAlign />
                </CollapsibleSection>

                <CollapsibleSection
                  label="Cor principal"
                  info="Cor usada quando o gráfico tem uma única série. Com legenda ou múltiplas medidas, cada série já tem sua própria cor (definida na pílula do Eixo Y) e esta opção não se aplica a elas. Não afeta o título — a cor do título é definida na formatação do Título, acima."
                  open={openSections.has('corPrincipal')} onToggle={() => toggleSection('corPrincipal')}
                >
                  <div className="flex gap-1.5 flex-wrap">
                    {COLORS.map((c) => (
                      <button type="button" key={c} onClick={() => set({ color: c })} className={swatchCls(draft.color === c, true)} style={{ background: c }} />
                    ))}
                  </div>
                </CollapsibleSection>

                {isKpi && (
                  <CollapsibleSection
                    label="Alinhamento do valor"
                    info="Posição horizontal do número (e da meta, se houver) dentro do card."
                    open={openSections.has('valorAlign')} onToggle={() => toggleSection('valorAlign')}
                  >
                    <AlignButtons value={draft.valueAlign} onChange={(a) => set({ valueAlign: a })} />
                  </CollapsibleSection>
                )}

                {hasDataLabels && (
                  <CollapsibleSection
                    label="Opacidade das colunas/linhas/fatias" info="Deixa mais transparente o preenchimento das barras, linhas, área ou fatias do gráfico — útil pra sobrepor rótulos ou dar destaque a outro elemento."
                    open={openSections.has('opacidadeSeries')} onToggle={() => toggleSection('opacidadeSeries')}
                  >
                    <OpacitySlider value={draft.seriesOpacity} onChange={(o) => set({ seriesOpacity: o })} />
                  </CollapsibleSection>
                )}

                <CollapsibleSection
                  label="Aparência do widget" info="Quatro seletores independentes — um só pros três efeitos juntos não dava pra ter, por exemplo, sombra cinza padrão com brilho azul. 'Padrão'/'Desligado' (X) volta ao normal ou desliga o efeito."
                  open={openSections.has('aparencia')} onToggle={() => toggleSection('aparencia')}
                >
                  <div className="space-y-3">
                    <div>
                      <span className="text-[9px] text-gray-500">Fundo do card</span>
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        <button type="button" onClick={() => set({ backgroundColor: undefined, backgroundOpacity: undefined })} title="Padrão" className={cn(swatchCls(!draft.backgroundColor), 'bg-app-surface flex items-center justify-center')}>
                          {!draft.backgroundColor && <X size={9} className="text-gray-500" />}
                        </button>
                        {COLORS.map((c) => (
                          <button type="button" key={c} onClick={() => set({ backgroundColor: c })} className={swatchCls(draft.backgroundColor === c)} style={{ background: c }} />
                        ))}
                      </div>
                      {draft.backgroundColor && <div className="mt-1"><OpacitySlider value={draft.backgroundOpacity} onChange={(o) => set({ backgroundOpacity: o })} /></div>}
                    </div>

                    <div>
                      <span className="text-[9px] text-gray-500">Sombra</span>
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        <button type="button" onClick={() => set({ shadow: undefined, shadowColor: undefined })} title="Desligada" className={cn(swatchCls(!draft.shadow), 'bg-app-surface flex items-center justify-center')}>
                          {!draft.shadow && <X size={9} className="text-gray-500" />}
                        </button>
                        {COLORS.map((c) => (
                          <button type="button" key={c} onClick={() => set({ shadow: true, shadowColor: c })} className={swatchCls(!!draft.shadow && draft.shadowColor === c)} style={{ background: c }} />
                        ))}
                      </div>
                    </div>

                    <div>
                      <span className="text-[9px] text-gray-500">Brilho</span>
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        <button type="button" onClick={() => set({ glow: undefined, glowColor: undefined })} title="Desligado" className={cn(swatchCls(!draft.glow), 'bg-app-surface flex items-center justify-center')}>
                          {!draft.glow && <X size={9} className="text-gray-500" />}
                        </button>
                        {COLORS.map((c) => (
                          <button type="button" key={c} onClick={() => set({ glow: true, glowColor: c })} className={swatchCls(!!draft.glow && draft.glowColor === c)} style={{ background: c }} />
                        ))}
                      </div>
                    </div>

                    <div>
                      <span className="text-[9px] text-gray-500">Piscar</span>
                      <div className="flex gap-1 mt-0.5 flex-wrap">
                        <button type="button" onClick={() => set({ blink: undefined, blinkColor: undefined })} title="Desligado" className={cn(swatchCls(!draft.blink), 'bg-app-surface flex items-center justify-center')}>
                          {!draft.blink && <X size={9} className="text-gray-500" />}
                        </button>
                        {COLORS.map((c) => (
                          <button type="button" key={c} onClick={() => set({ blink: true, blinkColor: c })} className={swatchCls(!!draft.blink && draft.blinkColor === c)} style={{ background: c }} />
                        ))}
                      </div>
                    </div>
                  </div>
                </CollapsibleSection>

                <CollapsibleSection
                  label="Cor dos ícones" info="Cor dos ícones de editar/duplicar/excluir que aparecem no cabeçalho do widget durante o modo de edição."
                  open={openSections.has('iconColor')} onToggle={() => toggleSection('iconColor')}
                >
                  <div className="flex gap-1 flex-wrap">
                    <button type="button" onClick={() => set({ iconColor: undefined })} title="Padrão" className={cn(swatchCls(!draft.iconColor), 'bg-app-surface flex items-center justify-center')}>
                      {!draft.iconColor && <X size={9} className="text-gray-500" />}
                    </button>
                    {COLORS.map((c) => (
                      <button type="button" key={c} onClick={() => set({ iconColor: c })} className={swatchCls(draft.iconColor === c)} style={{ background: c }} />
                    ))}
                  </div>
                </CollapsibleSection>

                {(TARGET_LINE_TYPES.includes(draft.type) || CONDITIONAL_RULES_TYPES.includes(draft.type)) && (
                  <CollapsibleSection
                    label="Meta e alertas"
                    info="Motor único de formatação condicional: defina uma meta (linha de referência no gráfico e comparação no KPI) e/ou regras 'se o valor for {operador} {número}, aplica {efeito}' — cor de fundo, piscar ou brilho — avaliadas na ordem da lista (a última que bater vence)."
                    open={openSections.has('metaAlertas')} onToggle={() => toggleSection('metaAlertas')}
                  >
                    {TARGET_LINE_TYPES.includes(draft.type) && (
                      <Field label="Meta (opcional)" info="Desenha uma linha de referência no gráfico e, no KPI, aparece ao lado do valor pra comparação visual.">
                        <input
                          type="number"
                          value={draft.target ?? ''}
                          onChange={(e) => set({ target: e.target.value === '' ? undefined : Number(e.target.value) })}
                          placeholder="Sem meta definida"
                          className={inputCls}
                        />
                        {draft.target != null && (
                          <div className="mt-2">
                            <span className="text-[9px] text-gray-500">Cor da linha de meta</span>
                            <div className="flex gap-1 mt-0.5 flex-wrap">
                              <button type="button" onClick={() => set({ targetLineColor: undefined, targetLineOpacity: undefined })} title="Padrão (vermelho)" className={cn(swatchCls(!draft.targetLineColor), 'bg-app-surface flex items-center justify-center')}>
                                {!draft.targetLineColor && <X size={9} className="text-gray-500" />}
                              </button>
                              {COLORS.map((c) => (
                                <button type="button" key={c} onClick={() => set({ targetLineColor: c })} className={swatchCls(draft.targetLineColor === c)} style={{ background: c }} />
                              ))}
                            </div>
                            {draft.targetLineColor && <div className="mt-1"><OpacitySlider value={draft.targetLineOpacity} onChange={(o) => set({ targetLineOpacity: o })} /></div>}
                          </div>
                        )}
                      </Field>
                    )}
                    {CONDITIONAL_RULES_TYPES.includes(draft.type) && (
                      <ConditionalRulesEditor
                        rules={draft.conditionalRules ?? []}
                        onChange={(rules) => set({ conditionalRules: rules.length ? rules : undefined })}
                        showGlow={draft.type === 'kpi'}
                        showTarget={BAR_LABEL_TARGET_TYPES.includes(draft.type)}
                      />
                    )}
                  </CollapsibleSection>
                )}

                {hasAxes && (
                  <>
                    <CollapsibleSection
                      label="Eixo X" info="Estilo do texto exibido no Eixo X do gráfico: tamanho da fonte, negrito, itálico, sublinhado, cor do texto e cor de fundo atrás do texto. O recuo ajusta manualmente o espaço reservado embaixo do gráfico para esse texto."
                      open={openSections.has('eixoX')} onToggle={() => toggleSection('eixoX')}
                    >
                      <TextFormatEditor value={draft.axisXFormat} onChange={(v) => set({ axisXFormat: v })} />
                      <AxisMarginField
                        label="Recuo inferior (px)"
                        value={draft.axisXFormat?.margin}
                        onChange={(margin) => set({ axisXFormat: { ...draft.axisXFormat, margin } })}
                      />
                    </CollapsibleSection>
                    <CollapsibleSection
                      label="Eixo Y" info="Estilo do texto exibido no Eixo Y do gráfico: tamanho da fonte, negrito, itálico, sublinhado, cor do texto e cor de fundo atrás do texto. O recuo ajusta manualmente o espaço reservado do lado do gráfico para esse texto."
                      open={openSections.has('eixoY')} onToggle={() => toggleSection('eixoY')}
                    >
                      <TextFormatEditor value={draft.axisYFormat} onChange={(v) => set({ axisYFormat: v })} />
                      <AxisMarginField
                        label="Recuo lateral (px)"
                        value={draft.axisYFormat?.margin}
                        onChange={(margin) => set({ axisYFormat: { ...draft.axisYFormat, margin } })}
                      />
                    </CollapsibleSection>
                    <CollapsibleSection
                      label="Linhas de grade" info="As linhas pontilhadas de fundo do gráfico — pode manter as duas direções, deixar só uma, ou remover totalmente. Cor e opacidade próprias, opcionais."
                      open={openSections.has('gridLines')} onToggle={() => toggleSection('gridLines')}
                    >
                      <div className="grid grid-cols-4 gap-1">
                        {(GRID_LINE_OPTIONS).map((g) => (
                          <button
                            type="button" key={g.key}
                            onClick={() => set({ gridLines: g.key })}
                            className={cn('px-1 py-1.5 rounded-lg border text-[10px] font-medium', (draft.gridLines ?? 'both') === g.key ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}
                          >
                            {g.label}
                          </button>
                        ))}
                      </div>
                      {draft.gridLines !== 'none' && (
                        <div className="mt-2">
                          <span className="text-[9px] text-gray-500">Cor</span>
                          <div className="flex gap-1 mt-0.5 flex-wrap">
                            <button type="button" onClick={() => set({ gridLinesColor: undefined, gridLinesOpacity: undefined })} title="Padrão do tema" className={cn(swatchCls(!draft.gridLinesColor), 'bg-app-surface flex items-center justify-center')}>
                              {!draft.gridLinesColor && <X size={9} className="text-gray-500" />}
                            </button>
                            {COLORS.map((c) => (
                              <button type="button" key={c} onClick={() => set({ gridLinesColor: c })} className={swatchCls(draft.gridLinesColor === c)} style={{ background: c }} />
                            ))}
                          </div>
                          {draft.gridLinesColor && <div className="mt-1"><OpacitySlider value={draft.gridLinesOpacity} onChange={(o) => set({ gridLinesOpacity: o })} /></div>}
                        </div>
                      )}
                    </CollapsibleSection>
                  </>
                )}

                {LEGEND_DISPLAY_TYPES.includes(draft.type) && (
                  <CollapsibleSection
                    label="Legenda" info="Estilo do texto da legenda embaixo do gráfico (os quadradinhos coloridos que identificam cada série)."
                    open={openSections.has('legenda')} onToggle={() => toggleSection('legenda')}
                  >
                    <TextFormatEditor value={draft.legendFormat} onChange={(v) => set({ legendFormat: v })} />
                  </CollapsibleSection>
                )}

                {isMatrix && (
                  <>
                    <CollapsibleSection
                      label="Linhas" info="Estilo do texto da coluna de linhas da Matriz (a hierarquia à esquerda): tamanho da fonte, negrito, itálico, sublinhado, cor do texto e cor de fundo."
                      open={openSections.has('matrixLinhas')} onToggle={() => toggleSection('matrixLinhas')}
                    >
                      <TextFormatEditor value={draft.matrixRowFormat} onChange={(v) => set({ matrixRowFormat: v })} showAlign />
                    </CollapsibleSection>
                    <CollapsibleSection
                      label="Colunas" info="Estilo do texto do cabeçalho das colunas dinâmicas da Matriz: tamanho da fonte, negrito, itálico, sublinhado, cor do texto e cor de fundo."
                      open={openSections.has('matrixColunas')} onToggle={() => toggleSection('matrixColunas')}
                    >
                      <TextFormatEditor value={draft.matrixColumnFormat} onChange={(v) => set({ matrixColumnFormat: v })} showAlign />
                    </CollapsibleSection>
                  </>
                )}

                {hasDataLabels && (
                  <CollapsibleSection
                    label="Rótulos de dados" info="Mostra o valor de cada barra/ponto/fatia diretamente sobre o gráfico, sem precisar passar o mouse. Escolha onde aparece, o que aparece (número, nome, percentual ou combinações) e o tamanho da fonte."
                    open={openSections.has('rotulos')} onToggle={() => toggleSection('rotulos')}
                  >
                    <DataLabelsEditor
                      value={draft.dataLabels} onChange={(v) => set({ dataLabels: v })}
                      isStacked={draft.type === 'barStacked' || draft.type === 'barHStacked'}
                    />
                    {/* Empilhada é sempre o total da pilha — override "por
                        série" não tem o que sobrescrever. */}
                    {draft.type !== 'barStacked' && draft.type !== 'barHStacked' && (
                      <SeriesLabelOverridesEditor items={seriesLabelItems} />
                    )}
                  </CollapsibleSection>
                )}

                {hasDataLabels && (
                  <CollapsibleSection
                    label="Gráfico dinâmico"
                    info="O gráfico se desenha sozinho do início ao fim e reinicia em loop, sem o dado mudar: linha/área traçando, coluna/barra crescendo uma de cada vez (esquerda → direita), pizza/funil/dispersão desenhando. Puramente visual — não muda o dado nem como a IA lê o gráfico."
                    open={openSections.has('dynamicAnimation')} onToggle={() => toggleSection('dynamicAnimation')}
                  >
                    <DynamicAnimationEditor
                      enabled={draft.dynamicAnimation}
                      speed={draft.dynamicAnimationSpeed}
                      onChange={(enabled, speed) => set({ dynamicAnimation: enabled || undefined, dynamicAnimationSpeed: speed })}
                    />
                  </CollapsibleSection>
                )}

                {isTable && (
                  <CollapsibleSection label="Tabela" open={openSections.has('tabela')} onToggle={() => toggleSection('tabela')}>
                    <Field label="Tamanho da fonte (px)" info="Tamanho do texto no corpo da tabela.">
                      <NumberStepper
                        value={draft.tableFormat?.fontSize} defaultValue={11} min={9} max={20}
                        onChange={(n) => set({ tableFormat: { ...draft.tableFormat, fontSize: n } })}
                      />
                    </Field>
                    <Field label="Alinhamento do texto nas células" info="Alinhamento horizontal do texto dentro de cada célula da tabela (afeta cabeçalho e corpo).">
                      <AlignButtons value={draft.tableFormat?.align} onChange={(a) => set({ tableFormat: { ...draft.tableFormat, align: a } })} />
                    </Field>
                    <label className="flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Cabeçalho em negrito</span>
                        <InfoHint text="Deixa o texto do cabeçalho das colunas em negrito." />
                      </span>
                      <button
                        type="button"
                        onClick={() => set({ tableFormat: { ...draft.tableFormat, headerBold: !(draft.tableFormat?.headerBold ?? true) } })}
                        className={cn('relative h-5 w-9 rounded-full transition-colors', (draft.tableFormat?.headerBold ?? true) ? 'bg-brand-blue' : 'bg-app-border')}
                      >
                        <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform" style={{ transform: (draft.tableFormat?.headerBold ?? true) ? 'translateX(16px)' : 'translateX(0)' }} />
                      </button>
                    </label>
                  </CollapsibleSection>
                )}

                {isTable && (
                  <CollapsibleSection label="Formatação condicional (tabela)" open={openSections.has('tabelaCondicional')} onToggle={() => toggleSection('tabelaCondicional')}>
                    <TableConditionalRulesEditor
                      rules={draft.tableConditionalRules ?? []}
                      onChange={(rules) => set({ tableConditionalRules: rules })}
                      columns={(draft.columns ?? []).map((key) => ({
                        key,
                        label: draft.tableFormat?.columnLabels?.[key] ?? sourceDef?.fields.find((f) => f.key === key)?.label ?? key,
                      }))}
                    />
                  </CollapsibleSection>
                )}
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border shrink-0">
            <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">Cancelar</button>
            <button
              onClick={() => canSave && onSave(draft)}
              disabled={!canSave}
              className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight disabled:opacity-50"
            >
              {initial ? 'Salvar widget' : 'Adicionar widget'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
