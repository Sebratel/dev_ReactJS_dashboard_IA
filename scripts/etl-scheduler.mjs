// ─────────────────────────────────────────────────────────────────────────
// Agendador do ETL — roda `fetch-install.mjs` num ciclo base curto e fixo,
// gravando o snapshot no volume compartilhado (SNAPSHOT_OUT). A decisão de
// "rodar ou não" cada QUERY é interna ao fetch-install.mjs (por query:
// 'realtime' roda em todo ciclo, 'scheduled' só quando o intervalo dela
// próprio já passou) — este processo só garante que o ciclo base aconteça
// com frequência suficiente pra a opção "tempo real" fazer sentido.
//
//   SNAPSHOT_OUT              caminho de saída do snapshot.
//   ETL_RUN_ON_START          'true' força uma execução ao subir.
//   ETL_BASE_INTERVAL_MINUTES intervalo do ciclo base (default 2min) — ajuste
//                             de infra, não é uma configuração por query.
//
// Bootstrap: se o snapshot ainda não existe, gera na hora.
// ─────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ETL = resolve(__dirname, 'fetch-install.mjs')
const OUT = process.env.SNAPSHOT_OUT ? resolve(process.env.SNAPSHOT_OUT) : resolve(__dirname, '../public/installData.data')
const BASE_INTERVAL_MINUTES = Math.max(1, Number(process.env.ETL_BASE_INTERVAL_MINUTES) || 2)

let running = false
function runETL(reason) {
  if (running) { console.log('[etl] já em execução — ignorando gatilho.'); return }
  running = true
  console.log(`[etl] iniciando ETL (${reason}) → ${OUT}`)
  const child = spawn(process.execPath, [ETL], { stdio: 'inherit', env: process.env })
  child.on('exit', (code) => { running = false; console.log(`[etl] finalizado (code ${code}) em ${new Date().toISOString()}`) })
  child.on('error', (e) => { running = false; console.error(`[etl] falha ao iniciar: ${e.message}`) })
}

if (!existsSync(OUT)) runETL('bootstrap — snapshot ausente no volume')
else if (process.env.ETL_RUN_ON_START === 'true') runETL('ETL_RUN_ON_START=true')
else console.log(`[etl] snapshot existente: ${OUT} (sem execução imediata)`)

setInterval(() => runETL(`ciclo base (${BASE_INTERVAL_MINUTES}min)`), BASE_INTERVAL_MINUTES * 60_000)
console.log(`[etl] scheduler ativo · ciclo base=${BASE_INTERVAL_MINUTES}min (o ritmo real de cada query depende do modo dela — ver Configurações)`)
