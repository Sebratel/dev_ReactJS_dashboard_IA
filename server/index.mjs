// ─────────────────────────────────────────────────────────────────────────
// Backend Express — serve /api/* a partir do snapshot materializado em
// memória (server/dataset.mjs), alimentado pelos datasets do Data Hub
// cadastrados na tela (server/lakehouseSources.mjs). Toda a dashboard é
// construída manualmente no Builder a partir das colunas reais dessas fontes
// — não há abas/métricas fixas embutidas no código.
//
// Este servidor NÃO fala com banco de dados: o lakehouse é o barramento. Havia
// antes um catálogo de queries SQL que batia direto no Postgres do ERP e no
// MariaDB; manter os dois caminhos consumia duas plataformas grandes pela
// mesma informação, então o SQL saiu.
// Mesmo padrão de auth do dev_ReacJS_HealthyScore-staging (Google OAuth,
// domínio restrito), adaptado para este projeto.
// ─────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import express from 'express'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getStatus } from './dataset.mjs'
import { runWidgetQuery, runFieldValues, listSourceDefs } from './widgetQuery.mjs'
import {
  listSheetSources, createSheetSource, updateSheetSource, deleteSheetSource, getSheetSource, resolveSheetRows, sourceKey as sheetSourceKey,
} from './sheetSources.mjs'
import {
  listLakehouseSources, getLakehouseSource, createLakehouseSource, updateLakehouseSource, deleteLakehouseSource,
  setLakehouseEnabled, setLakehouseRefresh, setLakehouseFolders, previewDataset, resolveCredentials,
  sourceKey as lakehouseSourceKey, DEFAULT_BASE_URL as DHUB_DEFAULT_BASE_URL,
} from './lakehouseSources.mjs'
import { listFieldDictionary, upsertFieldDescription } from './fieldDictionary.mjs'
import { isAiConfigured, usageFor, startConversation, runTurn } from './aiAssistant.mjs'
import { listCommentsForWidget, addComment, deleteComment, commentCountsByWidget } from './widgetComments.mjs'
import {
  getFolder, getTab, hasFolderAccess, canManageFolder, canEditTabWidgets,
  getWorkspaceTreeForUser, getDashboardForUser, listFoldersFull, getFolderFull,
  createFolder, updateFolder, deleteFolder, setFolderAccess, setFolderManagers, listFolderMembers,
  createDashboard, updateDashboard, deleteDashboard, saveDashboardFull, saveTabWidgets, setTabAccess,
  findFoldersUsingQuery,
} from './workspace.mjs'
import { isAdmin, touchUser, listUsers, setUserRole, appendAuditLog, listAuditLog, ONLINE_THRESHOLD_MS } from './accessLog.mjs'
import {
  COOKIE_NAME, TTL_MS as SESSION_TTL_MS, createSession, getSession, destroySession, touchSession, ensureAccessToken,
} from './sessions.mjs'
import {
  isConfigured as isOAuthConfigured, resolveRedirectUri, buildAuthUrl, exchangeCode, refreshAccessToken, fetchUserInfo,
} from './googleOAuth.mjs'

const PORT = Number(process.env.API_PORT) || 8788
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'sebratel.com.br').toLowerCase()
const __dirname = dirname(fileURLToPath(import.meta.url))
const ETL_SCRIPT = resolve(__dirname, '../scripts/fetch-install.mjs')

const app = express()
app.use(express.json({ limit: '2mb' }))

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  // A sessão agora é um cookie, não um header Authorization — sem isto o
  // navegador não envia o cookie em requisição de origem cruzada.
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ─── Auth ──────────────────────────────────────────────────────
// Sessão de servidor + cookie HttpOnly (ver server/sessions.mjs) alimentada
// pelo fluxo de código de autorização do Google (ver server/googleOAuth.mjs).
// O navegador não vê token do Google em momento nenhum.
const STATE_COOKIE = 'ind_oauth_state'
const STATE_TTL_MS = 10 * 60 * 1000
// Escrever no arquivo de sessões a cada requisição autenticada seria muito I/O
// (o front tem heartbeat periódico); o "visto por último" só precisa de
// granularidade de minuto.
const TOUCH_INTERVAL_MS = 60 * 1000

function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

// `Secure` só quando a requisição chegou por https: num servidor interno em
// http puro, marcar Secure faria o navegador DESCARTAR o cookie silenciosamente
// e o login nunca completaria.
function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim()
  return proto === 'https'
}

