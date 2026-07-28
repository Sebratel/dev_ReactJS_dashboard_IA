// "Well" de campo estilo Power BI (painel Dados) — mostra os campos já
// atribuídos como chips removíveis e um "+" que abre busca entre os campos
// ainda não usados. Genérico: usado para Agrupar por, Legenda, Filtro,
// Colunas etc. — qualquer papel que seja "escolher 1 ou N campos de uma lista".
import { useState } from 'react'
import { Plus, X, Search } from 'lucide-react'
import { cn } from '@/utils/cn'
import { InfoHint } from './InfoHint'

export interface FieldOption { key: string; label: string; description?: string }

export function FieldWell({ label, hint, info, allOptions, selectedKeys, onAdd, onRemove, multiple = false }: {
  label: string
  hint?: string
  info?: string
  allOptions: FieldOption[]
  selectedKeys: string[]
  onAdd: (key: string) => void
  onRemove: (key: string) => void
  multiple?: boolean
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')

  const selected = selectedKeys.map((k) => allOptions.find((o) => o.key === k) ?? { key: k, label: k })
  const available = allOptions.filter((o) => !selectedKeys.includes(o.key))
  const filtered = search ? available.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())) : available
  const canAddMore = (multiple || selected.length === 0) && available.length > 0

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
          {info && <InfoHint text={info} />}
        </span>
        {canAddMore && (
          <button
            onClick={() => setSearchOpen((v) => !v)}
            className={cn('h-5 w-5 flex items-center justify-center rounded transition-colors', searchOpen ? 'bg-brand-blue/15 text-brand-blue' : 'text-brand-blue hover:bg-brand-blue/10')}
            title={`Adicionar campo em ${label}`}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {hint && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}

      <div className="mt-1.5 min-h-[32px] rounded-lg border border-dashed border-app-border p-1.5 flex flex-wrap gap-1.5">
        {selected.length === 0 && <span className="text-[10px] text-gray-500 px-1 py-1">Sem campo — clique em “+”</span>}
        {selected.map((s) => (
          <span key={s.key} className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-brand-blue/10 border border-brand-blue/30 text-[11px] text-brand-blue">
            {s.label}
            <button onClick={() => onRemove(s.key)} className="h-3.5 w-3.5 flex items-center justify-center rounded text-brand-blue/70 hover:text-brand-blue hover:bg-brand-blue/20"><X size={9} /></button>
          </span>
        ))}
      </div>

      {searchOpen && (
        <div className="mt-1.5 rounded-lg border border-app-border bg-app-surface p-2">
          <div className="flex items-center gap-1.5 rounded-md border border-app-border bg-app-card px-2 py-1 mb-1.5">
            <Search size={11} className="text-gray-500 shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar campo…"
              className="w-full bg-transparent text-[11px] text-gray-200 placeholder:text-gray-500 outline-none"
            />
          </div>
          <div className="max-h-36 overflow-auto space-y-0.5">
            {filtered.length === 0 && <p className="text-[10px] text-gray-500 px-1 py-1">Nenhum campo encontrado.</p>}
            {filtered.map((o) => (
              <div key={o.key} className="flex items-center gap-0.5">
                <button
                  onClick={() => { onAdd(o.key); setSearch(''); if (!multiple) setSearchOpen(false) }}
                  className="flex-1 min-w-0 text-left px-2 py-1 rounded-md text-[11px] text-gray-300 hover:bg-brand-blue/10 hover:text-brand-blue transition-colors truncate"
                >
                  {o.label}
                </button>
                {o.description && <InfoHint text={o.description} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
