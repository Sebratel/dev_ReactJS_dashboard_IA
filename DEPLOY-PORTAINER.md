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
| `api` | Node + Express | `/api/*`: workspace, catálogo de fontes, agregação dos widgets. |
| `etl` | mesma imagem do `api` | Job de segundo plano: materializa as fontes (queries SQL + datasets do Data Hub) num snapshot. |

Dois volumes, os dois **compartilhados entre `api` e `etl`**:

- `snapshot` — o snapshot materializado (dado de todas as fontes, comprimido).
- `data` — catálogo de queries, fontes do Data Hub, planilhas, workspace,
  usuários e a chave de cifra dos tokens (`data/.secret-key`).

> **Não separe esses volumes por serviço.** Com volumes diferentes, o ciclo do
> `etl` sobrescreve o snapshot usando só o catálogo semente (descartando o que
> foi cadastrado pela tela) e os tokens do Data Hub cadastrados pelo `api`
> ficam indecifráveis do lado do `etl`.

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
| `GOOGLE_CLIENT_ID` | Client ID da aplicação Google. Vai para o `web` (login) e para o `api`. |
| `ALLOWED_DOMAIN` | Domínio permitido no login. Padrão: `sebratel.com.br`. |
| `ADMIN_EMAILS` | Administradores iniciais, separados por vírgula. |
| `SECRETS_KEY` | Chave que cifra os tokens do Data Hub em disco. Gere com `openssl rand -base64 32`. |

### Bancos de origem (se você usar fontes SQL)

`DB_ELLEVEN_HOST`, `DB_ELLEVEN_PORT`, `DB_ELLEVEN_DATABASE`, `DB_ELLEVEN_USER`,
`DB_ELLEVEN_PASSWORD`, `DB_ELLEVEN_SSL` e os equivalentes `DB_MARIA_*`.

Vão para **os dois** serviços, `api` e `etl`: o `etl` roda as queries do
catálogo, e o `api` precisa das mesmas credenciais para o botão "Testar" do
editor de query e para disparar o ETL sob demanda.

Uma instalação que consuma **só** o Data Hub pode deixar tudo isso vazio: as
queries SQL falham individualmente (mantendo o último dado bom) e o resto da
stack funciona normalmente.

### Opcionais

| Variável | Padrão | Para quê |
|---|---|---|
| `WEB_PORT` | `8081` | Porta publicada no host. |
| `DHUB_BASE_URL` | `https://data-hub.sebratel.net.br` | Endereço sugerido no cadastro de uma fonte do Data Hub. |
| `ETL_BASE_INTERVAL_MINUTES` | `2` | Ciclo base do ETL. Não é o ritmo de cada fonte — isso se configura por fonte, na tela. |
| `ETL_RUN_ON_START` | `false` | `true` força uma execução do ETL assim que o container sobe. |
| `DHUB_PAGE_SIZE` / `DHUB_MAX_ROWS` / `DHUB_TIMEOUT_MS` | `50000` / `500000` / `120000` | Ajuste fino da busca no Data Hub. |
| `GOOGLE_CLIENT_SECRET` | — | Ver seção 5. Declarada e **sem efeito** no login atual. |

> `SECRETS_KEY` precisa ser **a mesma** nos serviços `api` e `etl` — o compose
> já garante isso passando a mesma variável para os dois. Trocar a chave depois
> invalida os tokens do Data Hub já cadastrados: eles precisam ser
> recadastrados na tela (o resto do cadastro é preservado).

---

## 4. Depois de subir

1. `docker compose ps` (ou a tela da stack): `web` e `api` devem ficar
   **healthy**; `etl` não tem healthcheck, é um job em laço.
2. Abra `http://<servidor>:8081/config.js` — deve mostrar o seu
   `GOOGLE_CLIENT_ID`. Se vier vazio, a env não chegou no serviço `web`.
3. Abra `http://<servidor>:8081/api/health` — deve responder
   `{"ok":true,...}`. Se der 502, o `api` não subiu (veja os logs dele).
4. Faça login e vá em **Configurações** para cadastrar as fontes.

O Client ID **não é assado na imagem**: o container gera `/config.js` no boot a
partir do ambiente (ver [`docker/entrypoint.sh`](docker/entrypoint.sh)). Trocar
de Client ID é editar a variável e reiniciar a stack — sem reconstruir imagem.

---

## 5. SSO — situação atual do `GOOGLE_CLIENT_SECRET`

Vale ser explícito para não haver surpresa: **o login de hoje não usa client
secret.** Ele é o fluxo implícito do Google Identity Services, feito inteiro no
navegador — a página pede um `access_token` ao Google e o backend valida esse
token contra a API de `userinfo` do Google a cada requisição
([`server/index.mjs`](server/index.mjs), `getUserFromToken`). Nesse desenho não
existe nenhum passo em que um segredo do servidor seja necessário.

`GOOGLE_CLIENT_SECRET` está declarada na stack e chega ao container do `api`
para o caso de migrarmos para o **fluxo de código de autorização** (o servidor
recebe um `code` e o troca por tokens, usando o secret). Essa migração traz
ganhos concretos:

- `refresh_token` de verdade — hoje a sessão depende de renovação silenciosa
  que só funciona enquanto a sessão Google do navegador estiver viva;
- o token deixa de transitar pelo JavaScript da página (cookie `HttpOnly`);
- as planilhas do Google passariam a poder atualizar em segundo plano, o que
  hoje é impossível (ver o comentário em
  [`server/sheetSources.mjs`](server/sheetSources.mjs)).

Mas ela mexe em login, store de autenticação, cliente HTTP e middleware de
auth — não é um ajuste de configuração. Enquanto não for feita, a variável fica
sem efeito.

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
- **`/config.js` é `no-store`.** Se fosse cacheado, trocar o Client ID e
  reiniciar não teria efeito em quem já tem a versão antiga no navegador.
- **O `api` monta o volume do snapshot com escrita.** Ele dispara o ETL em
  segundo plano quando alguém mexe no catálogo de fontes, e é o ETL que escreve
  ali. Montar como somente-leitura faz essa atualização sob demanda falhar
  silenciosamente.
