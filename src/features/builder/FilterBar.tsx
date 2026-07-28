// Barra de filtros da aba — multiselect (valores distintos vindos do backend)
// e intervalo de datas. O estado ativo vive no DashboardBuilder e é repassado
// aos widgets genéricos via /api/widget-data.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, X, Filter, Trash2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import { fetchFieldValues } from './builderApi'
import type { ActiveFilters, FilterConfig } from './types'

function MultiSelect({ filter, selected, onChange }: {
  filter: FilterConfig; selected: string[]; onChange: (values: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<string[] | null>(null)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || options) return
    fetchFieldValues(filter.source, filter.field).then(setOptions).catch(() => setOptions([]))
  }, [open, options, filter.source, filter.field])

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  }
  const filtered = (options ?? []).filter((o) => !search || o.toLowerCase().includes(search.toLowerCase()))

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[11px] transition-colors',
          selected.length > 0 ? 'border-brand-blue/40 bg-brand-blue/10 text-brand-blue font-semibold' : 'border-app-border bg-app-card text-gray-400 hover:border-app-borderLight',
        )}
      >
        {filter.label}{selected.length > 0 && ` (${selected.length})`}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-64 rounded-lg border border-app-border bg-app-card shadow-card-lg p-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar…"
            className="w-full mb-1.5 rounded-md border border-app-border bg-app-surface px-2 py-1 text-[11px] text-gray-200 outline-none"
          />
          <div className="max-h-52 overflow-auto space-y-0.5">
            {options === null && <p className="text-[11px] text-gray-500 px-1 py-2">Carregando…</p>}
            {filtered.map((o) => (
              <label key={o} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-app-surface cursor-pointer">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} className="accent-[#ffb000]" />
                <span className="text-[11px] text-gray-300 truncate">{o}</span>
              </label>
            ))}
            {options !== null && filtered.length === 0 && <p className="text-[11px] text-gray-500 px-1 py-2">Nenhum valor.</p>}
          </div>
          {selected.length > 0 && (
            <button onClick={() => onChange([])} className="mt-1.5 w-full text-[10px] text-gray-500 hover:text-risk-critical py-1">Limpar seleção</button>
          )}
        </div>
      )}
    </div>
  )
}

function DateRange({ filter, selected, onChange }: {
  filter: FilterConfig; selected: string[]; onChange: (values: string[]) => void
}) {
  const [from, to] = [selected[0] ?? '', selected[1] ?? '']
  const set = (f: string, t: string) => onChange(f || t ? [f, t] : [])
  const active = !!(from || to)
  return (
    <div className={cn(
      'flex items-center gap-1 h-7 px-2 rounded-lg border text-[11px]',
      active ? 'border-brand-blue/40 bg-brand-blue/10' : 'border-app-border bg-app-card',
    )}>
      <span className={cn('font-medium', active ? 'text-brand-blue' : 'text-gray-400')}>{filter.label}:</span>
      <input type="date" value={from} onChange={(e) => set(e.target.value, to)} className="bg-transparent text-gray-300 outline-none w-[105px]" />
      <span className="text-gray-500">→</span>
      <input type="date" value={to} onChange={(e) => set(from, e.target.value)} className="bg-transparent text-gray-300 outline-none w-[105px]" />
      {active && <button onClick={() => onChange([])} className="text-gray-500 hover:text-risk-critical"><X size={10} /></button>}
    </div>
  )
}

export function FilterBar({ filters, active, onChange, editMode, onRemoveFilter }: {
  filters: FilterConfig[]
  active: ActiveFilters
  onChange: (filterId: string, values: string[]) => void
  editMode: boolean
  onRemoveFilter?: (filterId: string) => void
}) {
  if (filters.length === 0) return null
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Filter size={12} className="text-gray-500" />
      {filters.map((f) => (
        <div key={f.id} className="flex items-center gap-1">
          {f.type === 'daterange'
            ? <DateRange filter={f} selected={active[f.id] ?? []} onChange={(v) => onChange(f.id, v)} />
            : <MultiSelect filter={f} selected={active[f.id] ?? []} onChange={(v) => onChange(f.id, v)} />}
          {editMode && onRemoveFilter && (
            <button onClick={() => onRemoveFilter(f.id)} className="h-5 w-5 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical" title="Remover filtro">
              <Trash2 size={10} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
