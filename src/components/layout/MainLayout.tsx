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
