// ─────────────────────────────────────────────────────────────────────────
// Cliente da LEITURA DIRETA no Data Hub: executa um QueryDef numa fonte
// cadastrada em modo 'direct' (ver server/lakehouseSources.mjs) com os três
// cuidados que um painel precisa e uma chamada solta não:
//
//   • cache curto do resultado (DHUB_QUERY_CACHE_SECONDS, padrão 60) — abrir
//     um painel de 12 widgets para 20 pessoas não pode virar 240 consultas no
//     lake. A chave inclui o `updatedAt` da fonte, então editar a fonte já
//     descarta o que ela tinha; "Sincronizar agora" descarta na hora
//     (forgetDirectSource);
//   • a MESMA consulta em andamento é reaproveitada — dois widgets iguais, ou
//     duas pessoas abrindo o painel juntas, esperam a mesma resposta;
//   • no máximo DHUB_QUERY_CONCURRENCY (padrão 6) consultas ao mesmo tempo:
//     é o número de vagas que o motor do Data Hub reserva para painéis.
//     Mandar mais só formaria fila lá, e o tempo limite das que esperam
//     começaria a vencer.
//
// Quem traduz widget em QueryDef é server/directWidgetQuery.mjs.
// ─────────────────────────────────────────────────────────────────────────
import {
  getLakehouseSource, resolveCredentials, queryDataset, readModeOf, isLakehouseSource, lakehouseSourceId,
} from './lakehouseSources.mjs'

const CACHE_TTL_MS = Math.max(0, Number(process.env.DHUB_QUERY_CACHE_SECONDS ?? 60)) * 1000
const CACHE_MAX = 500
const CONCURRENCY = Math.max(1, Number(process.env.DHUB_QUERY_CONCURRENCY) || 6)

const cache = new Map() // chave → { at, value } (ordem de inserção = do mais antigo ao mais novo)
const inflight = new Map() // chave → Promise

// Entrada do catálogo de uma fonte do Data Hub ATIVA e em leitura direta —
// null em qualquer outro caso (cópia, planilha, desativada, inexistente).
export function directEntry(source) {
  if (!isLakehouseSource(source)) return null
  const entry = getLakehouseSource(lakehouseSourceId(source))
  if (!entry || entry.enabled === false || readModeOf(entry) !== 'direct') return null
  return entry
}

export const isDirectSource = (source) => directEntry(source) !== null

let active = 0
const waiting = []
async function withSlot(fn) {
  if (active < CONCURRENCY) active++
  else await new Promise((ok) => waiting.push(ok))
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next() // passa a vaga adiante sem soltar o contador
    else active--
  }
}

// → { columns: [{ name, type }], rows, total } — `rows` é compartilhado com o
// cache: quem recebe só lê, nunca altera.
export async function directQuery(source, def) {
  const entry = directEntry(source)
  if (!entry) throw new Error(`Fonte desconhecida: ${source}`)
  const key = `${entry.id}|${entry.updatedAt}|${JSON.stringify(def)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key)
    cache.set(key, hit)
    return hit.value
  }
  const pending = inflight.get(key)
  if (pending) return pending

  const run = withSlot(() => queryDataset(resolveCredentials(entry.id), def))
    .then((body) => {
      const value = {
        columns: Array.isArray(body.columns) ? body.columns : [],
        rows: body.rows,
        total: typeof body.total === 'number' ? body.total : null,
      }
      if (CACHE_TTL_MS > 0) {
        cache.set(key, { at: Date.now(), value })
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
      }
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, run)
  return run
}

// "Sincronizar agora", desativar, remover: a próxima leitura vai ao Data Hub.
export function forgetDirectSource(id) {
  for (const key of [...cache.keys()]) if (key.startsWith(`${id}|`)) cache.delete(key)
}
