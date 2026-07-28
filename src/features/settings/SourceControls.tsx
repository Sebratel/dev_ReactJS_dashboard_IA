// Controles compartilhados entre os tipos de fonte de dados de Configurações:
// queries SQL (SettingsPage.tsx) e datasets do Data Hub
// (LakehouseSourcesCard.tsx). Os dois têm exatamente os mesmos eixos de
// configuração — liga/desliga, ritmo de atualização e em quais pastas a fonte
// aparece no Builder — então estes componentes são genéricos sobre a "forma"
// comum (refreshMode/refreshMinutes/lastRunAt/folderIds) em vez de amarrados
// ao tipo de uma delas.
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ApiError } from '@/lib/apiClient'
import type { Folder } from '@/features/workspace/types'

export const inputCls = 'rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'
export const pillCls = (active: boolean) => cn(
  'px-2.5 py-1 rounded-lg border text-[10px] font-medium',
  active ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-300',
)

export type RefreshMode = 'realtime' | 'scheduled'
export interface RefreshPatch { mode: RefreshMode; minutes?: number }

// Toggle padrão do app — pill com círculo, transform via style (não classe
// arbitrária do Tailwind) e type="button" explícito, pra nunca depender de
// geração de classe em runtime pro deslocamento do círculo.
export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
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

// Ritmo de atualização de UMA fonte — 'realtime' (todo ciclo do ETL, poucos
// minutos) ou 'scheduled' (só a cada X min/h, mantendo o último dado bom
// entre uma execução e outra). É por fonte, não uma config global: dá pra
// ter uma em tempo real e outra agendada ao mesmo tempo.
export function RefreshControl({ source, noun, onSave }: {
  source: { refreshMode?: RefreshMode | null; refreshMinutes?: number | null; lastRunAt?: string | null }
  noun: string
  onSave: (refresh: RefreshPatch) => Promise<void>
}) {
  const initialMode = source.refreshMode ?? 'realtime'
  const initialMinutes = source.refreshMinutes ?? 60
  const [mode, setMode] = useState<RefreshMode>(initialMode)
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
      <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wider">Atualização {noun === 'query' ? 'desta query' : 'desta fonte'}</span>
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
        {source.lastRunAt && ` Última atualização: ${new Date(source.lastRunAt).toLocaleString('pt-BR')}.`}
      </p>
    </div>
  )
}

export interface SourceUsage { folderId: string; folderName: string; dashboardNames: string[] }

// Em quais pastas esta fonte aparece no Builder — 'Todas as pastas' (padrão,
// folderIds null) ou só as marcadas abaixo. Não afeta o ETL nem `enabled`:
// controla só se a fonte aparece nos pickers de quem está montando uma
// dashboard naquela pasta. Só admin ajusta isto — ver requireAdmin() nas
// rotas PATCH /api/queries/:id/folders e /api/lakehouse-sources/:id/folders.
export function FolderControl({ source, noun, allFolders, fetchUsage, onSave }: {
  // folderIds ausente (undefined) conta como null = liberada em todas as
  // pastas — entradas antigas do catálogo de queries não têm esse campo.
  source: { id: string; folderIds?: string[] | null }
  noun: string
  allFolders: Folder[]
  fetchUsage: (id: string) => Promise<SourceUsage[]>
  onSave: (folderIds: string[] | null) => Promise<void>
}) {
  const initialOpen = source.folderIds == null
  const [open, setOpen] = useState(initialOpen)
  const [selected, setSelected] = useState<Set<string>>(new Set(source.folderIds ?? []))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [checking, setChecking] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState<{ newFolderIds: string[] | null; affected: { name: string; dashboardNames: string[] }[] } | null>(null)

  const initialSelectedKey = [...(source.folderIds ?? [])].sort().join(',')
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
  // widget de verdade usando esta fonte — se tiver, confirma antes, listando
  // onde. Só ampliar acesso (ou não remover nenhuma pasta) nunca pede confirmação.
  const save = async () => {
    const newFolderIds = open ? null : Array.from(selected)
    const removedIds = newFolderIds === null
      ? []
      : source.folderIds == null
        ? allFolders.filter((f) => !selected.has(f.id)).map((f) => f.id)
        : source.folderIds.filter((id) => !selected.has(id))

    if (removedIds.length === 0) { await doSave(newFolderIds); return }

    setChecking(true); setError(null)
    try {
      const usage = await fetchUsage(source.id)
      const affected = usage.filter((u) => removedIds.includes(u.folderId))
      if (affected.length > 0) {
        setConfirmRemoval({ newFolderIds, affected: affected.map((f) => ({ name: f.folderName, dashboardNames: f.dashboardNames })) })
      } else {
        await doSave(newFolderIds)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Falha ao verificar o uso desta ${noun}.`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wider">Pastas onde esta {noun} pode ser usada</span>
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
            ? `Sem nenhuma pasta marcada, esta ${noun} some do Builder em todo lugar até marcar pelo menos uma.`
            : `Só quem estiver montando uma dashboard dentro de uma dessas pastas vê esta ${noun} no seletor de fontes.`}
      </p>
      {confirmRemoval && (
        <ConfirmDialog
          title="Remover acesso de pasta em uso?"
          message={
            `Esta ${noun} já está em uso em: ${confirmRemoval.affected
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