function writeCookie(res, req, name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax (e não Strict) porque o retorno do Google é uma navegação de
    // primeiro nível vinda de outro site: com Strict o cookie não seria
    // enviado no callback e o login falharia.
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ]
  if (isSecureRequest(req)) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}

function clearCookie(res, req, name) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isSecureRequest(req)) parts.push('Secure')
  res.append('Set-Cookie', parts.join('; '))
}

function requireAuth() {
  return async (req, res, next) => {
    const session = getSession(readCookie(req, COOKIE_NAME))
    if (!session) return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' })
    // Revalidado a cada requisição, não só no login: se o domínio permitido
    // mudar, as sessões já abertas de fora dele param na hora.
    if (!session.email.endsWith('@' + ALLOWED_DOMAIN)) {
      return res.status(403).json({ error: `Acesso restrito a contas @${ALLOWED_DOMAIN}.` })
    }
    // Renova o access_token do Google pelo refresh_token quando vencido. Sem
    // conseguir (consentimento revogado no Google, refresh inválido), a sessão
    // é destruída e o front manda pro login.
    const accessToken = await ensureAccessToken(session, refreshAccessToken)
    if (!accessToken) {
      clearCookie(res, req, COOKIE_NAME)
      return res.status(401).json({ error: 'Sua sessão com o Google expirou. Entre novamente.' })
    }
    req.user = { email: session.email, name: session.name }
    // Disponível pras rotas que falam com uma API do Google em nome do próprio
    // usuário — ver server/sheetSources.mjs/googleSheets.mjs (planilhas
    // cadastradas livremente).
    req.accessToken = accessToken
    req.sessionId = session.id
    if (Date.now() - (session.lastSeenAt ?? 0) > TOUCH_INTERVAL_MS) touchSession(session.id)
    touchUser(session.email, session.name)
    next()
  }
}

// ─── Rotas do login (fluxo de código de autorização) ──────────────
// Falha aqui não devolve JSON: quem está no meio do fluxo é o NAVEGADOR, numa
// navegação de página. Redireciona pro /login com a mensagem, que a tela mostra.
function failLogin(res, message) {
  res.redirect(`/login?erro=${encodeURIComponent(message)}`)
}

app.get('/api/auth/google/start', (req, res) => {
  if (!isOAuthConfigured()) {
    return failLogin(res, 'Login do Google não configurado no servidor (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).')
  }
  try {
    // `state` guardado em cookie, e não em memória do processo: assim o fluxo
    // sobrevive a um restart no meio do login e funciona com mais de uma
    // instância da API, sem estado compartilhado.
    const state = randomBytes(24).toString('base64url')
    writeCookie(res, req, STATE_COOKIE, state, STATE_TTL_MS)
    res.redirect(buildAuthUrl({ redirectUri: resolveRedirectUri(req), state }))
  } catch (e) {
    failLogin(res, e.message)
  }
})

app.get('/api/auth/google/callback', async (req, res) => {
  const expectedState = readCookie(req, STATE_COOKIE)
  clearCookie(res, req, STATE_COOKIE)

  if (req.query.error) {
    return failLogin(res, req.query.error === 'access_denied' ? 'Login cancelado.' : String(req.query.error))
  }
  // Proteção de CSRF do próprio fluxo: sem o state (ou divergente), o callback
  // pode ter sido provocado por outro site.
  if (!expectedState || req.query.state !== expectedState) {
    return failLogin(res, 'Sessão de login expirada ou inválida. Tente entrar novamente.')
  }
  if (!req.query.code) return failLogin(res, 'O Google não devolveu o código de autorização.')

  try {
    const tokens = await exchangeCode({ code: String(req.query.code), redirectUri: resolveRedirectUri(req) })
    const user = await fetchUserInfo(tokens.accessToken)
    if (!user.email.endsWith('@' + ALLOWED_DOMAIN)) {
      return failLogin(res, `Acesso restrito a contas @${ALLOWED_DOMAIN}.`)
    }
    if (!tokens.refreshToken) {
      // Não deveria acontecer (pedimos access_type=offline + prompt=consent),
      // mas sem refresh_token a sessão morreria em 1h sem aviso — melhor falhar
      // agora, com uma mensagem que diz o que fazer.
      return failLogin(res, 'O Google não devolveu credencial de renovação. Remova o acesso do app na sua Conta Google e entre novamente.')
    }
    const session = createSession(user, tokens)
    writeCookie(res, req, COOKIE_NAME, session.id, SESSION_TTL_MS)
    touchUser(user.email, user.name)
    appendAuditLog({ email: user.email, name: user.name, action: 'auth.login', target: user.email })
    res.redirect('/')
  } catch (e) {
    console.error(`[auth] falha no callback: ${e.message}`)
    failLogin(res, e.message)
  }
})

