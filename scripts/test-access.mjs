// Teste de quem entra e do que pode pedir (server/accessLog.mjs,
// server/accessRequests.mjs e a liberação de pasta em server/workspace.mjs).
// Roda com: npm run test:access
//
// O que ele prova:
// - quem acessa pela primeira vez entra como Padrão (`standard`), mesmo estando
//   em ADMIN_EMAILS, desde que a instalação já tenha um administrador salvo. A
//   lista só vale enquanto não existe nenhum admin (instalação nova, ou
//   data/users.json perdido) — é o que impede o sistema de nascer sem ninguém
//   capaz de liberar acesso;
// - o primeiro acesso fica marcado até o manual de uso ser aberto;
// - o pedido de acesso a uma pasta: um pendente por vez, decisão única, e
//   liberar põe o e-mail na lista de acesso da pasta.
//
// Não toca em data/: users.json, log de auditoria, pedidos e workspace vão para
// uma pasta temporária, e os e-mails são fictícios.
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ind-acessos-teste-'))
process.env.ACCESS_USERS_PATH = join(dir, 'users.json')
process.env.ACCESS_LOG_PATH = join(dir, 'audit-log.json')
process.env.ACCESS_REQUESTS_PATH = join(dir, 'accessRequests.json')
process.env.WORKSPACE_PATH = join(dir, 'workspace.json')
// Config legada que workspace.mjs procura na 1ª carga — inexistente de propósito.
process.env.DASHBOARD_CONFIG_PATH = join(dir, 'dashboard-config.json')
// Lida na importação do módulo — precisa estar definida antes do import.
process.env.ADMIN_EMAILS = 'lista.um@exemplo.test, lista.dois@exemplo.test, lista.tres@exemplo.test'

const AQUI = dirname(fileURLToPath(import.meta.url))
const mod = (n) => pathToFileURL(resolvePath(AQUI, '..', 'server', n)).href
const { touchUser, isAdmin, listUsers, setUserRole, isManualPending, markManualSeen } = await import(mod('accessLog.mjs'))
const { createRequest, decideRequest, latestRequestsByFolder, listRequests } = await import(mod('accessRequests.mjs'))
const { createFolder, setFolderAccess, grantFolderAccess, listFolderCatalogForUser } = await import(mod('workspace.mjs'))

let falhas = 0
let total = 0

function confere(desc, ok, detalhe = '') {
  total += 1
  if (ok) console.log(`  PASS  ${desc}`)
  else { falhas += 1; console.log(`  FALHA ${desc}${detalhe ? ` — ${detalhe}` : ''}`) }
}

const papel = (email) => listUsers().find((u) => u.email === email)?.role ?? '(sem registro)'

function erroDe(fn) {
  try { fn(); return null } catch (e) { return e.message }
}

console.log('\n── Instalação nova (nenhum admin salvo) ──')
touchUser('fora.da.lista@exemplo.test', 'Fora da Lista')
confere('quem não está na lista entra como Padrão', papel('fora.da.lista@exemplo.test') === 'standard', papel('fora.da.lista@exemplo.test'))
touchUser('lista.um@exemplo.test', 'Lista Um')
confere('o primeiro da lista entra como admin (bootstrap)', papel('lista.um@exemplo.test') === 'admin', papel('lista.um@exemplo.test'))

console.log('\n── Já existe admin salvo ──')
touchUser('lista.dois@exemplo.test', 'Lista Dois')
confere('e-mail da lista que entra depois é Padrão', papel('lista.dois@exemplo.test') === 'standard', papel('lista.dois@exemplo.test'))
touchUser('novo.usuario@exemplo.test', 'Novo Usuário')
confere('usuário novo fora da lista é Padrão', papel('novo.usuario@exemplo.test') === 'standard', papel('novo.usuario@exemplo.test'))
confere('isAdmin do admin salvo', isAdmin('lista.um@exemplo.test') === true)
confere('isAdmin de quem entrou como Padrão', isAdmin('lista.dois@exemplo.test') === false)
confere('isAdmin de e-mail da lista que nunca entrou', isAdmin('lista.tres@exemplo.test') === false)
confere('isAdmin sem e-mail', isAdmin('') === false)

console.log('\n── Promoção e rebaixamento pela aba Acessos ──')
setUserRole('lista.dois@exemplo.test', 'admin')
confere('promovido vira admin', isAdmin('lista.dois@exemplo.test') === true)
confere('e-mail em maiúsculas resolve igual', isAdmin('LISTA.DOIS@EXEMPLO.TEST') === true)
setUserRole('lista.dois@exemplo.test', 'standard')
confere('rebaixado volta a Padrão', isAdmin('lista.dois@exemplo.test') === false)
const ultimo = erroDe(() => setUserRole('lista.um@exemplo.test', 'standard'))
confere('rebaixar o último admin é recusado', /último administrador/.test(ultimo ?? ''), ultimo ?? 'não recusou')
const semRegistro = erroDe(() => setUserRole('nunca.entrou@exemplo.test', 'admin'))
confere('promover quem nunca entrou é recusado', /ainda não acessou/.test(semRegistro ?? ''), semRegistro ?? 'não recusou')

