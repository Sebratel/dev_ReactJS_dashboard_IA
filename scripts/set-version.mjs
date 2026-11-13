// Muda a versão da aplicação em TODOS os lugares de uma vez: package.json,
// package-lock.json e o valor padrão ${APP_VERSION:-X.Y.Z} do compose (é ele que o
// Portainer mostra na tag da imagem). Uso: npm run version:set -- 1.2.3
// O CI (.github/scripts/validate-version.py) reprova se os três divergirem ou se a
// versão não for MAIOR que a da branch de destino.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nova = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(nova ?? '')) {
  console.error('Uso: npm run version:set -- X.Y.Z   (ex.: 1.2.3, sem -beta nem -SNAPSHOT)')
  process.exit(1)
}
const ler = (f) => readFileSync(resolve(raiz, f), 'utf8')
const gravar = (f, t) => writeFileSync(resolve(raiz, f), t)
const eol = (t) => (t.includes('\r\n') ? '\r\n' : '\n')

// Troca só a primeira ocorrência "version": "..." (a do próprio pacote) — preserva a formatação do arquivo.
const trocaPrimeira = (t) => t.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${nova}$2`)
gravar('package.json', trocaPrimeira(ler('package.json')))

let lock = ler('package-lock.json')
lock = trocaPrimeira(lock) // topo
lock = lock.replace(/("packages":\s*\{\s*"":\s*\{[^}]*?"version":\s*")\d+\.\d+\.\d+(")/, `$1${nova}$2`)
gravar('package-lock.json', lock)

const f = 'docker-compose.portainer.yml'
const antes = ler(f)
const depois = antes.replace(/APP_VERSION:-\d+\.\d+\.\d+\}/g, `APP_VERSION:-${nova}}`)
gravar(f, depois)
void eol
console.log(`Versão ${nova} gravada em package.json, package-lock.json e ${f} (${(antes.match(/APP_VERSION:-/g) || []).length} ocorrências).`)
