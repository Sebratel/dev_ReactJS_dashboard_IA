// Bloqueio de edição por guia, do lado da tela (o servidor é
// server/tabLocks.mjs). O DashboardBuilder diz QUAIS guias quer segurar
// (`wanted`: a guia aberta no modo edição, mais as que têm alteração não
// salva) e este hook cuida do resto:
//   - pega o bloqueio de cada uma (ou descobre quem está editando);
//   - renova a cada RENEW_MS enquanto a pessoa está mexendo na tela;
//   - solta o que deixou de ser pedido, ao sair da página e ao fechar a aba;
//   - pergunta a cada POLL_MS quem está editando cada guia (o cadeado que
//     todo mundo vê), a versão de cada uma (`revs`) e as permissões de quem
//     está olhando (`editable`, `canManage`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acquireTabLock, fetchTabLocks, releaseTabLock, ApiError, type DashboardPulse,
} from '@/features/workspace/workspaceApi'
import type { DashboardTab, TabLockInfo, TabLocks } from '@/features/workspace/types'

const RENEW_MS = 30_000
const POLL_MS = 15_000
// Tela parada (sem clique nem tecla) por mais que isso deixa de renovar: o
// bloqueio vence sozinho no servidor (~2 min) e a guia volta a ficar livre
// pra outra pessoa. Ao voltar a mexer, a próxima renovação tenta pegar de novo.
const IDLE_MS = 20 * 60_000

// Uma por carga da página: é a "janela" dona do bloqueio (ver tabLocks.mjs).
function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* contexto sem crypto.randomUUID (http fora de localhost) */ }
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}
export const EDIT_CLIENT_ID = newClientId()

