// ─────────────────────────────────────────────────────────────────────────
// Harness compartilhado pelos testes de carga (loadtest/) e de segurança
// (scripts/test-security.mjs): sobe a API REAL (server/index.mjs, o mesmo
// código do container) numa pasta temporária, com dados inventados e login de
// verdade — sem AUTH_DISABLED, sem rede de fora, sem tocar em data/.
//
// Como o login funciona sem o Google: gera-se um par de chaves, grava-se o
// certificado no cache em disco que o servidor já usa (FIREBASE_CERTS_PATH) e
// assinam-se ID tokens RS256 com a chave privada. O servidor os valida pelo
// MESMO caminho de produção (assinatura, iss, aud, exp, domínio) e abre a
// sessão por cookie de verdade.
// ─────────────────────────────────────────────────────────────────────────
import { spawn, execFileSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
export const RAIZ = resolve(AQUI, '..', '..')
export const PROJETO = 'authentication-projeto-de-carga'
export const DOMINIO = 'sebratel.com.br'
export const ADMIN_EMAIL = `admin.carga@${DOMINIO}`
const KID = 'kid-de-carga'

// ─── Dados inventados (semente fixa: o mesmo dado em toda execução) ────────
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const p2 = (n) => String(n).padStart(2, '0')
const stamp = (ms) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
}

export function gerarProtocolos(n) {
  const r = rng(20261101)
  const pick = (l) => l[Math.floor(r() * l.length)]
  const STATUS = ['Concluído', 'Concluído', 'Concluído', 'Em andamento', 'Cancelado', 'Aguardando cliente']
  const CIDADES = ['Porto Alegre', 'Canoas', 'Gravataí', 'Viamão', 'Cachoeirinha', 'Novo Hamburgo', 'São Leopoldo']
  const INICIO = Date.UTC(2025, 0, 1)
  const FIM = Date.UTC(2026, 9, 31, 23, 59, 59)
  return Array.from({ length: n }, (_, i) => ({
    Protocolo: `P${100000 + i}`,
    'Data abertura': stamp(INICIO + Math.floor(r() * (FIM - INICIO))),
    Status: pick(STATUS),
    Cidade: pick(CIDADES),
    Base: `B${1 + Math.floor(r() * 6)}`,
    Valor: Math.round(r() * 100000) / 100,
    Cliente: `C${1 + Math.floor(r() * 5000)}`,
    Prioridade: 1 + Math.floor(r() * 4),
  }))
}

// ─── Token assinado ────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const agora = () => Math.floor(Date.now() / 1000)

export function assinarToken(chavePrivada, email, extra = {}, header = {}) {
  const payload = {
    iss: `https://securetoken.google.com/${PROJETO}`,
    aud: PROJETO,
    sub: `uid-${email}`,
    email,
    email_verified: true,
    name: email.split('@')[0],
    iat: agora() - 30,
    exp: agora() + 3600,
    ...extra,
  }
  const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT', ...header })
  const corpo = `${h}.${b64(payload)}`
  const sig = createSign('RSA-SHA256').update(corpo).sign(chavePrivada).toString('base64url')
  return `${corpo}.${sig}`
}

// ─── Processo ──────────────────────────────────────────────────────────────
async function esperarSaude(base, ms = 30_000) {
  const ate = Date.now() + ms
  while (Date.now() < ate) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    } catch { /* ainda subindo */ }
    await new Promise((ok) => setTimeout(ok, 150))
  }
  throw new Error('a API não ficou saudável a tempo')
}

function portaLivre() {
  return new Promise((ok, falha) => {
    const s = createServer()
    s.on('error', falha)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) })
  })
}

// Roda em processo à parte para o env do harness não vazar para o chamador, e
// grava catálogo, snapshot e workspace pelos MESMOS módulos do servidor.
const PREPARO = `
import { writeFileSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
const { join } = await import('node:path')
const entrada = JSON.parse(readFileSync(process.env.PREP_IN, 'utf8'))
const m = (n) => import(pathToFileURL(join(entrada.raiz, 'server', n)).href)
const lake = await m('lakehouseSources.mjs')
const ws = await m('workspace.mjs')
const src = lake.createLakehouseSource({ label: 'Protocolos (carga)', baseUrl: 'http://127.0.0.1:9', datasetSlug: 'protocolos', token: 'dhub_token_ficticio', readMode: 'copy' }, entrada.admin)
const chave = lake.sourceKey(src.id)
writeFileSync(process.env.SNAPSHOT_PATH, gzipSync(Buffer.from(JSON.stringify({ meta: { generatedAt: new Date().toISOString() }, data: { [chave]: entrada.linhas } }))))
const aberta = ws.createFolder({ name: 'Carga (aberta)' }, entrada.admin)
const dashA = ws.createDashboard(aberta.id, { name: 'Painel de carga' }, entrada.admin)
const restrita = ws.createFolder({ name: 'Restrita' }, entrada.admin)
ws.setFolderAccess(restrita.id, [entrada.admin], entrada.admin)
const dashR = ws.createDashboard(restrita.id, { name: 'Painel restrito' }, entrada.admin)
console.log('FIXOS=' + JSON.stringify({ chave, abertaId: aberta.id, dashId: dashA.id, tabId: dashA.tabs[0].id, restritaId: restrita.id, dashRestritaId: dashR.id }))
`

/**
 * Sobe a API real e devolve utilitários de teste.
 * @param {object} o
 * @param {number} [o.rows]    linhas do dataset sintético (padrão 50 000)
 * @param {number} [o.heapMb]  --max-old-space-size do processo (padrão 1024, como o compose)
 * @param {object} [o.env]     variáveis extras para o servidor
 */
