/// <reference types="vite/client" />

// Variáveis de build do Firebase, tipadas para o erro aparecer no `tsc` e não
// num `undefined` silencioso dentro do SDK. Todas são gravadas no bundle em
// tempo de BUILD — em Docker, via ARG/ENV no Dockerfile e build.args no
// compose; trocar o .env e reiniciar não basta.
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string
  readonly VITE_FIREBASE_AUTH_DOMAIN: string
  readonly VITE_FIREBASE_PROJECT_ID: string
  readonly VITE_FIREBASE_APP_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