// Quem está logado — é o que o front chama ao carregar, em vez de guardar
// identidade no localStorage. `isAdmin` vem junto pra economizar um
// round-trip (a checagem de verdade continua sendo no servidor, por rota).
app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({ user: req.user, isAdmin: isAdmin(req.user.email) })
})

app.post('/api/auth/logout', async (req, res) => {
  const session = getSession(readCookie(req, COOKIE_NAME))
  if (session) {
    appendAuditLog({ email: session.email, name: session.name, action: 'auth.logout', target: session.email })
    destroySession(session.id)
  }
  clearCookie(res, req, COOKIE_NAME)
  res.sendStatus(204)
})

// Restringe uma rota a administradores (gestão de acessos) — lista fixa via
// ADMIN_EMAILS, ver server/accessLog.mjs. Usar sempre depois de requireAuth().
function requireAdmin() {
  return (req, res, next) => {
    if (!isAdmin(req.user?.email)) return res.status(403).json({ error: 'Acesso restrito a administradores.' })
    next()
  }
}

// ─── Permissões da hierarquia Pasta → Dashboard → Guia (server/workspace.mjs) ──
// Sempre depois de requireAuth(). `:fid` é o id da pasta na URL em toda rota
// de workspace — ver server/workspace.mjs pras regras de acesso em si.
function requireFolderAccess() {
  return (req, res, next) => {
    const folder = getFolder(req.params.fid)
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' })
    if (!hasFolderAccess(folder, req.user.email)) return res.status(403).json({ error: 'Sem acesso a esta pasta.' })
    next()
  }
}

function requireFolderManager() {
  return (req, res, next) => {
    const folder = getFolder(req.params.fid)
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' })
    if (!canManageFolder(folder, req.user.email)) return res.status(403).json({ error: 'Só administradores ou o gerente desta pasta podem fazer isso.' })
    next()
  }
}

function requireTabEdit() {
  return (req, res, next) => {
    const folder = getFolder(req.params.fid)
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' })
    const tab = getTab(req.params.fid, req.params.did, req.params.tid)
    if (!tab) return res.status(404).json({ error: 'Guia não encontrada.' })
    if (!canEditTabWidgets(folder, tab, req.user.email)) return res.status(403).json({ error: 'Você não tem permissão para editar esta guia.' })
    next()
  }
}

// ─── Disparo do ETL após alterar o catálogo de fontes ─────────────
let etlRunning = false
function triggerEtlRefresh(reason) {
  if (etlRunning) return
  etlRunning = true
  const child = spawn(process.execPath, [ETL_SCRIPT], { stdio: 'inherit', env: process.env })
  child.on('exit', () => { etlRunning = false })
  child.on('error', (e) => { etlRunning = false; console.error(`[etl] falha ao disparar: ${e.message}`) })
  console.log(`[etl] atualizando snapshot em segundo plano (${reason})`)
}

// ─── Rotas ───────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'indicadores-sebratel-api', time: new Date().toISOString() })
})

app.get('/api/dataset/status', requireAuth(), (_req, res) => {
  res.json(getStatus())
})

