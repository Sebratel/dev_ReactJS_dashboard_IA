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
| `VITE_FIREBASE_API_KEY` | Chave web do projeto Firebase. **Entra no BUILD** do serviço `web` (é gravada no bundle), não no runtime. Ver seção 5. |
| `VITE_FIREBASE_AUTH_DOMAIN` | `<projeto>.firebaseapp.com`. Também de build. |
| `VITE_FIREBASE_PROJECT_ID` | Id do projeto Firebase (`authentication-dashboardsia`). De build **e** reaproveitada pelo `api` como `FIREBASE_PROJECT_ID`. |
| `VITE_FIREBASE_APP_ID` | Id do app web. De build. |
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
3. Faça login. A mensagem de erro diz de onde veio a recusa, e cada uma tem uma
   causa típica (seção 5): "endereço não está liberado no Firebase" é o host
   faltando em **Authorized domains**; "chave do Firebase não é válida" é
   `VITE_FIREBASE_*` ausente **no build** (redeploy com rebuild); "login não
   configurado no servidor" é `FIREBASE_PROJECT_ID` faltando no `api`; e
   "acesso restrito a contas @..." é conta de fora do domínio — essa é o
   sistema funcionando.
4. Vá em **Configurações** para cadastrar as fontes.

Nenhum **segredo** é assado na imagem. O que vai no bundle do `web` são as
`VITE_FIREBASE_*`, que são públicas por design (o navegador precisa delas para
falar com o Firebase) — e é justamente por irem no bundle que mudá-las exige
**rebuild**, não só reiniciar. O que o `api` lê em runtime é o
`FIREBASE_PROJECT_ID` e a `SECRETS_KEY`; esses sim trocam com um restart.

---

## 5. SSO — Firebase Authentication

Desde 13/09/2026 o login usa **Firebase Authentication** (projeto
`authentication-dashboardsia`), no padrão da skill `padrao-login-sso`:

```
navegador → popup do Google pelo SDK do Firebase (que vem no BUNDLE, via npm)
          → ID token (JWT RS256 assinado pelo Google)
          → POST /api/auth/session
          → servidor confere a ASSINATURA localmente, com a chave pública
            em cache (server/firebaseToken.mjs)
          → cookie de sessão HttpOnly (sessão gravada em data/sessions.json)
```

**Por que isto e não o fluxo anterior:** o fluxo de código de autorização
dependia da saída para o Google *a cada* validação. Aqui, depois de buscar os
certificados uma vez (e eles ficam em cache no volume `data`), a API valida
login **sem tocar na rede** — se a saída cair, quem tem token válido continua
entrando. Não há mais `GOOGLE_CLIENT_SECRET`, `APP_BASE_URL` nem
`redirect_uri` para cadastrar.

A sessão continua sendo um id opaco num cookie `HttpOnly`/`SameSite=Lax`, com
30 dias (`SESSION_TTL_DAYS`): o ID token do Firebase só prova quem é na hora de
entrar, e vence em 1 h — quem sustenta a navegação é a sessão.

### ⚠️ As `VITE_FIREBASE_*` são de BUILD, não de runtime

O Vite grava esses valores **dentro do JavaScript** na hora de compilar. No
Portainer isso significa:

> Mudou qualquer `VITE_FIREBASE_*`? **Redeploy com `Re-pull image and rebuild`.**
> Recriar o container sozinho não muda nada — o bundle já foi gerado.

O `Dockerfile` recebe as quatro como `ARG`/`ENV` e **falha o build** se a chave
ou o project id vierem vazios: melhor quebrar aqui do que subir uma imagem que
só mostra "chave inválida" no primeiro clique de quem for usar.

O `api` recebe `FIREBASE_PROJECT_ID` (derivado de `VITE_FIREBASE_PROJECT_ID` no
compose) como variável normal de runtime — é contra ele que o `aud` e o `iss`
do token são conferidos.

### O que configurar no console do Firebase (uma vez, e é sempre esquecido)

