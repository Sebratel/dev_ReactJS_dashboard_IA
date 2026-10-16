// Árvore de pastas/dashboards visíveis pro usuário atual — carregada no login
// (ver MainLayout.tsx), sempre que uma pasta/dashboard muda nesta tela
// (criar/renomear/remover pasta ou dashboard chama refresh()) e, em silêncio,
// de tempos em tempos e ao voltar para a aba — senão a dashboard que OUTRA
// pessoa criou só aparecia com F5. Não persiste em localStorage — é sempre um
// retrato fresco do que o servidor autoriza.
import { create } from 'zustand'
import { fetchWorkspaceTree } from '@/features/workspace/workspaceApi'
import type { WorkspaceTreeFolder } from '@/features/workspace/types'

interface WorkspaceState {
  folders: WorkspaceTreeFolder[] | null
  loading: boolean
  error: string | null
  // `silent`: conferência em segundo plano — não liga o "carregando", não
  // troca a árvore se nada mudou, e uma falha mantém a última que deu certo.
  refresh: (opts?: { silent?: boolean }) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  folders: null,
  loading: false,
  error: null,
  refresh: async (opts) => {
    if (opts?.silent) {
      try {
        const folders = await fetchWorkspaceTree()
        if (JSON.stringify(folders) !== JSON.stringify(get().folders)) set({ folders, error: null })
      } catch { /* sem rede ou sessão caindo: fica a última árvore */ }
      return
    }
    set({ loading: true, error: null })
    try {
      const folders = await fetchWorkspaceTree()
      set({ folders, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Falha ao carregar pastas.', loading: false })
    }
  },
}))