// Catálogo de fontes (uma por query com dados no snapshot) — alimenta os
// pickers de fonte/dimensão/medida/filtro/coluna no editor de widgets.
// ?folderId= filtra pra só as fontes liberadas naquela pasta (ver
// listSourceDefs em widgetQuery.mjs) — sem o parâmetro, devolve tudo.
app.get('/api/sources', requireAuth(), async (req, res) => {
  try {
    res.json({ sources: await listSourceDefs(req.query.folderId, req.accessToken) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ─── Dashboard Builder ───────────────────────────────────────────
app.post('/api/widget-data', requireAuth(), async (req, res) => {
  try {
    const b = req.body || {}
    const data = await runWidgetQuery({
      widget: b.widget,
      tabFilters: b.tabFilters ?? [],
      page: Number(b.page) || 1,
      pageSize: Math.min(200, Number(b.pageSize) || 50),
      accessToken: req.accessToken,
    })
    if (!data) return res.status(503).json({ error: 'Base ainda não materializada no backend.' })
    res.json({ data, meta: getStatus() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/field-values', requireAuth(), async (req, res) => {
  try {
    const b = req.body || {}
    const values = await runFieldValues({ source: b.source, field: b.field, accessToken: req.accessToken })
    if (!values) return res.status(503).json({ error: 'Base ainda não materializada no backend.' })
    res.json({ values })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ─── Planilhas do Google (server/sheetSources.mjs) ────────────────
// Ao contrário das queries SQL (admin-only), qualquer usuário autenticado
// pode cadastrar/usar uma planilha própria — ver decisão no changelog.
// Metadados só (sem as rows) — a lista de gerenciamento no editor de widget.
app.get('/api/sheet-sources', requireAuth(), (_req, res) => {
  res.json({ sheets: listSheetSources() })
})

// Cria e já tenta buscar ao vivo (com o token de quem está criando) — se a
// planilha não existir/não tiver acesso, desfaz a criação e devolve o erro
// real do Google, em vez de deixar uma fonte cadastrada e inutilizável.
app.post('/api/sheet-sources', requireAuth(), async (req, res) => {
  const b = req.body || {}
  let entry
  try {
    entry = createSheetSource({ label: b.label, url: b.url, sheetName: b.sheetName }, req.user.email)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  try {
    await resolveSheetRows(entry.id, { accessToken: req.accessToken, force: true })
  } catch (e) {
    deleteSheetSource(entry.id, req.user.email, true)
    return res.status(400).json({ error: e.message })
  }
  appendAuditLog({ email: req.user.email, name: req.user.name, action: 'sheetSource.create', target: entry.id, meta: { label: entry.label } })
  res.json({ ok: true, sheet: listSheetSources().find((s) => s.id === entry.id) })
})

app.put('/api/sheet-sources/:id', requireAuth(), async (req, res) => {
  const existing = getSheetSource(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Planilha não encontrada.' })
  if (existing.createdBy !== req.user.email && !isAdmin(req.user.email)) {
    return res.status(403).json({ error: 'Só quem cadastrou esta planilha (ou um administrador) pode editá-la.' })
  }
  try {
    const b = req.body || {}
    const saved = updateSheetSource(req.params.id, { label: b.label, url: b.url, sheetName: b.sheetName }, req.user.email)
    if (!saved.cache) await resolveSheetRows(saved.id, { accessToken: req.accessToken, force: true })
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'sheetSource.update', target: saved.id })
    res.json({ ok: true, sheet: listSheetSources().find((s) => s.id === saved.id) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/sheet-sources/:id', requireAuth(), (req, res) => {
  try {
    deleteSheetSource(req.params.id, req.user.email, isAdmin(req.user.email))
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'sheetSource.delete', target: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Em quais pastas/dashboards esta planilha já está sendo usada como fonte —
// mesma checagem das queries SQL (findFoldersUsingQuery aceita qualquer
// string de fonte, não é específico de SQL).
app.get('/api/sheet-sources/:id/usage', requireAuth(), (req, res) => {
  res.json({ folders: findFoldersUsingQuery(sheetSourceKey(req.params.id)) })
})

// Força buscar de novo agora (ignora o cache), com o token de quem clicou —
// mesmo espírito do "atualizar" que já existe por query SQL.
app.patch('/api/sheet-sources/:id/refresh', requireAuth(), async (req, res) => {
  try {
    const rows = await resolveSheetRows(req.params.id, { accessToken: req.accessToken, force: true })
    res.json({ ok: true, rowCount: rows.length })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ─── Fontes do Data Hub / lakehouse (server/lakehouseSources.mjs) ──
// Consumo da API pública do lakehouse como BARRAMENTO de dados: em vez de uma
// query SQL batendo no banco de origem, cadastra-se um dataset publicado lá
// mais um token de acesso. Auto-serviço como as planilhas (qualquer usuário
// logado cadastra a sua), com a mesma regra de dono/admin pra editar e
// remover; só admin decide em quais pastas a fonte aparece.
//
// O token nunca volta pro navegador em nenhuma destas rotas — a UI recebe só
// `tokenHint`. Quem precisa do token em claro é o ETL, que decifra na hora de
// buscar (ver scripts/fetch-install.mjs).
app.get('/api/lakehouse-sources', requireAuth(), (_req, res) => {
  res.json({ sources: listLakehouseSources(), defaultBaseUrl: DHUB_DEFAULT_BASE_URL })
})

// Testa credenciais AINDA NÃO SALVAS (o formulário acabou de digitá-las) e
// devolve total de linhas + colunas detectadas, pra pessoa confirmar que é o
// dataset certo antes de criar a fonte. Também serve pra revalidar uma fonte
// existente: sem `token` no corpo, reusa o token já cadastrado em `id`.
app.post('/api/lakehouse-sources/test', requireAuth(), async (req, res) => {
  try {
    const b = req.body || {}
    let { baseUrl, datasetSlug, token } = b
    if (!token && b.id) {
      const saved = resolveCredentials(b.id)
      token = saved.token
      baseUrl = baseUrl || saved.baseUrl
      datasetSlug = datasetSlug || saved.datasetSlug
    }
    res.json(await previewDataset({ baseUrl, datasetSlug, token }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Cria e já valida contra o Data Hub — se o token não abrir o dataset, nada é
// salvo e o erro real de lá volta pra tela (mesmo espírito de POST
// /api/sheet-sources). Em seguida dispara o ETL, pra fonte já aparecer no
// Builder sem esperar o próximo ciclo.
app.post('/api/lakehouse-sources', requireAuth(), async (req, res) => {
  const b = req.body || {}
  try {
    await previewDataset({ baseUrl: b.baseUrl, datasetSlug: b.datasetSlug, token: b.token })
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  try {
    const entry = createLakehouseSource({
      label: b.label, baseUrl: b.baseUrl, datasetSlug: b.datasetSlug, token: b.token, enabled: b.enabled,
    }, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'lakehouseSource.create', target: entry.id, meta: { label: entry.label, dataset: entry.datasetSlug } })
    triggerEtlRefresh(`fonte do Data Hub "${entry.datasetSlug}" cadastrada`)
    res.json({ ok: true, source: entry })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// `token` vazio/ausente no corpo mantém o token atual — a tela nunca recebe o
// token de volta, então não teria como reenviá-lo a cada edição.
app.put('/api/lakehouse-sources/:id', requireAuth(), async (req, res) => {
  const existing = getLakehouseSource(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Fonte não encontrada.' })
  if (existing.createdBy !== req.user.email && !isAdmin(req.user.email)) {
    return res.status(403).json({ error: 'Só quem cadastrou esta fonte (ou um administrador) pode editá-la.' })
  }
  const b = req.body || {}
  try {
    // Valida a combinação que vai ficar salva (o que mudou + o que ficou),
    // pra uma edição errada não deixar a fonte quebrada até o próximo ETL.
    await previewDataset({
      baseUrl: b.baseUrl ?? existing.baseUrl,
      datasetSlug: b.datasetSlug ?? existing.datasetSlug,
      token: b.token || resolveCredentials(existing.id).token,
    })
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  try {
    const saved = updateLakehouseSource(req.params.id, {
      label: b.label, baseUrl: b.baseUrl, datasetSlug: b.datasetSlug, token: b.token,
    }, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'lakehouseSource.update', target: saved.id, meta: { dataset: saved.datasetSlug } })
    triggerEtlRefresh(`fonte do Data Hub "${saved.datasetSlug}" editada`)
    res.json({ ok: true, source: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/lakehouse-sources/:id', requireAuth(), (req, res) => {
  try {
    deleteLakehouseSource(req.params.id, req.user.email, isAdmin(req.user.email))
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'lakehouseSource.delete', target: req.params.id })
    triggerEtlRefresh('fonte do Data Hub removida')
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// enabled e refresh: qualquer usuário logado ajusta (mesma decisão das
// queries SQL — é ritmo de atualização, não permissão).
app.patch('/api/lakehouse-sources/:id/enabled', requireAuth(), (req, res) => {
  try {
    const saved = setLakehouseEnabled(req.params.id, !!(req.body || {}).enabled, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'lakehouseSource.enabled', target: saved.id, meta: { enabled: saved.enabled } })
    triggerEtlRefresh(`fonte do Data Hub "${saved.datasetSlug}" ${saved.enabled ? 'ativada' : 'desativada'}`)
    res.json({ ok: true, source: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.patch('/api/lakehouse-sources/:id/refresh', requireAuth(), (req, res) => {
  try {
    const { mode, minutes } = req.body || {}
    const saved = setLakehouseRefresh(req.params.id, { mode, minutes }, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'lakehouseSource.refresh', target: saved.id, meta: { mode: saved.refreshMode, minutes: saved.refreshMinutes } })
    res.json({ ok: true, source: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Busca agora, sem esperar o ciclo. Dispara o ETL inteiro (é ele que escreve o
// snapshot) — a resposta volta na hora e a atualização acontece em segundo
// plano, igual ao que já acontece ao mexer no catálogo de queries.
app.patch('/api/lakehouse-sources/:id/sync', requireAuth(), (req, res) => {
  const entry = getLakehouseSource(req.params.id)
  if (!entry) return res.status(404).json({ error: 'Fonte não encontrada.' })
  triggerEtlRefresh(`sincronização manual da fonte do Data Hub "${entry.datasetSlug}"`)
  res.json({ ok: true, started: true })
})

// Em quais pastas esta fonte aparece no Builder — null (padrão) = todas.
// Mesma regra do equivalente por query SQL: só admin.
app.patch('/api/lakehouse-sources/:id/folders', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const { folderIds } = req.body || {}
    const saved = setLakehouseFolders(req.params.id, folderIds === undefined ? null : folderIds, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'lakehouseSource.folders', target: saved.id, meta: { folderIds: saved.folderIds } })
    res.json({ ok: true, source: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Em quais pastas/dashboards esta fonte já está em uso — findFoldersUsingQuery
// aceita qualquer string de fonte, não é específico de SQL.
app.get('/api/lakehouse-sources/:id/usage', requireAuth(), (req, res) => {
  res.json({ folders: findFoldersUsingQuery(lakehouseSourceKey(req.params.id)) })
})

// ─── Montagem com IA (server/aiAssistant.mjs) ─────────────────────
// A IA propõe WidgetConfig; nada é gravado por estas rotas. Quem aplica na
// guia é o usuário, e mesmo aí é rascunho até ele clicar em "Salvar".
app.get('/api/ai/status', requireAuth(), (req, res) => {
  res.json(usageFor(req.user.email))
})

// Abre a conversa amarrada a uma pasta + um conjunto de fontes. O acesso à
// pasta é checado aqui, e listSourceDefs já respeita o folderIds de cada
// fonte — então a conversa nunca alcança dado que o usuário não veria no
// Builder.
app.post('/api/ai/conversations', requireAuth(), async (req, res) => {
  try {
    if (!isAiConfigured()) {
      return res.status(503).json({ error: 'Montagem com IA não configurada no servidor (falta ANTHROPIC_API_KEY).' })
    }
    const { folderId, sourceKeys } = req.body || {}
    const folder = getFolder(folderId)
    if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' })
    if (!hasFolderAccess(folder, req.user.email)) return res.status(403).json({ error: 'Sem acesso a esta pasta.' })
    if (!Array.isArray(sourceKeys) || sourceKeys.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos uma fonte de dados.' })
    }
    const started = await startConversation({
      email: req.user.email, folderId, sourceKeys, accessToken: req.accessToken,
    })
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'ai.conversation.start', target: started.conversationId, meta: { folderId, sources: started.sources.map((s) => s.key) } })
    res.json(started)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Um turno da conversa, em streaming (SSE). Resposta longa e incremental: o
// texto aparece digitando e os widgets chegam como um evento próprio.
app.post('/api/ai/conversations/:id/messages', requireAuth(), async (req, res) => {
  const { text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Escreva uma mensagem.' })

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Sem isto o nginx BUFFERIZA a resposta inteira e o streaming não chega ao
  // navegador em produção — a pessoa veria a tela parada e a resposta toda de
  // uma vez no fim (ver docker/nginx.conf).
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let closed = false
  req.on('close', () => { closed = true })
  const emit = (event) => {
    if (closed) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    await runTurn({
      conversationId: req.params.id, email: req.user.email, userText: String(text),
      accessToken: req.accessToken, emit,
    })
  } catch (e) {
    console.error(`[ai] turno falhou: ${e.message}`)
    emit({ type: 'error', message: e.message })
  } finally {
    if (!closed) res.end()
  }
})

// ─── Dicionário de dados (descrição/origem por coluna) ────────────
// Leitura liberada pra qualquer usuário (é o que alimenta o InfoHint nos
// seletores de campo do Builder); só admin escreve.
app.get('/api/field-dictionary', requireAuth(), (_req, res) => {
  res.json({ entries: listFieldDictionary() })
})

app.put('/api/field-dictionary', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const b = req.body || {}
    const entry = upsertFieldDescription({ source: b.source, field: b.field, description: b.description }, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'fieldDictionary.update', target: `${b.source}::${b.field}` })
    res.json({ ok: true, entry })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ─── Comentários/anotações em widgets ─────────────────────────────
// Qualquer usuário autenticado pode ler/comentar (não é uma mudança
// estrutural do widget — não exige permissão de EDITAR, só de estar logado;
// a própria dashboard já está atrás de requireFolderAccess pra ser vista).
// Remover é restrito a quem escreveu (ou admin) — ver deleteComment.
app.get('/api/widget-comments/counts', requireAuth(), (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean)
  const all = commentCountsByWidget()
  const counts = {}
  for (const id of ids) counts[id] = all.get(id) ?? 0
  res.json({ counts })
})

app.get('/api/widget-comments/:widgetId', requireAuth(), (req, res) => {
  res.json({ comments: listCommentsForWidget(req.params.widgetId) })
})

app.post('/api/widget-comments', requireAuth(), (req, res) => {
  try {
    const b = req.body || {}
    const comment = addComment({ widgetId: b.widgetId, text: b.text }, req.user)
    res.json({ ok: true, comment })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/widget-comments/:id', requireAuth(), (req, res) => {
  try {
    deleteComment(req.params.id, req.user.email, isAdmin(req.user.email))
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ─── Workspace: Pasta → Dashboard → Guia ──────────────────────────
// Árvore leve (pastas + dashboards visíveis, sem guias/widgets) — alimenta o
// menu lateral. Cada pasta vem anotada com `canManage` pro front decidir se
// mostra os controles de admin/gerente daquela pasta.
app.get('/api/workspace/tree', requireAuth(), (req, res) => {
  res.json({ folders: getWorkspaceTreeForUser(req.user.email) })
})

// Dashboard completa (só as guias que o usuário pode ver, cada uma anotada
// com `canEdit`) — o que o DashboardBuilder de fato renderiza.
app.get('/api/workspace/folders/:fid/dashboards/:did', requireAuth(), requireFolderAccess(), (req, res) => {
  const result = getDashboardForUser(req.params.fid, req.params.did, req.user.email)
  if (result.error) return res.status(result.error).json({ error: result.message })
  res.json(result)
})

// Lista completa (accessEmails/managers reais) — só pra tela de gestão de
// pastas (admin). A árvore de navegação (/api/workspace/tree) é mais enxuta.
app.get('/api/workspace/folders', requireAuth(), requireAdmin(), (_req, res) => {
  res.json({ folders: listFoldersFull() })
})

// Uma pasta só, com accessEmails/managers reais — alimenta o botão de
// engrenagem ao lado da pasta no menu.
app.get('/api/workspace/folders/:fid', requireAuth(), requireAdmin(), (req, res) => {
  const folder = getFolderFull(req.params.fid)
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada.' })
  res.json({ folder })
})

app.post('/api/workspace/folders', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const folder = createFolder(req.body || {}, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'folder.create', target: folder.id })
    res.json({ ok: true, folder })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.put('/api/workspace/folders/:fid', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const folder = updateFolder(req.params.fid, req.body || {}, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'folder.update', target: folder.id })
    res.json({ ok: true, folder })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/workspace/folders/:fid', requireAuth(), requireAdmin(), (req, res) => {
  try {
    deleteFolder(req.params.fid)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'folder.delete', target: req.params.fid })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// accessEmails: null = pasta aberta a qualquer autenticado; lista = só esses.
app.put('/api/workspace/folders/:fid/access', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const emails = (req.body || {}).accessEmails
    const folder = setFolderAccess(req.params.fid, emails === null ? null : (emails || []), req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'folder.access.update', target: folder.id, meta: { open: folder.accessEmails === null, count: folder.accessEmails?.length ?? null } })
    res.json({ ok: true, folder })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Gerentes da pasta — cada um pode criar dashboards e gerenciar o acesso por
// guia dentro desta pasta, sem precisar ser admin global.
app.put('/api/workspace/folders/:fid/managers', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const folder = setFolderManagers(req.params.fid, (req.body || {}).managers || [], req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'folder.managers.update', target: folder.id, meta: { managers: folder.managers } })
    res.json({ ok: true, folder })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Fonte do seletor de acesso por guia — só quem já tem acesso a esta pasta.
app.get('/api/workspace/folders/:fid/members', requireAuth(), requireFolderManager(), (req, res) => {
  try {
    res.json({ members: listFolderMembers(req.params.fid) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/workspace/folders/:fid/dashboards', requireAuth(), requireFolderManager(), (req, res) => {
  try {
    const dashboard = createDashboard(req.params.fid, req.body || {}, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'workspace.dashboard.create', target: `${req.params.fid}/${dashboard.id}` })
    res.json({ ok: true, dashboard })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.put('/api/workspace/folders/:fid/dashboards/:did', requireAuth(), requireFolderManager(), (req, res) => {
  try {
    const dashboard = updateDashboard(req.params.fid, req.params.did, req.body || {}, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'workspace.dashboard.update', target: `${req.params.fid}/${dashboard.id}` })
    res.json({ ok: true, dashboard })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/workspace/folders/:fid/dashboards/:did', requireAuth(), requireFolderManager(), (req, res) => {
  try {
    deleteDashboard(req.params.fid, req.params.did)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'workspace.dashboard.delete', target: `${req.params.fid}/${req.params.did}` })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Salva a dashboard inteira (guias/filtros/canvas/widgets) — quem gerencia a
// pasta mexe livremente na estrutura.
app.put('/api/workspace/folders/:fid/dashboards/:did/full', requireAuth(), requireFolderManager(), (req, res) => {
  try {
    const dashboard = saveDashboardFull(req.params.fid, req.params.did, (req.body || {}).tabs, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'dashboard.save', target: `${req.params.fid}/${dashboard.id}` })
    res.json({ ok: true, dashboard })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Salva só os widgets de UMA guia — usado por um usuário padrão com edição
// liberada ali (não pode mexer na estrutura da dashboard).
app.put('/api/workspace/folders/:fid/dashboards/:did/tabs/:tid/widgets', requireAuth(), requireTabEdit(), (req, res) => {
  try {
    const tab = saveTabWidgets(req.params.fid, req.params.did, req.params.tid, (req.body || {}).widgets, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'tab.widgets.save', target: `${req.params.fid}/${req.params.did}/${tab.id}` })
    res.json({ ok: true, tab })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Define quem vê/edita uma guia — só admin ou o gerente da pasta.
app.put('/api/workspace/folders/:fid/dashboards/:did/tabs/:tid/access', requireAuth(), requireFolderManager(), (req, res) => {
  try {
    const tab = setTabAccess(req.params.fid, req.params.did, req.params.tid, req.body || {}, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'tab.access.update', target: `${req.params.fid}/${req.params.did}/${tab.id}`, meta: tab.access })
    res.json({ ok: true, tab })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ─── Gestão de acessos (aba "Acessos", só administradores) ────────
app.get('/api/access/is-admin', requireAuth(), (req, res) => {
  res.json({ isAdmin: isAdmin(req.user.email) })
})

app.get('/api/access/users', requireAuth(), requireAdmin(), (_req, res) => {
  res.json({ users: listUsers(), onlineThresholdMs: ONLINE_THRESHOLD_MS })
})

// Promove/rebaixa um usuário — 'admin' ou 'standard'. Bloqueia remover o
// último administrador (ver setUserRole em accessLog.mjs).
app.patch('/api/access/users/:email/role', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const target = req.params.email
    const updated = setUserRole(target, (req.body || {}).role)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: updated.role === 'admin' ? 'user.promote' : 'user.demote', target })
    res.json({ ok: true, user: updated })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/access/log', requireAuth(), requireAdmin(), (req, res) => {
  res.json({ entries: listAuditLog({ limit: Number(req.query.limit) || 200 }) })
})

// Ping periódico do front (ver src/hooks/useHeartbeat.ts) — mantém o usuário
// "online" mesmo numa tela parada sem nenhuma outra chamada de API.
app.post('/api/access/heartbeat', requireAuth(), (_req, res) => {
  res.sendStatus(204)
})

// O registro de login/logout na auditoria mudou de lugar: agora acontece no
// servidor, dentro do próprio fluxo (callback do Google e POST
// /api/auth/logout), em vez de depender de uma chamada extra do front que
// poderia simplesmente não acontecer.

app.listen(PORT, () => {
  console.log(`Indicadores Sebratel API ouvindo em :${PORT}`)
  console.log(`  domínio permitido: @${ALLOWED_DOMAIN}`)
})
