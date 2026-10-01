import { apiFetch, ApiError } from '@/lib/apiClient'

export { ApiError }

export type UserRole = 'admin' | 'standard'

export interface AccessUser {
  email: string
  name: string
  role: UserRole
  firstSeenAt: string
  lastSeenAt: string
  online: boolean
}

export interface AuditLogEntry {
  ts: string
  email: string | null
  name: string | null
  action: string
  target: string | null
  meta: Record<string, unknown> | null
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

export async function fetchIsAdmin(): Promise<boolean> {
  const body = await parse<{ isAdmin: boolean }>(await apiFetch('/api/access/is-admin'))
  return body.isAdmin
}

export async function fetchUsers(): Promise<{ users: AccessUser[]; onlineThresholdMs: number }> {
  return parse(await apiFetch('/api/access/users'))
}

export async function fetchAuditLog(limit = 200): Promise<AuditLogEntry[]> {
  const body = await parse<{ entries: AuditLogEntry[] }>(await apiFetch(`/api/access/log?limit=${limit}`))
  return body.entries
}

export async function setUserRole(email: string, role: UserRole): Promise<AccessUser> {
  const body = await parse<{ user: AccessUser }>(await apiFetch(`/api/access/users/${encodeURIComponent(email)}/role`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
  }))
  return body.user
}

// ─── Solicitações de acesso a pastas (ver server/accessRequests.mjs) ──
export type AccessRequestStatus = 'pending' | 'approved' | 'rejected'

export interface AccessRequest {
  id: string
  email: string
  name: string
  folderId: string
  folderName: string // nome da pasta no momento do pedido
  message: string | null
  status: AccessRequestStatus
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
}

// Uma pasta do catálogo da página "Manual de uso": todas as pastas, com o
// acesso de quem pergunta e o último pedido dele nela.
export interface FolderCatalogEntry {
  id: string
  name: string
  icon?: string
  hasAccess: boolean
  request: { id: string; status: AccessRequestStatus; createdAt: string; decidedAt: string | null } | null
}

export async function fetchFolderCatalog(): Promise<FolderCatalogEntry[]> {
  const body = await parse<{ folders: FolderCatalogEntry[] }>(await apiFetch('/api/access/folders'))
  return body.folders
}

export async function requestFolderAccess(folderId: string, message: string): Promise<AccessRequest> {
  const body = await parse<{ request: AccessRequest }>(await apiFetch('/api/access/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId, message }),
  }))
  return body.request
}

export async function fetchAccessRequests(status: AccessRequestStatus | 'all' = 'pending'): Promise<AccessRequest[]> {
  const body = await parse<{ requests: AccessRequest[] }>(await apiFetch(`/api/access/requests?status=${status}`))
  return body.requests
}

export async function decideAccessRequest(id: string, decision: 'approve' | 'reject'): Promise<AccessRequest> {
  const body = await parse<{ request: AccessRequest }>(await apiFetch(`/api/access/requests/${encodeURIComponent(id)}/${decision}`, { method: 'POST' }))
  return body.request
}

export async function sendHeartbeat(): Promise<void> {
  await apiFetch('/api/access/heartbeat', { method: 'POST' })
}

// Login e logout não são mais registrados por uma chamada do front: quem
// escreve na auditoria agora é o próprio servidor, dentro do fluxo (callback do
// Google e POST /api/auth/logout) — ver server/index.mjs. Para encerrar a
// sessão, use `logout()` de src/store/authSession.ts, que é o que de fato
// destrói a sessão no servidor e apaga o cookie.
