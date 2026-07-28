// ─────────────────────────────────────────────────────────────────────────
// ETL genérico — materializa num snapshot único todas as fontes de dados que
// o Builder consome em segundo plano:
//
//   1. Queries SQL do catálogo (server/queryCatalog.mjs, editável em
//      Configurações) contra Postgres (DB_ELLEVEN) ou MariaDB
//      (DB_Applicattion) — cada query vira uma fonte com as colunas exatas
//      que o SQL retornar, sem mapeamento manual.
//   2. Datasets do Data Hub / lakehouse (server/lakehouseSources.mjs), lidos
//      pela API pública de lá e gravados sob a chave `dhub:<id>`. É o caminho
//      pra consumir o dado pelo BARRAMENTO em vez de bater no banco de
//      origem.
//
// (As planilhas do Google não entram aqui: elas dependem do token OAuth de
// quem está logado, então são resolvidas dentro da requisição — ver
// server/sheetSources.mjs.)
//
// A atualização é POR FONTE (não um intervalo global): 'realtime' roda sempre
// que este script é chamado (o scheduler chama em ciclo curto, ver
// etl-scheduler.mjs); 'scheduled' só roda quando `refreshMinutes` já passou
// desde `lastRunAt` — nos ciclos em que não é a vez dela, o dado da execução
// anterior é mantido (lido do snapshot atual antes de sobrescrever), então
// ela não some do Builder entre uma execução e outra.
//
// Os pools de banco são criados SOB DEMANDA: uma instalação que só usa o Data
// Hub não precisa de nenhuma credencial de Postgres/MariaDB configurada, e
// falta de credencial derruba só as queries daquele banco, não o ciclo todo.
//
// Grava um snapshot (gzip) em SNAPSHOT_OUT/public/installData.data.
// Rodado sob demanda (`npm run fetch:install`) ou pelo scheduler.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { makePool } from './db.mjs'
import { makeMariaPool } from './db-maria.mjs'
import { loadQueryCatalog, executeQuery, recordQueryRuns, MAX_ETL_ROWS, DEFAULT_REFRESH_MINUTES } from '../server/queryCatalog.mjs'
import {
  listForEtl as listLakehouseForEtl, fetchDatasetRows, recordLakehouseRuns, sourceKey as lakehouseKey,
  isDue as isLakehouseDue, MAX_ROWS as MAX_LAKEHOUSE_ROWS,
} from '../server/lakehouseSources.mjs'
import { decryptSecret } from '../server/secretBox.mjs'

const OUT = process.env.SNAPSHOT_OUT ? resolve(process.env.SNAPSHOT_OUT) : resolve(process.cwd(), 'public/installData.data')

// Tolerante a arquivo ausente/corrompido — nesse caso simplesmente não há
// dado anterior pra carregar adiante (fontes agendadas ainda não vencidas
// ficam de fora do snapshot até a 1ª execução real delas, igual a hoje).
function readPreviousSnapshot(path) {
  try {
    const buf = readFileSync(path)
    let text
    try { text = gunzipSync(buf).toString('utf8') } catch { text = buf.toString('utf8') }
    return { data: JSON.parse(text)?.data ?? {} }
  } catch {
    return { data: {} }
  }
}

// realtime (ou refreshMode ausente, entrada antiga) = sempre devida.
// scheduled = devida se nunca rodou, ou se já passou `refreshMinutes`.
function isDue(q, now) {
  if (q.refreshMode !== 'scheduled') return true
  if (!q.lastRunAt) return true
  const minutes = Number(q.refreshMinutes) > 0 ? Number(q.refreshMinutes) : DEFAULT_REFRESH_MINUTES
  return now - new Date(q.lastRunAt).getTime() >= minutes * 60_000
}

// Pools sob demanda: criados na primeira query que precisar daquele banco e
// reusados no resto do ciclo. A falha de criação é memorizada e relançada em
// cada query do mesmo banco (o try/catch do laço a transforma em "mantendo o
// dado anterior"), em vez de tentar reconectar query após query.
function lazyPool(make, label) {
  let promise = null
  let created = null
  return {
    get() {
      if (!promise) {
        promise = (async () => make())().then((pool) => { created = pool; return pool })
        promise.catch(() => { /* tratado por quem der await; evita unhandled rejection */ })
      }
      return promise
    },
    async end() {
      if (created) {
        try { await created.end() } catch (e) { console.error(`[etl] falha ao fechar o pool ${label}: ${e.message}`) }
      }
    },
  }
}

