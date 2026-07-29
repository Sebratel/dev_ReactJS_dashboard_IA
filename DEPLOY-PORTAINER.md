# Deploy no Portainer (stack apontada para o GitHub)

Guia do deploy do **Indicadores Sebratel** num servidor interno, usando o
Portainer com a stack ligada a este repositório. Para o que o app faz, ver
[`DOCUMENTACAO.md`](DOCUMENTACAO.md).

---

## 1. O que sobe

A stack ([`docker-compose.yml`](docker-compose.yml)) tem três serviços:

| Serviço | Imagem | O que faz |
|---|---|---|
| `web` | nginx + build da SPA | Serve a interface e faz proxy de `/api/` para o `api`. É o único com porta publicada. |
| `api` | Node + Express | `/api/*`: workspace, catálogo de fontes, agregação dos widgets, montagem com IA. |
| `etl` | mesma imagem do `api` | Job de segundo plano: materializa os datasets do Data Hub num snapshot. |

Dois volumes, os dois **compartilhados entre `api` e `etl`**:

- `snapshot` — o snapshot materializado (dado de todas as fontes, comprimido).
- `data` — fontes do Data Hub, planilhas, workspace, usuários, sessões de
  login e a chave de cifra dos tokens (`data/.secret-key`).

> **Não separe esses volumes por serviço.** Com volumes diferentes, o `etl` não
> vê as fontes cadastradas pela tela (grava um snapshot vazio) e os tokens do
> Data Hub gravados pelo `api` ficam indecifráveis do lado dele.

---

## 2. Criar a stack

No Portainer: **Stacks → Add stack → Repository**.

| Campo | Valor |
|---|---|
| Name | `indicadores-sebratel` |
| Repository URL | a URL deste repositório no GitHub |
| Repository reference | `refs/heads/main` (ou a branch que você publica) |
| Compose path | `docker-compose.yml` |
| Authentication | ligado, se o repositório for privado (usuário + Personal Access Token) |

**GitOps updates** (opcional, recomendado): ligue **Automatic updates**. Duas
formas:

- **Polling** — o Portainer verifica a branch a cada X minutos e redeploya
  quando o commit muda. Simples, sem configurar nada no GitHub.
- **Webhook** — o Portainer gera uma URL; cadastre em
  *Settings → Webhooks* do repositório no GitHub. Redeploy imediato a cada push.

Como o compose usa `build:`, **o servidor constrói as imagens** a partir do
repositório clonado, a cada deploy. É o caminho sem registry: nada para
publicar, nada de credencial de imagem — em troca, cada deploy gasta CPU/disco
do servidor rodando `npm ci` + `vite build` dentro dele. Se um dia isso
incomodar, o passo é publicar as imagens num registry (GHCR) por GitHub Actions
e trocar `build:` por `image:` com tag.

---

## 3. Variáveis de ambiente da stack

Preencha em **Environment variables**, na própria tela da stack. O `.env` do
repositório é ignorado no deploy (está no `.gitignore` e no `.dockerignore`) —
o que vale é o que está aqui. Referência completa e comentada:
[`.env.example`](.env.example).

### Obrigatórias

| Variável | Para quê |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID da aplicação Google. Só o `api` precisa. |
| `GOOGLE_CLIENT_SECRET` | Client secret da mesma aplicação — é com ele que o servidor troca o `code` por tokens. Ver seção 5. |
| `APP_BASE_URL` | Endereço público da aplicação (ex. `http://indicadores.interno:8081`). Monta o `redirect_uri` que precisa estar cadastrado no Google. Ver seção 5. |
| `ALLOWED_DOMAIN` | Domínio permitido no login. Padrão: `sebratel.com.br`. |
| `ADMIN_EMAILS` | Administradores iniciais, separados por vírgula. |
| `SECRETS_KEY` | Chave que cifra, em disco, os tokens do Data Hub e os tokens do Google das sessões. Gere com `openssl rand -base64 32`. |
| `WEB_PORT` | Porta publicada no host (ex. `8081`). **Não tem valor padrão**: se ficar em branco, o compose só emite um aviso e o Docker publica numa porta **aleatória** — a stack sobe, mas fica inacessível no endereço esperado. |

### Não há credencial de banco

Esta stack **não fala com banco de dados** — não existe `DB_ELLEVEN_*` nem
`DB_MARIA_*` para preencher, e as imagens não trazem driver de Postgres ou
MySQL. Todo dado corporativo entra pelo Data Hub, cadastrado na tela pelo
próprio usuário (com o token dele). Havia antes um catálogo de queries SQL que
batia direto no ERP e no MariaDB; ele foi removido porque manter os dois
caminhos consumia duas plataformas grandes pela mesma informação.

Para dado que não vai ser publicado no Data Hub, existem as planilhas do
Google — que usam o login do próprio usuário, sem credencial de serviço.

### Opcionais

| Variável | Padrão | Para quê |
|---|---|---|
| `DHUB_BASE_URL` | `https://data-hub.sebratel.net.br` | Endereço sugerido no cadastro de uma fonte do Data Hub. |
| `ETL_BASE_INTERVAL_MINUTES` | `2` | Ciclo base do ETL. Não é o ritmo de cada fonte — isso se configura por fonte, na tela. |
| `ETL_RUN_ON_START` | `false` | `true` força uma execução do ETL assim que o container sobe. |
| `DHUB_PAGE_SIZE` / `DHUB_MAX_ROWS` / `DHUB_TIMEOUT_MS` | `10000` / `500000` / `120000` | Ajuste fino da busca no Data Hub. O padrão de página é 10.000 porque é o teto do próprio Data Hub — pedir mais só gasta round-trip. |
| `SESSION_TTL_DAYS` | `30` | Tempo de vida da sessão de login. |

