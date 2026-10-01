import { cn } from '@/utils/cn'

// Estilos compartilhados pelo modal de configurações da pasta e suas partes.
export const inputCls = 'rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

export const pillCls = (active: boolean) => cn(
  'flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium',
  active ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400',
)

export const saveButtonCls = 'flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-blue text-white text-[11px] font-semibold hover:bg-brand-blueLight disabled:opacity-50'
