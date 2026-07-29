// Convite da guia vazia — o primeiro contato de quem abre uma dashboard nova.
//
// A intenção aqui é inverter a hierarquia da tela: em vez de "clique em
// + Widget para adicionar o primeiro gráfico" (que exige entender fonte,
// dimensão e medida antes de ver qualquer coisa), a guia vazia pergunta o que
// a pessoa quer ver. Montar à mão continua disponível no botão de sempre —
// deixou de ser o caminho principal, não deixou de existir.
import { useEffect, useState } from 'react'
import { Sparkles, ArrowRight, Plus } from 'lucide-react'
import { fetchAiStatus } from './aiApi'

// Sugestões escritas como a pessoa fala, não como o app pensa: nenhuma
// menciona "dimensão", "medida" ou "fonte".
const SUGGESTIONS = [
  'Quais são os principais indicadores destes dados?',
  'Analise o churn e me mostre onde estão os problemas.',
  'Compare o volume por mês e destaque o que mudou.',
  'Monte uma visão executiva com 4 números e 2 gráficos.',
]

export function AiEmptyState({ onAsk, onManual }: {
  onAsk: (prompt: string) => void
  onManual: () => void
}) {
  const [text, setText] = useState('')
  // Checa o status por conta própria pra não engordar o DashboardBuilder com
  // mais um estado — e enquanto não sabe, mostra o convite (o caminho comum é
  // a IA estar configurada; piscar o texto de fallback seria pior).
  const [aiAvailable, setAiAvailable] = useState(true)

  useEffect(() => {
    let alive = true
    fetchAiStatus()
      .then((s) => { if (alive) setAiAvailable(s.configured) })
      .catch(() => { if (alive) setAiAvailable(false) })
    return () => { alive = false }
  }, [])

  if (!aiAvailable) {
    // Sem IA configurada no servidor, o convite seria uma promessa falsa.
    return (
      <div className="rounded-xl border border-dashed border-app-border px-5 py-16 text-center text-sm text-gray-500">
        Guia vazia.{' '}
        <button onClick={onManual} className="font-semibold text-brand-blue hover:underline">
          Adicione o primeiro gráfico
        </button>
        .
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-app-border bg-app-card px-6 py-10 sm:px-10 sm:py-14">
      <div className="mx-auto max-w-xl space-y-5">
        <div className="space-y-1.5 text-center">
          <div className="flex items-center justify-center gap-2">
            <Sparkles size={18} className="text-brand-cyan" />
            <h2 className="text-base font-bold text-white">O que você quer ver nesta tela?</h2>
          </div>
          <p className="text-[12px] text-gray-400">
            Descreva em português. A IA monta os gráficos com os seus dados e você aprova antes de aplicar.
          </p>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAsk(text.trim()) }}
          className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2 focus-within:border-brand-blue/50"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            placeholder="ex.: analise o churn e mostre onde estão os problemas"
            className="flex-1 bg-transparent text-sm text-gray-200 placeholder:text-gray-500 outline-none"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-blue text-white hover:bg-brand-blueLight disabled:opacity-40"
          >
            <ArrowRight size={15} />
          </button>
        </form>

        <div className="flex flex-wrap justify-center gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onAsk(s)}
              className="rounded-full border border-app-border px-3 py-1.5 text-[11px] text-gray-300 transition-colors hover:border-brand-cyan/50 hover:text-brand-cyan"
            >
              {s}
            </button>
          ))}
        </div>

        <p className="pt-1 text-center text-[11px] text-gray-500">
          Prefere montar você mesmo?{' '}
          <button onClick={onManual} className="inline-flex items-center gap-1 font-semibold text-gray-300 hover:text-brand-blue">
            <Plus size={11} /> Adicionar gráfico manualmente
          </button>
        </p>
      </div>
    </div>
  )
}
