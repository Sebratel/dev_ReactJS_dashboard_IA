// ─────────────────────────────────────────────────────────────────────────
// ETL — materializa num snapshot único as fontes que o Builder consome em
// segundo plano: os datasets do Data Hub / lakehouse
// (server/lakehouseSources.mjs), lidos pela API pública de lá.
//
// Este projeto NÃO fala com banco de dados. O lakehouse é o barramento: quem
// quer um dado no dashboard publica um dataset lá e cadastra a fonte na tela.
// Isso é deliberado — antes existia também um catálogo de queries SQL que
// batia direto no Postgres do ERP e no MariaDB, e manter os dois caminhos
// significava consumir duas plataformas grandes para a mesma informação.
//
// (As planilhas do Google também não entram aqui: elas dependem do token
// OAuth de quem está logado, então são resolvidas dentro da requisição — ver
// server/sheetSources.mjs.)
//
// A atualização é POR FONTE: 'realtime' roda sempre que este script é chamado
// (o scheduler chama em ciclo curto, ver etl-scheduler.mjs); 'scheduled' só
// roda quando `refreshMinutes` já passou desde `lastRunAt` — nos ciclos em que
// não é a vez dela, o dado da execução anterior é mantido (lido do snapshot
// atual antes de sobrescrever), então ela não some do Builder entre uma
// execução e outra.
//
// Fonte em LEITURA DIRETA (readMode 'direct') não é copiada: os painéis
// consultam o Data Hub na hora (server/directWidgetQuery.mjs). Na vez dela, o
// ciclo só confere que o Data Hub responde a consulta e anota o total de
// linhas — é o que a tela de Configurações mostra. Fonte COPIADA grande demais
// (COPY_MAX_BYTES, medido na 1ª página) vira erro NELA, com a saída sugerida,
// e não entra no snapshot: antes, ela derrubava o ciclo inteiro na hora de
// gravar, sem erro em lugar nenhum, e as fontes pequenas paravam de atualizar
// junto — de novo a cada ciclo.
//
// ETL_FORCE_IDS (ver FORCED, abaixo) fura a agenda para as fontes listadas —
// é o que dá sentido às ações manuais da tela.
//
// Grava um snapshot (gzip) em SNAPSHOT_OUT/public/installData.data.
// Rodado sob demanda (`npm run fetch:install`) ou pelo scheduler.
// ─────────────────────────────────────────────────────────────────────────
import { logger } from '../server/logger.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import {
  listForEtl as listLakehouseForEtl, fetchDatasetRows, queryDataset, recordLakehouseRuns, sourceKey as lakehouseKey,
  isDue, readModeOf, CopyTooLargeError, COPY_MAX_BYTES, MAX_ROWS as MAX_LAKEHOUSE_ROWS,
} from '../server/lakehouseSources.mjs'
import { decryptSecret } from '../server/secretBox.mjs'

// Onde gravar o snapshot. `SNAPSHOT_OUT` é o nome que o serviço `scheduler` usa; mas
// este script também roda disparado pela PRÓPRIA API (ao cadastrar/editar uma
// fonte, ver triggerEtlRefresh em server/index.mjs), e lá o que existe no
// ambiente é `SNAPSHOT_PATH` — o arquivo que ela LÊ.
//
// São o mesmo arquivo: quem escreve e quem lê têm de apontar pro mesmo lugar.
// Sem este fallback, o ETL disparado pela API gravava em ./public dentro do
// container dela (caminho que ninguém lê) enquanto a API seguia lendo
// /snapshot/installData.data — a fonte recém-cadastrada aparecia em
// Configurações, com contagem de linhas e tudo, e NUNCA chegava no Builder nem
// no dicionário. Era preciso esperar o serviço `scheduler` rodar, o que com fonte
// agendada de 60 min podia levar uma hora.
const OUT = resolve(process.env.SNAPSHOT_OUT || process.env.SNAPSHOT_PATH || 'public/installData.data')

