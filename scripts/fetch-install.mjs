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
// ETL_FORCE_IDS (ver FORCED, abaixo) fura a agenda para as fontes listadas —
// é o que dá sentido às ações manuais da tela.
//
// Grava um snapshot (gzip) em SNAPSHOT_OUT/public/installData.data.
// Rodado sob demanda (`npm run fetch:install`) ou pelo scheduler.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import {
  listForEtl as listLakehouseForEtl, fetchDatasetRows, recordLakehouseRuns, sourceKey as lakehouseKey,
  isDue, MAX_ROWS as MAX_LAKEHOUSE_ROWS,
} from '../server/lakehouseSources.mjs'
import { decryptSecret } from '../server/secretBox.mjs'

// Onde gravar o snapshot. `SNAPSHOT_OUT` é o nome que o serviço `etl` usa; mas
// este script também roda disparado pela PRÓPRIA API (ao cadastrar/editar uma
// fonte, ver triggerEtlRefresh em server/index.mjs), e lá o que existe no
// ambiente é `SNAPSHOT_PATH` — o arquivo que ela LÊ.
//
// São o mesmo arquivo: quem escreve e quem lê têm de apontar pro mesmo lugar.
// Sem este fallback, o ETL disparado pela API gravava em ./public dentro do
// container dela (caminho que ninguém lê) enquanto a API seguia lendo
// /snapshot/installData.data — a fonte recém-cadastrada aparecia em
// Configurações, com contagem de linhas e tudo, e NUNCA chegava no Builder nem
// no dicionário. Era preciso esperar o serviço `etl` rodar, o que com fonte
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
  if (FORCED.size) console.log(`[etl] busca manual pedida para: ${[...FORCED].join(', ')}`)

  const sources = listLakehouseForEtl()
  if (sources.length === 0) {
    console.log('[etl] nenhuma fonte do Data Hub cadastrada — cadastre em Configurações.')
  }

  // Sequencial (não Promise.all): são datasets de tamanho desconhecido —
  // evita empilhar N buscas grandes ao mesmo tempo contra o Data Hub. Uma
  // fonte com falha não derruba as demais.
  for (const src of sources) {
    const key = lakehouseKey(src.id)
    if (src.enabled === false) {
      console.log(`[etl] ${key}: desativada — pulando`)
      continue
    }
    if (!FORCED.has(src.id) && !isDue(src, now)) {
      if (previous.data[key]) data[key] = previous.data[key]
      console.log(`[etl] ${key} (${src.datasetSlug}): agendada (${src.refreshMinutes}min) — ainda não venceu, mantendo ${(data[key] ?? []).length} linha(s) anteriores`)
      continue
    }
    try {
      if (!src.tokenEnc) throw new Error('fonte sem token cadastrado')
      const { rows, total, pages } = await fetchDatasetRows({
        baseUrl: src.baseUrl, datasetSlug: src.datasetSlug, token: decryptSecret(src.tokenEnc),
      }, { maxRows: MAX_LAKEHOUSE_ROWS })
      data[key] = rows
      runs.push({ id: src.id, lastRunAt: new Date(now).toISOString(), rowCount: rows.length, error: null })
      const truncated = rows.length < total ? ` de ${total} (teto de ${MAX_LAKEHOUSE_ROWS})` : ''
      console.log(`[etl] ${key} (${src.datasetSlug}): ${rows.length} linhas${truncated} em ${pages} página(s)`)
    } catch (e) {
      // Falha transitória — mantém o último dado bom em vez de zerar, e NÃO
      // grava lastRunAt (tenta de novo no próximo ciclo). O erro fica
      // registrado pra aparecer na tela de Configurações.
      data[key] = previous.data[key] ?? []
      runs.push({ id: src.id, error: e.message })
      console.log(`[etl] ${key} (${src.datasetSlug}): falhou (${e.message}) — mantendo ${data[key].length} linha(s) anteriores`)
    }
  }
  if (runs.length) recordLakehouseRuns(runs)

  const snapshot = { meta: { generatedAt: new Date().toISOString() }, data }
  const json = JSON.stringify(snapshot)
  const gz = gzipSync(Buffer.from(json, 'utf8'))
  writeFileSync(OUT, gz)
  const ok = runs.filter((r) => !r.error).length
  console.log(`OK — snapshot gravado em ${OUT} (${(json.length / 1048576).toFixed(1)} MB → gzip ${(gz.length / 1048576).toFixed(1)} MB) · ${ok} dataset(s) do Data Hub executado(s)`)
}

main().catch((e) => { console.error('[etl] falhou:', e); process.exit(1) })