async function runSqlQueries(previous, now, data) {
  const { list: queries } = loadQueryCatalog()
  const pg = lazyPool(makePool, 'postgres')
  const maria = lazyPool(makeMariaPool, 'mariadb')
  const runs = []
  try {
    // Sequencial (não Promise.all): são queries de usuário, de custo
    // desconhecido — evita empilhar N execuções pesadas ao mesmo tempo contra
    // o mesmo banco de produção. Uma query com falha não derruba as demais.
    for (const q of queries) {
      // enabled ausente (entrada antiga) conta como ativa — só pula quando
      // explicitamente false. Desativada = nem roda, nem entra no snapshot,
      // então some do catálogo de fontes do Builder até ser reativada.
      if (q.enabled === false) {
        console.log(`[etl] ${q.id}: desativada — pulando`)
        continue
      }
      if (!isDue(q, now)) {
        if (previous.data[q.id]) data[q.id] = previous.data[q.id]
        console.log(`[etl] ${q.id}: agendada (${q.refreshMinutes}min) — ainda não venceu, mantendo ${(data[q.id] ?? []).length} linha(s) anteriores`)
        continue
      }
      try {
        const pools = q.db === 'mariadb' ? { mariaPool: await maria.get() } : { pgPool: await pg.get() }
        const rows = await executeQuery(q, { ...pools, limit: MAX_ETL_ROWS })
        data[q.id] = rows
        runs.push({ id: q.id, lastRunAt: new Date(now).toISOString() })
        console.log(`[etl] ${q.id}: ${rows.length} linhas`)
      } catch (e) {
        // Falha transitória — mantém o último dado bom em vez de zerar,
        // e NÃO grava lastRunAt (assim tenta de novo já no próximo ciclo).
        data[q.id] = previous.data[q.id] ?? []
        console.log(`[etl] ${q.id}: falhou (${e.message}) — mantendo ${data[q.id].length} linha(s) anteriores`)
      }
    }
  } finally {
    await pg.end()
    await maria.end()
  }
  if (runs.length) recordQueryRuns(runs)
  return runs.length
}

async function runLakehouseSources(previous, now, data) {
  const sources = listLakehouseForEtl()
  if (!sources.length) return 0
  const runs = []
  for (const src of sources) {
    const key = lakehouseKey(src.id)
    if (src.enabled === false) {
      console.log(`[etl] ${key}: desativada — pulando`)
      continue
    }
    if (!isLakehouseDue(src, now)) {
      if (previous.data[key]) data[key] = previous.data[key]
      console.log(`[etl] ${key} (${src.datasetSlug}): agendada (${src.refreshMinutes}min) — ainda não venceu, mantendo ${(data[key] ?? []).length} linha(s) anteriores`)
      continue
    }
    try {
      if (!src.tokenEnc) throw new Error('fonte sem token cadastrado')
      const { rows, total, pages } = await fetchDatasetRows({
        baseUrl: src.baseUrl, datasetSlug: src.datasetSlug, token: decryptSecret(src.tokenEnc),
      }, { maxRows: MAX_LAKEHOUSE_ROWS })
      data[key] = rows
      runs.push({ id: src.id, lastRunAt: new Date(now).toISOString(), rowCount: rows.length, error: null })
      const truncated = rows.length < total ? ` de ${total} (teto de ${MAX_LAKEHOUSE_ROWS})` : ''
      console.log(`[etl] ${key} (${src.datasetSlug}): ${rows.length} linhas${truncated} em ${pages} página(s)`)
    } catch (e) {
      // Mesma política das queries SQL: mantém o último dado bom, não grava
      // lastRunAt (tenta de novo no próximo ciclo) — mas registra o erro pra
      // aparecer na tela de Configurações.
      data[key] = previous.data[key] ?? []
      runs.push({ id: src.id, error: e.message })
      console.log(`[etl] ${key} (${src.datasetSlug}): falhou (${e.message}) — mantendo ${data[key].length} linha(s) anteriores`)
    }
  }
  if (runs.length) recordLakehouseRuns(runs)
  return runs.filter((r) => !r.error).length
}

async function main() {
  const previous = readPreviousSnapshot(OUT)
  const now = Date.now()
  const data = {}

  const sqlRuns = await runSqlQueries(previous, now, data)
  const lakehouseRuns = await runLakehouseSources(previous, now, data)

  const snapshot = { meta: { generatedAt: new Date().toISOString() }, data }
  const json = JSON.stringify(snapshot)
  const gz = gzipSync(Buffer.from(json, 'utf8'))
  writeFileSync(OUT, gz)
  console.log(`OK — snapshot gravado em ${OUT} (${(json.length / 1048576).toFixed(1)} MB → gzip ${(gz.length / 1048576).toFixed(1)} MB) · ${sqlRuns} query(s) + ${lakehouseRuns} dataset(s) do Data Hub executado(s)`)
}

main().catch((e) => { console.error('[etl] falhou:', e); process.exit(1) })
