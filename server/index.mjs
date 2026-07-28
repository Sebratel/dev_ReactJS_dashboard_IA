// ─────────────────────────────────────────────────────────────────────────
// Backend Express — serve /api/* a partir do snapshot materializado em
// memória (server/dataset.mjs), gerado por um catálogo único e editável de
// queries (server/queryCatalog.mjs). Toda a dashboard é construída
// manualmente no Builder a partir das colunas reais dessas queries — não há
// abas/métricas fixas embutidas no código.
// Mesmo padrão de auth do dev_ReacJS_HealthyScore-staging (Google OAuth,
// domínio restrito), adaptado para este projeto.
// ─────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import express from 'express'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { getStatus } from './dataset.mjs'
import { makePool } from '../scripts/db.mjs'
import { makeMariaPool } from '../scripts/db-maria.mjs'
import {
  loadQueryCatalog, createQuery, updateQuery, deleteQuery, resetQueryCatalog, setQueryEnabled, setQueryRefresh,
  setQueryFolders, executeQuery, TEST_ROW_LIMIT,
} from './queryCatalog.mjs'
import { runWidgetQuery, runFieldValues, listSourceDefs } from './widgetQuery.mjs'
import {
  listSheetSources, createSheetSource, updateSheetSource, deleteSheetSource, getSheetSource, resolveSheetRows, sourceKey as sheetSourceKey,
} from './sheetSources.mjs'
import { listFieldDictionary, upsertFieldDescription } from './fieldDictionary.mjs'
import { listCommentsForWidget, addComment, deleteComment, commentCountsByWidget } from './widgetComments.mjs'
import {
  getFolder, getTab, hasFolderAccess, canManageFolder, canEditTabWidgets,
  getWorkspaceTreeForUser, getDashboardForUser, listFoldersFull, getFolderFull,
  createFolder, updateFolder, deleteFolder, setFolderAccess, setFolderManagers, listFolderMembers,
  createDashboard, updateDashboard, deleteDashboard, saveDashboardFull, saveTabWidgets, setTabAccess,
  findFoldersUsingQuery,
} from './workspace.mjs'
import { isAdmin, touchUser, listUsers, setUserRole, appendAuditLog, listAuditLog, ONLINE_THRESHOLD_MS } from './accessLog.mjs'

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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ─── Auth ──────────────────────────────────────────────────────
const tokenCache = new Map()
const TOKEN_TTL_MS = 5 * 60 * 1000

async function getUserFromToken(token) {
  const cached = tokenCache.get(token)
  if (cached && cached.exp > Date.now()) return cached.user
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) return null
  const p = await r.json()
  if (!p.email || p.email_verified === false) return null
  const user = { email: String(p.email).toLowerCase(), name: p.name || p.email }
  tokenCache.set(token, { user, exp: Date.now() + TOKEN_TTL_MS })
  return user
}

function requireAuth() {
  return async (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (!m) return res.status(401).json({ error: 'Token de autenticação ausente.' })
    let user = null
    try { user = await getUserFromToken(m[1]) } catch { user = null }
    if (!user) return res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' })
    if (!user.email.endsWith('@' + ALLOWED_DOMAIN)) {
      return res.status(403).json({ error: `Acesso restrito a contas @${ALLOWED_DOMAIN}.` })
    }
    req.user = user
    // Guardado (só na memória da requisição, nunca persistido) pra rotas que
    // precisam falar com uma API do Google em nome do próprio usuário — ver
    // server/sheetSources.mjs/googleSheets.mjs (planilhas cadastradas livremente).
    req.accessToken = m[1]
    touchUser(user.email, user.name)
    next()
  }
}

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

// ─── Pools de banco sob demanda (só para "testar query" ao vivo) ──
// O servidor Express é de vida longa — cria os pools uma vez e reusa. Se as
// credenciais estiverem ausentes/erradas, a falha fica isolada na primeira
// chamada que tentar usá-los (não derruba o servidor no boot).
let pgPool = null
function getPgPool() {
  if (!pgPool) pgPool = makePool()
  return pgPool
}
let mariaPoolPromise = null
async function getMariaPool() {
  if (!mariaPoolPromise) mariaPoolPromise = makeMariaPool().catch((e) => { mariaPoolPromise = null; throw e })
  return mariaPoolPromise
}

// ─── Disparo do ETL após alterar o catálogo de queries ────────────
let etlRunning = false
function triggerEtlRefresh(reason) {
  if (etlRunning) return
  etlRunning = true
  const child = spawn(process.execPath, [ETL_SCRIPT], { stdio: 'inherit', env: process.env })
  child.on('exit', () => { etlRunning = false })
  child.on('error', (e) => { etlRunning = false; console.error(`[query-catalog] falha ao disparar ETL: ${e.message}`) })
  console.log(`[query-catalog] atualizando snapshot em segundo plano (${reason})`)
}

// ─── Rotas ───────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'indicadores-sebratel-api', time: new Date().toISOString() })
})

