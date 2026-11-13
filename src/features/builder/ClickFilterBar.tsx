import { FilterX, MousePointerClick } from 'lucide-react'
import { describeItem, selectionItems, type ClickCond } from './clickFilter'
import { clickFieldLabel, useClickFilterStore } from './useClickFilter'

/** Quantos itens o balão mostra antes de resumir em "+N". */
const MAX_VISIBLE = 4

/**
 * O balão que diz se a guia está filtrada por clique, e por quê.
 *
 * Existe porque o widget onde se clicou pode estar fora da tela: quem clicou
 * numa cidade lá em cima e desceu até a tabela precisa saber, ali, que ela
 * está recortada. Por isso flutua no rodapé, à vista em qualquer ponto da
 * rolagem — e, fora do fluxo, aparece sem empurrar nada: a barra em que se
 * clicou continua debaixo do cursor. Com muitos itens, resume em vez de
 * quebrar linha.
 *
 * O contêiner fica sempre montado, vazio sem filtro: é a região `aria-live`
 * que anuncia o filtro quando ele aparece — uma região que nasce junto com o
 * conteúdo não é lida.
 */
export function ClickFilterBar() {
  const selection = useClickFilterStore((s) => s.selection)
  const clear = useClickFilterStore((s) => s.clear)

  const items = selectionItems(selection)
  const visible = items.slice(0, MAX_VISIBLE)
  const hidden = items.length - visible.length
  const label = (c: ClickCond) => clickFieldLabel(c.source, c.field, c.bucket)

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      {items.length === 0 ? null : (
        // `data-click-keep`: clicar no balão não é "clicar fora" — daqui, só o
        // botão Limpar desfaz o filtro.
        <div
          data-click-keep
          className="pointer-events-auto flex h-10 min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-full border border-app-border bg-app-card pl-3 pr-1.5 text-xs shadow-xl"
        >
          <MousePointerClick size={15} className="shrink-0 text-brand-blue" aria-hidden />
          <span className="shrink-0 font-semibold text-gray-100">Filtro por clique:</span>
          {visible.map((item) => {
            const text = describeItem(item, label)
            return (
              <span key={text} title={text} className="min-w-0 max-w-72 shrink truncate rounded-full bg-brand-blue/15 px-2.5 py-1 font-semibold text-gray-100">
                {text}
              </span>
            )
          })}
          {hidden > 0 && <span className="shrink-0 font-semibold text-gray-400">+{hidden}</span>}
          <button
            type="button"
            onClick={clear}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-semibold text-gray-400 transition-colors hover:bg-app-surface hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          >
            <FilterX size={13} aria-hidden />
            Limpar
          </button>
        </div>
      )}
    </div>
  )
}
