// Estado de autenticação do cliente.
//
// NÃO é mais persistido no localStorage, e não guarda token nenhum: a sessão de
// verdade é o cookie HttpOnly que o servidor define (ver server/sessions.mjs),
// invisível pro JavaScript. O que existe aqui é só uma cópia em memória de
// "quem está logado", carregada de GET /api/auth/me a cada abertura do app
// (ver src/store/authSession.ts) — o servidor é a única fonte de verdade.
//
// Antes, este store persistia o access_token do Google no localStorage; era o
// que o fluxo implícito exigia, e é exatamente o que a migração para o fluxo de
// código eliminou.
import { create } from 'zustand'
import { clearSessionScopedStorage } from './sessionScopedStorage'

export const DEFAULT_HUB_URL = 'https://hub-apps.sebratel.net.br'

export interface AuthUser {
  name: string
  email: string
  picture?: string
}

interface AuthState {
  user: AuthUser | null
  isAdmin: boolean
  // Primeiro acesso: quem ainda não abriu o manual cai nele em vez da primeira
  // dashboard (ver DashboardRedirect em src/router/index.tsx).
  manualPending: boolean
  // null enquanto a 1ª checagem de sessão não terminou — o router usa isso pra
  // não mandar pro /login quem só ainda não foi verificado (o que faria um
  // F5 numa sessão válida cair na tela de login).
  ready: boolean
  // Como a tela de login se apresenta (GET /api/auth/config). Com `hubOnly`, a
  // única porta é o Hub Apps: a tela mostra "Acesse pelo Hub Apps" e nenhum
  // outro botão de login. É só UX — quem recusa o resto é o servidor.
  hubOnly: boolean
  hubUrl: string
  // Por que a última entrada pelo Hub falhou (token vencido, já usado...).
  hubError: string | null
  setAuthConfig: (c: { hubOnly: boolean; hubUrl: string }) => void
  setHubError: (msg: string | null) => void
  setSession: (session: { user: AuthUser; isAdmin: boolean; manualPending?: boolean }) => void
  setIsAdmin: (v: boolean) => void
  setManualPending: (v: boolean) => void
  setReady: (v: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAdmin: false,
  manualPending: false,
  ready: false,
  hubOnly: false,
  hubUrl: DEFAULT_HUB_URL,
  hubError: null,
  setAuthConfig: ({ hubOnly, hubUrl }) => set({ hubOnly, hubUrl: hubUrl || DEFAULT_HUB_URL }),
  setHubError: (hubError) => set({ hubError }),
  setSession: ({ user, isAdmin, manualPending = false }) => set({ user, isAdmin, manualPending, ready: true }),
  setIsAdmin: (isAdmin) => set({ isAdmin }),
  setManualPending: (manualPending) => set({ manualPending }),
  setReady: (ready) => set({ ready }),
  // Qualquer saída — o botão Sair, sessão vencida (401) ou nenhuma sessão ao
  // abrir — apaga o que era da sessão, como a conversa com a IA.
  logout: () => {
    clearSessionScopedStorage()
    set({ user: null, isAdmin: false, manualPending: false, ready: true })
  },
}))
