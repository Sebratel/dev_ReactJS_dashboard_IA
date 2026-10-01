import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/utils/cn'
import { renderPage, type PDFDocumentProxy } from './pdf'

// Fundo de papel do slide enquanto o pdf.js desenha. Literal de propósito: no
// tema deste app `white` é a cor do TEXTO (escura no claro), e a página do PDF
// é branca nos dois temas.
const PAPER = '#ffffff'

// Uma página do manual desenhada em canvas, com `width` px de largura e altura
// pela proporção do slide.
export function SlideCanvas({ doc, pageNumber, width, aspect, label, className }: {
  doc: PDFDocumentProxy
  pageNumber: number
  width: number
  aspect: number
  label: string
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || width <= 0) return
    setFailed(false)
    const job = renderPage(doc, pageNumber, canvas, width)
    job.promise.catch(() => setFailed(true))
    return job.cancel
  }, [doc, pageNumber, width])

  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={{ width, height: Math.round(width / aspect), background: PAPER }}
    >
      <canvas ref={ref} role="img" aria-label={label} className="absolute inset-0 h-full w-full" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-app-card text-[11px] text-gray-500">
          <AlertTriangle size={14} /> Não foi possível desenhar esta página.
        </div>
      )}
    </div>
  )
}
