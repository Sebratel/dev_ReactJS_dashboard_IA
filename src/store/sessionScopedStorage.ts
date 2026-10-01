// O que fica guardado no navegador só enquanto dura o login nesta aba. Vive no
// sessionStorage (fechar a aba apaga) e é apagado também no logout — mesmo que a
// parte do app que o usa nem tenha sido carregada nesta aba (ver logout em
// authStore.ts).

// Conversas do "Montar com IA", uma por dashboard (features/builder/ai/aiChatStore.ts).
export const AI_CHATS_KEY = 'indicadores:ai-chats'

export function clearSessionScopedStorage() {
  try {
    sessionStorage.removeItem(AI_CHATS_KEY)
  } catch {
    // Armazenamento bloqueado pelo navegador: não havia nada guardado.
  }
}
