// Well de colunas da tabela estilo Power BI — lista as colunas na ordem em
// que aparecem (setas pra reordenar), permite renomear o cabeçalho exibido
// (clique no nome) e remover; "+" busca entre as colunas ainda não usadas.
import { useState } from 'react'
import { Plus, X, ChevronUp, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/utils/cn'
import { InfoHint } from './InfoHint'
import type { FieldOption } from './FieldWell'

export function TableColumnsWell({ allFields, columns, columnLabels, onChangeColumns, onChangeLabel }: {
  allFields: FieldOption[]
  columns: string[]
  columnLabels: Record<string, string>
  onChangeColumns: (cols: string[]) => void
  onChangeLabel: (key: string, label: string | undefined) => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [renamingKey, setRenamingKey] = useState<string | null>(null)

  const available = allFields.filter((f) => !columns.includes(f.key))
  const filtered = search ? available.filter((f) => f.label.toLowerCase().includes(search.toLowerCase())) : available

  const move = (idx: number, delta: number) => {
    const target = idx + delta
    if (target < 0 || target >= columns.length) return
    const next = [...columns]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChangeColumns(next)
  }
  const remove = (key: string) => onChangeColumns(columns.filter((c) => c !== key))
  const add = (key: string) => { onChangeColumns([...columns, key]); setSearch('') }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Colunas da tabela</span>
          <InfoHint text="Escolha e ordene (setas) quais colunas aparecem na tabela. Clique no nome de uma coluna selecionada pra renomear o cabeçalho exibido, sem mudar o campo real por trás. Um campo de data pode entrar puro (o valor de cada linha) e/ou como Ano/Trimestre/Mês/Dia (Hierarquia de datas) — cada nível vira sua própria coluna." />
        </span>
        {available.length > 0 && (
          <button onClick={() => setSearchOpen((v) => !v)} className={cn('h-5 w-5 flex items-center justify-center rounded transition-colors', searchOpen ? 'bg-brand-blue/15 text-brand-blue' : 'text-brand-blue hover:bg-brand-blue/10')}>
            <Plus size={12} />
          </button>
        )}
      </div>

      <div className="mt-1.5 space-y-1">
        {columns.length === 0 && <p className="text-[10px] text-gray-500 px-1 py-1">Sem colunas — clique em “+”</p>}
        {columns.map((key, i) => {
          const field = allFields.find((f) => f.key === key)
          const label = columnLabels[key] ?? field?.label ?? key
          return (
            <div key={key} className="flex items-center gap-1.5 rounded-md border border-app-border bg-app-surface px-1.5 py-1">
              <div className="flex flex-col shrink-0">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="h-3.5 text-gray-500 hover:text-gray-200 disabled:opacity-25"><ChevronUp size={10} /></button>
                <button onClick={() => move(i, 1)} disabled={i === columns.length - 1} className="h-3.5 text-gray-500 hover:text-gray-200 disabled:opacity-25"><ChevronDown size={10} /></button>
              </div>
              {renamingKey === key ? (
                <input
                  autoFocus
                  defaultValue={label}
                  onBlur={(e) => { onChangeLabel(key, e.target.value.trim() || undefined); setRenamingKey(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  className="flex-1 min-w-0 bg-transparent text-[11px] text-gray-200 outline-none border-b border-brand-blue/60"
                />
              ) : (
                <button onClick={() => setRenamingKey(key)} title="Clique para renomear o cabeçalho" className="flex-1 min-w-0 text-left text-[11px] text-gray-300 truncate hover:text-gray-100">
                  {label}
                </button>
              )}
              {field?.description && <InfoHint text={field.description} />}
              <button onClick={() => remove(key)} className="h-5 w-5 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical shrink-0"><X size={11} /></button>
            </div>
          )
        })}
      </div>

      {searchOpen && (
        <div className="mt-1.5 rounded-lg border border-app-border bg-app-surface p-2">
          <div className="flex items-center gap-1.5 rounded-md border border-app-border bg-app-card px-2 py-1 mb-1.5">
            <Search size={11} className="text-gray-500 shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pesquisar coluna…"
              className="w-full bg-transparent text-[11px] text-gray-200 placeholder:text-gray-500 outline-none"
            />
          </div>
          <div className="max-h-36 overflow-auto space-y-0.5">
            {filtered.length === 0 && <p className="text-[10px] text-gray-500 px-1 py-1">Nenhuma coluna encontrada.</p>}
            {filtered.map((f) => (
              <div key={f.key} className="flex items-center gap-0.5">
                <button onClick={() => add(f.key)} className="flex-1 min-w-0 text-left px-2 py-1 rounded-md text-[11px] text-gray-300 hover:bg-brand-blue/10 hover:text-brand-blue transition-colors truncate">
                  {f.label}
                </button>
                {f.description && <InfoHint text={f.description} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
