import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { useAppStore } from '@/store/appStore'
import { useAuthStore } from '@/store/authStore'
import { useWorkspaceStore } from '@/store/workspaceStore'
import { useHeartbeat } from '@/hooks/useHeartbeat'
import { fetchIsAdmin } from '@/features/access/accessApi'
import { cn } from '@/utils/cn'

// De quanto em quanto tempo o menu de pastas/dashboards confere o servidor:
// dashboard criada, renomeada ou removida por outra pessoa, ou pasta liberada
// para esta pessoa, aparece sem F5. Também confere ao voltar para a aba.
const TREE_POLL_MS = 60_000

// Diferente do HealthyScore, este app não pré-carrega um dataset grande no
// cliente — cada aba busca seus próprios agregados sob demanda (ver
// features/dashboard/tabs/useLazyMetric.ts), então não há gate de carregamento
// global aqui.
export function MainLayout() {
  const { sidebarCollapsed } = useAppStore()
  const setIsAdmin = useAuthStore((s) => s.setIsAdmin)
  const refreshWorkspace = useWorkspaceStore((s) => s.refresh)
  useHeartbeat()

  useEffect(() => {
    let alive = true
    fetchIsAdmin().then((v) => { if (alive) setIsAdmin(v) }).catch(() => {})
    return () => { alive = false }
  }, [setIsAdmin])

  useEffect(() => { refreshWorkspace() }, [refreshWorkspace])

  useEffect(() => {
    const check = () => { if (!document.hidden) void refreshWorkspace({ silent: true }) }
    const id = setInterval(check, TREE_POLL_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [refreshWorkspace])

  return (
    <div className="min-h-screen bg-app-bg text-white">
      <Sidebar />
      <div className={cn('flex flex-col min-h-screen transition-all duration-300', sidebarCollapsed ? 'ml-16' : 'ml-56')}>
        <TopBar />
        <main className="flex-1 p-6 animate-fade-in">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
