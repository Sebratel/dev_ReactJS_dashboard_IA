// ─────────────────────────────────────────────────────────────────────────
// Varredura ESTÁTICA de segurança do repositório. Roda com: npm run security:scan
// Rápida (sem rede, sem subir nada) — é o primeiro portão do CI.
//
// Falha (exit 1) quando encontra:
//  - segredo no código versionado (chave de API, token, chave privada, senha
//    atribuída a literal), sem mostrar o valor — só arquivo:linha;
//  - arquivo que nunca deveria estar no git (.env, chave privada, aiConfig);
//  - AUTH_DISABLED ligado em qualquer arquivo versionado;
//  - Dockerfile que roda como root ou compose sem healthcheck/limite de memória;
//  - docker-compose com `container_name` ou sem `name:`;
//  - rota nova que devolve `err.stack`.
//
// O que NÃO varre: node_modules/ e dist/ (versionados neste repositório, mas são
// de terceiros / gerados) e o histórico do git.
// ─────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const achados = []
const avisos = []
const falha = (arq, linha, msg) => achados.push(`${arq}${linha ? `:${linha}` : ''} — ${msg}`)

const arquivos = execFileSync('git', ['ls-files', '-z'], { cwd: RAIZ, maxBuffer: 1 << 28 })
  .toString().split('\0').filter(Boolean)
  .filter((f) => !f.startsWith('node_modules/') && !f.startsWith('dist/') && !f.startsWith('loadtest/out'))

// 1) Arquivos que não podem estar versionados.
const PROIBIDOS = [
  [/(^|\/)\.env($|\.(?!example$))/, 'arquivo de ambiente versionado'],
  [/\.(pem|key|p12|pfx|jks)$/i, 'chave/certificado privado versionado'],
  [/(^|\/)data\/(aiConfig\.json|\.secret-key|sessions\.json|lakehouseSources\.json)$/, 'segredo de runtime versionado'],
  [/(^|\/)id_(rsa|ed25519)/, 'chave SSH versionada'],
]
for (const f of arquivos) for (const [re, msg] of PROIBIDOS) if (re.test(f)) falha(f, 0, msg)

