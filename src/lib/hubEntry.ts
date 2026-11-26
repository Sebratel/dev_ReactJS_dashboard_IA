// Entrada pelo Hub Apps (e pelo Data Hub, que abre os Indicadores dentro do Hub).
//
// O quadro chega com ?sso_token=<token de 5 min>. Este módulo é o PRIMEIRO
// import de src/main.tsx: ao ser avaliado, tira o token da barra de endereço
// com history.replaceState — antes de o router ler a URL, antes de qualquer
// requisição —, e o guarda em memória para a troca (enterFromHub em
// src/store/authSession.ts). Rodar aqui, fora do React, também livra do efeito
// duplo do StrictMode: o token é de uso único e a segunda troca falharia.
//
// A sessão que volta da troca fica no sessionStorage, não no localStorage nem
// em cookie: vale para ESTE quadro e some quando a aba fecha. Abrir o endereço
// numa aba solta não herda nada — é o que o modo "só pelo Hub" precisa.

const PARAM = 'sso_token'
const KEY = 'indicadores:hub-session'

export interface HubSession {
  token: string
  expiresAt: string
}

function takeSsoTokenFromUrl(): string | null {
  try {
    const url = new URL(window.location.href)
    const t = url.searchParams.get(PARAM)
    if (!t) return null
    url.searchParams.delete(PARAM)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    return t
  } catch {
    return null
  }
}

// Avaliado uma vez, na carga do módulo.
let pendingToken: string | null = takeSsoTokenFromUrl()

/** Devolve o token de entrada (uma vez só) e o esquece. */
export function consumeSsoToken(): string | null {
  const t = pendingToken
  pendingToken = null
  return t
}

/** Está dentro de um quadro (o Hub ou o Data Hub)? Na dúvida (topo inacessível), sim. */
export function isFramed(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

// Navegador sem sessionStorage (bloqueado): a sessão vale só enquanto a página
// estiver aberta — o mesmo efeito, sem cair em localStorage ou cookie.
let memory: HubSession | null = null

const valid = (v: HubSession | null | undefined): v is HubSession =>
  !!v?.token && Date.parse(v.expiresAt) > Date.now()

/** Id da sessão aberta pelo Hub, ou null se não há (ou venceu). */
export function hubSessionToken(): string | null {
  const s = storage()
  try {
    const raw = s?.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as HubSession
      if (valid(v)) return v.token
      s?.removeItem(KEY)
    }
  } catch {
    // armazenamento ilegível: cai na cópia em memória
  }
  if (valid(memory)) return memory.token
  memory = null
  return null
}

export function saveHubSession(v: HubSession): void {
  const s = storage()
  if (!s) { memory = v; return }
  try {
    s.setItem(KEY, JSON.stringify(v))
  } catch {
    memory = v
  }
}

export function clearHubSession(): void {
  memory = null
  try {
    storage()?.removeItem(KEY)
  } catch {
    // nada a limpar
  }
}
