// Well de medidas estilo Power BI (Eixo Y / Valores) — igual ao Eixo X: um
// botão "Selecionar" abre a mesma árvore fonte→coluna (AxisFieldPicker) pra
// escolher o campo. A diferença é que aqui cada campo escolhido vira uma
// pílula "{Agregação} de {Campo}" clicável, cujo flyout permite trocar o
// resumo (Contagem/Contagem distinta/Soma/Média), o campo, rótulo e cor.
import { useState } from 'react'
import { X, ChevronDown, ChevronRight, Plus, Search, Check, Database, Sigma, Calculator } from 'lucide-react'
import { cn } from '@/utils/cn'
import { InfoHint } from './InfoHint'
import type { AxisFieldGroup } from './AxisFieldPicker'
import type { AggKind, MeasureConfig, MeasureDef } from './types'

const AGG_LABELS: Record<AggKind, string> = {
  countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média',
}
const COLORS = ['#ffb000', '#3b82f6', '#10b981', '#7c3aed', '#22d3ee', '#f97316', '#ef4444', '#6366f1', '#6b7280']
const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

// Prefixo que marca uma chave da árvore "Selecionar" como uma medida salva
// (em vez de um campo cru) — permite misturar as duas na MESMA lista/busca,
// sem precisar de uma segunda árvore/UI separada pra medida (ver pickMeasureRef).
const MEASURE_KEY_PREFIX = 'measure:'

// Resumo de 1 linha pra mostrar como descrição (InfoHint) do item na árvore,
// quando a medida não tem uma `description` própria — mesmo espírito de
// summarizeMeasure em ai/AiPanel.tsx.
function measureSummary(m: MeasureDef): string | undefined {
  if (m.description) return m.description
  if (m.kind === 'formula') return m.expression
  return undefined
}

// Um pill de medida recém-criado (por pickField/pickMeasureRef) que ainda não
// foi tocado por ninguém — nem campo, nem medida salva, nem rótulo/cor.
// Descartado (em vez de acumulado ao lado do novo) quando o usuário adiciona
// a 2ª+ medida de uma série múltipla, senão a série nasceria com uma pílula
// vazia sobrando. Checa measureRef também (não só field) — sem isso, a
// PRIMEIRA medida escolhida via "Medida salva"/árvore de Medidas seria
// descartada por engano ao adicionar uma 2ª medida à mesma série múltipla.
function isPristinePlaceholder(measures: MeasureConfig[]): boolean {
  return measures.length === 1 && measures[0].agg === 'countDistinct'
    && !measures[0].field && !measures[0].measureRef && !measures[0].label && !measures[0].color
}

function fieldsFor(agg: AggKind, numberGroups: AxisFieldGroup[], countGroups: AxisFieldGroup[]): AxisFieldGroup[] {
  return agg === 'sum' || agg === 'avg' ? numberGroups : countGroups
}

function defaultLabel(m: MeasureConfig, numberGroups: AxisFieldGroup[], countGroups: AxisFieldGroup[], dashboardMeasures: MeasureDef[]): string {
  if (m.measureRef) return dashboardMeasures.find((d) => d.id === m.measureRef)?.name ?? 'Medida removida'
  const agg = AGG_LABELS[m.agg]
  if (!m.field) return agg
  const f = fieldsFor(m.agg, numberGroups, countGroups).flatMap((g) => g.fields).find((f) => f.key === m.field)
  return `${agg} de ${f?.label ?? m.field}`
}

