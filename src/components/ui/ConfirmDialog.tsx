// Diálogo de confirmação no estilo do app — substitui o confirm() nativo do
// navegador (que quebra a identidade visual e mostra a URL). z-[60] pra ficar
// por cima até de outro modal já aberto (ex.: confirmar dentro do Gerenciar
// abas, que já é z-50).
import { ModalPortal } from './ModalPortal'
import { cn } from '@/utils/cn'

export function ConfirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger, onConfirm, onCancel }: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
        <div className="w-full max-w-sm rounded-2xl border border-app-border bg-app-card shadow-card-lg">
          <div className="px-5 py-4">
            <h2 className="text-sm font-bold text-gray-100">{title}</h2>
            <p className="mt-1.5 text-[12px] text-gray-400">{message}</p>
          </div>
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border">
            <button onClick={onCancel} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">{cancelLabel}</button>
            <button
              onClick={onConfirm}
              className={cn(
                'px-3.5 py-2 rounded-lg text-xs font-semibold text-white',
                danger ? 'bg-risk-critical hover:bg-risk-critical/90' : 'bg-brand-blue hover:bg-brand-blueLight',
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
