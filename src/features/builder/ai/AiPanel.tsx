// Painel de montagem com IA — conversa lateral no modo edição da guia.
//
// Fluxo: 1. escolher as fontes (dá pra mudar depois) → 2. descrever o que quer
// ver → 3. nível de personalização → 4. o que a IA deve entregar (os dois
// últimos em AiRequestOptions.tsx) → a IA entrega medidas e widgets, que
// entram SALVOS sozinhos quando a resposta termina (ver useAiAutoSave.ts). Cada resposta salva tem
// "Desfazer" no cartão (AiTurnResult.tsx). Antes era preciso aprovar cartão
// por cartão e ainda clicar em "Salvar".
//
// "Ajustar com IA" num widget (botão no cabeçalho dele): o painel abre com o
// widget escolhido (aiChatStore.focus) e cada pedido vai com ele — a IA ajusta
// aquele widget no lugar (update_widget), em vez de montar um novo. O "×" da
// faixa "Ajustando" volta ao modo de sempre.
//
// Autocontido de propósito: o DashboardBuilder só monta este componente e
// passa o salvar/desfazer por callback, sem herdar estado nenhum da conversa.
//
// A conversa em si não mora aqui: fica em aiChatStore.ts, uma por dashboard,
// durante a sessão. Fechar o painel não apaga nada — e uma resposta em
// andamento continua chegando com ele fechado.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, X, Send, Loader2, AlertTriangle, Wrench, RotateCcw, Wand2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { getAllSources } from '../fieldCatalog'
import type { MeasureDef } from '../types'
import { fetchAiStatus, ApiError, type AiTarget } from './aiApi'
import { useAiChatStore, chatKey, EMPTY_CHAT, type AiFocus } from './aiChatStore'
import { AiSourcePicker } from './AiSourcePicker'
import { AiTurnResult } from './AiTurnResult'
import { AiRequestOptionsPicker, optionsSummary } from './AiRequestOptions'

const TOOL_LABEL: Record<string, string> = {
  field_values: 'conferindo os valores reais do campo',
  preview_widget: 'testando o widget contra os dados',
  propose_widgets: 'montando a proposta',
  preview_measure: 'conferindo o cálculo contra os dados',
  propose_measures: 'montando a medida',
  update_measures: 'atualizando a medida',
  update_widget: 'ajustando o widget',
}

// Mesmas frases do convite da guia vazia (ai/AiEmptyState.tsx): a pessoa que
// clicou no botão "IA" vindo de lá deve reconhecer as opções.
const SUGGESTIONS = [
  'Quais são os principais indicadores destes dados?',
  'Analise o churn e identifique onde estão as maiores perdas.',
  'Compare o volume por mês e destaque as variações relevantes.',
]

// Com um widget escolhido ("Ajustar com IA").
const FOCUS_SUGGESTIONS = [
  'Por que o número deste widget é diferente do dos outros?',
  'Revise os filtros deste widget e me diga o que ele está mostrando.',
  'Troque para um tipo de gráfico que leia melhor.',
  'Mostre os valores em cima do gráfico.',
]

