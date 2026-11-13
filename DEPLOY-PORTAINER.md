# Deploy no Portainer (stack apontada para o GitHub)

Guia do deploy do **Indicadores Sebratel** num servidor interno, usando o
Portainer com a stack ligada a este repositório. Para o que o app faz, ver
[`DOCUMENTACAO.md`](DOCUMENTACAO.md).

---

## 1. O que sobe

A stack ([`docker-compose.portainer.yml`](docker-compose.portainer.yml)) tem três serviços:

| Serviço | Imagem | O que faz |
|---|---|---|
| `frontend` | nginx + build da SPA | Serve a interface e faz proxy de `/api/` para o `backend`. É o único com porta publicada. |
| `backend` | Node + Express | `/api/*`: workspace, catálogo de fontes, agregação dos widgets, montagem com IA. |
| `scheduler` | mesma imagem do `backend` | Job de segundo plano: materializa os datasets do Data Hub num snapshot. |

Dois volumes, os dois **compartilhados entre `backend` e `scheduler`**:

- `snapshot` — o snapshot materializado (dado de todas as fontes, comprimido).
- `data` — fontes do Data Hub, planilhas, workspace, usuários, sessões de
  login e a chave de cifra dos tokens (`data/.secret-key`).

> **Não separe esses volumes por serviço.** Com volumes diferentes, o `scheduler` não
> vê as fontes cadastradas pela tela (grava um snapshot vazio) e os tokens do
> Data Hub gravados pelo `backend` ficam indecifráveis do lado dele.

---

## 2. Criar a stack

No Portainer: **Stacks → Add stack → Repository**.

| Campo | Valor |
|---|---|
| Name | `indicadores-sebratel` |
| Repository URL | a URL deste repositório no GitHub |
| Repository reference | `refs/heads/main` (ou a branch que você publica) |
| Compose path | `docker-compose.portainer.yml` |
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

## 2.1. Staging, webhook e CI

Dois ambientes, **duas stacks no Portainer** (staging num host/Portainer próprio), o mesmo código:

| | Staging | Produção |
|---|---|---|
| Branch | `staging` | `main` |
| Stack no Portainer | `dev_reactjs_dashboard_ia-staging` | `indicadores-sebratel` (a atual — ver a nota de migração abaixo) |
| Compose path | `docker-compose.portainer.yml` | `docker-compose.portainer.yml` |
| Como atualiza | **automático**: push em `staging` → CI verde → webhook | **semi-automático**: PR para `main` (`ci-ok` + 1 aprovação) → merge → CI → job `deploy-production` espera a **aprovação do Environment `production`** → webhook |
| Firebase / Data Hub | projeto e token **de staging** | os de produção |
| `WEB_PORT` / `ADMIN_EMAILS` / `APP_ENV` | os do host de staging (`WEB_PORT=3011`, registrada; `APP_ENV=staging`) | os de produção (`APP_ENV=production`; a porta atual segue até a stack ser mexida) |

