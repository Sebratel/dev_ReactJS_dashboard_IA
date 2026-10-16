import { apiFetch, ApiError } from '@/lib/apiClient'
import type { TabConfig, TabAccess, MeasureDef } from '@/features/builder/types'
import type { DashboardResponse, DashboardTab, Folder, FolderMember, TabLockInfo, TabLocks, WorkspaceTreeFolder } from './types'

export { ApiError }

async function parse<T>(res: Response): Promise<T> {
  let body: any = null
  try { body = await res.json() } catch { /* sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Erro ${res.status} no servidor.`)
  return body as T
}

const enc = encodeURIComponent
const jsonInit = (method: string, body: unknown) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

export async function fetchWorkspaceTree(): Promise<WorkspaceTreeFolder[]> {
  const body = await parse<{ folders: WorkspaceTreeFolder[] }>(await apiFetch('/api/workspace/tree'))
  return body.folders
}

// `clientId` (a janela, ver useTabLocks.ts) só serve pra marcar como `mine`
// os bloqueios de edição desta mesma janela.
export async function fetchDashboard(folderId: string, dashboardId: string, clientId?: string): Promise<DashboardResponse> {
  const query = clientId ? `?clientId=${enc(clientId)}` : ''
  return parse(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}${query}`))
}

// ─── Pastas (admin) ──────────────────────────────────────────────
export async function fetchFolders(): Promise<Folder[]> {
  const body = await parse<{ folders: Folder[] }>(await apiFetch('/api/workspace/folders'))
  return body.folders
}

export async function createFolder(def: { name: string; icon?: string }): Promise<Folder> {
  const body = await parse<{ folder: Folder }>(await apiFetch('/api/workspace/folders', jsonInit('POST', def)))
  return body.folder
}

export async function fetchFolder(id: string): Promise<Folder> {
  const body = await parse<{ folder: Folder }>(await apiFetch(`/api/workspace/folders/${enc(id)}`))
  return body.folder
}

export async function updateFolder(id: string, patch: { name?: string; icon?: string; order?: number }): Promise<Folder> {
  const body = await parse<{ folder: Folder }>(await apiFetch(`/api/workspace/folders/${enc(id)}`, jsonInit('PUT', patch)))
  return body.folder
}

export async function deleteFolder(id: string): Promise<void> {
  await parse(await apiFetch(`/api/workspace/folders/${enc(id)}`, { method: 'DELETE' }))
}

export async function setFolderAccess(id: string, accessEmails: string[] | null): Promise<Folder> {
  const body = await parse<{ folder: Folder }>(await apiFetch(`/api/workspace/folders/${enc(id)}/access`, jsonInit('PUT', { accessEmails })))
  return body.folder
}

export async function setFolderManagers(id: string, managers: string[]): Promise<Folder> {
  const body = await parse<{ folder: Folder }>(await apiFetch(`/api/workspace/folders/${enc(id)}/managers`, jsonInit('PUT', { managers })))
  return body.folder
}

export async function fetchFolderMembers(id: string): Promise<FolderMember[]> {
  const body = await parse<{ members: FolderMember[] }>(await apiFetch(`/api/workspace/folders/${enc(id)}/members`))
  return body.members
}

// ─── Dashboards (admin + gerente da pasta) ────────────────────────
export async function createDashboard(folderId: string, name: string): Promise<{ id: string; name: string }> {
  const body = await parse<{ dashboard: { id: string; name: string } }>(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards`, jsonInit('POST', { name })))
  return body.dashboard
}

export async function updateDashboard(folderId: string, dashboardId: string, patch: { name?: string; order?: number }): Promise<{ id: string; name: string }> {
  const body = await parse<{ dashboard: { id: string; name: string } }>(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}`, jsonInit('PUT', patch)))
  return body.dashboard
}

export async function deleteDashboard(folderId: string, dashboardId: string): Promise<void> {
  await parse(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}`, { method: 'DELETE' }))
}

// Grava guia por guia (ver saveDashboardFull em server/workspace.mjs): só as
// guias em `changedTabIds` são gravadas, e `measures` só quando vem. Devolve a
// dashboard como ficou no servidor.
export async function saveDashboardFull(folderId: string, dashboardId: string, payload: {
  tabs: TabConfig[]
  changedTabIds: string[]
  removedTabIds: string[]
  measures?: MeasureDef[]
  clientId: string
}): Promise<DashboardResponse> {
  return parse(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/full`, jsonInit('PUT', payload)))
}

// `baseRev` = versão da guia que a tela leu; o servidor recusa (409) se outra
// pessoa salvou a guia depois disso.
export async function saveTabWidgets(folderId: string, dashboardId: string, tabId: string, payload: {
  widgets: TabConfig['widgets']
  baseRev?: number
  clientId: string
}): Promise<DashboardTab> {
  const body = await parse<{ tab: DashboardTab }>(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/tabs/${enc(tabId)}/widgets`, jsonInit('PUT', payload)))
  return body.tab
}

// ─── Bloqueio de edição por guia (server/tabLocks.mjs) ───────────────
const lockPath = (folderId: string, dashboardId: string, tabId: string) =>
  `/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/tabs/${enc(tabId)}/lock`

export async function fetchTabLocks(folderId: string, dashboardId: string, clientId: string): Promise<{ locks: TabLocks; revs: Record<string, number> }> {
  return parse(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/locks?clientId=${enc(clientId)}`))
}

export type AcquireTabLockResult =
  | { ok: true; lock: TabLockInfo; tab?: DashboardTab | null }
  | { ok: false; lock: TabLockInfo; message: string }

// 409 não é falha aqui: é a resposta "outra pessoa está editando", com quem.
export async function acquireTabLock(folderId: string, dashboardId: string, tabId: string, clientId: string, renew: boolean): Promise<AcquireTabLockResult> {
  const res = await apiFetch(lockPath(folderId, dashboardId, tabId), jsonInit('POST', { clientId, renew }))
  if (res.status === 409) {
    const body = await res.json().catch(() => null)
    if (body?.lock) return { ok: false, lock: body.lock, message: body.error }
  }
  const body = await parse<{ lock: TabLockInfo; tab?: DashboardTab | null }>(res)
  return { ok: true, lock: body.lock, tab: body.tab }
}

// `keepalive`: o pedido sai mesmo com a página fechando (ver useTabLocks).
export async function releaseTabLock(folderId: string, dashboardId: string, tabId: string, clientId: string, keepalive = false): Promise<void> {
  await apiFetch(`${lockPath(folderId, dashboardId, tabId)}?clientId=${enc(clientId)}`, { method: 'DELETE', keepalive })
}

export async function setTabAccess(folderId: string, dashboardId: string, tabId: string, access: TabAccess): Promise<TabConfig> {
  const body = await parse<{ tab: TabConfig }>(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/tabs/${enc(tabId)}/access`, jsonInit('PUT', access)))
  return body.tab
}
