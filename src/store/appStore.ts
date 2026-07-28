import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type Theme = 'light' | 'dark'

interface AppState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  theme: Theme
  toggleTheme: () => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      theme: 'light',
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
    }),
    { name: 'indicadores-sebratel-app', storage: createJSONStorage(() => localStorage) },
  ),
)

// Aplica o atributo data-theme no <html> (é isso que os overrides de modo
// escuro em globals.css usam pra saber qual bloco de variáveis vale). O
// index.html já faz a mesma coisa de forma síncrona antes do React montar
// (evita flash do tema errado no 1º paint) — isto aqui cobre o toggle em
// tempo real (subscribe só dispara em mudanças futuras, por isso o set
// inicial explícito abaixo, pra cobrir os dois casos).
//
// Suprime toda `transition` da página por 1 frame ao trocar de tema: sem
// isso, qualquer elemento com `transition-all`/`transition-colors` já
// montado (ex.: a Sidebar) pode ficar "travado" na cor do tema anterior —
// bug conhecido do Chromium, onde uma transição em andamento não recalcula
// corretamente quando o valor novo vem de uma custom property (--app-*)
// mudando num ancestral, em vez de uma classe trocada no próprio elemento.
function applyTheme(theme: Theme) {
  const style = document.createElement('style')
  style.textContent = '*, *::before, *::after { transition: none !important; }'
  document.head.appendChild(style)
  document.documentElement.dataset.theme = theme
  void document.body.offsetHeight // força recalcular estilo já sem transição ativa
  requestAnimationFrame(() => style.remove())
}

applyTheme(useAppStore.getState().theme)
useAppStore.subscribe((state) => applyTheme(state.theme))
