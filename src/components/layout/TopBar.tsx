import { Settings, LogOut, Sun, Moon } from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useAppStore } from '@/store/appStore'
import { useWorkspaceStore } from '@/store/workspaceStore'
import { logout as endSession } from '@/store/authSession'

const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  '/configuracoes': { title: 'Configurações', subtitle: 'Fontes de dados e dicionário' },
  '/acessos': { title: 'Acessos', subtitle: 'Usuários, status online e log de ações' },
}

export function TopBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams<{ folderId?: string; dashboardId?: string }>()
  const folders = useWorkspaceStore((s) => s.folders)
  const user = useAuthStore((s) => s.user)
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  // Sair de verdade: destrói a sessão no servidor e apaga o cookie — não basta
  // limpar o estado local, que era tudo o que o fluxo antigo conseguia fazer.
  const handleLogout = () => {
    endSession().finally(() => navigate('/login', { replace: true }))
  }

  let page = PAGE_TITLES[location.pathname] ?? { title: 'Indicadores Sebratel', subtitle: '' }
  if (params.folderId && params.dashboardId) {
    const folder = folders?.find((f) => f.id === params.folderId)
    const dashboard = folder?.dashboards.find((d) => d.id === params.dashboardId)
    if (folder && dashboard) page = { title: dashboard.name, subtitle: folder.name }
  }

  return (
    <header className="h-14 flex items-center justify-between px-6 border-b border-app-border bg-app-surface/90 backdrop-blur-sm sticky top-0 z-30">
      <div className="flex flex-col leading-tight">
        <h1 className="text-sm font-semibold text-white">{page.title}</h1>
        {page.subtitle && <p className="text-[11px] text-gray-500">{page.subtitle}</p>}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="h-7 w-7 flex items-center justify-center rounded-lg bg-app-card border border-app-border text-gray-400 hover:text-gray-100 hover:border-app-borderLight transition-all"
          title={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
          aria-label={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
        >
          {theme === 'dark' ? <Moon size={13} /> : <Sun size={13} />}
        </button>
        {/* Mesmo critério da barra lateral: Configurações é tela de admin. */}
        {isAdmin && (
          <button onClick={() => navigate('/configuracoes')} className="h-7 w-7 flex items-center justify-center rounded-lg bg-app-card border border-app-border text-gray-400 hover:text-gray-100 hover:border-app-borderLight transition-all" aria-label="Configurações">
            <Settings size={13} />
          </button>
        )}

        <div className="flex items-center gap-2 h-7 pl-1 pr-1 rounded-lg bg-app-card border border-app-border">
          {user?.picture ? (
            <img src={user.picture} alt="" className="w-5 h-5 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-5 h-5 rounded-full bg-gradient-brand flex items-center justify-center text-[10px] font-bold text-white">
              {(user?.name ?? 'U')[0].toUpperCase()}
            </div>
          )}
          <span className="text-xs text-white hidden md:block max-w-[120px] truncate">{user?.name ?? 'Usuário'}</span>
          <button
            onClick={handleLogout}
            title="Sair"
            aria-label="Sair"
            className="h-6 w-6 flex items-center justify-center rounded-md text-gray-500 hover:text-risk-critical hover:bg-risk-critical/10 transition-all"
          >
            <LogOut size={13} />
          </button>
        </div>
      </div>
    </header>
  )
}
