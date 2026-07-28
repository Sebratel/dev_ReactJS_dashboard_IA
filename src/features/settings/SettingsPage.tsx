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

const DB_LABEL: Record<QueryDef['db'], string> = {
  postgres: 'PostgreSQL (DB_ELLEVEN)',
  mariadb: 'MariaDB (DB_Applicattion)',
}
const DB_COLOR: Record<QueryDef['db'], string> = {
  postgres: '#3b82f6', mariadb: '#f59e0b',
}

// Toggle padrão do app — pill com círculo, transform via style (não classe
// arbitrária do Tailwind) e type="button" explícito, pra nunca depender de
// geração de classe em runtime pro deslocamento do círculo.
function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange(!on)}
      className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0', on ? 'bg-brand-blue' : 'bg-app-border')}
    >
      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform" style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
    </button>
  )
}

const inputCls = 'rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'
const pillCls = (active: boolean) => cn(
  'px-2.5 py-1 rounded-lg border text-[10px] font-medium',
  active ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-300',
)

// Ritmo de atualização de UMA query — 'realtime' (todo ciclo do ETL, poucos
// minutos) ou 'scheduled' (só a cada X min/h, mantendo o último dado bom
// entre uma execução e outra). É por query, não uma config global: dá pra
// ter uma em tempo real e outra agendada ao mesmo tempo.
function RefreshControl({ q, onSave }: {
  q: QueryDef
  onSave: (refresh: { mode: 'realtime' | 'scheduled'; minutes?: number }) => Promise<void>
}) {
  const initialMode = q.refreshMode ?? 'realtime'
  const initialMinutes = q.refreshMinutes ?? 60
  const [mode, setMode] = useState<'realtime' | 'scheduled'>(initialMode)
  const [value, setValue] = useState(initialMinutes % 60 === 0 && initialMinutes >= 60 ? initialMinutes / 60 : initialMinutes)
  const [unit, setUnit] = useState<'minutos' | 'horas'>(initialMinutes % 60 === 0 && initialMinutes >= 60 ? 'horas' : 'minutos')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const minutes = unit === 'horas' ? value * 60 : value
  const dirty = mode !== initialMode || (mode === 'scheduled' && minutes !== initialMinutes)

  const save = async () => {
    setSaving(true); setError(null); setSaved(false)
    try {
      await onSave({ mode, minutes: mode === 'scheduled' ? minutes : undefined })
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
      <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wider">Atualização desta query</span>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button type="button" onClick={() => setMode('realtime')} className={pillCls(mode === 'realtime')}>Tempo real</button>
        <button type="button" onClick={() => setMode('scheduled')} className={pillCls(mode === 'scheduled')}>Agendada</button>
        {mode === 'scheduled' && (
          <>
            <span className="text-[10px] text-gray-400">a cada</span>
            <input type="number" min={1} value={value} onChange={(e) => setValue(Math.max(1, Number(e.target.value) || 1))} className={cn(inputCls, 'w-16')} />
            <select value={unit} onChange={(e) => setUnit(e.target.value as 'minutos' | 'horas')} className={inputCls}>
              <option value="minutos">Minutos</option>
              <option value="horas">Horas</option>
            </select>
          </>
        )}
        {dirty && (
          <button onClick={save} disabled={saving} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-blue text-white text-[11px] font-semibold hover:bg-brand-blueLight disabled:opacity-50">
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} Salvar
          </button>
        )}
        {saved && <span className="text-[10px] text-emerald-400">Salvo ✓</span>}
      </div>
      {error && <p className="text-[11px] text-risk-critical">{error}</p>}
      <p className="text-[10px] text-gray-400">
        {mode === 'realtime'
          ? 'Atualiza em todo ciclo do ETL (a cada poucos minutos).'
          : 'Só busca dado novo a cada intervalo definido — entre uma execução e outra, mantém o último dado buscado (não some do Builder).'}
        {q.lastRunAt && ` Última atualização: ${new Date(q.lastRunAt).toLocaleString('pt-BR')}.`}
      </p>
    </div>
  )
}

