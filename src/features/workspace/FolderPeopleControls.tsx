// Quem entra na pasta e quem a gerencia — só administrador vê estas duas
// seções (ver FolderSettingsModal). As pessoas vêm de quem já acessou o sistema
// (UserPicker), não de e-mail digitado: um e-mail errado não liberava nada e
// ninguém percebia.
import { useState, type ReactNode } from 'react'
import { Globe, Loader2, Lock, ShieldCheck } from 'lucide-react'
import { ApiError } from './workspaceApi'
import type { Folder } from './types'
import { UserPicker, type PickerUser } from './UserPicker'
import { pillCls, saveButtonCls } from './folderStyles'

// A lista de usuários vem do modal: null enquanto carrega.
export interface KnownUsers {
  users: PickerUser[] | null
  error: string | null
}

function sameSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

function useSaveState() {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (save: () => Promise<void>) => {
    setSaving(true); setError(null); setSaved(false)
    try {
      await save()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar.')
    } finally {
      setSaving(false)
    }
  }
  return { saving, saved, error, run }
}

function SaveRow({ dirty, saving, saved, error, onSave }: { dirty: boolean; saving: boolean; saved: boolean; error: string | null; onSave: () => void }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {dirty && (
          <button onClick={onSave} disabled={saving} className={saveButtonCls}>
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} Salvar
          </button>
        )}
        {saved && <span className="text-[10px] text-emerald-400">Salvo ✓</span>}
      </div>
      {error && <p className="text-[11px] text-risk-critical">{error}</p>}
    </>
  )
}

function PickerOrStatus({ known, children }: { known: KnownUsers; children: (users: PickerUser[]) => ReactNode }) {
  if (known.error) return <p className="text-[11px] text-risk-critical">{known.error}</p>
  if (!known.users) return <p className="flex items-center gap-1.5 text-[11px] text-gray-500"><Loader2 size={11} className="animate-spin" /> Carregando usuários…</p>
  return <>{children(known.users)}</>
}

export function AccessControl({ folder, known, onSave }: { folder: Folder; known: KnownUsers; onSave: (accessEmails: string[] | null) => Promise<void> }) {
  const initialOpen = folder.accessEmails === null
  const initialEmails = folder.accessEmails ?? []
  const [open, setOpen] = useState(initialOpen)
  const [emails, setEmails] = useState<string[]>(initialEmails)
  const { saving, saved, error, run } = useSaveState()
  const dirty = open !== initialOpen || (!open && !sameSet(emails, initialEmails))

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Acesso à pasta</span>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => setOpen(true)} className={pillCls(open)}><Globe size={11} /> Aberta a todos</button>
        <button type="button" onClick={() => setOpen(false)} className={pillCls(!open)}><Lock size={11} /> Restrita</button>
      </div>
      {!open && (
        <>
          <p className="text-[10px] text-gray-500">Marque quem pode ver esta pasta. Administradores e gerentes da pasta sempre veem.</p>
          <PickerOrStatus known={known}>
            {(users) => (
              <UserPicker users={users} selected={emails} onChange={setEmails} emptyText="Ninguém marcado: só administradores e gerentes verão esta pasta." />
            )}
          </PickerOrStatus>
        </>
      )}
      <SaveRow dirty={dirty} saving={saving} saved={saved} error={error} onSave={() => void run(() => onSave(open ? null : emails))} />
    </div>
  )
}

export function ManagersControl({ folder, known, onSave }: { folder: Folder; known: KnownUsers; onSave: (managers: string[]) => Promise<void> }) {
  const [managers, setManagers] = useState<string[]>(folder.managers)
  const { saving, saved, error, run } = useSaveState()
  const dirty = !sameSet(managers, folder.managers)

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1"><ShieldCheck size={11} /> Gerentes desta pasta</span>
      <p className="text-[10px] text-gray-500">Podem criar dashboards e liberar acesso de guias dentro desta pasta, sem precisar ser administrador.</p>
      <PickerOrStatus known={known}>
        {(users) => (
          <UserPicker users={users} selected={managers} onChange={setManagers} emptyText="Nenhum gerente: só administradores criam dashboards nesta pasta." />
        )}
      </PickerOrStatus>
      <SaveRow dirty={dirty} saving={saving} saved={saved} error={error} onSave={() => void run(() => onSave(managers))} />
    </div>
  )
}
