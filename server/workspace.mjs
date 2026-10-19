// ─────────────────────────────────────────────────────────────────────────
// Hierarquia Pasta → Dashboard → Guia (ver plano em
// C:\Users\gustavo.santos\.claude\plans\humble-toasting-riddle.md, seção
// "Hierarquia Pasta → Dashboard → Guia, com permissões por setor").
// Substitui o antigo documento único `data/dashboard-config.json`
// (server/dashboardConfig.mjs, removido) por `data/workspace.json`: uma
// árvore de pastas (setores) → dashboards → guias (o TabConfig de sempre),
// cada nível com seu próprio controle de acesso. Mesmo padrão de
// persistência síncrona (ler, mutar em memória, regravar o arquivo inteiro)
// usado em accessLog.mjs/lakehouseSources.mjs — escala bem pro tamanho de uma
// ferramenta interna, sem concorrência de escrita pesada.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { isAdmin, isKnownUser, resolveUsers, listKnownEmails } from './accessLog.mjs'
import { createWelcomeTab, LEGACY_WELCOME_TEXTS, CURRENT_WELCOME_TEXT, LEGACY_WELCOME_HEIGHTS, CURRENT_WELCOME_HEIGHT } from '../src/features/builder/defaultConfig.ts'

const WORKSPACE_PATH = process.env.WORKSPACE_PATH
  ? resolve(process.env.WORKSPACE_PATH)
  : resolve(process.cwd(), 'data/workspace.json')
// Config legada (documento único, pré-hierarquia) — lida diretamente aqui só
// para a migração de 1ª carga; nunca mais escrita depois disso.
const LEGACY_DASHBOARD_PATH = process.env.DASHBOARD_CONFIG_PATH
  ? resolve(process.env.DASHBOARD_CONFIG_PATH)
  : resolve(process.cwd(), 'data/dashboard-config.json')

function nowIso() { return new Date().toISOString() }
function genId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }
function normalizeEmails(list) {
  return Array.from(new Set((list || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean)))
}

function saveWorkspace(ws) {
  mkdirSync(dirname(WORKSPACE_PATH), { recursive: true })
  writeFileSync(WORKSPACE_PATH, JSON.stringify(ws, null, 2), 'utf8')
}

function loadLegacyDashboardConfig() {
  if (!existsSync(LEGACY_DASHBOARD_PATH)) return null
  try {
    const config = JSON.parse(readFileSync(LEGACY_DASHBOARD_PATH, 'utf8'))
    if (config && Array.isArray(config.tabs)) return config
  } catch (e) {
    console.error(`[workspace] falha ao ler dashboard-config.json legado: ${e.message}`)
  }
  return null
}

function emptyFolder(id, name) {
  return {
    id, name, icon: 'LayoutDashboard', order: 0,
    accessEmails: null, managers: [],
    createdBy: null, createdAt: nowIso(), updatedBy: null, updatedAt: null,
    dashboards: [],
  }
}

// Roda uma única vez, na 1ª chamada sem `data/workspace.json` no disco.
// Se existir uma config legada (documento único de antes desta hierarquia),
// vira a pasta "Geral" com uma dashboard "Principal" — TODAS as guias
// existentes são marcadas como abertas (`access: open`), pra ninguém perder
// acesso ao que já usa hoje. Sem config legada, nasce vazio mesmo (só a
// guia de boas-vindas), pronto pro admin organizar em pastas por setor.
function buildInitialWorkspace() {
  const legacy = loadLegacyDashboardConfig()
  const folder = emptyFolder('geral', 'Geral')
  if (legacy) {
    folder.dashboards.push({
      id: 'principal', name: 'Dashboard Principal', order: 0,
      createdBy: null, createdAt: nowIso(), updatedBy: null, updatedAt: null,
      tabs: legacy.tabs.map((t) => ({ ...t, access: t.access ?? { mode: 'open', view: [], edit: [] } })),
    })
    console.log('[workspace] migrado a partir de dashboard-config.json legado — guias existentes marcadas como abertas')
  } else {
    folder.dashboards.push({
      id: 'principal', name: 'Dashboard Principal', order: 0,
      createdBy: null, createdAt: nowIso(), updatedBy: null, updatedAt: null,
      tabs: [createWelcomeTab()],
    })
  }
  // version 2 = resolução de grade já na unidade nova (24 colunas/22px) —
  // um workspace criado do zero não precisa passar por
  // migrateGridResolution, já nasce migrado.
  return { version: 2, folders: [folder] }
}

