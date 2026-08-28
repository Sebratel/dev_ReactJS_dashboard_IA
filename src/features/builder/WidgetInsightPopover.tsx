// "Como este gráfico foi feito e que história ele conta" — o popover de
// leitura, aberto pelo ícone no cabeçalho do widget.
//
// São duas coisas diferentes na mesma janela, e a diferença é o ponto:
//
//   • COMO FOI CALCULADO sai do WidgetConfig, aqui no navegador. Instantâneo,
//     sem custo, sempre disponível — e exato, porque não é uma descrição do
//     cálculo, é o cálculo (ver explainWidget.ts).
//   • O QUE OS DADOS DIZEM é interpretação, e aí sim a IA entra — sob demanda,
//     num clique, nunca sozinha ao abrir a tela. Um gráfico não pode custar
//     dinheiro só por estar na dashboard.
//
// A leitura pode ser FIXADA (salva no widget, para todo mundo). Fixar é editar
// a dashboard, então só aparece em modo edição e ainda depende do "Salvar",
// como qualquer outra alteração. Se os dados mudarem depois, o texto fixado não
// some nem passa por atual: ganha um aviso de que é de antes.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Sparkles, X, Loader2, Pin, RefreshCw, AlertTriangle } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAuthStore } from '@/store/authStore'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { describeCalculation, fingerprintPoints, type CalcLine } from './explainWidget'
import { fetchWidgetInsight, ApiError } from './ai/aiApi'
import type { FilterConfig, PinnedInsight, TabRelation, WidgetConfig } from './types'