export async function iniciarHarness({ rows = 50_000, heapMb = 1024, env = {}, verboso = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ind-harness-'))
  const caminhos = {
    LAKEHOUSE_SOURCES_PATH: join(dir, 'lakehouseSources.json'),
    SNAPSHOT_PATH: join(dir, 'installData.data'),
    SNAPSHOT_OUT: join(dir, 'installData.data'),
    SHEET_SOURCES_PATH: join(dir, 'sheetSources.json'),
    FIELD_DICTIONARY_PATH: join(dir, 'fieldDictionary.json'),
    WIDGET_COMMENTS_PATH: join(dir, 'widgetComments.json'),
    WORKSPACE_PATH: join(dir, 'workspace.json'),
    ACCESS_USERS_PATH: join(dir, 'users.json'),
    ACCESS_LOG_PATH: join(dir, 'audit-log.json'),
    ACCESS_REQUESTS_PATH: join(dir, 'accessRequests.json'),
    SESSIONS_PATH: join(dir, 'sessions.json'),
    AI_CONFIG_PATH: join(dir, 'aiConfig.json'),
    SECRETS_KEY_PATH: join(dir, '.secret-key'),
    FIREBASE_CERTS_PATH: join(dir, 'certs.json'),
  }
  const envBase = {
    ...caminhos,
    SECRETS_KEY: 'chave-de-carga-somente-local',
    FIREBASE_PROJECT_ID: PROJETO,
    ALLOWED_DOMAIN: DOMINIO,
    ADMIN_EMAILS: ADMIN_EMAIL,
  }

  // 1) Par de chaves + certificado autoassinado (o formato que o Google publica).
  const keyPath = join(dir, 'k.pem')
  const certPath = join(dir, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=carga'], { stdio: 'ignore' })
  const chavePrivada = readFileSync(keyPath, 'utf8')
  writeFileSync(caminhos.FIREBASE_CERTS_PATH, JSON.stringify({ keys: { [KID]: readFileSync(certPath, 'utf8') }, fetchedAt: Date.now() }))

  // 2) Catálogo, snapshot e workspace.
  writeFileSync(join(dir, 'prep-in.json'), JSON.stringify({ raiz: RAIZ, admin: ADMIN_EMAIL, linhas: gerarProtocolos(rows) }))
  writeFileSync(join(dir, 'prep.mjs'), PREPARO)
  const saidaPrep = execFileSync(process.execPath, ['--import', 'tsx', join(dir, 'prep.mjs')], {
    cwd: RAIZ, env: { ...process.env, ...envBase, PREP_IN: join(dir, 'prep-in.json'), TZ: 'UTC' }, maxBuffer: 1 << 20,
  }).toString()
  const fixos = JSON.parse(/FIXOS=(.*)/.exec(saidaPrep)[1])

  // 3) A API de verdade.
  const porta = await portaLivre()
  const base = `http://127.0.0.1:${porta}`
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.mjs'], {
    cwd: RAIZ,
    env: {
      ...process.env, ...envBase,
      NODE_ENV: 'production',
      API_PORT: String(porta),
      // dotenv não sobrescreve o que já está no ambiente: garante que um .env
      // local com AUTH_DISABLED=true não vire "teste de carga sem login".
      AUTH_DISABLED: 'false',
      TZ: 'America/Sao_Paulo',
      NODE_OPTIONS: `--max-old-space-size=${heapMb}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  const guarda = (b) => { for (const l of b.toString().split('\n')) if (l.trim()) { log.push(l); if (log.length > 400) log.shift() } }
  child.stdout.on('data', guarda)
  child.stderr.on('data', guarda)
  let saiu = null
  child.on('exit', (code, sig) => { saiu = { code, sig, em: new Date().toISOString() } })
  try {
    await esperarSaude(base)
  } catch (e) {
    child.kill('SIGKILL')
    throw new Error(`${e.message}\n${log.join('\n')}`)
  }

  // 4) Login real.
  async function entrar(email, extra = {}) {
    const token = assinarToken(chavePrivada, email, extra)
    const r = await fetch(`${base}/api/auth/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }),
    })
    if (!r.ok) throw new Error(`login de ${email} falhou: ${r.status} ${await r.text()}`)
    const ck = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('ind_sessao='))
    if (!ck) throw new Error('o servidor não devolveu o cookie de sessão')
    return ck
  }

  const h = {
    base, dir, pid: child.pid, ...fixos,
    adminEmail: ADMIN_EMAIL, dominio: DOMINIO, linhas: rows,
    entrar,
    assinar: (email, extra, header) => assinarToken(chavePrivada, email, extra, header),
    logRecente: () => log.slice(),
    saiu: () => saiu,
    async parar() {
      if (!saiu) {
        child.kill('SIGTERM')
        await new Promise((ok) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); ok() }, 3000)
          child.on('exit', () => { clearTimeout(t); ok() })
        })
      }
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* pasta temporária; o SO limpa depois */ }
    },
  }
  if (verboso) console.log(`[harness] API em ${base} (pid ${child.pid}), ${rows} linhas, heap ${heapMb} MB`)
  return h
}

/** RSS (MB) do processo, ou null se não der para medir nesta plataforma. */
export function rssMb(pid) {
  try {
    if (process.platform === 'linux') {
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      return m ? Number(m[1]) / 1024 : null
    }
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      const m = /"([\d.,]+) K"/.exec(out)
      return m ? Number(m[1].replace(/[.,]/g, '')) / 1024 : null
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return out ? Number(out) / 1024 : null
  } catch { return null }
}
