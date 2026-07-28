// Aba de gestão de acessos (só administradores, ver server/accessLog.mjs):
// quem já acessou, quem está online agora, o log de ações realizadas na
// plataforma, e o papel (admin/padrão) de cada um. Atualiza sozinha a cada 20s.
import { useEffect, useState } from 'react'
import { Users, ScrollText, Loader2, AlertTriangle, RefreshCw } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAuthStore } from '@/store/authStore'
import { cn } from '@/utils/cn'
import { fetchUsers, fetchAuditLog, setUserRole, ApiError, type AccessUser, type AuditLogEntry, type UserRole } from './accessApi'

const POLL_MS = 20_000

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'query.create': 'Criou query',
  'query.update': 'Editou query',
  'query.delete': 'Removeu query',
  'query.reset': 'Restaurou catálogo de queries',
  'query.enable': 'Ativou query',
  'query.disable': 'Desativou query',
  'query.refresh': 'Alterou atualização da query',
  'query.folders.update': 'Alterou pastas liberadas da query',
  'dashboard.save': 'Salvou dashboard',
  'dashboard.reset': 'Restaurou dashboard padrão',
  'user.promote': 'Promoveu a administrador',
  'user.demote': 'Removeu privilégio de administrador',
  'folder.create': 'Criou pasta',
  'folder.update': 'Editou pasta',
  'folder.delete': 'Removeu pasta',
  'folder.access.update': 'Alterou acesso da pasta',
  'folder.managers.update': 'Alterou gerentes da pasta',
  'workspace.dashboard.create': 'Criou dashboard',
  'workspace.dashboard.update': 'Editou dashboard',
  'workspace.dashboard.delete': 'Removeu dashboard',
  'tab.widgets.save': 'Editou widgets de uma guia',
  'tab.access.update': 'Alterou acesso de uma guia',
  'sheetSource.create': 'Cadastrou planilha do Google',
  'sheetSource.update': 'Editou planilha do Google',
  'sheetSource.delete': 'Removeu planilha do Google',
  'fieldDictionary.update': 'Editou descrição de campo (dicionário de dados)',
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('pt-BR')
}

// Pill de duas posições — mesmo espírito do Toggle de SettingsPage.tsx, só
// que com dois rótulos (não um liga/desliga), então é um par de botões.
function RolePill({ role, disabled, onChange }: { role: UserRole; disabled?: boolean; onChange: (r: UserRole) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-app-border p-0.5 gap-0.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('standard')}
        className={cn('px-2 py-1 rounded-md text-[10px] font-semibold transition-colors disabled:opacity-50', role === 'standard' ? 'bg-app-border text-gray-100' : 'text-gray-500 hover:text-gray-300')}
      >
        Padrão
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('admin')}
        className={cn('px-2 py-1 rounded-md text-[10px] font-semibold transition-colors disabled:opacity-50', role === 'admin' ? 'bg-brand-blue text-white' : 'text-gray-500 hover:text-gray-300')}
      >
        Admin
      </button>
    </div>
  )
}