export function MeasureWell({ label, hint, info, measures, numberGroups, countGroups, onChange, onSwitchSource, allowMultiple = false, showColor = false, dashboardMeasures, widgetSource, hasDimension = false }: {
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
  // "Tabela de medidas" da dashboard (ver MeasureDef) — omitido ou vazio
  // esconde por completo o modo "Medida salva" (usado nos slots que ainda
  // não suportam measureRef, ver server/widgetQuery.mjs: measureX, matrixValue).
  // `hasDimension`: true quando o widget ATUAL tem um eixo com dimensão
  // (Eixo X, ou pizza/dispersão com categoria) — só medida 'simple' da MESMA
  // fonte do widget fica elegível ali (ver "Nível 2"); um KPI/sem dimensão
  // aceita qualquer medida, inclusive fórmula cruzando fontes ("Nível 1").
  dashboardMeasures?: MeasureDef[]
  widgetSource?: string
  hasDimension?: boolean
}) {
  const eligibleMeasures = (dashboardMeasures ?? []).filter((m) => !hasDimension || (m.kind === 'simple' && m.source === widgetSource))
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // "Medidas" já nasce expandida (quando existe) — é a tabela virtual nova,
  // vale chamar atenção pra ela em vez de exigir mais um clique só pra achar.
  const [expanded, setExpanded] = useState<Set<string>>(() => (eligibleMeasures.length > 0 ? new Set(['__measures__']) : new Set()))
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

  // Adiciona um MeasureConfig já pronto (de um campo cru ou de uma medida
  // salva, ver pickField/pickMeasureRef abaixo) na lista — mesma regra pras
  // duas origens: some (série múltipla) ou substitui (série única).
  const addMeasure = (measure: MeasureConfig) => {
    if (allowMultiple) {
      const base = isPristinePlaceholder(measures) ? [] : measures
      onChange([...base, measure])
      setOpenIdx(base.length)
    } else {
      onChange([measure])
      setOpenIdx(0)
    }
    setPickerOpen(false)
    setSearch('')
  }

  // Ao escolher um campo na árvore, define uma agregação padrão sensata:
  // campo numérico → Soma; qualquer outro → Contagem distinta (igual ao PBI).
  const pickField = (key: string) => {
    const isNumber = numberGroups.some((g) => g.fields.some((f) => f.key === key))
    addMeasure({ agg: isNumber ? 'sum' : 'countDistinct', field: key })
  }
  // Ao escolher uma medida salva na árvore (grupo "Medidas", ver measureGroup
  // abaixo) — mesmo default (Contagem distinta) do toggle "Medida salva" de
  // sempre; agg/field ficam sem efeito quando measureRef está presente.
  const pickMeasureRef = (id: string) => addMeasure({ agg: 'countDistinct', measureRef: id })

  // "Medidas" — tabela virtual no topo da árvore, ao lado das fontes reais,
  // pra escolher uma medida salva com a MESMA interação de escolher uma
  // coluna (clicar expande, clicar de novo seleciona) — em vez de precisar
  // abrir a pílula depois de criada e trocar pelo toggle "Medida salva".
  // Reaproveita `eligibleMeasures` (já filtrado por Nível 1/2 conforme o
  // slot) — por isso nunca aparece em measureX/matrixValue, que não recebem
  // `dashboardMeasures` (ainda não suportam medida nomeada, ver runWidgetQuery).
  const measureGroup: AxisFieldGroup | null = eligibleMeasures.length > 0 ? {
    key: '__measures__',
    label: 'Medidas',
    fields: eligibleMeasures.map((m) => ({ key: `${MEASURE_KEY_PREFIX}${m.id}`, label: m.name, description: measureSummary(m) })),
  } : null
  const allGroups = measureGroup ? [measureGroup, ...countGroups] : countGroups

  const filteredGroups = search
    ? allGroups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => f.label.toLowerCase().includes(search.toLowerCase())) }))
      .filter((g) => g.fields.length > 0)
    : allGroups

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
                <span className="truncate">{m.label || defaultLabel(m, numberGroups, countGroups, dashboardMeasures ?? [])}</span>
                <ChevronDown size={11} className={cn('shrink-0 transition-transform', openIdx === i && 'rotate-180')} />
              </button>
              {measures.length > 1 && (
                <button onClick={() => remove(i)} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical shrink-0"><X size={12} /></button>
              )}
            </div>

            {openIdx === i && (
              <div className="p-2 pt-0 space-y-1.5">
                {eligibleMeasures.length > 0 && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => update(i, { measureRef: undefined })}
                      className={cn('flex-1 flex items-center justify-center gap-1 px-1.5 py-1 rounded-md border text-[10px] font-medium', !m.measureRef ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-500')}
                    >
                      <Sigma size={10} /> Cálculo simples
                    </button>
                    <button
                      onClick={() => update(i, { measureRef: eligibleMeasures[0]?.id, agg: 'countDistinct', field: undefined })}
                      className={cn('flex-1 flex items-center justify-center gap-1 px-1.5 py-1 rounded-md border text-[10px] font-medium', m.measureRef ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-500')}
                    >
                      <Calculator size={10} /> Medida salva
                    </button>
                  </div>
                )}
                {m.measureRef ? (
                  <label className="block">
                    <span className="text-[9px] text-gray-500 uppercase">Medida da dashboard</span>
                    <select
                      value={m.measureRef}
                      onChange={(e) => update(i, { measureRef: e.target.value })}
                      className={cn(inputCls, 'mt-0.5 text-[11px]')}
                    >
                      {eligibleMeasures.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                    {hasDimension && <p className="text-[9px] text-gray-500 mt-1">Só medidas simples da mesma fonte deste widget aparecem aqui — uma fórmula ou medida de outra fonte só pode ser usada num Card (KPI).</p>}
                  </label>
                ) : (
                  <>
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
                  </>
                )}
                <label className="block">
                  <span className="text-[9px] text-gray-500 uppercase">Rótulo (opcional)</span>
                  <input
                    value={m.label ?? ''}
                    onChange={(e) => update(i, { label: e.target.value || undefined })}
                    placeholder={defaultLabel(m, numberGroups, countGroups, dashboardMeasures ?? [])}
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
                    {g.key === '__measures__' ? <Calculator size={10} className="shrink-0 opacity-60" /> : <Database size={10} className="shrink-0 opacity-60" />}
                    <span className="truncate font-medium">{g.label}</span>
                    {g.foreign && <span className="ml-auto shrink-0 text-[10px] text-brand-blue">usar esta fonte</span>}
                  </button>
                  {isOpen && (
                    <div className="pl-8 pb-1.5 pr-2 space-y-0.5 bg-app-surface/40">
                      {g.fields.length === 0 && <p className="text-[10px] text-gray-600 italic py-1">sem colunas</p>}
                      {g.fields.map((f) => {
                        const isMeasure = f.key.startsWith(MEASURE_KEY_PREFIX)
                        const isSelected = isMeasure
                          ? measures.some((m) => m.measureRef === f.key.slice(MEASURE_KEY_PREFIX.length))
                          : measures.some((m) => m.field === f.key)
                        return (
                          <div key={f.key} className="flex items-center gap-0.5">
                            <button
                              onClick={() => isMeasure ? pickMeasureRef(f.key.slice(MEASURE_KEY_PREFIX.length)) : pickField(f.key)}
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
