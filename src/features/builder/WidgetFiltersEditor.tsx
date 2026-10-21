// Filtros fixos do widget — quantos a pessoa quiser, cada um com o campo, a
// regra ("está em"/"não está em") e os valores. Todos valem juntos (E).
//
// Antes o editor só mostrava o PRIMEIRO filtro: um widget montado pela IA com
// dois (Tipo de Solicitação e Status = Encerrado) aparecia aqui com um só, e
// mexer nele gravava só aquele — o segundo sumia sem aviso. Foi um filtro
// escondido assim que fez uma pizza dar 79 e umas barras da mesma coisa 80.
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Search, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { fetchFieldValues } from './builderApi'
import { FieldWell, type FieldOption } from './FieldWell'
import type { FilterOp, TabRelation, WidgetFilter } from './types'

// Acima disso a lista de valores ganha uma busca.
const SEARCH_FROM = 12

// Campo "fonte.campo" (de fonte relacionada) busca os valores NAQUELA fonte.
function valueSource(field: string, source: string, relations: readonly TabRelation[]): { source: string; field: string } {
  const related = new Set<string>()
  for (const r of relations) {
    if (r.sourceA === source) related.add(r.sourceB)
    if (r.sourceB === source) related.add(r.sourceA)
  }
  const other = [...related].sort((a, b) => b.length - a.length).find((s) => field.startsWith(`${s}.`))
  return other ? { source: other, field: field.slice(other.length + 1) } : { source, field }
}

function FilterValues({ filter, source, relations, onChange }: {
  filter: WidgetFilter
  source: string
  relations: readonly TabRelation[]
  onChange: (f: WidgetFilter) => void
}) {
  const [values, setValues] = useState<string[] | null>(null)
  const [search, setSearch] = useState('')
  const target = valueSource(filter.field, source, relations)

  useEffect(() => {
    let alive = true
    setValues(null)
    fetchFieldValues(target.source, target.field)
      .then((v) => { if (alive) setValues(v) })
      .catch(() => { if (alive) setValues([]) })
    return () => { alive = false }
  }, [target.source, target.field])

  // Valor já escolhido que não veio na lista (grafia antiga, valor que sumiu
  // dos dados) continua aparecendo — senão não haveria como tirá-lo.
  const all = useMemo(() => {
    const list = values ?? []
    return [...filter.values.filter((v) => !list.includes(v)), ...list]
  }, [values, filter.values])
  const shown = search ? all.filter((v) => v.toLowerCase().includes(search.toLowerCase())) : all
  const toggle = (v: string) => onChange({ ...filter, values: filter.values.includes(v) ? filter.values.filter((x) => x !== v) : [...filter.values, v] })

  return (
    <div className="space-y-1.5">
      <select
        value={filter.op}
        onChange={(e) => onChange({ ...filter, op: e.target.value as FilterOp })}
        className="w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50"
      >
        <option value="in">está em</option>
        <option value="notIn">não está em</option>
      </select>
      {all.length > SEARCH_FROM && (
        <label className="flex items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-2 py-1">
          <Search size={11} className="shrink-0 text-gray-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar valor…" className="min-w-0 flex-1 bg-transparent text-[11px] text-gray-200 outline-none placeholder:text-gray-500" />
        </label>
      )}
      <div className="max-h-32 overflow-auto flex flex-wrap gap-1.5 rounded-lg border border-app-border p-2">
        {values === null && <span className="text-[10px] text-gray-500">Carregando valores…</span>}
        {values !== null && shown.length === 0 && <span className="text-[10px] text-gray-500">{search ? 'Nenhum valor com esse texto.' : 'Nenhum valor encontrado.'}</span>}
        {shown.map((v) => {
          const on = filter.values.includes(v)
          return (
            <button
              key={v}
              type="button"
              onClick={() => toggle(v)}
              className={cn('px-2 py-0.5 rounded-md border text-[10px]', on ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-500')}
            >
              {v || '(vazio)'}
            </button>
          )
        })}
      </div>
      {filter.values.length === 0 ? (
        <p className="flex items-start gap-1 text-[10px] leading-snug text-risk-high">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          {filter.op === 'in' ? 'Escolha ao menos um valor — "está em" sem valor não deixa passar nada.' : 'Nenhum valor escolhido: este filtro não tira nada.'}
        </p>
      ) : (
        <p className="text-[10px] text-gray-500">{filter.values.length} escolhido(s)</p>
      )}
    </div>
  )
}

export function WidgetFiltersEditor({ filters, fieldOptions, source, relations, onChange }: {
  filters: WidgetFilter[]
  fieldOptions: FieldOption[]
  source: string | undefined
  relations: readonly TabRelation[]
  // Lista vazia = sem filtro fixo (o editor grava `undefined`).
  onChange: (filters: WidgetFilter[]) => void
}) {
  const labelOf = (field: string) => fieldOptions.find((o) => o.key === field)?.label ?? field
  return (
    <div className="space-y-2">
      <FieldWell
        label="Filtros fixos do widget"
        hint="opcional — não reagem aos filtros da aba"
        info="Restringem os dados deste widget a um recorte fixo, sempre — diferente dos filtros da aba (no topo da dashboard), que quem vê pode mudar. Dá para pôr quantos quiser: todos valem juntos (ex. Tipo = Viabilidade E Status = Encerrado). Um filtro fixo que outro widget do mesmo assunto não tem é a causa mais comum de dois gráficos 'iguais' mostrarem números diferentes."
        allOptions={fieldOptions}
        selectedKeys={filters.map((f) => f.field)}
        onAdd={(field) => onChange([...filters, { field, op: 'in', values: [] }])}
        onRemove={(field) => onChange(filters.filter((f) => f.field !== field))}
        multiple
      />
      {source && filters.map((f, i) => (
        <div key={f.field} className="rounded-lg border border-app-border bg-app-surface/30 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] font-semibold text-gray-200">{labelOf(f.field)}</span>
            <button
              type="button"
              onClick={() => onChange(filters.filter((_, idx) => idx !== i))}
              title="Tirar este filtro"
              aria-label={`Tirar o filtro de ${labelOf(f.field)}`}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-risk-critical/10 hover:text-risk-critical"
            >
              <X size={11} />
            </button>
          </div>
          <FilterValues filter={f} source={source} relations={relations} onChange={(nf) => onChange(filters.map((x, idx) => (idx === i ? nf : x)))} />
        </div>
      ))}
    </div>
  )
}
