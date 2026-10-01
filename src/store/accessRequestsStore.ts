// Quantos pedidos de acesso a pastas esperam um administrador — o número ao
// lado de "Acessos" na barra lateral. Só faz sentido para admin: a rota que
// lista os pedidos é admin-only, e quem não é admin nunca chama refresh.
import { create } from 'zustand'
import { fetchAccessRequests } from '@/features/access/accessApi'

interface AccessRequestsState {
  pendingCount: number
  refreshPendingCount: () => Promise<void>
}

export const useAccessRequestsStore = create<AccessRequestsState>((set) => ({
  pendingCount: 0,
  refreshPendingCount: async () => {
    try {
      const pending = await fetchAccessRequests('pending')
      set({ pendingCount: pending.length })
    } catch {
      // O número é um aviso, não um dado crítico: falhou, fica o último valor.
    }
  },
}))
