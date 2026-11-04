// ─────────────────────────────────────────────────────────────────────────
// Cifra simétrica para segredos que precisam ficar em disco — hoje só os
// tokens da API pública do Data Hub (server/lakehouseSources.mjs). AES-256-GCM
// não só cifra: autentica. Uma alteração no arquivo cifrado é detectada na
// decifra (erro), em vez de devolver lixo silenciosamente.
//
// A chave vem de SECRETS_KEY (qualquer texto — é derivada pra 32 bytes com
// sha256). Sem essa env, uma chave aleatória é gerada em data/.secret-key na
// primeira vez e reusada dali em diante: como `data/` é o MESMO volume nos
// serviços `backend` e `scheduler` (ver docker-compose.portainer.yml), os dois decifram o mesmo
// token sem precisar de configuração nenhuma. Defina SECRETS_KEY quando
// quiser controlar a chave de fora (rotação, ou compartilhar entre
// ambientes) — trocar a chave invalida os tokens já salvos, que precisam ser
// recadastrados na tela.
//
// Formato do texto cifrado: `v1:<iv b64>:<tag b64>:<cifra b64>` — uma string
// só, pra caber num campo de JSON como qualquer outro.
// ─────────────────────────────────────────────────────────────────────────
import { logger } from './logger.mjs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const KEY_FILE = process.env.SECRETS_KEY_PATH
  ? resolve(process.env.SECRETS_KEY_PATH)
  : resolve(process.cwd(), 'data/.secret-key')

let cachedKey = null

// Lê (ou cria) o material da chave. Concorrência: api e etl podem subir ao
// mesmo tempo e tentar gerar o arquivo juntos — por isso a escrita usa
// flag 'wx' (falha se já existir) e, nesse caso, relê o que o outro gravou.
function keyMaterial() {
  if (process.env.SECRETS_KEY) return process.env.SECRETS_KEY
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, 'utf8')
  const generated = randomBytes(32).toString('base64')
  try {
    mkdirSync(dirname(KEY_FILE), { recursive: true })
    writeFileSync(KEY_FILE, generated, { encoding: 'utf8', flag: 'wx' })
    try { chmodSync(KEY_FILE, 0o600) } catch { /* FS sem suporte a permissão (Windows) — segue */ }
    logger.info(`[secret-box] chave gerada em ${KEY_FILE} (defina SECRETS_KEY para controlar de fora)`)
    return generated
  } catch (e) {
    if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, 'utf8')
    throw new Error(`Não foi possível criar a chave de cifra em ${KEY_FILE} (${e.message}). Defina SECRETS_KEY.`)
  }
}

function key() {
  if (!cachedKey) cachedKey = createHash('sha256').update(keyMaterial()).digest()
  return cachedKey
}

export function encryptSecret(plain) {
  const text = String(plain ?? '')
  if (!text) throw new Error('Nada para cifrar (segredo vazio).')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

export function decryptSecret(packed) {
  const parts = String(packed ?? '').split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Segredo guardado em formato desconhecido.')
  }
  const [, ivB, tagB, ctB] = parts
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    // Chave trocada (SECRETS_KEY diferente / data/.secret-key perdido) ou
    // arquivo adulterado. A mensagem é genérica de propósito: este módulo é
    // usado por mais de um consumidor (tokens do Data Hub e sessões de login),
    // e cada um sabe qual é a saída no seu caso — quem quiser orientar o
    // usuário envolve este erro com o próprio texto.
    throw new Error('Não foi possível decifrar um segredo guardado (a chave de cifra mudou?).')
  }
}

// Versão exibível de um segredo: só o começo e o fim, o suficiente pra pessoa
// reconhecer qual token está ali sem que ele volte inteiro pro navegador.
export function maskSecret(plain) {
  const text = String(plain ?? '')
  if (text.length <= 12) return '••••'
  return `${text.slice(0, 5)}…${text.slice(-4)}`
}
