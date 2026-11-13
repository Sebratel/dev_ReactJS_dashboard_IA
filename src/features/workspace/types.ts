// Tipos da hierarquia Pasta → Dashboard → Guia — ver server/workspace.mjs.
// Guias em si continuam usando TabConfig (src/features/builder/types.ts);
// aqui só o que envolve pasta/dashboard e as anotações de permissão.
import type { MeasureDef, TabConfig } from '@/features/builder/types'

export interface WorkspaceTreeDashboard {
  id: string
  name: string
}

// Árvore leve pro menu lateral — sem guias/widgets.
export interface WorkspaceTreeFolder {
  id: string
  name: string
  icon?: string
  canManage: boolean // admin ou gerente desta pasta
  dashboards: WorkspaceTreeDashboard[]
}

export interface FolderMember {
  email: string
  name: string
}

// Pasta completa (tela de gestão, admin) — mesmo formato persistido no
// servidor, mais a lista leve de dashboards (id/nome, sem guias/widgets).
export interface Folder {
  id: string
  name: string
  icon?: string
  order: number
  accessEmails: string[] | null // null = aberta a qualquer autenticado
  managers: string[]
  createdBy: string | null
  createdAt: string
  updatedBy: string | null
  updatedAt: string | null
  dashboards: WorkspaceTreeDashboard[]
}

export interface DashboardTab extends TabConfig {
  canEdit: boolean // resolvido pelo servidor pro usuário atual
}

// Quem está editando uma guia agora — ver server/tabLocks.mjs.
export interface TabLockInfo {
  name: string
  since: string     // ISO
  expiresAt: string // ISO
  self: boolean     // a mesma pessoa (talvez em outra janela)
  mine: boolean     // esta mesma janela
}

// Guia id → bloqueio vivo. Guia fora do mapa = ninguém editando.
export type TabLocks = Record<string, TabLockInfo>

export interface DashboardResponse {
  folder: { id: string; name: string; canManage: boolean; isManager: boolean }
  dashboard: { id: string; name: string; tabs: DashboardTab[]; measures?: MeasureDef[] }
  locks?: TabLocks
}