// Dobra a resolução da grade (12→24 colunas, 56→22px por linha — ver
// ROW_HEIGHT/GRID_COLS em DashboardBuilder.tsx): multiplica x/y/w/h de TODO
// widget de TODA guia por 2. Não muda o tamanho VISUAL de nada — é a mesma
// posição/tamanho, só expresso numa unidade duas vezes mais fina, que passou
// a existir pra dar ao Cartão/Texto um piso de redimensionar genuinamente
// menor (os demais tipos mantêm o piso de hoje via minW/minH explícito no
// front — ver MIN_SIZE_2X em DashboardBuilder.tsx).
//
// Diferente de migrateWelcomeText (decide pelo CONTEÚDO, sempre seguro de
// rodar de novo): dobrar de novo corromperia o layout silenciosamente, então
// isto é controlado por VERSÃO do arquivo — roda uma única vez, quando
// `ws.version` ainda é 1 (ou ausente, arquivo de antes desse campo existir).
function migrateGridResolution(ws) {
  if ((ws.version ?? 1) >= 2) return false
  for (const folder of ws.folders ?? []) {
    for (const dashboard of folder.dashboards ?? []) {
      for (const tab of dashboard.tabs ?? []) {
        for (const widget of tab.widgets ?? []) {
          if (!widget.layout) continue
          widget.layout = {
            x: (widget.layout.x ?? 0) * 2,
            y: (widget.layout.y ?? 0) * 2,
            w: (widget.layout.w ?? 1) * 2,
            h: (widget.layout.h ?? 1) * 2,
          }
        }
      }
    }
  }
  ws.version = 2
  return true
}

// Atualiza o texto da guia de boas-vindas de dashboards que já existiam.
// `createWelcomeTab` só roda na CRIAÇÃO, então sem isto uma dashboard antiga
// ficaria para sempre com o texto que ensina o caminho manual e cita o
// catálogo de queries (que não existe mais).
//
// Conservadora de propósito: só troca quando o conteúdo salvo é EXATAMENTE um
// dos textos que o app já gerou (LEGACY_WELCOME_TEXTS). Qualquer edição feita
// por alguém — mesmo um espaço a mais — faz o texto deixar de casar, e aí ele
// é preservado. Devolve quantos widgets foram atualizados.
function migrateWelcomeText(ws) {
  let updated = 0
  for (const folder of ws.folders ?? []) {
    for (const dashboard of folder.dashboards ?? []) {
      for (const tab of dashboard.tabs ?? []) {
        if (!tab.isWelcome) continue
        for (const widget of tab.widgets ?? []) {
          if (widget.type !== 'text') continue
          let changed = false

          if (LEGACY_WELCOME_TEXTS.includes(widget.content)) {
            widget.content = CURRENT_WELCOME_TEXT
            changed = true
          }

          // Altura é checada SEPARADAMENTE do conteúdo: uma guia que já foi
          // migrada numa rodada anterior tem o texto atual mas a altura antiga,
          // e cairia de fora se isto dependesse do texto ainda ser legado. Só
          // redimensiona quando a altura é uma das que o app gerou — quem
          // arrastou a borda mantém o tamanho que escolheu.
          if (widget.content === CURRENT_WELCOME_TEXT
            && LEGACY_WELCOME_HEIGHTS.includes(widget.layout?.h)) {
            widget.layout.h = CURRENT_WELCOME_HEIGHT
            changed = true
          }

          if (changed) updated += 1
        }
      }
    }
  }
  return updated
}

function loadWorkspace() {
  if (existsSync(WORKSPACE_PATH)) {
    try {
      // Guarda o texto ORIGINAL antes de parsear: é ele que vira o backup se a
      // migração mexer em algo (o objeto é mutado no lugar, então salvá-lo
      // depois gravaria a versão nova como "backup").
      const raw = readFileSync(WORKSPACE_PATH, 'utf8')
      const ws = JSON.parse(raw)
      if (ws && Array.isArray(ws.folders)) {
        // Resolução da grade primeiro: migrateWelcomeText compara a altura
        // salva contra LEGACY_WELCOME_HEIGHTS/CURRENT_WELCOME_HEIGHT, que já
        // estão na unidade NOVA — rodar depois da dobra é o que faz esses
        // valores baterem.
        const gridMigrated = migrateGridResolution(ws)
        const textMigrated = migrateWelcomeText(ws)
        if (gridMigrated || textMigrated > 0) {
          try { writeFileSync(`${WORKSPACE_PATH}.bak`, raw, 'utf8') } catch { /* backup é bônus, não bloqueia */ }
          saveWorkspace(ws)
          const parts = []
          if (gridMigrated) parts.push('resolução da grade dobrada (12→24 colunas)')
          if (textMigrated > 0) parts.push(`texto de boas-vindas atualizado em ${textMigrated} guia(s)`)
          console.log(`[workspace] ${parts.join(' · ')} — backup do anterior em ${WORKSPACE_PATH}.bak`)
        }
        return ws
      }
      throw new Error('formato inválido — "folders" (array) ausente')
    } catch (e) {
      console.error(`[workspace] arquivo corrompido (${e.message}) — recriando a partir do padrão`)
    }
  }
  const ws = buildInitialWorkspace()
  saveWorkspace(ws)
  return ws
}

function findFolder(ws, id) { return ws.folders.find((f) => f.id === id) }
function findDashboard(folder, id) { return folder.dashboards.find((d) => d.id === id) }
function findTab(dashboard, id) { return dashboard.tabs.find((t) => t.id === id) }

