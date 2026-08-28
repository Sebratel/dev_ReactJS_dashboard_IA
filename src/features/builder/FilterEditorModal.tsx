// Modal para adicionar um filtro à aba (campo + tipo).
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { getAllSources, getSourceDef } from './fieldCatalog'
import type { FilterConfig, SourceTable } from './types'

const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

export function FilterEditorModal({ onSave, onClose }: {
  onSave: (filter: FilterConfig) => void
  onClose: () => void
}) {
  const sources = getAllSources()
  const [source, setSource] = useState<SourceTable>(sources[0]?.key ?? '')
  const [field, setField] = useState('')
  const [label, setLabel] = useState('')

  const sourceDef = getSourceDef(source)
  const fieldDef = sourceDef?.fields.find((f) => f.key === field)
  const type = fieldDef?.kind === 'date' ? 'daterange' : 'multiselect'

  const options = useMemo(
    () => sourceDef?.fields.filter((f) => f.kind === 'dimension' || f.kind === 'date') ?? [],
    [sourceDef],
  )

  const canSave = !!field

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-card shadow-card-lg">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
          <h2 className="text-sm font-bold text-gray-100">Novo filtro da aba</h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Fonte de dados</span>
            <select value={source} onChange={(e) => { setSource(e.target.value as SourceTable); setField('') }} className={cn(inputCls, 'mt-1')}>
              {sources.length === 0 && <option value="">Nenhuma query cadastrada ainda</option>}
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Campo</span>
            <select value={field} onChange={(e) => { setField(e.target.value); const d = sourceDef?.fields.find((f) => f.key === e.target.value); if (d && !label) setLabel(d.label) }} className={cn(inputCls, 'mt-1')}>
              <option value="">Selecione…</option>
              {options.map((f) => <option key={f.key} value={f.key}>{f.label} {f.kind === 'date' ? '(período)' : ''}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Rótulo exibido</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={fieldDef?.label ?? ''} className={cn(inputCls, 'mt-1')} />
          </label>
          <p className="text-[10px] text-gray-500">
            Tipo: {type === 'daterange' ? 'intervalo de datas' : 'seleção múltipla de valores'} · O filtro afeta widgets desta fonte, e também widgets de outras fontes relacionadas a ela (ver botão "Relacionamentos").
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">Cancelar</button>
          <button
            onClick={() => canSave && onSave({ id: `f-${Date.now().toString(36)}`, source, field, label: label || (fieldDef?.label ?? field), type })}
            disabled={!canSave}
            className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight disabled:opacity-50"
          >
            Adicionar filtro
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}
