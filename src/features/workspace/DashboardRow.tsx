// Uma dashboard na lista da pasta: renomear no lugar (lápis; Enter salva, Esc
// cancela), duplicar e remover. Admin e gerente da pasta veem a lista — a rota de
// renomear tem a mesma regra (requireFolderManager em server/index.mjs).
import { useState } from 'react'
import { Check, Copy, Loader2, Pencil, Trash2, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ApiError } from './workspaceApi'
import type { WorkspaceTreeDashboard } from './types'
import { inputCls } from './folderStyles'

export function DashboardRow({ dashboard, deleting, duplicating, onRename, onDuplicate, onDelete }: {
  dashboard: WorkspaceTreeDashboard
  deleting: boolean
  duplicating: boolean
  onRename: (name: string) => Promise<void>
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(dashboard.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = () => {
    setValue(dashboard.name)
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    const name = value.trim()
    if (!name) { setError('Dê um nome à dashboard.'); return }
    if (name === dashboard.name) { setEditing(false); return }
    setSaving(true)
    setError(null)
    try {
      await onRename(name)
      setEditing(false)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao renomear a dashboard.')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <li className="space-y-1">
        <div className="flex items-center gap-1.5">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setEditing(false)
            }}
            autoFocus
            aria-label="Novo nome da dashboard"
            className={cn(inputCls, 'flex-1 py-1')}
          />
          <button type="button" onClick={() => void save()} disabled={saving} title="Salvar nome" aria-label="Salvar nome" className="shrink-0 text-gray-400 hover:text-emerald-400 disabled:opacity-50">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={saving} title="Cancelar" aria-label="Cancelar" className="shrink-0 text-gray-500 hover:text-gray-200">
            <X size={12} />
          </button>
        </div>
        {error && <p className="text-[10px] text-risk-critical">{error}</p>}
      </li>
    )
  }

  return (
    <li className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
      <span className="truncate">{dashboard.name}</span>
      <span className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={start} title="Renomear dashboard" aria-label={`Renomear ${dashboard.name}`} className="text-gray-600 hover:text-brand-blue">
          <Pencil size={11} />
        </button>
        <button type="button" onClick={onDuplicate} disabled={duplicating} title="Duplicar dashboard (com guias, widgets e medidas)" aria-label={`Duplicar ${dashboard.name}`} className="text-gray-600 hover:text-brand-blue disabled:opacity-50">
          {duplicating ? <Loader2 size={11} className="animate-spin" /> : <Copy size={11} />}
        </button>
        <button type="button" onClick={onDelete} disabled={deleting} title="Remover dashboard" aria-label={`Remover ${dashboard.name}`} className="text-gray-600 hover:text-risk-critical disabled:opacity-50">
          {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
        </button>
      </span>
    </li>
  )
}
