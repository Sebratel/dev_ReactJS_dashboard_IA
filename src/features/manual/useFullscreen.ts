import { useCallback, useEffect, useState, type RefObject } from 'react'

// Quanto esperar a tela cheia nativa entrar antes de usar o modo de reserva.
const NATIVE_TIMEOUT_MS = 1500

// Tela cheia do leitor do manual. Usa a API nativa do navegador; onde ela não
// existe (Safari no iPhone só a oferece para vídeo), é recusada, ou não
// responde (há navegador embutido que aceita o pedido e nunca entra), cai num
// modo de reserva que cobre a janela inteira com CSS — `fallback` diz qual dos
// dois está ativo.
export function useFullscreen(ref: RefObject<HTMLElement>) {
  const [native, setNative] = useState(false)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    const onChange = () => setNative(!!ref.current && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [ref])

  // No modo nativo o Esc é do navegador; no de reserva, é daqui.
  useEffect(() => {
    if (!fallback) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFallback(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fallback])

  const enter = useCallback(() => {
    const el = ref.current
    if (!el || !document.fullscreenEnabled || typeof el.requestFullscreen !== 'function') {
      setFallback(true)
      return
    }
    const timer = window.setTimeout(() => {
      if (document.fullscreenElement !== el) setFallback(true)
    }, NATIVE_TIMEOUT_MS)
    el.requestFullscreen().catch(() => {
      window.clearTimeout(timer)
      setFallback(true)
    })
  }, [ref])

  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    setFallback(false)
  }, [])

  const isFullscreen = native || fallback
  const toggle = useCallback(() => (isFullscreen ? exit() : enter()), [isFullscreen, enter, exit])

  return { isFullscreen, isFallback: fallback, toggle }
}
