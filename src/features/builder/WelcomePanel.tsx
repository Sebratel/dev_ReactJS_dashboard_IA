// A guia de boas-vindas de toda dashboard. Era um card de texto do tamanho da
// tela, com nove seções em caixa alta — ninguém lia. Agora é uma tela de
// entrada:
//   - quem pode montar telas: o pedido à IA logo de cara (com os 3 passos do
//     que acontece), e as guias da dashboard pra ir direto;
//   - quem só vê: as guias e como ler a tela.
// O texto antigo continua salvo como widget (ver isStockWelcomeWidget em
// defaultConfig.ts), só não é mais desenhado.
import { Link } from 'react-router-dom'
import {
  ArrowRight, BookOpen, CheckCircle2, Database, Filter, LayoutDashboard, Lock, MessageSquareText, MousePointerClick, Sparkles,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import type { TabLockInfo } from '@/features/workspace/types'
import { AiEmptyState } from './ai/AiEmptyState'

export interface WelcomeTabLink {
  id: string
  label: string
  widgetCount: number
  lock: TabLockInfo | null
}

const EDITOR_STEPS = [
  { icon: Database, title: 'Escolha os dados', text: 'Marque as fontes liberadas para esta pasta. Dá para trocar no meio da conversa.' },
  { icon: MessageSquareText, title: 'Peça em português', text: 'Como você pediria a um colega: “compare o volume por mês e destaque as variações”.' },
  { icon: CheckCircle2, title: 'Já fica salvo', text: 'Medidas e gráficos entram salvos numa guia nova. Não gostou? Um clique desfaz.' },
]

const VIEWER_STEPS = [
  { icon: LayoutDashboard, title: 'Abra uma guia', text: 'Cada guia é uma tela da dashboard — escolha acima ou na barra de guias.' },
  { icon: Filter, title: 'Filtre', text: 'Os filtros no topo da guia valem para todos os gráficos dela.' },
  { icon: MousePointerClick, title: 'Entenda o gráfico', text: 'No canto de cada gráfico, peça a leitura do que os números mostram.' },
]

export function WelcomePanel({ dashboardName, userName, tabs, canEdit, showAsk, onAsk, onManual, onOpenTab }: {
  dashboardName: string
  userName: string | null
  // Guias que a pessoa enxerga (sem a de boas-vindas).
  tabs: WelcomeTabLink[]
  // Pode montar telas nesta dashboard (quem gerencia a pasta).
  canEdit: boolean
  // O pedido à IA aparece aqui — fica de fora com o painel da IA já aberto.
  showAsk: boolean
  onAsk: (prompt: string) => void
  onManual: () => void
  onOpenTab: (tabId: string) => void
}) {
  const firstName = (userName ?? '').trim().split(/\s+/)[0]
  const steps = canEdit ? EDITOR_STEPS : VIEWER_STEPS

  return (
    <section className="space-y-5">
      <div className="relative overflow-clip rounded-2xl border border-app-border bg-app-card shadow-card">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-28 h-72 w-72 rounded-full bg-brand-blue/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-36 left-1/4 h-64 w-64 rounded-full bg-brand-violet/10 blur-3xl" />
        <div className={cn('relative grid gap-6 p-6 sm:p-8', showAsk && 'lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-10')}>
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-blue/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-brand-cyan">
              <Sparkles size={11} /> Boas-vindas
            </span>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-gray-100 sm:text-[28px] sm:leading-tight">
              {firstName ? `Olá, ${firstName}!` : 'Olá!'}
            </h1>
            <p className="mt-1 text-[13px] text-gray-400">
              Você está em <span className="font-semibold text-gray-200">{dashboardName}</span>.
            </p>
            <p className="mt-4 max-w-lg text-[14px] leading-relaxed text-gray-300">
              {canEdit
                ? 'Diga o que você quer acompanhar e a IA monta os indicadores com os dados liberados para esta pasta — já salvos, prontos para a equipe.'
                : 'Aqui ficam os indicadores da sua área. Escolha uma guia abaixo para começar.'}
            </p>
            {canEdit && !showAsk && (
              <p className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand-cyan/10 px-3 py-1.5 text-[12px] text-gray-300">
                <Sparkles size={12} className="text-brand-cyan" /> A conversa com a IA está aberta ao lado.
              </p>
            )}
            {!canEdit && (
              <p className="mt-4 text-[12px] text-gray-500">
                Quer montar uma tela? Peça edição ao gerente da pasta.
              </p>
            )}
          </div>
          {showAsk && <AiEmptyState variant="inline" onAsk={onAsk} onManual={onManual} />}
        </div>
      </div>

      <div>
        <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Guias desta dashboard</h2>
        {tabs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-app-border px-4 py-5 text-[12px] text-gray-500">
            {canEdit
              ? 'Ainda não há guias. Faça o primeiro pedido acima — a IA cria uma guia nova para ele.'
              : 'Ainda não há guias liberadas para você nesta dashboard.'}
          </p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => onOpenTab(t.id)}
                className="group flex items-center gap-3 rounded-xl border border-app-border bg-app-card px-4 py-3 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-brand-blue/50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-app-surface text-gray-400 transition-colors group-hover:bg-brand-blue/15 group-hover:text-brand-blue">
                  <LayoutDashboard size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-gray-100">{t.label}</span>
                  <span className="flex items-center gap-1 text-[11px] text-gray-500">
                    {t.widgetCount > 0 ? `${t.widgetCount} ${t.widgetCount === 1 ? 'gráfico' : 'gráficos'}` : 'ainda vazia'}
                    {t.lock && (
                      <span className="inline-flex min-w-0 items-center gap-1 text-risk-high">
                        · <Lock size={10} className="shrink-0" /> <span className="truncate">{t.lock.self ? 'você está editando' : `${t.lock.name} editando`}</span>
                      </span>
                    )}
                  </span>
                </span>
                <ArrowRight size={14} className="shrink-0 text-gray-500 transition-colors group-hover:text-brand-blue" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, text }, i) => (
          <div key={title} className="flex gap-3 rounded-xl border border-app-border bg-app-card/60 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-blue/15 text-brand-blue">
              <Icon size={15} />
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-gray-100"><span className="text-gray-500">{i + 1}.</span> {title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-400">{text}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-gray-500">
        Cada guia tem o próprio acesso — guias novas ficam restritas até o gerente da pasta liberar em “Abas”.
        <Link to="/manual" className="inline-flex items-center gap-1 font-medium text-gray-400 hover:text-brand-blue">
          <BookOpen size={11} /> Manual de uso
        </Link>
      </p>
    </section>
  )
}
