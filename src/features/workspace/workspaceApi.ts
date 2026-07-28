import { apiFetch, ApiError } from '@/lib/apiClient'
import type { TabConfig, TabAccess } from '@/features/builder/types'
import type { DashboardResponse, Folder, FolderMember, WorkspaceTreeFolder } from './types'

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

export async function fetchDashboard(folderId: string, dashboardId: string): Promise<DashboardResponse> {
  return parse(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}`))
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

export async function saveDashboardFull(folderId: string, dashboardId: string, tabs: TabConfig[]): Promise<void> {
  await parse(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/full`, jsonInit('PUT', { tabs })))
}

export async function saveTabWidgets(folderId: string, dashboardId: string, tabId: string, widgets: TabConfig['widgets']): Promise<void> {
  await parse(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/tabs/${enc(tabId)}/widgets`, jsonInit('PUT', { widgets })))
}

export async function setTabAccess(folderId: string, dashboardId: string, tabId: string, access: TabAccess): Promise<TabConfig> {
  const body = await parse<{ tab: TabConfig }>(await apiFetch(`/api/workspace/folders/${enc(folderId)}/dashboards/${enc(dashboardId)}/tabs/${enc(tabId)}/access`, jsonInit('PUT', access)))
  return body.tab
}
