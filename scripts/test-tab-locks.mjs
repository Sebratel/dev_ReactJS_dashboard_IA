// Teste do bloqueio de edição por guia (server/tabLocks.mjs) e da gravação
// guia por guia (saveDashboardFull/saveTabWidgets em server/workspace.mjs).
// Roda com: npm run test:locks
//
// O que ele prova:
// - o bloqueio é da guia, não da dashboard: duas pessoas editam guias
//   diferentes da mesma dashboard ao mesmo tempo, mas não a mesma guia;
// - a mesma pessoa numa janela nova assume o bloqueio da janela antiga, e a
//   antiga não o toma de volta na renovação; só a dona solta; vence sozinho;
// - salvar a dashboard grava só as guias que a tela mudou: o que um
//   supervisor salvou na guia dele continua lá depois que o gerente salva a
//   dashboard com a cópia que abriu antes (o problema de antes);
// - mudar ou remover uma guia que outra pessoa está editando é recusado, e
//   uma cópia desatualizada (rev) também;
// - guia criada por outra pessoa enquanto a tela estava aberta não some, e
//   guia removida por outra pessoa não volta.
//
// Não toca em data/: o workspace vai para uma pasta temporária, os e-mails são
// fictícios e não há rede.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'ind-bloqueio-teste-'))
process.env.ACCESS_USERS_PATH = join(dir, 'users.json')
process.env.ACCESS_LOG_PATH = join(dir, 'audit-log.json')
process.env.WORKSPACE_PATH = join(dir, 'workspace.json')
process.env.DASHBOARD_CONFIG_PATH = join(dir, 'dashboard-config.json')
process.env.ADMIN_EMAILS = 'gerente@exemplo.test'
// Prazo curto, pra conferir o vencimento sem esperar 2 minutos.
process.env.TAB_LOCK_TTL_SECONDS = '1'

const AQUI = dirname(fileURLToPath(import.meta.url))
const mod = (n) => pathToFileURL(resolvePath(AQUI, '..', 'server', n)).href
const { touchUser } = await import(mod('accessLog.mjs'))
const {
  createFolder, createDashboard, saveDashboardFull, saveTabWidgets, setTabAccess, grantFolderAccess,
  getDashboardForUser, getTabRevsForUser, TabConflictError,
} = await import(mod('workspace.mjs'))
const { acquireTabLock, releaseTabLock, blockingTabLock, listTabLocks, normalizeClientId, clearTabLocks } = await import(mod('tabLocks.mjs'))

