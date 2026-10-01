import { useEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '@/utils/cn'
import { SlideCanvas } from './SlideCanvas'
import type { PDFDocumentProxy } from './pdf'

const THUMB_WIDTH = 112

// Faixa de miniaturas para pular direto a um slide. Cada miniatura só é
// desenhada quando aparece na faixa — abrir o manual não desenha as 29 de uma vez.
export function SlideThumbnails({ doc, numPages, aspect, current, onSelect }: {
  doc: PDFDocumentProxy
  numPages: number
  aspect: number
  current: number
  onSelect: (page: number) => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)

  // Centraliza a miniatura do slide atual mexendo só no scroll da faixa —
  // scrollIntoView também rolaria a página inteira na vertical. A distância
  // vem das caixas na tela: offsetLeft mede a partir do ancestral posicionado,
  // não da faixa.
  useEffect(() => {
    const strip = stripRef.current
    const active = strip?.querySelector<HTMLElement>(`[data-page="${current}"]`)
    if (!strip || !active) return
    const a = active.getBoundingClientRect()
    const s = strip.getBoundingClientRect()
    strip.scrollBy({ left: a.left + a.width / 2 - (s.left + s.width / 2), behavior: 'smooth' })
  }, [current])

  return (
    <div ref={stripRef} className="flex gap-2 overflow-x-auto scrollbar-thin px-4 py-3" aria-label="Miniaturas dos slides">
      {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
        <Thumb
          key={page}
          doc={doc}
          page={page}
          aspect={aspect}
          active={page === current}
          root={stripRef}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function Thumb({ doc, page, aspect, active, root, onSelect }: {
  doc: PDFDocumentProxy
  page: number
  aspect: number
  active: boolean
  root: RefObject<HTMLDivElement>
  onSelect: (page: number) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || visible) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setVisible(true) },
      { root: root.current, rootMargin: '0px 240px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [root, visible])

  return (
    <button
      ref={ref}
      type="button"
      data-page={page}
      onClick={() => onSelect(page)}
      aria-label={`Ir para o slide ${page}`}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'shrink-0 rounded-md overflow-hidden border-2 transition-colors',
        active ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100 hover:border-app-borderLight',
      )}
    >
      {visible ? (
        <SlideCanvas doc={doc} pageNumber={page} width={THUMB_WIDTH} aspect={aspect} label={`Miniatura do slide ${page}`} />
      ) : (
        <div className="bg-app-surface" style={{ width: THUMB_WIDTH, height: Math.round(THUMB_WIDTH / aspect) }} />
      )}
      <span className={cn('block py-0.5 text-[10px] font-semibold', active ? 'bg-primary text-white' : 'bg-app-surface text-gray-500')}>
        {page}
      </span>
    </button>
  )
}
