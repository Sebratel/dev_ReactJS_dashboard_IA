// Conversas do "Montar com IA", uma por dashboard (chave pasta/dashboard),
// guardadas durante a SESSÃO: fechar o painel, trocar de dashboard ou recarregar
// a página não apaga nada. Fechar a aba apaga (é sessionStorage), e sair do
// sistema também (ver logout em src/store/authStore.ts e syncOwner, no fim).
//
// O turno roda aqui, não no componente: fechar o painel no meio de uma resposta
// não a interrompe, e ao reabrir ela está lá, inteira.
//
// A memória do MODELO fica no servidor (server/aiAssistant.mjs), que a esquece
// depois de 2 h sem uso ou quando a API reinicia. Aí ele responde 410, e a
// conversa é retomada com o que está na tela (historyForResume): o modelo relê
// o diálogo e segue de onde parou.
import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import { useAuthStore } from '@/store/authStore'
import { AI_CHATS_KEY } from '@/store/sessionScopedStorage'
import type { MeasureDef, WidgetConfig } from '../types'
import { endAiConversation, startAiConversation, streamAiTurn, ApiError, DEFAULT_AI_OPTIONS, type AiEvent, type AiRequestOptions, type AiStatus, type AiTarget, type ResumeMessage } from './aiApi'

// "Ajustar com IA": o widget em que a pessoa clicou. Enquanto estiver
// escolhido, cada pedido vai com ele (ver AiTarget) e o ajuste volta no mesmo
// widget, em vez de virar widget novo.
export interface AiFocus {
  widgetId: string
  tabId: string
  title: string
}

// Um ajuste que a IA fez num widget que já existia (update_widget).
export interface WidgetUpdate {
  widgetId: string
  widget: WidgetConfig
  summary: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  // Guia em que o pedido foi feito — é pra ela que vão os widgets propostos
  // na resposta (ver resolveAiTargetTab no DashboardBuilder). Ausente em
  // conversas de antes desta regra.
  tabId?: string
  // Preferências com que o pedido foi feito (no turno da pessoa) — o painel
  // mostra junto da mensagem.
  options?: AiRequestOptions
  // Pedido feito com um widget escolhido ("Ajustar com IA") — o nome dele.
  focusTitle?: string
  // Resposta cujo resultado entra SALVO sozinho quando ela termina (medidas
  // primeiro, depois widgets — ver useAiAutoSave.ts). Ausente em conversas de
  // antes desta regra: essas mostram um botão pra salvar.
  autoSave?: boolean
  // O que aconteceu com o salvamento — e o que o "Desfazer" precisa desfazer.
  auto?: AutoSaveResult
  // O que a resposta entregou (somado, se veio em mais de uma chamada).
  // `applied` só aparece em conversas de antes do salvar sozinho: era o
  // "Adicionar à guia" que já tinha sido clicado.
  proposal?: { widgets: WidgetConfig[]; summary: string; applied?: boolean }
  // Mesma ideia, pra uma proposta de MEDIDA nova (propose_measures)...
  measureProposal?: { measures: MeasureDef[]; summary: string; applied?: boolean }
  // ...e pra ATUALIZAÇÃO de medidas já existentes (update_measures).
  measureUpdateProposal?: { measures: MeasureDef[]; summary: string; applied?: boolean }
  // ...e pra ajuste num widget que já existe (update_widget).
  widgetUpdates?: WidgetUpdate[]
  // Resposta ainda chegando. Se a conexão cair ou a página recarregar no meio,
  // vira `interrupted` (no turno, ou ao reabrir — ver `merge`).
  streaming?: boolean
  interrupted?: boolean
}

export interface AutoSaveResult {
  state: 'saving' | 'saved' | 'failed' | 'undoing' | 'undone'
  tabId?: string            // guia em que os widgets entraram
  createdTab?: boolean      // a guia nasceu com eles (o Desfazer a remove, se ficar vazia)
  widgetIds?: string[]
  measuresDone?: boolean    // medidas já gravadas (uma nova tentativa só refaz os widgets)
  measureIds?: string[]     // medidas novas criadas
  previousMeasures?: MeasureDef[] // como estavam as medidas que a IA ajustou
  updatedTabId?: string     // guia do widget ajustado
  previousWidgets?: WidgetConfig[] // como estavam os widgets que a IA ajustou
  notes?: string[]          // o que ficou de fora, e por quê
  error?: string
}