let falhas = 0
let total = 0
function confere(desc, ok, detalhe = '') {
  total += 1
  if (ok) console.log(`  PASS  ${desc}`)
  else { falhas += 1; console.log(`  FALHA ${desc}${detalhe ? ` — ${detalhe}` : ''}`) }
}
function erroDe(fn) {
  try { fn(); return null } catch (e) { return e }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

const GERENTE = { email: 'gerente@exemplo.test', name: 'Gerente Exemplo' }
const ANA = { email: 'ana@exemplo.test', name: 'Ana Exemplo' }
const BRUNO = { email: 'bruno@exemplo.test', name: 'Bruno Exemplo' }
const janela = (who, n) => ({ ...who, clientId: `janela-${who.email.split('@')[0]}-${n}` })
for (const u of [GERENTE, ANA, BRUNO]) touchUser(u.email, u.name)

console.log('\n── Bloqueio por guia (em memória) ──')
const F = 'pasta-1'; const D = 'dash-1'
const gerente1 = janela(GERENTE, 1)
const ana1 = janela(ANA, 1)
const ana2 = janela(ANA, 2)
confere('clientId válido passa', normalizeClientId('janela-abc-123') === 'janela-abc-123')
confere('clientId com caractere estranho é recusado', normalizeClientId('a/b"c;d e') === null)
confere('clientId curto demais é recusado', normalizeClientId('abc') === null)

let r = acquireTabLock(F, D, 'guia-ana', ana1)
confere('guia livre: Ana pega', r.ok && r.lock.mine && r.lock.name === 'Ana Exemplo')
r = acquireTabLock(F, D, 'guia-bruno', janela(BRUNO, 1))
confere('outra guia da mesma dashboard: Bruno pega ao mesmo tempo', r.ok)
r = acquireTabLock(F, D, 'guia-ana', gerente1)
confere('a guia da Ana: o gerente é recusado', !r.ok && r.lock.name === 'Ana Exemplo' && !r.lock.self && !r.lock.mine)
r = acquireTabLock(F, D, 'guia-ana', ana1, { renew: true })
confere('Ana renova na mesma janela', r.ok)
r = acquireTabLock(F, D, 'guia-ana', ana2, { renew: true })
confere('outra janela da Ana não toma na renovação', !r.ok && r.lock.self)
r = acquireTabLock(F, D, 'guia-ana', ana2)
confere('outra janela da Ana assume num pedido novo', r.ok && r.lock.mine)
r = acquireTabLock(F, D, 'guia-ana', ana1, { renew: true })
confere('a janela antiga perde e não toma de volta', !r.ok && r.lock.self && !r.lock.mine)
confere('blockingTabLock: gerente bloqueado', blockingTabLock(F, D, 'guia-ana', gerente1)?.name === 'Ana Exemplo')
confere('blockingTabLock: janela dona livre', blockingTabLock(F, D, 'guia-ana', ana2) === null)
confere('blockingTabLock: janela antiga da Ana bloqueada', !!blockingTabLock(F, D, 'guia-ana', ana1))
confere('blockingTabLock sem clientId compara só o e-mail', blockingTabLock(F, D, 'guia-ana', { email: ANA.email }) === null)
const lista = listTabLocks(F, D, gerente1)
confere('listTabLocks traz as duas guias', Object.keys(lista).sort().join(',') === 'guia-ana,guia-bruno', Object.keys(lista).join(','))
confere('listTabLocks não expõe o clientId', !JSON.stringify(lista).includes('janela-'))
confere('listTabLocks de outra dashboard vem vazio', Object.keys(listTabLocks(F, 'outra', gerente1)).length === 0)
confere('soltar: o gerente não solta o da Ana', releaseTabLock(F, D, 'guia-ana', gerente1) === false && !!blockingTabLock(F, D, 'guia-ana', gerente1))
confere('soltar: a janela dona solta', releaseTabLock(F, D, 'guia-ana', ana2) === true && blockingTabLock(F, D, 'guia-ana', gerente1) === null)
r = acquireTabLock(F, D, 'guia-ana', gerente1)
confere('guia solta: o gerente pega', r.ok)
await espera(1200)
confere('o bloqueio vence sozinho (sem renovação)', blockingTabLock(F, D, 'guia-ana', ana1) === null && Object.keys(listTabLocks(F, D, gerente1)).length === 0)
clearTabLocks()

console.log('\n── Gravação guia por guia ──')
const pasta = createFolder({ name: 'Pasta de teste' }, GERENTE.email)
grantFolderAccess(pasta.id, ANA.email, GERENTE.email)
const dash = createDashboard(pasta.id, { name: 'Dashboard de teste' }, GERENTE.email)
const leitura = (who) => getDashboardForUser(pasta.id, dash.id, who.email).dashboard
const texto = (id, text) => ({ id, type: 'text', title: text, text, layout: { x: 0, y: 0, w: 6, h: 4 } })
const guiaNova = (id, label) => ({ id, label, filters: [], widgets: [], access: { mode: 'restricted', view: [], edit: [] }, canEdit: true })

// Gerente monta duas guias, uma pra cada supervisor.
let copia = leitura(GERENTE).tabs
saveDashboardFull(pasta.id, dash.id, [...copia, guiaNova('g-ana', 'Ana'), guiaNova('g-bruno', 'Bruno')], GERENTE.email, undefined, {
  changedTabIds: ['g-ana', 'g-bruno'], removedTabIds: [],
})
setTabAccess(pasta.id, dash.id, 'g-ana', { mode: 'restricted', view: [], edit: [ANA.email] }, GERENTE.email)
let tabs = leitura(GERENTE).tabs
confere('guias novas gravadas com rev 1', tabs.find((t) => t.id === 'g-ana')?.rev === 1 && tabs.find((t) => t.id === 'g-bruno')?.rev === 1)
const gravadas = JSON.parse(readFileSync(process.env.WORKSPACE_PATH, 'utf8')).folders.flatMap((f) => f.dashboards).flatMap((d) => d.tabs)
confere('canEdit (anotação de quem leu) não vai pro arquivo', gravadas.length > 0 && gravadas.every((t) => !('canEdit' in t)))

// O gerente abre a dashboard (cópia de agora)...
const copiaGerente = leitura(GERENTE)
// ...a Ana salva a guia dela...
const salvaAna = saveTabWidgets(pasta.id, dash.id, 'g-ana', [texto('w-ana', 'da Ana')], ANA.email, { baseRev: 1 })
confere('Ana salva a guia dela: rev sobe', salvaAna.rev === 2)
// ...e o gerente salva a dashboard com a cópia de antes, mexendo só na do Bruno.
const tabsGerente = copiaGerente.tabs.map((t) => (t.id === 'g-bruno' ? { ...t, widgets: [texto('w-bruno', 'do gerente')] } : t))
saveDashboardFull(pasta.id, dash.id, tabsGerente, GERENTE.email, undefined, { changedTabIds: ['g-bruno'], removedTabIds: [] })
tabs = leitura(GERENTE).tabs
confere('o que a Ana salvou continua lá (o problema de antes)', tabs.find((t) => t.id === 'g-ana')?.widgets[0]?.id === 'w-ana')
confere('a mudança do gerente na guia do Bruno entrou', tabs.find((t) => t.id === 'g-bruno')?.widgets[0]?.id === 'w-bruno')

// Cópia desatualizada: o gerente tenta mudar a guia da Ana com o rev antigo.
let e = erroDe(() => saveDashboardFull(pasta.id, dash.id,
  copiaGerente.tabs.map((t) => (t.id === 'g-ana' ? { ...t, label: 'Ana (renomeada)' } : t)), GERENTE.email, undefined,
  { changedTabIds: ['g-ana'], removedTabIds: [] }))
confere('mudar guia com rev velho: recusado (409)', e instanceof TabConflictError && e.status === 409 && /salva por outra pessoa/.test(e.message), e?.message)
e = erroDe(() => saveTabWidgets(pasta.id, dash.id, 'g-ana', [], ANA.email, { baseRev: 1 }))
confere('saveTabWidgets com rev velho: recusado (409)', e instanceof TabConflictError, e?.message)

// Bloqueio: a Ana está editando a guia dela.
const bloqueioAna = (tid) => (tid === 'g-ana' ? { name: 'Ana Exemplo', self: false } : null)
let atual = leitura(GERENTE)
e = erroDe(() => saveDashboardFull(pasta.id, dash.id,
  atual.tabs.map((t) => (t.id === 'g-ana' ? { ...t, label: 'Outro nome' } : t)), GERENTE.email, undefined,
  { changedTabIds: ['g-ana'], removedTabIds: [], lockedByOther: bloqueioAna }))
confere('mudar guia bloqueada por outra pessoa: recusado com o nome', e instanceof TabConflictError && /Ana Exemplo/.test(e.message), e?.message)
e = erroDe(() => saveDashboardFull(pasta.id, dash.id, atual.tabs.filter((t) => t.id !== 'g-ana'), GERENTE.email, undefined,
  { changedTabIds: [], removedTabIds: ['g-ana'], lockedByOther: bloqueioAna }))
confere('remover guia bloqueada: recusado', e instanceof TabConflictError, e?.message)
e = erroDe(() => saveDashboardFull(pasta.id, dash.id,
  atual.tabs.map((t) => (t.id === 'g-bruno' ? { ...t, widgets: [] } : t)), GERENTE.email, undefined,
  { changedTabIds: ['g-bruno'], removedTabIds: [], lockedByOther: bloqueioAna }))
confere('mudar OUTRA guia com a da Ana bloqueada: passa', e === null, e?.message)
const reordenada = [...leitura(GERENTE).tabs].reverse()
e = erroDe(() => saveDashboardFull(pasta.id, dash.id, reordenada, GERENTE.email, undefined,
  { changedTabIds: [], removedTabIds: [], lockedByOther: bloqueioAna }))
confere('reordenar as guias com uma bloqueada: passa', e === null && leitura(GERENTE).tabs[0].id === reordenada[0].id, e?.message)

// Acesso e boas-vindas de guia existente ficam com o servidor.
atual = leitura(GERENTE)
saveDashboardFull(pasta.id, dash.id,
  atual.tabs.map((t) => (t.id === 'g-ana' ? { ...t, label: 'Ana', access: { mode: 'open', view: [], edit: [] } } : t)), GERENTE.email, undefined,
  { changedTabIds: ['g-ana'], removedTabIds: [] })
const guiaAna = leitura(GERENTE).tabs.find((t) => t.id === 'g-ana')
confere('acesso de guia existente não muda pelo salvar', guiaAna.access.mode === 'restricted' && guiaAna.access.edit.includes(ANA.email), JSON.stringify(guiaAna.access))

// Outra pessoa cria uma guia depois que esta tela abriu: ela não some.
const copiaVelha = leitura(GERENTE)
saveDashboardFull(pasta.id, dash.id, [...copiaVelha.tabs, guiaNova('g-outro', 'Criada por outro')], GERENTE.email, undefined,
  { changedTabIds: ['g-outro'], removedTabIds: [] })
saveDashboardFull(pasta.id, dash.id, copiaVelha.tabs, GERENTE.email, undefined, { changedTabIds: [], removedTabIds: [] })
confere('guia criada por outra pessoa nesse meio-tempo continua', leitura(GERENTE).tabs.some((t) => t.id === 'g-outro'))

// Outra pessoa remove uma guia: a cópia velha (sem mexer nela) não a ressuscita.
const comOutro = leitura(GERENTE)
saveDashboardFull(pasta.id, dash.id, comOutro.tabs.filter((t) => t.id !== 'g-outro'), GERENTE.email, undefined,
  { changedTabIds: [], removedTabIds: ['g-outro'] })
saveDashboardFull(pasta.id, dash.id, comOutro.tabs, GERENTE.email, undefined, { changedTabIds: [], removedTabIds: [] })
confere('guia removida por outra pessoa não volta', !leitura(GERENTE).tabs.some((t) => t.id === 'g-outro'))

// Boas-vindas.
atual = leitura(GERENTE)
e = erroDe(() => saveDashboardFull(pasta.id, dash.id, atual.tabs.filter((t) => !t.isWelcome), GERENTE.email, undefined,
  { changedTabIds: [], removedTabIds: atual.tabs.filter((t) => t.isWelcome).map((t) => t.id) }))
confere('remover a guia de boas-vindas continua proibido', /boas-vindas/.test(e?.message ?? ''), e?.message)
saveDashboardFull(pasta.id, dash.id, [...atual.tabs, { ...guiaNova('g-falsa', 'Falsa'), isWelcome: true }], GERENTE.email, undefined,
  { changedTabIds: ['g-falsa'], removedTabIds: [] })
confere('guia nova não vira boas-vindas pelo salvar', leitura(GERENTE).tabs.filter((t) => t.isWelcome).length === 1)

// Página de uma versão anterior (sem changedTabIds): compara o conteúdo.
atual = leitura(GERENTE)
e = erroDe(() => saveDashboardFull(pasta.id, dash.id,
  atual.tabs.map((t) => (t.id === 'g-ana' ? { ...t, widgets: [] } : t)), GERENTE.email, undefined, { lockedByOther: bloqueioAna }))
confere('versão anterior da página: mudar guia bloqueada é recusado', e instanceof TabConflictError, e?.message)
e = erroDe(() => saveDashboardFull(pasta.id, dash.id,
  atual.tabs.map((t) => (t.id === 'g-bruno' ? { ...t, label: 'Bruno 2' } : t)), GERENTE.email, undefined, { lockedByOther: bloqueioAna }))
confere('versão anterior da página: mudar outra guia passa', e === null && leitura(GERENTE).tabs.find((t) => t.id === 'g-bruno')?.label === 'Bruno 2', e?.message)

// Versões que a tela consulta.
const revs = getTabRevsForUser(pasta.id, dash.id, ANA.email)
const visiveisAna = leitura(ANA).tabs.map((t) => t.id).sort().join(',')
confere('getTabRevsForUser só traz as guias que a pessoa vê', Object.keys(revs).sort().join(',') === visiveisAna, `${Object.keys(revs)} vs ${visiveisAna}`)
confere('getTabRevsForUser traz o rev atual', revs['g-ana'] === leitura(ANA).tabs.find((t) => t.id === 'g-ana').rev)

rmSync(dir, { recursive: true, force: true })
console.log(`\n${total - falhas}/${total} conferências passaram${falhas ? ` — ${falhas} FALHA(S)` : ''}`)
process.exit(falhas ? 1 : 0)
