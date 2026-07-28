// Configuração de runtime da SPA — ESQUELETO.
//
// Em desenvolvimento este arquivo fica vazio de propósito: o app cai no
// VITE_GOOGLE_CLIENT_ID do .env (ver src/lib/runtimeConfig.ts).
//
// No container, docker/entrypoint.sh SOBRESCREVE este arquivo no boot com os
// valores do ambiente da stack — por isso o Client ID não precisa ser assado
// no build e a mesma imagem serve qualquer ambiente.
window.__APP_CONFIG__ = {}