export interface DashboardChat {
  conversationId: string | null
  // null = ninguém escolheu ainda (o painel só pré-seleciona quando há UMA fonte).
  sourceKeys: string[] | null
  // Personalização e o que entregar (passos 3 e 4) — valem pro próximo pedido.
  options: AiRequestOptions
  // Widget escolhido para ajustar ("Ajustar com IA"); null = pedido comum.
  focus: AiFocus | null
  turns: ChatTurn[]
  // Daqui pra baixo, transitório — não vai para o sessionStorage.
  busy: boolean
  tool: string | null
  error: string | null
  // Turno em andamento. Um "Nova conversa" ou um logout no meio da resposta
  // troca/apaga este valor, e o resto da resposta é descartado.
  runId: string | null
}

type StoredChat = Pick<DashboardChat, 'conversationId' | 'sourceKeys' | 'turns'> & { options?: AiRequestOptions; focus?: AiFocus | null }

interface PersistedState {
  ownerEmail: string | null
  chats: Record<string, StoredChat>
}

interface AiChatState {
  ownerEmail: string | null
  chats: Record<string, DashboardChat>
  // Gasto do dia (é por usuário, não por dashboard).
  status: AiStatus | null
  setStatus: (status: AiStatus) => void
  setSources: (key: string, sourceKeys: string[]) => void
  setOptions: (key: string, options: AiRequestOptions) => void
  setFocus: (key: string, focus: AiFocus | null) => void
  send: (args: { key: string; folderId: string; text: string; dashboardMeasures: MeasureDef[]; tabId?: string; target?: AiTarget }) => Promise<void>
  setAuto: (key: string, turnIndex: number, auto: AutoSaveResult) => void
  reset: (key: string) => void
  clearAll: () => void
}

export const EMPTY_CHAT: DashboardChat = {
  conversationId: null, sourceKeys: null, options: DEFAULT_AI_OPTIONS, focus: null, turns: [], busy: false, tool: null, error: null, runId: null,
}

export const chatKey = (folderId: string, dashboardId: string) => `${folderId}/${dashboardId}`

// ─── Retomada ────────────────────────────────────────────────────────────
function proposalNotes(turn: ChatTurn): string[] {
  const notes: string[] = []
  const savedNote = turn.auto?.state === 'saved' ? ' — salvo automaticamente' : turn.auto?.state === 'undone' ? ' — o usuário desfez' : ''
  if (turn.proposal) {
    const titles = turn.proposal.widgets.map((w) => w.title || w.type).join('; ')
    notes.push(`[Propus ${turn.proposal.widgets.length} widget(s): ${titles}${turn.proposal.applied ? ' — o usuário adicionou à guia' : savedNote}]`)
  }
  if (turn.measureProposal) {
    const names = turn.measureProposal.measures.map((m) => m.name).join('; ')
    notes.push(`[Propus a(s) medida(s): ${names}${turn.measureProposal.applied ? ' — o usuário adicionou à tabela de medidas' : savedNote}]`)
  }
  if (turn.measureUpdateProposal) {
    const names = turn.measureUpdateProposal.measures.map((m) => m.name).join('; ')
    notes.push(`[Propus atualizar a(s) medida(s): ${names}${turn.measureUpdateProposal.applied ? ' — o usuário aplicou' : savedNote}]`)
  }
  for (const u of turn.widgetUpdates ?? []) {
    notes.push(`[Ajustei o widget "${u.widget.title}": ${u.summary}${savedNote}]`)
  }
  if (turn.interrupted) notes.push('[resposta interrompida]')
  return notes
}

// O que já foi dito, em texto — inclusive o que foi proposto e aprovado, que
// na tela é cartão e não texto. O servidor limita o tamanho (resumeHistory).
export function historyForResume(turns: ChatTurn[]): ResumeMessage[] {
  return turns
    .map((t) => ({ role: t.role, text: t.role === 'user' ? t.text : [t.text, ...proposalNotes(t)].filter(Boolean).join('\n\n') }))
    .filter((m) => m.text.trim())
}

// ─── sessionStorage com gravação adiada ──────────────────────────────────
// Durante a resposta o texto chega aos pedaços, e serializar todas as conversas
// a cada pedaço é trabalho jogado fora: grava 400 ms depois da última mudança —
// e na hora, se a aba for fechada ou recarregada.
const WRITE_DELAY_MS = 400
let pendingWrite: { name: string; value: StorageValue<PersistedState> } | null = null
let writeTimer: ReturnType<typeof setTimeout> | undefined

function flushWrite() {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = undefined
  if (!pendingWrite) return
  const { name, value } = pendingWrite
  pendingWrite = null
  try {
    sessionStorage.setItem(name, JSON.stringify(value))
  } catch {
    // Cheio ou bloqueado pelo navegador: a conversa segue só em memória.
  }
}
window.addEventListener('pagehide', flushWrite)

