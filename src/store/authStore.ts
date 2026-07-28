import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export interface AuthUser {
  name: string
  email: string
  picture?: string
}

interface AuthState {
  user: AuthUser | null
  accessToken: string | null
  isAdmin: boolean
  setUser: (u: AuthUser | null) => void
  setAccessToken: (t: string | null) => void
  setIsAdmin: (v: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      isAdmin: false,
      setUser: (user) => set({ user }),
      setAccessToken: (accessToken) => set({ accessToken }),
      setIsAdmin: (isAdmin) => set({ isAdmin }),
      logout: () => set({ user: null, accessToken: null, isAdmin: false }),
    }),
    { name: 'indicadores-sebratel-auth', storage: createJSONStorage(() => localStorage) },
  ),
)
