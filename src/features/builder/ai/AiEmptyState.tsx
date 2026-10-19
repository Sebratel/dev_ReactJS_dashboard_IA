// Convite da guia vazia — o primeiro contato de quem abre uma dashboard.
//
// A intenção é inverter a hierarquia da tela: em vez de "clique em + Widget
// para adicionar o primeiro gráfico" (que exige entender fonte, dimensão e
// medida antes de ver qualquer coisa), a guia pergunta o que a pessoa quer
// ver. Montar à mão continua disponível — deixou de ser o caminho principal,
// não deixou de existir.
//
// Só é renderizado quando o painel lateral está FECHADO (ver DashboardBuilder):
// os dois juntos seriam duas entradas para a mesma coisa.
//
// `variant="inline"`: só o campo, as sugestões e o "montar à mão", sem o card
// e o título — é como ele entra na tela de boas-vindas (WelcomePanel.tsx).
import { useEffect, useState } from 'react'
import { Sparkles, ArrowRight, Plus, BarChart3, TrendingUp, LayoutGrid } from 'lucide-react'
import { fetchAiStatus } from './aiApi'

// Sugestões escritas como a pessoa fala, não como o app pensa: nenhuma
// menciona "dimensão", "medida" ou "fonte". O ícone dá uma pista do formato
// do resultado antes de clicar.
const SUGGESTIONS = [
  { icon: LayoutGrid, text: 'Quais são os principais indicadores destes dados?' },
  { icon: TrendingUp, text: 'Analise o churn e identifique onde estão as maiores perdas.' },
  { icon: BarChart3, text: 'Compare o volume por mês e destaque as variações relevantes.' },
]

export function AiEmptyState({ onAsk, onManual, variant = 'card' }: {
  onAsk: (prompt: string) => void
  onManual: () => void
  variant?: 'card' | 'inline'
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

  if (!aiAvailable && variant === 'inline') {
    return (
      <button
        onClick={onManual}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-blue px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-blueLight"
      >
        <Plus size={13} /> Montar o primeiro gráfico
      </button>
    )
  }

  if (!aiAvailable) {
    // Sem IA configurada no servidor, o convite seria uma promessa falsa.
    return (
      <div className="rounded-xl border border-dashed border-app-border px-5 py-14 text-center">
        <p className="text-sm text-gray-400">Esta guia ainda não tem nenhum gráfico.</p>
        <button
          onClick={onManual}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-blue px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-blueLight"
        >
          <Plus size={13} /> Adicionar o primeiro gráfico
        </button>
      </div>
    )
  }

  const form = (
    <>
        <form
          onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAsk(text.trim()) }}
          className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3.5 py-2.5 shadow-sm transition-colors focus-within:border-brand-blue/60"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus={variant === 'card'}
            placeholder="ex.: analise o churn e mostre onde estão as maiores perdas"
            className="min-w-0 flex-1 bg-transparent text-sm text-gray-100 outline-none placeholder:text-gray-500"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            aria-label="Enviar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-blue text-white transition-colors hover:bg-brand-blueLight disabled:opacity-30"
          >
            <ArrowRight size={15} />
          </button>
        </form>

        {/* Sugestões em lista, não em "pílulas": frases inteiras ficam legíveis
            e o alvo de clique é a linha toda, não um texto apertado. */}
        <div className="mt-3 grid gap-1.5">
          {SUGGESTIONS.map(({ icon: Icon, text: s }) => (
            <button
              key={s}
              onClick={() => onAsk(s)}
              className="group flex items-center gap-2.5 rounded-lg border border-app-border/70 bg-app-surface/40 px-3.5 py-2.5 text-left text-[12px] text-gray-300 transition-colors hover:border-brand-cyan/40 hover:bg-app-surface hover:text-gray-100"
            >
              <Icon size={14} className="shrink-0 text-gray-500 transition-colors group-hover:text-brand-cyan" />
              <span className="min-w-0 flex-1">{s}</span>
              <ArrowRight size={13} className="shrink-0 text-transparent transition-colors group-hover:text-brand-cyan" />
            </button>
          ))}
        </div>
    </>
  )

  if (variant === 'inline') {
    return (
      <div>
        {form}
        <button
          onClick={onManual}
          className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:text-gray-300"
        >
          <Plus size={11} /> Prefiro montar o gráfico manualmente
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-app-border bg-app-card px-6 py-12 sm:px-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-7 text-center">
          <span className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-cyan/10 ring-1 ring-brand-cyan/25">
            <Sparkles size={20} className="text-brand-cyan" />
          </span>
          <h2 className="text-lg font-semibold tracking-tight text-white">O que você quer ver nesta tela?</h2>
          <p className="mx-auto mt-1.5 max-w-md text-[12px] leading-relaxed text-gray-400">
            Descreva em português. A IA monta os gráficos com os seus dados e eles já entram salvos
            nesta guia — se não gostar, é só desfazer.
          </p>
        </div>

        {form}

        <div className="mt-7 flex items-center gap-3">
          <span className="h-px flex-1 bg-app-border" />
          <button
            onClick={onManual}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:text-gray-300"
          >
            <Plus size={11} /> Prefiro montar o gráfico manualmente
          </button>
          <span className="h-px flex-1 bg-app-border" />
        </div>
      </div>
    </div>
  )
}
