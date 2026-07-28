// Escopo OAuth pedido ao Google — usado nos DOIS lugares que chamam
// initTokenClient (LoginPage.tsx e store/googleAuth.ts), pra nunca ficarem
// fora de sincronia. `spreadsheets.readonly` é o que permite o recurso de
// planilhas do Google cadastradas livremente pelo usuário no Builder (ver
// server/googleSheets.mjs) — sem ele, o token só serve pra identidade.
// Requer a API do Google Sheets habilitada no mesmo projeto do Google Cloud
// do VITE_GOOGLE_CLIENT_ID (Configuração → Habilitar APIs e serviços).
export const GOOGLE_OAUTH_SCOPE = 'openid email profile https://www.googleapis.com/auth/spreadsheets.readonly'
