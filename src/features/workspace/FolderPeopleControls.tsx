// Quem entra na pasta e quem a gerencia — só administrador vê (ver
// FolderSettingsModal). UMA lista de pessoas com duas caixas por linha,
// "Acesso" e "Gerente", e um "Salvar" só. Antes eram duas listas separadas,
// cada uma com etiquetas, busca e salvar próprios: a mesma pessoa aparecia
// duas vezes e era difícil ver, de relance, quem tinha o quê.
//
// As pessoas vêm de quem já acessou o sistema (GET /api/access/users), nunca de
// e-mail digitado. Um e-mail salvo que não está entre elas (liberado antes do
// primeiro acesso — ou digitado errado) aparece no topo, marcado "nunca
// entrou": se a pessoa já usa o app, o e-mail está diferente do login dela e
// ela fica sem o acesso, sem nada na tela dela que diga por quê.
import { useMemo, useState } from 'react'
import { AlertTriangle, Globe, Loader2, Lock, Search, ShieldCheck, Users } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ApiError } from './workspaceApi'
import type { Folder } from './types'
import { inputCls, pillCls, saveButtonCls } from './folderStyles'

export interface FolderUser {
  email: string
  name: string
  role?: 'admin' | 'standard'
}

// A lista de usuários vem do modal: null enquanto carrega.
export interface KnownUsers {
  users: FolderUser[] | null
  error: string | null
}

type Filter = 'all' | 'access' | 'managers'

// Busca sem acento e sem maiúscula: "joao" acha "João".
function normalize(text: string) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function sameSet(a: Iterable<string>, b: Iterable<string>) {
  const x = new Set(a)
  const y = new Set(b)
  return x.size === y.size && [...x].every((v) => y.has(v))
}

