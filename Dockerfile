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

# A imagem é agnóstica de ambiente: como o login é conduzido pelo servidor
# (fluxo de código de autorização), a SPA não precisa de Client ID nem de
# nenhuma outra configuração injetada em runtime — o segredo e o id ficam só no
# serviço `api`. Por isso aqui não há entrypoint gerando config: nada a gerar.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
