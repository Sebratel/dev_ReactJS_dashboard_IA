// Painel de criação/edição de widget — estilo Power BI: painel fixo à
// direita (não bloqueia o resto da dashboard), abas "Dados" (tipo de visual +
// Eixo X/Eixo Y/Legenda via AxisFieldPicker/MeasureWell), "Modificadores"
// (mesclar fonte, filtro fixo, top N) e "Formato" (título/cor/tabela).
import { useEffect, useMemo, useState } from 'react'
import {
  X, Eye, Plus, Link2, Gauge, BarChart3, BarChart2, BarChartBig, BarChartHorizontalBig,
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
import type { ConditionalOperator, ConditionalRule, DataLabelFormat, LookupColumn, MeasureConfig, SourceTable, TextFormat, WidgetConfig, WidgetDataPoint, WidgetType } from './types'

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

// Editor genérico de TextFormat — reusado pelo Título/Subtítulo, Eixo X/Eixo Y
// (gráficos) e Linhas/Colunas (Matriz). Cada botão "nenhuma"/"padrão" (X)
// volta o campo pra undefined em vez de fixar uma cor, deixando o renderer
// usar o padrão dele. O slider de opacidade só aparece quando a cor
// correspondente está definida (senão não haveria nada pra "desbotar").
function TextFormatEditor({ value, onChange }: { value: TextFormat | undefined; onChange: (v: TextFormat | undefined) => void }) {
  const v = value ?? {}
  const patch = (p: Partial<TextFormat>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <input
          type="number" min={8} max={24}
          value={v.fontSize ?? 11}
          onChange={(e) => patch({ fontSize: Number(e.target.value) || undefined })}
          className={cn(inputCls, 'w-16')}
        />
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
        <input
          type="number" step={4}
          value={value ?? 0}
          onChange={(e) => { const n = Number(e.target.value) || 0; onChange(n === 0 ? undefined : n) }}
          className={cn(inputCls, 'w-24')}
        />
      </Field>
    </div>
  )
}

const OPERATOR_OPTIONS: ConditionalOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq']

// Lista de regras do motor de formatação condicional (ver conditionalFormat.ts)
// — cada uma "se o valor for {operador} {número}, aplica {efeito}". `showGlow`
// só faz sentido pro KPI (é a única forma de widget onde o brilho realmente
// aparece — ver ChartFrame/conditionalStyle no WidgetRenderer).
function ConditionalRulesEditor({ rules, onChange, showGlow }: {
  rules: ConditionalRule[]
  onChange: (rules: ConditionalRule[]) => void
  showGlow?: boolean
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
              <input type="checkbox" checked={!!r.effect.blink} onChange={(e) => updateEffect(i, { blink: e.target.checked || undefined })} className="accent-[#ffb000]" />
              Piscar
            </label>
            {showGlow && (
              <label className="flex items-center gap-1 text-[11px] text-gray-300">
                <input type="checkbox" checked={!!r.effect.glow} onChange={(e) => updateEffect(i, { glow: e.target.checked || undefined })} className="accent-[#ffb000]" />
                Brilho
              </label>
            )}
          </div>
        </div>
      ))}
      <button onClick={add} className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight">
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

