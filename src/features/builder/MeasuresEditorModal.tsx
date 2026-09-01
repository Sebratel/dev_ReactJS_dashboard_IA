// Modal de gerenciamento da "tabela de medidas" da DASHBOARD (ver MeasureDef,
// types.ts) — reutilizável em qualquer guia/widget desta mesma dashboard.
// Cobre o caminho MANUAL (pra quem já sabe a fórmula que quer, sem precisar
// da IA) — o caminho principal pra quem não entende de cálculo é pedir pra
// IA (ver AiPanel), que propõe medidas aqui dentro pra revisão/aprovação.
//
// Duas formas de medida: 'simple' (uma agregação comum, com uma janela de
// data relativa opcional) e 'formula' (combina OUTRAS medidas nomeadas numa
// expressão aritmética — nunca um campo cru direto, sempre outra medida).
import { useEffect, useState } from 'react'
import { AlertTriangle, Calculator, Sigma, Plus, X, Trash2, Pencil } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { InfoHint } from './InfoHint'
import { FieldWell } from './FieldWell'
import { fetchFieldValues } from './builderApi'
import { getAllSources, getSourceDef } from './fieldCatalog'
import {
  decomposeFormula, buildFormulaFromSteps, humanFormulaLabel,
  FORMULA_OP_LABELS, FORMULA_OP_SYMBOLS,
  type FormulaTerm, type FormulaStep, type FormulaOp,
} from './measureExprClient'
import type { AggKind, DateWindowSpec, MeasureDef, MeasureFormat, SourceTable, TabConfig, WidgetFilter } from './types'

const EMPTY_TERM: FormulaTerm = { kind: 'measure', measureId: '' }

