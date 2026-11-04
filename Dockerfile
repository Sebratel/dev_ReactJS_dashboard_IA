# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Configuração do Firebase Authentication. Tem de estar presente AQUI, no
# build: o Vite grava essas variáveis dentro do bundle, então passá-las como
# `environment` do container não teria efeito nenhum — o JavaScript já estaria
# gerado sem elas, e o login falharia com "chave inválida" em produção enquanto
# funciona na sua máquina. Ver `build.args` no docker-compose.portainer.yml.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID

# Falha cedo e com a mensagem certa: sem isto o build passa, a imagem sobe e o
# erro só aparece no primeiro clique de quem for usar.
RUN test -n "$VITE_FIREBASE_API_KEY" -a -n "$VITE_FIREBASE_PROJECT_ID" \
    || (echo "ERRO: VITE_FIREBASE_API_KEY e VITE_FIREBASE_PROJECT_ID são obrigatórias no build (build.args do compose)." && exit 1)

RUN npm run build

FROM nginx:alpine AS serve

# Versão da aplicação como label da imagem (o Portainer a mostra). Vem do compose; o CI confere contra o package.json.
ARG APP_VERSION=0.0.0
LABEL org.opencontainers.image.version=$APP_VERSION

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# A imagem é agnóstica de ambiente: como o login é conduzido pelo servidor
# (fluxo de código de autorização), a SPA não precisa de Client ID nem de
# nenhuma outra configuração injetada em runtime — o segredo e o id ficam só no
# serviço `backend`. Por isso aqui não há entrypoint gerando config: nada a gerar.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