app.get('/api/dataset/status', requireAuth(), (_req, res) => {
  res.json(getStatus())
})

// ─── Catálogo único de queries (add/editar/remover livremente) ───
app.get('/api/queries', requireAuth(), (_req, res) => {
  res.json(loadQueryCatalog())
})

app.post('/api/queries', requireAuth(), (req, res) => {
  try {
    const saved = createQuery(req.body || {}, req.user.email)
    triggerEtlRefresh(`nova query ${saved.id}`)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'query.create', target: saved.id })
    res.json({ ok: true, query: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.put('/api/queries/:id', requireAuth(), (req, res) => {
  try {
    const saved = updateQuery(req.params.id, req.body || {}, req.user.email)
    triggerEtlRefresh(`query editada ${saved.id}`)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'query.update', target: saved.id })
    res.json({ ok: true, query: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.delete('/api/queries/:id', requireAuth(), (req, res) => {
  try {
    deleteQuery(req.params.id)
    triggerEtlRefresh(`query removida ${req.params.id}`)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'query.delete', target: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/queries/reset', requireAuth(), (req, res) => {
  const list = resetQueryCatalog()
  triggerEtlRefresh('catálogo restaurado ao padrão')
  appendAuditLog({ email: req.user.email, name: req.user.name, action: 'query.reset', target: null })
  res.json({ ok: true, queries: list })
})

// Ativa/desativa uma query — desativada não roda no próximo ETL e some do
// catálogo de fontes do Builder (fica "bloqueada para uso") até reativar.
app.patch('/api/queries/:id/enabled', requireAuth(), (req, res) => {
  try {
    const saved = setQueryEnabled(req.params.id, !!(req.body || {}).enabled, req.user.email)
    triggerEtlRefresh(`query ${saved.enabled ? 'ativada' : 'desativada'}: ${saved.id}`)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: saved.enabled ? 'query.enable' : 'query.disable', target: saved.id })
    res.json({ ok: true, query: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Modo de atualização de UMA query — 'realtime' (roda em todo ciclo do ETL)
// ou 'scheduled' (só roda a cada `minutes`, mantendo o dado anterior nos
// ciclos em que não é a vez dela). Config por query, não global — cada uma
// tem seu próprio ritmo, ver scripts/fetch-install.mjs.
app.patch('/api/queries/:id/refresh', requireAuth(), (req, res) => {
  try {
    const { mode, minutes } = req.body || {}
    const saved = setQueryRefresh(req.params.id, { mode, minutes }, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'query.refresh', target: saved.id, meta: { mode: saved.refreshMode, minutes: saved.refreshMinutes } })
    res.json({ ok: true, query: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Em quais pastas (e dashboards dentro delas) esta query já está em uso de
// fato — alimenta o aviso de confirmação antes do admin remover uma pasta
// que já depende dela (ver FolderControl em SettingsPage.tsx).
app.get('/api/queries/:id/usage', requireAuth(), requireAdmin(), (req, res) => {
  res.json({ folders: findFoldersUsingQuery(req.params.id) })
})

// Em quais pastas esta query aparece como fonte no Builder — null (padrão)
// = todas. Só admin (mesmo nível de quem gerencia pastas em si) decide isso;
// diferente de enabled/refresh, que qualquer usuário logado pode ajustar.
app.patch('/api/queries/:id/folders', requireAuth(), requireAdmin(), (req, res) => {
  try {
    const { folderIds } = req.body || {}
    const saved = setQueryFolders(req.params.id, folderIds === undefined ? null : folderIds, req.user.email)
    appendAuditLog({ email: req.user.email, name: req.user.name, action: 'query.folders.update', target: saved.id, meta: { folderIds: saved.folderIds } })
    res.json({ ok: true, query: saved })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Executa SQL ao vivo (capado) sem salvar — usado pelo editor para validar
// antes de criar/editar uma query.
app.post('/api/queries/test', requireAuth(), async (req, res) => {
  try {
    const { db, sql } = req.body || {}
    const rows = await executeQuery({ db, sql }, { pgPool: getPgPool(), mariaPool: await getMariaPool(), limit: TEST_ROW_LIMIT })
    const columns = rows.length ? Object.keys(rows[0]) : []
    res.json({ columns, rows, rowCount: rows.length })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
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

app.post('/api/access/login', requireAuth(), (req, res) => {
  appendAuditLog({ email: req.user.email, name: req.user.name, action: 'auth.login', target: req.user.email })
  res.sendStatus(204)
})

app.post('/api/access/logout', requireAuth(), (req, res) => {
  appendAuditLog({ email: req.user.email, name: req.user.name, action: 'auth.logout', target: req.user.email })
  res.sendStatus(204)
})

app.listen(PORT, () => {
  console.log(`Indicadores Sebratel API ouvindo em :${PORT}`)
  console.log(`  domínio permitido: @${ALLOWED_DOMAIN}`)
})