export function AiPanel({ folderId, dashboardId, initialPrompt, dashboardMeasures, resolveTargetTab, resolveFocusTarget, tabLabel, onSaveTurn, onUndoTurn, onClose }: {
  folderId: string
  // Cada dashboard tem a sua conversa (ver aiChatStore.ts).
  dashboardId: string
  // Pergunta já digitada no convite (ver AiEmptyState). Com as fontes já
  // escolhidas nesta dashboard, sai sozinha; sem, fica no campo esperando a
  // pessoa escolher as fontes — escolher é o 1º passo, não um detalhe.
  initialPrompt?: string
  // Medidas JÁ existentes no rascunho da dashboard (salvas ou não) — mandadas
  // a cada turno, pra IA saber o que já existe e poder referenciar por nome
  // numa fórmula nova (ver measuresText, server/aiAssistant.mjs).
  dashboardMeasures: MeasureDef[]
  // Chamado a cada pedido enviado: em que guia os widgets da resposta vão
  // cair. Na guia de boas-vindas, cria uma guia nova (ver DashboardBuilder).
  resolveTargetTab: () => string | null
  // O widget escolhido como está AGORA (e os outros da guia) — null se ele
  // não existe mais.
  resolveFocusTarget: (focus: AiFocus) => AiTarget | null
  // Nome atual de uma guia, pro cartão dizer onde a resposta entrou.
  tabLabel: (tabId: string | undefined) => string | null
  // Salvar (ou tentar de novo) e desfazer o que uma resposta entregou (ver
  // useAiAutoSave.ts) — o salvar sozinho já acontece sem o painel.
  onSaveTurn: (turnIndex: number) => void
  onUndoTurn: (turnIndex: number) => void
  onClose: () => void
}) {
  const key = chatKey(folderId, dashboardId)
  const chat = useAiChatStore((s) => s.chats[key]) ?? EMPTY_CHAT
  const status = useAiChatStore((s) => s.status)
  const { setStatus, setSources, setOptions, setFocus, send: sendTurn, reset } = useAiChatStore.getState()
  const { conversationId, turns, busy, tool, error, focus } = chat
  const [statusError, setStatusError] = useState<string | null>(null)
  const [focusError, setFocusError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const sources = getAllSources()
  const selected = useMemo(() => new Set(chat.sourceKeys ?? []), [chat.sourceKeys])

  // Com UMA fonte só não há o que escolher: já vem marcada. Com mais de uma, a
  // escolha é da pessoa — antes, até 3 vinham todas marcadas e o pedido do
  // convite saía sozinho, sem ela nem ver de que dados a IA ia partir.
  useEffect(() => {
    if (chat.sourceKeys !== null || sources.length !== 1) return
    setSources(key, [sources[0].key])
  }, [sources, chat.sourceKeys, key, setSources])

  useEffect(() => {
    let alive = true
    fetchAiStatus()
      .then((s) => { if (alive) setStatus(s) })
      .catch((e) => { if (alive) setStatusError(e instanceof ApiError ? e.message : 'Não foi possível checar a IA.') })
    return () => { alive = false }
  }, [setStatus])

  // Mantém a conversa rolada para o fim conforme o texto vai chegando — e ao
  // reabrir o painel, já no ponto em que a conversa parou.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, tool])

  const send = (text: string) => {
    if (!text.trim() || busy) return
    // Com widget escolhido, o pedido vai com ele e com a guia dele — não abre
    // guia nova (resolveTargetTab criaria uma, vindo da de boas-vindas).
    const target = focus ? resolveFocusTarget(focus) : null
    if (focus && !target) {
      setFocusError(`O widget "${focus.title}" não está mais na dashboard. Feche a faixa "Ajustando" para pedir outra coisa.`)
      return
    }
    setFocusError(null)
    setInput('')
    void sendTurn({
      key, folderId, text, dashboardMeasures,
      tabId: focus ? focus.tabId : resolveTargetTab() ?? undefined,
      target: target ?? undefined,
    })
  }

  const overBudget = !!status && status.budgetUsd > 0 && status.spentUsd >= status.budgetUsd

  // A pergunta vinda do convite: sai sozinha, uma única vez, quando as fontes
  // já tinham sido escolhidas nesta dashboard (ou só existe uma). Sem fonte
  // escolhida, ela fica no campo e a pessoa envia depois de marcar as fontes —
  // mandar no 1º clique cortaria quem quer marcar mais de uma. O ref é o que
  // garante "uma vez": em desenvolvimento o React monta o componente duas
  // vezes, e sem isso o turno sairia duplicado — e cobrado duas vezes.
  const autoSent = useRef(false)
  useEffect(() => {
    if (autoSent.current || !initialPrompt || overBudget) return
    // A única fonte está sendo marcada agora (efeito acima): envia no próximo render.
    if (selected.size === 0 && sources.length === 1) return
    autoSent.current = true
    if (selected.size === 0) {
      setInput(initialPrompt)
      return
    }
    send(initialPrompt)
    // `send` é recriada a cada render; o guard acima é o que controla o efeito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, selected.size, overBudget])

  // "Nova conversa": o único jeito de zerar agora que fechar o painel não zera.
  const startOver = () => {
    setConfirmReset(false)
    reset(key)
  }

  // Precisa de pelo menos uma fonte marcada — inclusive no meio da conversa.
  const canChat = selected.size > 0

  // Portal obrigatório, não decorativo: a raiz do Builder tem `animate-slide-up`,
  // que deixa um `transform` (identidade, mas transform) no elemento — e isso o
  // torna o bloco de contenção de qualquer `position: fixed` descendente. Na
  // árvore normal, o painel ancorava 78px abaixo do topo da janela em vez de em
  // 0, e como a altura continuava sendo h-svh (a altura da JANELA), os últimos
  // 78px vazavam pra fora da tela — levando junto o campo de escrever, sem
  // rolagem que o trouxesse de volta. Ver ModalPortal.
  return (
    <ModalPortal>
    <aside className="fixed right-0 top-0 z-40 flex h-svh w-[min(30rem,100vw)] flex-col border-l border-app-border bg-app-card shadow-card-lg">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-app-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-cyan/10 ring-1 ring-brand-cyan/25">
            <Sparkles size={13} className="text-brand-cyan" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold leading-tight text-white">Montar com IA</h2>
            <p className="truncate text-[10px] leading-tight text-gray-500">
              {focus ? 'Ajustando um widget' : conversationId ? 'Conversa em andamento' : 'Descreva o que quer ver'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {status && status.budgetUsd > 0 && (
            // Gasto do dia como badge discreto: informação de contexto, não o
            // protagonista do cabeçalho — vira alerta só ao estourar.
            <span
              className={cn(
                'rounded-md px-1.5 py-0.5 font-mono text-[10px]',
                overBudget ? 'bg-risk-critical/15 text-risk-critical' : 'bg-app-surface text-gray-500',
              )}
              title={`Gasto de IA hoje e o limite diário por usuário · ${status.provider} · ${status.model}${status.priced ? '' : ' · SEM PREÇO CADASTRADO: o gasto não está sendo somado — ajuste em Configurações › Provedor de IA'}`}
            >
              {status.spentUsd.toFixed(2)}/{status.budgetUsd.toFixed(0)}
              {/* Sem preço cadastrado, o medidor mente por omissão: mostra zero
                  e parece que a IA não custa. O asterisco é o que faz alguém
                  passar o mouse e descobrir. */}
              {!status.priced && <span className="ml-0.5 text-risk-medium" aria-label="sem preço cadastrado">*</span>}
            </span>
          )}
          {(turns.length > 0 || conversationId) && (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              aria-label="Nova conversa"
              title="Nova conversa — apaga esta e começa do zero"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-app-surface hover:text-gray-200"
            >
              <RotateCcw size={13} />
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Fechar"
            title="Fechar — a conversa continua guardada"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-app-surface hover:text-gray-200"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {statusError && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-app-border px-4 py-2 text-[11px] text-risk-critical">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {statusError}
        </p>
      )}
      {status && !status.configured && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-app-border px-4 py-2 text-[11px] text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          IA não configurada — um administrador precisa cadastrar o provedor em <span className="font-medium">Configurações › Provedor de IA</span>.
        </p>
      )}

      <AiSourcePicker
        sources={sources}
        selected={selected}
        onChange={(keys) => setSources(key, keys)}
        conversationActive={!!conversationId || turns.length > 0}
      />

      {focus && (
        <div className="shrink-0 border-b border-app-border bg-brand-cyan/5 px-4 py-2.5">
          <div className="flex items-start gap-2">
            <Wand2 size={13} className="mt-0.5 shrink-0 text-brand-cyan" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-gray-100">
                Ajustando: <span className="text-brand-cyan">“{focus.title}”</span>
              </p>
              <p className="text-[10px] leading-snug text-gray-500">O que você pedir muda este widget, no mesmo lugar da guia — e dá para desfazer.</p>
            </div>
            <button
              type="button"
              onClick={() => { setFocus(key, null); setFocusError(null) }}
              aria-label="Parar de ajustar este widget"
              title="Parar de ajustar este widget — volta a pedir widgets novos"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-app-surface hover:text-gray-200"
            >
              <X size={12} />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {FOCUS_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { setInput(s); inputRef.current?.focus() }}
                disabled={busy || overBudget}
                className="rounded-md border border-app-border/70 bg-app-card px-2 py-1 text-left text-[10px] leading-snug text-gray-300 transition-colors hover:border-brand-cyan/40 hover:text-gray-100 disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
          {focusError && <p className="mt-2 flex items-start gap-1.5 text-[10px] text-risk-critical"><AlertTriangle size={11} className="mt-px shrink-0" /> {focusError}</p>}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {turns.length === 0 && !focus && (
          <div className="space-y-3 pt-1">
            <p className="text-[12px] font-semibold text-gray-100">2. Descreva o que você quer ver</p>
            <p className="text-[11px] leading-relaxed text-gray-400">
              Escreva no campo lá embaixo, ou comece por uma sugestão. A IA usa os campos reais das fontes
              marcadas, e o que ela montar entra <strong className="font-semibold text-gray-200">já salvo</strong> na guia — com "Desfazer".
            </p>
            <div className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Sugestões</span>
              {/* A sugestão vai pro campo, não sai direto: dá tempo de ajustar
                  os passos 3 e 4 antes de enviar. */}
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); inputRef.current?.focus() }}
                  disabled={busy || overBudget}
                  className="group flex w-full items-center gap-2 rounded-lg border border-app-border/70 bg-app-surface/40 px-3 py-2.5 text-left text-[11px] leading-snug text-gray-300 transition-colors hover:border-brand-cyan/40 hover:bg-app-surface hover:text-gray-100 disabled:opacity-40 disabled:hover:border-app-border/70"
                >
                  <span className="min-w-0 flex-1">{s}</span>
                  <Send size={11} className="shrink-0 text-transparent transition-colors group-hover:text-brand-cyan" />
                </button>
              ))}
            </div>
            <div className="border-t border-app-border pt-3">
              <AiRequestOptionsPicker value={chat.options} onChange={(o) => setOptions(key, o)} compact={false} />
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={cn('space-y-2', turn.role === 'user' && 'flex justify-end')}>
            {turn.role === 'user' ? (
              <div className="flex max-w-[85%] flex-col items-end gap-0.5">
                <p className="rounded-xl rounded-br-sm bg-brand-blue/15 px-3 py-2 text-[11px] text-gray-100">{turn.text}</p>
                {turn.focusTitle && <span className="flex items-center gap-1 text-[9px] text-brand-cyan"><Wand2 size={9} /> Ajuste em “{turn.focusTitle}”</span>}
                {turn.options && !turn.focusTitle && <span className="text-[9px] text-gray-500">{optionsSummary(turn.options)}</span>}
              </div>
            ) : (
              <>
                {turn.text && <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-gray-200">{turn.text}</p>}
                {turn.interrupted && (
                  <p className="text-[10px] italic text-gray-500">Resposta interrompida — a conexão caiu ou a página foi recarregada enquanto ela chegava.</p>
                )}
                <AiTurnResult turn={turn} tabLabel={tabLabel} onSave={() => onSaveTurn(i)} onUndo={() => onUndoTurn(i)} />
              </>
            )}
          </div>
        ))}

        {tool && (
          <p className="flex items-center gap-1.5 text-[10px] text-gray-500">
            <Wrench size={10} className="animate-pulse" /> {TOOL_LABEL[tool] ?? tool}…
          </p>
        )}
        {busy && !tool && (
          <p className="flex items-center gap-1.5 text-[10px] text-gray-500"><Loader2 size={10} className="animate-spin" /> pensando…</p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 rounded-lg border border-risk-critical/30 bg-risk-critical/10 px-2.5 py-2 text-[11px] text-risk-critical">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
      </div>

      {turns.length > 0 && !focus && (
        <AiRequestOptionsPicker value={chat.options} onChange={(o) => setOptions(key, o)} compact />
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); send(input) }}
        className={cn('flex shrink-0 items-end gap-2 px-4 py-3', turns.length === 0 && 'border-t border-app-border')}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
          rows={2}
          disabled={!canChat || busy || overBudget}
          placeholder={
            overBudget ? 'Limite de uso de IA de hoje atingido.'
              : canChat && focus ? `O que mudar em “${focus.title}”? (Enter envia)`
              : canChat ? 'O que você quer ver? (Enter envia, Shift+Enter quebra linha)'
                : 'Marque pelo menos uma fonte acima para começar.'
          }
          className="min-h-[2.5rem] flex-1 resize-y rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none placeholder:text-gray-500 focus:border-brand-blue/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canChat || busy || overBudget || !input.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-blue text-white hover:bg-brand-blueLight disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>
    </aside>
    {confirmReset && (
      <ConfirmDialog
        title="Nova conversa"
        message="Apagar esta conversa e começar do zero? O que já foi salvo na dashboard continua lá."
        confirmLabel="Nova conversa"
        onConfirm={startOver}
        onCancel={() => setConfirmReset(false)}
      />
    )}
    </ModalPortal>
  )
}
