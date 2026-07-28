// Botão de informação (ícone pequeno) usado ao lado de rótulos de campos do
// editor de widget — clique pra ver a explicação. Mede o espaço disponível
// à direita do ícone antes de abrir: se o balão (largura fixa) não couber
// até a borda da janela, abre alinhado à direita do ícone (crescendo pra
// esquerda) em vez de sempre pra direita. Fecha ao perder o foco (blur),
// então funciona bem em telas touch também.
import { useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/utils/cn'

const TOOLTIP_WIDTH = 240 // w-60
const EDGE_MARGIN = 12

export function InfoHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setAlignRight(rect.left + TOOLTIP_WIDTH > window.innerWidth - EDGE_MARGIN)
    }
    setOpen((v) => !v)
  }

  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={btnRef}
        type="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); toggle() }}
        onBlur={() => setOpen(false)}
        title={text}
        aria-label="Mais informações"
        className={cn('h-3.5 w-3.5 flex items-center justify-center rounded-full text-gray-500 hover:text-brand-blue transition-colors', open && 'text-brand-blue')}
      >
        <Info size={11} />
      </button>
      {open && (
        <span
          role="tooltip"
          className={cn(
            'absolute z-50 top-full mt-1 w-60 rounded-lg border border-app-border bg-app-card p-2 text-[10px] normal-case font-normal leading-snug text-gray-300 shadow-lg',
            alignRight ? 'right-0' : 'left-0',
          )}
        >
          {text}
        </span>
      )}
    </span>
  )
}
