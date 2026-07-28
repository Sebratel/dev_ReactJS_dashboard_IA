// Define quem vê/edita UMA guia — só quem gerencia a pasta (admin ou
// gerente) abre isto, ver TabManager.tsx. O seletor de usuários vem só de
// quem já tem acesso à própria pasta (fetchFolderMembers) — liberar a pasta
// em si é sempre um passo separado, feito pelo admin em /pastas.
import { useEffect, useState } from 'react'
import { X, Loader2, Lock, Globe } from 'lucide-react'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { cn } from '@/utils/cn'
import { fetchFolderMembers, setTabAccess, ApiError } from '@/features/workspace/workspaceApi'
import type { FolderMember } from '@/features/workspace/types'
import type { TabAccess, TabConfig } from './types'

export function TabAccessModal({ folderId, dashboardId, tab, onSaved, onClose }: {
  folderId: string
  dashboardId: string
  tab: TabConfig
  onSaved: (tab: TabConfig) => void
  onClose: () => void
}) {
  const initial: TabAccess = tab.access ?? { mode: 'restricted', view: [], edit: [] }
  const [members, setMembers] = useState<FolderMember[] | null>(null)
  const [mode, setMode] = useState<TabAccess['mode']>(initial.mode)
  const [view, setView] = useState<Set<string>>(new Set(initial.view))
  const [edit, setEdit] = useState<Set<string>>(new Set(initial.edit))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchFolderMembers(folderId).then((m) => { if (alive) setMembers(m) }).catch(() => { if (alive) setMembers([]) })
    return () => { alive = false }
  }, [folderId])

  const toggleView = (email: string) => {
    setView((prev) => {
      const next = new Set(prev)
      next.has(email) ? next.delete(email) : next.add(email)
      return next
    })
  }
  const toggleEdit = (email: string) => {
    setEdit((prev) => {
      const next = new Set(prev)
      next.has(email) ? next.delete(email) : next.add(email)
      return next
    })
  }

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const saved = await setTabAccess(folderId, dashboardId, tab.id, { mode, view: Array.from(view), edit: Array.from(edit) })
      onSaved({ ...tab, access: saved.access })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar o acesso.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="w-full max-w-md max-h-[85vh] overflow-auto rounded-2xl border border-app-border bg-app-card shadow-card-lg">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border sticky top-0 bg-app-card">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-gray-100">Acesso da guia</h2>
              <p className="text-[11px] text-gray-500 truncate">{tab.label}</p>
            </div>
            <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200 shrink-0"><X size={14} /></button>
          </div>

          <div className="p-5 space-y-4">
            {tab.isWelcome ? (
              <p className="flex items-center gap-2 text-[11px] text-gray-400 bg-app-surface rounded-lg px-3 py-2.5">
                <Globe size={13} className="text-brand-cyan shrink-0" /> Guia de boas-vindas — sempre aberta para quem acessa esta pasta.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => setMode('open')} className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-semibold', mode === 'open' ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}>
                    <Globe size={12} /> Aberta
                  </button>
                  <button type="button" onClick={() => setMode('restricted')} className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-semibold', mode === 'restricted' ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}>
                    <Lock size={12} /> Restrita
                  </button>
                </div>
                <p className="text-[10px] text-gray-500">
                  {mode === 'open'
                    ? 'Qualquer um com acesso a esta pasta vê esta guia.'
                    : 'Só quem estiver marcado abaixo vê (ou edita) esta guia — além de administradores e do(s) gerente(s) desta pasta, que sempre têm acesso total.'}
                </p>
              </>
            )}

            {mode === 'restricted' && !tab.isWelcome && (
              members === null ? (
                <div className="flex items-center gap-2 text-[11px] text-gray-500"><Loader2 size={12} className="animate-spin" /> Carregando usuários da pasta…</div>
              ) : members.length === 0 ? (
                <p className="text-[11px] text-gray-500">Ninguém tem acesso a esta pasta ainda — libere o acesso à pasta primeiro (tela Pastas).</p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto scrollbar-thin pr-1">
                  <div className="grid grid-cols-[1fr,3rem,3rem] gap-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-1">
                    <span>Usuário</span><span className="text-center">Ver</span><span className="text-center">Editar</span>
                  </div>
                  {members.map((m) => (
                    <div key={m.email} className="grid grid-cols-[1fr,3rem,3rem] gap-2 items-center px-1 py-1.5 rounded-lg hover:bg-app-surface">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-200 truncate">{m.name}</p>
                        <p className="text-[10px] text-gray-500 truncate">{m.email}</p>
                      </div>
                      <label className="flex justify-center">
                        <input type="checkbox" checked={view.has(m.email) || edit.has(m.email)} disabled={edit.has(m.email)} onChange={() => toggleView(m.email)} />
                      </label>
                      <label className="flex justify-center">
                        <input type="checkbox" checked={edit.has(m.email)} onChange={() => toggleEdit(m.email)} />
                      </label>
                    </div>
                  ))}
                </div>
              )
            )}

            {error && <p className="text-[11px] text-risk-critical">{error}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border">
            <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">Cancelar</button>
            <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight disabled:opacity-50">
              {saving ? <Loader2 size={12} className="animate-spin" /> : null} Salvar
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
