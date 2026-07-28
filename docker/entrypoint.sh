#!/bin/sh
# Gera a config de runtime da SPA a partir do ambiente do container, ANTES de
# subir o nginx. É o que permite a MESMA imagem servir qualquer ambiente: o
# Client ID do Google vem da env da stack (Portainer), não de um `vite build`.
#
# Sem isto, VITE_GOOGLE_CLIENT_ID só existiria assado no bundle e trocar de
# Client ID exigiria reconstruir a imagem.
#
# Aceita GOOGLE_CLIENT_ID (nome usado na stack, igual ao do serviço `api`) ou
# VITE_GOOGLE_CLIENT_ID (o nome antigo), pra não quebrar quem já tinha a env
# antiga configurada.
set -eu

# Sobrescrevível só para poder testar o script fora do container.
CONFIG_PATH="${CONFIG_PATH:-/usr/share/nginx/html/config.js}"
CLIENT_ID="${GOOGLE_CLIENT_ID:-${VITE_GOOGLE_CLIENT_ID:-}}"

# Escapa aspas/barras: o valor entra num literal de string JS.
escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > "$CONFIG_PATH" <<EOF
// Gerado no boot do container por docker/entrypoint.sh — não editar à mão.
window.__APP_CONFIG__ = {
  googleClientId: "$(escape "$CLIENT_ID")"
};
EOF

if [ -z "$CLIENT_ID" ]; then
  echo "[entrypoint] AVISO: GOOGLE_CLIENT_ID não definido — a tela de login vai avisar que falta configurar." >&2
else
  echo "[entrypoint] config.js gerada (googleClientId=...${CLIENT_ID#"${CLIENT_ID%????}"})"
fi

exec "$@"