1. **Authentication → Sign-in method → Google → Ativar.** Projeto novo vem com
   todos os provedores desligados.
2. **Authentication → Settings → Authorized domains** → adicionar o host de
   produção (ex. `indicadores.interno`). Só `localhost` vem liberado de
   fábrica. Sem isso o popup falha com `auth/unauthorized-domain` — e esse erro
   só aparece no **primeiro clique real**, nunca no build. A tela de login
   mostra essa mensagem já traduzida, dizendo exatamente onde configurar.
3. **Google Cloud → APIs e serviços → Credenciais → a chave de navegador**:
   restrinja a **Identity Toolkit / Token Service** e aos referenciadores HTTP
   do sistema. A chave é pública por design (vai no bundle), e isso só é
   inofensivo enquanto ela não servir a APIs cobradas.
4. **API do Google Sheets habilitada** no mesmo projeto, se for usar fonte por
   planilha (o escopo `spreadsheets.readonly` é pedido no popup).

### Se o login falhar: de quem é a recusa

| Mensagem | Onde está o problema |
|---|---|
| "endereço não está liberado no Firebase" (`auth/unauthorized-domain`) | Falta o host em **Authentication → Settings → Authorized domains**. |
| "provedor Google deste projeto Firebase está com credencial inválida" (`auth/invalid-credential`) | O **client secret** em *Sign-in method → Google → Web SDK configuration* não confere com o client ID dele. Ver abaixo. |
| "chave do Firebase não é válida" | `VITE_FIREBASE_*` ausente **no build** — redeploy com rebuild. |
| "login não configurado no servidor" | Falta `FIREBASE_PROJECT_ID` no `api`. |
| "acesso restrito a contas @…" | Conta de fora do domínio. É o sistema funcionando. |

**Como saber se um client secret é válido, sem adivinhar** — peça um token ao
Google com um código propositalmente falso:

```bash
curl -s -X POST https://oauth2.googleapis.com/token \
  -d grant_type=authorization_code -d code=codigo-falso \
  -d client_id=<CLIENT_ID> -d client_secret=<CLIENT_SECRET> \
  -d redirect_uri=https://<projeto>.firebaseapp.com/__/auth/handler
```

- `invalid_client` → **o segredo não confere** com esse client ID.
- `invalid_grant` (*Malformed auth code*) → **o par está certo**; o erro é só o
  código falso, como esperado. O problema está no que o console guardou.

### Detalhes que valem saber

- **Planilha do Google depende de um token que vence em ~1 h.** O fluxo web do
  Firebase não devolve `refresh_token`, então o `access_token` capturado no
  login serve por cerca de uma hora; depois disso as fontes por planilha
  respondem pelo **cache** até a pessoa entrar de novo. Isso **não** derruba a
  sessão — de propósito.
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
- **O volume `snapshot` precisa pertencer ao usuário da imagem (`app`).** A
  imagem da API roda sem privilégio, e quem grava o snapshot é esse usuário. O
  [`Dockerfile.api`](Dockerfile.api) cria `/snapshot` já com esse dono, o que
  resolve volume novo ou vazio — mas o Docker não mexe em volume que já tem
  conteúdo. Um volume com arquivo de outro dono continua recusando a gravação,
  e o sintoma é a fonte em Configurações com o erro "o snapshot não pôde ser
  gravado … EACCES" (em versões anteriores do ETL, pior: contagem de linhas na
  tela e nenhuma coluna no Builder, sem erro nenhum). Correção de uma vez, sem perder
  nada — no Portainer, *Containers → `<stack>-api-1` → Console*, usuário
  `root`, ou pelo host:

  ```bash
  docker exec -u 0 <container-da-api> chown -R app:app /snapshot
  ```

  Depois, **Sincronizar agora** na fonte. Alternativa: remover o volume
  `<stack>_snapshot` e redeployar — o snapshot é cache, o ETL reconstrói tudo
  a partir do Data Hub.