console.log('\n── Primeiro acesso cai no manual ──')
confere('usuário novo começa com o manual pendente', isManualPending('novo.usuario@exemplo.test') === true)
markManualSeen('novo.usuario@exemplo.test')
confere('abrir o manual encerra o primeiro acesso', isManualPending('novo.usuario@exemplo.test') === false)
{
  // Registro de antes do campo existir: conta como quem já viu o manual.
  const atual = JSON.parse(readFileSync(process.env.ACCESS_USERS_PATH, 'utf8'))
  atual['antigo@exemplo.test'] = { email: 'antigo@exemplo.test', name: 'Antigo', role: 'standard', firstSeenAt: '2026-08-01T12:00:00.000Z', lastSeenAt: '2026-08-01T12:00:00.000Z' }
  writeFileSync(process.env.ACCESS_USERS_PATH, JSON.stringify(atual, null, 2))
  confere('registro antigo, sem o campo, não é primeiro acesso', isManualPending('antigo@exemplo.test') === false)
  touchUser('antigo@exemplo.test', 'Antigo')
  confere('e continua assim depois de um novo acesso', isManualPending('antigo@exemplo.test') === false)
}
confere('e-mail desconhecido não tem manual pendente', isManualPending('ninguem@exemplo.test') === false)

console.log('\n── Pedido de acesso a pasta ──')
const statusDe = (fn) => { try { fn(); return null } catch (e) { return e.status ?? 'sem status' } }
const pasta = createFolder({ name: 'Comercial (teste)' }, 'lista.um@exemplo.test')
setFolderAccess(pasta.id, [], 'lista.um@exemplo.test')
const quem = 'pede.acesso@exemplo.test'
const catalogo = () => listFolderCatalogForUser(quem).find((f) => f.id === pasta.id)
confere('pasta restrita aparece no catálogo, sem acesso', catalogo()?.hasAccess === false)
const pedido = createRequest({ email: quem, name: 'Pede Acesso', folderId: pasta.id, folderName: pasta.name, message: '  Sou do comercial.  ' })
confere('pedido nasce pendente, com a mensagem aparada', pedido.status === 'pending' && pedido.message === 'Sou do comercial.')
confere('segundo pedido pendente para a mesma pasta é 409',
  statusDe(() => createRequest({ email: quem, name: 'Pede Acesso', folderId: pasta.id, folderName: pasta.name })) === 409)
confere('mensagem acima do limite é 400',
  statusDe(() => createRequest({ email: 'outro@exemplo.test', name: 'Outro', folderId: pasta.id, folderName: pasta.name, message: 'x'.repeat(501) })) === 400)
confere('o último pedido da pessoa por pasta é o pendente', latestRequestsByFolder(quem).get(pasta.id)?.id === pedido.id)
grantFolderAccess(pasta.id, quem, 'lista.um@exemplo.test')
decideRequest(pedido.id, 'approved', 'lista.um@exemplo.test')
confere('liberar põe o e-mail na lista da pasta', catalogo()?.hasAccess === true)
confere('pedido respondido sai da fila de pendentes', !listRequests({ status: 'pending' }).some((r) => r.id === pedido.id))
confere('responder de novo o mesmo pedido é 409', statusDe(() => decideRequest(pedido.id, 'rejected', 'lista.um@exemplo.test')) === 409)
confere('pedido inexistente é 404', statusDe(() => decideRequest('nao-existe', 'approved', 'lista.um@exemplo.test')) === 404)
const antes = JSON.stringify(listFolderCatalogForUser(quem))
grantFolderAccess(pasta.id, quem, 'lista.um@exemplo.test')
confere('liberar de novo não duplica nem muda nada', JSON.stringify(listFolderCatalogForUser(quem)) === antes)
{
  const recusado = createRequest({ email: 'recusado@exemplo.test', name: 'Recusado', folderId: pasta.id, folderName: pasta.name })
  decideRequest(recusado.id, 'rejected', 'lista.um@exemplo.test')
  const outraVez = statusDe(() => createRequest({ email: 'recusado@exemplo.test', name: 'Recusado', folderId: pasta.id, folderName: pasta.name }))
  confere('depois de recusado, dá para pedir de novo', outraVez === null)
  const aberta = createFolder({ name: 'Aberta (teste)' }, 'lista.um@exemplo.test')
  confere('pasta aberta já aparece liberada para qualquer um', listFolderCatalogForUser('qualquer@exemplo.test').find((f) => f.id === aberta.id)?.hasAccess === true)
}

console.log('\n── users.json perdido ──')
rmSync(process.env.ACCESS_USERS_PATH, { force: true })
touchUser('lista.tres@exemplo.test', 'Lista Três')
confere('sem admin salvo, a lista volta a valer', papel('lista.tres@exemplo.test') === 'admin', papel('lista.tres@exemplo.test'))
touchUser('outro.novo@exemplo.test', 'Outro Novo')
confere('e quem não está nela continua Padrão', papel('outro.novo@exemplo.test') === 'standard', papel('outro.novo@exemplo.test'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${total - falhas}/${total} checagens passaram`)
process.exit(falhas ? 1 : 0)
