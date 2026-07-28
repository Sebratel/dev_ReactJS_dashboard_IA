// ─────────────────────────────────────────────────────────────────────────
// ETL genérico — roda as queries do catálogo único (server/queryCatalog.mjs,
// editável via Configurações) contra Postgres (DB_ELLEVEN) ou MariaDB
// (DB_Applicattion), sem mapeamento manual: cada query vira uma fonte no
// snapshot com as colunas exatas que o SQL retornar.
//
// A atualização é POR QUERY (não um intervalo global): 'realtime' roda
// sempre que este script é chamado (o scheduler chama em ciclo curto, ver
// etl-scheduler.mjs); 'scheduled' só roda quando `refreshMinutes` já passou
// desde `lastRunAt` — nos ciclos em que não é a vez dela, o dado da execução
// anterior é mantido (lido do snapshot atual antes de sobrescrever), então
// ela não some do Builder entre uma execução e outra.
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

const OUT = process.env.SNAPSHOT_OUT ? resolve(process.env.SNAPSHOT_OUT) : resolve(process.cwd(), 'public/installData.data')

// Tolerante a arquivo ausente/corrompido — nesse caso simplesmente não há
// dado anterior pra carregar adiante (queries agendadas ainda não vencidas
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

async function main() {
  const pgPool = makePool()
  const mariaPool = await makeMariaPool()
  try {
    const { list: queries } = loadQueryCatalog()
    const previous = readPreviousSnapshot(OUT)
    const now = Date.now()
    const data = {}
    const runs = []
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
        const rows = await executeQuery(q, { pgPool, mariaPool, limit: MAX_ETL_ROWS })
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

    const snapshot = { meta: { generatedAt: new Date().toISOString() }, data }
    const json = JSON.stringify(snapshot)
    const gz = gzipSync(Buffer.from(json, 'utf8'))
    writeFileSync(OUT, gz)
    if (runs.length) recordQueryRuns(runs)
    console.log(`OK — snapshot gravado em ${OUT} (${(json.length / 1048576).toFixed(1)} MB → gzip ${(gz.length / 1048576).toFixed(1)} MB) · ${runs.length} query(s) executada(s)`)
  } finally {
    await pgPool.end()
    await mariaPool.end()
  }
}

main().catch((e) => { console.error('[etl] falhou:', e); process.exit(1) })
