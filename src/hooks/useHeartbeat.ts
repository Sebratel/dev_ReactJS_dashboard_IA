import { useEffect } from 'react'
import { sendHeartbeat } from '@/features/access/accessApi'

const INTERVAL_MS = 45_000

// Mantém o usuário marcado como "online" (ver server/accessLog.mjs) mesmo
// numa tela parada, sem interação — só faz sentido com a aba visível, senão
// um usuário com várias abas abertas em segundo plano nunca apareceria
// offline de verdade.
export function useHeartbeat() {
  useEffect(() => {
    const ping = () => { if (document.visibilityState === 'visible') sendHeartbeat().catch(() => {}) }
    ping()
    const id = setInterval(ping, INTERVAL_MS)
    document.addEventListener('visibilitychange', ping)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', ping) }
  }, [])
}
