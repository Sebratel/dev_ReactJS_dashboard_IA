// Passos 3 e 4 de um pedido à IA, depois de escolher as fontes (passo 1) e
// descrever o que quer (passo 2):
//   3. Nível de personalização — Mínimo, Médio ou Alto: quanto da aba Formato
//      a IA usa (cores, rótulos, destaques, metas);
//   4. O que entregar — Padrão (a IA decide, como sempre) ou só os tipos de
//      widget que a pessoa marcar: tabelas, gráficos, cards. As medidas
//      (cálculos) ficam fora da escolha: a IA cria as que a análise pedir,
//      em qualquer opção.
// Vale pro próximo pedido e fica guardado na conversa. O servidor cobra o
// passo 4 nas ferramentas da IA (server/aiRequestOptions.mjs): widget de tipo
// não pedido volta como erro pra ela corrigir.
//
// Antes da conversa começar aparece inteiro, como passos numerados; depois,
// vira uma linha acima do campo de escrever, que abre com "Ajustar".
import { useState } from 'react'
import { BarChart3, Check, ChevronDown, Hash, Palette, Sparkles, Table2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { AiRequestOptions, Deliverable, Personalization } from './aiApi'

const LEVELS: { id: Personalization; label: string; text: string }[] = [
  { id: 'minimal', label: 'Mínimo', text: 'Aparência padrão do app — a IA não mexe em cores nem formatação.' },
  { id: 'medium', label: 'Médio', text: 'Títulos claros, rótulos onde ajudam, cores coerentes e destaque no principal.' },
  { id: 'high', label: 'Alto', text: 'Visual caprichado: paleta própria em cada widget, fundos, metas e destaques.' },
]

const KINDS: { id: Deliverable; label: string; icon: typeof Table2 }[] = [
  { id: 'tables', label: 'Tabelas', icon: Table2 },
  { id: 'charts', label: 'Gráficos', icon: BarChart3 },
  { id: 'cards', label: 'Cards', icon: Hash },
]

const levelLabel = (p: Personalization) => LEVELS.find((l) => l.id === p)?.label ?? p
export const deliverSummary = (deliver: Deliverable[] | null) =>
  deliver ? KINDS.filter((k) => deliver.includes(k.id)).map((k) => k.label).join(', ') : 'Padrão'
export const optionsSummary = (o: AiRequestOptions) => `${levelLabel(o.personalization)} · ${deliverSummary(o.deliver)}`

function deliverText(deliver: Deliverable[] | null): string {
  if (!deliver) return 'A IA decide o que montar — gráficos, tabelas, cards ou texto, conforme o pedido. As medidas vêm junto quando a análise pedir.'
  return `Só ${deliverSummary(deliver)}. As medidas (cálculos) a IA cria quando a análise pedir, como sempre.`
}

function Controls({ value, onChange, numbered }: { value: AiRequestOptions; onChange: (o: AiRequestOptions) => void; numbered: boolean }) {
  const toggleKind = (id: Deliverable) => {
    const current = new Set(value.deliver ?? [])
    if (current.has(id)) current.delete(id)
    else current.add(id)
    // Ordem fixa (a das caixas), e nada marcado volta pro padrão.
    const next = KINDS.map((k) => k.id).filter((k) => current.has(k))
    onChange({ ...value, deliver: next.length ? next : null })
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-gray-100">
          <Palette size={12} className="text-brand-blue" /> {numbered && '3. '}Nível de personalização
        </p>
        <div role="radiogroup" aria-label="Nível de personalização" className="grid grid-cols-3 gap-1 rounded-lg border border-app-border bg-app-card p-1">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={value.personalization === l.id}
              onClick={() => onChange({ ...value, personalization: l.id })}
              className={cn(
                'rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors',
                value.personalization === l.id ? 'bg-brand-blue text-white shadow-sm' : 'text-gray-400 hover:bg-app-surface hover:text-gray-200',
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] leading-snug text-gray-500">{LEVELS.find((l) => l.id === value.personalization)?.text}</p>
      </div>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-gray-100">
          <Sparkles size={12} className="text-brand-blue" /> {numbered && '4. '}O que a IA deve entregar
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={!value.deliver}
            onClick={() => onChange({ ...value, deliver: null })}
            className={cn(
              'flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
              !value.deliver ? 'border-brand-blue/60 bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400 hover:border-brand-blue/40 hover:text-gray-200',
            )}
          >
            {!value.deliver && <Check size={11} strokeWidth={3} />} Padrão — a IA decide
          </button>
          {KINDS.map(({ id, label, icon: Icon }) => {
            const on = !!value.deliver?.includes(id)
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleKind(id)}
                className={cn(
                  'flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                  on ? 'border-brand-blue/60 bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400 hover:border-brand-blue/40 hover:text-gray-200',
                )}
              >
                {on ? <Check size={11} strokeWidth={3} /> : <Icon size={11} />} {label}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-[10px] leading-snug text-gray-500">{deliverText(value.deliver)}</p>
      </div>
    </div>
  )
}

export function AiRequestOptionsPicker({ value, onChange, compact }: {
  value: AiRequestOptions
  onChange: (o: AiRequestOptions) => void
  // Já há conversa: uma linha acima do campo de escrever, que abre os controles.
  compact: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!compact) return <Controls value={value} onChange={onChange} numbered />
  return (
    <div className="shrink-0 border-t border-app-border px-4 pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] text-gray-400 transition-colors hover:text-gray-200"
      >
        <Palette size={11} className="shrink-0 text-brand-blue" />
        <span className="min-w-0 flex-1 truncate">
          Personalização <strong className="font-semibold text-gray-200">{levelLabel(value.personalization)}</strong>
          {' · '}Entrega <strong className="font-semibold text-gray-200">{deliverSummary(value.deliver)}</strong>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 font-medium">{open ? 'Fechar' : 'Ajustar'} <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} /></span>
      </button>
      {open && <div className="pt-2.5"><Controls value={value} onChange={onChange} numbered={false} /></div>}
    </div>
  )
}
