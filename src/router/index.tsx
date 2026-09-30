import { lazy, Suspense, useEffect } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { MainLayout } from '@/components/layout/MainLayout'
import { SkeletonCard } from '@/components/ui/SkeletonCard'
import { useAuthStore } from '@/store/authStore'
import { useWorkspaceStore } from '@/store/workspaceStore'

const LoginPage = lazy(() => import('@/features/auth/LoginPage'))
const DashboardPage = lazy(() => import('@/features/dashboard/DashboardPage'))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'))
const AccessPage = lazy(() => import('@/features/access/AccessPage'))

function PageLoader() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <SkeletonCard key={i} />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => <SkeletonCard key={i} />)}
      </div>
    </div>
  )
}

function PageSuspense({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>
}

// Tela neutra enquanto a sessão é verificada no servidor — dura um round-trip.
// Não usa o PageLoader (esqueleto de dashboard) porque aqui ainda não se sabe
// nem se existe usuário.
function SessionCheck() {
  return (
    <div className="min-h-svh flex items-center justify-center bg-app-bg">
      <span className="text-xs text-gray-500">Verificando sessão…</span>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const ready = useAuthStore((s) => s.ready)
  // `ready` false = GET /api/auth/me ainda não respondeu. Sem esse gate, um F5
  // numa sessão válida mandaria pro /login antes da resposta chegar.
  if (!ready) return <SessionCheck />
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

// isAdmin só é confirmado depois de um round-trip ao backend (ver
// MainLayout.tsx) — a checagem real de segurança é sempre no servidor
// (requireAdmin() em server/index.mjs); isto aqui é só a UX de esconder a
// rota de quem não tem permissão.
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const isAdmin = useAuthStore((s) => s.isAdmin)
  if (!isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

function LoginRoute() {
  const user = useAuthStore((s) => s.user)
  const ready = useAuthStore((s) => s.ready)
  if (!ready) return <SessionCheck />
  if (user) return <Navigate to="/" replace />
  return <Suspense fallback={<SessionCheck />}><LoginPage /></Suspense>
}

// `/` sozinho não é mais uma página própria — redireciona pra 1ª dashboard
// que o usuário pode ver (primeira pasta, primeira dashboard dela, ambas
// ordenadas). Sem nenhuma pasta/dashboard liberada, mostra um estado vazio
// em vez de tentar navegar pra algo que não existe.
function DashboardRedirect() {
  const folders = useWorkspaceStore((s) => s.folders)
  const loading = useWorkspaceStore((s) => s.loading)
  const error = useWorkspaceStore((s) => s.error)
  const refresh = useWorkspaceStore((s) => s.refresh)

  useEffect(() => { if (!folders && !loading && !error) refresh() }, [folders, loading, error, refresh])

  if (error) {
    return <p className="text-sm text-rose-300 rounded-xl border border-app-border bg-app-card px-5 py-16 text-center">{error}</p>
  }
  if (!folders || loading) return <PageLoader />

  const firstWithDashboard = folders.find((f) => f.dashboards.length > 0)
  if (!firstWithDashboard) {
    return (
      <p className="text-sm text-gray-400 rounded-xl border border-dashed border-app-border px-5 py-16 text-center">
        Nenhuma dashboard disponível ainda — peça acesso a um administrador.
      </p>
    )
  }
  return <Navigate to={`/dashboard/${firstWithDashboard.id}/${firstWithDashboard.dashboards[0].id}`} replace />
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute /> },
  {
    path: '/',
    element: <RequireAuth><MainLayout /></RequireAuth>,
    children: [
      { index: true, element: <DashboardRedirect /> },
      { path: 'dashboard/:folderId/:dashboardId', element: <PageSuspense><DashboardPage /></PageSuspense> },
      { path: 'configuracoes', element: <RequireAdmin><PageSuspense><SettingsPage /></PageSuspense></RequireAdmin> },
      { path: 'acessos', element: <RequireAdmin><PageSuspense><AccessPage /></PageSuspense></RequireAdmin> },
    ],
  },
])
