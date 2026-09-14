// Firebase Authentication — o SDK vem do npm, NUNCA de <script src>.
//
// É essa a diferença que a skill padrao-login-sso registra: o Google Identity
// Services baixa o SDK de accounts.google.com em tempo de execução, então um
// bloqueio de rede derruba o login antes de qualquer clique, e a tela de erro
// não ajuda porque ela precisa exatamente do domínio bloqueado. Vindo no
// bundle, o SDK já está aqui — e a verificação do token, no servidor, é feita
// com a chave pública em cache (ver server/firebaseToken.mjs).
//
// As VITE_FIREBASE_* são gravadas no bundle em tempo de BUILD. Em Docker isso
// significa ARG + ENV no Dockerfile e build.args no compose: mudar o .env e
// reiniciar NÃO tem efeito, precisa de rebuild. Elas não são segredo (vão no
// JavaScript do cliente por design), mas a chave precisa estar restrita a
// Identity Toolkit no Google Cloud — senão vira um cartão de crédito publicado.
import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  getAuth, signInWithPopup, signOut, GoogleAuthProvider,
  setPersistence, browserLocalPersistence, type Auth,
} from 'firebase/auth'
import { GOOGLE_OAUTH_SCOPES } from './googleScopes'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
}

// Sem configuração não há login. Descobrir isso na subida (e dizer o que
// falta) é melhor que um erro do SDK no primeiro clique, que vem em inglês e
// não menciona variável de ambiente nenhuma.
export function firebaseConfigurado(): boolean {
  return !!(config.apiKey && config.authDomain && config.projectId && config.appId)
}

let app: FirebaseApp | null = null
let auth: Auth | null = null

function getAuthLazy(): Auth {
  if (!auth) {
    app = initializeApp(config)
    auth = getAuth(app)
    // Mantém a pessoa identificada no SDK entre recarregamentos. Não é a nossa
    // sessão (essa é o cookie do servidor) — serve pra reentrar sem popup
    // quando o cookie vence antes do vínculo com o Google.
    void setPersistence(auth, browserLocalPersistence).catch(() => {})
  }
  return auth
}

export interface LoginGoogle {
  idToken: string
  /** Token do Google para ler planilha em nome da pessoa. Pode não vir. */
  googleAccessToken: string | null
  /** Quando esse access_token vence (ms). O Google dá ~1h e não manda refresh. */
  googleAccessTokenExpiresAt: number
}

/**
 * Abre o popup do Google e devolve o ID token para o servidor validar.
 *
 * O `hd` só filtra o seletor de contas — evita a pessoa escolher a conta
 * pessoal e tomar "sem acesso" depois. NÃO é controle de acesso: quem valida o
 * domínio é o servidor, sempre (ver POST /api/auth/session).
 */
export async function entrarComGoogle(): Promise<LoginGoogle> {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ hd: 'sebratel.com.br' })
  // Escopo das planilhas: sem ele o token serviria só pra identidade, e o
  // recurso de fonte por planilha do Google pararia de ler.
  for (const escopo of GOOGLE_OAUTH_SCOPES) provider.addScope(escopo)

  const cred = await signInWithPopup(getAuthLazy(), provider)
  const idToken = await cred.user.getIdToken()
  const oauth = GoogleAuthProvider.credentialFromResult(cred)

  return {
    idToken,
    googleAccessToken: oauth?.accessToken ?? null,
    // O SDK não expõe o vencimento; o Google emite com 1h. 55 min deixa margem.
    googleAccessTokenExpiresAt: Date.now() + 55 * 60 * 1000,
  }
}

/** Encerra também o vínculo com o Google, pra "Sair" significar sair mesmo. */
export async function sairDoGoogle(): Promise<void> {
  if (!auth) return
  try {
    await signOut(auth)
  } catch {
    // Falha aqui não pode prender ninguém: a sessão de verdade é o cookie, e
    // ela já foi encerrada no servidor.
  }
}

/**
 * Traduz o código do Firebase para uma frase que diz o que fazer. Vale o
 * trabalho: `auth/unauthorized-domain` é o passo manual mais esquecido do
 * console, e ele só aparece no primeiro clique real — nunca no build.
 */
export function mensagemDeErro(e: unknown): string {
  const codigo = (e as { code?: string })?.code ?? ''
  switch (codigo) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Login cancelado.'
    case 'auth/popup-blocked':
      return 'O navegador bloqueou a janela de login. Libere os pop-ups para este endereço e tente de novo.'
    case 'auth/unauthorized-domain':
      return 'Este endereço não está liberado no Firebase. Um administrador precisa adicioná-lo em Authentication → Settings → Authorized domains.'
    case 'auth/network-request-failed':
      return 'Não foi possível falar com o Google. Verifique a conexão e tente de novo.'
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid-please-pass-a-valid-api-key':
      return 'A chave do Firebase não é válida para este endereço. Confira as VITE_FIREBASE_* usadas no build.'
    case 'auth/operation-not-allowed':
      return 'O login com Google não está ativado neste projeto do Firebase (Authentication → Sign-in method).'
    default:
      return (e as Error)?.message || 'Não foi possível entrar. Tente de novo.'
  }
}
