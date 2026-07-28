// Árvore de pastas/dashboards visíveis pro usuário atual — carregada uma vez
// no login (ver MainLayout.tsx) e sempre que uma pasta/dashboard muda
// (criar/renomear/remover pasta ou dashboard chama refresh()). Não persiste
// em localStorage — é sempre um retrato fresco do que o servidor autoriza.
import { create } from 'zustand'
import { fetchWorkspaceTree } from '@/features/workspace/workspaceApi'
import type { WorkspaceTreeFolder } from '@/features/workspace/types'

interface WorkspaceState {
  folders: WorkspaceTreeFolder[] | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  folders: null,
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const folders = await fetchWorkspaceTree()
      set({ folders, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Falha ao carregar pastas.', loading: false })
    }
  },
}))
