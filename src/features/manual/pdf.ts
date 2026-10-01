// pdf.js só entra na página do manual (a rota é lazy, ver src/router/index.tsx).
// Build "legacy" para cobrir navegadores um pouco mais antigos, e o worker sai
// como asset próprio do Vite — nada vem de CDN.
import { getDocument, GlobalWorkerOptions, RenderingCancelledException } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy }

export function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // isEvalSupported: false — o arquivo é trocável, então o pdf.js não monta
  // função a partir do conteúdo dele (defesa em profundidade).
  return getDocument({ data, isEvalSupported: false }).promise
}

export interface RenderJob {
  promise: Promise<void>
  cancel: () => void
}

// Desenha a página `pageNumber` em `target` para ocupar `cssWidth` px na tela,
// na densidade real do monitor (nítido em tela retina). Renderiza num canvas
// fora da tela e só então copia: trocar de slide não pisca em branco.
export function renderPage(doc: PDFDocumentProxy, pageNumber: number, target: HTMLCanvasElement, cssWidth: number): RenderJob {
  let task: RenderTask | null = null
  let cancelled = false
  const promise = (async () => {
    const page = await doc.getPage(pageNumber)
    if (cancelled) return
    const base = page.getViewport({ scale: 1 })
    const scale = (cssWidth / base.width) * (window.devicePixelRatio || 1)
    const viewport = page.getViewport({ scale })
    const offscreen = document.createElement('canvas')
    offscreen.width = Math.max(1, Math.floor(viewport.width))
    offscreen.height = Math.max(1, Math.floor(viewport.height))
    task = page.render({ canvas: offscreen, viewport })
    await task.promise
    if (cancelled) return
    target.width = offscreen.width
    target.height = offscreen.height
    target.getContext('2d')?.drawImage(offscreen, 0, 0)
  })().catch((e: unknown) => {
    if (cancelled || e instanceof RenderingCancelledException) return
    throw e
  })
  return {
    promise,
    cancel: () => {
      cancelled = true
      task?.cancel()
    },
  }
}