// Escolhe entre uma medida já existente (padrão) ou um número fixo (ex.
// dividir por uma constante, simular +20%) — usado pra "Referência N" do
// construtor passo a passo de fórmula.
function FormulaTermPicker({ term, measures, onChange }: { term: FormulaTerm; measures: MeasureDef[]; onChange: (t: FormulaTerm) => void }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onChange({ kind: 'measure', measureId: '' })} className={cn('flex-1 px-1.5 py-1 rounded-md border text-[10px] font-medium', term.kind === 'measure' ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-500')}>
          Medida
        </button>
        <button type="button" onClick={() => onChange({ kind: 'number', value: 0 })} className={cn('flex-1 px-1.5 py-1 rounded-md border text-[10px] font-medium', term.kind === 'number' ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-500')}>
          Número fixo
        </button>
      </div>
      {term.kind === 'measure' ? (
        <select value={term.measureId} onChange={(e) => onChange({ kind: 'measure', measureId: e.target.value })} className={cn(inputCls, 'text-[11px]')}>
          <option value="">Selecione a medida…</option>
          {measures.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      ) : (
        <input type="number" value={term.value} onChange={(e) => onChange({ kind: 'number', value: Number(e.target.value) })} className={cn(inputCls, 'text-[11px]')} />
      )}
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'
const AGG_LABELS: Record<AggKind, string> = { countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média' }

type BaseWindowType = 'none' | 'lastNDays' | 'lastNMonths' | 'yearToDate' | 'currentMonth' | 'currentQuarter' | 'currentYear'
const BASE_WINDOW_LABELS: Record<Exclude<BaseWindowType, 'none'>, string> = {
  lastNDays: 'Últimos N dias', lastNMonths: 'Últimos N meses', yearToDate: 'Ano até a data',
  currentMonth: 'Mês atual', currentQuarter: 'Trimestre atual', currentYear: 'Ano atual',
}

// Decompõe um DateWindowSpec salvo de volta pro formulário (tipo base + n +
// campo + "comparar com ano anterior") — shiftYears nunca é escolhido direto
// na UI manual, só como um checkbox por cima de qualquer janela base (cobre
// o caso "mesmo período do ano passado" sem expor a recursão do tipo).
function decomposeWindow(w: DateWindowSpec | undefined): { baseType: BaseWindowType; n: number; field: string; shiftPreviousYear: boolean } {
  if (!w) return { baseType: 'none', n: 3, field: '', shiftPreviousYear: false }
  const inner = w.type === 'shiftYears' ? w.base : w
  const n = 'n' in inner ? inner.n : 3
  return { baseType: inner.type, n, field: inner.field, shiftPreviousYear: w.type === 'shiftYears' }
}
function composeWindow(baseType: BaseWindowType, n: number, field: string, shiftPreviousYear: boolean): DateWindowSpec | undefined {
  if (baseType === 'none' || !field) return undefined
  const base = (baseType === 'lastNDays' || baseType === 'lastNMonths')
    ? { type: baseType, field, n: Math.max(1, n) } as DateWindowSpec
    : { type: baseType, field } as DateWindowSpec
  return shiftPreviousYear ? { type: 'shiftYears', years: -1, base: base as Exclude<DateWindowSpec, { type: 'shiftYears' }> } : base
}

// "Usada em" — só pra quem for apagar/renomear decidir com informação (ver
// HISTORICO_ALTERACOES.md: apagar nunca é bloqueado, só avisa).
function usageOf(measureId: string, tabs: TabConfig[], measures: MeasureDef[]): string[] {
  const uses: string[] = []
  for (const t of tabs) {
    for (const w of t.widgets) {
      const slots = [w.measure, ...(w.measures ?? []), w.measureX, w.matrixValue]
      if (slots.some((m) => m?.measureRef === measureId)) uses.push(`Widget "${w.title || w.type}" (guia "${t.label}")`)
    }
  }
  for (const m of measures) {
    if (m.id !== measureId && m.kind === 'formula' && Object.values(m.refs ?? {}).includes(measureId)) uses.push(`Medida "${m.name}"`)
  }
  return uses
}

function MeasureForm({ initial, measures, onSave, onCancel }: {
  initial: MeasureDef | null
  measures: MeasureDef[]
  onSave: (m: MeasureDef) => void
  onCancel: () => void
}) {
  const sources = getAllSources()
  const [kind, setKind] = useState<'simple' | 'formula'>(initial?.kind ?? 'simple')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  // Formatação de exibição (ver MeasureFormat, types.ts) — vale pras duas
  // formas de medida (simple ou formula), por isso fica fora do bloco
  // condicional por kind mais abaixo.
  const [format, setFormat] = useState<MeasureFormat | undefined>(initial?.format)

  const [source, setSource] = useState<SourceTable>(initial?.kind === 'simple' ? initial.source : (sources[0]?.key ?? ''))
  const [agg, setAgg] = useState<AggKind>(initial?.kind === 'simple' ? initial.agg : 'countDistinct')
  const [field, setField] = useState(initial?.kind === 'simple' ? (initial.field ?? '') : '')
  const initWindow = decomposeWindow(initial?.kind === 'simple' ? initial.dateWindow : undefined)
  const [baseType, setBaseType] = useState<BaseWindowType>(initWindow.baseType)
  const [windowN, setWindowN] = useState(initWindow.n)
  const [windowField, setWindowField] = useState(initWindow.field)
  const [shiftPreviousYear, setShiftPreviousYear] = useState(initWindow.shiftPreviousYear)

  const [expression, setExpression] = useState(initial?.kind === 'formula' ? initial.expression : '')
  const [refs, setRefs] = useState<Record<string, string>>(initial?.kind === 'formula' ? initial.refs : {})
  const [newRefAlias, setNewRefAlias] = useState('')
  const [newRefMeasureId, setNewRefMeasureId] = useState('')

  // Construtor "passo a passo" de fórmula (padrão) vs. "modo avançado"
  // (expressão em texto, ver bloco de `expression`/`refs` acima) — só entra
  // em modo avançado de saída quando a fórmula já salva não decompõe numa
  // cadeia simples (ex. escrita à mão com % / ^ / parênteses "invertidos").
  const initialFormulaDecomp = initial?.kind === 'formula' ? decomposeFormula(initial.expression, initial.refs) : null
  const [formulaMode, setFormulaMode] = useState<'steps' | 'text'>(initial?.kind === 'formula' && !initialFormulaDecomp ? 'text' : 'steps')
  const [firstTerm, setFirstTerm] = useState<FormulaTerm>(initialFormulaDecomp?.first ?? EMPTY_TERM)
  const [formulaSteps, setFormulaSteps] = useState<FormulaStep[]>(initialFormulaDecomp?.steps ?? [{ op: '+', term: EMPTY_TERM }])
  const [stepsResetNotice, setStepsResetNotice] = useState(false)

  // Filtro fixo por valor/categoria, embutido na PRÓPRIA medida — diferente
  // do filtro de aba (contextual). Mesma v1 pragmática do filtro fixo de
  // widget (um filtro por medida cobre o caso comum: isolar/excluir um
  // status, uma equipe, um tipo — ver WidgetEditorModal "Filtro fixo do
  // widget"); o tipo (WidgetFilter[]) já comporta mais de um no futuro.
  const [filter, setFilter] = useState<WidgetFilter | undefined>(initial?.kind === 'simple' ? initial.filters?.[0] : undefined)
  const [filterValues, setFilterValues] = useState<string[] | null>(null)

  const sourceDef = getSourceDef(source)
  const dateFields = sourceDef?.fields.filter((f) => f.kind === 'date') ?? []
  const numberFields = sourceDef?.fields.filter((f) => f.kind === 'number') ?? []
  const filterableFields = sourceDef?.fields.filter((f) => f.kind === 'dimension') ?? []
  const availableForRefs = measures.filter((m) => m.id !== initial?.id)

  useEffect(() => {
    setFilterValues(null)
    if (!filter || !source) return
    fetchFieldValues(source, filter.field).then(setFilterValues).catch(() => setFilterValues([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, filter?.field])

  const stepsFormula = formulaMode === 'steps' ? buildFormulaFromSteps(firstTerm, formulaSteps) : null

  const canSave = name.trim().length > 0 && (
    kind === 'simple'
      ? !!source && (agg !== 'sum' && agg !== 'avg' ? true : !!field)
      : formulaMode === 'steps'
        ? !!stepsFormula
        : expression.trim().length > 0 && Object.keys(refs).length > 0
  )

  const addRef = () => {
    if (!newRefAlias.trim() || !newRefMeasureId) return
    setRefs((prev) => ({ ...prev, [newRefAlias.trim()]: newRefMeasureId }))
    setNewRefAlias(''); setNewRefMeasureId('')
  }
  const removeRef = (alias: string) => setRefs((prev) => { const next = { ...prev }; delete next[alias]; return next })

  const updateStep = (i: number, patch: Partial<FormulaStep>) => setFormulaSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const removeStep = (i: number) => setFormulaSteps((prev) => prev.filter((_, idx) => idx !== i))
  const addStep = () => setFormulaSteps((prev) => [...prev, { op: '+', term: EMPTY_TERM }])

  // Trocar de modo NUNCA perde o que já foi montado: ir pro avançado escreve
  // a expressão equivalente à cadeia atual; voltar pro passo a passo tenta
  // decompor o texto atual de volta — só reseta (com aviso) se a expressão
  // for complexa demais pra representar como cadeia simples.
  const switchToText = () => {
    if (stepsFormula) { setExpression(stepsFormula.expression); setRefs(stepsFormula.refs) }
    setFormulaMode('text')
  }
  const switchToSteps = () => {
    const decomp = expression.trim() ? decomposeFormula(expression, refs) : null
    if (decomp) {
      setFirstTerm(decomp.first); setFormulaSteps(decomp.steps); setStepsResetNotice(false)
    } else {
      setFirstTerm(EMPTY_TERM); setFormulaSteps([{ op: '+', term: EMPTY_TERM }]); setStepsResetNotice(!!expression.trim())
    }
    setFormulaMode('steps')
  }

  const save = () => {
    if (!canSave) return
    const id = initial?.id ?? `msr-${Date.now().toString(36)}`
    const base = { id, name: name.trim(), description: description.trim() || undefined }
    if (kind === 'simple') {
      const filters = filter && filter.values.length > 0 ? [filter] : undefined
      onSave({ ...base, kind: 'simple', source, agg, field: (agg === 'sum' || agg === 'avg' || field) ? field || undefined : undefined, dateWindow: composeWindow(baseType, windowN, windowField, shiftPreviousYear), filters, format })
    } else {
      const formula = formulaMode === 'steps' ? stepsFormula! : { expression: expression.trim(), refs }
      onSave({ ...base, kind: 'formula', expression: formula.expression, refs: formula.refs, format })
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-app-border p-3 space-y-2.5">
      <div className="flex items-center gap-1.5">
        <button onClick={() => setKind('simple')} className={cn('flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border text-[11px] font-medium', kind === 'simple' ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}>
          <Sigma size={11} /> Cálculo simples
        </button>
        <button onClick={() => setKind('formula')} className={cn('flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border text-[11px] font-medium', kind === 'formula' ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}>
          <Calculator size={11} /> Fórmula (combina medidas)
        </button>
      </div>

      <label className="block">
        <span className="block text-[10px] text-gray-500 mb-0.5">Nome da medida</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Protocolos últimos 3 meses" className={inputCls} />
      </label>

      {kind === 'simple' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Fonte</span>
              <select value={source} onChange={(e) => { setSource(e.target.value); setField(''); setWindowField(''); setFilter(undefined) }} className={inputCls}>
                {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Agregação</span>
              <select value={agg} onChange={(e) => setAgg(e.target.value as AggKind)} className={inputCls}>
                <option value="countDistinct">Contagem distinta</option>
                <option value="count">Contagem</option>
                <option value="sum">Soma</option>
                <option value="avg">Média</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="block text-[10px] text-gray-500 mb-0.5">{agg === 'sum' || agg === 'avg' ? 'Campo numérico' : 'Campo (opcional)'}</span>
            <select value={field} onChange={(e) => setField(e.target.value)} className={inputCls}>
              <option value="">{agg === 'count' ? 'Todas as linhas' : agg === 'countDistinct' ? 'Linha inteira' : 'Selecione…'}</option>
              {(agg === 'sum' || agg === 'avg' ? numberFields : sourceDef?.fields ?? []).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>

          <div className="rounded-md border border-app-border/60 bg-app-surface/40 p-2 space-y-1.5">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Janela de data (opcional)</span>
            <select value={baseType} onChange={(e) => setBaseType(e.target.value as BaseWindowType)} className={cn(inputCls, 'text-[11px]')}>
              <option value="none">Sem janela — todo o período</option>
              {Object.entries(BASE_WINDOW_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {baseType !== 'none' && (
              <>
                <label className="block">
                  <span className="block text-[10px] text-gray-500 mb-0.5">Campo de data</span>
                  <select value={windowField} onChange={(e) => setWindowField(e.target.value)} className={cn(inputCls, 'text-[11px]')}>
                    <option value="">Selecione…</option>
                    {dateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </label>
                {(baseType === 'lastNDays' || baseType === 'lastNMonths') && (
                  <label className="block">
                    <span className="block text-[10px] text-gray-500 mb-0.5">{baseType === 'lastNDays' ? 'Quantos dias' : 'Quantos meses'}</span>
                    <input type="number" min={1} value={windowN} onChange={(e) => setWindowN(Math.max(1, Number(e.target.value) || 1))} className={cn(inputCls, 'text-[11px]')} />
                  </label>
                )}
                <label className="flex items-center gap-1.5 cursor-pointer pt-0.5">
                  <input type="checkbox" checked={shiftPreviousYear} onChange={(e) => setShiftPreviousYear(e.target.checked)} className="accent-[#ffb000]" />
                  <span className="text-[11px] text-gray-300">Comparar com o mesmo período do ano anterior</span>
                </label>
              </>
            )}
          </div>

          <div className="rounded-md border border-app-border/60 bg-app-surface/40 p-2 space-y-1.5">
            <FieldWell
              label="Filtro fixo (opcional)"
              hint="vale sempre que a medida for usada — diferente do filtro da aba"
              info="Isola/exclui um valor de categoria, sempre — ex. Status = Reincidência, ou excluir Cancelado. Diferente do filtro da aba (que quem vê a tela pode mudar): este é parte da definição da medida."
              allOptions={filterableFields}
              selectedKeys={filter ? [filter.field] : []}
              onAdd={(f) => setFilter({ field: f, op: 'in', values: [] })}
              onRemove={() => setFilter(undefined)}
            />
            {filter && (
              <div>
                <select value={filter.op} onChange={(e) => setFilter({ ...filter, op: e.target.value as WidgetFilter['op'] })} className={cn(inputCls, 'text-[11px] mb-1.5')}>
                  <option value="in">está em</option>
                  <option value="notIn">não está em</option>
                </select>
                <div className="max-h-28 overflow-auto flex flex-wrap gap-1.5 rounded-lg border border-app-border p-2">
                  {filterValues === null && <span className="text-[10px] text-gray-500">Carregando valores…</span>}
                  {(filterValues ?? []).map((v) => {
                    const on = filter.values.includes(v)
                    return (
                      <button
                        key={v}
                        onClick={() => setFilter({ ...filter, values: on ? filter.values.filter((x) => x !== v) : [...filter.values, v] })}
                        className={cn('px-2 py-0.5 rounded-md border text-[10px]', on ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-500')}
                      >
                        {v}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      ) : formulaMode === 'steps' ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-gray-500">Combine medidas numa conta, passo a passo — sem precisar escrever fórmula.</span>
            <button type="button" onClick={switchToText} className="shrink-0 text-[10px] text-brand-blue hover:text-brand-blueLight underline underline-offset-2">
              Modo avançado
            </button>
          </div>

          <div>
            <span className="block text-[10px] text-gray-500 mb-0.5">Referência 1</span>
            <FormulaTermPicker term={firstTerm} measures={availableForRefs} onChange={setFirstTerm} />
          </div>

          {formulaSteps.map((s, i) => (
            <div key={i} className="rounded-md border border-app-border/60 bg-app-surface/40 p-2 space-y-1.5 relative">
              <button type="button" onClick={() => removeStep(i)} className="absolute top-1.5 right-1.5 text-gray-500 hover:text-risk-critical" title="Remover este cálculo">
                <X size={11} />
              </button>
              <label className="block pr-5">
                <span className="block text-[10px] text-gray-500 mb-0.5">O que fazer</span>
                <select value={s.op} onChange={(e) => updateStep(i, { op: e.target.value as FormulaOp })} className={cn(inputCls, 'text-[11px]')}>
                  {(Object.keys(FORMULA_OP_LABELS) as FormulaOp[]).map((op) => (
                    <option key={op} value={op}>{FORMULA_OP_SYMBOLS[op]} {FORMULA_OP_LABELS[op]}</option>
                  ))}
                </select>
              </label>
              <div>
                <span className="block text-[10px] text-gray-500 mb-0.5">Referência {i + 2}</span>
                <FormulaTermPicker term={s.term} measures={availableForRefs} onChange={(t) => updateStep(i, { term: t })} />
              </div>
            </div>
          ))}

          {formulaSteps.length === 0 && <p className="text-[10px] text-gray-500 italic">Adicione pelo menos um cálculo.</p>}
          <button type="button" onClick={addStep} className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight">
            <Plus size={12} /> Adicionar mais um cálculo
          </button>
          {stepsResetNotice && (
            <p className="text-[10px] text-risk-critical">Essa fórmula é complexa demais pro modo passo a passo — comece do zero aqui, ou clique em "Modo avançado" de novo pra editá-la como texto sem perder nada.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-gray-500">Escreva a expressão diretamente — mais poder (%, potência), mais exigente.</span>
            <button type="button" onClick={switchToSteps} className="shrink-0 text-[10px] text-brand-blue hover:text-brand-blueLight underline underline-offset-2">
              Modo passo a passo
            </button>
          </div>
          <label className="block">
            <span className="text-[10px] text-gray-500 mb-0.5 flex items-center gap-1">
              Expressão <InfoHint text="Combine as medidas referenciadas abaixo com + - * / % ^ e parênteses. Ex.: (atual - anterior) / anterior * 100" />
            </span>
            <input value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="ex.: (atual - anterior) / anterior * 100" className={cn(inputCls, 'font-mono')} />
          </label>
          <div className="space-y-1">
            <span className="text-[10px] text-gray-500">Medidas referenciadas (o nome usado na expressão)</span>
            {Object.entries(refs).length === 0 && <p className="text-[10px] text-gray-600 italic">Nenhuma ainda.</p>}
            {Object.entries(refs).map(([alias, id]) => (
              <div key={alias} className="flex items-center gap-1.5 text-[11px] text-gray-300 bg-app-surface rounded-md px-2 py-1">
                <span className="font-mono text-brand-blue">{alias}</span> = {measures.find((m) => m.id === id)?.name ?? '(medida removida)'}
                <button onClick={() => removeRef(alias)} className="ml-auto text-gray-500 hover:text-risk-critical"><X size={11} /></button>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_1.5fr_auto] gap-1.5">
              <input value={newRefAlias} onChange={(e) => setNewRefAlias(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} placeholder="alias" className={cn(inputCls, 'text-[11px]')} />
              <select value={newRefMeasureId} onChange={(e) => setNewRefMeasureId(e.target.value)} className={cn(inputCls, 'text-[11px]')}>
                <option value="">Selecione a medida…</option>
                {availableForRefs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button onClick={addRef} disabled={!newRefAlias.trim() || !newRefMeasureId} className="px-2 rounded-md border border-app-border text-gray-400 hover:border-brand-blue hover:text-brand-blue disabled:opacity-40"><Plus size={12} /></button>
            </div>
          </div>
        </div>
      )}

      <label className="flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" checked={format === 'percent'} onChange={(e) => setFormat(e.target.checked ? 'percent' : undefined)} className="accent-[#ffb000]" />
        <span className="text-[11px] text-gray-300 flex items-center gap-1">
          Mostrar como percentual
          <InfoHint text="Acrescenta o sinal % na exibição (num Card/KPI) — não divide nem multiplica o valor de novo. Use quando o cálculo já entrega o número na escala 0-100, ex. uma razão * 100." />
        </span>
      </label>

      <label className="block">
        <span className="block text-[10px] text-gray-500 mb-0.5">Descrição {kind === 'formula' && '(recomendado explicar a suposição, principalmente se as medidas referenciadas forem de fontes diferentes)'}</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={cn(inputCls, 'resize-none')} />
      </label>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-app-border text-[11px] text-gray-300 hover:border-app-borderLight">Cancelar</button>
        <button onClick={save} disabled={!canSave} className="px-3 py-1.5 rounded-lg bg-brand-blue text-white text-[11px] font-semibold hover:bg-brand-blueLight disabled:opacity-50">Salvar medida</button>
      </div>
    </div>
  )
}

export function MeasuresEditorModal({ measures, tabs, onChange, onClose }: {
  measures: MeasureDef[]
  tabs: TabConfig[]
  onChange: (measures: MeasureDef[]) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<'new' | string | null>(null)

  const upsert = (m: MeasureDef) => {
    onChange(measures.some((x) => x.id === m.id) ? measures.map((x) => (x.id === m.id ? m : x)) : [...measures, m])
    setEditing(null)
  }
  const remove = (id: string) => onChange(measures.filter((m) => m.id !== id))

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="w-full max-w-lg rounded-2xl border border-app-border bg-app-card shadow-card-lg max-h-[85vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border shrink-0">
            <h2 className="text-sm font-bold text-gray-100">Tabela de medidas da dashboard</h2>
            <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
          </div>
          <div className="p-5 space-y-4 overflow-y-auto">
            <p className="text-[11px] text-gray-500">
              Medidas nomeadas e reutilizáveis em qualquer guia/widget desta dashboard — escolha "Medida salva" no
              Eixo Y de um widget pra usar uma delas. O caminho mais fácil pra criar é pedir pro assistente de IA
              (botão "IA", descrevendo o cálculo em português); aqui é o caminho manual, pra quem já sabe a fórmula.
            </p>

            {measures.length > 0 ? (
              <div className="space-y-1.5">
                {measures.map((m) => {
                  const uses = usageOf(m.id, tabs, measures)
                  return editing === m.id ? (
                    <MeasureForm key={m.id} initial={m} measures={measures} onSave={upsert} onCancel={() => setEditing(null)} />
                  ) : (
                    <div key={m.id} className="rounded-lg border border-app-border bg-app-surface px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        {m.kind === 'formula' ? <Calculator size={12} className="text-brand-blue shrink-0" /> : <Sigma size={12} className="text-brand-blue shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-semibold text-gray-200 truncate">{m.name}</p>
                          <p className="text-[10px] text-gray-500 truncate">
                            {m.kind === 'simple' ? `${AGG_LABELS[m.agg]}${m.field ? ` de ${m.field}` : ''} · ${m.source}${m.dateWindow ? ' · com janela de data' : ''}${m.filters?.length ? ' · com filtro' : ''}` : humanFormulaLabel(m.expression, m.refs, measures)}
                            {m.format === 'percent' ? ' · %' : ''}
                          </p>
                        </div>
                        <button onClick={() => setEditing(m.id)} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-brand-blue shrink-0"><Pencil size={12} /></button>
                        <button onClick={() => remove(m.id)} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical shrink-0"><Trash2 size={12} /></button>
                      </div>
                      {m.description && <p className="text-[10px] text-gray-500 mt-1 pl-[18px]">{m.description}</p>}
                      {uses.length > 0 && (
                        <p className="text-[10px] text-gray-600 mt-1 pl-[18px] flex items-center gap-1">
                          <AlertTriangle size={9} className="shrink-0" /> Usada em: {uses.join(', ')}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-[11px] text-gray-500 py-1">Nenhuma medida ainda.</p>
            )}

            {editing === 'new' ? (
              <MeasureForm initial={null} measures={measures} onSave={upsert} onCancel={() => setEditing(null)} />
            ) : (
              <button onClick={() => setEditing('new')} className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight">
                <Plus size={12} /> Nova medida
              </button>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border shrink-0">
            <button onClick={onClose} className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight">Concluído</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