export function useTabLocks({ folderId, dashboardId, wanted, onAcquired, onPulse }: {
  folderId: string
  dashboardId: string
  // Guias (que já existem no servidor) que esta janela quer segurar agora.
  wanted: string[]
  // Bloqueio novo: a guia como está no servidor, pra edição começar dela.
  onAcquired: (tab: DashboardTab) => void
  // Versão de cada guia, a cada consulta — pra trazer o que outra pessoa salvou.
  // E as permissões de quem está olhando, agora — mudaram, a tela se atualiza.
  onPulse: (pulse: DashboardPulse) => void
}) {
  const [locks, setLocks] = useState<TabLocks>({})
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set())
  const heldRef = useRef(new Set<string>())
  // Quando cada bloqueio desta janela foi confirmado — ver a consulta abaixo.
  const heldSince = useRef(new Map<string, number>())
  const pendingRef = useRef(new Set<string>())
  // Pedidas e recusadas (outra pessoa editando). Só voltam a ser tentadas
  // quando a consulta periódica as vê livres — nunca "tomando" de volta o
  // bloqueio que a mesma pessoa abriu em outra janela.
  const refusedRef = useRef(new Set<string>())
  const wantedRef = useRef<string[]>(wanted)
  wantedRef.current = wanted
  const lastActivity = useRef(Date.now())
  // Callbacks mais recentes, sem reiniciar os timers a cada render.
  const callbacks = useRef({ onAcquired, onPulse })
  callbacks.current = { onAcquired, onPulse }

  const setHeldTab = useCallback((tabId: string, on: boolean) => {
    if (on === heldRef.current.has(tabId)) return
    if (on) {
      heldRef.current.add(tabId)
      heldSince.current.set(tabId, Date.now())
    } else {
      heldRef.current.delete(tabId)
      heldSince.current.delete(tabId)
    }
    setHeld(new Set(heldRef.current))
  }, [])

  const setLockOf = useCallback((tabId: string, lock: TabLockInfo | null) => {
    setLocks((prev) => {
      const next = { ...prev }
      if (lock) next[tabId] = lock
      else delete next[tabId]
      return next
    })
  }, [])

  const acquire = useCallback(async (tabId: string, renew: boolean) => {
    if (pendingRef.current.has(tabId)) return
    pendingRef.current.add(tabId)
    try {
      const result = await acquireTabLock(folderId, dashboardId, tabId, EDIT_CLIENT_ID, renew)
      // Deixou de ser pedida enquanto a resposta vinha (trocou de guia, saiu do
      // modo edição): solta de volta em vez de segurar à toa.
      if (result.ok && !wantedRef.current.includes(tabId)) {
        void releaseTabLock(folderId, dashboardId, tabId, EDIT_CLIENT_ID).catch(() => {})
        setHeldTab(tabId, false)
        setLockOf(tabId, null)
        return
      }
      setLockOf(tabId, result.lock)
      setHeldTab(tabId, result.ok)
      if (result.ok) refusedRef.current.delete(tabId)
      else refusedRef.current.add(tabId)
      if (result.ok && result.tab) callbacks.current.onAcquired(result.tab)
    } catch (e) {
      // Guia apagada ou permissão retirada: não há o que segurar. Falha de rede
      // não muda nada — a próxima renovação tenta de novo.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setHeldTab(tabId, false)
    } finally {
      pendingRef.current.delete(tabId)
    }
  }, [folderId, dashboardId, setHeldTab, setLockOf])

  const release = useCallback((tabId: string, keepalive = false) => {
    setHeldTab(tabId, false)
    setLockOf(tabId, null)
    void releaseTabLock(folderId, dashboardId, tabId, EDIT_CLIENT_ID, keepalive).catch(() => {})
  }, [folderId, dashboardId, setHeldTab, setLockOf])

  // Segura o que foi pedido e solta o resto. Uma guia recusada não é pedida de
  // novo aqui — quem tenta de novo é a consulta periódica, quando a vê livre.
  const wantedKey = wanted.join('|')
  useEffect(() => {
    const want = new Set(wanted)
    for (const id of [...refusedRef.current]) if (!want.has(id)) refusedRef.current.delete(id)
    for (const id of [...heldRef.current]) if (!want.has(id)) release(id)
    for (const id of want) if (!heldRef.current.has(id) && !refusedRef.current.has(id)) void acquire(id, false)
    // `wanted` entra pela chave (o array é recriado a cada render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, acquire, release])

  const idle = useCallback(() => Date.now() - lastActivity.current > IDLE_MS, [])

  // Atividade = clique ou tecla em qualquer ponto da página. Voltando de uma
  // pausa longa, pega de volta na hora o que venceu enquanto a tela estava
  // parada, sem esperar a próxima consulta.
  useEffect(() => {
    const mark = () => {
      const wasIdle = idle()
      lastActivity.current = Date.now()
      if (!wasIdle) return
      for (const tabId of wantedRef.current) {
        if (heldRef.current.has(tabId)) void acquire(tabId, true)
        else if (!refusedRef.current.has(tabId)) void acquire(tabId, false)
      }
    }
    window.addEventListener('pointerdown', mark, { passive: true })
    window.addEventListener('keydown', mark, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', mark)
      window.removeEventListener('keydown', mark)
    }
  }, [acquire, idle])

  // Renovação. Uma guia que outra pessoa pegou nesse meio-tempo (o bloqueio
  // venceu) volta como recusada — e a tela mostra quem está com ela.
  useEffect(() => {
    const id = setInterval(() => {
      if (idle()) return
      for (const tabId of [...heldRef.current]) void acquire(tabId, true)
    }, RENEW_MS)
    return () => clearInterval(id)
  }, [acquire, idle])

  // Quem está editando o quê — pra todo mundo, editando ou só olhando.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      const startedAt = Date.now()
      try {
        const res = await fetchTabLocks(folderId, dashboardId, EDIT_CLIENT_ID)
        if (!alive) return
        setLocks(res.locks)
        // O servidor é quem sabe: um bloqueio desta janela que não aparece
        // mais (venceu com a tela parada, a API reiniciou) deixa de contar como
        // seguro — a não ser que tenha sido pego depois que a consulta saiu.
        for (const tabId of [...heldRef.current]) {
          if (!res.locks[tabId]?.mine && (heldSince.current.get(tabId) ?? 0) < startedAt) setHeldTab(tabId, false)
        }
        // Pedida e agora livre (inclusive as recusadas antes): tenta pegar —
        // menos com a tela parada, que é justamente quando o bloqueio é largado.
        if (!idle()) {
          for (const tabId of wantedRef.current) {
            if (!heldRef.current.has(tabId) && !res.locks[tabId]) void acquire(tabId, false)
          }
        }
        callbacks.current.onPulse({ revs: res.revs, editable: res.editable ?? [], canManage: !!res.canManage })
      } catch { /* sem rede: mantém o último estado e tenta na próxima */ }
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    const onVisible = () => { if (!document.hidden) void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [folderId, dashboardId, acquire, setHeldTab, idle])

  // Fechar a aba/janela do navegador: `keepalive` deixa o pedido sair mesmo
  // com a página indo embora. Sair da dashboard pelo menu (desmontar) solta
  // do jeito normal.
  useEffect(() => {
    const onHide = () => { for (const tabId of [...heldRef.current]) release(tabId, true) }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      for (const tabId of [...heldRef.current]) release(tabId)
    }
  }, [release])

  // Bloqueio de OUTRA pessoa (ou desta pessoa em outra janela) — o que impede
  // esta tela de editar a guia.
  const otherLock = useCallback((tabId: string | null | undefined): TabLockInfo | null => {
    if (!tabId) return null
    const lock = locks[tabId]
    return lock && !lock.mine ? lock : null
  }, [locks])

  return useMemo(() => ({ locks, setLocks, held, otherLock }), [locks, held, otherLock])
}
