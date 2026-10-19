// O que uma resposta da IA entregou — medidas novas, medidas ajustadas e
// widgets — e o que aconteceu com isso. Não há mais "aprovar": a resposta
// entra SALVA sozinha quando termina (ver useAiAutoSave.ts), e o cartão diz
// onde entrou e oferece "Desfazer". Falhou (guia bloqueada, sem permissão),
// diz por quê e oferece "Tentar de novo".
//
// Resposta de antes desta regra (sem `autoSave`) ou cortada no meio (conexão,
// F5) não é salva sozinha: mostra o botão "Salvar na dashboard".
import { AlertTriangle, Check, CheckCircle2, Loader2, Pencil, RotateCcw, Save, Sigma, Undo2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { MeasureDef } from '../types'
import type { ChatTurn } from './aiChatStore'

// Resumo de 1 linha da medida — o suficiente pra reconhecer o que foi criado.
function summarizeMeasure(m: MeasureDef): string {
  const fmtSuffix = m.format === 'percent' ? ' · exibida como %' : ''
  if (m.kind === 'formula') return `${m.expression}${fmtSuffix}`
  const aggLabel: Record<string, string> = { countDistinct: 'Contagem distinta', count: 'Contagem', sum: 'Soma', avg: 'Média' }
  const base = `${aggLabel[m.agg] ?? m.agg}${m.field ? ` de ${m.field}` : ''}`
  const withWindow = m.dateWindow ? `${base} · janela de data` : base
  const withFilter = m.filters?.length ? `${withWindow} · filtro (${m.filters.map((f) => `${f.field} ${f.op === 'in' ? '=' : '≠'} ${f.values.join('/')}`).join(', ')})` : withWindow
  return `${withFilter}${fmtSuffix}`
}

export function hasDelivery(turn: ChatTurn): boolean {
  return !!(turn.proposal?.widgets.length || turn.measureProposal?.measures.length || turn.measureUpdateProposal?.measures.length)
}

export function AiTurnResult({ turn, tabLabel, onSave, onUndo }: {
  turn: ChatTurn
  tabLabel: (tabId: string | undefined) => string | null
  onSave: () => void
  onUndo: () => void
}) {
  if (!hasDelivery(turn) || turn.streaming) return null
  const auto = turn.auto
  const created = turn.measureProposal?.measures ?? []
  const updated = turn.measureUpdateProposal?.measures ?? []
  const widgets = turn.proposal?.widgets ?? []
  const where = tabLabel(auto?.tabId ?? turn.tabId)
  // Resposta de antes desta regra já adicionada ao rascunho por "Adicionar".
  const legacyApplied = !turn.autoSave && !auto
    && (!turn.proposal || turn.proposal.applied) && (!turn.measureProposal || turn.measureProposal.applied)
    && (!turn.measureUpdateProposal || turn.measureUpdateProposal.applied)
  // Marcada pra salvar sozinha e ainda sem resultado: o salvamento está pra
  // começar (useAiAutoSave) — mostra "Salvando…", não um botão que some já.
  const state = auto?.state ?? (turn.autoSave && !turn.interrupted ? 'saving' : legacyApplied ? 'legacy' : 'pending')

  const tone = state === 'failed' ? 'border-risk-critical/40 bg-risk-critical/5'
    : state === 'saved' ? 'border-emerald-500/35 bg-emerald-500/5'
      : 'border-app-border bg-app-surface/40'

  return (
    <div className={cn('rounded-xl border p-3', tone)}>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
        {state === 'saving' && <><Loader2 size={12} className="animate-spin text-brand-blue" /><span className="text-gray-200">Salvando na dashboard…</span></>}
        {state === 'undoing' && <><Loader2 size={12} className="animate-spin text-gray-400" /><span className="text-gray-200">Desfazendo…</span></>}
        {state === 'saved' && (
          <><CheckCircle2 size={13} className="text-emerald-500" />
            <span className="text-gray-100">Salvo{widgets.length && where ? <> na guia <span className="text-emerald-500">“{where}”</span></> : ' na dashboard'}</span></>
        )}
        {state === 'failed' && <><AlertTriangle size={13} className="text-risk-critical" /><span className="text-gray-100">Não foi salvo</span></>}
        {state === 'undone' && <><Undo2 size={12} className="text-gray-500" /><span className="text-gray-400">Desfeito — nada disto ficou na dashboard</span></>}
        {state === 'pending' && <><Save size={12} className="text-gray-400" /><span className="text-gray-300">Ainda não salvo</span></>}
        {state === 'legacy' && <><Check size={12} className="text-gray-400" /><span className="text-gray-300">Adicionado ao rascunho da guia</span></>}
      </div>

      <div className={cn('space-y-2', state === 'undone' && 'opacity-50')}>
        {created.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500"><Sigma size={10} /> {created.length} medida(s) nova(s)</p>
            <ul className="space-y-0.5">
              {created.map((m) => (
                <li key={m.id} className="text-[11px] text-gray-200"><span className="font-semibold">{m.name}</span><span className="text-gray-500"> — {summarizeMeasure(m)}</span></li>
              ))}
            </ul>
          </div>
        )}
        {updated.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500"><Pencil size={10} /> {updated.length} medida(s) ajustada(s)</p>
            <ul className="space-y-0.5">
              {updated.map((m) => (
                <li key={m.id} className="text-[11px] text-gray-200"><span className="font-semibold">{m.name}</span><span className="text-gray-500"> — {summarizeMeasure(m)}</span></li>
              ))}
            </ul>
          </div>
        )}
        {widgets.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">{widgets.length} widget(s)</p>
            <ul className="space-y-0.5">
              {widgets.map((w) => (
                <li key={w.id} className="flex items-baseline gap-1.5 text-[11px] text-gray-200">
                  <span className="shrink-0 rounded bg-app-surface px-1.5 py-0.5 font-mono text-[9px] text-gray-400">{w.type}</span>
                  <span className="min-w-0 truncate">{w.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {auto?.notes?.map((n) => (
        <p key={n} className="mt-2 flex items-start gap-1.5 text-[10px] leading-snug text-risk-high"><AlertTriangle size={11} className="mt-px shrink-0" /> {n}</p>
      ))}
      {auto?.error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-risk-critical"><AlertTriangle size={11} className="mt-0.5 shrink-0" /> {auto.error}</p>
      )}

      {(state === 'saved' || state === 'failed' || state === 'pending') && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {state === 'saved' && (
            <button onClick={onUndo} className="flex items-center gap-1 rounded-lg border border-app-border px-2.5 py-1 text-[11px] font-medium text-gray-300 transition-colors hover:border-risk-critical/50 hover:text-risk-critical">
              <Undo2 size={11} /> Desfazer
            </button>
          )}
          {state === 'failed' && (
            <button onClick={onSave} className="flex items-center gap-1 rounded-lg bg-brand-blue px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-blueLight">
              <RotateCcw size={11} /> Tentar de novo
            </button>
          )}
          {state === 'pending' && (
            <button onClick={onSave} className="flex items-center gap-1 rounded-lg bg-brand-blue px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-blueLight">
              <Save size={11} /> Salvar na dashboard
            </button>
          )}
        </div>
      )}
    </div>
  )
}
