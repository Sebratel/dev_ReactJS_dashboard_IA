// Pastas do sistema na página "Manual de uso", com o acesso de quem está vendo
// e o pedido de acesso ao administrador (GET /api/access/folders e POST
// /api/access/requests). Só nome e status — o conteúdo de uma pasta continua
// invisível até ela ser liberada.
import { useCallback, useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Folder, Loader2, Send, XCircle } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { useAuthStore } from '@/store/authStore'
import { useWorkspaceStore } from '@/store/workspaceStore'
import { fetchFolderCatalog, requestFolderAccess, ApiError, type FolderCatalogEntry } from '@/features/access/accessApi'

// Relê o catálogo de tempos em tempos: um pedido liberado aparece aqui (e no
// menu lateral) sem a pessoa precisar recarregar a página.
const POLL_MS = 30_000
const MAX_MESSAGE = 500

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('pt-BR')
}

function StatusChip({ folder }: { folder: FolderCatalogEntry }) {
  const base = 'inline-flex items-center gap-1 text-[10px] font-semibold'
  if (folder.hasAccess) return <span className={`${base} text-emerald-400`}><CheckCircle2 size={12} /> Liberada</span>
  if (folder.request?.status === 'pending') {
    return <span className={`${base} text-amber-400`}><Clock size={12} /> Pedido enviado em {fmtDate(folder.request.createdAt)}</span>
  }
  if (folder.request?.status === 'rejected') {
    return <span className={`${base} text-rose-300`}><XCircle size={12} /> Recusado em {fmtDate(folder.request.decidedAt ?? folder.request.createdAt)}</span>
  }
  return <span className={`${base} text-gray-500`}>Sem acesso</span>
}

export function FolderAccessList() {
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const tree = useWorkspaceStore((s) => s.folders)
  const refreshTree = useWorkspaceStore((s) => s.refresh)
  const [folders, setFolders] = useState<FolderCatalogEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formFor, setFormFor] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetchFolderCatalog()
      .then((list) => { setFolders(list); setLoadError(null) })
      .catch((e: unknown) => setLoadError(e instanceof ApiError ? e.message : 'Não foi possível carregar as pastas.'))
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // Pasta liberada com a página aberta: o menu lateral só conhece as pastas
  // que já enxergava, então é ele que precisa ser relido.
  useEffect(() => {
    if (!folders || !tree) return
    const known = new Set(tree.map((f) => f.id))
    if (folders.some((f) => f.hasAccess && !known.has(f.id))) void refreshTree()
  }, [folders, tree, refreshTree])

  const openForm = (id: string) => {
    setFormFor(id)
    setMessage('')
    setSendError(null)
  }

  const send = async (folder: FolderCatalogEntry) => {
    setSending(true)
    setSendError(null)
    try {
      const r = await requestFolderAccess(folder.id, message)
      const request = { id: r.id, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt }
      setFolders((prev) => prev && prev.map((f) => (f.id === folder.id ? { ...f, request } : f)))
      setFormFor(null)
    } catch (e) {
      setSendError(e instanceof ApiError ? e.message : 'Não foi possível enviar o pedido.')
      load()
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<Folder size={14} />}
        title="Pastas do sistema"
        subtitle={isAdmin
          ? 'Como administrador, você já vê todas. Os pedidos de acesso chegam na aba Acessos.'
          : 'Peça acesso à pasta da sua área — o pedido vai para o administrador.'}
      />
      {loadError && !folders && (
        <p className="flex items-center gap-2 px-5 py-6 text-[12px] text-rose-300"><AlertTriangle size={14} /> {loadError}</p>
      )}
      {!folders && !loadError && (
        <div className="flex items-center gap-2 px-5 py-6 text-[12px] text-gray-400"><Loader2 size={14} className="animate-spin" /> Carregando pastas…</div>
      )}
      {folders && folders.length === 0 && <p className="px-5 py-6 text-[12px] text-gray-500">Nenhuma pasta foi criada ainda.</p>}
      {folders && folders.length > 0 && (
        <ul className="divide-y divide-app-border/60">
          {folders.map((f) => {
            const dashboard = f.hasAccess ? tree?.find((t) => t.id === f.id)?.dashboards[0] : undefined
            const canRequest = !f.hasAccess && f.request?.status !== 'pending'
            return (
              <li key={f.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Folder size={15} className="shrink-0 text-primary" />
                  <span className="text-xs font-semibold text-gray-100">{f.name}</span>
                  <StatusChip folder={f} />
                  <div className="ml-auto flex items-center gap-2">
                    {dashboard && (
                      <NavLink to={`/dashboard/${f.id}/${dashboard.id}`} className="flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:underline">
                        Abrir <ArrowRight size={12} />
                      </NavLink>
                    )}
                    {f.hasAccess && !dashboard && <span className="text-[10px] text-gray-500">Ainda sem dashboards</span>}
                    {canRequest && formFor !== f.id && (
                      <button
                        type="button"
                        onClick={() => openForm(f.id)}
                        className="rounded-lg border border-app-border px-2.5 py-1 text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue transition-colors"
                      >
                        {f.request?.status === 'rejected' ? 'Pedir de novo' : 'Solicitar acesso'}
                      </button>
                    )}
                  </div>
                </div>
                {formFor === f.id && (
                  <form onSubmit={(e) => { e.preventDefault(); void send(f) }} className="mt-2.5 space-y-2">
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      maxLength={MAX_MESSAGE}
                      rows={2}
                      autoFocus
                      placeholder="Conte ao administrador para que você precisa desta pasta (opcional)"
                      className="w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-brand-blue/60"
                    />
                    {sendError && <p className="text-[11px] text-rose-300">{sendError}</p>}
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={sending}
                        className="flex items-center gap-1.5 rounded-lg bg-brand-blue px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-blueLight disabled:opacity-60"
                      >
                        {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Enviar pedido
                      </button>
                      <button type="button" onClick={() => setFormFor(null)} className="rounded-lg border border-app-border px-3 py-1.5 text-[11px] text-gray-300 hover:border-app-borderLight">
                        Cancelar
                      </button>
                      <span className="ml-auto text-[10px] text-gray-500 tabular-nums">{message.length}/{MAX_MESSAGE}</span>
                    </div>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
