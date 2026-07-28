// Modal "Configurações de tela" (estilo Power BI) — define um tamanho de
// tela fixo em px para a aba atual (ou volta para a largura fluida padrão) e
// a atualização automática da aba (pensada pra telas sem interação, ex. TV
// de painel de um setor — sem isso, a aba só busca dado novo ao recarregar
// a página manualmente).
import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import type { CanvasConfig, TabAutoRefresh } from './types'

const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

const ALIGN_LABELS: Record<NonNullable<CanvasConfig['verticalAlign']>, string> = {
  top: 'Superior', middle: 'Meio', bottom: 'Inferior',
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0', on ? 'bg-brand-blue' : 'bg-app-border')}
    >
      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform" style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
    </button>
  )
}

export function CanvasSettingsModal({ initial, initialAutoRefresh, onSave, onClose }: {
  initial: CanvasConfig | null
  initialAutoRefresh?: TabAutoRefresh | null
  onSave: (canvas: CanvasConfig | null, autoRefresh: TabAutoRefresh | undefined) => void
  onClose: () => void
}) {
  const [custom, setCustom] = useState(!!initial)
  const [width, setWidth] = useState(initial?.width ?? 1280)
  const [height, setHeight] = useState(initial?.height ?? 720)
  const [verticalAlign, setVerticalAlign] = useState<CanvasConfig['verticalAlign']>(initial?.verticalAlign ?? 'top')
  const [autoRefreshOn, setAutoRefreshOn] = useState(initialAutoRefresh?.enabled ?? false)
  const [minutes, setMinutes] = useState(initialAutoRefresh?.minutes ?? 5)

  const save = () => {
    onSave(
      custom ? { width: Math.max(320, width), height: Math.max(240, height), verticalAlign } : null,
      autoRefreshOn ? { enabled: true, minutes: Math.max(1, minutes) } : undefined,
    )
  }

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-sm rounded-2xl border border-app-border bg-app-card shadow-card-lg">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
          <h2 className="text-sm font-bold text-gray-100">Configurações de tela</h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Tipo</span>
            <select
              value={custom ? 'custom' : 'fluid'}
              onChange={(e) => setCustom(e.target.value === 'custom')}
              className={cn(inputCls, 'mt-1')}
            >
              <option value="fluid">Ajustar à janela (padrão)</option>
              <option value="custom">Personalizar</option>
            </select>
          </label>

          {custom && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Largura (px)</span>
                  <input type="number" min={320} step={10} value={width} onChange={(e) => setWidth(Number(e.target.value) || 0)} className={cn(inputCls, 'mt-1')} />
                </label>
                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Altura (px)</span>
                  <input type="number" min={240} step={10} value={height} onChange={(e) => setHeight(Number(e.target.value) || 0)} className={cn(inputCls, 'mt-1')} />
                </label>
              </div>
              <label className="block">
                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Alinhamento vertical</span>
                <select value={verticalAlign} onChange={(e) => setVerticalAlign(e.target.value as CanvasConfig['verticalAlign'])} className={cn(inputCls, 'mt-1')}>
                  {(Object.keys(ALIGN_LABELS) as (keyof typeof ALIGN_LABELS)[]).map((k) => <option key={k} value={k}>{ALIGN_LABELS[k]}</option>)}
                </select>
              </label>
              <p className="text-[10px] text-gray-500">
                A grade passa a ter esse tamanho fixo (rolagem horizontal se a janela for menor). Os widgets podem ser posicionados livremente dentro dela, sem reorganização automática.
              </p>
            </>
          )}
          {!custom && (
            <p className="text-[10px] text-gray-500">
              A grade usa toda a largura disponível na janela — mesmo comportamento de hoje.
            </p>
          )}

          <div className="pt-2 border-t border-app-border space-y-2">
            <label className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Atualização automática</span>
              <Toggle on={autoRefreshOn} onChange={setAutoRefreshOn} />
            </label>
            <p className="text-[10px] text-gray-500">
              Sem isso, esta aba só busca dado novo se alguém recarregar a página. Ligue pra telas sem interação (ex. TV de painel) — os widgets se atualizam sozinhos, sem precisar de F5. Só vale fora do modo edição.
            </p>
            {autoRefreshOn && (
              <label className="flex items-center gap-2">
                <span className="text-[10px] text-gray-400 shrink-0">A cada</span>
                <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))} className={cn(inputCls, 'w-20')} />
                <span className="text-[10px] text-gray-400">minuto(s)</span>
              </label>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">Cancelar</button>
          <button onClick={save} className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight">Aplicar</button>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}
