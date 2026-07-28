// Comentários/anotações de um widget (item 2.6 das sugestões) — ex. "esse
// pico em março foi por causa da campanha X". Qualquer usuário autenticado
// pode ler/comentar (não exige modo edição); remover é só de quem escreveu
// ou um admin — ver server/widgetComments.mjs.
import { useEffect, useRef, useState } from 'react'
import { MessageSquare, X, Send, Loader2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAuthStore } from '@/store/authStore'
import { ModalPortal } from '@/components/ui/ModalPortal'
import {
  fetchWidgetComments, addWidgetComment, deleteWidgetComment, ApiError, type WidgetComment,
} from './widgetCommentApi'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

const PANEL_WIDTH = 288 // w-72
const EDGE_MARGIN = 8

export function WidgetCommentsPopover({ widgetId, initialCount, iconClassName, iconStyle }: {
  widgetId: string
  initialCount?: number
  iconClassName?: string
  iconStyle?: React.CSSProperties
}) {
  const [open, setOpen] = useState(false)
  // Posição calculada a partir do botão (position: fixed, no portal) — nunca
  // null enquanto `open` é true.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [comments, setComments] = useState<WidgetComment[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const currentEmail = useAuthStore((s) => s.user?.email ?? null)
  const isAdmin = useAuthStore((s) => s.isAdmin)

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      const left = Math.min(Math.max(EDGE_MARGIN, rect.right - PANEL_WIDTH), window.innerWidth - PANEL_WIDTH - EDGE_MARGIN)
      setPos({ top: rect.bottom + 4, left })
    }
    setOpen((v) => !v)
  }

  // Card do widget tem `overflow: hidden` e um layout de grade estreito — o
  // painel precisa sair pra um portal em document.body (position: fixed),
  // senão fica cortado/espremido dentro dos limites do próprio widget (ver
  // relato do usuário com o painel amassado atrás do card vermelho).
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

  useEffect(() => {
    if (!open || comments !== null) return
    setLoading(true)
    fetchWidgetComments(widgetId)
      .then(setComments)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Erro ao carregar comentários.'))
      .finally(() => setLoading(false))
  }, [open, widgetId, comments])

  const send = async () => {
    if (!draft.trim()) return
    setSending(true)
    setError(null)
    try {
      const comment = await addWidgetComment(widgetId, draft)
      setComments((prev) => [...(prev ?? []), comment])
      setDraft('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao enviar comentário.')
    } finally {
      setSending(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await deleteWidgetComment(id)
      setComments((prev) => (prev ?? []).filter((c) => c.id !== id))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao remover comentário.')
    }
  }

  const count = comments?.length ?? initialCount ?? 0

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); toggle() }}
        style={iconStyle}
        className={cn('relative h-6 w-6 flex items-center justify-center rounded-md hover:text-brand-blue hover:bg-brand-blue/10 shrink-0', iconClassName)}
        title="Comentários"
      >
        <MessageSquare size={11} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[13px] h-[13px] px-0.5 rounded-full bg-brand-blue text-[8px] leading-[13px] text-white text-center font-semibold">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && pos && (
        <ModalPortal>
          <div
            ref={panelRef}
            className="fixed z-50 w-72 rounded-lg border border-app-border bg-app-card shadow-lg overflow-hidden"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-app-border flex items-center justify-between">
              <span className="text-[11px] font-semibold text-gray-300">Comentários</span>
              <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300"><X size={12} /></button>
            </div>
            <div className="max-h-52 overflow-y-auto divide-y divide-app-border/60">
              {loading && <div className="px-3 py-3 flex items-center gap-1.5 text-[11px] text-gray-500"><Loader2 size={12} className="animate-spin" /> Carregando…</div>}
              {!loading && comments?.length === 0 && <p className="px-3 py-3 text-[11px] text-gray-500">Nenhum comentário ainda.</p>}
              {comments?.map((c) => {
                const canRemove = isAdmin || c.authorEmail === currentEmail
                return (
                  <div key={c.id} className="px-3 py-2 group">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-[10px] font-semibold text-gray-400">{c.authorName}</span>
                      {canRemove && (
                        <button onClick={() => remove(c.id)} className="text-gray-600 opacity-0 group-hover:opacity-100 hover:text-risk-critical transition-opacity"><X size={10} /></button>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-300 whitespace-pre-wrap break-words mt-0.5">{c.text}</p>
                    <span className="text-[9px] text-gray-500">{formatWhen(c.createdAt)}</span>
                  </div>
                )
              })}
            </div>
            {error && <p className="px-3 pt-1.5 text-[10px] text-rose-400">{error}</p>}
            <div className="p-2 flex items-end gap-1.5 border-t border-app-border">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder="Escrever um comentário…"
                rows={1}
                className="flex-1 min-w-0 resize-none rounded-md border border-app-border bg-app-surface px-2 py-1.5 text-[11px] text-gray-200 outline-none focus:border-brand-blue/50"
              />
              <button
                onClick={send}
                disabled={sending || !draft.trim()}
                className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md bg-brand-blue text-white disabled:opacity-40"
              >
                {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              </button>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  )
}