function UsersSection({ users, currentEmail, savingEmail, onRequestRoleChange }: {
  users: AccessUser[]
  currentEmail: string | null
  savingEmail: string | null
  onRequestRoleChange: (user: AccessUser, role: UserRole) => void
}) {
  const online = users.filter((u) => u.online)
  return (
    <Card>
      <CardHeader
        icon={<Users size={14} />}
        title="Usuários"
        subtitle={`${users.length} já acessaram · ${online.length} online agora`}
      />
      {users.length === 0 ? (
        <p className="text-[11px] text-gray-500 text-center py-8">Ninguém acessou ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-app-border">
                <th className="text-left font-semibold px-5 py-2">Status</th>
                <th className="text-left font-semibold px-3 py-2">Nome</th>
                <th className="text-left font-semibold px-3 py-2">E-mail</th>
                <th className="text-left font-semibold px-3 py-2">Primeiro acesso</th>
                <th className="text-left font-semibold px-3 py-2">Último acesso</th>
                <th className="text-left font-semibold px-3 py-2">Papel</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email} className="border-b border-app-border/60 last:border-0">
                  <td className="px-5 py-2.5">
                    <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-semibold', u.online ? 'text-emerald-400' : 'text-gray-500')}>
                      <span className="relative flex h-2 w-2">
                        {u.online && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
                        <span className={cn('relative inline-flex rounded-full h-2 w-2', u.online ? 'bg-emerald-500' : 'bg-gray-600')} />
                      </span>
                      {u.online ? 'Online' : 'Offline'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-200 font-medium">
                    {u.name} {u.email === currentEmail && <span className="text-[10px] text-gray-500 font-normal">(você)</span>}
                  </td>
                  <td className="px-3 py-2.5 text-gray-400 font-mono">{u.email}</td>
                  <td className="px-3 py-2.5 text-gray-500">{fmtDateTime(u.firstSeenAt)}</td>
                  <td className="px-3 py-2.5 text-gray-500">{fmtDateTime(u.lastSeenAt)}</td>
                  <td className="px-3 py-2.5">
                    <RolePill role={u.role} disabled={savingEmail === u.email} onChange={(role) => onRequestRoleChange(u, role)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function AuditLogSection({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <Card>
      <CardHeader icon={<ScrollText size={14} />} title="Log de ações" subtitle={`Últimas ${entries.length} ações registradas`} />
      {entries.length === 0 ? (
        <p className="text-[11px] text-gray-500 text-center py-8">Nenhuma ação registrada ainda.</p>
      ) : (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto scrollbar-thin">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-app-card">
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-app-border">
                <th className="text-left font-semibold px-5 py-2">Data/hora</th>
                <th className="text-left font-semibold px-3 py-2">Usuário</th>
                <th className="text-left font-semibold px-3 py-2">Ação</th>
                <th className="text-left font-semibold px-3 py-2">Alvo</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className="border-b border-app-border/60 last:border-0">
                  <td className="px-5 py-2.5 text-gray-500 whitespace-nowrap">{fmtDateTime(e.ts)}</td>
                  <td className="px-3 py-2.5 text-gray-300">
                    <div className="font-medium text-gray-200">{e.name ?? '—'}</div>
                    <div className="text-[10px] text-gray-500 font-mono">{e.email ?? '—'}</div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-200">{ACTION_LABELS[e.action] ?? e.action}</td>
                  <td className="px-3 py-2.5 text-gray-500 font-mono">{e.target ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export default function AccessPage() {
  const currentEmail = useAuthStore((s) => s.user?.email ?? null)
  const [users, setUsers] = useState<AccessUser[] | null>(null)
  const [log, setLog] = useState<AuditLogEntry[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [savingEmail, setSavingEmail] = useState<string | null>(null)
  const [roleError, setRoleError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<{ user: AccessUser; role: UserRole } | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([fetchUsers(), fetchAuditLog(300)])
      .then(([u, l]) => { if (alive) { setUsers(u.users); setLog(l); setError(null) } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'Erro inesperado.')) })
    return () => { alive = false }
  }, [reloadKey])

  useEffect(() => {
    const id = setInterval(() => setReloadKey((k) => k + 1), POLL_MS)
    return () => clearInterval(id)
  }, [])

  const applyRoleChange = async (user: AccessUser, role: UserRole) => {
    setConfirmState(null)
    setSavingEmail(user.email)
    setRoleError(null)
    // Otimista — reflete na hora; se falhar (ex.: último admin), recarrega
    // do servidor pra desfazer, mesmo padrão do toggle de query em Settings.
    setUsers((prev) => prev && prev.map((u) => (u.email === user.email ? { ...u, role } : u)))
    try {
      const saved = await setUserRole(user.email, role)
      setUsers((prev) => prev && prev.map((u) => (u.email === user.email ? saved : u)))
    } catch (e) {
      setRoleError(e instanceof ApiError ? e.message : 'Falha ao atualizar o papel do usuário.')
      setReloadKey((k) => k + 1)
    } finally {
      setSavingEmail(null)
    }
  }

  if (error && !users) {
    return (
      <div className="rounded-xl border border-app-border bg-app-card px-5 py-6 space-y-3 animate-slide-up">
        <div className="flex items-start gap-2.5 text-sm text-rose-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-gray-100">Não foi possível carregar os dados de acesso</p>
            <p className="mt-0.5 text-[12px] text-gray-400">{error.message}</p>
          </div>
        </div>
        <button onClick={() => setReloadKey((k) => k + 1)} className="flex items-center gap-1.5 rounded-md border border-app-border px-3 py-1.5 text-[12px] text-gray-300 hover:border-app-borderLight hover:text-gray-100 transition-colors">
          <RefreshCw size={13} /> Tentar novamente
        </button>
      </div>
    )
  }

  if (!users || !log) {
    return <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-card px-5 py-16 text-sm text-gray-400 animate-slide-up"><Loader2 size={16} className="animate-spin" /> Carregando…</div>
  }

  return (
    <div className="space-y-5 animate-slide-up">
      {roleError && (
        <div className="flex items-start gap-2.5 rounded-xl border border-risk-critical/30 bg-risk-critical/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>{roleError}</p>
        </div>
      )}
      <UsersSection
        users={users}
        currentEmail={currentEmail}
        savingEmail={savingEmail}
        onRequestRoleChange={(user, role) => setConfirmState({ user, role })}
      />
      <AuditLogSection entries={log} />

      {confirmState && (
        <ConfirmDialog
          title={confirmState.role === 'admin' ? 'Tornar administrador' : 'Remover privilégio de administrador'}
          message={
            confirmState.role === 'admin'
              ? `Dar acesso de administrador (aba Acessos) para ${confirmState.user.name} (${confirmState.user.email})?`
              : `Remover o acesso de administrador de ${confirmState.user.name} (${confirmState.user.email})? A pessoa deixa de ver a aba Acessos.`
          }
          confirmLabel={confirmState.role === 'admin' ? 'Tornar admin' : 'Remover'}
          danger={confirmState.role === 'standard'}
          onConfirm={() => applyRoleChange(confirmState.user, confirmState.role)}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  )
}
