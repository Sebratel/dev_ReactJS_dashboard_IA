import { useEffect, useState } from 'react'
import { fetchManualPdf, ApiError } from './manualApi'
import { openPdf, type PDFDocumentProxy } from './pdf'

export type ManualDocument =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; doc: PDFDocumentProxy; numPages: number; aspect: number }

// Baixa o PDF do manual e abre no pdf.js. `aspect` (largura/altura) vem da 1ª
// página — 16:9 num slide exportado — e dimensiona o palco antes do desenho.
// Mudar `reloadKey` busca de novo (botão "Tentar novamente").
export function useManualDocument(reloadKey: number): ManualDocument {
  const [state, setState] = useState<ManualDocument>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    let opened: PDFDocumentProxy | null = null
    setState({ status: 'loading' })
    fetchManualPdf()
      .then(openPdf)
      .then(async (doc) => {
        // Saiu da página antes de o PDF abrir: a limpeza já rodou sem ele.
        if (!alive) { void doc.destroy(); return }
        opened = doc
        const first = (await doc.getPage(1)).getViewport({ scale: 1 })
        if (alive) setState({ status: 'ready', doc, numPages: doc.numPages, aspect: first.width / first.height })
      })
      .catch((e: unknown) => {
        if (!alive) return
        const message = e instanceof ApiError
          ? e.message
          : 'O arquivo do manual não pôde ser aberto. Avise um administrador.'
        setState({ status: 'error', message })
      })
    return () => {
      alive = false
      void opened?.destroy()
    }
  }, [reloadKey])

  return state
}
