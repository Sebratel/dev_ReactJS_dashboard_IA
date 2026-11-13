// ─────────────────────────────────────────────────────────────────────────
// Log estruturado (skill observabilidade-backend): em container, UMA linha JSON
// por evento, com os mesmos nomes de campo de todos os serviços da Sebratel
// (timestamp ISO UTC, level em texto, service, env, msg, requestId...). Em
// desenvolvimento local (NODE_ENV não definido ou "development") sai texto
// legível, como sempre saiu.
//
//   import { logger } from './logger.mjs'
//   logger.info('fonte atualizada', { sourceId })     // msg estável + dados em campos
//   logger.error('falha ao disparar', err)            // Error vira msg + stack
//
// O requestId vem de AsyncLocalStorage: toda linha emitida durante uma
// requisição o carrega, inclusive de módulos que não sabem o que é HTTP.
//
// Nunca logue segredo nem dado sensível (authorization, cookie, token, senha,
// corpo de requisição): os campos abaixo são redigidos por nome, e o log de
// acesso não registra query string nem corpo.
// ─────────────────────────────────────────────────────────────────────────
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const SERVICE = 'indicadores-sebratel-api'
const NODE_ENV = process.env.NODE_ENV || 'development'
const ENV = process.env.APP_ENV || (NODE_ENV === 'production' ? 'production' : 'development')
const JSON_MODE = process.env.LOG_FORMAT ? process.env.LOG_FORMAT === 'json' : NODE_ENV !== 'development'
const SLOW_REQUEST_MS = Math.max(1, Number(process.env.SLOW_REQUEST_MS) || 5000)

const contexto = new AsyncLocalStorage()
const REDIGIR = /^(authorization|cookie|set-cookie|password|senha|token|secret|apikey|api_key|idtoken|accesstoken|refreshtoken)$/i

function limpar(campos) {
  const out = {}
  for (const [k, v] of Object.entries(campos ?? {})) out[k] = REDIGIR.test(k) ? '[redigido]' : v
  return out
}

function escrever(level, args) {
  let msg = ''
  let extra = {}
  const partes = []
  for (const a of args) {
    if (a instanceof Error) { partes.push(a.message); extra = { ...extra, stack: a.stack } }
    else if (typeof a === 'string') partes.push(a)
    else if (a && typeof a === 'object') extra = { ...extra, ...limpar(a) }
    else if (a !== undefined) partes.push(String(a))
  }
  msg = partes.join(' ')
  const requestId = contexto.getStore()?.requestId
  const linha = JSON_MODE
    ? JSON.stringify({ timestamp: new Date().toISOString(), level, service: SERVICE, env: ENV, msg, ...(requestId ? { requestId } : {}), ...extra })
    : `${msg}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`
  // stderr para warn/error, como o console sempre fez — o Docker junta os dois.
  ;(level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(linha + '\n')
}

export const logger = {
  debug: (...a) => { if (process.env.LOG_LEVEL === 'debug') escrever('debug', a) },
  info: (...a) => escrever('info', a),
  warn: (...a) => escrever('warn', a),
  error: (...a) => escrever('error', a),
}

/**
 * Middleware: reaproveita X-Request-Id (se veio e tem até 200 caracteres seguros), senão gera um UUID; devolve o
 * header na resposta; e escreve UM log no fim da requisição (status/durationMs, nível pelo resultado).
 * /api/health só aparece se falhar (senão domina o volume: o Docker o chama a cada 30 s).
 */
export function requestLogger() {
  return (req, res, next) => {
    const vindo = String(req.headers['x-request-id'] ?? '')
    const requestId = vindo && vindo.length <= 200 && /^[\w.:-]+$/.test(vindo) ? vindo : randomUUID()
    req.requestId = requestId
    res.setHeader('X-Request-Id', requestId)
    const t0 = process.hrtime.bigint()
    let terminou = false
    res.on('finish', () => { terminou = true })
    res.on('close', () => {
      const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6)
      const base = { method: req.method, path: req.path, status: res.statusCode, durationMs, ...(req.user?.email ? { userEmail: req.user.email } : {}) }
      contexto.run({ requestId }, () => {
        if (!terminou) return logger.warn('request aborted', base) // o cliente desistiu antes da resposta
        if (req.path === '/api/health' && res.statusCode < 400) return
        if (res.statusCode >= 500) logger.error('request completed', base)
        else if (res.statusCode >= 400) logger.warn('request completed', base)
        else if (durationMs >= SLOW_REQUEST_MS) logger.warn('slow request', base)
        else logger.info('request completed', base)
      })
    })
    contexto.run({ requestId }, next)
  }
}
