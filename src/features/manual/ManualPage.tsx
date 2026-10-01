// Página "Manual de uso": em cima, a lista de pastas com o pedido de acesso —
// é o que precisa fazer primeiro quem cai aqui sem nada liberado —; embaixo, o
// manual (um PDF — ver /api/manual em server/index.mjs) num leitor de slides.
// É onde cai quem entra pela primeira vez e quem ainda não tem nenhuma
// dashboard liberada (ver DashboardRedirect em src/router/index.tsx); fora
// isso, fica no menu lateral para qualquer um voltar a consultar.
import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useWorkspaceStore } from '@/store/workspaceStore'
import { markManualSeen } from './manualApi'
import { ManualViewer } from './ManualViewer'
import { FolderAccessList } from './FolderAccessList'

function WelcomeBanner({ firstVisit, hasDashboards }: { firstVisit: boolean; hasDashboards: boolean }) {
  const title = firstVisit ? 'Boas-vindas ao Indicadores Sebratel!' : 'Você ainda não tem nenhuma dashboard liberada'
  const text = hasDashboards
    ? 'Suas dashboards ficam no menu lateral, em Dashboards. Mais abaixo está o manual, que mostra como o sistema funciona — ele continua no menu, em Manual de uso.'
    : 'Peça acesso à pasta da sua área na lista abaixo — o pedido vai para o administrador. Mais embaixo, o manual mostra como o sistema funciona.'
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/10 px-5 py-4">
      <Sparkles size={18} className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-100">{title}</p>
        <p className="mt-0.5 text-[12px] text-gray-400">{text}</p>
        <a href="#manual" className="mt-2 inline-block text-[12px] font-semibold text-brand-blue hover:underline">
          Ir para o manual
        </a>
      </div>
    </div>
  )
}

export default function ManualPage() {
  const manualPending = useAuthStore((s) => s.manualPending)
  const setManualPending = useAuthStore((s) => s.setManualPending)
  const folders = useWorkspaceStore((s) => s.folders)
  // Guardado na abertura: o banner de boas-vindas não pode sumir no instante em
  // que o servidor registra que o manual foi visto.
  const [firstVisit] = useState(manualPending)

  useEffect(() => {
    if (!manualPending) return
    markManualSeen().then(() => setManualPending(false)).catch(() => {
      // Sem registro, a pessoa só volta a cair aqui no próximo acesso.
    })
  }, [manualPending, setManualPending])

  const hasDashboards = !!folders?.some((f) => f.dashboards.length > 0)
  const showBanner = firstVisit || (folders !== null && !hasDashboards)

  return (
    <div className="space-y-5 animate-slide-up">
      {showBanner && <WelcomeBanner firstVisit={firstVisit} hasDashboards={hasDashboards} />}
      <FolderAccessList />
      <section id="manual" className="scroll-mt-20">
        <ManualViewer />
      </section>
    </div>
  )
}