function requireFolder(ws, folderId) {
  const folder = findFolder(ws, folderId)
  if (!folder) throw new Error('Pasta não encontrada.')
  return folder
}
function requireDashboard(folder, dashboardId) {
  const dashboard = findDashboard(folder, dashboardId)
  if (!dashboard) throw new Error('Dashboard não encontrada.')
  return dashboard
}

// ─── Permissões ────────────────────────────────────────────────────────
export function isFolderManager(folder, email) {
  return !!email && folder.managers.includes(String(email).toLowerCase())
}

// Gate grosso: sem isso, a pasta (e tudo dentro) nem aparece pro usuário.
export function hasFolderAccess(folder, email) {
  if (!email) return false
  const key = String(email).toLowerCase()
  if (isAdmin(key) || isFolderManager(folder, key)) return true
  return folder.accessEmails === null || folder.accessEmails.includes(key)
}

// Criar dashboard, gerenciar guias/filtros/formato, dar acesso por guia.
export function canManageFolder(folder, email) {
  return isAdmin(email) || isFolderManager(folder, email)
}

export function canViewTab(folder, tab, email) {
  if (!hasFolderAccess(folder, email)) return false
  if (isAdmin(email) || isFolderManager(folder, email)) return true
  if (!tab.access || tab.access.mode === 'open') return true
  const key = String(email).toLowerCase()
  return tab.access.view.includes(key) || tab.access.edit.includes(key)
}

export function canEditTabWidgets(folder, tab, email) {
  if (!hasFolderAccess(folder, email)) return false
  if (isAdmin(email) || isFolderManager(folder, email)) return true
  const key = String(email).toLowerCase()
  return (tab.access?.edit ?? []).includes(key)
}

// Pra middlewares de permissão em server/index.mjs (requireFolderAccess/
// requireFolderManager/requireTabEdit) — leitura pura, sem checar nada.
export function getFolder(folderId) {
  const ws = loadWorkspace()
  return findFolder(ws, folderId) || null
}

export function getTab(folderId, dashboardId, tabId) {
  const folder = getFolder(folderId)
  if (!folder) return null
  const dashboard = findDashboard(folder, dashboardId)
  if (!dashboard) return null
  return findTab(dashboard, tabId) || null
}

// ─── Leitura para o usuário atual ──────────────────────────────────────
// Árvore leve (sem guias/widgets) pro menu lateral — só pastas e dashboards
// que o usuário pode ver.
export function getWorkspaceTreeForUser(email) {
  const ws = loadWorkspace()
  return ws.folders
    .filter((f) => hasFolderAccess(f, email))
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      id: f.id,
      name: f.name,
      icon: f.icon,
      canManage: canManageFolder(f, email),
      dashboards: [...f.dashboards]
        .sort((a, b) => a.order - b.order)
        .map((d) => ({ id: d.id, name: d.name })),
    }))
}

// TODAS as pastas, para a página "Manual de uso" pedir acesso: só nome, ícone e
// se quem pergunta já entra. Nada de dashboards, guias ou lista de acesso — quem
// está de fora não enxerga o conteúdo de uma pasta antes de ser liberado.
export function listFolderCatalogForUser(email) {
  const ws = loadWorkspace()
  return [...ws.folders]
    .sort((a, b) => a.order - b.order)
    .map((f) => ({ id: f.id, name: f.name, icon: f.icon, hasAccess: hasFolderAccess(f, email) }))
}

// Dashboard completa (guias + widgets), só com as guias que o usuário pode
// ver — cada uma anotada com `canEdit` pro Builder decidir o que habilitar.
export function getDashboardForUser(folderId, dashboardId, email) {
  const ws = loadWorkspace()
  const folder = findFolder(ws, folderId)
  if (!folder) return { error: 404, message: 'Pasta não encontrada.' }
  if (!hasFolderAccess(folder, email)) return { error: 403, message: 'Sem acesso a esta pasta.' }
  const dashboard = findDashboard(folder, dashboardId)
  if (!dashboard) return { error: 404, message: 'Dashboard não encontrada.' }
  const tabs = dashboard.tabs
    .filter((t) => canViewTab(folder, t, email))
    .map((t) => ({ ...t, canEdit: canEditTabWidgets(folder, t, email) }))
  return {
    folder: { id: folder.id, name: folder.name, canManage: canManageFolder(folder, email), isManager: isFolderManager(folder, email) },
    dashboard: { id: dashboard.id, name: dashboard.name, tabs, measures: dashboard.measures ?? [] },
  }
}

