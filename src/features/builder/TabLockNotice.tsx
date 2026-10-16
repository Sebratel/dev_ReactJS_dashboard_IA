// O que a tela mostra de uma guia que OUTRA pessoa está editando (ver
// useTabLocks.ts): o cadeado no botão da guia, o selo no lugar de "Editar" e
// o aviso em cima da grade. Laranja de status (risk-high), não âmbar: âmbar é
// a cor da marca (a guia ativa já é âmbar) e, no tema claro, amber-300 some
// contra o fundo. O texto usa os cinzas do tema, que se invertem no escuro.
import { Lock } from 'lucide-react'
import type { TabLockInfo } from '@/features/workspace/types'

function sinceLabel(lock: TabLockInfo): string {
  const since = new Date(lock.since)
  if (Number.isNaN(since.getTime())) return ''
  return ` desde ${since.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
}

export function lockHolderLabel(lock: TabLockInfo): string {
  return lock.self ? 'Você (em outra janela)' : lock.name
}

export function lockTitle(lock: TabLockInfo): string {
  return lock.self
    ? `Bloqueada: você está editando esta guia em outra janela${sinceLabel(lock)}`
    : `Bloqueada: ${lock.name} está editando esta guia${sinceLabel(lock)}`
}

// Cadeado ao lado do nome da guia, na barra de guias.
export function TabLockIcon({ lock }: { lock: TabLockInfo }) {
  return (
    <span title={lockTitle(lock)} aria-label={lockTitle(lock)} className="inline-flex text-risk-high">
      <Lock size={10} />
    </span>
  )
}

// No lugar do botão "Editar dashboard" quando a guia aberta está bloqueada.
export function TabLockChip({ lock }: { lock: TabLockInfo }) {
  return (
    <span title={lockTitle(lock)} className="flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-risk-high/40 bg-risk-high/10 px-3 py-1.5 text-[11px] font-semibold text-gray-200">
      <Lock size={11} className="shrink-0 text-risk-high" />
      <span className="truncate">{lockHolderLabel(lock)} editando</span>
    </span>
  )
}

// Aviso acima da grade. `dirty`: esta tela tem alteração não salva nesta guia
// (perdeu o bloqueio no meio da edição) — aí o aviso diz que ela não vai salvar.
export function TabLockBanner({ lock, dirty }: { lock: TabLockInfo; dirty: boolean }) {
  const who = lock.self ? 'Você está editando esta guia em outra janela' : `${lock.name} está editando esta guia`
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-lg border border-risk-high/40 bg-risk-high/10 px-3 py-2 text-[11px] text-gray-300">
      <Lock size={13} className="mt-0.5 shrink-0 text-risk-high" />
      <p>
        <strong className="font-semibold text-gray-100">Guia bloqueada para edição.</strong>{' '}
        {who}{sinceLabel(lock)}.{' '}
        {dirty
          ? 'O que você mudou aqui não pode ser salvo agora — descarte, ou espere a guia ficar livre.'
          : lock.self
            ? 'Salve ou descarte por lá para editar aqui.'
            : `Você pode ver, mas não editar, até ${lock.name} salvar ou sair. A versão nova aparece aqui sozinha.`}
      </p>
    </div>
  )
}
