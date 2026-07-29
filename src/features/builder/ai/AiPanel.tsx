// Painel de montagem com IA — conversa lateral no modo edição da guia.
//
// Fluxo: escolher as fontes → conversar → a IA propõe widgets → você aprova.
// Nada é gravado por conta própria: aprovar coloca os widgets no rascunho da
// guia, e ainda depende do "Salvar" da barra de edição, como qualquer edição
// manual. É a mesma regra do resto do Builder, e é deliberada — o modelo pode
// interpretar mal um pedido ambíguo.
//
// Autocontido de propósito: o DashboardBuilder só monta este componente e
// recebe os widgets aprovados por callback, sem herdar estado nenhum da
// conversa (o arquivo já tem 500+ linhas).
import { useEffect, useRef, useState } from 'react'
import { Sparkles, X, Send, Loader2, AlertTriangle, Check, Trash2, Database, Wrench } from 'lucide-react'
import { cn } from '@/utils/cn'
import { getAllSources } from '../fieldCatalog'
import type { WidgetConfig } from '../types'
import { fetchAiStatus, startAiConversation, streamAiTurn, ApiError, type AiStatus } from './aiApi'

interface Turn {
  role: 'user' | 'assistant'
  text: string
  // Proposta anexada a este turno. `applied` marca que já foi para a guia,
  // pra não dar pra aprovar duas vezes o mesmo lote.
  proposal?: { widgets: WidgetConfig[]; summary: string; applied?: boolean }
}

const TOOL_LABEL: Record<string, string> = {
  field_values: 'conferindo os valores reais do campo',
  preview_widget: 'testando o widget contra os dados',
  propose_widgets: 'montando a proposta',
}

const SUGGESTIONS = [
  'Monte uma tela com os principais indicadores desta fonte.',
  'Quais são os 3 gargalos que os dados mostram?',
  'Compare o volume por equipe nos últimos meses.',
]

