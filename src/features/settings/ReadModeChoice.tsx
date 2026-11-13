// Como a aplicação lê uma fonte do Data Hub (ReadMode, ver o cabeçalho de
// server/lakehouseSources.mjs): direto no Data Hub, sem cópia nenhuma, ou do
// jeito antigo, copiando a tabela inteira para cá.
import { Zap, Copy } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { ReadMode } from './lakehouseSourceApi'

const OPTIONS: { mode: ReadMode; title: string; hint: string; Icon: typeof Zap }[] = [
  {
    mode: 'direct',
    title: 'Direto no Data Hub',
    hint: 'Recomendado. Cada painel pergunta ao Data Hub e recebe só o resultado — nada é copiado para cá. Serve para tabela de qualquer tamanho.',
    Icon: Zap,
  },
  {
    mode: 'copy',
    title: 'Cópia local',
    hint: 'O jeito anterior: a tabela inteira é baixada para cá a cada atualização, até 100 MB. Use se o Data Hub ainda não tiver a consulta direta.',
    Icon: Copy,
  },
]

export function ReadModeChoice({ value, onChange }: { value: ReadMode; onChange: (mode: ReadMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Como ler esta fonte" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {OPTIONS.map(({ mode, title, hint, Icon }) => {
        const on = value === mode
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(mode)}
            className={cn(
              'text-left rounded-lg border p-2.5 transition-colors',
              on ? 'border-brand-blue/60 bg-brand-blue/10' : 'border-app-border hover:border-app-borderLight',
            )}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-100">
              <Icon size={12} className={on ? 'text-brand-blue' : 'text-gray-500'} /> {title}
            </span>
            <span className="mt-1 block text-[10px] leading-snug text-gray-500">{hint}</span>
          </button>
        )
      })}
    </div>
  )
}

// Resultado do teste de conexão para a leitura direta.
export function DirectQueryStatus({ direct }: { direct: { available: boolean; total: number | null; error: string | null } }) {
  if (direct.available) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[10px] text-risk-low">
        <Zap size={11} className="shrink-0" /> Leitura direta disponível — os painéis vão consultar o Data Hub sem copiar a tabela.
      </p>
    )
  }
  return (
    <p className="mt-2 flex items-start gap-1.5 text-[10px] text-risk-medium">
      <Zap size={11} className="mt-0.5 shrink-0" /> Leitura direta indisponível: {direct.error}
    </p>
  )
}
