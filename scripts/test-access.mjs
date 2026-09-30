// Teste do papel de quem entra (server/accessLog.mjs). Roda com:
// npm run test:access
//
// O que ele prova: quem acessa pela primeira vez entra como Padrão
// (`standard`), mesmo estando em ADMIN_EMAILS, desde que a instalação já tenha
// um administrador salvo. A lista só vale enquanto não existe nenhum admin
// (instalação nova, ou data/users.json perdido) — é o que impede o sistema de
// nascer sem ninguém capaz de liberar acesso.
//
// Não toca em data/: users.json e o log de auditoria vão para uma pasta
// temporária, e os e-mails são fictícios.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ind-acessos-teste-'))
process.env.ACCESS_USERS_PATH = join(dir, 'users.json')
process.env.ACCESS_LOG_PATH = join(dir, 'audit-log.json')
// Lida na importação do módulo — precisa estar definida antes do import.
process.env.ADMIN_EMAILS = 'lista.um@exemplo.test, lista.dois@exemplo.test, lista.tres@exemplo.test'

const AQUI = dirname(fileURLToPath(import.meta.url))
const mod = (n) => pathToFileURL(resolvePath(AQUI, '..', 'server', n)).href
const { touchUser, isAdmin, listUsers, setUserRole } = await import(mod('accessLog.mjs'))

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

console.log('\n── users.json perdido ──')
rmSync(process.env.ACCESS_USERS_PATH, { force: true })
touchUser('lista.tres@exemplo.test', 'Lista Três')
confere('sem admin salvo, a lista volta a valer', papel('lista.tres@exemplo.test') === 'admin', papel('lista.tres@exemplo.test'))
touchUser('outro.novo@exemplo.test', 'Outro Novo')
confere('e quem não está nela continua Padrão', papel('outro.novo@exemplo.test') === 'standard', papel('outro.novo@exemplo.test'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${total - falhas}/${total} checagens passaram`)
process.exit(falhas ? 1 : 0)