export function FolderPeople({ folder, known, onSave }: {
  folder: Folder
  known: KnownUsers
  onSave: (next: { accessEmails: string[] | null; managers: string[] }) => Promise<void>
}) {
  const initialOpen = folder.accessEmails === null
  const [open, setOpen] = useState(initialOpen)
  const [access, setAccess] = useState<Set<string>>(() => new Set(folder.accessEmails ?? []))
  const [managers, setManagers] = useState<Set<string>>(() => new Set(folder.managers))
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Linhas: quem nunca entrou primeiro (é o que pede atenção), depois quem já
  // tinha acesso ou gerência quando a lista abriu, depois o resto — ordem
  // fixada na abertura, pra linha não pular de lugar a cada clique.
  const rows = useMemo(() => {
    const users = known.users ?? []
    const byEmail = new Map(users.map((u) => [u.email, u]))
    const saved = new Set([...(folder.accessEmails ?? []), ...folder.managers])
    const unknown = [...saved].filter((e) => !byEmail.has(e)).sort()
      .map((email) => ({ email, name: email, role: undefined, known: false }))
    const sorted = [...users].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    const withSomething = sorted.filter((u) => saved.has(u.email))
    const rest = sorted.filter((u) => !saved.has(u.email))
    return [...unknown, ...[...withSomething, ...rest].map((u) => ({ ...u, known: true }))]
  }, [known.users, folder.accessEmails, folder.managers])

  const hasAccess = (email: string, role?: string) => open || role === 'admin' || managers.has(email) || access.has(email)
  const q = normalize(query.trim())
  const visible = rows.filter((r) => {
    if (q && !normalize(r.name).includes(q) && !r.email.includes(q)) return false
    if (filter === 'access') return hasAccess(r.email, r.role)
    if (filter === 'managers') return managers.has(r.email)
    return true
  })
  const accessCount = open ? null : rows.filter((r) => hasAccess(r.email, r.role)).length
  const neverLogged = rows.filter((r) => !r.known && (access.has(r.email) || managers.has(r.email)))

  const dirty = open !== initialOpen
    || (!open && !sameSet(access, folder.accessEmails ?? []))
    || !sameSet(managers, folder.managers)

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, email: string) => {
    const next = new Set(set)
    if (next.has(email)) next.delete(email)
    else next.add(email)
    setter(next)
  }

  const save = async () => {
    setSaving(true); setError(null); setSaved(false)
    try {
      await onSave({ accessEmails: open ? null : [...access], managers: [...managers] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500"><Users size={11} /> Pessoas da pasta</span>
        <span className="text-[10px] text-gray-500">
          {accessCount === null ? 'todos com acesso' : `${accessCount} com acesso`} · {managers.size} {managers.size === 1 ? 'gerente' : 'gerentes'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setOpen(false)} className={pillCls(!open)}><Lock size={11} /> Restrita</button>
        <button type="button" onClick={() => setOpen(true)} className={pillCls(open)}><Globe size={11} /> Aberta a todos</button>
        <span className="text-[10px] text-gray-500">
          {open ? 'Qualquer pessoa logada vê a pasta.' : 'Só quem estiver marcado em Acesso (e administradores) vê a pasta.'}
        </span>
      </div>

      {known.error ? (
        <p className="text-[11px] text-risk-critical">{known.error}</p>
      ) : !known.users ? (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-500"><Loader2 size={11} className="animate-spin" /> Carregando usuários…</p>
      ) : (
        <>
          {neverLogged.length > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg border border-risk-high/40 bg-risk-high/10 px-2.5 py-1.5 text-[10px] leading-snug text-gray-200">
              <AlertTriangle size={11} className="mt-px shrink-0 text-risk-high" />
              <span>
                {neverLogged.length === 1 ? 'Um e-mail marcado nunca entrou' : `${neverLogged.length} e-mails marcados nunca entraram`} no sistema
                (no topo da lista). Se a pessoa ainda vai entrar pela primeira vez, tudo certo. Se ela <strong className="font-semibold">já usa o app</strong>,
                o e-mail está diferente do login dela e ela fica sem este acesso — desmarque e marque a pessoa certa.
              </span>
            </p>
          )}

          <div className="flex items-center gap-1.5">
            <label className={cn(inputCls, 'flex flex-1 items-center gap-1.5 py-1')}>
              <Search size={12} className="shrink-0 text-gray-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nome ou e-mail…"
                aria-label="Buscar pessoa"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-gray-500"
              />
            </label>
            {(['all', 'access', 'managers'] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={cn(pillCls(filter === f), 'shrink-0 py-1')}>
                {f === 'all' ? 'Todos' : f === 'access' ? 'Com acesso' : 'Gerentes'}
              </button>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-app-border">
            <div className="grid grid-cols-[1fr_4rem_4rem] items-center gap-2 border-b border-app-border bg-app-surface px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              <span>Pessoa</span>
              <span className="text-center" title="Vê a pasta e as guias liberadas para ela">Acesso</span>
              <span className="flex items-center justify-center gap-1" title="Cria dashboards e libera o acesso das guias desta pasta"><ShieldCheck size={10} /> Gerente</span>
            </div>
            <div className="max-h-72 divide-y divide-app-border/60 overflow-y-auto scrollbar-thin">
              {visible.length === 0 && (
                <p className="px-3 py-3 text-[11px] text-gray-500">
                  {rows.length === 0 ? 'Ninguém acessou o sistema ainda.' : q ? `Ninguém encontrado com “${query.trim()}”.` : 'Ninguém neste filtro.'}
                </p>
              )}
              {visible.map((r) => {
                const isAdmin = r.role === 'admin'
                const isManager = managers.has(r.email)
                // Acesso implícito: pasta aberta, administrador ou gerente
                // sempre veem — a caixa fica marcada e travada, com o motivo.
                const implied = open ? 'Pasta aberta: todo mundo vê.' : isAdmin ? 'Administrador sempre vê a pasta.' : isManager ? 'Gerente sempre vê a pasta.' : null
                const accessOn = implied ? true : access.has(r.email)
                return (
                  <div key={r.email} className={cn('grid grid-cols-[1fr_4rem_4rem] items-center gap-2 px-3 py-1.5', !r.known && 'bg-risk-high/5')}>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-[12px] text-gray-100">
                        {!r.known && <AlertTriangle size={11} className="shrink-0 text-risk-high" />}
                        <span className="truncate">{r.known ? r.name : r.email}</span>
                        {isAdmin && <span className="shrink-0 text-[9px] font-bold uppercase text-brand-blue">admin</span>}
                      </p>
                      <p className="truncate text-[10px] text-gray-500">{r.known ? r.email : 'nunca entrou no sistema com este e-mail'}</p>
                    </div>
                    <span className="flex justify-center" title={implied ?? undefined}>
                      <input
                        type="checkbox"
                        checked={accessOn}
                        disabled={!!implied}
                        onChange={() => toggle(access, setAccess, r.email)}
                        aria-label={`Acesso de ${r.name}`}
                        className="h-4 w-4 accent-brand-blue disabled:opacity-50"
                      />
                    </span>
                    <span className="flex justify-center" title={!r.known ? 'Só quem já entrou no sistema pode ser gerente.' : undefined}>
                      <input
                        type="checkbox"
                        checked={isManager}
                        disabled={!r.known && !isManager}
                        onChange={() => toggle(managers, setManagers, r.email)}
                        aria-label={`Gerente de ${r.name}`}
                        className="h-4 w-4 accent-brand-blue disabled:opacity-40"
                      />
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          <p className="text-[10px] leading-snug text-gray-500">
            Gerente cria dashboards e libera o acesso das guias desta pasta, sem precisar ser administrador — e sempre vê a pasta.
          </p>
        </>
      )}

      <div className="flex items-center gap-2">
        {dirty && (
          <button onClick={() => void save()} disabled={saving} className={saveButtonCls}>
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} Salvar
          </button>
        )}
        {saved && <span className="text-[10px] text-emerald-400">Salvo ✓</span>}
      </div>
      {error && <p className="text-[11px] text-risk-critical">{error}</p>}
    </div>
  )
}
