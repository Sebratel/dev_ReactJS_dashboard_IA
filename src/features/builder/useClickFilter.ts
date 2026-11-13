// Estado e ganchos do filtro por clique (a lógica pura está em clickFilter.ts).
//
// Separado dos filtros do topo de propósito: aqueles são escolha deliberada,
// configurada na guia; este é o clique do momento. Não persiste e some ao
// trocar de guia ou de dashboard, ao entrar no modo edição e ao sair da tela —
// um clique de ontem reaparecendo filtrado hoje seria um filtro que ninguém
// lembra de ter posto.
import { useCallback, useEffect, useMemo, type MouseEvent as ReactMouseEvent } from 'react'
import { create } from 'zustand'
import { getSourceDef } from './fieldCatalog'
import {
  NO_SELECTION, applyClick, condsOf, hasSelection, isLit,
  type ClickCond, type ClickItem, type ClickSelection, type DateBucket, type FieldContext,
} from './clickFilter'
import type { TabRelation, WidgetConfig } from './types'

interface ClickFilterState {
  selection: ClickSelection
  /** Um clique num item do widget; `multi` = Ctrl (ou Cmd) pressionado. */
  click: (widgetId: string, item: ClickItem, multi: boolean) => void
  clear: () => void
}

export const useClickFilterStore = create<ClickFilterState>((set) => ({
  selection: NO_SELECTION,
  click: (widgetId, item, multi) => set((s) => ({ selection: applyClick(s.selection, widgetId, item, { multi }) })),
  clear: () => set((s) => (s.selection === NO_SELECTION ? s : { selection: NO_SELECTION })),
}))

const BUCKET_SUFFIX: Record<DateBucket, string> = { year: 'Ano', quarter: 'Trimestre', month: 'Mês', day: 'Dia' }

/** O nome de um campo como a tela mostra ("Região", "Data de abertura · Mês"). */
export function clickFieldLabel(source: string, field: string, bucket?: DateBucket): string {
  const base = getSourceDef(source)?.fields.find((f) => f.key === field)?.label ?? field
  return bucket ? `${base} · ${BUCKET_SUFFIX[bucket]}` : base
}

/** Lista vazia compartilhada: um `[]` novo a cada leitura do store re-renderizaria sem fim. */
const NONE: readonly ClickItem[] = []

/** O mínimo de um evento de clique que a seleção precisa. */
export type ClickEvent = Pick<ReactMouseEvent, 'ctrlKey' | 'metaKey' | 'stopPropagation'>

/** O que um widget precisa para participar do filtro por clique. */
export interface WidgetClick {
  /** Há algo clicado NESTE widget — os elementos fora da seleção esmaecem. */
  active: boolean
  /** As condições de um grupo do widget (ver condsOf). */
  conds: (dimensions: readonly string[] | undefined, rawKey: string, sep?: string) => ClickCond[] | null
  /** Clicou num elemento. Sem condições, não faz nada (e o clique segue como "clicar fora"). */
  select: (conds: readonly ClickCond[] | null, e: ClickEvent) => void
  /** O elemento está aceso? (ver isLit) */
  lit: (conds: readonly ClickCond[] | null) => boolean
}

// KPI e texto não têm elemento para clicar; o histograma agrupa por faixa de
// número, que filtro de guia nenhum expressa.
const CLICKABLE = new Set<WidgetConfig['type']>(['bar', 'barH', 'barStacked', 'barHStacked', 'comboBarLine', 'line', 'area', 'pie', 'scatter', 'funnel', 'table', 'matrix'])

/**
 * O filtro por clique de um widget. `undefined` quando ele não participa —
 * fora do modo visualização, ou um tipo sem elemento clicável.
 *
 * O clique para de propagar aqui: sem isso ele chegaria à página, que
 * entende clique que sobe até ela como "clicou fora" e limparia a seleção no
 * mesmo instante em que ela foi feita.
 */
export function useWidgetClick(widget: WidgetConfig, relations: readonly TabRelation[], enabled: boolean): WidgetClick | undefined {
  const items = useClickFilterStore((s) => s.selection[widget.id] ?? NONE)
  const click = useClickFilterStore((s) => s.click)

  const ctx = useMemo<FieldContext | null>(() => {
    if (!widget.source) return null
    const related = new Set<string>()
    for (const r of relations) {
      if (r.sourceA === widget.source) related.add(r.sourceB)
      if (r.sourceB === widget.source) related.add(r.sourceA)
    }
    for (const lk of widget.lookups ?? []) related.add(lk.source)
    return { source: widget.source, relatedSources: [...related] }
  }, [widget.source, widget.lookups, relations])

  return useMemo(() => {
    if (!enabled || !ctx || !CLICKABLE.has(widget.type)) return undefined
    return {
      active: items.length > 0,
      conds: (dimensions, rawKey, sep) => condsOf(dimensions, rawKey, ctx, sep),
      select: (conds, e) => {
        if (!conds?.length) return
        e.stopPropagation()
        click(widget.id, { conds }, e.ctrlKey || e.metaKey)
      },
      lit: (conds) => isLit(items, conds),
    }
  }, [enabled, ctx, widget.type, widget.id, items, click])
}

/**
 * Elementos cujo clique é deles, e não um "clique fora": controles (filtros
 * do topo, ordenação, paginação, os botões do widget) e o que a tela marcar
 * com `data-click-keep` (o balão do filtro).
 */
const CONTROLS =
  'button, a, input, select, textarea, label, [role="option"], [role="listbox"], [role="combobox"], [role="dialog"], [role="menu"], [data-click-keep]'

/**
 * Onde o Esc já tem dono: campos, listas suspensas, diálogos. Botão comum
 * NÃO entra — depois de clicar, o foco pode ficar num botão, e é ali que se
 * aperta Esc para desfazer.
 */
const ESC_OWNERS = 'input, select, textarea, [role="listbox"], [role="combobox"], [role="dialog"], [data-click-keep]'

const inside = (target: EventTarget | null, selector: string) => target instanceof Element && target.closest(selector) !== null

/**
 * Limpa o filtro por clique quando se clica FORA de um elemento clicável, ou
 * com Esc — e ao sair da tela.
 *
 * Devolve o `onClick` para o contêiner da guia. Os elementos clicáveis param a
 * propagação (ver useWidgetClick), então o que chega aqui é clique em espaço
 * vazio, título de widget, área do gráfico sem barra… — o "fora" do Power BI.
 * Duas exceções, para não apagar o filtro de quem não pediu: controles e
 * texto selecionado (quem arrastou para copiar um valor não clicou fora).
 */
export function useClearClickFilterOnOutside() {
  const active = useClickFilterStore((s) => hasSelection(s.selection))
  const clear = useClickFilterStore((s) => s.clear)

  useEffect(() => clear, [clear])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !inside(e.target, ESC_OWNERS)) clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, clear])

  return useCallback((e: ReactMouseEvent) => {
    if (!active || inside(e.target, CONTROLS)) return
    if (window.getSelection()?.toString()) return
    clear()
  }, [active, clear])
}