// Em quais pastas esta query aparece como fonte no Builder — 'Todas as
// pastas' (padrão, folderIds null) ou só as marcadas abaixo. Não afeta o
// ETL nem `enabled`: controla só se a query aparece nos pickers de fonte de
// quem está montando uma dashboard naquela pasta. Só admin ajusta isto —
// ver requireAdmin() na rota PATCH /api/queries/:id/folders.
function FolderControl({ q, allFolders, onSave }: {
  q: QueryDef
  allFolders: Folder[]
  onSave: (folderIds: string[] | null) => Promise<void>
}) {
  const initialOpen = q.folderIds == null
  const [open, setOpen] = useState(initialOpen)
  const [selected, setSelected] = useState<Set<string>>(new Set(q.folderIds ?? []))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [checking, setChecking] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState<{ newFolderIds: string[] | null; affected: { name: string; dashboardNames: string[] }[] } | null>(null)

  const initialSelectedKey = [...(q.folderIds ?? [])].sort().join(',')
  const dirty = open !== initialOpen || (!open && [...selected].sort().join(',') !== initialSelectedKey)

  const toggleFolder = (id: string) => setSelected((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const doSave = async (folderIds: string[] | null) => {
    setSaving(true); setError(null); setSaved(false)
    try {
      await onSave(folderIds)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  // Antes de salvar, checa se alguma pasta que estava liberada e está sendo
  // removida (ou deixada de fora ao restringir a partir de "todas") já tem
  // widget de verdade usando esta query — se tiver, confirma antes, listando
  // onde. Só amplia acesso (ou não remove nenhuma pasta) nunca pede confirmação.
  const save = async () => {
    const newFolderIds = open ? null : Array.from(selected)
    const removedIds = newFolderIds === null
      ? []
      : q.folderIds == null
        ? allFolders.filter((f) => !selected.has(f.id)).map((f) => f.id)
        : q.folderIds.filter((id) => !selected.has(id))

    if (removedIds.length === 0) { await doSave(newFolderIds); return }

    setChecking(true); setError(null)
    try {
      const usage = await fetchQueryUsage(q.id)
      const affected = usage.filter((u) => removedIds.includes(u.folderId))
      if (affected.length > 0) {
        setConfirmRemoval({ newFolderIds, affected: affected.map((f) => ({ name: f.folderName, dashboardNames: f.dashboardNames })) })
      } else {
        await doSave(newFolderIds)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao verificar o uso desta query.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wider">Pastas onde esta query pode ser usada</span>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button type="button" onClick={() => setOpen(true)} className={pillCls(open)}>Todas as pastas</button>
        <button type="button" onClick={() => setOpen(false)} className={pillCls(!open)}>Só nestas</button>
      </div>
      {!open && (
        allFolders.length === 0 ? (
          <p className="text-[10px] text-gray-400">Nenhuma pasta cadastrada ainda.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {allFolders.map((f) => (
              <button key={f.id} type="button" onClick={() => toggleFolder(f.id)} className={pillCls(selected.has(f.id))}>{f.name}</button>
            ))}
          </div>
        )
      )}
      <div className="flex items-center gap-2">
        {dirty && (
          <button onClick={save} disabled={saving || checking} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-blue text-white text-[11px] font-semibold hover:bg-brand-blueLight disabled:opacity-50">
            {saving || checking ? <Loader2 size={11} className="animate-spin" /> : null} Salvar
          </button>
        )}
        {saved && <span className="text-[10px] text-emerald-400">Salvo ✓</span>}
      </div>
      {error && <p className="text-[11px] text-risk-critical">{error}</p>}
      <p className="text-[10px] text-gray-400">
        {open
          ? 'Aparece como fonte disponível em qualquer pasta.'
          : selected.size === 0
            ? 'Sem nenhuma pasta marcada, esta query some do Builder em todo lugar até marcar pelo menos uma.'
            : 'Só quem estiver montando uma dashboard dentro de uma dessas pastas vê esta query no seletor de fontes.'}
      </p>
      {confirmRemoval && (
        <ConfirmDialog
          title="Remover acesso de pasta em uso?"
          message={
            `Esta query já está em uso em: ${confirmRemoval.affected
              .map((f) => `"${f.name}" (${f.dashboardNames.join(', ')})`)
              .join('; ')}. Remover o acesso não apaga os widgets já criados, mas eles deixam de aparecer no seletor de fontes para novas edições nessa pasta. Continuar?`
          }
          confirmLabel="Remover mesmo assim"
          danger
          onConfirm={() => { const { newFolderIds } = confirmRemoval; setConfirmRemoval(null); doSave(newFolderIds) }}
          onCancel={() => setConfirmRemoval(null)}
        />
      )}
    </div>
  )
}

function QueryCard({ q, isAdmin, allFolders, onEdit, onDelete, onToggleEnabled, onSaveRefresh, onSaveFolders }: {
  q: QueryDef; isAdmin: boolean; allFolders: Folder[]
  onEdit: () => void; onDelete: () => void; onToggleEnabled: (enabled: boolean) => void
  onSaveRefresh: (refresh: { mode: 'realtime' | 'scheduled'; minutes?: number }) => Promise<void>
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
          <RefreshControl q={q} onSave={onSaveRefresh} />
          {isAdmin && <FolderControl q={q} allFolders={allFolders} onSave={onSaveFolders} />}
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

  const saveQueryRefresh = async (id: string, refresh: { mode: 'realtime' | 'scheduled'; minutes?: number }) => {
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
