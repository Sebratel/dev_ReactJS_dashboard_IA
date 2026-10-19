// O que a IA entrega entra SALVO sozinho: assim que uma resposta termina, as
// medidas que ela criou ou ajustou são gravadas primeiro (os widgets podem
// usá-las) e depois os widgets, na guia do pedido (ver resolveAiTargetTab no
// DashboardBuilder). Antes era preciso aprovar cartão por cartão e ainda
// clicar em "Salvar".
//
// Cada gravação leva SÓ o que a IA entregou: o rascunho que a pessoa ainda não
// salvou (um widget arrastado, um filtro novo) continua rascunho. É o mesmo
// salvar guia por guia do servidor (saveDashboardFull/saveTabWidgets, com o
// `rev` da guia) e as medidas uma a uma (saveDashboardMeasures).
//
// Cada resposta salva tem "Desfazer" no painel — tira os widgets, as medidas
// novas, volta as medidas ajustadas como estavam, e remove a guia que nasceu
// pra elas se ela ficar vazia.
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  saveDashboardFull, saveDashboardMeasures, saveTabWidgets, ApiError,
} from '@/features/workspace/workspaceApi'
import type { DashboardTab, TabLockInfo } from '@/features/workspace/types'
import { useAiChatStore, type AutoSaveResult, type ChatTurn } from './ai/aiChatStore'
import {
  blankTab, mergeMeasureList, placeWidgets, tabContent, toDashboardState,
  type DashboardState, type MeasureChanges,
} from './dashboardState'

interface Snapshot {
  dashboard: DashboardState | null
  savedDashboard: DashboardState | null
  tab: DashboardTab | null
  held: ReadonlySet<string>
}

const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Falha ao salvar.')

