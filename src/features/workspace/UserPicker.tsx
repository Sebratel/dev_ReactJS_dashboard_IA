// Seleção de pessoas entre quem já acessou o sistema (GET /api/access/users),
// no lugar de digitar e-mail. Os escolhidos aparecem como etiquetas; a lista
// com busca marca e desmarca. E-mail já salvo que não está entre os usuários
// conhecidos (liberado antes do primeiro acesso dele) vira uma etiqueta "ainda
// não acessou" — continua valendo até alguém tirá-lo.
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { inputCls } from './folderStyles'

export interface PickerUser {
  email: string
  name: string
  role?: 'admin' | 'standard'
}

// Busca sem acento e sem maiúscula: "joao" acha "João".
function normalize(text: string) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function UserPicker({ users, selected, onChange, emptyText }: {
  users: PickerUser[]
  selected: string[]
  onChange: (emails: string[]) => void
  emptyText: string
}) {
  const [query, setQuery] = useState('')
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const byEmail = useMemo(() => new Map(users.map((u) => [u.email, u])), [users])
  const q = normalize(query.trim())
  const filtered = q ? users.filter((u) => normalize(u.name).includes(q) || u.email.includes(q)) : users

  const toggle = (email: string) => {
    onChange(selectedSet.has(email) ? selected.filter((e) => e !== email) : [...selected, email])
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((email) => {
            const user = byEmail.get(email)
            return (
              <span
                key={email}
                title={email}
                className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface px-1.5 py-0.5 text-[10px] text-gray-200"
              >
                {user ? user.name : email}
                {!user && <span className="text-gray-500">· ainda não acessou</span>}
                <button type="button" onClick={() => toggle(email)} aria-label={`Tirar ${user?.name ?? email}`} className="text-gray-500 hover:text-risk-critical">
                  <X size={10} />
                </button>
              </span>
            )
          })}
        </div>
      ) : (
        <p className="text-[10px] text-gray-500">{emptyText}</p>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar por nome ou e-mail…"
        aria-label="Buscar usuário"
        className={cn(inputCls, 'w-full')}
      />
      <div className="max-h-44 overflow-y-auto scrollbar-thin rounded-lg border border-app-border divide-y divide-app-border/60">
        {users.length === 0 && <p className="px-3 py-2 text-[11px] text-gray-500">Ninguém acessou o sistema ainda.</p>}
        {users.length > 0 && filtered.length === 0 && <p className="px-3 py-2 text-[11px] text-gray-500">Ninguém encontrado com “{query.trim()}”.</p>}
        {filtered.map((u) => (
          <label key={u.email} className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-app-surface">
            <input type="checkbox" checked={selectedSet.has(u.email)} onChange={() => toggle(u.email)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-gray-200">{u.name}</span>
              <span className="block truncate text-[10px] text-gray-500">{u.email}</span>
            </span>
            {u.role === 'admin' && <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-brand-blue">admin</span>}
          </label>
        ))}
      </div>
    </div>
  )
}
