// Barra de filtros da aba — multiselect (valores distintos vindos do backend)
// e intervalo de datas. O estado ativo vive no DashboardBuilder e é repassado
// aos widgets genéricos via /api/widget-data.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, X, Filter, Trash2, Repeat } from 'lucide-react'
import { cn } from '@/utils/cn'
import { fetchFieldValues } from './builderApi'
import type { ActiveFilters, FilterConfig, FilterDynamicConfig } from './types'

const MIN_DYNAMIC_INTERVAL_SECONDS = 5
const DEFAULT_DYNAMIC_INTERVAL_SECONDS = 60

// Motor do filtro dinâmico: enquanto ativo (ver `isCycling` em FilterBar),
// busca a lista de valores distintos do campo uma vez e avança sozinho pra
// próxima a cada `intervalSeconds`, voltando à primeira depois da última.
// Não renderiza nada — só chama `onAdvance`, que segue o mesmo caminho de
// uma troca manual de checkbox (mesmo `onChange`, mesmo refetch dos
// widgets). Recomeça do primeiro valor sempre que monta (ex. ao sair do
// modo edição, ou ao abrir a aba) — não tenta continuar de onde parou.
function DynamicFilterDriver({ filter, onAdvance }: {
  filter: FilterConfig
  onAdvance: (values: string[]) => void
}) {
  const [options, setOptions] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setOptions(null)
    fetchFieldValues(filter.source, filter.field).then((v) => { if (!cancelled) setOptions(v) }).catch(() => { if (!cancelled) setOptions([]) })
    return () => { cancelled = true }
  }, [filter.source, filter.field])

  useEffect(() => {
    if (!options || options.length === 0) return
    let index = 0
    onAdvance([options[index]])
    const ms = Math.max(MIN_DYNAMIC_INTERVAL_SECONDS, filter.dynamic?.intervalSeconds ?? DEFAULT_DYNAMIC_INTERVAL_SECONDS) * 1000
    const id = setInterval(() => {
      index = (index + 1) % options.length
      onAdvance([options[index]])
    }, ms)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, filter.dynamic?.intervalSeconds])

  return null
}

// Botão + popover de configuração do filtro dinâmico, num componente só —
// o ref do "clique fora fecha" envolve os DOIS (botão de alternar e o
// popover), senão clicar de novo no próprio botão pra fechar contava como
// "fora" (mousedown fecha antes do click do botão reabrir) e o popover
// nunca fechava por ali, só clicando em outro lugar da tela.
function DynamicFilterControl({ dynamic, onSave }: {
  dynamic: FilterDynamicConfig | undefined
  onSave: (next: FilterDynamicConfig | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(dynamic?.enabled ?? false)
  const [seconds, setSeconds] = useState(dynamic?.intervalSeconds ?? DEFAULT_DYNAMIC_INTERVAL_SECONDS)
  const ref = useRef<HTMLDivElement>(null)

  const openPopover = () => {
    setEnabled(dynamic?.enabled ?? false)
    setSeconds(dynamic?.intervalSeconds ?? DEFAULT_DYNAMIC_INTERVAL_SECONDS)
    setOpen(true)
  }
  const commit = () => {
    onSave(enabled ? { enabled, intervalSeconds: Math.max(MIN_DYNAMIC_INTERVAL_SECONDS, seconds) } : undefined)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) commit() }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, enabled, seconds])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => (open ? commit() : openPopover())}
        className={cn('h-5 w-5 flex items-center justify-center rounded', dynamic?.enabled ? 'text-brand-blue' : 'text-gray-500 hover:text-gray-200')}
        title="Filtro dinâmico"
      >
        <Repeat size={10} />
      </button>
      {open && (
        <div className="absolute z-40 top-full mt-1 left-0 w-56 rounded-lg border border-app-border bg-app-card shadow-card-lg p-2.5 space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-[#ffb000]" />
            <span className="text-[11px] font-semibold text-gray-200">Filtro dinâmico</span>
          </label>
          {enabled && (
            <label className="block">
              <span className="text-[10px] text-gray-500">Troca a cada (segundos)</span>
              <input
                type="number"
                min={MIN_DYNAMIC_INTERVAL_SECONDS}
                value={seconds}
                onChange={(e) => setSeconds(Math.max(MIN_DYNAMIC_INTERVAL_SECONDS, Number(e.target.value) || MIN_DYNAMIC_INTERVAL_SECONDS))}
                className="w-full mt-0.5 rounded-md border border-app-border bg-app-surface px-2 py-1 text-[11px] text-gray-200 outline-none"
              />
            </label>
          )}
          <p className="text-[10px] text-gray-500 leading-snug">
            Ativo, o filtro mostra 1 valor por vez e avança sozinho pela lista de valores, voltando ao início depois do último — só roda fora do modo edição.
          </p>
        </div>
      )}
    </div>
  )
}

function MultiSelect({ filter, selected, onChange, locked }: {
  filter: FilterConfig; selected: string[]; onChange: (values: string[]) => void; locked: boolean
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
        disabled={locked}
        title={locked ? 'Filtro dinâmico ativo — desative pra escolher manualmente' : undefined}
        className={cn(
          'flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[11px] transition-colors',
          locked && 'cursor-default',
          selected.length > 0 ? 'border-brand-blue/40 bg-brand-blue/10 text-brand-blue font-semibold' : 'border-app-border bg-app-card text-gray-400 hover:border-app-borderLight',
        )}
      >
        {locked && <Repeat size={10} className="animate-spin [animation-duration:2.5s]" />}
        {locked ? `${filter.label}: ${selected[0] ?? '…'}` : <>{filter.label}{selected.length > 0 && ` (${selected.length})`}</>}
        {!locked && <ChevronDown size={11} />}
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

export function FilterBar({ filters, active, onChange, editMode, onRemoveFilter, onUpdateFilter }: {
  filters: FilterConfig[]
  active: ActiveFilters
  onChange: (filterId: string, values: string[]) => void
  editMode: boolean
  onRemoveFilter?: (filterId: string) => void
  onUpdateFilter?: (filterId: string, patch: Partial<FilterConfig>) => void
}) {
  if (filters.length === 0) return null
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Filter size={12} className="text-gray-500" />
      {filters.map((f) => {
        // Só roda fora do modo edição — igual à Atualização automática
        // (TabAutoRefresh): alguém editando a aba precisa que o filtro
        // fique parado pra testar valores, e cada troca dispara refetch de
        // todo widget que usa a fonte, o mesmo custo de um tick do
        // autoRefresh — não é algo que deva rodar "por baixo" de uma edição.
        const isCycling = f.type === 'multiselect' && !!f.dynamic?.enabled && !editMode
        return (
          <div key={f.id} className="relative flex items-center gap-1">
            {f.type === 'daterange'
              ? <DateRange filter={f} selected={active[f.id] ?? []} onChange={(v) => onChange(f.id, v)} />
              : <MultiSelect filter={f} selected={active[f.id] ?? []} onChange={(v) => onChange(f.id, v)} locked={isCycling} />}
            {isCycling && <DynamicFilterDriver filter={f} onAdvance={(v) => onChange(f.id, v)} />}
            {editMode && f.type === 'multiselect' && onUpdateFilter && (
              <DynamicFilterControl dynamic={f.dynamic} onSave={(next) => onUpdateFilter(f.id, { dynamic: next })} />
            )}
            {editMode && onRemoveFilter && (
              <button onClick={() => onRemoveFilter(f.id)} className="h-5 w-5 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical" title="Remover filtro">
                <Trash2 size={10} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
