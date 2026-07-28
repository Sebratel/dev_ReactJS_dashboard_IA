// Well de medidas estilo Power BI (Eixo Y / Valores) — igual ao Eixo X: um
// botão "Selecionar" abre a mesma árvore fonte→coluna (AxisFieldPicker) pra
// escolher o campo. A diferença é que aqui cada campo escolhido vira uma
// pílula "{Agregação} de {Campo}" clicável, cujo flyout permite trocar o
// resumo (Contagem/Contagem distinta/Soma/Média), o campo, rótulo e cor.
import { useState } from 'react'
import { X, ChevronDown, ChevronRight, Plus, Search, Check, Database } from 'lucide-react'
import { cn } from '@/utils/cn'
import { InfoHint } from './InfoHint'
import type { AxisFieldGroup } from './AxisFieldPicker'
import type { AggKind, MeasureConfig } from './types'

const AGG_LABELS: Record<AggKind, string> = {
  countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média',
}
const COLORS = ['#ffb000', '#3b82f6', '#10b981', '#7c3aed', '#22d3ee', '#f97316', '#ef4444', '#6366f1', '#6b7280']
const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

function fieldsFor(agg: AggKind, numberGroups: AxisFieldGroup[], countGroups: AxisFieldGroup[]): AxisFieldGroup[] {
  return agg === 'sum' || agg === 'avg' ? numberGroups : countGroups
}

function defaultLabel(m: MeasureConfig, numberGroups: AxisFieldGroup[], countGroups: AxisFieldGroup[]): string {
  const agg = AGG_LABELS[m.agg]
  if (!m.field) return agg
  const f = fieldsFor(m.agg, numberGroups, countGroups).flatMap((g) => g.fields).find((f) => f.key === m.field)
  return `${agg} de ${f?.label ?? m.field}`
}