// ─── Pastas (admin) ─────────────────────────────────────────────────────
// Lista completa (com accessEmails/managers reais) — só pra tela de gestão
// de pastas (admin); a árvore de navegação (getWorkspaceTreeForUser) é
// deliberadamente mais enxuta e já filtrada por acesso.
export function listFoldersFull() {
  const ws = loadWorkspace()
  return ws.folders
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      id: f.id, name: f.name, icon: f.icon, order: f.order,
      accessEmails: f.accessEmails, managers: f.managers,
      createdBy: f.createdBy, createdAt: f.createdAt, updatedBy: f.updatedBy, updatedAt: f.updatedAt,
      dashboards: f.dashboards.map((d) => ({ id: d.id, name: d.name })),
    }))
}

// Uma pasta só, com accessEmails/managers reais — usado pelo botão de
// engrenagem ao lado de cada pasta no menu (em vez de uma tela dedicada).
export function getFolderFull(folderId) {
  const ws = loadWorkspace()
  const folder = findFolder(ws, folderId)
  if (!folder) return null
  return {
    id: folder.id, name: folder.name, icon: folder.icon, order: folder.order,
    accessEmails: folder.accessEmails, managers: folder.managers,
    createdBy: folder.createdBy, createdAt: folder.createdAt, updatedBy: folder.updatedBy, updatedAt: folder.updatedAt,
    dashboards: folder.dashboards.map((d) => ({ id: d.id, name: d.name })),
  }
}

export function createFolder({ name, icon }, actorEmail) {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('Nome da pasta é obrigatório.')
  const ws = loadWorkspace()
  const folder = {
    id: genId('folder'), name: trimmed, icon: icon || 'Folder', order: ws.folders.length,
    accessEmails: null, managers: [],
    createdBy: actorEmail, createdAt: nowIso(), updatedBy: null, updatedAt: null,
    dashboards: [],
  }
  ws.folders.push(folder)
  saveWorkspace(ws)
  return folder
}

export function updateFolder(folderId, patch, actorEmail) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim()
    if (!trimmed) throw new Error('Nome da pasta é obrigatório.')
    folder.name = trimmed
  }
  if (patch.icon !== undefined) folder.icon = patch.icon
  if (patch.order !== undefined) folder.order = patch.order
  folder.updatedBy = actorEmail
  folder.updatedAt = nowIso()
  saveWorkspace(ws)
  return folder
}

export function deleteFolder(folderId) {
  const ws = loadWorkspace()
  const idx = ws.folders.findIndex((f) => f.id === folderId)
  if (idx === -1) throw new Error('Pasta não encontrada.')
  const [removed] = ws.folders.splice(idx, 1)
  saveWorkspace(ws)
  return removed
}

export function setFolderAccess(folderId, accessEmails, actorEmail) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  folder.accessEmails = accessEmails === null ? null : normalizeEmails(accessEmails)
  folder.updatedBy = actorEmail
  folder.updatedAt = nowIso()
  saveWorkspace(ws)
  return folder
}

// Libera a pasta para UM e-mail — é o que aprovar uma solicitação de acesso
// faz (ver server/accessRequests.mjs). Pasta aberta (accessEmails null) já
// atende todo mundo, e e-mail já liberado não muda nada: nos dois casos não há
// o que gravar.
export function grantFolderAccess(folderId, email, actorEmail) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const key = String(email).toLowerCase()
  if (folder.accessEmails === null || folder.accessEmails.includes(key)) return folder
  folder.accessEmails = normalizeEmails([...folder.accessEmails, key])
  folder.updatedBy = actorEmail
  folder.updatedAt = nowIso()
  saveWorkspace(ws)
  return folder
}

export function setFolderManagers(folderId, managers, actorEmail) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const normalized = normalizeEmails(managers)
  for (const email of normalized) {
    if (!isKnownUser(email)) throw new Error(`"${email}" ainda não acessou o sistema — não é possível torná-lo gerente.`)
  }
  folder.managers = normalized
  folder.updatedBy = actorEmail
  folder.updatedAt = nowIso()
  saveWorkspace(ws)
  return folder
}

// Fonte do seletor de acesso por guia — só os e-mails que já têm acesso a
// esta pasta (nunca a lista global de usuários), pra um gerente nunca
// precisar de visibilidade sobre gente fora do próprio setor.
export function listFolderMembers(folderId) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const emails = folder.accessEmails === null ? listKnownEmails() : folder.accessEmails
  return resolveUsers(emails)
}

// ─── Dashboards (admin + gerente da pasta) ─────────────────────────────
export function createDashboard(folderId, { name }, actorEmail) {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('Nome da dashboard é obrigatório.')
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = {
    id: genId('dash'), name: trimmed, order: folder.dashboards.length,
    createdBy: actorEmail, createdAt: nowIso(), updatedBy: null, updatedAt: null,
    tabs: [createWelcomeTab()],
  }
  folder.dashboards.push(dashboard)
  saveWorkspace(ws)
  return dashboard
}

export function updateDashboard(folderId, dashboardId, patch, actorEmail) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = requireDashboard(folder, dashboardId)
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim()
    if (!trimmed) throw new Error('Nome da dashboard é obrigatório.')
    dashboard.name = trimmed
  }
  if (patch.order !== undefined) dashboard.order = patch.order
  dashboard.updatedBy = actorEmail
  dashboard.updatedAt = nowIso()
  saveWorkspace(ws)
  return dashboard
}

