// Escopo OAuth pedido ao Google no login.
//
// Quem consome isto hoje é o SERVIDOR (server/googleOAuth.mjs), ao montar a URL
// de autorização — o login deixou de acontecer no navegador quando migramos
// para o fluxo de código de autorização. O arquivo continua aqui, em src/, para
// não haver duas listas de escopo divergindo caso o front volte a precisar
// dela; é também por isso que a API sobe com `tsx` (ver Dockerfile.api).
//
// `spreadsheets.readonly` é o que permite o recurso de planilhas do Google
// cadastradas livremente pelo usuário no Builder (ver server/googleSheets.mjs)
// — sem ele, o token só serviria pra identidade. Requer a API do Google Sheets
// habilitada no mesmo projeto do Google Cloud do GOOGLE_CLIENT_ID
// (Configuração → Habilitar APIs e serviços).
export const GOOGLE_OAUTH_SCOPE = 'openid email profile https://www.googleapis.com/auth/spreadsheets.readonly'
