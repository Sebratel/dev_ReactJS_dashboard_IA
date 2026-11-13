// Quais fontes a IA usa — o PRIMEIRO passo de uma conversa, e editável a
// qualquer momento depois. A lista é a das fontes liberadas para a pasta da
// dashboard (o catálogo do Builder já vem filtrado pelo servidor). Pôr ou
// tirar uma fonte no meio da conversa vale a partir da próxima mensagem (ver
// runTurn em server/aiAssistant.mjs); o que já foi montado com uma fonte que
// saiu continua na dashboard.
//
// Antes a escolha travava na 1ª mensagem, e com até 3 fontes elas vinham todas
// marcadas e o pedido do convite já saía sozinho — a pessoa nem chegava a ver
// a escolha.
import { useState } from 'react'
import { Check, ChevronDown, Database, Search } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { SourceDef } from '../fieldCatalog'

export function AiSourcePicker({ sources, selected, onChange, conversationActive }: {
  sources: SourceDef[]
  selected: ReadonlySet<string>
  onChange: (keys: string[]) => void
  // Já há conversa: mostra um resumo de uma linha, que abre a lista.
  conversationActive: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const expanded = !conversationActive || open
  const chosen = sources.filter((s) => selected.has(s.key))
  const none = selected.size === 0

  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange([...next])
  }

  const q = query.trim().toLowerCase()
  const visible = q ? sources.filter((s) => s.label.toLowerCase().includes(q)) : sources

  return (
    <div className={cn(
      'shrink-0 border-b border-app-border px-4 py-3',
      expanded ? 'bg-app-surface/50' : 'bg-app-surface/30',
    )}
    >
      <div className="flex items-center gap-2">
        <span className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
          none ? 'bg-risk-high/15 text-risk-high' : 'bg-brand-blue/15 text-brand-blue',
        )}
        >
          <Database size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold leading-tight text-gray-100">
            {conversationActive ? 'Fontes desta conversa' : '1. Escolha os dados que a IA vai usar'}
          </p>
          {!expanded && (
            <p className="truncate text-[11px] leading-tight text-gray-400" title={chosen.map((s) => s.label).join(', ')}>
              {chosen.map((s) => s.label).join(', ') || 'Nenhuma fonte marcada'}
            </p>
          )}
        </div>
        {conversationActive && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-app-border px-2 py-1 text-[11px] font-medium text-gray-300 transition-colors hover:border-brand-blue/50 hover:text-brand-blue"
          >
            {open ? 'Fechar' : 'Alterar'}
            <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2.5 space-y-2">
          {sources.length === 0 ? (
            <p className="text-[11px] text-gray-500">Nenhuma fonte liberada para esta pasta. Peça a um administrador para liberar em Configurações.</p>
          ) : (
            <>
              {sources.length > 6 && (
                <label className="flex items-center gap-1.5 rounded-lg border border-app-border bg-app-card px-2.5 py-1.5">
                  <Search size={12} className="shrink-0 text-gray-500" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Buscar fonte…"
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-gray-200 outline-none placeholder:text-gray-500"
                  />
                </label>
              )}
              <div className="max-h-48 space-y-1 overflow-y-auto pr-0.5">
                {visible.map((s) => {
                  const on = selected.has(s.key)
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => toggle(s.key)}
                      aria-pressed={on}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                        on ? 'border-brand-blue/60 bg-brand-blue/10' : 'border-app-border bg-app-card hover:border-brand-blue/40',
                      )}
                    >
                      <span className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                        on ? 'border-brand-blue bg-brand-blue text-white' : 'border-app-borderLight',
                      )}
                      >
                        {on && <Check size={10} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-gray-100">{s.label}</span>
                        <span className="block text-[10px] text-gray-500">
                          {s.error ? s.error : `${s.fields.length} campos${s.direct ? ' · direto no Data Hub' : ''}`}
                        </span>
                      </span>
                    </button>
                  )
                })}
                {visible.length === 0 && <p className="px-1 text-[11px] text-gray-500">Nenhuma fonte com esse nome.</p>}
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] leading-snug text-gray-500">
                  {conversationActive
                    ? 'Vale a partir da próxima mensagem. Tirar uma fonte não apaga o que já foi montado com ela.'
                    : 'Só os nomes e os tipos dos campos vão para a IA — nunca as linhas de dados.'}
                </p>
                {sources.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onChange(selected.size === sources.length ? [] : sources.map((s) => s.key))}
                    className="shrink-0 text-[10px] font-medium text-gray-400 hover:text-brand-blue"
                  >
                    {selected.size === sources.length ? 'Limpar' : 'Marcar todas'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
