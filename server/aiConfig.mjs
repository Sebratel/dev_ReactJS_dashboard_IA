// ─────────────────────────────────────────────────────────────────────────
// Configuração da IA — provedor, credencial, modelo e limites — guardada NO
// SERVIDOR (data/aiConfig.json) e editável na tela de Configurações.
//
// POR QUE SAIU DO .env: trocar de provedor, de modelo ou de orçamento exigia
// editar o .env e reiniciar a API — no Portainer, um redeploy da stack. Quem
// administra a ferramenta não tem (nem deveria ter) acesso ao arquivo de
// ambiente do container. Aqui a mesma decisão é um formulário.
//
// A CREDENCIAL DE CADA PROVEDOR é cifrada em repouso (server/secretBox.mjs),
// mesmo padrão dos tokens do Data Hub — um vazamento do volume `data` não
// entrega a chave sem a chave de cifra. E ela NUNCA volta inteira pro
// navegador: a tela recebe só a versão mascarada (maskSecret).
//
// NADA DE IA VEM MAIS DO .env. Houve uma fase de transição em que
// ANTHROPIC_API_KEY/AI_MODEL/AI_EFFORT/... valiam como semente enquanto não
// existisse arquivo salvo; a pedido (10/09/2026), essas variáveis saíram do
// ambiente e o app parou de lê-las. Motivo: semente é uma segunda fonte de
// verdade para a mesma decisão — dois lugares onde procurar "qual modelo está
// rodando", e um deles mentindo assim que alguém salva pela tela.
//
// Consequência aceita: instalação nova sobe com a IA NÃO CONFIGURADA, e alguém
// precisa cadastrar o provedor na tela. É explícito e visível (a tela avisa),
// ao contrário de uma chave herdada de um arquivo de ambiente que ninguém
// lembra de ter preenchido.
//
// Uma chave POR PROVEDOR (e não uma só, sobrescrita a cada troca): alternar
// entre dois provedores pra comparar custo é o caso de uso real, e
// recadastrar a credencial a cada ida e volta transformaria a comparação num
// trabalho manual.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { encryptSecret, decryptSecret, maskSecret } from './secretBox.mjs'

const STORE_PATH = process.env.AI_CONFIG_PATH
  ? resolve(process.env.AI_CONFIG_PATH)
  : resolve(process.cwd(), 'data/aiConfig.json')

// ─── Catálogo de provedores ────────────────────────────────────────────
// `models` são SUGESTÕES pra tela, não uma lista fechada: o campo de modelo
// aceita texto livre, porque catálogo de modelo muda mais rápido que release
// de app — travar numa lista transformaria "lançaram um modelo novo" em
// "preciso de deploy". O botão "Testar" da tela é quem confirma se o id vale.
//
// `price` é o preço por milhão de tokens, e é EDITÁVEL na tela pelo mesmo
// motivo: preço de API muda, e um número velho aqui não daria erro nenhum —
// daria um medidor de gasto mentindo com confiança, que é pior. O que está
// aqui é só o valor inicial de um modelo conhecido.
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    keyLabel: 'Chave da API (sk-ant-…)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-5',
    // Esforço e cache de prompt são os dois controles que mais mexem no custo
    // desta feature — e só existem aqui.
    supportsEffort: true,
    supportsPromptCache: true,
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5', price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
    ],
  },
  openai: {
    label: 'OpenAI',
    keyLabel: 'Chave da API (sk-…)',
    keyUrl: 'https://platform.openai.com/api-keys',
    // Sem padrão embutido de propósito: qualquer id que eu fixasse aqui
    // envelheceria em silêncio. Quem liga o provedor informa o modelo e
    // confirma no "Testar".
    defaultModel: '',
    supportsEffort: false,
    supportsPromptCache: false,
    models: [],
  },
  gemini: {
    label: 'Google Gemini',
    keyLabel: 'Chave da API (AIza…)',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: '',
    supportsEffort: false,
    supportsPromptCache: false,
    models: [],
  },
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

function priceFor(provider, model) {
  const known = (PROVIDERS[provider]?.models ?? []).find((m) => m.id === model)
  // Modelo sem preço conhecido: zero, e não um chute. Zero deixa o medidor
  // explicitamente em US$ 0,00 e a tela avisa que falta preencher — melhor
  // que um valor plausível e errado somando dinheiro que ninguém gastou.
  return known?.price ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
}

