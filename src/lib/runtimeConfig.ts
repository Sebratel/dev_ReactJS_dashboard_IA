// Configuração lida em TEMPO DE EXECUÇÃO, não assada no bundle.
//
// O problema que isto resolve: a SPA é um build estático servido por nginx, e
// tudo que vem de `import.meta.env.VITE_*` é substituído por texto literal na
// hora do `vite build`. Com isso, trocar o Client ID do Google exigiria
// RECONSTRUIR a imagem — inviável num deploy de Portainer, onde a imagem é a
// mesma e o que muda é a env da stack.
//
// Então o container gera, no boot, um /config.js com os valores do ambiente
// (ver docker/entrypoint.sh) e o index.html carrega esse arquivo ANTES do
// bundle. Aqui a leitura é: window.__APP_CONFIG__ primeiro; se estiver vazio
// (é o caso em desenvolvimento, onde public/config.js é só um esqueleto), cai
// pro VITE_* do .env de sempre. Assim `npm run dev` continua funcionando sem
// nenhuma etapa nova.
export interface AppRuntimeConfig {
  googleClientId?: string
}

declare global {
  interface Window {
    __APP_CONFIG__?: AppRuntimeConfig
  }
}

// Valor "não configurado" também cobre o placeholder que o entrypoint escreve
// quando a env não foi definida na stack — evita mandar a string literal
// "__GOOGLE_CLIENT_ID__" pro Google e receber um erro obscuro de volta.
function clean(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  if (!trimmed || /^__.*__$/.test(trimmed)) return undefined
  return trimmed
}

export function googleClientId(): string | undefined {
  return clean(window.__APP_CONFIG__?.googleClientId)
    ?? clean(import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)
}

// Mensagem única pros dois lugares que precisam do Client ID (tela de login e
// renovação silenciosa do token) — o nome da variável muda conforme onde a
// pessoa tem que mexer, então vale explicar as duas.
export const MISSING_CLIENT_ID_MESSAGE =
  'Client ID do Google não configurado — defina GOOGLE_CLIENT_ID no ambiente do container (ou VITE_GOOGLE_CLIENT_ID no .env, em desenvolvimento).'