// 2) Segredos no conteúdo (só texto, só arquivos de código/config/doc).
const TEXTO = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yml', '.yaml', '.md', '.conf', '.env', '.example', '.html', '.css', '', '.sh', '.py', '.txt'])
const PADROES = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'chave privada'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'chave de API do Google'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'chave da Anthropic'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'chave estilo OpenAI'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'token do GitHub'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'token do Slack'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'chave de acesso AWS'],
  [/\bdhub_[A-Za-z0-9]{24,}\b/, 'token do Data Hub'],
  [/https:\/\/[^\s"']*\/api\/webhooks\/[A-Za-z0-9-]{20,}/, 'URL de webhook (é segredo: quem a tem dispara deploy)'],
  [/(passw(or)?d|senha|secret|api[_-]?key)\s*[:=]\s*['"][^'"$\s{][^'"\s]{7,}['"]/i, 'credencial atribuída a literal'],
]
// Valores que são claramente exemplo/placeholder/teste.
const PLACEHOLDER = /(exemplo|example|placeholder|ficticio|fictício|teste|test|fake|changeme|xxxx|\.\.\.|your[_-]|seu[_-]|<[^>]+>)/i
for (const f of arquivos) {
  if (!TEXTO.has(extname(f).toLowerCase())) continue
  if (/^(loadtest|scripts)\/.*(test|harness)/.test(f) || f.startsWith('.github/scripts/') || f === 'scripts/security-scan.mjs') continue
  let txt
  try { txt = readFileSync(join(RAIZ, f), 'utf8') } catch { continue }
  if (txt.length > 2_000_000) continue
  const linhas = txt.split('\n')
  linhas.forEach((l, i) => {
    for (const [re, msg] of PADROES) {
      if (re.test(l) && !PLACEHOLDER.test(l)) falha(f, i + 1, `possível ${msg} (valor omitido)`)
    }
  })
}

// 3) AUTH_DISABLED só pode existir desligado ou comentado.
for (const f of arquivos) {
  if (!existsSync(join(RAIZ, f))) continue
  // Só config/deploy: em .md e no código a menção é a documentação do próprio bypass.
  if (!/\.example$|\.ya?ml$|(^|\/)Dockerfile/.test(f)) continue
  const txt = readFileSync(join(RAIZ, f), 'utf8')
  txt.split('\n').forEach((l, i) => {
    if (/^\s*#/.test(l) || /^\s*\/\//.test(l)) return
    if (/AUTH_DISABLED\s*[:=]\s*['"]?true/i.test(l) && f !== 'scripts/security-scan.mjs' && !/test-security|harness/.test(f)) falha(f, i + 1, 'AUTH_DISABLED=true versionado (login desligado)')
  })
}

// 4) Dockerfiles: sem root, com healthcheck.
for (const f of arquivos.filter((x) => /(^|\/)Dockerfile(\..+)?$/.test(x))) {
  const txt = readFileSync(join(RAIZ, f), 'utf8')
  // Dockerfile do frontend roda nginx (imagem oficial já dropa privilégios nos workers) — a regra de USER vale para o da API.
  if (/FROM node:/.test(txt) && !/FROM nginx/.test(txt) && !/^USER\s+(?!root)/m.test(txt)) falha(f, 0, 'imagem de runtime Node sem USER não-root')
  if (!/^HEALTHCHECK/m.test(txt)) falha(f, 0, 'sem HEALTHCHECK')
  if (/FROM\s+\S+:latest\b/.test(txt)) falha(f, 0, 'imagem base com tag :latest (fixe a versão)')
  if (/^(ARG|ENV)\s+\w*(SECRET|PASSWORD|TOKEN|PRIVATE)\w*/im.test(txt)) falha(f, 0, 'segredo em ARG/ENV de build (vai para a camada da imagem)')
}

// 5) Compose: regras de nomenclatura/ambiente ficam em .github/scripts/validate-compose.py;
//    aqui só o que é segurança.
for (const f of arquivos.filter((x) => /docker-compose.*\.ya?ml$/.test(x))) {
  const txt = readFileSync(join(RAIZ, f), 'utf8')
  if (/^\s*container_name:/m.test(txt)) falha(f, 0, 'container_name fixo (colide entre stacks de staging e produção)')
  if (!/^name:\s*\S+/m.test(txt)) falha(f, 0, 'sem `name:` no topo')
  if (/privileged:\s*true/.test(txt)) falha(f, 0, 'container privilegiado')
  if (/\/var\/run\/docker\.sock/.test(txt)) falha(f, 0, 'monta o socket do Docker')
  if (/network_mode:\s*['"]?host/.test(txt)) falha(f, 0, 'network_mode: host')
  if (!/memory:\s*\S+|mem_limit:/.test(txt)) falha(f, 0, 'nenhum limite de memória')
  for (const m of txt.matchAll(/^\s*-\s*["']?(\d+):(\d+)["']?\s*$/gm)) falha(f, 0, `porta fixa ${m[1]}:${m[2]} (parametrize com \${VAR})`)
}

// 6) Código do servidor: nada de devolver stack ao cliente.
for (const f of arquivos.filter((x) => x.startsWith('server/') && x.endsWith('.mjs'))) {
  readFileSync(join(RAIZ, f), 'utf8').split('\n').forEach((l, i) => {
    if (/res\.(json|send)\([^)]*\.stack/.test(l)) falha(f, i + 1, 'devolve stack trace ao cliente')
    if (/\beval\s*\(|new Function\s*\(/.test(l) && !/^\s*\/\//.test(l)) falha(f, i + 1, 'eval/new Function')
    if (/child_process/.test(l) && /exec\(/.test(l) && !/execFile/.test(l)) avisos.push(`${f}:${i + 1} — exec() de shell: confira se há entrada do usuário`)
  })
}

// 7) Dependências: avisa se o lock não existe (npm ci falharia no build).
if (!existsSync(join(RAIZ, 'package-lock.json'))) falha('package-lock.json', 0, 'ausente: o build usa `npm ci`')

for (const a of avisos) console.log(`aviso: ${a}`)
if (achados.length) {
  console.error(`\nsecurity-scan: ${achados.length} achado(s):\n`)
  for (const a of achados) console.error(`  ✗ ${a}`)
  process.exit(1)
}
console.log(`security-scan: ${arquivos.length} arquivos versionados verificados, nenhum achado.`)
