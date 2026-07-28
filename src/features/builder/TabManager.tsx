// Modal de gerenciamento de abas (guias) — criar, renomear, remover,
// reordenar e (novo) controlar o acesso de cada uma. Só quem gerencia a
// dashboard (admin ou gerente da pasta) abre isto — ver DashboardBuilder.tsx.
import { useState } from 'react'
import { X, Plus, Trash2, ArrowUp, ArrowDown, Lock, Globe, Sparkles, ShieldCheck } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { TabAccessModal } from './TabAccessModal'
import type { TabConfig } from './types'

const inputCls = 'rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

function AccessBadge({ tab }: { tab: TabConfig }) {
  if (tab.isWelcome) return <span className="flex items-center gap-1 text-[10px] text-brand-cyan"><Sparkles size={10} /> Boas-vindas</span>
  const mode = tab.access?.mode ?? 'restricted'
  return mode === 'open'
    ? <span className="flex items-center gap-1 text-[10px] text-emerald-400"><Globe size={10} /> Aberta</span>
    : <span className="flex items-center gap-1 text-[10px] text-gray-500"><Lock size={10} /> Restrita</span>
}

export function TabManager({ folderId, dashboardId, tabs, onChange, onClose }: {
  folderId: string
  dashboardId: string
  tabs: TabConfig[]
  onChange: (tabs: TabConfig[]) => void
  onClose: () => void
}) {
  const [newLabel, setNewLabel] = useState('')
  const [confirmTab, setConfirmTab] = useState<TabConfig | null>(null)
  const [accessTab, setAccessTab] = useState<TabConfig | null>(null)

  const rename = (id: string, label: string) => onChange(tabs.map((t) => (t.id === id ? { ...t, label } : t)))
  const remove = (id: string) => onChange(tabs.filter((t) => t.id !== id))
  const move = (idx: number, delta: number) => {
    const next = [...tabs]
    const target = idx + delta
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }
  const add = () => {
    const label = newLabel.trim()
    if (!label) return
    // Guia nova nasce BLOQUEADA (só admin/gerente veem) até alguém liberar o
    // acesso explicitamente — só a guia de boas-vindas nasce aberta.
    onChange([...tabs, { id: `tab-${Date.now().toString(36)}`, label, filters: [], widgets: [], access: { mode: 'restricted', view: [], edit: [] } }])
    setNewLabel('')
  }

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-2xl max-h-[85vh] overflow-auto rounded-2xl border border-app-border bg-app-card shadow-card-lg">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border sticky top-0 bg-app-card">
          <h2 className="text-sm font-bold text-gray-100">Gerenciar abas</h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
        </div>
        <div className="p-5 space-y-2">
          {tabs.map((t, i) => (
            <div key={t.id} className="flex items-center gap-2">
              <input value={t.label} onChange={(e) => rename(t.id, e.target.value)} className={cn(inputCls, 'flex-1')} />
              <span className="text-[10px] text-gray-500 w-16 text-right shrink-0">{t.widgets.length} widget(s)</span>
              <div className="w-20 shrink-0"><AccessBadge tab={t} /></div>
              <button onClick={() => setAccessTab(t)} title="Gerenciar acesso desta guia" className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-brand-blue disabled:opacity-30" disabled={t.isWelcome}>
                <ShieldCheck size={12} />
              </button>
              <button onClick={() => move(i, -1)} disabled={i === 0} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-gray-200 disabled:opacity-30"><ArrowUp size={11} /></button>
              <button onClick={() => move(i, 1)} disabled={i === tabs.length - 1} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-gray-200 disabled:opacity-30"><ArrowDown size={11} /></button>
              <button
                onClick={() => tabs.length > 1 && !t.isWelcome && setConfirmTab(t)}
                disabled={tabs.length <= 1 || t.isWelcome}
                title={t.isWelcome ? 'A guia de boas-vindas não pode ser removida' : undefined}
                className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical disabled:opacity-30"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-2 border-t border-app-border">
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Nome da nova aba…" className={cn(inputCls, 'flex-1')} />
            <button onClick={add} disabled={!newLabel.trim()} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight disabled:opacity-50">
              <Plus size={12} /> Criar
            </button>
          </div>
          <p className="text-[10px] text-gray-500 pt-1">
            Guias novas nascem bloqueadas — use o ícone de escudo pra liberar visualização/edição por usuário.
          </p>
        </div>
      </div>
    </div>
    {confirmTab && (
      <ConfirmDialog
        title="Remover aba"
        message={`Remover a aba "${confirmTab.label}" e seus ${confirmTab.widgets.length} widget(s)? Essa ação não pode ser desfeita depois de salvar.`}
        confirmLabel="Remover"
        danger
        onConfirm={() => { remove(confirmTab.id); setConfirmTab(null) }}
        onCancel={() => setConfirmTab(null)}
      />
    )}
    {accessTab && (
      <TabAccessModal
        folderId={folderId}
        dashboardId={dashboardId}
        tab={accessTab}
        onSaved={(updated) => { onChange(tabs.map((t) => (t.id === updated.id ? updated : t))); setAccessTab(null) }}
        onClose={() => setAccessTab(null)}
      />
    )}
    </ModalPortal>
  )
}
