// Configurações de UMA pasta — aberto pelo botão de engrenagem ao lado da
// pasta no menu lateral (não é mais uma tela própria). Admin vê tudo (acesso,
// gerentes, remover); quem só é gerente da pasta vê apenas a lista de
// dashboards — criar, renomear, remover (o resto é admin-only, ver
// server/workspace.mjs).
import { useEffect, useState } from 'react'
import { X, Trash2, Loader2, AlertTriangle, LayoutGrid, Plus } from 'lucide-react'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { cn } from '@/utils/cn'
import { useAuthStore } from '@/store/authStore'
import { useWorkspaceStore } from '@/store/workspaceStore'
import { fetchUsers } from '@/features/access/accessApi'
import { fetchFolder, createFolder, createDashboard, updateDashboard, deleteDashboard, deleteFolder, setFolderAccess, setFolderManagers, ApiError } from './workspaceApi'
import type { Folder, WorkspaceTreeDashboard } from './types'
import { AccessControl, ManagersControl, type KnownUsers } from './FolderPeopleControls'
import { DashboardRow } from './DashboardRow'
import { inputCls } from './folderStyles'

export function FolderSettingsModal({ folderId, onClose }: { folderId: string | null; onClose: () => void }) {
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const treeFolders = useWorkspaceStore((s) => s.folders)
  const refreshWorkspace = useWorkspaceStore((s) => s.refresh)

  const [currentId, setCurrentId] = useState<string | null>(folderId)
  const [fullFolder, setFullFolder] = useState<Folder | null>(null) // só carregado pra admin
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newDashboard, setNewDashboard] = useState('')
  const [creatingDashboard, setCreatingDashboard] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deletingDashboardId, setDeletingDashboardId] = useState<string | null>(null)
  const [dashboardToDelete, setDashboardToDelete] = useState<WorkspaceTreeDashboard | null>(null)
  // Quem já acessou o sistema — de onde saem as pessoas de "Acesso à pasta" e
  // "Gerentes". A lista é admin-only, como as duas seções.
  const [known, setKnown] = useState<KnownUsers>({ users: null, error: null })

  const treeFolder = currentId ? treeFolders?.find((f) => f.id === currentId) ?? null : null

  useEffect(() => {
    if (!currentId || !isAdmin) { setFullFolder(null); return }
    let alive = true
    setLoading(true)
    fetchFolder(currentId)
      .then((f) => { if (alive) { setFullFolder(f); setError(null) } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e.message : 'Erro inesperado.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [currentId, isAdmin])

  useEffect(() => {
    if (!currentId || !isAdmin) return
    let alive = true
    fetchUsers()
      .then(({ users }) => {
        if (!alive) return
        const list = users
          .map((u) => ({ email: u.email, name: u.name, role: u.role }))
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        setKnown({ users: list, error: null })
      })
      .catch((e) => { if (alive) setKnown({ users: null, error: e instanceof ApiError ? e.message : 'Não foi possível carregar os usuários.' }) })
    return () => { alive = false }
  }, [currentId, isAdmin])

  const name = fullFolder?.name ?? treeFolder?.name ?? ''
  const dashboards: WorkspaceTreeDashboard[] = fullFolder?.dashboards ?? treeFolder?.dashboards ?? []

  const handleCreateFolder = async () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      const created = await createFolder({ name: trimmed })
      refreshWorkspace()
      setCurrentId(created.id) // transiciona pro modo edição da pasta recém-criada
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao criar pasta.')
    } finally {
      setCreating(false)
    }
  }

  const saveAccess = async (accessEmails: string[] | null) => {
    if (!fullFolder) return
    const saved = await setFolderAccess(fullFolder.id, accessEmails)
    setFullFolder({ ...fullFolder, accessEmails: saved.accessEmails })
    refreshWorkspace()
  }

  const saveManagers = async (managers: string[]) => {
    if (!fullFolder) return
    const saved = await setFolderManagers(fullFolder.id, managers)
    setFullFolder({ ...fullFolder, managers: saved.managers })
    refreshWorkspace()
  }

  const addDashboard = async () => {
    if (!currentId) return
    const trimmed = newDashboard.trim()
    if (!trimmed) return
    setCreatingDashboard(true)
    try {
      const dashboard = await createDashboard(currentId, trimmed)
      if (fullFolder) setFullFolder({ ...fullFolder, dashboards: [...fullFolder.dashboards, dashboard] })
      setNewDashboard('')
      refreshWorkspace()
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao criar dashboard.')
    } finally {
      setCreatingDashboard(false)
    }
  }

  // Erros sobem para a linha da dashboard, que os mostra junto do campo.
  const renameDashboard = async (dashboard: WorkspaceTreeDashboard, name: string) => {
    if (!currentId) return
    const saved = await updateDashboard(currentId, dashboard.id, { name })
    if (fullFolder) {
      setFullFolder({ ...fullFolder, dashboards: fullFolder.dashboards.map((d) => (d.id === dashboard.id ? { ...d, name: saved.name } : d)) })
    }
    // Menu lateral e título do topo leem a árvore — e, para o gerente, é dela
    // que esta lista vem.
    await refreshWorkspace()
  }

  const confirmDeleteDashboard = async () => {
    if (!currentId || !dashboardToDelete) return
    setDeletingDashboardId(dashboardToDelete.id)
    try {
      await deleteDashboard(currentId, dashboardToDelete.id)
      if (fullFolder) setFullFolder({ ...fullFolder, dashboards: fullFolder.dashboards.filter((d) => d.id !== dashboardToDelete.id) })
      refreshWorkspace()
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao remover dashboard.')
    } finally {
      setDeletingDashboardId(null)
      setDashboardToDelete(null)
    }
  }

  const confirmDeleteFolder = async () => {
    if (!currentId) return
    try {
      await deleteFolder(currentId)
      refreshWorkspace()
      onClose()
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao remover pasta.')
    }
  }

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="w-full max-w-md max-h-[85vh] overflow-auto rounded-2xl border border-app-border bg-app-card shadow-card-lg">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border sticky top-0 bg-app-card">
            <h2 className="text-sm font-bold text-gray-100">{currentId ? 'Configurações da pasta' : 'Nova pasta'}</h2>
            <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
          </div>

          <div className="p-5 space-y-4">
            {!currentId && (
              <div className="flex items-center gap-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                  placeholder="Nome da pasta (setor)…"
                  className={cn(inputCls, 'flex-1')}
                  autoFocus
                />
                <button onClick={handleCreateFolder} disabled={!newName.trim() || creating} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight disabled:opacity-50">
                  {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Criar
                </button>
              </div>
            )}

            {currentId && loading && !fullFolder && (
              <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 size={13} className="animate-spin" /> Carregando…</div>
            )}
            {error && (
              <p className="flex items-center gap-1.5 text-[11px] text-risk-critical"><AlertTriangle size={12} /> {error}</p>
            )}

            {currentId && name && (
              <>
                <p className="text-xs font-semibold text-gray-100">{name}</p>

                {isAdmin && fullFolder && (
                  <>
                    <AccessControl folder={fullFolder} known={known} onSave={saveAccess} />
                    <ManagersControl folder={fullFolder} known={known} onSave={saveManagers} />
                  </>
                )}

                <div className="space-y-1.5">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1"><LayoutGrid size={11} /> Dashboards</span>
                  {dashboards.length > 0 && (
                    <ul className="space-y-1">
                      {dashboards.map((d) => (
                        <DashboardRow
                          key={d.id}
                          dashboard={d}
                          deleting={deletingDashboardId === d.id}
                          onRename={(name) => renameDashboard(d, name)}
                          onDelete={() => setDashboardToDelete(d)}
                        />
                      ))}
                    </ul>
                  )}
                  <div className="flex items-center gap-2">
                    <input value={newDashboard} onChange={(e) => setNewDashboard(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDashboard()} placeholder="Nome da nova dashboard…" className={cn(inputCls, 'flex-1')} />
                    <button onClick={addDashboard} disabled={!newDashboard.trim() || creatingDashboard} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue disabled:opacity-50">
                      {creatingDashboard ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Criar
                    </button>
                  </div>
                </div>

                {isAdmin && fullFolder && (
                  <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 text-[11px] font-semibold text-risk-critical hover:underline">
                    <Trash2 size={11} /> Remover esta pasta
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Remover pasta"
          message={`Remover a pasta "${name}"? ${dashboards.length} dashboard(s) e todo o conteúdo dentro delas serão perdidos.`}
          confirmLabel="Remover"
          danger
          onConfirm={confirmDeleteFolder}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {dashboardToDelete && (
        <ConfirmDialog
          title="Remover dashboard"
          message={`Remover a dashboard "${dashboardToDelete.name}"? Todas as guias e widgets dentro dela serão perdidos.`}
          confirmLabel="Remover"
          danger
          onConfirm={confirmDeleteDashboard}
          onCancel={() => setDashboardToDelete(null)}
        />
      )}
    </ModalPortal>
  )
}