**Webhook de deploy de staging** (o job `deploy-staging` de [`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

1. No Portainer de staging: stack → **GitOps updates** → ligue **Webhook** e copie a URL.
2. No GitHub: *Settings → Environments → staging → Secrets* → crie `PORTAINER_WEBHOOK_URL_STAGING` com essa URL.
   A URL é segredo — quem a tem dispara deploy. Nunca a coloque em arquivo, log ou mensagem de commit
   (o `npm run security:scan` reprova URL de webhook versionada).
3. A partir daí, todo push em `staging` roda o CI inteiro e, **só se o `ci-ok` passar**, o job chama o webhook;
   o Portainer puxa a branch e **rebuilda no host** (o compose usa `build:`, não há registry).
4. Conferir: o job termina com "Webhook acionado"; no Portainer, a stack mostra o redeploy e os três serviços
   ficam **healthy**; `http://<staging>:<WEB_PORT>/api/health` responde `{"status":"ok",...}`.

**Webhook de deploy de produção** (job `deploy-production`, mesmo arquivo):

1. No Portainer de produção: stack `indicadores-sebratel` (não renomear) → **GitOps updates** → ligue **Webhook** (com *Re-pull image* e *Force redeployment*) e copie a URL.
2. No GitHub: *Settings → Environments → production*: marque **Required reviewers** (quem aprova o deploy); em *Secrets* crie `PORTAINER_WEBHOOK_URL_PRODUCTION`; em *Variables* (opcional) `HEALTH_URL_PRODUCTION` = `http://<host>:<WEB_PORT>/api/health`.
3. Merge na `main` → CI → o job aguarda aprovação → aciona o webhook → confere que `/api/health` responde `ok` na versão do `package.json` (até 5 min). Sem `HEALTH_URL_PRODUCTION`, a conferência é pulada com aviso.
4. O mesmo vale para o webhook de staging: ligue *Re-pull image* e *Force redeployment*. Sem polling em nenhuma das duas stacks.

> Não ligue o **polling** do GitOps junto com o webhook: o Portainer poderia puxar um commit antes do CI terminar.

**Versão da aplicação (regra mandatória da skill `cicd-deploy-backend`).** A versão vive no `package.json` (projeto novo
nasce em `1.0.0`) e **todo commit que sobe para `staging` ou `main` precisa ter versão estritamente MAIOR que a da branch
de destino** — o job `versao` do CI reprova igual ou menor. O Portainer enxerga a versão em três lugares: a **tag da
imagem** (`indicadores-sebratel-backend:1.0.1`), o label `org.opencontainers.image.version` dos containers e o campo
`version` de `/api/health`. Para mudar, **nunca edite na mão**: `npm run version:set -- 1.0.2` altera `package.json`,
`package-lock.json` e o valor padrão `${APP_VERSION:-X.Y.Z}` do compose juntos (o CI reprova se divergirem).
Patch = correção, minor = funcionalidade compatível, major = quebra de contrato.

**Nomes** (validados a cada PR por [`.github/scripts/validate-compose.py`](.github/scripts/validate-compose.py)):
`name:` é o nome do repositório em minúsculas (`dev_reactjs_dashboard_ia`); nenhum serviço define `container_name`;
os serviços têm o **papel** como nome — `frontend`, `backend`, `scheduler` — sem o nome do repositório nem palavra de
ambiente (`staging`, `prod`...). O ambiente se distingue pela **stack** e pelas variáveis, nunca pelo nome do serviço.

> **Migração dos nomes (stack de produção já existente).** Antes os serviços eram `web`/`api`/`etl` e o arquivo era
> `docker-compose.yml`. Ao apontar a stack para `docker-compose.portainer.yml`: (1) troque o **Compose path** na stack e
> faça *Pull and redeploy*; (2) os containers são recriados com os nomes novos — os **volumes não mudam** enquanto a
> stack mantiver o nome `indicadores-sebratel` (o Portainer passa o nome da stack ao Compose, que prefixa os volumes
> `snapshot` e `data`). **Não renomeie a stack de produção**: um nome novo cria volumes novos e vazios (a chave
> `SECRETS_KEY`, as fontes e as sessões ficariam para trás). Renomear só com cópia prévia dos volumes. (3) Se algo
> externo apontava para o nome do container (`web`/`api`), ajuste — nada neste repositório aponta.

**Rollback**: `git revert <commit>` na branch (via PR, com o CI rodando) e *Pull and redeploy*. Em emergência, aponte a
*Repository reference* da stack para o commit/tag anterior e faça o redeploy; depois corrija a branch. Nunca force-push
na `main`. O snapshot e o `data/` ficam nos volumes — o rollback de código não os desfaz (mudanças de formato de
`data/`, se houver, precisam ser compatíveis com a versão anterior).

**Teste de carga**: ver [`loadtest/README.md`](loadtest/README.md). O cenário `smoke` roda a cada PR; `load`, `stress`, `spike`,
`soak` e `abuso` são manuais (workflow *Carga (manual)*) e devem rodar antes de mudar o caminho quente ou o dimensionamento.

**Proteção da `main`** (configuração no GitHub, não é arquivo): *Settings → Rules*: exigir PR com 1 aprovação, exigir o
status check **`ci-ok`** (só ele), bloquear push direto e force-push.

---

## 3. Variáveis de ambiente da stack

Preencha em **Environment variables**, na própria tela da stack. O `.env` do
repositório é ignorado no deploy (está no `.gitignore` e no `.dockerignore`) —
o que vale é o que está aqui. Referência completa e comentada:
[`.env.example`](.env.example).

### Obrigatórias

| Variável | Para quê |
|---|---|
| `VITE_FIREBASE_API_KEY` | Chave web do projeto Firebase. **Entra no BUILD** do serviço `frontend` (é gravada no bundle), não no runtime. Ver seção 5. |
| `VITE_FIREBASE_AUTH_DOMAIN` | `<projeto>.firebaseapp.com`. Também de build. |
| `VITE_FIREBASE_PROJECT_ID` | Id do projeto Firebase (`authentication-dashboardsia`). De build **e** reaproveitada pelo `backend` como `FIREBASE_PROJECT_ID`. |
| `VITE_FIREBASE_APP_ID` | Id do app web. De build. |
| `ALLOWED_DOMAIN` | Domínio permitido no login. Padrão: `sebratel.com.br`. |
| `ADMIN_EMAILS` | Administradores iniciais, separados por vírgula. Só valem enquanto a instalação não tem nenhum administrador salvo; depois disso, quem entra pela primeira vez é Padrão e é promovido na aba **Acessos**. |
| `SECRETS_KEY` | Chave que cifra, em disco, os tokens do Data Hub e os tokens do Google das sessões. Gere com `openssl rand -base64 32`. |
| `WEB_PORT` | Porta publicada no host. **Registrada: 3011** (faixa de frontend 3000–3099; planilha de portas, PROD linha 50 e STAGING linha 51), a mesma em staging e produção. Sem a variável o compose usa 3011 (nunca porta aleatória). A produção já existente mantém o valor que a stack define até ser mexida; ao migrar, atualize junto o upstream do NPM, o firewall e a monitoração. |

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
| `DHUB_PAGE_SIZE` / `DHUB_MAX_ROWS` / `DHUB_TIMEOUT_MS` | `10000` / `500000` / `120000` | Ajuste fino da busca no Data Hub (fontes em cópia local). O padrão de página é 10.000 porque é o teto do próprio Data Hub — pedir mais só gasta round-trip. |
| `DHUB_COPY_MAX_MB` | `100` | Teto de UMA fonte em cópia local, em MB de JSON. Acima disso a fonte vira erro nela mesma, sugerindo a leitura direta, em vez de derrubar o ciclo do ETL. Vai em `backend` e `scheduler`. |
| `DHUB_QUERY_CACHE_SECONDS` / `DHUB_QUERY_CONCURRENCY` / `DHUB_QUERY_TIMEOUT_MS` | `60` / `6` / `45000` | Leitura direta (só a `backend`): quanto tempo o resultado de uma consulta fica em cache, quantas consultas vão ao Data Hub ao mesmo tempo e o tempo limite de cada uma. Os padrões casam com o motor do Data Hub (6 vagas para painéis, 30 s por consulta). |
| (sem variável) versão nova do app | — | Depois de um redeploy, quem está com o app aberto vê "Saiu uma versão nova do app — Atualizar agora" em até 2 min, e o servidor recusa salvar de uma página de versão antiga (pede F5). Não é preciso avisar a equipe por fora. |
| `TAB_LOCK_TTL_SECONDS` | `120` | Bloqueio de edição por guia (só a `backend`): em quanto tempo o bloqueio de quem fechou a tela, perdeu a rede ou a deixou parada vence sozinho. A tela renova a cada 30 s. Fica em memória, então a `backend` roda numa instância só — o que a memória da IA já exigia. |

> **Leitura direta exige o Data Hub atualizado.** A fonte em "Direto no Data Hub" usa a rota `POST /api/public/v1/datasets/:slug/query` do Data Hub (commit `3cea3c6` "API publica: consulta agregada pelo token", na branch `staging` de `Sebratel/dev_DataHub_ReactJS`). Sem ela, o cadastro recusa a leitura direta com a mensagem "ainda não tem a consulta direta" e a fonte pode ser salva como cópia local; as fontes que já existem seguem em cópia e não são afetadas. A ordem segura é: publicar o Data Hub, depois esta stack.
| `SESSION_TTL_DAYS` | `30` | Tempo de vida da sessão de login. |
| `MANUAL_PATH` | `manual/manual-de-uso.pdf` (dentro da imagem `backend`) | PDF da página "Manual de uso". Apontar para um arquivo no volume `data` (ex.: `/app/data/manual-de-uso.pdf`) permite trocar o manual sem rebuild. |

> `SECRETS_KEY` precisa ser **a mesma** nos serviços `backend` e `scheduler` — o compose
> já garante isso passando a mesma variável para os dois. Trocar a chave depois
> invalida os tokens do Data Hub já cadastrados: eles precisam ser
> recadastrados na tela (o resto do cadastro é preservado).

---

## 4. Depois de subir

1. `docker compose ps` (ou a tela da stack): `frontend` e `backend` devem ficar
   **healthy**; `scheduler` tem healthcheck próprio (o processo do agendador está vivo — ele não abre porta).
2. Abra `http://<servidor>:<WEB_PORT>/api/health` — deve responder
   `{"status":"ok","ok":true,...}`. Se der 502, o `backend` não subiu (veja os logs dele).
3. Faça login. A mensagem de erro diz de onde veio a recusa, e cada uma tem uma
   causa típica (seção 5): "endereço não está liberado no Firebase" é o host
   faltando em **Authorized domains**; "chave do Firebase não é válida" é
   `VITE_FIREBASE_*` ausente **no build** (redeploy com rebuild); "login não
   configurado no servidor" é `FIREBASE_PROJECT_ID` faltando no `backend`; e
   "acesso restrito a contas @..." é conta de fora do domínio — essa é o
   sistema funcionando.
4. Com uma conta de administrador (ver `ADMIN_EMAILS`), vá em **Configurações**
   para cadastrar as fontes — a tela não aparece para o usuário Padrão.
5. **Trocar o manual de uso**: substitua `manual/manual-de-uso.pdf` no
   repositório por outro PDF com o mesmo nome e faça o redeploy (a imagem `backend`
   copia a pasta). O número de slides é lido do arquivo. Para trocar sem
   rebuild, use `MANUAL_PATH` (seção 3) apontando para o volume `data`.

Nenhum **segredo** é assado na imagem. O que vai no bundle do `frontend` são as
`VITE_FIREBASE_*`, que são públicas por design (o navegador precisa delas para
falar com o Firebase) — e é justamente por irem no bundle que mudá-las exige
**rebuild**, não só reiniciar. O que o `backend` lê em runtime é o
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

O `backend` recebe `FIREBASE_PROJECT_ID` (derivado de `VITE_FIREBASE_PROJECT_ID` no
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
| "login não configurado no servidor" | Falta `FIREBASE_PROJECT_ID` no `backend`. |
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

- **Tudo em `public/` é público.** O nginx do `frontend` serve o `dist/` inteiro sem
  login. Por isso o snapshot versionado (`public/installData.data`, dado real)
  está no `.dockerignore` desde 01/10/2026 — antes disso,
  `/installData.data` respondia para qualquer um. Imagem construída antes dessa
  data continua servindo o arquivo até o próximo redeploy.
- **Sem `container_name` fixo.** O Portainer prefixa os containers com o nome
  da stack. Nome fixo colide se você tiver duas stacks no mesmo host (ex.
  homologação e produção) e atrapalha o redeploy.
- **O `frontend` sobe mesmo se o `backend` estiver fora.** O nginx resolve o endereço do
  `backend` **por requisição**, via DNS interno do Docker, em vez de no start (ver o
  comentário em [`docker/nginx.conf`](docker/nginx.conf)). Com resolução no
  start, o nginx se recusa a subir quando o `backend` ainda não existe e guarda o IP
  antigo quando o `backend` é recriado — e todo redeploy recria containers. Com a
  resolução diferida, `/api/` responde 502 enquanto o backend não está de pé e
  volta sozinho quando ele sobe.
- **O `backend` monta o volume do snapshot com escrita.** Ele dispara o ETL em
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
