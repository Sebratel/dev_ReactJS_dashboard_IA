// Catálogo único e editável de queries — add/editar/remover livremente.
// Cada query vira uma fonte de dados no Builder (colunas inferidas dos dados
// reais). Ao salvar/remover, o snapshot é atualizado em segundo plano.
import { useEffect, useState } from 'react'
import { Database, Search, Loader2, Plus, Pencil, Trash2, AlertTriangle, RefreshCw, RotateCcw, FolderCog } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/utils/cn'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAuthStore } from '@/store/authStore'
import { fetchFolders } from '@/features/workspace/workspaceApi'
import type { Folder } from '@/features/workspace/types'
import {
  fetchQueryCatalog, deleteQuery, resetQueryCatalog, setQueryEnabled, setQueryRefresh, setQueryFolders,
  fetchQueryUsage, ApiError, type QueryDef,
} from './queryCatalogApi'
import { QueryEditorModal } from './QueryEditorModal'
import { FieldDictionaryCard } from './FieldDictionaryCard'
import { LakehouseSourcesCard } from './LakehouseSourcesCard'
import { Toggle, RefreshControl, FolderControl, type RefreshPatch } from './SourceControls'

const DB_LABEL: Record<QueryDef['db'], string> = {
  postgres: 'PostgreSQL (DB_ELLEVEN)',
  mariadb: 'MariaDB (DB_Applicattion)',
}
const DB_COLOR: Record<QueryDef['db'], string> = {
  postgres: '#3b82f6', mariadb: '#f59e0b',
}

