# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

FROM nginx:alpine AS serve

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# A config da SPA (Client ID do Google) NÃO é assada no build: o entrypoint
# gera /config.js no boot a partir do ambiente do container, então a mesma
# imagem serve qualquer ambiente e trocar de Client ID é só reiniciar a stack.
COPY docker/entrypoint.sh /docker-entrypoint-sebratel.sh
RUN chmod +x /docker-entrypoint-sebratel.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/docker-entrypoint-sebratel.sh"]
CMD ["nginx", "-g", "daemon off;"]
