// PRIMEIRO import, de propósito: ao ser avaliado, tira o ?sso_token do Hub Apps
// da barra de endereço — antes de o router (importado logo abaixo) ler a URL.
import './lib/hubEntry'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { bootAuth } from './store/authSession'
import './styles/globals.css'

// Quem está logado vem do servidor (o cookie de sessão é HttpOnly, invisível
// pro JavaScript; a sessão do Hub fica no sessionStorage do quadro), então a
// checagem começa antes do primeiro render e o router espera por ela através
// do `ready` do authStore. Sem esperar, um F5 numa sessão válida piscaria a
// tela de login — e a entrada pelo Hub perderia a corrida para o guarda de rota.
void bootAuth()

// Depois de um redeploy, os arquivos da versão antiga somem do servidor: uma
// aba aberta desde antes falha ao carregar uma tela ("Failed to fetch
// dynamically imported module") e fica em branco. Recarrega uma vez, que traz
// a versão nova — no máximo a cada minuto, pra não entrar em laço se o erro
// for outro (servidor fora, por exemplo).
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'reload-after-chunk-error'
  let last = 0
  try { last = Number(sessionStorage.getItem(KEY)) || 0 } catch { /* sem storage */ }
  if (Date.now() - last < 60_000) return
  try { sessionStorage.setItem(KEY, String(Date.now())) } catch { /* sem storage */ }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
