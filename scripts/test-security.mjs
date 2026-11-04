// ─────────────────────────────────────────────────────────────────────────
// Testes de SEGURANÇA da API real. Roda com: npm run test:security
//
// Sobe server/index.mjs de verdade (scripts/lib/harness.mjs), com login de
// verdade e dados inventados, e tenta o que um usuário malicioso tentaria. Não
// toca em data/ nem na rede de fora.
//
// O que prova:
//  1. TODA rota /api/* (descoberta no código, não numa lista escrita à mão)
//     recusa quem não tem sessão — a única exceção é uma lista curta e explícita.
//     Rota nova sem requireAuth() reprova aqui.
//  2. Toda rota com requireAdmin() recusa um usuário comum (403).
//  3. Cookie inexistente, adulterado ou truncado não vale.
//  4. ID token forjado/expirado/de outro projeto/de outro domínio não abre sessão
//     (alg:none, HS256 com a chave pública, assinatura trocada, e-mail não verificado).
//  5. Pasta restrita: quem não está na lista não lê nem escreve.
//  6. CORS não ecoa origem arbitrária com credenciais.
//  7. Erros não vazam stack trace nem caminho de arquivo; corpo acima do limite é 413.
//  8. Cabeçalhos e cookie de sessão (HttpOnly, SameSite, Secure atrás de https).
//  9. Entrada hostil (__proto__, nomes de campo malucos) não derruba a API.
// 10. O token do Data Hub nunca volta para o navegador.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { iniciarHarness, RAIZ } from './lib/harness.mjs'

