import { useParams } from 'react-router-dom'
import { DashboardBuilder } from '@/features/builder/DashboardBuilder'

// A URL carrega qual pasta/dashboard mostrar (ver src/router/index.tsx) — a
// `key` força um remount completo do Builder ao trocar de dashboard, o jeito
// mais simples de resetar todo o estado interno (aba ativa, rascunhos, modo
// edição) sem precisar de um monte de useEffect de reset manual.
export default function DashboardPage() {
  const { folderId, dashboardId } = useParams<{ folderId: string; dashboardId: string }>()
  if (!folderId || !dashboardId) return null
  return <DashboardBuilder key={`${folderId}/${dashboardId}`} folderId={folderId} dashboardId={dashboardId} />
}
