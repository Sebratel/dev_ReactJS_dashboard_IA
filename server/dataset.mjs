// ─────────────────────────────────────────────────────────────────────────
// Materialização do snapshot multi-tabela no backend. Carrega o JSON (gzip)
// gerado pelo ETL em memória e recarrega automaticamente quando o arquivo
// muda (compara mtime) — mesmo padrão do dev_ReacJS_HealthyScore-staging.
//
//   SNAPSHOT_PATH  caminho do snapshot (ex.: /snapshot/installData.data).
//                  Sem a env, cai em ./public/installData.data (dev).
// ─────────────────────────────────────────────────────────────────────────
import { logger } from './logger.mjs'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'

const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH
  ? resolve(process.env.SNAPSHOT_PATH)
  : resolve(process.cwd(), 'public/installData.data')

let cache = null
let cacheMtime = 0
let lastError = null

function ensureFresh() {
  if (!existsSync(SNAPSHOT_PATH)) { lastError = `snapshot ausente: ${SNAPSHOT_PATH}`; cache = null; return }
  let mtime
  try { mtime = statSync(SNAPSHOT_PATH).mtimeMs } catch (e) { lastError = e.message; return }
  if (cache && mtime === cacheMtime) return
  try {
    const buf = readFileSync(SNAPSHOT_PATH)
    let text
    try { text = gunzipSync(buf).toString('utf8') } catch { text = buf.toString('utf8') }
    cache = JSON.parse(text)
    cacheMtime = mtime
    lastError = null
    logger.info(`[dataset] carregado: ${Object.keys(cache?.data ?? {}).length} fontes · ${SNAPSHOT_PATH}`)
  } catch (e) {
    lastError = e.message
  }
}

export function getSnapshot() { ensureFresh(); return cache }
export function getVersion() { ensureFresh(); return cacheMtime }

export function getStatus() {
  ensureFresh()
  return {
    loaded: !!cache,
    path: SNAPSHOT_PATH,
    fileMtime: cacheMtime ? new Date(cacheMtime).toISOString() : null,
    generatedAt: cache?.meta?.generatedAt ?? null,
    coverage: cache?.meta?.coverage ?? null,
    error: lastError,
  }
}
