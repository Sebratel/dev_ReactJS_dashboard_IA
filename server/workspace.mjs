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

export function deleteDashboard(folderId, dashboardId) {
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const idx = folder.dashboards.findIndex((d) => d.id === dashboardId)
  if (idx === -1) throw new Error('Dashboard não encontrada.')
  const [removed] = folder.dashboards.splice(idx, 1)
  saveWorkspace(ws)
  return removed
}

// Salva a dashboard inteira (guias/filtros/canvas/widgets) — equivalente ao
// antigo saveDashboardConfig, usado por quem gerencia a dashboard inteira.
// `measures` (a "tabela de medidas" da dashboard, ver MeasureDef em
// types.ts) é opcional pra manter compatibilidade com uma chamada antiga
// que não a envie — só substitui quando vem como array de verdade (mesmo
// truque de sempre: `[]` explícito apaga todas de propósito, `undefined`
// preserva o que já estava salvo).
export function saveDashboardFull(folderId, dashboardId, tabs, actorEmail, measures) {
  if (!Array.isArray(tabs)) throw new Error('Config inválida: "tabs" (array) é obrigatório.')
  for (const tab of tabs) {
    if (!tab.id || !tab.label || !Array.isArray(tab.widgets)) {
      throw new Error(`Guia inválida: ${JSON.stringify(tab?.id ?? tab)}`)
    }
  }
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = requireDashboard(folder, dashboardId)
  const hadWelcome = dashboard.tabs.some((t) => t.isWelcome)
  if (hadWelcome && !tabs.some((t) => t.isWelcome)) throw new Error('A guia de boas-vindas não pode ser removida.')
  dashboard.tabs = tabs
  if (Array.isArray(measures)) dashboard.measures = measures
  dashboard.updatedBy = actorEmail
  dashboard.updatedAt = nowIso()
  saveWorkspace(ws)
  return dashboard
}

// Salva só os widgets de UMA guia — usado por um usuário padrão com edição
// liberada ali, que não deve poder mexer na estrutura da dashboard.
export function saveTabWidgets(folderId, dashboardId, tabId, widgets, actorEmail) {
  if (!Array.isArray(widgets)) throw new Error('Lista de widgets inválida.')
  const ws = loadWorkspace()
  const folder = requireFolder(ws, folderId)
  const dashboard = requireDashboard(folder, dashboardId)
  const tab = findTab(dashboard, tabId)
  if (!tab) throw new Error('Guia não encontrada.')
  tab.widgets = widgets
  dashboard.updatedBy = actorEmail
  dashboard.updatedAt = nowIso()
  saveWorkspace(ws)
  return tab
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
