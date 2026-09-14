// Teste de fumaça da verificação do ID token do Firebase
// (server/firebaseToken.mjs). Roda com: npm run test:auth
//
// Isto é código de AUTENTICAÇÃO: um furo aqui não aparece como bug, aparece
// como alguém entrando. Por isso o teste não se contenta em provar que um token
// bom passa — a maior parte dele prova que os RUINS param, um a um, incluindo
// as fraudes clássicas (alg:none, troca pra HS256, payload adulterado depois de
// assinado, token legítimo de OUTRO projeto Firebase).
//
// Não toca na rede: gera um par de chaves próprio, assina os tokens com ele e
// injeta o certificado no cache com __setCertsForTest.
import { execFileSync } from 'node:child_process'
import { createSign, createHmac, generateKeyPairSync } from 'node:crypto'
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const PROJETO_ID = 'authentication-projeto-de-teste'
process.env.FIREBASE_PROJECT_ID = PROJETO_ID
// Não deixa o módulo achar (nem gravar) o cache real de certificados.
const dir = mkdtempSync(join(tmpdir(), 'ind-auth-teste-'))
process.env.FIREBASE_CERTS_PATH = join(dir, 'certs.json')

const AQUI = dirname(fileURLToPath(import.meta.url))
const mod = (n) => pathToFileURL(resolvePath(AQUI, '..', 'server', n)).href
const { verifyFirebaseIdToken, __setCertsForTest } = await import(mod('firebaseToken.mjs'))

// ─── Chave + certificado autoassinado (o formato que o Google publica) ──
const keyPath = join(dir, 'k.pem')
const certPath = join(dir, 'c.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=teste',
], { stdio: 'ignore' })
const chavePrivada = readFileSync(keyPath, 'utf8')
const certificado = readFileSync(certPath, 'utf8')

const KID = 'kid-de-teste'
__setCertsForTest({ [KID]: certificado })

// ─── Fábrica de tokens ─────────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const agora = () => Math.floor(Date.now() / 1000)

function payloadValido(extra = {}) {
  return {
    iss: `https://securetoken.google.com/${PROJETO_ID}`,
    aud: PROJETO_ID,
    sub: 'uid-123',
    email: 'fulano@sebratel.com.br',
    email_verified: true,
    name: 'Fulano de Tal',
    iat: agora() - 30,
    exp: agora() + 3600,
    ...extra,
  }
}

function assinaRS256(header, payload) {
  const corpo = `${b64(header)}.${b64(payload)}`
  const sig = createSign('RSA-SHA256').update(corpo).sign(chavePrivada)
  return `${corpo}.${Buffer.from(sig).toString('base64url')}`
}

const tokenValido = (extra = {}, header = {}) =>
  assinaRS256({ alg: 'RS256', kid: KID, typ: 'JWT', ...header }, payloadValido(extra))

// ─── Verificações ──────────────────────────────────────────────────────
let falhas = 0
let total = 0

async function aceita(desc, token) {
  total += 1
  const r = await verifyFirebaseIdToken(token)
  if (r) console.log(`  PASS  aceita: ${desc}`)
  else { falhas += 1; console.log(`  FALHA aceita: ${desc} — foi RECUSADO e deveria passar`) }
  return r
}

async function recusa(desc, token) {
  total += 1
  let r
  try {
    r = await verifyFirebaseIdToken(token)
  } catch (e) {
    falhas += 1
    console.log(`  FALHA recusa: ${desc} — lançou exceção (${e.message}); deveria devolver null`)
    return
  }
  if (r === null) console.log(`  PASS  recusa: ${desc}`)
  else { falhas += 1; console.log(`  FALHA recusa: ${desc} — ENTROU como ${r.email}`) }
}