export function useAiAutoSave({
  chatKey, folderId, dashboardId, clientId, canManage, ready, snapshot, setDashboard, setSavedDashboard, setActiveTabId, otherLock,
}: {
  chatKey: string
  folderId: string
  dashboardId: string
  clientId: string
  canManage: boolean
  // Dashboard carregada — antes disso não há onde salvar.
  ready: boolean
  // Estado mais recente da tela (lido na hora, não no render).
  snapshot: () => Snapshot
  setDashboard: Dispatch<SetStateAction<DashboardState | null>>
  setSavedDashboard: Dispatch<SetStateAction<DashboardState | null>>
  setActiveTabId: (id: string | null) => void
  otherLock: (tabId: string | null | undefined) => TabLockInfo | null
}) {
  const setAuto = useAiChatStore((s) => s.setAuto)

  // Grava UMA mudança numa guia direto no servidor, partindo da versão SALVA
  // dela (não do rascunho), e depois aplica a mesma mudança na tela.
  // `newTab`: a guia ainda não existe no servidor (nasceu agora, só nesta tela).
  const commitTab = useCallback(async (tabId: string, change: (t: DashboardTab) => DashboardTab, newTab?: DashboardTab) => {
    const { dashboard: d, savedDashboard: s, held } = snapshot()
    if (!d || !s) throw new Error('A dashboard ainda está carregando.')
    const savedTab = s.tabs.find((t) => t.id === tabId) ?? null
    const localTab = d.tabs.find((t) => t.id === tabId) ?? newTab ?? null
    const base = savedTab ?? localTab
    if (!base) throw new Error('A guia não existe mais.')
    const serverTab = change(base)

    let freshTab: DashboardTab | undefined
    let fresh: DashboardState | null = null
    if (canManage) {
      const tabs = savedTab ? s.tabs.map((t) => (t.id === tabId ? serverTab : t)) : [...s.tabs, serverTab]
      fresh = toDashboardState(await saveDashboardFull(folderId, dashboardId, { tabs, changedTabIds: [tabId], removedTabIds: [], clientId }))
      freshTab = fresh.tabs.find((t) => t.id === tabId)
    } else {
      if (!savedTab) throw new Error('Só quem gerencia a dashboard cria guias novas.')
      freshTab = await saveTabWidgets(folderId, dashboardId, tabId, { widgets: serverTab.widgets, baseRev: savedTab.rev ?? 0, clientId })
    }
    if (!freshTab) throw new Error('A guia não voltou do servidor.')
    const confirmed = freshTab

    // A versão salva passa a ter a mudança (as medidas não mudaram aqui)...
    setSavedDashboard((prev) => {
      if (!prev) return prev
      if (fresh) return { ...fresh, measures: prev.measures }
      return { ...prev, tabs: prev.tabs.map((t) => (t.id === tabId ? confirmed : t)) }
    })
    // ...e a tela também, por cima do que ela ainda não salvou. Guia sem
    // rascunho fica igual à do servidor; com rascunho, ganha a mudança e o
    // `rev` novo (o rascunho agora parte desta versão).
    const wasClean = !!savedTab && !!localTab && tabContent(localTab) === tabContent(savedTab)
    setDashboard((prev) => {
      if (!prev) return prev
      const has = prev.tabs.some((t) => t.id === tabId)
      let tabs = has
        ? prev.tabs.map((t) => (t.id !== tabId ? t : wasClean || !savedTab ? confirmed : { ...change(t), rev: confirmed.rev }))
        : [...prev.tabs, confirmed]
      if (fresh) {
        // Outras guias que esta tela não mexeu: a versão do servidor, que pode
        // ter vindo mais nova.
        const oldById = new Map(s.tabs.map((t) => [t.id, t]))
        const freshById = new Map(fresh.tabs.map((t) => [t.id, t]))
        tabs = tabs.map((t) => {
          if (t.id === tabId) return t
          const old = oldById.get(t.id)
          const nu = freshById.get(t.id)
          return old && nu && !held.has(t.id) && tabContent(old) === tabContent(t) ? nu : t
        })
      }
      return { ...prev, tabs }
    })
    return confirmed
  }, [canManage, folderId, dashboardId, clientId, snapshot, setDashboard, setSavedDashboard])

  // Medidas uma a uma, na versão salva e na tela ao mesmo tempo.
  const commitMeasures = useCallback(async (changes: MeasureChanges) => {
    await saveDashboardMeasures(folderId, dashboardId, changes)
    setSavedDashboard((prev) => (prev ? { ...prev, measures: mergeMeasureList(prev.measures, changes) } : prev))
    setDashboard((prev) => (prev ? { ...prev, measures: mergeMeasureList(prev.measures, changes) } : prev))
  }, [folderId, dashboardId, setDashboard, setSavedDashboard])

  // Remove uma guia que nasceu pra uma resposta e ficou vazia no Desfazer.
  const removeEmptyTab = useCallback(async (tabId: string) => {
    const { savedDashboard: s } = snapshot()
    if (!s || !canManage) return
    const saved = s.tabs.find((t) => t.id === tabId)
    if (!saved || saved.widgets.length > 0 || saved.isWelcome) return
    const fresh = toDashboardState(await saveDashboardFull(folderId, dashboardId, {
      tabs: s.tabs.filter((t) => t.id !== tabId), changedTabIds: [], removedTabIds: [tabId], clientId,
    }))
    setSavedDashboard((prev) => (prev ? { ...prev, tabs: fresh.tabs } : prev))
    setDashboard((prev) => (prev ? { ...prev, tabs: prev.tabs.filter((t) => t.id !== tabId) } : prev))
    const { tab } = snapshot()
    if (tab?.id === tabId) setActiveTabId(fresh.tabs[0]?.id ?? null)
  }, [canManage, folderId, dashboardId, clientId, snapshot, setDashboard, setSavedDashboard, setActiveTabId])

  const turnAt = (i: number): ChatTurn | undefined => useAiChatStore.getState().chats[chatKey]?.turns[i]

  // Salva o que uma resposta entregou. Também é o "Tentar de novo" e o botão
  // de conversas de antes desta regra.
  const saveTurn = useCallback(async (turnIndex: number) => {
    const turn = turnAt(turnIndex)
    if (!turn) return
    const previous = turn.auto
    const result: AutoSaveResult = { ...previous, state: 'saving', error: undefined, notes: [] }
    setAuto(chatKey, turnIndex, result)
    try {
      // 1. Medidas — antes dos widgets, que podem usá-las (measureRef).
      if (!result.measuresDone) {
        const created = turn.measureProposal?.measures ?? []
        let updates = turn.measureUpdateProposal?.measures ?? []
        if (updates.length && !canManage) {
          result.notes!.push('O ajuste em medida que já existe ficou de fora: só o gerente da pasta ou um administrador altera uma medida da dashboard.')
          updates = []
        }
        if (created.length || updates.length) {
          const current = snapshot().dashboard?.measures ?? []
          result.previousMeasures = updates.map((u) => current.find((m) => m.id === u.id)).filter((m): m is NonNullable<typeof m> => !!m)
          await commitMeasures({ upsert: [...created, ...updates], remove: [] })
          result.measureIds = created.map((m) => m.id)
        }
        result.measuresDone = true
      }

      // 2. Widgets, na guia do pedido.
      const incoming = turn.proposal?.widgets ?? []
      if (incoming.length && !result.widgetIds?.length) {
        const { dashboard: d, tab } = snapshot()
        if (!d) throw new Error('A dashboard ainda está carregando.')
        let target = d.tabs.find((t) => t.id === turn.tabId) ?? (tab && !tab.isWelcome ? tab : null)
        // Sem guia de destino (ela foi removida, ou a resposta é de antes desta
        // regra e a guia aberta é a de boas-vindas): guia nova — só pra quem
        // gerencia a dashboard, que é quem cria guia.
        const created = target || !canManage ? null : blankTab(d.tabs)
        if (created) target = created
        if (!target) throw new Error('Abra a guia em que os widgets devem entrar e tente de novo.')
        const lock = otherLock(target.id)
        if (lock) throw new Error(`A guia "${target.label}" está sendo editada por ${lock.self ? 'você, em outra janela' : lock.name} agora.`)
        const placed = placeWidgets(target.widgets, incoming)
        const isNew = !snapshot().savedDashboard?.tabs.some((t) => t.id === target!.id)
        await commitTab(target.id, (t) => ({ ...t, widgets: [...t.widgets, ...placed] }), created ?? (isNew ? target : undefined))
        result.tabId = target.id
        result.createdTab = isNew
        result.widgetIds = placed.map((w) => w.id)
        setActiveTabId(target.id)
      }
      setAuto(chatKey, turnIndex, { ...result, state: 'saved' })
    } catch (e) {
      setAuto(chatKey, turnIndex, { ...result, state: 'failed', error: errorText(e) })
    }
  }, [chatKey, canManage, snapshot, commitMeasures, commitTab, otherLock, setActiveTabId, setAuto])

  // Desfaz uma resposta salva: widgets primeiro (aí as medidas dela ficam sem
  // uso e podem sair), depois as medidas, e por fim a guia que nasceu vazia.
  const undoTurn = useCallback(async (turnIndex: number) => {
    const turn = turnAt(turnIndex)
    const auto = turn?.auto
    if (!auto || auto.state !== 'saved') return
    setAuto(chatKey, turnIndex, { ...auto, state: 'undoing', error: undefined })
    try {
      if (auto.tabId && auto.widgetIds?.length) {
        const ids = new Set(auto.widgetIds)
        const { savedDashboard: s } = snapshot()
        if (s?.tabs.some((t) => t.id === auto.tabId)) {
          await commitTab(auto.tabId, (t) => ({ ...t, widgets: t.widgets.filter((w) => !ids.has(w.id)) }))
        }
      }
      if (auto.measureIds?.length || auto.previousMeasures?.length) {
        await commitMeasures({ upsert: auto.previousMeasures ?? [], remove: auto.measureIds ?? [] })
      }
      if (auto.createdTab && auto.tabId) await removeEmptyTab(auto.tabId)
      setAuto(chatKey, turnIndex, { ...auto, state: 'undone' })
    } catch (e) {
      setAuto(chatKey, turnIndex, { ...auto, state: 'saved', error: `Não deu para desfazer: ${errorText(e)}` })
    }
  }, [chatKey, snapshot, commitTab, commitMeasures, removeEmptyTab, setAuto])

  // Salva sozinho cada resposta que terminou com algo entregue. A resposta
  // marcada (`autoSave`) e ainda sem resultado (`auto`) é a que falta — inclusive
  // uma que terminou com esta dashboard fechada (a conversa segue em segundo
  // plano): ela é salva quando a dashboard abre de novo.
  const saveRef = useRef(saveTurn)
  saveRef.current = saveTurn
  const running = useRef(new Set<number>())
  useEffect(() => {
    if (!ready) return
    const run = () => {
      const turns = useAiChatStore.getState().chats[chatKey]?.turns ?? []
      turns.forEach((t, i) => {
        if (t.role !== 'assistant' || !t.autoSave || t.auto || t.streaming || t.interrupted) return
        if (!t.proposal && !t.measureProposal && !t.measureUpdateProposal) return
        if (running.current.has(i)) return
        running.current.add(i)
        void saveRef.current(i).finally(() => running.current.delete(i))
      })
    }
    run()
    return useAiChatStore.subscribe(run)
  }, [chatKey, ready])

  return { saveTurn, undoTurn }
}