function DataLabelsEditor({ value, onChange }: { value: DataLabelFormat | undefined; onChange: (v: DataLabelFormat | undefined) => void }) {
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
      {v.show && (
        <>
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
            <input type="number" min={8} max={24} value={v.fontSize ?? 10} onChange={(e) => patch({ fontSize: Number(e.target.value) || undefined })} className={inputCls} />
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

const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'
const tabBtnCls = (active: boolean) => cn(
  'flex-1 px-3 py-2 text-[11px] font-semibold border-b-2 transition-colors',
  active ? 'border-brand-blue text-brand-blue' : 'border-transparent text-gray-500 hover:text-gray-300',
)

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
    layout: { x: 0, y: 0, w: 6, h: 5 },
    ...newWidgetDefaults,
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
  // em variantes "por dia"/"por mês" (só faz sentido pra eixo/legenda).
  const buildGroups = (kindFilter: (kind: FieldKind) => boolean, dateBuckets: boolean): AxisFieldGroup[] => {
    const groups: AxisFieldGroup[] = []
    if (sourceDef) {
      const fields: { key: string; label: string; description?: string }[] = []
      for (const f of sourceDef.fields) {
        if (!kindFilter(f.kind)) continue
        if (f.kind === 'date' && dateBuckets) {
          fields.push({ key: `day:${f.key}`, label: `${f.label} (por dia)`, description: f.description })
          fields.push({ key: `month:${f.key}`, label: `${f.label} (por mês)`, description: f.description })
        } else {
          fields.push({ key: f.key, label: f.label, description: f.description })
        }
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
      if (kind === 'date' && dateBuckets) {
        g.fields.push({ key: `day:${outKey}`, label: `${lk.label} (por dia)`, description: lkField?.description })
        g.fields.push({ key: `month:${outKey}`, label: `${lk.label} (por mês)`, description: lkField?.description })
      } else {
        g.fields.push({ key: outKey, label: lk.label, description: lkField?.description })
      }
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
    () => axisGroups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => !(draft.dimensions ?? []).includes(f.key)) }))
      .filter((g) => g.foreign || g.fields.length > 0),
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
  const canAddLookup = !!lookupDraft.source && !!lookupDraft.localKey && !!lookupDraft.foreignKey && !!lookupDraft.field
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
                      info="Cada campo adicionado aqui vira um nível de agrupamento nas linhas da tabela, com subtotal automático. Ex.: Cidade + Bairro mostra o total por cidade e, expandindo, o detalhe por bairro."
                      groups={axisGroups}
                      selectedKeys={draft.matrixRows ?? []}
                      multiple
                      onAdd={(k) => set({ matrixRows: [...(draft.matrixRows ?? []), k] })}
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
                      onAdd={(k) => set({ matrixColumns: [...(draft.matrixColumns ?? []), k] })}
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
                        : 'Define como os dados são agrupados — cada valor distinto do campo escolhido vira uma categoria (barra, ponto, fatia etc.). Adicionar mais de um campo cria um agrupamento composto (ex.: "Cidade / Status").'}
                    groups={axisGroups}
                    selectedKeys={draft.dimensions ?? []}
                    multiple={draft.type !== 'kpi'}
                    onAdd={(k) => set({ dimensions: [...(draft.dimensions ?? []), k] })}
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
                      <input
                        type="number" min={2} max={50}
                        value={draft.histogramBins ?? 10}
                        onChange={(e) => set({ histogramBins: Math.min(50, Math.max(2, Number(e.target.value) || 10)) })}
                        className={cn(inputCls, 'w-24')}
                      />
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
                    allFields={sourceDef.fields}
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
                        {lookupSourceDef?.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </div>
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
                    <input type="number" min={1} max={100} value={draft.limit ?? 15} onChange={(e) => set({ limit: Number(e.target.value) || undefined })} className={inputCls} />
                  </Field>
                )}
              </>
            ) : (
              <>
                <CollapsibleSection label="Título" open={openSections.has('titulo')} onToggle={() => toggleSection('titulo')}>
                  <input value={draft.title} onChange={(e) => set({ title: e.target.value })} className={inputCls} />
                  <TextFormatEditor value={draft.titleFormat} onChange={(v) => set({ titleFormat: v })} />
                </CollapsibleSection>

                <CollapsibleSection
                  label="Subtítulo (opcional)" info="Texto pequeno exibido abaixo do título, no cabeçalho do widget."
                  open={openSections.has('subtitulo')} onToggle={() => toggleSection('subtitulo')}
                >
                  <input value={draft.subtitle ?? ''} onChange={(e) => set({ subtitle: e.target.value || undefined })} className={inputCls} placeholder="Sem subtítulo" />
                  <TextFormatEditor value={draft.subtitleFormat} onChange={(v) => set({ subtitleFormat: v })} />
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

                {hasDataLabels && (
                  <CollapsibleSection
                    label="Opacidade das colunas/linhas/fatias" info="Deixa mais transparente o preenchimento das barras, linhas, área ou fatias do gráfico — útil pra sobrepor rótulos ou dar destaque a outro elemento."
                    open={openSections.has('opacidadeSeries')} onToggle={() => toggleSection('opacidadeSeries')}
                  >
                    <OpacitySlider value={draft.seriesOpacity} onChange={(o) => set({ seriesOpacity: o })} />
                  </CollapsibleSection>
                )}

                <CollapsibleSection
                  label="Aparência do widget" info="Cor de fundo do cartão do widget (o card inteiro, atrás do gráfico/tabela). Deixe em 'Padrão' pra usar o tema atual."
                  open={openSections.has('aparencia')} onToggle={() => toggleSection('aparencia')}
                >
                  <div className="flex gap-1 flex-wrap">
                    <button type="button" onClick={() => set({ backgroundColor: undefined, backgroundOpacity: undefined })} title="Padrão" className={cn(swatchCls(!draft.backgroundColor), 'bg-app-surface flex items-center justify-center')}>
                      {!draft.backgroundColor && <X size={9} className="text-gray-500" />}
                    </button>
                    {COLORS.map((c) => (
                      <button type="button" key={c} onClick={() => set({ backgroundColor: c })} className={swatchCls(draft.backgroundColor === c)} style={{ background: c }} />
                    ))}
                  </div>
                  {draft.backgroundColor && <OpacitySlider value={draft.backgroundOpacity} onChange={(o) => set({ backgroundOpacity: o })} />}
                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    <label className="flex items-center gap-1.5 text-[11px] text-gray-300">
                      <input type="checkbox" checked={!!draft.shadow} onChange={(e) => set({ shadow: e.target.checked || undefined })} className="accent-[#ffb000]" />
                      Sombra
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-gray-300">
                      <input type="checkbox" checked={!!draft.glow} onChange={(e) => set({ glow: e.target.checked || undefined })} className="accent-[#ffb000]" />
                      Brilho
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-gray-300">
                      <input type="checkbox" checked={!!draft.blink} onChange={(e) => set({ blink: e.target.checked || undefined })} className="accent-[#ffb000]" />
                      Piscar
                    </label>
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
                      </Field>
                    )}
                    {CONDITIONAL_RULES_TYPES.includes(draft.type) && (
                      <ConditionalRulesEditor
                        rules={draft.conditionalRules ?? []}
                        onChange={(rules) => set({ conditionalRules: rules.length ? rules : undefined })}
                        showGlow={draft.type === 'kpi'}
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
                      label="Linhas de grade" info="As linhas pontilhadas de fundo do gráfico — pode manter as duas direções, deixar só uma, ou remover totalmente."
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
                      <TextFormatEditor value={draft.matrixRowFormat} onChange={(v) => set({ matrixRowFormat: v })} />
                    </CollapsibleSection>
                    <CollapsibleSection
                      label="Colunas" info="Estilo do texto do cabeçalho das colunas dinâmicas da Matriz: tamanho da fonte, negrito, itálico, sublinhado, cor do texto e cor de fundo."
                      open={openSections.has('matrixColunas')} onToggle={() => toggleSection('matrixColunas')}
                    >
                      <TextFormatEditor value={draft.matrixColumnFormat} onChange={(v) => set({ matrixColumnFormat: v })} />
                    </CollapsibleSection>
                  </>
                )}

                {hasDataLabels && (
                  <CollapsibleSection
                    label="Rótulos de dados" info="Mostra o valor de cada barra/ponto/fatia diretamente sobre o gráfico, sem precisar passar o mouse. Escolha onde aparece, o que aparece (número, nome, percentual ou combinações) e o tamanho da fonte."
                    open={openSections.has('rotulos')} onToggle={() => toggleSection('rotulos')}
                  >
                    <DataLabelsEditor value={draft.dataLabels} onChange={(v) => set({ dataLabels: v })} />
                    <SeriesLabelOverridesEditor items={seriesLabelItems} />
                  </CollapsibleSection>
                )}

                {isTable && (
                  <CollapsibleSection label="Tabela" open={openSections.has('tabela')} onToggle={() => toggleSection('tabela')}>
                    <Field label="Tamanho da fonte (px)" info="Tamanho do texto no corpo da tabela.">
                      <input
                        type="number" min={9} max={20}
                        value={draft.tableFormat?.fontSize ?? 11}
                        onChange={(e) => set({ tableFormat: { ...draft.tableFormat, fontSize: Number(e.target.value) || undefined } })}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Alinhamento do texto nas células" info="Alinhamento horizontal do texto dentro de cada célula da tabela (afeta cabeçalho e corpo).">
                      <div className="flex gap-1.5">
                        {(['left', 'center', 'right'] as const).map((a) => (
                          <button
                            key={a}
                            onClick={() => set({ tableFormat: { ...draft.tableFormat, align: a } })}
                            className={cn(
                              'flex-1 px-2 py-1.5 rounded-lg border text-[11px] font-medium capitalize',
                              (draft.tableFormat?.align ?? 'left') === a ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400',
                            )}
                          >
                            {a === 'left' ? 'Esquerda' : a === 'center' ? 'Centro' : 'Direita'}
                          </button>
                        ))}
                      </div>
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
