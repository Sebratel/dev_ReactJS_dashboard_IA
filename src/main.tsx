import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { loadSession } from './store/authSession'
import './styles/globals.css'

// Quem está logado vem do servidor (o cookie de sessão é HttpOnly, invisível
// pro JavaScript), então a checagem começa antes do primeiro render e o router
// espera por ela através do `ready` do authStore. Sem esperar, um F5 numa
// sessão válida piscaria a tela de login.
void loadSession()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