export function MeasureWell({ label, hint, info, measures, numberGroups, countGroups, onChange, onSwitchSource, allowMultiple = false, showColor = false }: {
  label: string
  hint?: string
  info?: string
  measures: MeasureConfig[]
  numberGroups: AxisFieldGroup[]
  countGroups: AxisFieldGroup[] // qualquer campo (não só numérico) — usado por Contagem/Contagem distinta
  onChange: (list: MeasureConfig[]) => void
  onSwitchSource?: (key: string) => void
  allowMultiple?: boolean
  showColor?: boolean
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const update = (i: number, patch: Partial<MeasureConfig>) =>
    onChange(measures.map((m, idx) => (idx === i ? { ...m, ...patch } : m)))
  const remove = (i: number) => {
    onChange(measures.filter((_, idx) => idx !== i))
    if (openIdx === i) setOpenIdx(null)
  }

  const toggleExpand = (key: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  // Ao escolher um campo na árvore, define uma agregação padrão sensata:
  // campo numérico → Soma; qualquer outro → Contagem distinta (igual ao PBI).
  const pickField = (key: string) => {
    const isNumber = numberGroups.some((g) => g.fields.some((f) => f.key === key))
    const measure: MeasureConfig = { agg: isNumber ? 'sum' : 'countDistinct', field: key }
    if (allowMultiple) {
      // Descarta a pílula-placeholder inicial (nunca tocada pelo usuário —
      // agg padrão, sem campo/rótulo/cor) em vez de acumular ao lado da nova.
      const isPristinePlaceholder = measures.length === 1
        && measures[0].agg === 'countDistinct' && !measures[0].field && !measures[0].label && !measures[0].color
      const base = isPristinePlaceholder ? [] : measures
      onChange([...base, measure])
      setOpenIdx(base.length)
    } else {
      onChange([measure])
      setOpenIdx(0)
    }
    setPickerOpen(false)
    setSearch('')
  }

  const filteredGroups = search
    ? countGroups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => f.label.toLowerCase().includes(search.toLowerCase())) }))
      .filter((g) => g.fields.length > 0)
    : countGroups

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
          {info && <InfoHint text={info} />}
        </span>
      </div>
      {hint && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}

      <div className="mt-1.5 space-y-1.5">
        {measures.length === 0 && <p className="text-[10px] text-gray-500 px-1 py-1">Sem campo</p>}
        {measures.map((m, i) => (
          <div key={i} className="rounded-lg border border-dashed border-app-border overflow-hidden">
            <div className="flex items-center gap-1 p-1">
              <button
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
                className="flex-1 flex items-center justify-between gap-1 px-2 py-1 rounded-md bg-brand-blue/10 border border-brand-blue/30 text-[11px] text-brand-blue text-left"
              >
                <span className="truncate">{m.label || defaultLabel(m, numberGroups, countGroups)}</span>
                <ChevronDown size={11} className={cn('shrink-0 transition-transform', openIdx === i && 'rotate-180')} />
              </button>
              {measures.length > 1 && (
                <button onClick={() => remove(i)} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical shrink-0"><X size={12} /></button>
              )}
            </div>

            {openIdx === i && (
              <div className="p-2 pt-0 space-y-1.5">
                <label className="block">
                  <span className="text-[9px] text-gray-500 uppercase">Resumo</span>
                  <select
                    value={m.agg}
                    onChange={(e) => update(i, { agg: e.target.value as AggKind, field: undefined })}
                    className={cn(inputCls, 'mt-0.5 text-[11px]')}
                  >
                    <option value="countDistinct">Contagem distinta</option>
                    <option value="count">Contagem</option>
                    <option value="sum">Soma</option>
                    <option value="avg">Média</option>
                  </select>
                </label>
                {(m.agg === 'sum' || m.agg === 'avg') && (
                  <label className="block">
                    <span className="text-[9px] text-gray-500 uppercase">Campo numérico</span>
                    <select
                      value={m.field ?? ''}
                      onChange={(e) => update(i, { field: e.target.value || undefined })}
                      className={cn(inputCls, 'mt-0.5 text-[11px]')}
                    >
                      <option value="">Selecione…</option>
                      {numberGroups.map((g) => (
                        <optgroup key={g.key} label={g.label}>
                          {g.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                )}
                {(m.agg === 'count' || m.agg === 'countDistinct') && (
                  <label className="block">
                    <span className="text-[9px] text-gray-500 uppercase">Campo</span>
                    <select
                      value={m.field ?? ''}
                      onChange={(e) => update(i, { field: e.target.value || undefined })}
                      className={cn(inputCls, 'mt-0.5 text-[11px]')}
                    >
                      <option value="">{m.agg === 'count' ? 'Todas as linhas' : 'Linha inteira (todos os campos)'}</option>
                      {countGroups.map((g) => (
                        <optgroup key={g.key} label={g.label}>
                          {g.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                )}
                <label className="block">
                  <span className="text-[9px] text-gray-500 uppercase">Rótulo (opcional)</span>
                  <input
                    value={m.label ?? ''}
                    onChange={(e) => update(i, { label: e.target.value || undefined })}
                    placeholder={defaultLabel(m, numberGroups, countGroups)}
                    className={cn(inputCls, 'mt-0.5 text-[11px]')}
                  />
                </label>
                {showColor && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[9px] text-gray-500 mr-0.5">Cor:</span>
                    {COLORS.map((c) => (
                      <button
                        type="button"
                        key={c}
                        onClick={() => update(i, { color: c })}
                        className={cn(
                          'h-4 w-4 rounded-full border border-black/40',
                          m.color === c && 'outline outline-2 outline-offset-1 outline-brand-blue',
                        )}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        <button
          onClick={() => setPickerOpen((v) => !v)}
          className={cn('flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-colors', pickerOpen ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400 hover:border-app-borderLight')}
        >
          <Plus size={11} /> Selecionar
        </button>
      </div>

      {pickerOpen && (
        <div className="mt-1.5 rounded-lg border border-app-border bg-app-surface p-2">
          <div className="flex items-center gap-1.5 rounded-md border border-app-border bg-app-card px-2 py-1 mb-1.5">
            <Search size={11} className="text-gray-500 shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar tabela ou coluna…"
              className="w-full bg-transparent text-[11px] text-gray-200 placeholder:text-gray-500 outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-app-border divide-y divide-app-border/60">
            {filteredGroups.length === 0 && <p className="text-[10px] text-gray-500 px-2 py-2">Nenhum campo encontrado.</p>}
            {filteredGroups.map((g) => {
              const isOpen = !g.foreign && (expanded.has(g.key) || !!search)
              return (
                <div key={g.key}>
                  <button
                    onClick={() => g.foreign ? onSwitchSource?.(g.key) : toggleExpand(g.key)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-gray-300 hover:bg-app-card/60"
                  >
                    {g.foreign
                      ? <span className="w-[11px] shrink-0" />
                      : <ChevronRight size={11} className={cn('shrink-0 transition-transform text-gray-500', isOpen && 'rotate-90')} />}
                    <Database size={10} className="shrink-0 opacity-60" />
                    <span className="truncate font-medium">{g.label}</span>
                    {g.foreign && <span className="ml-auto shrink-0 text-[10px] text-brand-blue">usar esta fonte</span>}
                  </button>
                  {isOpen && (
                    <div className="pl-8 pb-1.5 pr-2 space-y-0.5 bg-app-surface/40">
                      {g.fields.length === 0 && <p className="text-[10px] text-gray-600 italic py-1">sem colunas</p>}
                      {g.fields.map((f) => {
                        const isSelected = measures.some((m) => m.field === f.key)
                        return (
                          <div key={f.key} className="flex items-center gap-0.5">
                            <button
                              onClick={() => pickField(f.key)}
                              className={cn(
                                'flex-1 min-w-0 flex items-center justify-between gap-1 text-left px-2 py-1 rounded-md text-[11px] transition-colors',
                                isSelected ? 'text-brand-blue/70' : 'text-gray-300 hover:bg-brand-blue/10 hover:text-brand-blue',
                              )}
                            >
                              <span className="truncate">{f.label}</span>
                              {isSelected && <Check size={11} className="shrink-0" />}
                            </button>
                            {f.description && <InfoHint text={f.description} />}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
