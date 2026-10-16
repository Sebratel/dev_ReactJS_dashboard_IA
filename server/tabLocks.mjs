// Bloqueio de edição por GUIA (não por dashboard): enquanto alguém edita uma
// guia, ninguém mais edita aquela guia — mas as outras guias da mesma
// dashboard continuam livres. É o caso de um gerente com uma guia por
// supervisor, cada um mexendo na sua ao mesmo tempo.
//
// Fica em memória, de propósito: um bloqueio só vale enquanto a tela de quem
// edita está aberta e renovando (o Builder renova a cada ~30 s). Se a API
// reiniciar, os bloqueios somem e a próxima renovação de cada tela os recria.
// Quem fecha a aba do navegador, perde a conexão ou deixa a tela parada perde
// o bloqueio sozinho quando o prazo vence — não existe bloqueio "esquecido".
//
// O dono é a JANELA (clientId, gerado a cada carga da página), não só o
// e-mail: a mesma pessoa com a guia aberta em duas janelas editaria uma por
// cima da outra. Abrir a edição numa janela nova assume o bloqueio da antiga
// (é a mesma pessoa), e a antiga passa a ver o aviso na próxima renovação.
//
// Ver as rotas em server/index.mjs e o uso em src/features/builder/useTabLocks.ts.

const DEFAULT_TTL_SECONDS = 120

function ttlMs() {
  const seconds = Number(process.env.TAB_LOCK_TTL_SECONDS)
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TTL_SECONDS) * 1000
}

// chave `${folderId}/${dashboardId}/${tabId}` → { email, name, clientId, since, expiresAt }
const locks = new Map()

const keyOf = (folderId, dashboardId, tabId) => `${folderId}/${dashboardId}/${tabId}`

// Só letras, números, "-" e "_" — vem do navegador e vira parte do estado.
export function normalizeClientId(value) {
  const id = String(value ?? '').trim()
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}

function liveLock(key, now = Date.now()) {
  const lock = locks.get(key)
  if (!lock) return null
  if (lock.expiresAt <= now) {
    locks.delete(key)
    return null
  }
  return lock
}

// O que sai pro navegador: nunca o clientId de outra pessoa. `mine` = esta
// mesma janela; `self` = a mesma pessoa (talvez em outra janela).
function publicLock(lock, viewer) {
  const email = String(viewer?.email ?? '').toLowerCase()
  return {
    name: lock.name || lock.email.split('@')[0],
    since: new Date(lock.since).toISOString(),
    expiresAt: new Date(lock.expiresAt).toISOString(),
    self: lock.email === email,
    mine: lock.email === email && !!viewer?.clientId && lock.clientId === viewer.clientId,
  }
}

// Pega ou renova o bloqueio da guia para esta janela.
//   - livre (ou vencido): fica com quem pediu;
//   - desta mesma janela: renova o prazo;
//   - da mesma pessoa em outra janela: a janela nova assume — mas só num pedido
//     novo (`renew: false`). Na renovação, quem perdeu continua sem ele: senão as
//     duas janelas ficariam tomando o bloqueio uma da outra a cada 30 s;
//   - de outra pessoa: recusa, devolvendo quem está editando.
export function acquireTabLock(folderId, dashboardId, tabId, holder, { renew = false } = {}) {
  const email = String(holder.email).toLowerCase()
  const key = keyOf(folderId, dashboardId, tabId)
  const now = Date.now()
  const current = liveLock(key, now)
  const sameWindow = !!current && current.email === email && current.clientId === holder.clientId
  if (current && !sameWindow && (renew || current.email !== email)) {
    return { ok: false, lock: publicLock(current, { email, clientId: holder.clientId }) }
  }
  const lock = {
    email,
    name: holder.name || email,
    clientId: holder.clientId,
    since: sameWindow ? current.since : now,
    expiresAt: now + ttlMs(),
  }
  locks.set(key, lock)
  return { ok: true, lock: publicLock(lock, { email, clientId: holder.clientId }) }
}

// Solta o bloqueio — só a janela dona. Pedido de outra janela/pessoa é
// ignorado em silêncio (o bloqueio dela continua valendo).
export function releaseTabLock(folderId, dashboardId, tabId, holder) {
  const key = keyOf(folderId, dashboardId, tabId)
  const current = liveLock(key)
  if (!current) return false
  if (current.email !== String(holder.email).toLowerCase() || current.clientId !== holder.clientId) return false
  locks.delete(key)
  return true
}

// Bloqueio de OUTRA pessoa/janela que impede `viewer` de gravar esta guia —
// ou null. Sem clientId (navegador com a versão antiga da página, durante uma
// troca de versão), compara só o e-mail.
export function blockingTabLock(folderId, dashboardId, tabId, viewer) {
  const current = liveLock(keyOf(folderId, dashboardId, tabId))
  if (!current) return null
  const email = String(viewer.email).toLowerCase()
  const blocked = current.email !== email || (!!viewer.clientId && current.clientId !== viewer.clientId)
  return blocked ? publicLock(current, { email, clientId: viewer.clientId }) : null
}

// Todos os bloqueios vivos de uma dashboard, por id da guia.
export function listTabLocks(folderId, dashboardId, viewer) {
  const prefix = `${folderId}/${dashboardId}/`
  const now = Date.now()
  const out = {}
  for (const key of [...locks.keys()]) {
    if (!key.startsWith(prefix)) continue
    const lock = liveLock(key, now)
    if (lock) out[key.slice(prefix.length)] = publicLock(lock, viewer)
  }
  return out
}

// Pros testes (scripts/test-tab-locks.mjs).
export function clearTabLocks() {
  locks.clear()
}
