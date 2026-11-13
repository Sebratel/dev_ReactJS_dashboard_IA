// ─────────────────────────────────────────────────────────────────────────
// Teste de carga REAL da API (server/index.mjs).
//
//   node loadtest/run.mjs smoke            # ~40 s
//   node loadtest/run.mjs load             # 10 min no ritmo do expediente
//   node loadtest/run.mjs stress           # degraus até quebrar e volta (~13 min)
//   node loadtest/run.mjs spike            # abertura simultânea (~4 min)
//   node loadtest/run.mjs abuso            # um cliente tentando derrubar a API
//   SOAK_SECONDS=3600 node loadtest/run.mjs soak
//   node loadtest/run.mjs smoke load stress   # vários, na mesma API
//
// Variáveis: ROWS (linhas do dataset, 100000), USERS (60), HEAP_MB (1024, o
// teto do compose), LOAD_SECONDS (600), SOAK_SECONDS (1800), OUT_DIR.
//
// O que roda: a API de verdade (mesmo código do container), login de verdade
// (ID token RS256 assinado com chave de teste → cookie de sessão), dataset
// sintético no snapshot, tudo numa pasta temporária que some no fim. Nunca toca
// em data/, no Data Hub nem na rede de fora.
//
// Modelo ABERTO (arrival-rate): a taxa de chegada não diminui quando a API
// fica lenta. É isso que mostra o ponto de saturação de verdade — um modelo
// fechado "freia" junto com o servidor e esconde o problema.
//
// Saída: resumo no terminal, loadtest/out/<cenário>-summary.json e
// loadtest/out/RESULTS.md. Código de saída 1 se um cenário com critério de
// aceite (smoke, load) violar algum limite.
// ─────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iniciarHarness, rssMb } from '../scripts/lib/harness.mjs'

const AQUI = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(process.env.OUT_DIR || join(AQUI, 'out'))
mkdirSync(OUT, { recursive: true })

const ROWS = Number(process.env.ROWS) || 100_000
const USERS = Number(process.env.USERS) || 60
const HEAP_MB = Number(process.env.HEAP_MB) || 1024
const LOAD_SECONDS = Number(process.env.LOAD_SECONDS) || 600
const SOAK_SECONDS = Number(process.env.SOAK_SECONDS) || 1800
// Teto de iterações simultâneas do PRÓPRIO gerador. Sem teto, a API saturada faz o gerador abrir milhares de
// conexões e esgotar as portas efêmeras do SO (EADDRNOTAVAIL) — o teste passaria a medir o cliente, não a API.
// O que passar do teto vira "descartadas" (o dropped_iterations do k6) e é relatado.
const MAX_EM_VOO = Number(process.env.MAX_EM_VOO) || 300
const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms))

// ─── Métricas ──────────────────────────────────────────────────────────────
class Metricas {
  constructor() { this.tags = new Map(); this.inesperadas = 0; this.descartadas = 0; this.iniciadas = 0; this.picoEmVoo = 0; this.emVoo = 0; this.amostrasRss = []; this.codigosRede = {} }
  tag(nome) {
    if (!this.tags.has(nome)) this.tags.set(nome, { n: 0, f5xx: 0, rede: 0, lat: [] })
    return this.tags.get(nome)
  }
  registrar(nome, status, ms) {
    const t = this.tag(nome)
    t.n++
    t.lat.push(ms)
    if (status === 0) t.rede++
    else if (status >= 500) t.f5xx++
  }
}
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = Float64Array.from(arr).sort()
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
function resumoTag(t) {
  const n = t.n || 0
  return {
    n, f5xx: t.f5xx, rede: t.rede, falhas: t.f5xx + t.rede, taxaFalha: n ? (t.f5xx + t.rede) / n : 0,
    p50: pct(t.lat, 50), p95: pct(t.lat, 95), p99: pct(t.lat, 99), max: t.lat.reduce((a, b) => (b > a ? b : a), 0),
  }
}