const PANEL_WIDTH = 384 // w-96
const EDGE_MARGIN = 8

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function WidgetInsightPopover({ widget, tabFilters, relations, points, editMode, onPin, iconClassName, iconStyle }: {
  widget: WidgetConfig
  tabFilters: { filter: FilterConfig; values: string[] }[]
  relations: TabRelation[]
  // Os pontos que o widget JÁ desenhou. Servem só para a impressão digital que
  // detecta leitura fixada envelhecida — nenhuma consulta a mais por causa
  // disto, e os números que a IA lê vêm do servidor, não daqui.
  points: unknown
  editMode: boolean
  onPin?: (insight: PinnedInsight | undefined) => void
  iconClassName?: string
  iconStyle?: React.CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [usd, setUsd] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const userName = useAuthStore((s) => s.user?.name ?? undefined)

  const calc: CalcLine[] = describeCalculation(widget, tabFilters, relations)
  const fingerprint = fingerprintPoints(points)
  const pinned = widget.insight
  const pinnedStale = !!pinned && pinned.fingerprint !== fingerprint
  // O que está na tela: o texto gerado agora tem precedência sobre o fixado.
  const shown = text ?? pinned?.text ?? null
  const showingPinned = !text && !!pinned

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      const left = Math.min(Math.max(EDGE_MARGIN, rect.right - PANEL_WIDTH), window.innerWidth - PANEL_WIDTH - EDGE_MARGIN)
      setPos({ top: rect.bottom + 4, left })
    }
    setOpen((v) => !v)
  }

  // Sobe o painel quando ele não caberia inteiro abaixo do botão. Sem isto,
  // um widget na parte de baixo da tela abre um painel que vaza pra fora da
  // janela — e como ele é alto (e cresce mais ainda quando a leitura chega),
  // os botões "Gerar"/"Fixar" ficam inalcançáveis, sem barra de rolagem que
  // os traga de volta. Roda de novo a cada mudança de conteúdo justamente
  // porque a altura muda depois que o texto da IA carrega.
  useLayoutEffect(() => {
    if (!open || !pos || !panelRef.current) return
    const h = panelRef.current.offsetHeight
    const maxTop = window.innerHeight - EDGE_MARGIN - h
    if (pos.top > maxTop) setPos({ ...pos, top: Math.max(EDGE_MARGIN, maxTop) })
  }, [open, pos, shown, loading, error, pinnedStale])

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const generate = async (force: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const out = await fetchWidgetInsight({ widget, tabFilters, relations, calc, force })
      setText(out.text)
      setUsd(out.cached ? 0 : out.usd)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível gerar a leitura.')
    } finally {
      setLoading(false)
    }
  }

  const pin = () => {
    if (!shown) return
    onPin?.({ text: shown, at: new Date().toISOString(), by: userName, fingerprint })
  }

  // Widget de texto e afins não têm cálculo nem dado — o ícone nem aparece.
  if (!calc.length) return null

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); toggle() }}
        style={iconStyle}
        className={cn('relative h-6 w-6 flex items-center justify-center rounded-md hover:text-brand-cyan hover:bg-brand-cyan/10 shrink-0', iconClassName)}
        title="Como foi calculado e o que os dados dizem"
      >
        <Sparkles size={11} />
        {pinned && (
          <span className={cn(
            'absolute -top-0.5 -right-0.5 h-[7px] w-[7px] rounded-full ring-2 ring-app-card',
            pinnedStale ? 'bg-amber-500' : 'bg-brand-cyan',
          )} />
        )}
      </button>

      {open && pos && (
        <ModalPortal>
          <div
            ref={panelRef}
            className="fixed z-50 w-96 max-h-[70vh] flex flex-col rounded-xl border border-app-border bg-app-card shadow-lg overflow-hidden"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3.5 py-2.5 border-b border-app-border flex items-center justify-between shrink-0">
              <span className="text-[11px] font-semibold text-gray-200 truncate">{widget.title}</span>
              <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300 shrink-0"><X size={12} /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <section className="px-3.5 py-3">
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Como foi calculado</h4>
                <dl className="grid gap-1.5">
                  {calc.map((l, i) => (
                    <div key={i} className="flex gap-2 text-[11px] leading-snug">
                      <dt className="w-[88px] shrink-0 text-gray-500">{l.label}</dt>
                      <dd className="min-w-0 flex-1">
                        <span className="text-gray-200" title={l.value}>{l.value}</span>
                        {l.hint && <span className="mt-0.5 block text-[10px] leading-snug text-gray-500">{l.hint}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="border-t border-app-border px-3.5 py-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">O que os dados dizem</h4>
                  {showingPinned && (
                    <span className="shrink-0 text-[9px] text-gray-600">
                      fixada em {formatWhen(pinned!.at)}{pinned!.by ? ` por ${pinned!.by.split(' ')[0]}` : ''}
                    </span>
                  )}
                </div>

                {showingPinned && pinnedStale && (
                  <p className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-500/90">
                    <AlertTriangle size={11} className="mt-px shrink-0" />
                    Os dados mudaram desde esta leitura. Gere de novo para conferir se ela ainda vale.
                  </p>
                )}

                {error && <p className="mb-2 text-[11px] text-risk-critical">{error}</p>}

                {shown ? (
                  <p className="whitespace-pre-line text-[11.5px] leading-relaxed text-gray-300">{shown}</p>
                ) : !loading && !error ? (
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    A IA lê os números deste gráfico e escreve o que eles mostram. Roda só quando você pede.
                  </p>
                ) : null}

                {loading && (
                  <p className="flex items-center gap-2 text-[11px] text-gray-500">
                    <Loader2 size={12} className="animate-spin" /> Lendo o gráfico…
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => generate(!!shown)}
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand-blue px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-brand-blueLight disabled:opacity-40"
                  >
                    {shown ? <><RefreshCw size={11} /> Gerar de novo</> : <><Sparkles size={11} /> Gerar leitura</>}
                  </button>

                  {/* Fixar é alterar a dashboard: some fora do modo edição, e
                      mesmo dentro ainda depende do "Salvar" da barra. */}
                  {editMode && shown && (
                    <button
                      onClick={pin}
                      disabled={showingPinned && !pinnedStale}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-app-border px-2.5 py-1.5 text-[11px] font-medium text-gray-300 transition-colors hover:border-brand-cyan/40 hover:text-gray-100 disabled:opacity-40"
                      title={showingPinned && !pinnedStale ? 'Esta leitura já está fixada' : 'Salvar esta leitura no gráfico'}
                    >
                      <Pin size={11} /> Fixar
                    </button>
                  )}
                  {editMode && pinned && (
                    <button
                      onClick={() => onPin?.(undefined)}
                      className="text-[11px] text-gray-500 transition-colors hover:text-risk-critical"
                    >
                      Remover fixada
                    </button>
                  )}

                  {usd != null && (
                    <span className="ml-auto text-[9px] text-gray-600">
                      {usd > 0 ? `US$ ${usd.toFixed(3)}` : 'sem custo (cache)'}
                    </span>
                  )}
                </div>
              </section>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  )
}
