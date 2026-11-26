// ─────────────────────────────────────────────────────────────────────────
// Entrada pelo Hub Apps e modo "só pelo Hub" (HUB_ONLY). Roda com:
//   npm run test:hub
//
// Parte 1 — conferência do token (server/hubSso.mjs), sem rede: válido,
// segredo errado, alg:none, vencido, iat no futuro, vida longa, appId errado,
// domínio de fora, reuso, payload adulterado; e o token do Data Hub (menu
// "Painéis"), que só atravessa com HUB_ONLY se a sessão de lá veio do Hub.
//
// Parte 2 — a API REAL (scripts/lib/harness.mjs) com HUB_ONLY ligado: login
// pelo Google recusado no servidor, sessão antiga de cookie (de administrador)
// recusada, a sessão do Hub só vale no Bearer (nunca em cookie: aba solta não
// entra), papel vindo de data/users.json, AUTH_DISABLED ignorado. E os dois
// cenários que não podem trancar ninguém: HUB_ONLY sem segredo é ignorado, e
// sem HUB_ONLY os dois caminhos convivem.
//
// Segredos e e-mails são fictícios. Não toca em data/ nem na rede de fora.
// ─────────────────────────────────────────────────────────────────────────
import { createHmac, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

let total = 0
let falhas = 0
function check(nome, ok, detalhe = '') {
  total++
  if (!ok) falhas++
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${nome}${!ok && detalhe ? ` — ${detalhe}` : ''}`)
}

const SEGREDO = 'segredo-do-hub-so-para-teste-0123456789abcdef'
const SEGREDO_DH = 'segredo-do-data-hub-so-para-teste-0123456789abcdef'
const APP = 'f03eb408-086d-495b-a4dc-1cbe3b539b28'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const agora = () => Math.floor(Date.now() / 1000)

function assinar(payload, segredo = SEGREDO, header = { alg: 'HS256', typ: 'JWT' }) {
  const corpo = `${b64(header)}.${b64(payload)}`
  return `${corpo}.${createHmac('sha256', segredo).update(corpo).digest('base64url')}`
}
// Token como o hub-api emite (jsonwebtoken, expiresIn 300).
const tokHub = (extra = {}, segredo = SEGREDO, header) => assinar({
  sub: 'uid-123', email: 'fulano.tal@sebratel.com.br', name: 'Fulano Tal', appId: APP,
  iat: agora(), exp: agora() + 300, jti: randomUUID(), ...extra,
}, segredo, header)
// Token do Data Hub para o quadro "Painéis" (contrato em server/hubSso.mjs).
const tokDh = (extra = {}, segredo = SEGREDO_DH) => assinar({
  iss: 'data-hub', aud: 'dashia', sub: 'fulano.tal@sebratel.com.br', email: 'fulano.tal@sebratel.com.br',
  name: 'Fulano Tal', via: 'hub', iat: agora(), exp: agora() + 300, jti: randomUUID(), ...extra,
}, segredo)

function ambiente(v) {
  for (const k of ['HUB_SSO_SECRET', 'HUB_APP_ID', 'HUB_ONLY', 'HUB_URL', 'DATAHUB_SSO_SECRET']) delete process.env[k]
  process.env.ALLOWED_DOMAIN = 'sebratel.com.br'
  Object.assign(process.env, v)
}

// ─── Parte 1: conferência do token ─────────────────────────────────────────
console.log('Conferência do token do Hub (server/hubSso.mjs)')
ambiente({ HUB_SSO_SECRET: SEGREDO, DATAHUB_SSO_SECRET: SEGREDO_DH })
const hub = await import('../server/hubSso.mjs')

{
  const r = hub.verifyHubLaunchToken(tokHub())
  check('token válido entra, como `hub`', r.ok && r.email === 'fulano.tal@sebratel.com.br' && r.via === 'hub' && r.name === 'Fulano Tal', JSON.stringify(r))
  check('HUB_APP_ID padrão é o id do card no Hub', hub.hubAppId() === APP, hub.hubAppId())
  check('HUB_URL padrão é o Hub de produção', hub.hubUrl() === 'https://hub-apps.sebratel.net.br', hub.hubUrl())
}
const st = (t) => hub.verifyHubLaunchToken(t).status
check('segredo errado → 401', st(tokHub({}, 'outro-segredo-qualquer-0123456789')) === 401)
{
  const [, pay] = tokHub().split('.')
  check('alg:none sem assinatura → 401', st(`${b64({ alg: 'none', typ: 'JWT' })}.${pay}.`) === 401)
  const corpoNone = `${b64({ alg: 'none', typ: 'JWT' })}.${pay}`
  const sigNone = createHmac('sha256', SEGREDO).update(corpoNone).digest('base64url')
  check('alg:none mesmo com HMAC certo → 401 (o alg não escolhe nada)', st(`${corpoNone}.${sigNone}`) === 401)
  check('alg:HS512 → 401', st(tokHub({}, SEGREDO, { alg: 'HS512', typ: 'JWT' })) === 401)
}
check('vencido → 401', st(tokHub({ iat: agora() - 400, exp: agora() - 1 })) === 401)
check('iat no futuro (além de 60 s) → 401', st(tokHub({ iat: agora() + 120, exp: agora() + 420 })) === 401)
check('iat 30 s adiantado (relógio do Hub) ainda entra', hub.verifyHubLaunchToken(tokHub({ iat: agora() + 30, exp: agora() + 330 })).ok)
check('vida acima de 600 s → 401', st(tokHub({ iat: agora(), exp: agora() + 3600 })) === 401)
check('sem iat → 401', st(tokHub({ iat: undefined })) === 401)
check('appId de outro app do Hub → 403', st(tokHub({ appId: 'outro-app-do-hub' })) === 403)
check('sem appId → 403', st(tokHub({ appId: undefined })) === 403)
check('e-mail de fora do domínio → 403', st(tokHub({ email: 'alguem@gmail.com' })) === 403)
check('domínio parecido (sufixo) → 403', st(tokHub({ email: 'alguem@evilsebratel.com.br' })) === 403)
check('subdomínio → 403', st(tokHub({ email: 'alguem@x.sebratel.com.br' })) === 403)
check('sem e-mail → 403', st(tokHub({ email: undefined })) === 403)
{
  const r = hub.verifyHubLaunchToken(tokHub({ email: '  Fulano.TAL@Sebratel.com.br ' }))
  check('e-mail normalizado em minúsculas', r.ok && r.email === 'fulano.tal@sebratel.com.br', JSON.stringify(r))
}
{
  const t = tokHub({ email: 'reuso@sebratel.com.br' })
  const a = hub.verifyHubLaunchToken(t)
  const b = hub.verifyHubLaunchToken(t)
  check('uso único: o mesmo token na segunda vez → 401', a.ok && !b.ok && b.status === 401, JSON.stringify(b))
}
{
  const [cab, pay, sig] = tokHub().split('.')
  const corpo = JSON.parse(Buffer.from(pay, 'base64url').toString())
  check('payload adulterado depois de assinado (outro e-mail) → 401', st(`${cab}.${b64({ ...corpo, email: 'admin@sebratel.com.br' })}.${sig}`) === 401)
  check('appId trocado depois de assinado → 401', st(`${cab}.${b64({ ...corpo, appId: APP + 'x' })}.${sig}`) === 401)
}
for (const [nome, lixo] of [['lixo', 'isto.nao.eh.jwt'], ['duas partes', 'a.b'], ['vazio', ''], ['objeto', { $ne: null }]]) {
  check(`token ${nome} não entra`, !hub.verifyLaunchToken(lixo).ok)
}
check('HUB_ONLY desligado por padrão', hub.hubOnlyActive() === false)

ambiente({ HUB_SSO_SECRET: SEGREDO, HUB_APP_ID: 'app-de-staging' })
check('HUB_APP_ID do ambiente vale (token do card de produção → 403)', st(tokHub()) === 403)
check('… e o do HUB_APP_ID configurado entra', hub.verifyHubLaunchToken(tokHub({ appId: 'app-de-staging' })).ok)

ambiente({ HUB_ONLY: 'true' })
check('HUB_ONLY sem HUB_SSO_SECRET é ignorado (ninguém fica trancado)', hub.hubOnlyActive() === false)
check('sem segredo a troca responde 503', hub.verifyHubLaunchToken(tokHub()).status === 503)
ambiente({ HUB_ONLY: 'true', HUB_SSO_SECRET: SEGREDO })
check('HUB_ONLY com o segredo vale', hub.hubOnlyActive() === true)

console.log('\nToken do Data Hub (menu "Painéis": Hub → Data Hub → Indicadores)')
ambiente({ HUB_SSO_SECRET: SEGREDO, DATAHUB_SSO_SECRET: SEGREDO_DH })
{
  const r = hub.verifyLaunchToken(tokDh())
  check('token do Data Hub válido entra, como `datahub`', r.ok && r.via === 'datahub' && r.email === 'fulano.tal@sebratel.com.br', JSON.stringify(r))
  check('token do Hub pelo mesmo caminho entra como `hub`', hub.verifyLaunchToken(tokHub()).via === 'hub')
}
const stDh = (t) => hub.verifyLaunchToken(t).status
check('token do Data Hub assinado com o segredo do HUB → 401', stDh(tokDh({}, SEGREDO)) === 401)
check('token do Hub assinado com o segredo do DATA HUB → 401', stDh(tokHub({}, SEGREDO_DH)) === 401)
check('Data Hub com `aud` de outro sistema → 401', stDh(tokDh({ aud: 'outro-sistema' })) === 401)
check('Data Hub vencido → 401', stDh(tokDh({ iat: agora() - 400, exp: agora() - 1 })) === 401)
check('Data Hub com vida acima de 600 s → 401', stDh(tokDh({ exp: agora() + 3600 })) === 401)
check('Data Hub com e-mail de fora → 403', stDh(tokDh({ email: 'x@gmail.com' })) === 403)
{
  const t = tokDh({ email: 'reuso.dh@sebratel.com.br' })
  hub.verifyLaunchToken(t)
  check('Data Hub: uso único', stDh(t) === 401)
}
check('sem HUB_ONLY, sessão do Data Hub aberta pelo Google também atravessa', hub.verifyLaunchToken(tokDh({ via: 'google' })).ok)
ambiente({ HUB_SSO_SECRET: SEGREDO, DATAHUB_SSO_SECRET: SEGREDO_DH, HUB_ONLY: 'true' })
{
  const r = hub.verifyLaunchToken(tokDh({ via: 'google' }))
  check('com HUB_ONLY, sessão do Data Hub que NÃO veio do Hub (ex.: master direto) → 403 HUB_ONLY', !r.ok && r.status === 403 && r.code === 'HUB_ONLY', JSON.stringify(r))
  check('com HUB_ONLY, sem `via` → 403', stDh(tokDh({ via: undefined })) === 403)
  check('com HUB_ONLY, sessão do Data Hub vinda do Hub atravessa', hub.verifyLaunchToken(tokDh()).ok)
}
ambiente({ HUB_SSO_SECRET: SEGREDO, DATAHUB_SSO_SECRET: SEGREDO })
check('DATAHUB_SSO_SECRET igual ao do Hub desliga a ligação', !hub.datahubSsoConfigured() && stDh(tokDh({}, SEGREDO)) === 503 && /igual/.test(hub.datahubSsoProblem() ?? ''))
ambiente({ HUB_SSO_SECRET: SEGREDO, DATAHUB_SSO_SECRET: 'curto' })
check('DATAHUB_SSO_SECRET curto desliga a ligação', !hub.datahubSsoConfigured() && /menos de/.test(hub.datahubSsoProblem() ?? ''))
ambiente({ HUB_SSO_SECRET: SEGREDO })
check('sem DATAHUB_SSO_SECRET o token do Data Hub → 503', stDh(tokDh()) === 503)

// ─── Parte 2: a API real ───────────────────────────────────────────────────
// O harness repassa process.env ao servidor: limpa o que a parte 1 deixou,
// para cada cenário valer só com o `env` que ele declara.
ambiente({})
const { iniciarHarness } = await import('./lib/harness.mjs')
const json = (r) => r.json().catch(() => null)
const post = (base, caminho, corpo, headers = {}) => fetch(base + caminho, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(corpo),
})
const bearer = (t) => ({ authorization: `Bearer ${t}` })
const temCookieSessao = (r) => (r.headers.getSetCookie?.() ?? []).some((c) => /^ind_sessao=[^;]+/.test(c) && !/^ind_sessao=;/.test(c))

console.log('\nAPI com HUB_ONLY=true (e AUTH_DISABLED=true, que precisa ser ignorado)')
let h = await iniciarHarness({
  rows: 200,
  env: { HUB_SSO_SECRET: SEGREDO, HUB_ONLY: 'true', DATAHUB_SSO_SECRET: SEGREDO_DH, AUTH_DISABLED: 'true' },
})
try {
  // Sessão de login pelo Google aberta ANTES de ligar o modo — de um ADMINISTRADOR.
  const ANTIGA = 'sessao-antiga-do-google-0123456789abcdef'
  const t0 = Date.now()
  writeFileSync(join(h.dir, 'sessions.json'), JSON.stringify([{
    id: ANTIGA, email: h.adminEmail, name: 'Admin', picture: null, accessToken: null, accessTokenExpiresAt: 0,
    createdAt: t0, lastSeenAt: t0, expiresAt: t0 + 86_400_000,
  }]))

  const cfg = await fetch(`${h.base}/api/auth/config`)
  const cfgTxt = await cfg.text()
  const cfgBody = JSON.parse(cfgTxt)
  check('GET /api/auth/config é público e diz hubOnly', cfg.status === 200 && cfgBody.hubOnly === true && cfgBody.hubSso === true && cfgBody.hubUrl === 'https://hub-apps.sebratel.net.br', cfgTxt)
  check('… e não entrega segredo nenhum', !cfgTxt.includes(SEGREDO) && !cfgTxt.includes(SEGREDO_DH))

  const google = await post(h.base, '/api/auth/session', { idToken: h.assinar('fulano.tal@sebratel.com.br') })
  const gBody = await json(google)
  check('login pelo Google com ID token VÁLIDO → 403 HUB_ONLY', google.status === 403 && gBody?.code === 'HUB_ONLY', `${google.status} ${JSON.stringify(gBody)}`)
  check('… e não abre cookie de sessão', !temCookieSessao(google))
  const googleAdmin = await post(h.base, '/api/auth/session', { idToken: h.assinar(h.adminEmail) })
  check('nem para administrador (sem exceção) → 403 HUB_ONLY', googleAdmin.status === 403 && (await json(googleAdmin))?.code === 'HUB_ONLY')

  const meAntiga = await fetch(`${h.base}/api/auth/me`, { headers: { cookie: `ind_sessao=${ANTIGA}` } })
  check('sessão de cookie aberta antes do modo (de admin) → 403 HUB_ONLY', meAntiga.status === 403 && (await json(meAntiga))?.code === 'HUB_ONLY', String(meAntiga.status))
  check('… e o cookie é apagado na resposta', (meAntiga.headers.getSetCookie?.() ?? []).some((c) => /^ind_sessao=;.*Max-Age=0/.test(c)))
  const arvoreAntiga = await fetch(`${h.base}/api/workspace/tree`, { headers: { cookie: `ind_sessao=${ANTIGA}` } })
  check('… também nas rotas de API protegidas', arvoreAntiga.status === 403)
  const antigaNoBearer = await fetch(`${h.base}/api/auth/me`, { headers: bearer(ANTIGA) })
  check('id da sessão do Google mandado no Bearer → 401', antigaNoBearer.status === 401, String(antigaNoBearer.status))

  const semNada = await fetch(`${h.base}/api/workspace/tree`)
  check('sem sessão → 401 (AUTH_DISABLED=true ignorado com HUB_ONLY)', semNada.status === 401, String(semNada.status))

  // Entrada pelo Hub
  const troca = await post(h.base, '/api/auth/hub', { token: tokHub({ email: 'usuario.comum@sebratel.com.br', name: 'Usuário Comum' }) })
  const tb = await json(troca)
  check('token do Hub → 200 com a sessão no corpo', troca.status === 200 && typeof tb?.token === 'string' && tb.user?.email === 'usuario.comum@sebratel.com.br', `${troca.status} ${JSON.stringify(tb)}`)
  check('… sem cookie (a sessão vive no sessionStorage do quadro)', !temCookieSessao(troca))
  const vida = Date.parse(tb?.expiresAt) - Date.now()
  check('… sessão de 8 h', vida > 7.9 * 3600e3 && vida <= 8 * 3600e3, String(vida))
  check('… papel vem do cadastro (usuário comum não é admin)', tb?.isAdmin === false)

  const me = await fetch(`${h.base}/api/auth/me`, { headers: bearer(tb.token) })
  const meBody = await json(me)
  check('GET /api/auth/me com o Bearer do Hub → 200', me.status === 200 && meBody?.user?.email === 'usuario.comum@sebratel.com.br', String(me.status))
  const arvore = await fetch(`${h.base}/api/workspace/tree`, { headers: bearer(tb.token) })
  check('rota protegida com o Bearer do Hub → 200', arvore.status === 200, String(arvore.status))
  const rotaAdmin = await fetch(`${h.base}/api/lakehouse-sources`, { headers: bearer(tb.token) })
  const rotaAdminBody = await json(rotaAdmin)
  check('rota de admin com usuário comum vindo do Hub → 403 (sem HUB_ONLY: é permissão)', rotaAdmin.status === 403 && rotaAdminBody?.code !== 'HUB_ONLY', String(rotaAdmin.status))

  const noCookie = await fetch(`${h.base}/api/auth/me`, { headers: { cookie: `ind_sessao=${tb.token}` } })
  check('aba solta: o id da sessão do Hub posto em COOKIE não vale (401)', noCookie.status === 401, String(noCookie.status))

  const tokAdmin = tokHub({ email: h.adminEmail, name: 'Admin' })
  const trocaAdmin = await json(await post(h.base, '/api/auth/hub', { token: tokAdmin }))
  check('administrador entra pelo Hub e o papel vem do cadastro', trocaAdmin?.isAdmin === true, JSON.stringify(trocaAdmin))
  const adminOk = await fetch(`${h.base}/api/lakehouse-sources`, { headers: bearer(trocaAdmin.token) })
  check('… e abre a rota de admin com o Bearer do Hub (200)', adminOk.status === 200, String(adminOk.status))
  const reuso = await post(h.base, '/api/auth/hub', { token: tokAdmin })
  check('mesmo token do Hub de novo → 401 (uso único)', reuso.status === 401, String(reuso.status))

  for (const [nome, tk, esperado] of [
    ['de outro app', tokHub({ appId: 'outro' }), 403],
    ['de fora do domínio', tokHub({ email: 'x@gmail.com' }), 403],
    ['vencido', tokHub({ iat: agora() - 400, exp: agora() - 1 }), 401],
    ['com segredo errado', tokHub({}, 'outro-segredo-0123456789-0123456789'), 401],
    ['alg:none', `${b64({ alg: 'none' })}.${tokHub().split('.')[1]}.`, 401],
  ]) {
    const r = await post(h.base, '/api/auth/hub', { token: tk })
    check(`token do Hub ${nome} → ${esperado}`, r.status === esperado, String(r.status))
  }
  const vazio = await post(h.base, '/api/auth/hub', {})
  check('troca sem token → 400', vazio.status === 400)

  const dh = await json(await post(h.base, '/api/auth/hub', { token: tokDh({ email: 'pelo.datahub@sebratel.com.br' }) }))
  const meDh = await fetch(`${h.base}/api/auth/me`, { headers: bearer(dh?.token ?? 'x'.repeat(30)) })
  check('Painéis do Data Hub (sessão de lá veio do Hub) → entra pelo Bearer', meDh.status === 200, String(meDh.status))
  const dhGoogle = await post(h.base, '/api/auth/hub', { token: tokDh({ via: 'google', email: 'master.direto@sebratel.com.br' }) })
  check('Painéis do Data Hub com sessão de lá aberta direto (master) → 403 HUB_ONLY', dhGoogle.status === 403 && (await json(dhGoogle))?.code === 'HUB_ONLY', String(dhGoogle.status))

  const sair = await fetch(`${h.base}/api/auth/logout`, { method: 'POST', headers: bearer(tb.token) })
  const depois = await fetch(`${h.base}/api/auth/me`, { headers: bearer(tb.token) })
  check('logout com o Bearer encerra a sessão do Hub no servidor', sair.status === 204 && depois.status === 401, `${sair.status}/${depois.status}`)

  await new Promise((ok) => setTimeout(ok, 200))
  const todoLog = h.logRecente().join('\n')
  check('o log não contém o token do Hub nem o id da sessão', !todoLog.includes(tokAdmin) && !todoLog.includes(trocaAdmin.token))
  check('a subida avisa que AUTH_DISABLED foi ignorado', /AUTH_DISABLED=true IGNORADO/.test(todoLog))
} finally {
  await h.parar()
}

console.log('\nAPI com HUB_ONLY=true SEM HUB_SSO_SECRET (não pode trancar ninguém)')
h = await iniciarHarness({ rows: 200, env: { HUB_ONLY: 'true' } })
try {
  const cfg = await json(await fetch(`${h.base}/api/auth/config`))
  check('config: hubOnly=false, hubSso=false', cfg?.hubOnly === false && cfg?.hubSso === false, JSON.stringify(cfg))
  const ck = await h.entrar('fulano.tal@sebratel.com.br')
  const me = await fetch(`${h.base}/api/auth/me`, { headers: { cookie: ck } })
  check('login pelo Google continua funcionando', me.status === 200, String(me.status))
  const troca = await post(h.base, '/api/auth/hub', { token: tokHub() })
  check('troca pelo Hub responde 503 (não configurada)', troca.status === 503, String(troca.status))
  check('a subida avisa que HUB_ONLY foi ignorado', /HUB_ONLY=true IGNORADO/.test(h.logRecente().join('\n')))
} finally {
  await h.parar()
}

console.log('\nAPI com HUB_SSO_SECRET e sem HUB_ONLY (os dois caminhos convivem)')
h = await iniciarHarness({ rows: 200, env: { HUB_SSO_SECRET: SEGREDO } })
try {
  const cfg = await json(await fetch(`${h.base}/api/auth/config`))
  check('config: hubSso=true, hubOnly=false', cfg?.hubOnly === false && cfg?.hubSso === true, JSON.stringify(cfg))
  const ck = await h.entrar('fulano.tal@sebratel.com.br')
  check('login pelo Google abre sessão de cookie', (await fetch(`${h.base}/api/workspace/tree`, { headers: { cookie: ck } })).status === 200)
  const tb = await json(await post(h.base, '/api/auth/hub', { token: tokHub() }))
  check('entrada pelo Hub abre sessão de Bearer', (await fetch(`${h.base}/api/workspace/tree`, { headers: bearer(tb?.token ?? 'x'.repeat(30)) })).status === 200)
  check('a sessão do Hub continua sem valer em cookie', (await fetch(`${h.base}/api/auth/me`, { headers: { cookie: `ind_sessao=${tb.token}` } })).status === 401)
  const dh = await post(h.base, '/api/auth/hub', { token: tokDh() })
  check('sem DATAHUB_SSO_SECRET o token do Data Hub → 503', dh.status === 503, String(dh.status))
} finally {
  await h.parar()
}

console.log(`\n${total - falhas}/${total} verificações passaram.`)
process.exit(falhas ? 1 : 0)
