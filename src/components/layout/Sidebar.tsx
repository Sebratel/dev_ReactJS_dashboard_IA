import { useEffect, useState } from 'react'
import { NavLink, useLocation, useParams } from 'react-router-dom'
import { Settings, ShieldCheck, Settings2, Folder, LayoutDashboard, LayoutGrid, ChevronLeft, ChevronRight, ChevronDown, Plus, Zap } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { useAuthStore } from '@/store/authStore'
import { useWorkspaceStore } from '@/store/workspaceStore'
import { FolderSettingsModal } from '@/features/workspace/FolderSettingsModal'
import { cn } from '@/utils/cn'

// As duas telas são de administrador: quem é Padrão não vê nenhuma delas, e a
// rota também barra quem digitar o endereço (ver src/router/index.tsx).
const ADMIN_NAV_ITEMS = [
  { path: '/configuracoes', icon: Settings, label: 'Configurações', sublabel: 'Fontes de dados' },
  { path: '/acessos', icon: ShieldCheck, label: 'Acessos', sublabel: 'Usuários e log de ações' },
]

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useAppStore()
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const folders = useWorkspaceStore((s) => s.folders)
  const location = useLocation()
  const params = useParams<{ folderId?: string }>()
  const [dashboardsOpen, setDashboardsOpen] = useState(true)
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({})
  const [folderModal, setFolderModal] = useState<{ open: boolean; folderId: string | null }>({ open: false, folderId: null })

  // Sempre abre a pasta da dashboard atual — assim navegar por link direto
  // (ou recarregar a página) já mostra o item ativo expandido.
  useEffect(() => {
    if (params.folderId) setOpenFolders((prev) => (prev[params.folderId!] ? prev : { ...prev, [params.folderId!]: true }))
  }, [params.folderId])

  const toggleFolder = (id: string) => setOpenFolders((prev) => ({ ...prev, [id]: !prev[id] }))
  const bottomNavItems = isAdmin ? ADMIN_NAV_ITEMS : []

  return (
    // transition-[width] (não transition-all): "all" tenta transicionar
    // também o background-color, e quando a mudança de cor vem de uma
    // custom property (--app-surface, ao trocar o tema) o Chromium as vezes
    // não recalcula esse valor depois — a barra lateral fica travada na cor
    // antiga do tema anterior até um reload. Só a largura precisa animar.
    <aside className={cn('fixed left-0 top-0 h-full flex flex-col bg-app-surface border-r border-app-border transition-[width] duration-300 z-40', sidebarCollapsed ? 'w-16' : 'w-56')}>
      <div className={cn('flex items-center border-b border-app-border h-14 shrink-0', sidebarCollapsed ? 'justify-center px-0' : 'px-4 gap-3')}>
        <img src="/logo-circular-sebratel.png" alt="Sebratel" className="w-8 h-8 rounded-full shrink-0 ring-1 ring-app-border" />
        {!sidebarCollapsed && (
          <span className="text-sm font-bold text-white uppercase tracking-widest">Sebratel</span>
        )}
      </div>

      <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto scrollbar-thin px-2">
        <button
          type="button"
          onClick={() => setDashboardsOpen((v) => !v)}
          title={sidebarCollapsed ? 'Dashboards' : undefined}
          className={cn(
            'w-full flex items-center gap-3 rounded-2xl transition-colors min-h-[44px] text-white hover:bg-app-surface',
            sidebarCollapsed ? 'justify-center h-11 w-11 mx-auto' : 'px-3 py-2.5',
          )}
        >
          <LayoutDashboard size={16} strokeWidth={2} className="shrink-0 text-primary" />
          {!sidebarCollapsed && (
            <>
              <div className="flex-1 flex flex-col leading-tight min-w-0 text-left">
                <span className="text-xs font-semibold truncate">Dashboards</span>
                <span className="text-[10px] truncate text-gray-500">Pastas e dashboards</span>
              </div>
              {isAdmin && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); setFolderModal({ open: true, folderId: null }) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setFolderModal({ open: true, folderId: null }) } }}
                  title="Nova pasta"
                  className="h-5 w-5 flex items-center justify-center rounded-md text-gray-500 hover:text-brand-blue hover:bg-brand-blue/10 shrink-0"
                >
                  <Plus size={12} />
                </span>
              )}
              <ChevronDown size={13} className={cn('shrink-0 transition-transform', dashboardsOpen && 'rotate-180')} />
            </>
          )}
        </button>

        {dashboardsOpen && (
          <>
            {(folders ?? []).length === 0 && !sidebarCollapsed && (
              <p className="px-3 py-2 text-[10px] text-gray-500">Nenhuma pasta liberada ainda.</p>
            )}
            {(folders ?? []).map((folder) => {
              const isOpen = !!openFolders[folder.id]
              return (
                <div key={folder.id}>
                  <div
                    className={cn(
                      'w-full flex items-center gap-1.5 rounded-2xl transition-colors min-h-[40px] text-white hover:bg-app-surface',
                      sidebarCollapsed ? 'justify-center h-11 w-11 mx-auto' : 'px-3 py-2',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleFolder(folder.id)}
                      title={sidebarCollapsed ? folder.name : undefined}
                      className="flex-1 flex items-center gap-2.5 min-w-0"
                    >
                      <Folder size={15} strokeWidth={2} className="shrink-0 text-primary" />
                      {!sidebarCollapsed && <span className="flex-1 text-left text-xs font-semibold truncate">{folder.name}</span>}
                    </button>
                    {!sidebarCollapsed && folder.canManage && (
                      <button
                        type="button"
                        onClick={() => setFolderModal({ open: true, folderId: folder.id })}
                        title="Configurações da pasta"
                        className="h-5 w-5 flex items-center justify-center rounded-md text-gray-500 hover:text-brand-blue hover:bg-brand-blue/10 shrink-0"
                      >
                        <Settings2 size={12} />
                      </button>
                    )}
                    {!sidebarCollapsed && (
                      <button type="button" onClick={() => toggleFolder(folder.id)} className="shrink-0 text-gray-500">
                        <ChevronDown size={13} className={cn('transition-transform', isOpen && 'rotate-180')} />
                      </button>
                    )}
                  </div>
                  {!sidebarCollapsed && isOpen && (
                    <div className="ml-4 pl-2.5 border-l border-app-border space-y-0.5 py-0.5 mb-0.5">
                      {folder.dashboards.length === 0 && (
                        <p className="px-3 py-1.5 text-[10px] text-gray-600">Sem dashboards ainda.</p>
                      )}
                      {folder.dashboards.map((d) => {
                        const path = `/dashboard/${folder.id}/${d.id}`
                        const isActive = location.pathname === path
                        return (
                          <NavLink
                            key={d.id}
                            to={path}
                            className={cn(
                              'flex items-center gap-2 rounded-xl px-3 py-1.5 text-[11px] font-medium truncate transition-colors',
                              isActive ? 'bg-primary text-white font-bold' : 'text-white hover:bg-app-surface',
                            )}
                          >
                            <LayoutGrid size={12} className="shrink-0" />
                            {d.name}
                          </NavLink>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {bottomNavItems.length > 0 && <div className="h-px bg-app-border my-2 mx-1" />}

        {bottomNavItems.map(({ path, icon: Icon, label, sublabel }) => {
          const isActive = location.pathname.startsWith(path)
          return (
            <NavLink
              key={path}
              to={path}
              title={sidebarCollapsed ? `${label} — ${sublabel}` : undefined}
              className={cn(
                'flex items-center gap-3 rounded-2xl transition-all duration-300 ease-nexa group relative min-h-[44px]',
                sidebarCollapsed ? 'justify-center h-11 w-11 mx-auto' : 'px-3 py-2.5',
                isActive
                  ? 'bg-primary text-white font-bold shadow-lg shadow-primary/20'
                  : 'text-white hover:bg-app-surface'
              )}
            >
              <Icon size={16} strokeWidth={2} className={cn('shrink-0', isActive ? 'text-white' : 'text-primary')} />
              {!sidebarCollapsed && (
                <div className="flex flex-col leading-tight min-w-0">
                  <span className="text-xs font-semibold truncate">{label}</span>
                  <span className={cn('text-[10px] truncate', isActive ? 'text-white/70' : 'text-gray-500')}>{sublabel}</span>
                </div>
              )}
            </NavLink>
          )
        })}
      </nav>

      {!sidebarCollapsed && (
        <div className="mx-3 mb-3 p-2.5 rounded-lg bg-app-card border border-app-border">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-[10px] text-gray-400">Monitoramento ativo</span>
          </div>
          <div className="mt-1 flex items-center gap-1">
            <Zap size={9} className="text-brand-cyan" />
            <span className="text-[10px] text-brand-cyan font-mono">ETL quase em tempo real</span>
          </div>
        </div>
      )}

      <button
        onClick={toggleSidebar}
        className="m-2 flex items-center justify-center h-7 rounded-lg bg-app-card border border-app-border text-gray-500 hover:text-gray-200 hover:border-app-borderLight transition-all"
      >
        {sidebarCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
      </button>

      {folderModal.open && (
        <FolderSettingsModal folderId={folderModal.folderId} onClose={() => setFolderModal({ open: false, folderId: null })} />
      )}
    </aside>
  )
}