// Cópia de uma dashboard inteira na MESMA pasta — guias (com o acesso de cada
// uma, que vale pras mesmas pessoas da pasta), filtros, formato e medidas.
// Guias e widgets ganham id novo: os comentários de um widget são pelo id
// dele (ver widgetComments.mjs), e a cópia não herda a conversa do original.
// As medidas mantêm o id — ele só vale dentro da dashboard, e é por ele que os
// widgets copiados apontam pra elas (measureRef).
export function duplicateDashboard(folderId, dashboardId, actorEmail, actorName) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const source = requireDashboard(folder, dashboardId)
  const names = new Set(folder.dashboards.map((d) => d.name))
  let name = `${source.name} (cópia)`
  for (let n = 2; names.has(name); n++) name = `${source.name} (cópia ${n})`
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const copy = {
    id: genId('dash'), name, order: folder.dashboards.length,
    createdBy: actorEmail, createdAt: nowIso(), updatedBy: null, updatedAt: null,
    tabs: source.tabs.map((tab) => {
      const { rev: _rev, canEdit: _canEdit, updatedBy: _by, updatedByName: _name, updatedAt: _at, ...content } = clone(tab)
      const copied = { ...content, id: genId('tab'), widgets: (content.widgets ?? []).map((w) => ({ ...w, id: genId('w') })), rev: 1 }
      stampTab(copied, { email: actorEmail, name: actorName })
      return copied
    }),
    measures: clone(source.measures ?? []),
  }
  folder.dashboards.push(copy)
  saveWorkspace(ws)
  return copy
}

export function deleteDashboard(folderId, dashboardId) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const idx = folder.dashboards.findIndex((d) => d.id === dashboardId)
  if (idx === -1) throw new Error('Dashboard não encontrada.')
  const [removed] = folder.dashboards.splice(idx, 1)
  saveWorkspace(ws)
  return removed
}

// Duas pessoas tentando gravar a mesma guia — a rota responde 409 com a
// mensagem (ver server/index.mjs). `lock` = quem está editando agora, quando
// o motivo é o bloqueio de edição (server/tabLocks.mjs).
export class TabConflictError extends Error {
  constructor(message, lock = null) {
    super(message)
    this.name = 'TabConflictError'
    this.status = 409
    this.lock = lock
  }
}

// Sem permissão para a mudança pedida — a rota responde 403 com a mensagem.
export class WorkspaceAccessError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WorkspaceAccessError'
    this.status = 403
  }
}

// ─── Medidas da dashboard (a "tabela de medidas", ver MeasureDef) ─────────
// Medidas nomeadas que um widget usa (measureRef) — e as que uma fórmula usa.
function widgetMeasureRefs(widget) {
  return [widget.measure, ...(widget.measures ?? []), ...(widget.measuresLine ?? []), widget.measureX, widget.matrixValue]
    .map((m) => m?.measureRef)
    .filter(Boolean)
}

function referencedMeasureIds(dashboard) {
  const ids = new Set()
  for (const tab of dashboard.tabs) for (const w of tab.widgets ?? []) for (const id of widgetMeasureRefs(w)) ids.add(id)
  for (const m of dashboard.measures ?? []) if (m.kind === 'formula') for (const id of Object.values(m.refs ?? {})) ids.add(id)
  return ids
}

function isMeasureDef(m) {
  return !!m && typeof m === 'object' && typeof m.id === 'string' && !!m.id && typeof m.name === 'string'
    && (m.kind === 'simple' || m.kind === 'formula')
}

// Muda as medidas UMA A UMA, por id — nunca troca a lista inteira. Com a lista
// inteira, quem salvava por último apagava a medida que outra pessoa tinha
// criado nesse meio-tempo (e o widget dela ficava "Medida não encontrada").
// Mantém a ordem: a medida alterada fica onde estava, a nova vai pro fim.
function mergeMeasures(current, { upsert = [], remove = [] } = {}) {
  const removed = new Set(remove.map(String))
  const byId = new Map(current.filter((m) => !removed.has(m.id)).map((m) => [m.id, m]))
  for (const m of upsert) byId.set(m.id, m)
  return [...byId.values()]
}