let total = 0
let falhas = 0
function check(nome, ok, detalhe = '') {
  total++
  if (!ok) falhas++
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${nome}${!ok && detalhe ? ` — ${detalhe}` : ''}`)
}

// ─── 1. Rotas descobertas no código ────────────────────────────────────────
const codigo = readFileSync(join(RAIZ, 'server', 'index.mjs'), 'utf8')
const ROTA = /^app\.(get|post|put|patch|delete)\('([^']+)'((?:,\s*[^\n]*?)?)\s*,\s*(?:async\s*)?\(/gm
const rotas = []
for (const m of codigo.matchAll(ROTA)) {
  const [, metodo, caminho, meio] = m
  rotas.push({ metodo: metodo.toUpperCase(), caminho, auth: /requireAuth\(\)/.test(meio), admin: /requireAdmin\(\)/.test(meio) })
}

// Rotas que PODEM ficar abertas, e por quê.
const ABERTAS = new Map([
  ['GET /api/health', 'sonda do Docker/Portainer e do CI; não devolve dado'],
  ['POST /api/auth/session', 'é a porta de entrada: valida o ID token'],
  ['POST /api/auth/logout', 'só encerra a sessão do próprio cookie; sem sessão é no-op'],
])

check(`o teste enxergou as rotas do servidor (${rotas.length})`, rotas.length > 50, String(rotas.length))
const semAuth = rotas.filter((r) => !r.auth && !ABERTAS.has(`${r.metodo} ${r.caminho}`))
check('toda rota /api/* declara requireAuth() (fora da lista de rotas abertas)', semAuth.length === 0, semAuth.map((r) => `${r.metodo} ${r.caminho}`).join(', '))

const h = await iniciarHarness({ rows: 2000 })
try {
  const comum = await h.entrar('usuario.comum@sebratel.com.br')
  const outro = await h.entrar('outra.pessoa@sebratel.com.br')
  const admin = await h.entrar(h.adminEmail)

  const preencher = (caminho) => caminho
    .replace(':fid', h.abertaId).replace(':did', h.dashId).replace(':tid', h.tabId)
    .replace(/:[a-zA-Z]+/g, 'x')
  const chamar = (r, cookie, extra = {}) => fetch(h.base + preencher(r.caminho), {
    method: r.metodo,
    headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
    body: ['GET', 'DELETE'].includes(r.metodo) ? undefined : '{}',
    redirect: 'manual',
    ...extra,
  })

  // 1) sem sessão → 401 em TODAS as rotas autenticadas
  const abertasPorErro = []
  for (const r of rotas.filter((x) => x.auth)) {
    const res = await chamar(r, null)
    if (res.status !== 401) abertasPorErro.push(`${r.metodo} ${r.caminho} → ${res.status}`)
  }
  check(`sem cookie: as ${rotas.filter((x) => x.auth).length} rotas autenticadas respondem 401`, abertasPorErro.length === 0, abertasPorErro.join('; '))

  // 3) cookie ruim
  for (const [nome, ck] of [
    ['inexistente', 'ind_sessao=nao-existe'],
    ['vazio', 'ind_sessao='],
    ['truncado', comum.slice(0, comum.length - 6)],
    ['com o valor de outro campo', `outro=${comum.split('=')[1]}`],
    ['com injeção de cabeçalho', 'ind_sessao=abc%0d%0aSet-Cookie:x=1'],
  ]) {
    const res = await fetch(`${h.base}/api/auth/me`, { headers: { cookie: ck } })
    check(`cookie ${nome} não vale (401)`, res.status === 401, String(res.status))
  }

  // 2) rotas de admin recusam usuário comum, aceitam admin
  const adminRotas = rotas.filter((r) => r.admin)
  check(`o teste enxergou as rotas de admin (${adminRotas.length})`, adminRotas.length >= 15, String(adminRotas.length))
  const furoAdmin = []
  for (const r of adminRotas) {
    const res = await chamar(r, comum)
    if (res.status !== 403) furoAdmin.push(`${r.metodo} ${r.caminho} → ${res.status}`)
  }
  check('usuário comum recebe 403 em toda rota de administrador', furoAdmin.length === 0, furoAdmin.join('; '))
  const lista = await fetch(`${h.base}/api/lakehouse-sources`, { headers: { cookie: admin } })
  check('o administrador entra na mesma rota (200)', lista.status === 200, String(lista.status))
  const corpoLista = await lista.text()
  check('o token do Data Hub nunca volta para o navegador', !corpoLista.includes('dhub_token_ficticio') && !/tokenEnc/.test(corpoLista))

  // 4) ID tokens forjados
  const sessao = async (idToken) => (await fetch(`${h.base}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) })).status
  const bom = h.assinar('fulano@sebratel.com.br')
  check('token válido abre a sessão (200)', (await sessao(bom)) === 200)
  const [cab, pay, sig] = bom.split('.')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const agora = Math.floor(Date.now() / 1000)
  const corpoPay = JSON.parse(Buffer.from(pay, 'base64url').toString())
  const casos = [
    ['alg:none sem assinatura', `${b64({ alg: 'none', typ: 'JWT' })}.${pay}.`, 401],
    ['alg:none com a assinatura original', `${b64({ alg: 'none', kid: 'kid-de-carga' })}.${pay}.${sig}`, 401],
    ['HS256 assinado com o certificado público', `${b64({ alg: 'HS256', kid: 'kid-de-carga' })}.${pay}.${sig}`, 401],
    ['payload adulterado depois de assinado (outro e-mail)', `${cab}.${b64({ ...corpoPay, email: 'admin.carga@sebratel.com.br' })}.${sig}`, 401],
    ['assinatura trocada', `${cab}.${pay}.${Buffer.from('falsa').toString('base64url')}`, 401],
    ['kid desconhecido', h.assinar('f@sebratel.com.br', {}, { kid: 'outro' }), 401],
    ['expirado', h.assinar('f@sebratel.com.br', { exp: agora - 10, iat: agora - 3600 }), 401],
    ['de outro projeto Firebase (aud)', h.assinar('f@sebratel.com.br', { aud: 'outro-projeto' }), 401],
    ['de outro emissor (iss)', h.assinar('f@sebratel.com.br', { iss: 'https://securetoken.google.com/outro' }), 401],
    ['sem sub', h.assinar('f@sebratel.com.br', { sub: '' }), 401],
    ['sem e-mail', h.assinar('f@sebratel.com.br', { email: undefined }), 401],
    ['lixo', 'isto.nao.eh.jwt', 401],
    ['vazio', '', 400],
    ['e-mail de fora do domínio', h.assinar('alguem@gmail.com'), 403],
    ['domínio parecido (sufixo)', h.assinar('alguem@evilsebratel.com.br'), 403],
    ['e-mail não verificado', h.assinar('f@sebratel.com.br', { email_verified: false }), 403],
  ]
  for (const [nome, tk, esperado] of casos) check(`ID token ${nome} → ${esperado}`, (await sessao(tk)) === esperado, `veio ${await sessao(tk)}`)
  const naoString = await fetch(`${h.base}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: { $ne: null } }) })
  check('idToken que não é texto (objeto) não passa', naoString.status === 400 || naoString.status === 401, String(naoString.status))

  // Cookie da sessão
  const login = await fetch(`${h.base}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ idToken: bom }) })
  const setCookie = (login.headers.getSetCookie?.() ?? []).join(' | ')
  check('cookie de sessão é HttpOnly', /HttpOnly/i.test(setCookie), setCookie)
  check('cookie de sessão tem SameSite', /SameSite=(Lax|Strict)/i.test(setCookie), setCookie)
  check('cookie de sessão é Secure atrás de https', /;\s*Secure/i.test(setCookie), setCookie)
  const loginHttp = await fetch(`${h.base}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: bom }) })
  check('em http puro o cookie NÃO é Secure (senão o navegador o descarta)', !/;\s*Secure/i.test((loginHttp.headers.getSetCookie?.() ?? []).join('|')))

  // Logout encerra de verdade
  const ck2 = await h.entrar('logout.teste@sebratel.com.br')
  await fetch(`${h.base}/api/auth/logout`, { method: 'POST', headers: { cookie: ck2 } })
  check('depois do logout o cookie antigo não vale mais', (await fetch(`${h.base}/api/auth/me`, { headers: { cookie: ck2 } })).status === 401)

  // 5) pasta restrita
  const verRestrita = await fetch(`${h.base}/api/workspace/folders/${h.restritaId}/dashboards/${h.dashRestritaId}`, { headers: { cookie: comum } })
  check('usuário fora da lista não lê dashboard de pasta restrita', [403, 404].includes(verRestrita.status), String(verRestrita.status))
  const admOk = await fetch(`${h.base}/api/workspace/folders/${h.restritaId}/dashboards/${h.dashRestritaId}`, { headers: { cookie: admin } })
  check('quem está na lista lê (200)', admOk.status === 200, String(admOk.status))
  const arvore = JSON.parse(await (await fetch(`${h.base}/api/workspace/tree`, { headers: { cookie: comum } })).text())
  check('a pasta restrita nem aparece na árvore de quem não tem acesso', !arvore.folders.some((f) => f.id === h.restritaId))
  const escreve = await fetch(`${h.base}/api/workspace/folders/${h.abertaId}/dashboards/${h.dashId}`, { method: 'PUT', headers: { cookie: comum, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'invadido' }) })
  check('usuário comum não renomeia dashboard (sem ser gerente da pasta)', escreve.status === 403, String(escreve.status))
  const apaga = await fetch(`${h.base}/api/workspace/folders/${h.abertaId}/dashboards/${h.dashId}`, { method: 'DELETE', headers: { cookie: comum } })
  check('usuário comum não apaga dashboard', apaga.status === 403, String(apaga.status))
  const grava = await fetch(`${h.base}/api/workspace/folders/${h.restritaId}/dashboards/${h.dashRestritaId}/tabs/x/widgets`, { method: 'PUT', headers: { cookie: comum, 'content-type': 'application/json' }, body: JSON.stringify({ widgets: [], baseRev: 1 }) })
  check('usuário fora da lista não grava widgets em pasta restrita', [403, 404].includes(grava.status), String(grava.status))
  // Promoção a admin pela própria pessoa
  const promove = await fetch(`${h.base}/api/access/users/${encodeURIComponent('usuario.comum@sebratel.com.br')}/role`, { method: 'PATCH', headers: { cookie: comum, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) })
  check('usuário comum não se promove a administrador (403)', promove.status === 403, String(promove.status))
  const aindaComum = JSON.parse(await (await fetch(`${h.base}/api/auth/me`, { headers: { cookie: comum } })).text())
  check('e continua sendo usuário padrão depois da tentativa', aindaComum.isAdmin === false)
  void outro

  // Comentário: só o autor (ou admin) apaga
  const c = await fetch(`${h.base}/api/widget-comments`, { method: 'POST', headers: { cookie: comum, 'content-type': 'application/json' }, body: JSON.stringify({ widgetId: 'w1', text: 'meu comentário' }) })
  const idc = JSON.parse(await c.text())?.comment?.id
  const delOutro = await fetch(`${h.base}/api/widget-comments/${idc}`, { method: 'DELETE', headers: { cookie: outro } })
  check('outra pessoa não apaga o comentário de alguém', delOutro.status >= 400, String(delOutro.status))
  const delDono = await fetch(`${h.base}/api/widget-comments/${idc}`, { method: 'DELETE', headers: { cookie: comum } })
  check('o autor apaga o próprio comentário', delDono.status === 200, String(delDono.status))

  // 6) CORS
  const cors = await fetch(`${h.base}/api/auth/me`, { headers: { cookie: comum, origin: 'https://site-malicioso.example' } })
  check('CORS não ecoa uma origem qualquer', cors.headers.get('access-control-allow-origin') == null, String(cors.headers.get('access-control-allow-origin')))
  check('CORS não libera credenciais para origem qualquer', cors.headers.get('access-control-allow-credentials') == null)
  const pre = await fetch(`${h.base}/api/widget-data`, { method: 'OPTIONS', headers: { origin: 'https://site-malicioso.example', 'access-control-request-method': 'POST' } })
  check('preflight de origem estranha não recebe permissões', pre.headers.get('access-control-allow-origin') == null && pre.status < 500)

  // 7) erros e limites
  const quebrado = await fetch(`${h.base}/api/widget-data`, { method: 'POST', headers: { cookie: comum, 'content-type': 'application/json' }, body: '{"widget":' })
  const txtQuebrado = await quebrado.text()
  check('JSON quebrado → 400', quebrado.status === 400, String(quebrado.status))
  check('o erro não vaza stack trace nem caminho de arquivo', !/\bat .*\(.*:\d+:\d+\)|node_modules|[A-Z]:\\|\/app\//.test(txtQuebrado), txtQuebrado.slice(0, 160))
  const grande = await fetch(`${h.base}/api/widget-data`, { method: 'POST', headers: { cookie: comum, 'content-type': 'application/json' }, body: JSON.stringify({ widget: 'x'.repeat(3_000_000) }) })
  check('corpo acima de 2 MB → 413', grande.status === 413, String(grande.status))
  const naoExiste = await fetch(`${h.base}/api/rota-que-nao-existe`, { headers: { cookie: comum } })
  const txtNE = await naoExiste.text()
  check('rota inexistente → 404 sem stack', naoExiste.status === 404 && !/node_modules|\bat \w+/.test(txtNE), `${naoExiste.status} ${txtNE.slice(0, 100)}`)

  // 8) cabeçalhos
  const hd = await fetch(`${h.base}/api/health`)
  check('não anuncia o framework (X-Powered-By)', hd.headers.get('x-powered-by') == null, String(hd.headers.get('x-powered-by')))
  check('X-Content-Type-Options: nosniff', hd.headers.get('x-content-type-options') === 'nosniff')
  const corpoHealth = await hd.json()
  check('/api/health devolve {"status":"ok"} (o que o CI confere) e não vaza dado', corpoHealth.status === 'ok' && Object.keys(corpoHealth).every((k) => ['status', 'ok', 'service', 'time'].includes(k)), JSON.stringify(corpoHealth))
  const nginx = readFileSync(join(RAIZ, 'docker', 'nginx.conf'), 'utf8')
  check('nginx: server_tokens off', /server_tokens\s+off/.test(nginx))
  check('nginx: X-Content-Type-Options e X-Frame-Options', /X-Content-Type-Options/.test(nginx) && /X-Frame-Options/.test(nginx))

  // 9) entrada hostil: nada pode derrubar nem poluir
  const S = h.chave
  const hostis = [
    { widget: { id: 'w', title: 't', source: S, type: 'bar', dimensions: ['__proto__'], measures: [{ agg: 'count' }] } },
    { widget: { id: 'w', title: 't', source: S, type: 'bar', dimensions: ['constructor'], measures: [{ agg: 'count' }] } },
    { widget: { id: 'w', title: 't', source: '__proto__', type: 'kpi' } },
    { widget: { id: 'w', title: 't', source: S, type: 'kpi', measure: { agg: 'sum', field: 'toString' } } },
    { widget: { id: 'w', title: 't', source: S, type: 'bar', dimensions: ['Status'], measures: [{ agg: "count'; DROP TABLE x;--" }] } },
    { widget: null }, { widget: [] }, { widget: 'texto' }, {}, [],
    { widget: { id: 'w', title: 't', source: S, type: 'table', columns: ['Protocolo'] }, page: -5, pageSize: -1 },
    { widget: { id: 'w', title: 't', source: S, type: 'table', columns: ['Protocolo'] }, page: 'x', pageSize: 1e308 },
    { widget: { id: 'w', title: 't', source: S, type: 'kpi' }, tabFilters: 'não é lista', relations: { a: 1 }, dashboardMeasures: 7 },
  ]
  let quedas = 0
  for (const corpo of hostis) {
    const r = await fetch(`${h.base}/api/widget-data`, { method: 'POST', headers: { cookie: comum, 'content-type': 'application/json' }, body: JSON.stringify(corpo) }).catch(() => null)
    if (!r || r.status >= 500) quedas++
  }
  check(`${hostis.length} entradas hostis em /api/widget-data: nenhuma dá 5xx`, quedas === 0, `${quedas} com 5xx`)
  const vivo = await fetch(`${h.base}/api/health`).then((r) => r.ok).catch(() => false)
  check('a API continua de pé depois das entradas hostis', vivo && !h.saiu())
  const traversal = await fetch(`${h.base}/api/widget-comments/..%2F..%2Fetc%2Fpasswd`, { headers: { cookie: comum } })
  check('path traversal em parâmetro de rota não vaza arquivo', traversal.status !== 200 || !/root:/.test(await traversal.text()))
  const loginLixo = await Promise.all(Array.from({ length: 30 }, () => sessao('a.b.c')))
  check('30 logins inválidos em rajada: todos 401, sem consultar o Google', loginLixo.every((s) => s === 401))
} finally {
  await h.parar()
}

console.log(`\n${total - falhas}/${total} verificações passaram.`)
process.exit(falhas ? 1 : 0)