export function AiPanel({ folderId, onApply, onClose }: {
  folderId: string
  onApply: (widgets: WidgetConfig[]) => void
  onClose: () => void
}) {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [tool, setTool] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const sources = getAllSources()

  // Pré-seleciona quando há poucas fontes: com uma ou duas cadastradas, exigir
  // um clique antes de poder escrever é atrito puro. Com muitas, deixa a
  // escolha — o catálogo de todas subiria no prompt e diluiria o contexto.
  useEffect(() => {
    if (sources.length > 0 && sources.length <= 3) {
      setSelected(new Set(sources.map((s) => s.key)))
    }
  }, [sources.length])

  useEffect(() => {
    let alive = true
    fetchAiStatus()
      .then((s) => { if (alive) setStatus(s) })
      .catch((e) => { if (alive) setStatusError(e instanceof ApiError ? e.message : 'Não foi possível checar a IA.') })
    return () => { alive = false }
  }, [])

  // Mantém a conversa rolada para o fim conforme o texto vai chegando.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, tool])

  const toggleSource = (key: string) => setSelected((prev) => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const send = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true); setError(null); setInput('')
    try {
      let id = conversationId
      if (!id) {
        const started = await startAiConversation(folderId, Array.from(selected))
        id = started.conversationId
        setConversationId(id)
      }
      setTurns((prev) => [...prev, { role: 'user', text }, { role: 'assistant', text: '' }])

      for await (const ev of streamAiTurn(id, text)) {
        if (ev.type === 'text') {
          setTurns((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = { ...last, text: last.text + ev.text }
            return next
          })
        } else if (ev.type === 'tool') {
          setTool(ev.name)
        } else if (ev.type === 'widgets') {
          setTool(null)
          setTurns((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = { ...last, proposal: { widgets: ev.widgets, summary: ev.summary } }
            return next
          })
        } else if (ev.type === 'done') {
          setStatus(ev.usage)
        } else if (ev.type === 'error') {
          setError(ev.message)
        }
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao falar com a IA.')
    } finally {
      setBusy(false); setTool(null)
    }
  }

  const applyProposal = (turnIndex: number) => {
    const proposal = turns[turnIndex]?.proposal
    if (!proposal || proposal.applied) return
    onApply(proposal.widgets)
    setTurns((prev) => prev.map((t, i) => (
      i === turnIndex && t.proposal ? { ...t, proposal: { ...t.proposal, applied: true } } : t
    )))
  }

  const discardProposal = (turnIndex: number) => {
    setTurns((prev) => prev.map((t, i) => (i === turnIndex ? { ...t, proposal: undefined } : t)))
  }

  const overBudget = !!status && status.budgetUsd > 0 && status.spentUsd >= status.budgetUsd
  const canChat = !!conversationId || selected.size > 0

  return (
    <aside className="fixed right-0 top-0 z-40 flex h-svh w-[min(30rem,100vw)] flex-col border-l border-app-border bg-app-card shadow-card-lg">
      <div className="flex items-center justify-between gap-2 border-b border-app-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-brand-cyan" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-white">Montar com IA</h2>
        </div>
        <div className="flex items-center gap-2">
          {status && status.budgetUsd > 0 && (
            <span
              className={cn('font-mono text-[10px]', overBudget ? 'text-risk-critical' : 'text-gray-500')}
              title="Gasto de IA hoje, e o limite diário por usuário (AI_DAILY_BUDGET_USD)"
            >
              US$ {status.spentUsd.toFixed(2)}/{status.budgetUsd.toFixed(2)}
            </span>
          )}
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
        </div>
      </div>

      {statusError && (
        <p className="flex items-start gap-1.5 border-b border-app-border px-4 py-2 text-[11px] text-risk-critical">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {statusError}
        </p>
      )}
      {status && !status.configured && (
        <p className="flex items-start gap-1.5 border-b border-app-border px-4 py-2 text-[11px] text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          IA não configurada no servidor — falta a variável <span className="font-mono">ANTHROPIC_API_KEY</span>.
        </p>
      )}

      {/* Seleção de fontes: trava depois do 1º turno, porque o catálogo faz
          parte do prefixo cacheado da conversa — trocar no meio invalidaria o
          cache e confundiria o modelo. Para trocar, é conversa nova. */}
      <div className="border-b border-app-border px-4 py-3">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Database size={11} className="text-gray-500" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">
            {conversationId ? 'Fontes desta conversa' : 'Fontes que a IA pode usar'}
          </span>
        </div>
        {sources.length === 0 ? (
          <p className="text-[10px] text-gray-500">Nenhuma fonte disponível nesta pasta.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => {
              const on = selected.has(s.key)
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={!!conversationId}
                  onClick={() => toggleSource(s.key)}
                  title={`${s.fields.length} campos`}
                  className={cn(
                    'rounded-lg border px-2 py-1 text-[10px] font-medium transition-colors',
                    on ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400',
                    conversationId ? 'cursor-default opacity-70' : 'hover:border-brand-blue/50',
                  )}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        )}
        <p className="mt-1.5 text-[10px] text-gray-500">
          {conversationId
            ? 'Para mudar as fontes, comece uma conversa nova.'
            : 'Só os NOMES e tipos dos campos vão para a IA — nunca as linhas de dados.'}
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-[11px] text-gray-400">
              Descreva o que você quer ver. A IA monta os widgets usando os campos reais das fontes marcadas e você aprova antes de ir pra guia.
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={!canChat || busy || overBudget}
                className="block w-full rounded-lg border border-dashed border-app-border px-3 py-2 text-left text-[11px] text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={cn('space-y-2', turn.role === 'user' && 'flex justify-end')}>
            {turn.role === 'user' ? (
              <p className="max-w-[85%] rounded-xl rounded-br-sm bg-brand-blue/15 px-3 py-2 text-[11px] text-gray-100">{turn.text}</p>
            ) : (
              <>
                {turn.text && <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-gray-200">{turn.text}</p>}
                {turn.proposal && (
                  <div className="rounded-xl border border-brand-cyan/30 bg-brand-cyan/5 p-3">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-brand-cyan">
                      {turn.proposal.widgets.length} widget(s) propostos
                    </p>
                    <ul className="mb-2.5 space-y-1">
                      {turn.proposal.widgets.map((w) => (
                        <li key={w.id} className="flex items-baseline gap-1.5 text-[11px] text-gray-200">
                          <span className="shrink-0 rounded bg-app-surface px-1.5 py-0.5 font-mono text-[9px] text-gray-400">{w.type}</span>
                          <span className="min-w-0 truncate">{w.title}</span>
                        </li>
                      ))}
                    </ul>
                    {turn.proposal.applied ? (
                      <p className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                        <Check size={11} /> Adicionados à guia — ainda precisa clicar em "Salvar".
                      </p>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => applyProposal(i)}
                          className="flex items-center gap-1 rounded-lg bg-brand-blue px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-blueLight"
                        >
                          <Check size={11} /> Adicionar à guia
                        </button>
                        <button
                          onClick={() => discardProposal(i)}
                          className="flex items-center gap-1 rounded-lg border border-app-border px-2.5 py-1 text-[11px] text-gray-300 hover:border-risk-critical/50 hover:text-risk-critical"
                        >
                          <Trash2 size={11} /> Descartar
                        </button>
                      </div>
                    )}
                  </div>
                )}
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

      <form
        onSubmit={(e) => { e.preventDefault(); send(input) }}
        className="flex items-end gap-2 border-t border-app-border px-4 py-3"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
          rows={2}
          disabled={!canChat || busy || overBudget}
          placeholder={
            overBudget ? 'Limite de uso de IA de hoje atingido.'
              : canChat ? 'O que você quer ver? (Enter envia, Shift+Enter quebra linha)'
                : 'Marque pelo menos uma fonte acima.'
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
  )
}