// ─── Cliente HTTP ──────────────────────────────────────────────────────────
function criarCliente(h, m) {
  /** Faz a requisição, mede, e conta como inesperada se o status não for o esperado. */
  async function req(tag, metodo, caminho, { cookie, corpo, esperado = [200], bruto } = {}) {
    const t0 = performance.now()
    let status = 0
    let texto = ''
    try {
      const r = await fetch(h.base + caminho, {
        method: metodo,
        headers: { ...(cookie ? { cookie } : {}), ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: corpo === undefined ? undefined : (bruto ? corpo : JSON.stringify(corpo)),
        signal: AbortSignal.timeout(60_000),
      })
      status = r.status
      texto = await r.text()
    } catch (e) { status = 0; const c = e?.cause?.code || e?.code || e?.name || "erro"; m.codigosRede[c] = (m.codigosRede[c] || 0) + 1 }
    const ms = performance.now() - t0
    m.registrar(tag, status, ms)
    if (!esperado.includes(status)) m.inesperadas++
    return { status, ms, texto }
  }
  return { req }
}

// ─── O que um usuário faz ──────────────────────────────────────────────────
function modelos(h) {
  const S = h.chave
  const W = (w) => ({ id: 'w', title: 't', source: S, ...w })
  const filtroStatus = { filter: { source: S, field: 'Status', type: 'multiselect' }, values: ['Concluído', 'Cancelado'] }
  return {
    kpi: { tag: 'w_kpi', corpo: { widget: W({ type: 'kpi' }) } },
    kpiSoma: { tag: 'w_kpi', corpo: { widget: W({ type: 'kpi', measure: { agg: 'sum', field: 'Valor' } }), tabFilters: [filtroStatus] } },
    barras: { tag: 'w_barras', corpo: { widget: W({ type: 'bar', dimensions: ['Status'], measures: [{ agg: 'count' }] }) } },
    barrasCidade: { tag: 'w_barras', corpo: { widget: W({ type: 'bar', dimensions: ['Cidade'], measures: [{ agg: 'sum', field: 'Valor' }], sort: 'asc' }), tabFilters: [filtroStatus] } },
    linhaMes: { tag: 'w_linha', corpo: { widget: W({ type: 'line', dimensions: ['month:Data abertura'], measures: [{ agg: 'count' }] }) } },
    distintos: { tag: 'w_distintos', corpo: { widget: W({ type: 'kpi', measure: { agg: 'countDistinct', field: 'Cliente' } }) } },
    tabela: (pagina) => ({ tag: 'w_tabela', corpo: { widget: W({ type: 'table', columns: ['Protocolo', 'Status', 'Cidade', 'Valor'] }), page: pagina, pageSize: 50 } }),
  }
}

const sorteia = (l) => l[Math.floor(Math.random() * l.length)]

/** Uma abertura de dashboard: árvore + dashboard + pulso + 6 widgets em paralelo. */
function criarCenas(h, m, cli, users) {
  const mod = modelos(h)
  const usuario = () => sorteia(users)
  const post = (tag, caminho, corpo, cookie) => cli.req(tag, 'POST', caminho, { cookie, corpo })

  async function abrirDashboard() {
    const { cookie } = usuario()
    await cli.req('tree', 'GET', '/api/workspace/tree', { cookie })
    await cli.req('dashboard', 'GET', `/api/workspace/folders/${h.abertaId}/dashboards/${h.dashId}`, { cookie })
    await Promise.all([
      post(mod.kpi.tag, '/api/widget-data', mod.kpi.corpo, cookie),
      post(mod.kpiSoma.tag, '/api/widget-data', mod.kpiSoma.corpo, cookie),
      post(mod.barras.tag, '/api/widget-data', mod.barras.corpo, cookie),
      post(mod.barrasCidade.tag, '/api/widget-data', mod.barrasCidade.corpo, cookie),
      post(mod.linhaMes.tag, '/api/widget-data', mod.linhaMes.corpo, cookie),
      post(mod.tabela(1 + Math.floor(Math.random() * 20)).tag, '/api/widget-data', mod.tabela(1 + Math.floor(Math.random() * 20)).corpo, cookie),
    ])
  }

  /** Ruído de fundo: o que a tela faz sozinha (heartbeat, pulso, sessão) e leituras leves. */
  async function ruido() {
    const { cookie } = usuario()
    const sorte = Math.random()
    if (sorte < 0.35) return cli.req('pulso', 'GET', `/api/workspace/folders/${h.abertaId}/dashboards/${h.dashId}/locks`, { cookie })
    if (sorte < 0.6) return cli.req('heartbeat', 'POST', '/api/access/heartbeat', { cookie, corpo: {}, esperado: [204] })
    if (sorte < 0.75) return cli.req('me', 'GET', '/api/auth/me', { cookie })
    if (sorte < 0.88) return cli.req('fontes', 'GET', `/api/sources?folderId=${h.abertaId}`, { cookie })
    return post(mod.distintos.tag, '/api/field-values', { source: h.chave, field: 'Cidade' }, cookie)
  }

  /** Interação: filtra por clique (widget de outro tipo com filtro de guia). */
  async function interagir() {
    const { cookie } = usuario()
    const b = mod.barrasCidade.corpo
    await post('w_barras', '/api/widget-data', b, cookie)
    await post(mod.distintos.tag, '/api/widget-data', mod.distintos.corpo, cookie)
  }

  /** Escrita leve: comentário em widget e remoção em seguida (o que o front faz). */
  async function comentar() {
    const { cookie } = usuario()
    const r = await post('comentar', '/api/widget-comments', { widgetId: `w-carga-${Math.floor(Math.random() * 50)}`, text: 'carga' }, cookie)
    try {
      const id = JSON.parse(r.texto)?.comment?.id
      if (id) await cli.req('comentar_del', 'DELETE', `/api/widget-comments/${encodeURIComponent(id)}`, { cookie })
    } catch { /* corpo inesperado já contado */ }
  }

  /** As barreiras não podem ceder quando a API está ocupada. */
  async function seguranca() {
    const comum = usuario().cookie
    const exp = (...s) => ({ esperado: s })
    await cli.req('seg_sem_cookie', 'GET', '/api/workspace/tree', exp(401))
    await cli.req('seg_cookie_falso', 'GET', '/api/auth/me', { cookie: 'ind_sessao=nao-existe', esperado: [401] })
    await cli.req('seg_admin_fonte', 'GET', '/api/lakehouse-sources', { cookie: comum, esperado: [403] })
    await cli.req('seg_admin_pastas', 'GET', '/api/workspace/folders', { cookie: comum, esperado: [403] })
    await cli.req('seg_pasta_restrita', 'GET', `/api/workspace/folders/${h.restritaId}/dashboards/${h.dashRestritaId}`, { cookie: comum, esperado: [403, 404] })
    await cli.req('seg_json_quebrado', 'POST', '/api/widget-data', { cookie: comum, corpo: '{"widget":', bruto: true, esperado: [400] })
    await cli.req('seg_login_ruim', 'POST', '/api/auth/session', { corpo: { idToken: 'a.b.c' }, esperado: [401] })
  }

  return { abrirDashboard, ruido, interagir, comentar, seguranca }
}

// ─── Gerador de chegadas (modelo aberto) ───────────────────────────────────
/**
 * Dispara `fn` à taxa `taxa(t)` (por segundo, t em segundos desde o início)
 * durante `duracao` segundos, sem esperar a anterior terminar. `maxEmVoo`
 * protege o PRÓPRIO gerador; o que passar disso conta como descartada.
 */
function chegadas(m, { taxa, duracao, fn, maxEmVoo = MAX_EM_VOO, abortar }) {
  return new Promise((fim) => {
    const t0 = performance.now()
    let ultimo = t0
    let credito = 0
    const pendentes = new Set()
    const passo = setInterval(() => {
      const agora = performance.now()
      const t = (agora - t0) / 1000
      if (t >= duracao || abortar?.()) {
        clearInterval(passo)
        Promise.allSettled([...pendentes]).then(fim)
        return
      }
      credito += taxa(t) * ((agora - ultimo) / 1000)
      ultimo = agora
      while (credito >= 1) {
        credito -= 1
        if (m.emVoo >= maxEmVoo) { m.descartadas++; continue }
        m.iniciadas++
        m.emVoo++
        m.picoEmVoo = Math.max(m.picoEmVoo, m.emVoo)
        const p = fn().catch(() => { m.inesperadas++ }).finally(() => { m.emVoo--; pendentes.delete(p) })
        pendentes.add(p)
      }
    }, 20)
  })
}

const rampa = (pontos) => (t) => {
  // pontos: [[segundo, taxa], ...] — interpolação linear entre eles.
  if (t <= pontos[0][0]) return pontos[0][1]
  for (let i = 1; i < pontos.length; i++) {
    if (t <= pontos[i][0]) {
      const [t0, r0] = pontos[i - 1]
      const [t1, r1] = pontos[i]
      return r0 + ((r1 - r0) * (t - t0)) / Math.max(1e-9, t1 - t0)
    }
  }
  return pontos[pontos.length - 1][1]
}
const degraus = (lista, ini) => {
  // lista: [[taxa, segundos], ...] — sobe em 10 s e segura (formato k6 "stages").
  const pts = [[0, ini]]
  let t = 0
  let r = ini
  for (const [alvo, dur] of lista) { t += dur; pts.push([t, alvo]); r = alvo }
  void r
  return { f: rampa(pts), total: t }
}

// ─── Cenários ──────────────────────────────────────────────────────────────
// Unidade da taxa: ABERTURAS de dashboard por segundo (cada uma ≈ 8 requisições).
// ~60 pessoas, cada uma abrindo/atualizando uma dashboard a cada ~1 min ≈ 1 abertura/s (load).
function perfis(c) {
  const fundo = (taxa) => (t) => taxa(t)
  return {
    smoke: {
      criterio: true,
      duracao: 30,
      fases: [
        { fn: c.abrirDashboard, taxa: () => 2 },
        { fn: c.ruido, taxa: () => 3 },
        { fn: c.interagir, taxa: () => 0.5 },
        { fn: c.comentar, taxa: () => 0.2 },
        { fn: c.seguranca, taxa: () => 0.4 },
      ],
    },
    load: {
      criterio: true,
      duracao: LOAD_SECONDS,
      fases: [
        { fn: c.abrirDashboard, taxa: () => 1 },
        { fn: c.ruido, taxa: () => 3 },
        { fn: c.interagir, taxa: () => 0.3 },
        { fn: c.comentar, taxa: () => 0.3 },
        { fn: c.seguranca, taxa: () => 0.2 },
      ],
    },
    stress: (() => {
      const d = degraus([[1, 5], [1, 55], [2, 5], [2, 55], [3, 5], [3, 55], [5, 5], [5, 55], [8, 5], [8, 55], [15, 5], [15, 55], [40, 5], [40, 55], [1, 5], [1, 175]], 1)
      return {
        criterio: false, duracao: d.total, recuperacaoAPartirDe: d.total - 120,
        fases: [
          { fn: c.abrirDashboard, taxa: d.f },
          { fn: c.ruido, taxa: (t) => 2 * d.f(t) },
          { fn: c.interagir, taxa: (t) => 0.3 * d.f(t) },
          { fn: c.seguranca, taxa: () => 0.4 },
        ],
      }
    })(),
    spike: (() => {
      const f = rampa([[0, 2], [60, 2], [70, 100], [190, 100], [200, 2], [320, 2]])
      return {
        criterio: false, duracao: 320, recuperacaoAPartirDe: 200,
        fases: [
          { fn: c.abrirDashboard, taxa: f },
          { fn: c.ruido, taxa: (t) => 2 * f(t) },
          { fn: c.seguranca, taxa: () => 0.4 },
        ],
      }
    })(),
    soak: {
      criterio: false, duracao: SOAK_SECONDS, soak: true,
      fases: [
        { fn: c.abrirDashboard, taxa: () => 1 },
        { fn: c.ruido, taxa: () => 3 },
        { fn: c.interagir, taxa: () => 0.3 },
        { fn: c.comentar, taxa: () => 0.3 },
      ],
    },
  }
}

// Limites do critério de aceite (smoke e load). No stress/spike o objetivo é
// ACHAR o limite e ver se a API se recupera; não há aprovação.
const LIMITES = {
  taxaFalhaGlobal: 0.01,
  // A API é UM processo Node: consulta de widget (CPU síncrona) e rota leve dividem o mesmo laço de
  // eventos, então o p95 das rotas leves acompanha o das consultas. Os limites são o que o usuário
  // percebe como "instantâneo" (<500 ms) e "rápido" (<1 s) — não o que a API entrega hoje.
  p95: { w_kpi: 1000, w_barras: 1000, w_linha: 1000, w_tabela: 1200, w_distintos: 1200, tree: 500, dashboard: 600, me: 500, pulso: 500, heartbeat: 500 },
  p99Widgets: 2500,
}

// ─── Execução de um cenário ────────────────────────────────────────────────
async function rodarCenario(nome, h, users) {
  // Aquecimento fora da medição: a 1ª consulta carrega e descomprime o snapshot
  // (síncrono, bloqueia o processo) e o 1º acesso de cada usuário grava users.json.
  // Em produção isso acontece uma vez, no 1º acesso após o deploy; medi-lo junto
  // com o regime normal só suja o p95. O custo do 1º acesso fica registrado em
  // `primeiroAcessoMs` no resumo.
  const aquecer = criarCenas(h, new Metricas(), criarCliente(h, new Metricas()), users)
  const tA = performance.now()
  await aquecer.abrirDashboard()
  const primeiroAcessoMs = Math.round(performance.now() - tA)
  for (let i = 0; i < 3; i++) await Promise.all([aquecer.abrirDashboard(), aquecer.ruido(), aquecer.ruido()])
  const m = new Metricas()
  const cli = criarCliente(h, m)
  const cenas = criarCenas(h, m, cli, users)
  const perfil = (nome === 'abuso' ? null : perfis(cenas)[nome])
  if (nome !== 'abuso' && !perfil) throw new Error(`cenário desconhecido: ${nome}`)

  console.log(`\n>> ${nome}: ${ROWS} linhas, ${users.length} usuários, heap ${HEAP_MB} MB`)
  let caiu = null
  const vigia = setInterval(() => {
    const s = h.saiu()
    if (s && !caiu) caiu = `API CAIU em ${s.em}: code=${s.code} sinal=${s.sig}`
  }, 1000)
  const t0 = Date.now()
  const rssIni = rssMb(h.pid)
  const amostrador = setInterval(() => {
    const v = rssMb(h.pid)
    if (v != null) m.amostrasRss.push({ t: Math.round((Date.now() - t0) / 1000), mb: Math.round(v) })
  }, 2000)
  // Sonda de saúde: latência de /api/health a cada 500 ms, sem autenticação.
  const sonda = setInterval(() => { cli.req('sonda_health', 'GET', '/api/health') }, 500)
  const abortar = () => !!caiu

  const duracao = nome === 'abuso' ? 180 : perfil.duracao
  if (nome === 'abuso') {
    const nominal = cenas.abrirDashboard
    await Promise.all([
      chegadas(m, { taxa: () => 3, duracao, fn: nominal, abortar }),
      // Um único cliente autenticado tentando degradar o caminho quente.
      chegadas(m, { taxa: () => 1, duracao: duracao - 30, fn: () => abuso(h, cli, users), abortar }),
    ])
  } else {
    await Promise.all(perfil.fases.map((f) => chegadas(m, { taxa: f.taxa, duracao, fn: f.fn, abortar })))
  }
  clearInterval(sonda); clearInterval(amostrador); clearInterval(vigia)
  const rssFim = rssMb(h.pid)

  // Ao fim a API ainda responde? (recuperação)
  const ok = await fetch(h.base + '/api/health', { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false)

  // ── Resumo
  const tags = {}
  for (const [k, v] of m.tags) tags[k] = resumoTag(v)
  const reqTotal = [...m.tags.values()].reduce((s, t) => s + t.n, 0)
  const falhas = [...m.tags.values()].reduce((s, t) => s + t.f5xx + t.rede, 0)
  const duracaoReal = (Date.now() - t0) / 1000
  const resumo = {
    cenario: nome, duracaoSeg: Math.round(duracaoReal), linhas: ROWS, usuarios: users.length, heapMb: HEAP_MB,
    requisicoes: reqTotal, reqPorSeg: +(reqTotal / duracaoReal).toFixed(1),
    falhas, taxaFalha: reqTotal ? falhas / reqTotal : 0,
    respostasInesperadas: m.inesperadas, descartadasPeloGerador: m.descartadas, picoEmVoo: m.picoEmVoo,
    rssInicialMb: rssIni && Math.round(rssIni), rssFinalMb: rssFim && Math.round(rssFim),
    rssPicoMb: m.amostrasRss.length ? Math.max(...m.amostrasRss.map((a) => a.mb)) : null,
    codigosRede: m.codigosRede, apiViva: ok && !caiu, evento: caiu, primeiroAcessoMs, tags,
  }
  // Recuperação: p95 da sonda de saúde na janela final vs. a inicial.
  if (perfil?.recuperacaoAPartirDe) {
    resumo.sondaP95Final = Math.round(pct(m.tag('sonda_health').lat.slice(-Math.round(60 * 2)), 95))
    resumo.sondaP95Inicial = Math.round(pct(m.tag('sonda_health').lat.slice(0, 60 * 2), 95))
  }
  if (perfil?.soak) {
    const metade = Math.floor(m.amostrasRss.length / 2)
    const med = (l) => (l.length ? l.reduce((s, a) => s + a.mb, 0) / l.length : 0)
    resumo.rssMediaPrimeiraMetadeMb = Math.round(med(m.amostrasRss.slice(0, metade)))
    resumo.rssMediaSegundaMetadeMb = Math.round(med(m.amostrasRss.slice(metade)))
  }

  // ── Critério de aceite
  const violacoes = []
  if (perfil?.criterio) {
    if (resumo.taxaFalha >= LIMITES.taxaFalhaGlobal) violacoes.push(`falhas ${(resumo.taxaFalha * 100).toFixed(2)}% (limite 1%)`)
    if (resumo.respostasInesperadas > 0) violacoes.push(`${resumo.respostasInesperadas} respostas inesperadas (limite 0)`)
    for (const [tag, lim] of Object.entries(LIMITES.p95)) {
      if (tags[tag] && tags[tag].p95 > lim) violacoes.push(`${tag} p95 ${tags[tag].p95.toFixed(0)} ms (limite ${lim})`)
    }
    for (const tag of Object.keys(tags).filter((k) => k.startsWith('w_'))) {
      if (tags[tag].p99 > LIMITES.p99Widgets) violacoes.push(`${tag} p99 ${tags[tag].p99.toFixed(0)} ms (limite ${LIMITES.p99Widgets})`)
    }
    if (!resumo.apiViva) violacoes.push('a API não terminou de pé')
  }
  resumo.violacoes = violacoes
  resumo.aprovado = perfil?.criterio ? violacoes.length === 0 : null
  resumo.logApi = h.logRecente().filter((l) => /error|erro|exception|fatal|heap|memory/i.test(l)).slice(-10)

  writeFileSync(join(OUT, `${nome}-summary.json`), JSON.stringify({ ...resumo, rssSerie: m.amostrasRss }, null, 2))
  imprimir(resumo)
  return resumo
}

/** Um cliente tentando degradar a API: o que a rota aberta ao usuário logado aceita. */
async function abuso(h, cli, users) {
  const { cookie } = sorteia(users)
  const S = h.chave
  const escolha = Math.random()
  if (escolha < 0.25) {
    // pageSize absurdo: o servidor tem que limitar (Math.min(200, …)).
    return cli.req('abuso_pagesize', 'POST', '/api/widget-data', { cookie, corpo: { widget: { id: 'w', title: 't', source: S, type: 'table', columns: ['Protocolo', 'Status'] }, page: 1, pageSize: 10_000_000 } })
  }
  if (escolha < 0.5) {
    // Dimensão de altíssima cardinalidade (um grupo por linha): a pior agregação possível.
    return cli.req('abuso_cardinalidade', 'POST', '/api/widget-data', { cookie, corpo: { widget: { id: 'w', title: 't', source: S, type: 'bar', dimensions: ['Protocolo'], measures: [{ agg: 'sum', field: 'Valor' }] } } })
  }
  if (escolha < 0.7) {
    // Corpo grande (até o limite de 2 MB do express.json).
    const lixo = 'x'.repeat(1_900_000)
    return cli.req('abuso_corpo_grande', 'POST', '/api/widget-comments', { cookie, corpo: { widgetId: 'w', text: lixo }, esperado: [200, 400, 413] })
  }
  if (escolha < 0.85) {
    // Corpo ACIMA do limite: tem de ser recusado (413), sem estourar memória.
    const lixo = 'x'.repeat(5_000_000)
    return cli.req('abuso_corpo_enorme', 'POST', '/api/widget-data', { cookie, corpo: { widget: lixo }, esperado: [413] })
  }
  // Tabela inteira ordenada (ordenação de todas as linhas) em loop.
  return cli.req('abuso_ordenacao', 'POST', '/api/widget-data', { cookie, corpo: { widget: { id: 'w', title: 't', source: S, type: 'table', columns: ['Protocolo', 'Valor', 'Cliente'] }, page: 1 + Math.floor(Math.random() * 3000), pageSize: 200, tableSort: { column: 'Valor', direction: 'desc' } } })
}

function imprimir(r) {
  const f = (n) => (n == null ? '—' : n)
  console.log(`   requisições: ${r.requisicoes} (${r.reqPorSeg}/s) · falhas ${(r.taxaFalha * 100).toFixed(2)}% · inesperadas ${r.respostasInesperadas} · descartadas ${r.descartadasPeloGerador}`)
  console.log(`   memória (RSS): início ${f(r.rssInicialMb)} MB · pico ${f(r.rssPicoMb)} MB · fim ${f(r.rssFinalMb)} MB`)
  console.log(`   ${'endpoint'.padEnd(22)} ${'n'.padStart(8)} ${'falha%'.padStart(7)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)}`)
  for (const [k, t] of Object.entries(r.tags).sort()) {
    console.log(`   ${k.padEnd(22)} ${String(t.n).padStart(8)} ${(t.taxaFalha * 100).toFixed(1).padStart(7)} ${t.p50.toFixed(0).padStart(7)} ${t.p95.toFixed(0).padStart(7)} ${t.p99.toFixed(0).padStart(7)} ${t.max.toFixed(0).padStart(7)}`)
  }
  if (Object.keys(r.codigosRede).length) console.log(`   erros de rede por causa: ${JSON.stringify(r.codigosRede)}`)
  if (r.evento) console.log(`   !! ${r.evento}`)
  if (r.sondaP95Final != null) console.log(`   recuperação: p95 de /api/health ${r.sondaP95Inicial} ms (início) → ${r.sondaP95Final} ms (fim)`)
  if (r.aprovado === true) console.log('   APROVADO')
  if (r.aprovado === false) console.log(`   REPROVADO:\n     - ${r.violacoes.join('\n     - ')}`)
}

function relatorio(resumos, versao) {
  const L = [`# Resultados do teste de carga`, '', `Gerado em ${new Date().toISOString()} · Node ${process.version} · ${process.platform} · ${versao}`, '',
    `Dataset sintético: ${ROWS.toLocaleString('pt-BR')} linhas · ${USERS} usuários · heap da API ${HEAP_MB} MB. Unidade da taxa: aberturas de dashboard/s (≈ 8 requisições cada).`, '',
    '| Cenário | Duração | Req/s | Falhas | Inesperadas | Pico RSS | Resultado |', '|---|---|---|---|---|---|---|']
  for (const r of resumos) {
    L.push(`| ${r.cenario} | ${r.duracaoSeg}s | ${r.reqPorSeg} | ${(r.taxaFalha * 100).toFixed(2)}% | ${r.respostasInesperadas} | ${r.rssPicoMb ?? '—'} MB | ${r.aprovado === null ? (r.apiViva ? 'medição (API de pé)' : 'medição (API CAIU)') : r.aprovado ? 'APROVADO' : 'REPROVADO'} |`)
  }
  for (const r of resumos) {
    L.push('', `## ${r.cenario}`, '', '| Endpoint | n | falha | p50 | p95 | p99 | max |', '|---|---|---|---|---|---|---|')
    for (const [k, t] of Object.entries(r.tags).sort()) L.push(`| ${k} | ${t.n} | ${(t.taxaFalha * 100).toFixed(1)}% | ${t.p50.toFixed(0)} | ${t.p95.toFixed(0)} | ${t.p99.toFixed(0)} | ${t.max.toFixed(0)} |`)
    if (r.violacoes.length) L.push('', `Violações: ${r.violacoes.join('; ')}`)
    if (r.evento) L.push('', `**${r.evento}**`)
    if (r.rssMediaPrimeiraMetadeMb) L.push('', `Soak: RSS médio ${r.rssMediaPrimeiraMetadeMb} MB → ${r.rssMediaSegundaMetadeMb} MB (1ª → 2ª metade).`)
    if (r.sondaP95Final != null) L.push('', `Recuperação: p95 de /api/health ${r.sondaP95Inicial} ms → ${r.sondaP95Final} ms.`)
    if (r.logApi.length) L.push('', 'Log da API (linhas de erro):', '```', ...r.logApi, '```')
  }
  return L.join('\n') + '\n'
}

// ─── Principal ─────────────────────────────────────────────────────────────
const pedidos = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (!pedidos.length) pedidos.push('smoke')
const VALIDOS = ['smoke', 'load', 'stress', 'spike', 'soak', 'abuso']
for (const p of pedidos) if (!VALIDOS.includes(p)) { console.error(`cenário desconhecido "${p}". Use: ${VALIDOS.join(', ')}`); process.exit(2) }

const resumos = []
let h = null
let status = 0
const encerrar = async () => { if (h) await h.parar().catch(() => {}); h = null }
process.on('SIGINT', async () => { await encerrar(); process.exit(130) })
try {
  for (const nome of pedidos) {
    // API nova por cenário: um cenário que derruba ou suja a API não contamina o seguinte.
    h = await iniciarHarness({ rows: ROWS, heapMb: HEAP_MB, verboso: true })
    const users = []
    for (let i = 0; i < USERS; i++) {
      const email = `carga${String(i).padStart(3, '0')}@${h.dominio}`
      users.push({ email, cookie: await h.entrar(email) })
    }
    users[0] = { email: h.adminEmail, cookie: await h.entrar(h.adminEmail) }
    // Usuário comum é o que o teste de segurança usa: tira o admin da sorte do ruído.
    const comuns = users.slice(1)
    const r = await rodarCenario(nome, h, comuns)
    resumos.push(r)
    if (r.aprovado === false) status = 1
    await encerrar()
    await dorme(2000)
  }
} finally {
  await encerrar()
}
writeFileSync(join(OUT, 'RESULTS.md'), relatorio(resumos, `commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'}`))
console.log(`\n>> relatório: ${join(OUT, 'RESULTS.md')}`)
process.exit(status)
