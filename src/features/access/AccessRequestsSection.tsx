// Pedidos de acesso a pastas feitos pela página "Manual de uso". Liberar põe o
// e-mail na lista de acesso da pasta (guias restritas continuam dependendo da
// liberação por guia); recusar só fecha o pedido — a pessoa pode pedir de novo.
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Inbox, Loader2, X } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { decideAccessRequest, fetchAccessRequests, ApiError, type AccessRequest } from './accessApi'

type Decision = 'approve' | 'reject'

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('pt-BR')
}

function confirmText(request: AccessRequest, decision: Decision) {
  const who = `${request.name} (${request.email})`
  return decision === 'approve'
    ? `Liberar a pasta "${request.folderName}" para ${who}? A pessoa passa a ver a pasta e as guias abertas dela; guias restritas continuam dependendo da liberação por guia.`
    : `Recusar o pedido de ${who} para a pasta "${request.folderName}"? A pessoa vê que foi recusado e pode pedir de novo.`
}

export function AccessRequestsSection({ reloadKey, onDecided }: { reloadKey: number; onDecided: () => void }) {
  const [requests, setRequests] = useState<AccessRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ request: AccessRequest; decision: Decision } | null>(null)

  useEffect(() => {
    let alive = true
    fetchAccessRequests('pending')
      .then((list) => { if (alive) { setRequests(list); setError(null) } })
      .catch((e: unknown) => { if (alive) setError(e instanceof ApiError ? e.message : 'Não foi possível carregar os pedidos.') })
    return () => { alive = false }
  }, [reloadKey])

  const decide = async (request: AccessRequest, decision: Decision) => {
    setConfirm(null)
    setBusyId(request.id)
    setError(null)
    try {
      await decideAccessRequest(request.id, decision)
      setRequests((prev) => prev && prev.filter((r) => r.id !== request.id))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível responder o pedido.')
    } finally {
      setBusyId(null)
      onDecided()
    }
  }

  const subtitle = requests === null ? 'Carregando…'
    : requests.length === 0 ? 'Nenhum pedido aguardando'
      : `${requests.length} aguardando resposta`

  return (
    <Card>
      <CardHeader icon={<Inbox size={14} />} title="Pedidos de acesso a pastas" subtitle={subtitle} />
      {error && <p className="flex items-center gap-2 px-5 pt-3 text-[12px] text-rose-300"><AlertTriangle size={14} /> {error}</p>}
      {requests === null && !error && (
        <div className="flex items-center gap-2 px-5 py-6 text-[12px] text-gray-400"><Loader2 size={14} className="animate-spin" /> Carregando…</div>
      )}
      {requests && requests.length === 0 && (
        <p className="text-[11px] text-gray-500 text-center py-6">Quando alguém pedir acesso a uma pasta pela página Manual de uso, o pedido aparece aqui.</p>
      )}
      {requests && requests.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-app-border">
                <th className="text-left font-semibold px-5 py-2">Pedido em</th>
                <th className="text-left font-semibold px-3 py-2">Usuário</th>
                <th className="text-left font-semibold px-3 py-2">Pasta</th>
                <th className="text-left font-semibold px-3 py-2">Mensagem</th>
                <th className="text-right font-semibold px-5 py-2">Resposta</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-b border-app-border/60 last:border-0 align-top">
                  <td className="px-5 py-2.5 text-gray-500 whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-gray-200">{r.name}</div>
                    <div className="text-[10px] text-gray-500 font-mono">{r.email}</div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-200 font-medium">{r.folderName}</td>
                  <td className="px-3 py-2.5 text-gray-400 max-w-[320px] whitespace-pre-wrap break-words">
                    {r.message ?? <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-5 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => setConfirm({ request: r, decision: 'approve' })}
                        className="flex items-center gap-1 rounded-md bg-brand-blue px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-blueLight disabled:opacity-50"
                      >
                        <Check size={12} /> Liberar
                      </button>
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => setConfirm({ request: r, decision: 'reject' })}
                        className="flex items-center gap-1 rounded-md border border-app-border px-2.5 py-1 text-[11px] text-gray-300 hover:border-risk-critical/50 hover:text-rose-300 disabled:opacity-50"
                      >
                        <X size={12} /> Recusar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.decision === 'approve' ? 'Liberar acesso à pasta' : 'Recusar pedido de acesso'}
          message={confirmText(confirm.request, confirm.decision)}
          confirmLabel={confirm.decision === 'approve' ? 'Liberar' : 'Recusar'}
          danger={confirm.decision === 'reject'}
          onConfirm={() => void decide(confirm.request, confirm.decision)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Card>
  )
}