// Grava mudanças nas medidas sem passar pelo salvar da dashboard inteira — é
// o que a IA usa ao criar ou ajustar uma medida (ela entra salva na hora).
// Quem gerencia a pasta muda qualquer medida. Quem só edita alguma guia desta
// dashboard pode CRIAR medida nova e remover uma que nenhum widget usa (o
// "Desfazer" do que a IA criou), mas não alterar uma que já existe — as
// medidas valem pra dashboard inteira, inclusive pras guias dos outros.
export function saveDashboardMeasures(folderId, dashboardId, { upsert, remove } = {}, actorEmail) {
  const up = Array.isArray(upsert) ? upsert : []
  const rm = Array.isArray(remove) ? remove.map(String) : []
  for (const m of up) {
    if (!isMeasureDef(m)) throw new Error(`Medida inválida: ${JSON.stringify(m?.id ?? m)}`)
  }
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = requireDashboard(folder, dashboardId)
  const current = dashboard.measures ?? []
  if (!canManageFolder(folder, actorEmail)) {
    if (!dashboard.tabs.some((t) => canEditTabWidgets(folder, t, actorEmail))) {
      throw new WorkspaceAccessError('Você não tem edição liberada em nenhuma guia desta dashboard.')
    }
    const existing = new Set(current.map((m) => m.id))
    const changing = up.find((m) => existing.has(m.id))
    if (changing) {
      throw new WorkspaceAccessError(`Só o gerente da pasta ou um administrador altera uma medida que já existe ("${changing.name}").`)
    }
    const used = referencedMeasureIds(dashboard)
    const inUse = rm.find((id) => used.has(id))
    if (inUse) {
      const name = current.find((m) => m.id === inUse)?.name ?? inUse
      throw new WorkspaceAccessError(`A medida "${name}" está em uso — só o gerente da pasta ou um administrador remove.`)
    }
  }
  dashboard.measures = mergeMeasures(current, { upsert: up, remove: rm })
  dashboard.updatedBy = actorEmail
  dashboard.updatedAt = nowIso()
  saveWorkspace(ws)
  return dashboard.measures
}

// Página aberta com uma versão antiga do app tentando salvar — a rota responde
// 409 (`code: 'client_outdated'`) e a página pede pra recarregar. Era o buraco
// invisível: uma aba do navegador aberta desde antes de um redeploy seguia
// salvando do jeito antigo (a lista inteira de guias, a lista inteira de
// medidas) e apagava, sem aviso nenhum, o que outras pessoas tinham gravado.
export class OutdatedClientError extends Error {
  constructor() {
    super('Esta página está numa versão antiga do app e o que você mudou NÃO foi salvo. Recarregue a página (F5) e refaça a alteração.')
    this.name = 'OutdatedClientError'
    this.status = 409
    this.code = 'client_outdated'
  }
}

// Conteúdo de uma guia pra comparar duas versões dela. Fora da comparação:
// `canEdit` (anotação de permissão de quem leu), `rev` (o contador em si),
// `access` (só muda pela rota própria, ver setTabAccess) e quem/quando gravou
// por último (ver stampTab).
function tabContent(tab) {
  const { canEdit: _canEdit, rev: _rev, access: _access, updatedBy: _by, updatedByName: _name, updatedAt: _at, ...content } = tab
  return JSON.stringify(content)
}

// Quem gravou a guia por último, e quando — a tela mostra no modo edição. É o
// que torna visível um "meu trabalho sumiu": dá pra ver que outra pessoa salvou
// a guia depois.
function stampTab(tab, actor) {
  tab.updatedBy = actor.email
  tab.updatedByName = actor.name || actor.email
  tab.updatedAt = nowIso()
}

// Cada gravação que muda o conteúdo de uma guia sobe o `rev` dela. É como uma
// tela sabe que a cópia que ela tem ficou velha: quem salva manda o `rev` que
// leu, e se outra pessoa gravou a guia nesse meio-tempo, os dois não batem.
function nextRev(tab) {
  return (Number(tab?.rev) || 0) + 1
}