// Tolerante a arquivo ausente/corrompido — nesse caso simplesmente não há
// dado anterior pra carregar adiante (fontes agendadas ainda não vencidas
// ficam de fora do snapshot até a 1ª execução real delas).
function readPreviousSnapshot(path) {
  try {
    const buf = readFileSync(path)
    let text
    try { text = gunzipSync(buf).toString('utf8') } catch { text = buf.toString('utf8') }
    return { data: JSON.parse(text)?.data ?? {} }
  } catch {
    return { data: {} }
  }
}

// Vira o erro da fonte em Configurações, então precisa dizer onde mexer — não
// só "EACCES". No container, permissão negada quase sempre é o volume do
// snapshot pertencendo a outro usuário que não o da imagem.
function describeWriteError(e) {
  const base = `o dado foi buscado, mas o snapshot não pôde ser gravado em ${OUT} (${e.code || e.message})`
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    const uid = typeof process.getuid === 'function' ? ` (uid ${process.getuid()})` : ''
    return `${base}: o processo${uid} não tem permissão de escrita ali. No Docker, o volume do snapshot precisa pertencer ao usuário da imagem — ver Dockerfile.api.`
  }
  if (e.code === 'EROFS') return `${base}: o volume está montado como somente leitura.`
  return base
}

// Fontes que devem ser buscadas MESMO fora da agenda delas. É o que sustenta
// as ações manuais da tela — "Sincronizar agora", salvar uma edição, reativar
// uma fonte: em todas elas a pessoa acabou de pedir o dado, e responder "sua
// janela de 60 min ainda não venceu" seria contrariar o que a tela promete.
//
// Passado pela API que dispara este script (triggerEtlRefresh, em
// server/index.mjs). Vazio = ciclo normal, só quem venceu a agenda.
const FORCED = new Set(
  (process.env.ETL_FORCE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
)

async function main() {
  const previous = readPreviousSnapshot(OUT)
  const now = Date.now()
  const data = {}
  const runs = []
  if (FORCED.size) logger.info(`[etl] busca manual pedida para: ${[...FORCED].join(', ')}`)

  const sources = listLakehouseForEtl()
  if (sources.length === 0) {
    logger.info('[etl] nenhuma fonte do Data Hub cadastrada — cadastre em Configurações.')
  }

  // Sequencial (não Promise.all): são datasets de tamanho desconhecido —
  // evita empilhar N buscas grandes ao mesmo tempo contra o Data Hub. Uma
  // fonte com falha não derruba as demais.
  for (const src of sources) {
    const key = lakehouseKey(src.id)
    if (src.enabled === false) {
      logger.info(`[etl] ${key}: desativada — pulando`)
      continue
    }
    if (readModeOf(src) === 'direct') {
      // Não entra no snapshot (nem o que sobrou de quando era copiada).
      if (!FORCED.has(src.id) && !isDue(src, now)) continue
      try {
        if (!src.tokenEnc) throw new Error('fonte sem token cadastrado')
        const { total } = await queryDataset({
          baseUrl: src.baseUrl, datasetSlug: src.datasetSlug, token: decryptSecret(src.tokenEnc),
        }, { limit: 1 })
        runs.push({ id: src.id, lastRunAt: new Date(now).toISOString(), rowCount: total ?? null, error: null })
        logger.info(`[etl] ${key} (${src.datasetSlug}): leitura direta — ${total ?? '?'} linha(s) no Data Hub, nada copiado`)
      } catch (e) {
        // Sem lastRunAt: confere de novo no próximo ciclo (é uma consulta só).
        runs.push({ id: src.id, error: e.message })
        logger.info(`[etl] ${key} (${src.datasetSlug}): leitura direta falhou (${e.message})`)
      }
      continue
    }
    // "Manter o dado anterior" só vale se ele existe. Fora da agenda mas
    // AUSENTE do snapshot — o ciclo em que ela rodou não conseguiu gravar, ou
    // o volume do snapshot foi recriado — a fonte é buscada agora: senão ela
    // ficava fora do Builder até a janela vencer, com o catálogo dizendo que
    // já tinha rodado.
    if (!FORCED.has(src.id) && !isDue(src, now) && previous.data[key]) {
      data[key] = previous.data[key]
      logger.info(`[etl] ${key} (${src.datasetSlug}): agendada (${src.refreshMinutes}min) — ainda não venceu, mantendo ${data[key].length} linha(s) anteriores`)
      continue
    }
    try {
      if (!src.tokenEnc) throw new Error('fonte sem token cadastrado')
      const { rows, total, pages } = await fetchDatasetRows({
        baseUrl: src.baseUrl, datasetSlug: src.datasetSlug, token: decryptSecret(src.tokenEnc),
      }, { maxRows: MAX_LAKEHOUSE_ROWS, maxBytes: COPY_MAX_BYTES })
      data[key] = rows
      runs.push({ id: src.id, lastRunAt: new Date(now).toISOString(), rowCount: rows.length, rowTotal: total, error: null })
      const truncated = rows.length < total ? ` de ${total} (teto de ${MAX_LAKEHOUSE_ROWS})` : ''
      logger.info(`[etl] ${key} (${src.datasetSlug}): ${rows.length} linhas${truncated} em ${pages} página(s)`)
    } catch (e) {
      if (e instanceof CopyTooLargeError) {
        // Não é falha passageira: a fonte segue a agenda dela (lastRunAt) em
        // vez de ser rebaixada a cada ciclo. Fica no snapshot só o que ela já
        // tinha, se tinha.
        if (previous.data[key]) data[key] = previous.data[key]
        runs.push({ id: src.id, lastRunAt: new Date(now).toISOString(), error: e.message })
        logger.info(`[etl] ${key} (${src.datasetSlug}): ${e.message}`)
        continue
      }
      // Falha transitória — mantém o último dado bom em vez de zerar, e NÃO
      // grava lastRunAt (tenta de novo no próximo ciclo). O erro fica
      // registrado pra aparecer na tela de Configurações.
      data[key] = previous.data[key] ?? []
      runs.push({ id: src.id, error: e.message })
      logger.info(`[etl] ${key} (${src.datasetSlug}): falhou (${e.message}) — mantendo ${data[key].length} linha(s) anteriores`)
    }
  }
  const snapshot = { meta: { generatedAt: new Date().toISOString() }, data }
  // Rede de proteção: com o teto por fonte isto não deveria estourar, mas se
  // estourar (muitas fontes copiadas perto do teto), o motivo vai para as
  // fontes do ciclo em vez de o processo morrer mudo.
  let json
  try {
    json = JSON.stringify(snapshot)
  } catch (e) {
    const reason = `o snapshot ficou grande demais para gravar (${e.message}) — mude as fontes maiores para "Direto no Data Hub"`
    if (runs.length) recordLakehouseRuns(runs.map((r) => ({ id: r.id, error: r.error ?? reason })))
    throw new Error(reason, { cause: e })
  }
  const gz = gzipSync(Buffer.from(json, 'utf8'))
  // A execução só é registrada DEPOIS que o snapshot foi gravado. Antes era o
  // contrário, e uma gravação que falhava (volume sem permissão de escrita)
  // mentia duas vezes: a tela mostrava a fonte saudável, com contagem de
  // linhas, sem nenhuma coluna no Builder; e a agenda a considerava em dia,
  // adiando a próxima tentativa. Agora o motivo vai para o erro da fonte, que
  // é o que Configurações mostra.
  try {
    writeFileSync(OUT, gz)
  } catch (e) {
    const reason = describeWriteError(e)
    if (runs.length) recordLakehouseRuns(runs.map((r) => ({ id: r.id, error: r.error ?? reason })))
    throw new Error(reason, { cause: e })
  }
  if (runs.length) recordLakehouseRuns(runs)
  const ok = runs.filter((r) => !r.error).length
  logger.info(`OK — snapshot gravado em ${OUT} (${(json.length / 1048576).toFixed(1)} MB → gzip ${(gz.length / 1048576).toFixed(1)} MB) · ${ok} dataset(s) do Data Hub executado(s)`)
}

main().catch((e) => { logger.error('[etl] falhou:', e); process.exit(1) })
