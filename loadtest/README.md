# Teste de carga (loadtest)

Carga **real** sobre a API deste projeto (`server/index.mjs`, o mesmo código do container): login de verdade,
dataset sintético no snapshot, tudo numa pasta temporária que some no fim. **Nunca toca em `data/`, no Data Hub
nem na rede de fora.** O repositório guarda só scripts; os dados e os resultados nascem no teste.

Mesma bateria feita nos projetos `Dev_ReactJS_Agile_Cancellation` e `dev_SpringBoot_APIDashboards`
(carga nominal, stress, spike, soak, abuso e segurança sob carga), adaptada a este stack — uma API Node/Express
única, sem banco, que carrega o snapshot inteiro na memória.

## Rodar

```bash
node loadtest/run.mjs smoke                 # ~40 s — roda a cada PR no CI
node loadtest/run.mjs load                  # 10 min no ritmo do expediente (critério de aceite)
node loadtest/run.mjs stress                # degraus até saturar e volta (~13 min)
node loadtest/run.mjs spike                 # todo mundo abre ao mesmo tempo (~5 min)
node loadtest/run.mjs abuso                 # um cliente tentando derrubar a API (~3 min)
SOAK_SECONDS=3600 node loadtest/run.mjs soak   # vazamento de memória (padrão 30 min)
node loadtest/run.mjs load stress spike     # vários, cada um com uma API nova
```

Requer Node 20+ e `openssl` (já vem no Git for Windows, no macOS e no Linux). Sem Docker, sem k6.
Variáveis: `ROWS` (linhas do dataset, padrão 100 000), `USERS` (60), `HEAP_MB` (1024 — o teto do compose),
`LOAD_SECONDS` (600), `SOAK_SECONDS` (1800), `OUT_DIR`. No CI manual: *Actions → Carga (manual)*.

Saída: resumo no terminal, `loadtest/out/<cenário>-summary.json` (inclui a série de memória) e
`loadtest/out/RESULTS.md`. O código de saída é 1 se `smoke` ou `load` violarem algum limite.
O [`RESULTS.md`](./RESULTS.md) desta pasta é o relatório curado da última medição de referência.

## O que existe

| Arquivo | Função |
|---|---|
| `run.mjs` | Cenários, gerador de chegadas, métricas por endpoint, critério de aceite, relatório |
| `../scripts/lib/harness.mjs` | Sobe a API real numa pasta temporária: par de chaves + certificado no cache do Firebase, snapshot e workspace gravados pelos módulos do servidor, login por ID token RS256 assinado de verdade |
| `../scripts/test-security.mjs` | Os mesmos usuários e a mesma API, atacados (ver `npm run test:security`) |

## Modelo de carga

- **Login real**: 59 usuários + 1 administrador entram por `POST /api/auth/session` com um ID token assinado; o
  servidor valida assinatura, `iss`, `aud`, validade e domínio pelo mesmo caminho de produção e devolve o cookie.
  Não usa `AUTH_DISABLED` (o harness o força para `false`, mesmo que haja `.env` local).
- **Abertura de dashboard** (a unidade da taxa): árvore → dashboard → 6 widgets em paralelo (KPI, KPI com filtro de
  guia, barras, barras com filtro, linha por mês, tabela paginada) ≈ 8 requisições.
- **Ruído de fundo**: pulso de bloqueio de guia, heartbeat, `/auth/me`, catálogo de fontes, valores de campo.
- **Interação**: clique que filtra a guia (nova consulta de widgets), comentário criado e removido.
- **Executores de chegada (modelo aberto)**: a taxa não diminui quando a API fica lenta. É o que mostra o ponto de
  saturação de verdade — um modelo fechado "freia" junto com o servidor e esconde o problema.
- **Aquecimento fora da medição**: a 1ª consulta carrega e descomprime o snapshot (síncrono) e o 1º acesso de cada
  usuário grava `users.json`. O custo fica no resumo como `primeiroAcessoMs`.
- **Sonda de saúde**: `GET /api/health` a cada 500 ms durante todo o cenário (`sonda_health`) — mede o quanto o
  laço de eventos fica bloqueado e se a latência volta ao normal no fim do stress/spike.
- **Segurança sob carga** (`seg_*`): sem cookie → 401, cookie falso → 401, rota de admin com usuário comum → 403,
  pasta restrita → 403/404, JSON quebrado → 400, ID token inválido → 401. Qualquer status diferente do esperado
  conta como `respostas_inesperadas` e reprova.
- **Abuso**: `pageSize` absurdo, agregação por campo com um grupo por linha, corpo de ~1,9 MB, corpo de 5 MB (tem de
  dar 413) e ordenação da tabela inteira — enquanto o tráfego nominal segue.
- **Medidas do processo**: RSS da API a cada 2 s, o processo que cai (watchdog) e o log de erro da API.

## Critérios de aceite (`smoke` e `load`)

| Métrica | Limite |
|---|---|
| Falhas (5xx / erro de rede) | < 1% e **zero** respostas inesperadas |
| Widgets (KPI, barras, linha) p95 / p99 | < 1 s / < 2,5 s |
| Tabela e valores distintos p95 | < 1,2 s |
| Árvore, `/auth/me`, pulso, heartbeat p95 | < 500 ms |
| Dashboard (leitura) p95 | < 600 ms |
| API de pé no fim | sim |

No `stress`/`spike` não há aprovação: o objetivo é descobrir o limite, **como a API degrada** e se ela **se
recupera** quando a carga volta ao normal (o relatório mostra o p95 da sonda no início e no fim). O `soak` compara a
memória da 1ª e da 2ª metade. O `abuso` mede o quanto UM cliente consegue degradar o caminho quente.

## Limites conhecidos do teste

- O gerador de carga e a API rodam na **mesma máquina** e competem por CPU; os números absolutos em CI (2 vCPU) e no
  servidor real diferem. Use-os para **comparar** (antes/depois de uma mudança) e para achar limites relativos.
- Dataset sintético e uniforme (8 colunas, 100 mil linhas): o snapshot real pode ter mais fontes, mais colunas e
  mais linhas. Ajuste `ROWS` ao tamanho do `installData.data` de produção (o custo de uma consulta cresce com as linhas).
- Só fontes em **cópia local** (snapshot em memória). A leitura direta no Data Hub depende da latência do Data Hub e
  é coberta por `npm run test:direct` (corretude), não por carga.
- Não exercita IA (`/api/ai/*`, cobrada por token), planilhas do Google nem o ETL.
- Uma API só (a stack roda uma instância: o bloqueio de guia e a memória da IA ficam em memória do processo).
