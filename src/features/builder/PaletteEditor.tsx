// Paleta de cores do widget (`palette`): as cores das fatias e das séries sem
// cor própria, na ordem. A IA preenche quando pedem cores variadas; antes o
// editor não tinha como ver nem trocar essas cores.
import { Plus, RotateCcw, X } from 'lucide-react'
import { PALETTE } from './WidgetRenderer'

const MAX_COLORS = 12

export function PaletteEditor({ value, suggestions, onChange }: {
  value: string[] | undefined
  // Cores oferecidas no "+ Cor" (as mesmas da Cor principal).
  suggestions: string[]
  // `undefined` = volta à paleta do app.
  onChange: (palette: string[] | undefined) => void
}) {
  if (!value?.length) {
    return (
      <div className="space-y-2">
        <div className="flex gap-1">
          {PALETTE.map((c) => <span key={c} className="h-4 w-4 rounded-full ring-1 ring-black/10" style={{ background: c }} />)}
        </div>
        <p className="text-[10px] text-gray-500">Usando a paleta do app.</p>
        <button
          type="button"
          onClick={() => onChange([...PALETTE])}
          className="rounded-lg border border-app-border px-2.5 py-1 text-[11px] font-medium text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue"
        >
          Personalizar
        </button>
      </div>
    )
  }

  const set = (i: number, color: string) => onChange(value.map((c, idx) => (idx === i ? color : c)))
  const remove = (i: number) => {
    const next = value.filter((_, idx) => idx !== i)
    onChange(next.length ? next : undefined)
  }
  const add = () => {
    const next = suggestions.find((c) => !value.includes(c)) ?? '#888888'
    onChange([...value, next])
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((c, i) => (
          <span key={`${i}-${c}`} className="group relative">
            {/* O seletor nativo fica por cima da bolinha: clicar nela abre a
                escolha de qualquer cor. */}
            <label className="block h-7 w-7 cursor-pointer rounded-full ring-1 ring-black/15" style={{ background: c }} title={`${i + 1}ª cor: ${c} — clique para trocar`}>
              <input type="color" value={c} onChange={(e) => set(i, e.target.value)} className="sr-only" aria-label={`Trocar a ${i + 1}ª cor`} />
            </label>
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`Tirar a ${i + 1}ª cor`}
              className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-app-card text-gray-400 ring-1 ring-app-border hover:text-risk-critical group-hover:flex"
            >
              <X size={8} />
            </button>
          </span>
        ))}
        {value.length < MAX_COLORS && (
          <button
            type="button"
            onClick={add}
            title="Acrescentar uma cor"
            aria-label="Acrescentar uma cor"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-app-border text-gray-500 hover:border-brand-blue/50 hover:text-brand-blue"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(undefined)}
        className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-200"
      >
        <RotateCcw size={10} /> Voltar à paleta do app
      </button>
    </div>
  )
}
