import { useEffect, useState } from 'react'

// Largura e altura do CONTEÚDO de um elemento (sem o padding), acompanhando
// redimensionamento: janela, barra lateral recolhida, tela cheia. Arredondado
// para não disparar novo desenho por fração de pixel.
//
// Devolve um callback ref em vez de pedir um useRef: se o elemento for trocado
// (ex.: o mesmo bloco passa a ser renderizado num portal), a medida segue o
// elemento novo em vez de continuar observando o antigo.
export function useElementSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    if (!element) return
    // O ResizeObserver já entrega uma primeira medida ao começar a observar.
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect
      const width = Math.round(box.width)
      const height = Math.round(box.height)
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return [setElement, size] as const
}