console.log('\n── Token legítimo ──')
const claims = await aceita('token bem formado deste projeto', tokenValido())
total += 1
if (claims?.email === 'fulano@sebratel.com.br' && claims?.uid === 'uid-123' && claims?.name === 'Fulano de Tal') {
  console.log('  PASS  claims devolvidas (email, uid, nome)')
} else { falhas += 1; console.log(`  FALHA claims erradas: ${JSON.stringify(claims)}`) }

total += 1
const naoVerificado = await verifyFirebaseIdToken(tokenValido({ email_verified: false }))
if (naoVerificado && naoVerificado.emailVerified === false) {
  console.log('  PASS  e-mail não verificado chega marcado (a rota é quem barra)')
} else { falhas += 1; console.log(`  FALHA email_verified=false não foi sinalizado: ${JSON.stringify(naoVerificado)}`) }

console.log('\n── Fraudes de assinatura ──')
{
  // alg:none — a mais clássica: sem assinatura, esperando que o servidor
  // obedeça ao cabeçalho.
  const h = { alg: 'none', kid: KID, typ: 'JWT' }
  await recusa('alg: none (sem assinatura)', `${b64(h)}.${b64(payloadValido())}.`)

  // HS256 assinado com a CHAVE PÚBLICA como segredo — o ataque de confusão de
  // algoritmo. Só funciona se o servidor escolher o algoritmo pelo cabeçalho.
  const h2 = { alg: 'HS256', kid: KID, typ: 'JWT' }
  const corpo = `${b64(h2)}.${b64(payloadValido())}`
  const hs = createHmac('sha256', certificado).update(corpo).digest('base64url')
  await recusa('HS256 assinado com a chave pública', `${corpo}.${hs}`)

  // Payload trocado DEPOIS de assinado.
  const bom = tokenValido()
  const [hdr, , sig] = bom.split('.')
  const adulterado = `${hdr}.${b64(payloadValido({ email: 'invasor@sebratel.com.br' }))}.${sig}`
  await recusa('payload adulterado depois da assinatura', adulterado)

  // Assinado por OUTRA chave (o certificado no cache não confere).
  const outra = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const corpo3 = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64(payloadValido())}`
  const sig3 = createSign('RSA-SHA256').update(corpo3).sign(outra)
  await recusa('assinado por chave que não é a do Google', `${corpo3}.${Buffer.from(sig3).toString('base64url')}`)
}

console.log('\n── Emissor, público e validade ──')
await recusa('aud de outro projeto Firebase', tokenValido({ aud: 'authentication-outro-sistema' }))
await recusa('iss de outro projeto Firebase', tokenValido({ iss: 'https://securetoken.google.com/authentication-outro-sistema' }))
await recusa('iss de domínio qualquer', tokenValido({ iss: 'https://exemplo.com/' }))
await recusa('expirado', tokenValido({ exp: agora() - 60 }))
await recusa('sem exp', tokenValido({ exp: undefined }))
await recusa('iat muito no futuro (relógio adulterado)', tokenValido({ iat: agora() + 3600 }))
await recusa('sem sub (token sem dono)', tokenValido({ sub: undefined }))
await recusa('sem email', tokenValido({ email: undefined }))

console.log('\n── Forma do token e certificados ──')
await recusa('kid desconhecido', tokenValido({}, { kid: 'kid-que-nao-existe' }))
await recusa('sem kid no cabeçalho', tokenValido({}, { kid: undefined }))
await recusa('string vazia', '')
await recusa('não é JWT (2 partes)', 'abc.def')
await recusa('base64 inválido no payload', `${b64({ alg: 'RS256', kid: KID })}.%%%.zzz`)

console.log('\n── Sem projeto configurado ──')
{
  const antes = process.env.FIREBASE_PROJECT_ID
  process.env.FIREBASE_PROJECT_ID = ''
  await recusa('FIREBASE_PROJECT_ID ausente recusa TUDO', tokenValido())
  process.env.FIREBASE_PROJECT_ID = antes
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${total - falhas}/${total} checagens passaram`)
process.exit(falhas ? 1 : 0)
