// Leitor do manual de uso: um slide por vez, com setas, miniaturas, teclado
// (← →; em tela cheia também PageUp/PageDown, espaço, Home/End) e arrastar o
// dedo no celular. Só visualização — não há botão de baixar nem de imprimir.
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { AlertTriangle, BookOpen, ChevronLeft, ChevronRight, Loader2, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { useElementSize } from '@/hooks/useElementSize'
import { cn } from '@/utils/cn'
import { useManualDocument } from './useManualDocument'
import { useFullscreen } from './useFullscreen'
import { SlideCanvas } from './SlideCanvas'
import { SlideThumbnails } from './SlideThumbnails'

// Fora da tela cheia, o slide ocupa no máximo esta fração da altura da janela —
// sobra lugar para os controles e as miniaturas sem rolar a página.
const MAX_HEIGHT_RATIO = 0.62
const SWIPE_MIN_PX = 50

function isTypingIn(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target : null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

function useWindowHeight() {
  const [height, setHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return height
}

function ControlButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="h-8 w-8 flex items-center justify-center rounded-lg border border-app-border bg-app-card text-gray-300 hover:text-gray-100 hover:border-app-borderLight disabled:opacity-40 disabled:pointer-events-none transition-colors"
    >
      {children}
    </button>
  )
}

export function ManualViewer() {
  const [reloadKey, setReloadKey] = useState(0)
  const manual = useManualDocument(reloadKey)
  const [page, setPage] = useState(1)
  const stageRef = useRef<HTMLDivElement>(null)
  const [areaRef, area] = useElementSize<HTMLDivElement>()
  const windowHeight = useWindowHeight()
  const { isFullscreen, isFallback, toggle } = useFullscreen(stageRef)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)

  const numPages = manual.status === 'ready' ? manual.numPages : 0
  const clamp = useCallback((p: number) => Math.min(Math.max(1, p), Math.max(1, numPages)), [numPages])
  const step = useCallback((delta: number) => setPage((p) => clamp(p + delta)), [clamp])

  useEffect(() => {
    if (manual.status !== 'ready') return
    const onKey = (e: KeyboardEvent) => {
      if (isTypingIn(e.target) || e.altKey || e.ctrlKey || e.metaKey) return
      const k = e.key
      if (k === 'ArrowRight' || (isFullscreen && (k === 'PageDown' || (k === ' ' && !e.shiftKey)))) step(1)
      else if (k === 'ArrowLeft' || (isFullscreen && (k === 'PageUp' || (k === ' ' && e.shiftKey)))) step(-1)
      else if (isFullscreen && k === 'Home') setPage(1)
      else if (isFullscreen && k === 'End') setPage(numPages)
      else if (k === 'f' || k === 'F') toggle()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [manual.status, isFullscreen, numPages, step, toggle])

  const onPointerDown = (e: PointerEvent) => {
    swipeStart.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = (e: PointerEvent) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start) return
    const dx = e.clientX - start.x
    if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(e.clientY - start.y)) step(dx < 0 ? 1 : -1)
  }

  const aspect = manual.status === 'ready' ? manual.aspect : 16 / 9
  const maxHeight = isFullscreen ? area.height : Math.max(200, windowHeight * MAX_HEIGHT_RATIO)
  const slideWidth = Math.floor(Math.min(area.width, maxHeight * aspect))

  const stage = (
    <div
      ref={stageRef}
      className={cn('flex flex-col', isFullscreen && 'bg-app-bg w-full h-full', isFallback && 'fixed inset-0 z-[70]')}
    >
      <div
        ref={areaRef}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        className={cn('flex items-center justify-center touch-pan-y', isFullscreen ? 'flex-1 min-h-0 p-4' : 'px-4 pt-4')}
      >
        {manual.status === 'loading' && (
          <div className="flex items-center gap-2 py-16 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" /> Carregando o manual…</div>
        )}
        {manual.status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="flex items-center gap-2 text-sm text-rose-300"><AlertTriangle size={16} /> {manual.message}</p>
            <button
              type="button"
              onClick={() => { setPage(1); setReloadKey((k) => k + 1) }}
              className="flex items-center gap-1.5 rounded-md border border-app-border px-3 py-1.5 text-[12px] text-gray-300 hover:border-app-borderLight hover:text-gray-100"
            >
              <RefreshCw size={13} /> Tentar novamente
            </button>
          </div>
        )}
        {manual.status === 'ready' && slideWidth > 0 && (
          <SlideCanvas
            doc={manual.doc}
            pageNumber={page}
            width={slideWidth}
            aspect={aspect}
            label={`Slide ${page} de ${numPages} do manual de uso`}
            className="rounded-lg shadow-card-md border border-app-border"
          />
        )}
      </div>

      {manual.status === 'ready' && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <ControlButton label="Slide anterior" onClick={() => step(-1)} disabled={page <= 1}><ChevronLeft size={16} /></ControlButton>
          <span className="min-w-[104px] text-center text-xs font-semibold text-gray-200 tabular-nums" aria-live="polite">
            Slide {page} de {numPages}
          </span>
          <ControlButton label="Próximo slide" onClick={() => step(1)} disabled={page >= numPages}><ChevronRight size={16} /></ControlButton>
          <span className="hidden md:inline ml-2 text-[10px] text-gray-500">
            Setas ← → do teclado{isFullscreen ? ' · Esc para sair' : ' · F para tela cheia'}
          </span>
          <button
            type="button"
            onClick={toggle}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-app-border bg-app-card px-2.5 py-1.5 text-[11px] font-semibold text-gray-300 hover:text-gray-100 hover:border-app-borderLight transition-colors"
          >
            {isFullscreen ? <><Minimize2 size={13} /> Sair da tela cheia</> : <><Maximize2 size={13} /> Tela cheia</>}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <Card>
      <CardHeader icon={<BookOpen size={14} />} title="Manual de uso" subtitle="Passe os slides pelas setas, pelo teclado ou pelas miniaturas" />
      {/* O modo de reserva vai para o body: preso na página, o position:fixed
          seria contido pelo transform da animação de entrada (ver ModalPortal). */}
      {isFallback ? <ModalPortal>{stage}</ModalPortal> : stage}

      {manual.status === 'ready' && !isFullscreen && (
        <div className="border-t border-app-border">
          <SlideThumbnails doc={manual.doc} numPages={numPages} aspect={aspect} current={page} onSelect={setPage} />
        </div>
      )}
    </Card>
  )
}
