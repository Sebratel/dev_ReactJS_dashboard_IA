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
//
// A conversa em si não mora aqui: fica em aiChatStore.ts, uma por dashboard,
// durante a sessão. Fechar o painel não apaga nada — e uma resposta em
// andamento continua chegando com ele fechado.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, X, Send, Loader2, AlertTriangle, Check, Trash2, Database, Wrench, ChevronDown, Sigma, Pencil, RotateCcw } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { getAllSources } from '../fieldCatalog'
import type { MeasureDef, WidgetConfig } from '../types'
import { fetchAiStatus, ApiError } from './aiApi'
import { useAiChatStore, chatKey, EMPTY_CHAT, type ProposalKind } from './aiChatStore'

const TOOL_LABEL: Record<string, string> = {
  field_values: 'conferindo os valores reais do campo',
  preview_widget: 'testando o widget contra os dados',
  propose_widgets: 'montando a proposta',
  preview_measure: 'conferindo o cálculo contra os dados',
  propose_measures: 'montando a medida',
  update_measures: 'atualizando a medida',
}

// Resumo de 1 linha pra tela de aprovação — não precisa ser tão completo
// quanto o rótulo real do MeasureWell (que já sabe formatar agg/campo em
// português); aqui é só o suficiente pra reconhecer o que foi proposto.
function summarizeMeasure(m: MeasureDef): string {
  const fmtSuffix = m.format === 'percent' ? ' · exibida como %' : ''
  if (m.kind === 'formula') return `${m.expression}${fmtSuffix}`
  const aggLabel: Record<string, string> = { countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média' }
  const base = `${aggLabel[m.agg] ?? m.agg}${m.field ? ` de ${m.field}` : ''}`
  const withWindow = m.dateWindow ? `${base} · janela de data` : base
  const withFilter = m.filters?.length ? `${withWindow} · filtro (${m.filters.map((f) => `${f.field} ${f.op === 'in' ? '=' : '≠'} ${f.values.join('/')}`).join(', ')})` : withWindow
  return `${withFilter}${fmtSuffix}`
}

// Mesmas frases do convite da guia vazia (ai/AiEmptyState.tsx): a pessoa que
// clicou no botão "IA" vindo de lá deve reconhecer as opções.
const SUGGESTIONS = [
  'Quais são os principais indicadores destes dados?',
  'Analise o churn e identifique onde estão as maiores perdas.',
  'Compare o volume por mês e destaque as variações relevantes.',
]

export function AiPanel({ folderId, dashboardId, initialPrompt, dashboardMeasures, onApply, onApplyMeasures, onApplyMeasureUpdates, onClose }: {
  folderId: string
  // Cada dashboard tem a sua conversa (ver aiChatStore.ts).
  dashboardId: string
  // Pergunta já digitada no convite da guia vazia (ver AiEmptyState): o painel
  // abre e manda sozinho, pra pessoa não precisar escrever duas vezes.
  initialPrompt?: string
  // Medidas JÁ existentes no rascunho da dashboard (salvas ou não) — mandadas
  // a cada turno, pra IA saber o que já existe e poder referenciar por nome
  // numa fórmula nova (ver measuresText, server/aiAssistant.mjs).
  dashboardMeasures: MeasureDef[]
  onApply: (widgets: WidgetConfig[]) => void
  onApplyMeasures: (measures: MeasureDef[]) => void
  // Aprovar uma atualização (update_measures) faz UPSERT por id no rascunho
  // — diferente de onApplyMeasures, que sempre ACRESCENTA (medida nova).
  onApplyMeasureUpdates: (measures: MeasureDef[]) => void
  onClose: () => void
}) {
  const key = chatKey(folderId, dashboardId)
  const chat = useAiChatStore((s) => s.chats[key]) ?? EMPTY_CHAT
  const status = useAiChatStore((s) => s.status)
  const { setStatus, setSources, send: sendTurn, markApplied, discard, reset } = useAiChatStore.getState()
  const { conversationId, turns, busy, tool, error } = chat
  const [statusError, setStatusError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  // Aberto enquanto ninguém falou nada (é quando a escolha importa); recolhe
  // sozinho no 1º turno, quando a seleção trava e vira só referência.
  const [sourcesOpen, setSourcesOpen] = useState(!conversationId)
  const scrollRef = useRef<HTMLDivElement>(null)

  const sources = getAllSources()
  const selected = useMemo(() => new Set(chat.sourceKeys ?? []), [chat.sourceKeys])

  // Pré-seleciona quando há poucas fontes e ninguém escolheu ainda: com uma ou
  // duas cadastradas, exigir um clique antes de poder escrever é atrito puro.
  // Com muitas, deixa a escolha — o catálogo de todas subiria no prompt e
  // diluiria o contexto.
  useEffect(() => {
    if (conversationId || chat.sourceKeys !== null) return
    if (sources.length > 0 && sources.length <= 3) setSources(key, sources.map((s) => s.key))
  }, [sources.length, conversationId, chat.sourceKeys, key, setSources])

  useEffect(() => { if (conversationId) setSourcesOpen(false) }, [conversationId])

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

  const toggleSource = (sourceKey: string) => {
    const next = new Set(selected)
    next.has(sourceKey) ? next.delete(sourceKey) : next.add(sourceKey)
    setSources(key, Array.from(next))
  }

  const send = (text: string) => {
    if (!text.trim() || busy) return
    setInput('')
    void sendTurn({ key, folderId, text, dashboardMeasures })
  }

  const overBudget = !!status && status.budgetUsd > 0 && status.spentUsd >= status.budgetUsd

  // Dispara a pergunta vinda do convite da guia vazia, uma única vez. O ref é
  // o que garante "uma vez": em desenvolvimento o React monta o componente
  // duas vezes, e sem isso o turno sairia duplicado — e cobrado duas vezes.
  // Com conversa já aberta nesta dashboard, a pergunta entra como o próximo
  // pedido dela.
  const autoSent = useRef(false)
  useEffect(() => {
    if (autoSent.current || !initialPrompt || selected.size === 0 || overBudget) return
    autoSent.current = true
    send(initialPrompt)
    // `send` é recriada a cada render; o guard acima é o que controla o efeito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, selected.size, overBudget])

  const applyProposal = (turnIndex: number) => {
    const proposal = turns[turnIndex]?.proposal
    if (!proposal || proposal.applied) return
    onApply(proposal.widgets)
    markApplied(key, turnIndex, 'proposal')
  }

  const applyMeasuresProposal = (turnIndex: number) => {
    const proposal = turns[turnIndex]?.measureProposal
    if (!proposal || proposal.applied) return
    onApplyMeasures(proposal.measures)
    markApplied(key, turnIndex, 'measureProposal')
  }

  const applyMeasureUpdatesProposal = (turnIndex: number) => {
    const proposal = turns[turnIndex]?.measureUpdateProposal
    if (!proposal || proposal.applied) return
    onApplyMeasureUpdates(proposal.measures)
    markApplied(key, turnIndex, 'measureUpdateProposal')
  }

  const discardKind = (kind: ProposalKind) => (turnIndex: number) => discard(key, turnIndex, kind)
  const discardProposal = discardKind('proposal')
  const discardMeasuresProposal = discardKind('measureProposal')
  const discardMeasureUpdatesProposal = discardKind('measureUpdateProposal')

  // "Nova conversa": o único jeito de zerar agora que fechar o painel não zera
  // mais — e o caminho para trocar as fontes, que travam no 1º turno.
  const startOver = () => {
    setConfirmReset(false)
    reset(key)
    setSourcesOpen(true)
  }

  const canChat = !!conversationId || selected.size > 0

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
              {conversationId ? 'Conversa em andamento' : 'Descreva o que quer ver'}
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

      {/* Seleção de fontes: trava depois do 1º turno, porque o catálogo faz
          parte do prefixo cacheado da conversa — trocar no meio invalidaria o
          cache e confundiria o modelo. Para trocar, é conversa nova.

          Por isso ele se recolhe sozinho quando a conversa começa: vira um
          resumo de uma linha. Aberto, com várias fontes cadastradas, esse
          bloco come mais de 100px de altura permanentes de um painel que
          precisa desse espaço pra conversa — e depois do 1º turno não há mais
          nada a decidir ali. */}
      <div className="shrink-0 border-b border-app-border bg-app-surface/30 px-4 py-3">
        <div className="flex items-center gap-1.5">
          <Database size={11} className="shrink-0 text-gray-500" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            {conversationId ? 'Fontes desta conversa' : 'Dados que a IA pode usar'}
          </span>
          {conversationId && (
            <button
              type="button"
              onClick={() => setSourcesOpen((v) => !v)}
              className="ml-auto flex items-center gap-1 text-[10px] text-gray-500 transition-colors hover:text-gray-300"
            >
              {sourcesOpen ? 'ocultar' : `${selected.size} selecionada${selected.size === 1 ? '' : 's'}`}
              <ChevronDown size={11} className={cn('transition-transform', sourcesOpen && 'rotate-180')} />
            </button>
          )}
        </div>
        {!sourcesOpen ? (
          <p className="mt-1.5 truncate text-[11px] text-gray-400" title={sources.filter((s) => selected.has(s.key)).map((s) => s.label).join(', ')}>
            {sources.filter((s) => selected.has(s.key)).map((s) => s.label).join(', ') || '—'}
          </p>
        ) : (
        <div className="mt-2">
        {sources.length === 0 ? (
          <p className="text-[11px] text-gray-500">Nenhuma fonte disponível nesta pasta.</p>
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
                  title={`${s.fields.length} campos disponíveis`}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    on
                      ? 'border-brand-blue/60 bg-brand-blue/10 text-brand-blue'
                      : 'border-app-border text-gray-400',
                    conversationId ? 'cursor-default' : 'hover:border-brand-blue/50 hover:text-gray-200',
                  )}
                >
                  {/* Marca de seleção explícita: com uma fonte só pré-marcada,
                      a cor sozinha não deixava claro que era um estado. */}
                  <span className={cn(
                    'flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
                    on ? 'border-brand-blue bg-brand-blue text-white' : 'border-app-borderLight',
                  )}
                  >
                    {on && <Check size={9} strokeWidth={3} />}
                  </span>
                  {s.label}
                </button>
              )
            })}
          </div>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-gray-500">
          {conversationId
            ? 'Para trocar as fontes, comece uma conversa nova (↺ no topo do painel).'
            : 'Só os nomes e os tipos dos campos vão para a IA — nunca as linhas de dados.'}
        </p>
        </div>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {turns.length === 0 && (
          <div className="space-y-3 pt-1">
            <p className="text-[11px] leading-relaxed text-gray-400">
              Descreva o que você precisa visualizar. A IA usa os campos reais das fontes marcadas
              e apresenta a proposta para aprovação antes de aplicar na guia.
            </p>
            <div className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Sugestões</span>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={!canChat || busy || overBudget}
                  className="group flex w-full items-center gap-2 rounded-lg border border-app-border/70 bg-app-surface/40 px-3 py-2.5 text-left text-[11px] leading-snug text-gray-300 transition-colors hover:border-brand-cyan/40 hover:bg-app-surface hover:text-gray-100 disabled:opacity-40 disabled:hover:border-app-border/70"
                >
                  <span className="min-w-0 flex-1">{s}</span>
                  <Send size={11} className="shrink-0 text-transparent transition-colors group-hover:text-brand-cyan" />
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={cn('space-y-2', turn.role === 'user' && 'flex justify-end')}>
            {turn.role === 'user' ? (
              <p className="max-w-[85%] rounded-xl rounded-br-sm bg-brand-blue/15 px-3 py-2 text-[11px] text-gray-100">{turn.text}</p>
            ) : (
              <>
                {turn.text && <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-gray-200">{turn.text}</p>}
                {turn.interrupted && (
                  <p className="text-[10px] italic text-gray-500">Resposta interrompida — a conexão caiu ou a página foi recarregada enquanto ela chegava.</p>
                )}
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
                {turn.measureProposal && (
                  <div className="rounded-xl border border-brand-cyan/30 bg-brand-cyan/5 p-3">
                    <p className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-brand-cyan">
                      <Sigma size={11} /> {turn.measureProposal.measures.length} medida(s) proposta(s)
                    </p>
                    <ul className="mb-2.5 space-y-1">
                      {turn.measureProposal.measures.map((m) => (
                        <li key={m.id} className="text-[11px] text-gray-200">
                          <span className="font-semibold">{m.name}</span>
                          <span className="text-gray-500"> — {summarizeMeasure(m)}</span>
                        </li>
                      ))}
                    </ul>
                    {turn.measureProposal.applied ? (
                      <p className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                        <Check size={11} /> Adicionadas à tabela de medidas — ainda precisa clicar em "Salvar".
                      </p>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => applyMeasuresProposal(i)}
                          className="flex items-center gap-1 rounded-lg bg-brand-blue px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-blueLight"
                        >
                          <Check size={11} /> Adicionar à tabela de medidas
                        </button>
                        <button
                          onClick={() => discardMeasuresProposal(i)}
                          className="flex items-center gap-1 rounded-lg border border-app-border px-2.5 py-1 text-[11px] text-gray-300 hover:border-risk-critical/50 hover:text-risk-critical"
                        >
                          <Trash2 size={11} /> Descartar
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {turn.measureUpdateProposal && (
                  <div className="rounded-xl border border-brand-cyan/30 bg-brand-cyan/5 p-3">
                    <p className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-brand-cyan">
                      <Pencil size={11} /> {turn.measureUpdateProposal.measures.length} medida(s) atualizada(s)
                    </p>
                    <ul className="mb-2.5 space-y-1">
                      {turn.measureUpdateProposal.measures.map((m) => (
                        <li key={m.id} className="text-[11px] text-gray-200">
                          <span className="font-semibold">{m.name}</span>
                          <span className="text-gray-500"> — {summarizeMeasure(m)}</span>
                        </li>
                      ))}
                    </ul>
                    {turn.measureUpdateProposal.applied ? (
                      <p className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                        <Check size={11} /> Atualizadas na tabela de medidas — ainda precisa clicar em "Salvar".
                      </p>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => applyMeasureUpdatesProposal(i)}
                          className="flex items-center gap-1 rounded-lg bg-brand-blue px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-blueLight"
                        >
                          <Check size={11} /> Atualizar na tabela de medidas
                        </button>
                        <button
                          onClick={() => discardMeasureUpdatesProposal(i)}
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
        className="flex shrink-0 items-end gap-2 border-t border-app-border px-4 py-3"
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
    {confirmReset && (
      <ConfirmDialog
        title="Nova conversa"
        message="Apagar esta conversa e começar do zero? O que já foi adicionado à guia continua lá."
        confirmLabel="Nova conversa"
        onConfirm={startOver}
        onCancel={() => setConfirmReset(false)}
      />
    )}
    </ModalPortal>
  )
}