// Estado inicial de uma instalação que nunca foi configurada. Tudo daqui é
// padrão de CÓDIGO — nenhuma variável de ambiente é consultada.
//
// `model` nasce VAZIO de propósito, inclusive para a Anthropic: um modelo
// pré-escolhido junto com "nenhuma credencial" produz uma tela que parece
// configurada e não é. Vazio, a tela pede o que falta.
function padrao() {
  return {
    provider: 'anthropic',
    model: '',
    effort: 'high',
    maxTokens: 16000,
    maxIterations: 14,
    dailyBudgetUsd: 5,
    price: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    // Endpoint alternativo por provedor. Vazio = endpoint oficial. Existe por
    // dois motivos concretos: gateway corporativo/proxy (o firewall daqui já
    // derrubou integração antes) e serviço compatível com a API da OpenAI, que
    // é o caminho comum pra rodar modelo próprio. Não é segredo — vai em claro.
    baseUrls: { anthropic: '', openai: '', gemini: '' },
    keys: { anthropic: null, openai: null, gemini: null },
    updatedAt: null,
    updatedBy: null,
  }
}

let cache = null

function load() {
  if (cache) return cache
  if (!existsSync(STORE_PATH)) { cache = padrao(); return cache }
  try {
    const saved = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    // Mescla com o padrão: campo que não existe no arquivo (porque foi
    // acrescentado depois) cai no padrão em vez de virar undefined lá dentro
    // do laço de tool use, longe daqui.
    const base = padrao()
    cache = {
      ...base, ...saved,
      keys: { ...base.keys, ...(saved.keys ?? {}) },
      baseUrls: { ...base.baseUrls, ...(saved.baseUrls ?? {}) },
    }
    return cache
  } catch (e) {
    // Config ilegível não pode derrubar a API: a IA é uma feature, e o resto
    // do app (dashboards, fontes, acessos) não depende dela. Cai no padrão,
    // que é "não configurada" — a tela diz isso, e o arquivo pode ser
    // regravado ali mesmo.
    console.error(`[ai-config] arquivo ilegível (${e.message}) — tratando como não configurada`)
    cache = padrao()
    return cache
  }
}

function persist(next) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), 'utf8')
  cache = next
}

// Config resolvida para uso INTERNO do servidor — inclui a credencial em
// claro. Nunca serializar isto numa resposta HTTP.
export function aiConfig() {
  const c = load()
  let apiKey = null
  const packed = c.keys?.[c.provider] ?? null
  if (packed) {
    try {
      apiKey = decryptSecret(packed)
    } catch (e) {
      // Chave de cifra trocada (SECRETS_KEY diferente, ou volume novo): a
      // credencial salva é inutilizável. Vale como ausente — a tela dirá que
      // a IA não está configurada e pede o recadastro, que é a única saída.
      console.error(`[ai-config] credencial de ${c.provider} ilegível (${e.message}) — recadastre na tela`)
    }
  }
  // `baseUrl` resolvido pro provedor ativo: o adaptador não precisa saber que
  // existe um mapa por provedor.
  return { ...c, apiKey, baseUrl: c.baseUrls?.[c.provider] || '' }
}

// Versão para a TELA: sem credencial em claro, com a máscara e com o catálogo
// que o formulário precisa pra se montar.
export function aiConfigPublic() {
  const c = load()
  const masked = {}
  for (const p of Object.keys(PROVIDERS)) {
    const packed = c.keys?.[p] ?? null
    if (!packed) { masked[p] = null; continue }
    try {
      masked[p] = maskSecret(decryptSecret(packed))
    } catch {
      // Ilegível: a tela precisa saber que existe algo salvo E que está
      // quebrado. Sem isso o usuário vê "sem chave", cadastra de novo e não
      // entende por que continua sem funcionar.
      masked[p] = 'ilegível'
    }
  }
  return {
    provider: c.provider,
    model: c.model,
    effort: c.effort,
    maxTokens: c.maxTokens,
    maxIterations: c.maxIterations,
    dailyBudgetUsd: c.dailyBudgetUsd,
    price: c.price,
    baseUrls: c.baseUrls,
    keyMasks: masked,
    updatedAt: c.updatedAt,
    updatedBy: c.updatedBy,
    // Fonte da verdade do formulário: o servidor descreve os provedores, a
    // tela só desenha. Evita a lista existir em dois lugares e divergir.
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, {
      label: p.label, keyLabel: p.keyLabel, keyUrl: p.keyUrl, defaultModel: p.defaultModel,
      supportsEffort: p.supportsEffort, supportsPromptCache: p.supportsPromptCache, models: p.models,
    }])),
    effortLevels: EFFORT_LEVELS,
  }
}

