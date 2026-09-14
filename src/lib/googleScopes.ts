// Escopos OAuth pedidos ao Google no login.
//
// Quem consome isto voltou a ser o CLIENTE (src/lib/firebase.ts), ao montar o
// provider do popup — com a migração para o Firebase Authentication, é o
// navegador que negocia com o Google de novo. O servidor não monta mais URL de
// autorização (o fluxo de código de autorização foi aposentado em 13/09/2026).
//
// `spreadsheets.readonly` é o que permite o recurso de planilhas do Google
// cadastradas livremente pelo usuário no Builder (ver server/googleSheets.mjs).
// Sem ele, o token só serviria pra identidade. Requer a API do Google Sheets
// habilitada no mesmo projeto do Google Cloud do Firebase
// (Configuração → Habilitar APIs e serviços).
//
// ATENÇÃO ao mexer aqui: escopo novo faz o Google pedir consentimento de novo,
// e quem já estava logado só concede na próxima entrada.
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
]

// `openid email profile` não precisam ser pedidos: o Firebase já os inclui.
export const GOOGLE_OAUTH_SCOPE = GOOGLE_OAUTH_SCOPES.join(' ')
