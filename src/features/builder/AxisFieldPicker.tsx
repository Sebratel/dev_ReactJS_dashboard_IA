// Picker de campo estilo Power BI pra Eixo X/Eixo Y/Legenda — botão
// "Selecionar" abre uma árvore agrupada por FONTE (a principal do widget +
// as já mescladas em Modificadores); expandir uma fonte revela suas colunas
// disponíveis pro papel (dimensão/data para eixo/legenda, numérico ou
// qualquer campo para medida — decidido por quem monta `groups`).
import { useState } from 'react'
import { ChevronRight, Search, Check, Database, Plus, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { InfoHint } from './InfoHint'

export interface AxisFieldGroup {
  key: string
  label: string
  fields: {
    key: string; label: string; description?: string
    // Nível de uma "Hierarquia de datas" (Ano/Trimestre/Mês/Dia, ver
    // buildGroups em WidgetEditorModal.tsx) — `indent` dá o recuo visual
    // que agrupa os 4 níveis como filhos do mesmo campo; `toggle` faz o
    // clique alternar adicionar/remover (em vez de só adicionar e ficar
    // desabilitado depois de selecionado, como qualquer campo comum) —
    // sem isso não teria como desmarcar um nível direto na árvore, só pelo
    // chip lá em cima.
    indent?: boolean
    toggle?: boolean
  }[]
  // true = fonte ainda não usada neste widget (nem principal, nem mesclada)
  // — aqui não dá pra "ver as colunas" direto (não haveria como cruzar com
  // a fonte principal); clicar troca a fonte principal do widget pra essa.
  foreign?: boolean
}

export function AxisFieldPicker({ label, hint, info, groups, selectedKeys, onAdd, onRemove, onSwitchSource, multiple = false }: {
  label: string
  hint?: string
  info?: string
  groups: AxisFieldGroup[]
  selectedKeys: string[]
  onAdd: (key: string) => void
  onRemove: (key: string) => void
  onSwitchSource?: (key: string) => void
  multiple?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const toggleExpand = (key: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const labelOf = (key: string) => groups.flatMap((g) => g.fields).find((f) => f.key === key)?.label ?? key

  const filteredGroups = search
    ? groups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => f.label.toLowerCase().includes(search.toLowerCase())) }))
      .filter((g) => g.fields.length > 0)
    : groups

  const canAddMore = multiple || selectedKeys.length === 0

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1">
          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
          {info && <InfoHint text={info} />}
        </span>
      </div>
      {hint && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}

      <div className="mt-1.5 min-h-[32px] rounded-lg border border-dashed border-app-border p-1.5 flex flex-wrap gap-1.5">
        {selectedKeys.length === 0 && (
          <span className="text-[10px] text-gray-500 px-1 py-1">Sem campo</span>
        )}
        {selectedKeys.map((k) => (
          <span key={k} className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-brand-blue/10 border border-brand-blue/30 text-[11px] text-brand-blue">
            {labelOf(k)}
            <button onClick={() => onRemove(k)} className="h-3.5 w-3.5 flex items-center justify-center rounded text-brand-blue/70 hover:text-brand-blue hover:bg-brand-blue/20"><X size={9} /></button>
          </span>
        ))}
        {canAddMore && (
          <button
            onClick={() => setOpen((v) => !v)}
            className={cn('flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-colors', open ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400 hover:border-app-borderLight')}
          >
            <Plus size={11} /> Selecionar
          </button>
        )}
      </div>

      {open && (
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
                        const isSelected = selectedKeys.includes(f.key)
                        const disabled = isSelected && !f.toggle
                        return (
                          <div key={f.key} className={cn('flex items-center gap-0.5', f.indent && 'ml-3 border-l border-app-border/60 pl-1.5')}>
                            <button
                              disabled={disabled}
                              onClick={() => {
                                if (isSelected && f.toggle) { onRemove(f.key); return }
                                onAdd(f.key); setSearch(''); if (!multiple) setOpen(false)
                              }}
                              className={cn(
                                'flex-1 min-w-0 flex items-center justify-between gap-1 text-left px-2 py-1 rounded-md text-[11px] transition-colors',
                                disabled ? 'text-brand-blue/50 cursor-default' : isSelected ? 'text-brand-blue hover:bg-brand-blue/10' : 'text-gray-300 hover:bg-brand-blue/10 hover:text-brand-blue',
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
