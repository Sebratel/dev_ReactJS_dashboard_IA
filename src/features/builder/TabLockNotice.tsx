// O que a tela mostra de uma guia que OUTRA pessoa está editando (ver
// useTabLocks.ts): o cadeado no botão da guia, o selo no lugar de "Editar" e
// o aviso em cima da grade — é o aviso que diz QUEM está editando, com o nome
// inteiro. O selo é curto de propósito: com o nome dentro, um nome comprido
// ("Fabricio Silveira Machado edit…") era cortado e virava o único lugar da
// tela com essa informação. Laranja de status (risk-high), não âmbar: âmbar é
// a cor da marca (a guia ativa já é âmbar) e, no tema claro, amber-300 some
// contra o fundo. O texto usa os cinzas do tema, que se invertem no escuro.
import { Lock } from 'lucide-react'
import type { TabLockInfo } from '@/features/workspace/types'

function sinceLabel(lock: TabLockInfo): string {
  const since = new Date(lock.since)
  if (Number.isNaN(since.getTime())) return ''
  return ` desde ${since.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
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
      <Lock size={11} strokeWidth={2.5} />
    </span>
  )
}

// No lugar do botão "Editar dashboard" quando a guia aberta está bloqueada.
// Quem está editando vai no aviso logo abaixo (TabLockBanner).
export function TabLockChip({ lock }: { lock: TabLockInfo }) {
  return (
    <span title={lockTitle(lock)} className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-risk-high/50 bg-risk-high/15 px-3 py-1.5 text-[11px] font-semibold text-gray-100">
      <Lock size={12} strokeWidth={2.5} className="shrink-0 text-risk-high" />
      Bloqueada para edição
    </span>
  )
}

// Aviso acima da grade, em duas linhas: quem está editando (o nome inteiro,
// quebrando linha se precisar — nunca cortado) e o que isso significa.
// `dirty`: esta tela tem alteração não salva nesta guia (perdeu o bloqueio no
// meio da edição) — aí o aviso diz que ela não vai salvar.
export function TabLockBanner({ lock, dirty }: { lock: TabLockInfo; dirty: boolean }) {
  const since = sinceLabel(lock).trim()
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-risk-high/50 border-l-4 border-l-risk-high bg-risk-high/10 px-3.5 py-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-risk-high/20 text-risk-high">
        <Lock size={14} strokeWidth={2.5} />
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-[13px] leading-snug text-gray-100">
          {lock.self
            ? <><strong className="font-semibold">Você</strong> está editando esta guia em outra janela</>
            : <><strong className="font-semibold">{lock.name}</strong> está editando esta guia</>}
        </p>
        <p className="text-[11px] leading-snug text-gray-400">
          Guia bloqueada para edição{since ? ` ${since}` : ''}.{' '}
          {dirty
            ? 'O que você mudou aqui não pode ser salvo agora — descarte, ou espere a guia ficar livre.'
            : lock.self
              ? 'Salve ou descarte por lá para editar aqui.'
              : 'Você pode ver, mas não editar, até a edição terminar. A versão nova aparece aqui sozinha.'}
        </p>
      </div>
    </div>
  )
}