const sessionStore: PersistStorage<PersistedState> = {
  getItem: (name) => {
    try {
      const raw = sessionStorage.getItem(name)
      return raw ? (JSON.parse(raw) as StorageValue<PersistedState>) : null
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    pendingWrite = { name, value }
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(flushWrite, WRITE_DELAY_MS)
  },
  removeItem: (name) => {
    pendingWrite = null
    if (writeTimer) clearTimeout(writeTimer)
    try { sessionStorage.removeItem(name) } catch { /* bloqueado: nada guardado */ }
  },
}

// ─── Store ───────────────────────────────────────────────────────────────
let runSeq = 0

function replaceLast(turns: ChatTurn[], change: (turn: ChatTurn) => ChatTurn): ChatTurn[] {
  return turns.length ? [...turns.slice(0, -1), change(turns[turns.length - 1])] : turns
}

export const useAiChatStore = create<AiChatState>()(persist((set, get) => {
  const chatOf = (key: string) => get().chats[key] ?? EMPTY_CHAT

  const patchChat = (key: string, patch: Partial<DashboardChat> | ((chat: DashboardChat) => Partial<DashboardChat>)) => {
    set((s) => {
      const current = s.chats[key] ?? EMPTY_CHAT
      const next = typeof patch === 'function' ? patch(current) : patch
      return { chats: { ...s.chats, [key]: { ...current, ...next } } }
    })
  }

  // Só escreve se `runId` ainda for o turno da conversa.
  const patchRun = (key: string, runId: string, patch: Partial<DashboardChat> | ((chat: DashboardChat) => Partial<DashboardChat>)) => {
    if (get().chats[key]?.runId !== runId) return false
    patchChat(key, patch)
    return true
  }

  const consumeTurn = async (key: string, runId: string, events: AsyncGenerator<AiEvent>) => {
    for await (const ev of events) {
      if (get().chats[key]?.runId !== runId) return
      if (ev.type === 'text') {
        patchRun(key, runId, (c) => ({ turns: replaceLast(c.turns, (t) => ({ ...t, text: t.text + ev.text })) }))
      } else if (ev.type === 'tool') {
        patchRun(key, runId, { tool: ev.name })
      // Mais de uma entrega no MESMO turno se SOMA (antes a 2ª substituía a
      // 1ª — e, com as medidas salvas sozinhas, o widget que usava uma medida
      // do 1º lote ficaria apontando pra uma medida que nunca foi gravada).
      } else if (ev.type === 'widgets') {
        patchRun(key, runId, (c) => ({ tool: null, turns: replaceLast(c.turns, (t) => ({
          ...t, proposal: { widgets: [...(t.proposal?.widgets ?? []), ...ev.widgets], summary: [t.proposal?.summary, ev.summary].filter(Boolean).join(' ') },
        })) }))
      } else if (ev.type === 'measures') {
        patchRun(key, runId, (c) => ({ tool: null, turns: replaceLast(c.turns, (t) => ({
          ...t, measureProposal: { measures: [...(t.measureProposal?.measures ?? []), ...ev.measures], summary: [t.measureProposal?.summary, ev.summary].filter(Boolean).join(' ') },
        })) }))
      } else if (ev.type === 'measureUpdates') {
        patchRun(key, runId, (c) => ({ tool: null, turns: replaceLast(c.turns, (t) => {
          const ids = new Set(ev.measures.map((m) => m.id))
          const kept = (t.measureUpdateProposal?.measures ?? []).filter((m) => !ids.has(m.id))
          return { ...t, measureUpdateProposal: { measures: [...kept, ...ev.measures], summary: [t.measureUpdateProposal?.summary, ev.summary].filter(Boolean).join(' ') } }
        }) }))
      } else if (ev.type === 'widgetUpdate') {
        // Dois ajustes no mesmo widget, no mesmo turno: vale o último.
        patchRun(key, runId, (c) => ({ tool: null, turns: replaceLast(c.turns, (t) => ({
          ...t, widgetUpdates: [...(t.widgetUpdates ?? []).filter((u) => u.widgetId !== ev.widgetId), { widgetId: ev.widgetId, widget: ev.widget, summary: ev.summary }],
        })) }))
      } else if (ev.type === 'done') {
        set({ status: ev.usage })
      } else if (ev.type === 'error') {
        patchRun(key, runId, { error: ev.message })
      }
    }
  }

  return {
    ownerEmail: null,
    chats: {},
    status: null,

    setStatus: (status) => set({ status }),

    setSources: (key, sourceKeys) => patchChat(key, { sourceKeys }),

    setOptions: (key, options) => patchChat(key, { options }),

    setFocus: (key, focus) => patchChat(key, { focus }),

    send: async ({ key, folderId, text, dashboardMeasures, tabId, target }) => {
      const chat = chatOf(key)
      if (!text.trim() || chat.busy) return
      const runId = String(++runSeq)
      patchChat(key, { busy: true, error: null, tool: null, runId })
      try {
        let conversationId = chat.conversationId
        if (!conversationId) {
          const started = await startAiConversation(folderId, chat.sourceKeys ?? [])
          conversationId = started.conversationId
          if (!patchRun(key, runId, { conversationId })) return
        }
        const added = patchRun(key, runId, (c) => ({
          turns: [...c.turns, { role: 'user', text, tabId, options: c.options, focusTitle: target ? c.focus?.title ?? target.widget.title : undefined }, { role: 'assistant', text: '', streaming: true, tabId, autoSave: true }],
        }))
        if (!added) return
        try {
          await consumeTurn(key, runId, streamAiTurn(conversationId, text, dashboardMeasures, chatOf(key).sourceKeys ?? undefined, chatOf(key).options, target))
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 410) throw e
          // O servidor esqueceu a conversa: abre outra com o que já foi dito
          // (sem o par que acabou de entrar) e manda o mesmo pedido de novo.
          const current = chatOf(key)
          const started = await startAiConversation(folderId, current.sourceKeys ?? [], historyForResume(current.turns.slice(0, -2)))
          if (!patchRun(key, runId, { conversationId: started.conversationId })) return
          await consumeTurn(key, runId, streamAiTurn(started.conversationId, text, dashboardMeasures, chatOf(key).sourceKeys ?? undefined, chatOf(key).options, target))
        }
      } catch (e) {
        patchRun(key, runId, (c) => ({
          error: e instanceof ApiError ? e.message : 'Falha ao falar com a IA.',
          // A resposta parou no meio (a conexão caiu, a página foi recarregada):
          // o que chegou fica, marcado como incompleto.
          turns: c.turns.map((t) => (t.streaming ? { ...t, interrupted: true } : t)),
        }))
      } finally {
        patchRun(key, runId, (c) => ({
          busy: false, tool: null, runId: null,
          turns: c.turns.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
        }))
      }
    },

    setAuto: (key, turnIndex, auto) => patchChat(key, (c) => ({
      turns: c.turns.map((t, i) => (i === turnIndex ? { ...t, auto } : t)),
    })),

    reset: (key) => {
      const previous = get().chats[key]?.conversationId
      if (previous) endAiConversation(previous).catch(() => { /* o servidor esquece sozinho */ })
      set((s) => {
        const chats = { ...s.chats }
        delete chats[key]
        return { chats }
      })
    },

    clearAll: () => set({ chats: {}, ownerEmail: null }),
  }
}, {
  name: AI_CHATS_KEY,
  version: 1,
  storage: sessionStore,
  partialize: (s): PersistedState => ({
    ownerEmail: s.ownerEmail,
    chats: Object.fromEntries(Object.entries(s.chats).map(([key, c]) => [key, { conversationId: c.conversationId, sourceKeys: c.sourceKeys, options: c.options, focus: c.focus, turns: c.turns }])),
  }),
  merge: (persisted, current) => {
    const stored = (persisted ?? {}) as Partial<PersistedState>
    const chats: Record<string, DashboardChat> = {}
    for (const [key, c] of Object.entries(stored.chats ?? {})) {
      chats[key] = {
        ...EMPTY_CHAT,
        conversationId: c.conversationId ?? null,
        sourceKeys: c.sourceKeys ?? null,
        options: c.options ?? DEFAULT_AI_OPTIONS,
        focus: c.focus ?? null,
        // Resposta que estava chegando quando a página recarregou: o resto
        // dela ficou no servidor, mas não chega mais aqui.
        turns: (c.turns ?? []).map((t) => (t.streaming ? { ...t, streaming: false, interrupted: true } : t)),
      }
    }
    return { ...current, ownerEmail: stored.ownerEmail ?? null, chats }
  },
}))

// ─── Dono das conversas ──────────────────────────────────────────────────
// Saiu (logout, sessão vencida) ou entrou outra pessoa nesta aba: tudo apagado.
function syncOwner(email: string | null) {
  const { ownerEmail, chats, clearAll } = useAiChatStore.getState()
  if (!email) {
    if (ownerEmail || Object.keys(chats).length) clearAll()
    return
  }
  if (ownerEmail && ownerEmail !== email) clearAll()
  if (useAiChatStore.getState().ownerEmail !== email) useAiChatStore.setState({ ownerEmail: email })
}

// Só depois que a sessão foi conferida no servidor (`ready`): antes disso,
// "sem usuário" quer dizer "ainda não sei", não "saiu".
const auth = useAuthStore.getState()
if (auth.ready) syncOwner(auth.user?.email ?? null)
useAuthStore.subscribe((s, prev) => {
  if (!s.ready) return
  const email = s.user?.email ?? null
  if (!prev.ready || email !== (prev.user?.email ?? null)) syncOwner(email)
})
