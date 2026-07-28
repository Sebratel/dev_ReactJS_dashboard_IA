// Modal "Temas" (estilo Power BI) — lista os temas prontos (ver
// themePresets.ts) num grid de cartões, cada um com uma prévia das cores das
// séries, do fundo do card e do texto da legenda. Escolher um tema sobrepõe
// essas cores em todos os widgets da guia atual — ver applyTheme em
// DashboardBuilder.tsx. Puramente uma escolha de "qual tema aplicar"; a
// aplicação de fato acontece no componente pai ao confirmar.
import { useState } from 'react'
import { X, Check } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { THEME_PRESETS, type ThemePreset } from './themePresets'

function ThemeCard({ theme, selected, onClick }: { theme: ThemePreset; selected: boolean; onClick: () => void }) {
  const previewBg = theme.backgroundColor ?? 'rgb(var(--app-surface))'
  const legendColor = theme.textColor ?? 'rgb(var(--gray-400))'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left rounded-xl border p-3 space-y-2.5 transition-colors',
        selected ? 'border-brand-blue bg-brand-blue/5' : 'border-app-border hover:border-app-borderLight',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-100">{theme.name}</span>
        {selected && <Check size={13} className="text-brand-blue shrink-0" />}
      </div>
      <div className="rounded-lg p-2.5 space-y-2" style={{ background: previewBg }}>
        <div className="flex items-end gap-1 h-8">
          {theme.palette.slice(0, 6).map((c, i) => (
            <span key={i} className="flex-1 rounded-sm" style={{ background: c, height: `${40 + (i % 3) * 20}%` }} />
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {theme.palette.slice(0, 5).map((c, i) => <span key={i} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />)}
          <span className="text-[9px] ml-1" style={{ color: legendColor }}>Legenda</span>
        </div>
      </div>
    </button>
  )
}

export function ThemePickerModal({ initialThemeId, onApply, onClose }: {
  initialThemeId?: string
  onApply: (theme: ThemePreset) => void
  onClose: () => void
}) {
  // `initialThemeId` vem do tema já detectado nos widgets da guia (ver
  // detectAppliedTheme em themePresets.ts) — sem isso, o modal sempre abriria
  // no primeiro card ("Padrão do app"), mesmo com outro tema já aplicado.
  const [selectedId, setSelectedId] = useState<string>(initialThemeId ?? THEME_PRESETS[0].id)

  const apply = () => {
    const theme = THEME_PRESETS.find((t) => t.id === selectedId)
    if (theme) onApply(theme)
  }

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="w-full max-w-2xl rounded-2xl border border-app-border bg-app-card shadow-card-lg">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
            <h2 className="text-sm font-bold text-gray-100">Temas</h2>
            <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
          </div>
          <div className="p-5 space-y-3">
            <p className="text-[11px] text-gray-400">
              Escolha um tema pronto para aplicar de uma vez as cores das barras/linhas/fatias, o fundo dos cards e a cor do texto (título, subtítulo, legenda, eixos, rótulos, célula/coluna/linha de tabela e matriz) em todos os widgets desta guia. Cada widget continua editável individualmente depois.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[50vh] overflow-y-auto scrollbar-thin pr-1">
              {THEME_PRESETS.map((theme) => (
                <ThemeCard key={theme.id} theme={theme} selected={theme.id === selectedId} onClick={() => setSelectedId(theme.id)} />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border">
            <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">Cancelar</button>
            <button onClick={apply} className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight">Aplicar nesta guia</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