// Salva a dashboard (guias/filtros/canvas/widgets) — usado por quem gerencia
// a dashboard inteira. As medidas (a "tabela de medidas", ver MeasureDef em
// types.ts) vão em `opts.measureChanges` — { upsert, remove }, só as que esta
// tela mudou, aplicadas uma a uma (mergeMeasures). `measures` (a lista
// inteira, que substitui tudo) fica só pra página de uma versão anterior:
// `[]` explícito apaga todas, `undefined` preserva o que já estava salvo.
//
// Grava GUIA POR GUIA, não a lista inteira de uma vez. Antes, salvar
// substituía todas as guias pela cópia que a tela tinha — e um gerente que
// abriu a dashboard às 9h apagava, ao salvar às 10h, o que um supervisor
// gravou na guia dele às 9h30. Agora (opts):
//   - changedTabIds: as guias que esta tela mudou. Só elas são gravadas; as
//     outras ficam com a versão do servidor, que pode ser mais nova;
//   - removedTabIds: as guias que esta tela removeu. Uma guia que existe no
//     servidor e não veio na lista (criada por outra pessoa depois que esta
//     tela abriu) continua, no fim;
//   - lockedByOther(tabId): bloqueio de edição de outra pessoa (ver
//     server/tabLocks.mjs). Mudar ou remover uma guia bloqueada é recusado.
// Uma guia mudada cujo `rev` não bate com o do servidor também é recusada:
// alguém a gravou depois que esta tela leu.
//
// Sem `changedTabIds` — ou com a lista inteira de medidas em vez de
// `measureChanges` —, quem chama é uma página de uma versão antiga do app:
// recusado (OutdatedClientError), nunca mais "adivinhado".
// `opts.actorName`: nome de quem salva, gravado em cada guia mudada.
export function saveDashboardFull(folderId, dashboardId, tabs, actorEmail, measures, opts = {}) {
  if (!Array.isArray(opts.changedTabIds) || (Array.isArray(measures) && !opts.measureChanges)) throw new OutdatedClientError()
  if (!Array.isArray(tabs)) throw new Error('Config inválida: "tabs" (array) é obrigatório.')
  for (const tab of tabs) {
    if (!tab.id || !tab.label || !Array.isArray(tab.widgets)) {
      throw new Error(`Guia inválida: ${JSON.stringify(tab?.id ?? tab)}`)
    }
  }
  const lockedByOther = opts.lockedByOther ?? (() => null)
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = requireDashboard(folder, dashboardId)
  const serverById = new Map(dashboard.tabs.map((t) => [t.id, t]))
  const clientIds = new Set(tabs.map((t) => t.id))

  const changed = new Set(opts.changedTabIds.map(String).filter((id) => clientIds.has(id)))
  const removed = new Set((Array.isArray(opts.removedTabIds) ? opts.removedTabIds.map(String) : [])
    .filter((id) => serverById.has(id) && !clientIds.has(id)))

  for (const id of [...changed, ...removed]) {
    const server = serverById.get(id)
    if (!server) continue
    const lock = lockedByOther(id)
    if (lock) {
      throw new TabConflictError(
        lock.self
          ? `A guia "${server.label}" está aberta para edição por você em outra janela. Salve ou descarte por lá antes.`
          : `A guia "${server.label}" está sendo editada por ${lock.name} agora. Descarte o que mudou nela ou espere ${lock.name} terminar.`,
        lock,
      )
    }
  }
  for (const t of tabs) {
    const server = serverById.get(t.id)
    if (server && changed.has(t.id) && (Number(t.rev) || 0) !== (Number(server.rev) || 0)) {
      throw new TabConflictError(`A guia "${server.label}" foi salva por ${server.updatedByName || 'outra pessoa'} depois que você abriu a dashboard. Descarte e abra de novo para editar a versão atual.`)
    }
  }

  const next = []
  for (const t of tabs) {
    const server = serverById.get(t.id)
    if (!changed.has(t.id)) {
      // Não mexida: fica a versão do servidor. Se ela nem existe mais, outra
      // pessoa removeu a guia enquanto esta tela estava aberta — e continua
      // removida.
      if (server) next.push(server)
      continue
    }
    const { canEdit: _canEdit, ...stored } = t
    // Acesso e "boas-vindas" de uma guia que já existe são do servidor: o
    // acesso só muda pela rota própria (setTabAccess), e boas-vindas não se
    // cria nem se desfaz por aqui.
    if (server) {
      if (server.access === undefined) delete stored.access
      else stored.access = server.access
    }
    if (server?.isWelcome) stored.isWelcome = true
    else delete stored.isWelcome
    stored.rev = nextRev(server)
    stampTab(stored, { email: actorEmail, name: opts.actorName })
    next.push(stored)
  }
  for (const server of dashboard.tabs) {
    if (!clientIds.has(server.id) && !removed.has(server.id)) next.push(server)
  }

  const hadWelcome = dashboard.tabs.some((t) => t.isWelcome)
  if (hadWelcome && !next.some((t) => t.isWelcome)) throw new Error('A guia de boas-vindas não pode ser removida.')
  dashboard.tabs = next
  if (opts.measureChanges) dashboard.measures = mergeMeasures(dashboard.measures ?? [], {
    upsert: (Array.isArray(opts.measureChanges.upsert) ? opts.measureChanges.upsert : []).filter(isMeasureDef),
    remove: Array.isArray(opts.measureChanges.remove) ? opts.measureChanges.remove : [],
  })
  dashboard.updatedBy = actorEmail
  dashboard.updatedAt = nowIso()
  saveWorkspace(ws)
  return dashboard
}

// Salva só os widgets de UMA guia — usado por um usuário padrão com edição
// liberada ali, que não deve poder mexer na estrutura da dashboard.
// `baseRev` = o `rev` da guia quando a tela a leu (ver saveDashboardFull);
// ausente = página de uma versão antiga do app, recusada (OutdatedClientError).
export function saveTabWidgets(folderId, dashboardId, tabId, widgets, actorEmail, { baseRev, actorName } = {}) {
  if (!Array.isArray(widgets)) throw new Error('Lista de widgets inválida.')
  if (baseRev === undefined || baseRev === null) throw new OutdatedClientError()
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = requireDashboard(folder, dashboardId)
  const tab = findTab(dashboard, tabId)
  if (!tab) throw new Error('Guia não encontrada.')
  if ((Number(baseRev) || 0) !== (Number(tab.rev) || 0)) {
    throw new TabConflictError(`A guia "${tab.label}" foi salva por ${tab.updatedByName || 'outra pessoa'} depois que você abriu a dashboard. Descarte e abra de novo para editar a versão atual.`)
  }
  tab.widgets = widgets
  tab.rev = nextRev(tab)
  stampTab(tab, { email: actorEmail, name: actorName })
  dashboard.updatedBy = actorEmail
  dashboard.updatedAt = nowIso()
  saveWorkspace(ws)
  return tab
}