function QueryCard({ q, isAdmin, allFolders, onEdit, onDelete, onToggleEnabled, onSaveRefresh, onSaveFolders }: {
  q: QueryDef; isAdmin: boolean; allFolders: Folder[]
  onEdit: () => void; onDelete: () => void; onToggleEnabled: (enabled: boolean) => void
  onSaveRefresh: (refresh: RefreshPatch) => Promise<void>
  onSaveFolders: (folderIds: string[] | null) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const enabled = q.enabled ?? true
  return (
    <Card className={cn(!enabled && 'opacity-60')}>
      <div className="w-full flex items-center justify-between gap-3 px-5 py-4">
        <Toggle on={enabled} onChange={onToggleEnabled} title={enabled ? 'Desativar query (bloqueia o uso e para de atualizar)' : 'Ativar query'} />
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 text-left flex-1">
          <p className="text-xs font-semibold text-gray-100">{q.title}</p>
          <p className="text-[10px] text-gray-500 mt-0.5 font-mono">
            {q.id}
            {!enabled && <span className="text-risk-critical"> · desativada</span>}
            {enabled && <span> · {(q.refreshMode ?? 'realtime') === 'realtime' ? 'tempo real' : `a cada ${q.refreshMinutes ?? 60}min`}</span>}
          </p>
        </button>
        <span className="text-[10px] font-semibold px-2 py-1 rounded shrink-0" style={{ color: DB_COLOR[q.db], background: `${DB_COLOR[q.db]}15` }}>
          {DB_LABEL[q.db]}
        </span>
        {q.folderIds && (
          <span
            className="text-[10px] font-semibold px-2 py-1 rounded shrink-0 flex items-center gap-1 text-gray-400 bg-app-surface"
            title={q.folderIds.length === 0 ? 'Nenhuma pasta liberada — some do Builder em todo lugar' : `Liberada em ${q.folderIds.length} pasta(s), não em todas`}
          >
            <FolderCog size={10} /> {q.folderIds.length}
          </span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onEdit} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-500 hover:text-brand-blue hover:bg-brand-blue/10" title="Editar"><Pencil size={12} /></button>
          <button onClick={onDelete} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-500 hover:text-risk-critical hover:bg-risk-critical/10" title="Remover"><Trash2 size={12} /></button>
        </div>
      </div>
      {open && (
        <div className="border-t border-app-border p-4 space-y-4">
          <RefreshControl source={q} noun="query" onSave={onSaveRefresh} />
          {isAdmin && <FolderControl source={q} noun="query" allFolders={allFolders} fetchUsage={fetchQueryUsage} onSave={onSaveFolders} />}
          <pre className="text-[11px] text-gray-300 bg-app-surface rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">{q.sql.trim()}</pre>
        </div>
      )}
    </Card>
  )
}

export default function SettingsPage() {
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const [list, setList] = useState<QueryDef[] | null>(null)
  const [isDefault, setIsDefault] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [search, setSearch] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState<{ open: boolean; query: QueryDef | null }>({ open: false, query: null })
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null)
  // Só pra alimentar o seletor de pastas do admin — /api/workspace/folders é
  // admin-only, então nem tentamos buscar se o usuário não for admin.
  const [allFolders, setAllFolders] = useState<Folder[]>([])

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchQueryCatalog()
      .then((r) => { if (alive) { setList(r.list); setIsDefault(r.isDefault); setError(null) } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'Erro inesperado.')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [reloadKey])

  useEffect(() => {
    if (!isAdmin) return
    let alive = true
    fetchFolders().then((f) => { if (alive) setAllFolders(f) }).catch(() => { /* mantém lista vazia */ })
    return () => { alive = false }
  }, [isAdmin])

  const removeQuery = (id: string) => {
    setConfirmState({
      title: 'Remover query',
      message: `Remover a query "${id}"? Os widgets que usam essa fonte deixarão de funcionar.`,
      confirmLabel: 'Remover',
      onConfirm: async () => {
        setConfirmState(null)
        try {
          await deleteQuery(id)
          setReloadKey((k) => k + 1)
        } catch (e) {
          alert(e instanceof ApiError ? e.message : 'Falha ao remover.')
        }
      },
    })
  }

  const toggleQueryEnabled = async (id: string, enabled: boolean) => {
    // Otimista — reflete na hora na lista; se a chamada falhar, recarrega do
    // servidor pra desfazer (mais simples que guardar o estado anterior aqui).
    setList((prev) => prev && prev.map((q) => (q.id === id ? { ...q, enabled } : q)))
    try {
      await setQueryEnabled(id, enabled)
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao atualizar.')
      setReloadKey((k) => k + 1)
    }
  }

  const saveQueryRefresh = async (id: string, refresh: RefreshPatch) => {
    const saved = await setQueryRefresh(id, refresh)
    setList((prev) => prev && prev.map((q) => (q.id === id ? saved : q)))
  }

  const saveQueryFolders = async (id: string, folderIds: string[] | null) => {
    const saved = await setQueryFolders(id, folderIds)
    setList((prev) => prev && prev.map((q) => (q.id === id ? saved : q)))
  }

  const restoreDefault = () => {
    setConfirmState({
      title: 'Restaurar catálogo padrão',
      message: 'Restaurar o catálogo PADRÃO (as 12 queries originais)? Queries criadas/editadas por você serão perdidas.',
      confirmLabel: 'Restaurar',
      onConfirm: async () => {
        setConfirmState(null)
        try {
          await resetQueryCatalog()
          setReloadKey((k) => k + 1)
        } catch (e) {
          alert(e instanceof ApiError ? e.message : 'Falha ao restaurar.')
        }
      },
    })
  }

  if (loading && !list) {
    return <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-card px-5 py-16 text-sm text-gray-400 animate-slide-up"><Loader2 size={16} className="animate-spin" /> Carregando catálogo de queries…</div>
  }
  if (error && !list) {
    return (
      <div className="rounded-xl border border-app-border bg-app-card px-5 py-6 space-y-3 animate-slide-up">
        <div className="flex items-start gap-2.5 text-sm text-rose-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-gray-100">Não foi possível carregar o catálogo</p>
            <p className="mt-0.5 text-[12px] text-gray-400">{error.message}</p>
          </div>
        </div>
        <button onClick={() => setReloadKey((k) => k + 1)} className="flex items-center gap-1.5 rounded-md border border-app-border px-3 py-1.5 text-[12px] text-gray-300 hover:border-app-borderLight hover:text-gray-100 transition-colors"><RefreshCw size={13} /> Tentar novamente</button>
      </div>
    )
  }
  if (!list) return null

  const filtered = list.filter((q) =>
    !search || q.title.toLowerCase().includes(search.toLowerCase()) || q.id.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="space-y-5 animate-slide-up">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Database size={13} className="text-brand-cyan" />
          <h2 className="text-xs font-bold text-white uppercase tracking-wider">Queries</h2>
          {isDefault && <span className="text-[10px] text-gray-500">(catálogo padrão)</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setEditorOpen({ open: true, query: null })} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue">
            <Plus size={11} /> Nova query
          </button>
          <button onClick={restoreDefault} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-risk-critical/30 text-[11px] font-semibold text-risk-critical hover:bg-risk-critical/10" title="Restaurar o catálogo padrão">
            <RotateCcw size={11} /> Padrão
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-card px-4 py-2.5">
        <Search size={13} className="text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por título ou id da query…"
          className="flex-1 bg-transparent text-xs text-gray-200 placeholder:text-gray-500 outline-none"
        />
      </div>

      {loading && <div className="flex items-center gap-1.5 text-[11px] text-gray-500"><Loader2 size={11} className="animate-spin" /> atualizando…</div>}

      {filtered.length === 0 && (
        <p className="text-[11px] text-gray-500 rounded-xl border border-dashed border-app-border px-4 py-6 text-center">
          {list.length === 0 ? 'Nenhuma query cadastrada ainda — crie a primeira para alimentar o Builder.' : 'Nenhuma query encontrada para essa busca.'}
        </p>
      )}
      <div className="space-y-2">
        {filtered.map((q) => (
          <QueryCard
            key={q.id}
            q={q}
            isAdmin={isAdmin}
            allFolders={allFolders}
            onEdit={() => setEditorOpen({ open: true, query: q })}
            onDelete={() => removeQuery(q.id)}
            onToggleEnabled={(enabled) => toggleQueryEnabled(q.id, enabled)}
            onSaveRefresh={(refresh) => saveQueryRefresh(q.id, refresh)}
            onSaveFolders={(folderIds) => saveQueryFolders(q.id, folderIds)}
          />
        ))}
      </div>

      <p className="text-[10px] text-gray-500 text-center">
        Só são permitidas queries de leitura (SELECT/WITH). Ao salvar/remover, o snapshot é atualizado automaticamente em segundo plano — as colunas novas aparecem no editor de widgets do Builder em pouco tempo.
      </p>

      <LakehouseSourcesCard allFolders={allFolders} />

      {isAdmin && <FieldDictionaryCard />}

      {editorOpen.open && (
        <QueryEditorModal
          initial={editorOpen.query}
          onSaved={() => { setEditorOpen({ open: false, query: null }); setReloadKey((k) => k + 1) }}
          onClose={() => setEditorOpen({ open: false, query: null })}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  )
}