function num(value, { min, max, fallback }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Grava a configuração. `patch` vem da tela e é validado campo a campo — o
 * que não vier fica como está.
 *
 * `apiKey` só é gravada quando vem DEFINIDA: a tela devolve a máscara no
 * lugar da chave quando o usuário não a alterou, e gravar a máscara seria
 * destruir a credencial em silêncio. String vazia é o gesto explícito de
 * REMOVER a chave daquele provedor.
 */
export function saveAiConfig(patch = {}, { email = null } = {}) {
  const current = load()
  const provider = patch.provider ?? current.provider
  if (!PROVIDERS[provider]) throw new Error(`Provedor desconhecido: ${provider}.`)

  const model = String(patch.model ?? current.model ?? '').trim()
  // Modelo é obrigatório: sem ele a primeira chamada falharia no provedor,
  // com uma mensagem dele, e não aqui, onde dá pra dizer o que fazer.
  if (!model) throw new Error('Informe o modelo do provedor (ex.: claude-opus-5).')

  const effort = patch.effort ?? current.effort
  if (!EFFORT_LEVELS.includes(effort)) throw new Error(`Esforço inválido: ${effort}.`)

  const baseUrls = { ...current.baseUrls }
  if (patch.baseUrl !== undefined) {
    const url = String(patch.baseUrl ?? '').trim()
    // Validado na entrada: uma URL torta aqui só apareceria como erro de rede
    // na primeira conversa, longe de quem digitou.
    if (url && !/^https?:\/\//i.test(url)) throw new Error('O endpoint deve começar com http:// ou https://.')
    // Sem barra no fim: o adaptador concatena o caminho, e `//chat/completions`
    // devolve 404 em alguns gateways.
    baseUrls[provider] = url.replace(/\/+$/, '')
  }

  const keys = { ...current.keys }
  if (patch.apiKey !== undefined) {
    const raw = String(patch.apiKey ?? '').trim()
    keys[provider] = raw ? encryptSecret(raw) : null
  }

  // Preço: aceita o que a tela mandar (é editável de propósito) e cai no
  // preço conhecido do modelo quando a tela não manda nada.
  const known = priceFor(provider, model)
  const price = {
    input: num(patch.price?.input, { min: 0, max: 10000, fallback: known.input }),
    output: num(patch.price?.output, { min: 0, max: 10000, fallback: known.output }),
    cacheWrite: num(patch.price?.cacheWrite, { min: 0, max: 10000, fallback: known.cacheWrite }),
    cacheRead: num(patch.price?.cacheRead, { min: 0, max: 10000, fallback: known.cacheRead }),
  }

  const next = {
    provider,
    model,
    effort,
    maxTokens: num(patch.maxTokens, { min: 2000, max: 128000, fallback: current.maxTokens }),
    maxIterations: num(patch.maxIterations, { min: 3, max: 40, fallback: current.maxIterations }),
    dailyBudgetUsd: num(patch.dailyBudgetUsd, { min: 0, max: 10000, fallback: current.dailyBudgetUsd }),
    price,
    baseUrls,
    keys,
    updatedAt: new Date().toISOString(),
    updatedBy: email,
  }
  persist(next)
  return aiConfigPublic()
}

// Preço conhecido de um modelo — a tela usa pra preencher os campos ao trocar
// de modelo, sem repetir a tabela no front.
export function knownPriceFor(provider, model) {
  return priceFor(provider, model)
}

// Credencial salva de UM provedor, mesmo que não seja o ativo. Existe para o
// "Testar" da tela: testar a chave já salva sem obrigar a pessoa a redigitá-la
// (ela nunca volta pro navegador, então redigitar seria a única alternativa).
export function apiKeyFor(provider) {
  const packed = load().keys?.[provider] ?? null
  if (!packed) return null
  try {
    return decryptSecret(packed)
  } catch {
    return null
  }
}

export function isAiConfigured() {
  const c = aiConfig()
  return !!c.apiKey && !!c.model
}