// Versão (`rev`) de cada guia que `email` pode ver — o Builder confere de
// tempos em tempos pra trazer a versão nova de uma guia que outra pessoa
// salvou, sem precisar de F5.
export function getTabRevsForUser(folderId, dashboardId, email) {
  const ws = loadWorkspace()
  const folder = findFolder(ws, folderId)
  const dashboard = folder && findDashboard(folder, dashboardId)
  if (!dashboard) return null
  const revs = {}
  for (const t of dashboard.tabs) {
    if (canViewTab(folder, t, email)) revs[t.id] = Number(t.rev) || 0
  }
  return revs
}

// O que a tela confere a cada 15 s (junto dos bloqueios): a versão de cada
// guia que `email` vê — e as PERMISSÕES dele agora. Permissão mudou (virou
// gerente, ganhou ou perdeu edição numa guia, uma guia foi liberada), a tela
// se atualiza sozinha; antes ficava com a permissão de quando abriu até um F5,
// e o gerente recém-nomeado seguia sem poder editar — sem nada que dissesse
// por quê.
export function getDashboardPulse(folderId, dashboardId, email) {
  const ws = loadWorkspace()
  const folder = findFolder(ws, folderId)
  const dashboard = folder && findDashboard(folder, dashboardId)
  if (!dashboard) return null
  const revs = {}
  const editable = []
  for (const t of dashboard.tabs) {
    if (!canViewTab(folder, t, email)) continue
    revs[t.id] = Number(t.rev) || 0
    if (canEditTabWidgets(folder, t, email)) editable.push(t.id)
  }
  return { revs, editable, canManage: canManageFolder(folder, email) }
}

// Guia pronta pra mandar pro navegador (com `canEdit`), ou null — usada ao
// pegar o bloqueio, pra tela começar a editar a partir da versão atual.
export function getTabForUser(folderId, dashboardId, tabId, email) {
  const ws = loadWorkspace()
  const folder = findFolder(ws, folderId)
  const dashboard = folder && findDashboard(folder, dashboardId)
  const tab = dashboard && findTab(dashboard, tabId)
  if (!tab || !canViewTab(folder, tab, email)) return null
  return { ...tab, canEdit: canEditTabWidgets(folder, tab, email) }
}

// Define quem vê/edita uma guia. Só aceita e-mails que já têm acesso à
// pasta — liberar a pasta é sempre um passo do admin, separado disto.
export function setTabAccess(folderId, dashboardId, tabId, { mode, view, edit }, actorEmail) {
  if (mode !== 'open' && mode !== 'restricted') throw new Error('Modo inválido — use "open" ou "restricted".')
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = requireDashboard(folder, dashboardId)
  const tab = findTab(dashboard, tabId)
  if (!tab) throw new Error('Guia não encontrada.')
  if (tab.isWelcome && mode !== 'open') throw new Error('A guia de boas-vindas precisa continuar aberta.')
  const viewList = normalizeEmails(view)
  const editList = normalizeEmails(edit)
  const members = new Set(listFolderMembers(folderId).map((m) => m.email))
  for (const email of new Set([...viewList, ...editList])) {
    if (!members.has(email)) throw new Error(`"${email}" não tem acesso a esta pasta — libere o acesso à pasta antes de liberar a guia.`)
  }
  tab.access = { mode, view: viewList, edit: editList }
  dashboard.updatedBy = actorEmail
  dashboard.updatedAt = nowIso()
  saveWorkspace(ws)
  return tab
}

// Em quais pastas (e dashboards) uma query do catálogo já está sendo usada
// de fato por algum widget — varre TODAS as pastas/dashboards/guias/widgets,
// independente do `folderIds` atual da query (um widget continua funcionando
// mesmo que a pasta seja removida da liberação depois, ver
// setLakehouseFolders em lakehouseSources.mjs). Usado pra avisar o admin antes de remover uma pasta
// que já tem widgets dependendo dessa query — ver PUT .../queries/:id/folders.
export function findFoldersUsingQuery(queryId) {
  const ws = loadWorkspace()
  const usesQuery = (widget) => widget.source === queryId || (widget.lookups ?? []).some((l) => l.source === queryId)
  const result = []
  for (const folder of ws.folders) {
    const dashboardNames = []
    for (const dashboard of folder.dashboards) {
      const used = dashboard.tabs.some((tab) => tab.widgets.some(usesQuery))
      if (used) dashboardNames.push(dashboard.name)
    }
    if (dashboardNames.length > 0) result.push({ folderId: folder.id, folderName: folder.name, dashboardNames })
  }
  return result
}
