// Saiu uma versão nova do app enquanto esta aba estava aberta? A página de
// entrada (index.html, servida com no-cache — ver docker/nginx.conf) aponta pro
// script principal do build, cujo nome muda a cada build (/assets/index-<hash>.js).
// Comparar o que o servidor serve agora com o que esta aba carregou diz se ela
// ficou pra trás — sem precisar de nada no servidor.
//
// Era o problema invisível: uma aba aberta desde antes de um redeploy segue
// rodando o código antigo (menu que não se atualiza, salvar do jeito antigo)
// sem nada na tela que avise. Agora a tela avisa (NewVersionBanner), e o
// servidor recusa o salvar de uma versão antiga (OutdatedClientError).
import { useEffect, useState } from 'react'

const CHECK_MS = 2 * 60_000
const ENTRY_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/

// O script principal desta aba. No `npm run dev` não existe (o Vite serve os
// módulos soltos) — aí a checagem fica desligada.
function loadedEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
  return script ? new URL(script.src).pathname : null
}

export function useNewVersion(): boolean {
  const [outdated, setOutdated] = useState(false)

  useEffect(() => {
    const mine = loadedEntry()
    if (!mine) return
    let alive = true
    const check = async () => {
      if (document.hidden) return
      try {
        const res = await fetch(`/?v=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' })
        if (!res.ok) return
        const served = (await res.text()).match(ENTRY_RE)?.[0]
        if (alive && served && served !== mine) setOutdated(true)
      } catch { /* sem rede: confere na próxima */ }
    }
    const id = setInterval(check, CHECK_MS)
    const onVisible = () => { if (!document.hidden) void check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      alive = false
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  return outdated
}