> `SECRETS_KEY` precisa ser **a mesma** nos serviços `api` e `etl` — o compose
> já garante isso passando a mesma variável para os dois. Trocar a chave depois
> invalida os tokens do Data Hub já cadastrados: eles precisam ser
> recadastrados na tela (o resto do cadastro é preservado).

---

## 4. Depois de subir

1. `docker compose ps` (ou a tela da stack): `web` e `api` devem ficar
   **healthy**; `etl` não tem healthcheck, é um job em laço.
2. Abra `http://<servidor>:8081/api/health` — deve responder
   `{"ok":true,...}`. Se der 502, o `api` não subiu (veja os logs dele).
3. Faça login. Se a tela mostrar um erro em vez de ir para o Google, ele veio do
   servidor — as causas usuais são `GOOGLE_CLIENT_SECRET` ausente ou o
   `redirect_uri` não cadastrado (seção 5).
4. Vá em **Configurações** para cadastrar as fontes.

Nenhuma credencial é assada na imagem: o Client ID e o Secret são lidos do
ambiente pelo `api`, em runtime. Trocar de credencial é editar a variável e
reiniciar a stack — sem reconstruir imagem.

---

## 5. SSO — fluxo de código de autorização

O login é conduzido **pelo servidor**. O navegador nunca vê um token do Google:

```
navegador → GET /api/auth/google/start        (servidor gera `state`, redireciona)
          → accounts.google.com               (usuário escolhe a conta)
          → GET /api/auth/google/callback     (servidor troca o `code` por tokens
                                               usando o GOOGLE_CLIENT_SECRET)
          → cookie de sessão HttpOnly         (sessão gravada em data/sessions.json)
```

A sessão é um id opaco num cookie `HttpOnly`/`SameSite=Lax`; o `access_token` e
o `refresh_token` do Google ficam no servidor, **cifrados** com a `SECRETS_KEY`
(mesma chave dos tokens do Data Hub). Quando o access token vence, o servidor
renova sozinho pelo refresh token — o usuário não é deslogado a cada hora.

### O que configurar no Google Cloud (uma vez)

Em **APIs e serviços → Credenciais → seu Client ID OAuth**, cadastre o
**URI de redirecionamento autorizado**:

```
<APP_BASE_URL>/api/auth/google/callback
```

Ele precisa ser **idêntico**, caractere por caractere, ao que a API monta —
inclusive esquema e porta. Cadastre um por ambiente, por exemplo:

```
http://localhost:5173/api/auth/google/callback          (desenvolvimento)
http://indicadores.interno:8081/api/auth/google/callback (produção)
```

Se o URI não bater, o Google recusa antes de qualquer coisa e a tela de login
mostra a mensagem que ele devolveu (`redirect_uri_mismatch`).

### Detalhes que valem saber

- **A tela de consentimento aparece a cada login.** É deliberado: o fluxo pede
  `access_type=offline&prompt=consent`, e sem `prompt=consent` o Google só
  devolve `refresh_token` no primeiro consentimento de cada usuário — nos
  logins seguintes a sessão não teria como se renovar. Como a sessão dura
  `SESSION_TTL_DAYS` (30 por padrão), logar é raro.
- **`Secure` no cookie é condicional.** Marcado só quando a requisição chega por
  https. Num servidor interno em http puro, marcar `Secure` sempre faria o
  navegador descartar o cookie e o login nunca completaria.
- **Trocar a `SECRETS_KEY` desloga todo mundo** — as sessões salvas ficam
  ilegíveis (e são tratadas como expiradas, não como erro).
- **Sessões sobrevivem a restart/redeploy**, porque ficam no volume `data`. Um
  redeploy da stack não desloga ninguém.
- **Logout invalida de verdade**: destrói a sessão no servidor, em vez de só
  limpar o estado do navegador.
- **A migração invalida as sessões antigas**: quem estava logado pelo fluxo
  anterior precisa entrar novamente, uma vez.

---

## 6. Detalhes que evitam dor de cabeça

- **Sem `container_name` fixo.** O Portainer prefixa os containers com o nome
  da stack. Nome fixo colide se você tiver duas stacks no mesmo host (ex.
  homologação e produção) e atrapalha o redeploy.
- **O `web` sobe mesmo se o `api` estiver fora.** O nginx resolve o endereço do
  `api` **por requisição**, via DNS interno do Docker, em vez de no start (ver o
  comentário em [`docker/nginx.conf`](docker/nginx.conf)). Com resolução no
  start, o nginx se recusa a subir quando o `api` ainda não existe e guarda o IP
  antigo quando o `api` é recriado — e todo redeploy recria containers. Com a
  resolução diferida, `/api/` responde 502 enquanto o backend não está de pé e
  volta sozinho quando ele sobe.
- **O `api` monta o volume do snapshot com escrita.** Ele dispara o ETL em
  segundo plano quando alguém mexe no catálogo de fontes, e é o ETL que escreve
  ali. Montar como somente-leitura faz essa atualização sob demanda falhar
  silenciosamente.
