// Configurações de UMA pasta — aberto pelo botão de engrenagem ao lado da
// pasta no menu lateral (não é mais uma tela própria). Admin vê tudo (acesso,
// gerentes, remover); quem só é gerente da pasta vê apenas a lista de
// dashboards + criar nova (o resto é admin-only, ver server/workspace.mjs).
import { useEffect, useState } from 'react'
import { X, Trash2, Loader2, AlertTriangle, Globe, Lock, ShieldCheck, LayoutGrid, Plus } from 'lucide-react'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { cn } from '@/utils/cn'
import { useAuthStore } from '@/store/authStore'
import { useWorkspaceStore } from '@/store/workspaceStore'
import { fetchFolder, createFolder, createDashboard, deleteFolder, setFolderAccess, setFolderManagers, ApiError } from './workspaceApi'
import type { Folder, WorkspaceTreeDashboard } from './types'

const inputCls = 'rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'
const pillCls = (active: boolean) => cn(
  'flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium',
  active ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400',
)

function parseEmailList(text: string): string[] {
  return Array.from(new Set(text.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean)))
}

function AccessControl({ folder, onSave }: { folder: Folder; onSave: (accessEmails: string[] | null) => Promise<void> }) {
  const initialOpen = folder.accessEmails === null
  const [open, setOpen] = useState(initialOpen)
  const [text, setText] = useState((folder.accessEmails ?? []).join('\n'))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = open !== initialOpen || (!open && text !== (folder.accessEmails ?? []).join('\n'))

  const save = async () => {
    setSaving(true); setError(null); setSaved(false)
    try {
      await onSave(open ? null : parseEmailList(text))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Acesso à pasta</span>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => setOpen(true)} className={pillCls(open)}><Globe size={11} /> Aberta a todos</button>
        <button type="button" onClick={() => setOpen(false)} className={pillCls(!open)}><Lock size={11} /> Restrita</button>
      </div>
      {!open && (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="um e-mail por linha (ou separados por vírgula)" className={cn(inputCls, 'w-full resize-y font-mono')} />
      )}
      <div className="flex items-center gap-2">
        {dirty && (
          <button onClick={save} disabled={saving} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-blue text-white text-[11px] font-semibold hover:bg-brand-blueLight disabled:opacity-50">
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} Salvar
          </button>
        )}
        {saved && <span className="text-[10px] text-emerald-400">Salvo ✓</span>}
      </div>
      {error && <p className="text-[11px] text-risk-critical">{error}</p>}
    </div>
  )
}

function ManagersControl({ folder, onSave }: { folder: Folder; onSave: (managers: string[]) => Promise<void> }) {
  const initial = folder.managers.join('\n')
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = text !== initial

  const save = async () => {
    setSaving(true); setError(null); setSaved(false)
    try {
      await onSave(parseEmailList(text))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1"><ShieldCheck size={11} /> Gerentes desta pasta</span>
      <p className="text-[10px] text-gray-500">Podem criar dashboards e liberar acesso de guias dentro desta pasta, sem precisar ser administrador. Precisam já ter acessado o sistema pelo menos uma vez.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="um e-mail por linha" className={cn(inputCls, 'w-full resize-y font-mono')} />
      <div className="flex items-center gap-2">
        {dirty && (
          <button onClick={save} disabled={saving} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-blue text-white text-[11px] font-semibold hover:bg-brand-blueLight disabled:opacity-50">
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} Salvar
          </button>
        )}
        {saved && <span className="text-[10px] text-emerald-400">Salvo ✓</span>}
      </div>
      {error && <p className="text-[11px] text-risk-critical">{error}</p>}
    </div>
  )
}

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
                    <AccessControl folder={fullFolder} onSave={saveAccess} />
                    <ManagersControl folder={fullFolder} onSave={saveManagers} />
                  </>
                )}

                <div className="space-y-1.5">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1"><LayoutGrid size={11} /> Dashboards</span>
                  {dashboards.length > 0 && (
                    <ul className="space-y-0.5">
                      {dashboards.map((d) => <li key={d.id} className="text-[11px] text-gray-400">{d.name}</li>)}
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
    </ModalPortal>
  )
}
