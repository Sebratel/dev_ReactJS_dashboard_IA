import { logger } from './logger.mjs'
// ─────────────────────────────────────────────────────────────────────────
// Leitura de planilhas do Google Sheets via API REST v4, usando o próprio
// access_token OAuth do usuário logado (escopo spreadsheets.readonly, ver
// src/lib/googleScopes.ts) — fetch direto, sem SDK, mesmo padrão já usado
// pra validar identidade em server/index.mjs::getUserFromToken. Cada usuário
// só consegue ler as planilhas que a própria conta Google dele tem acesso.
// ─────────────────────────────────────────────────────────────────────────
const SPREADSHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/

export function extractSpreadsheetId(url) {
  const m = SPREADSHEET_ID_RE.exec(String(url || ''))
  if (!m) {
    throw new Error('Link inválido — cole a URL completa da planilha do Google Sheets (ex.: https://docs.google.com/spreadsheets/d/ID/edit).')
  }
  return m[1]
}

async function googleFetch(url, accessToken) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (r.ok) return r.json()
  let body = null
  try { body = await r.json() } catch { /* sem corpo JSON */ }
  const msg = body?.error?.message ?? ''
  logger.error('[google-sheets] erro da API:', r.status, msg || '(sem mensagem)')
  if (r.status === 401 || (r.status === 403 && /scope/i.test(msg))) {
    throw new Error('Sua sessão do Google ainda não tem permissão pra ler planilhas — saia e entre de novo pra conceder o novo acesso.')
  }
  if (r.status === 403 && /(has not been used|disabled|is not enabled)/i.test(msg)) {
    throw new Error('A API do Google Sheets ainda não está habilitada no projeto do Google Cloud deste app — habilite em "APIs e serviços" e tente de novo em alguns minutos.')
  }
  if (r.status === 403) {
    throw new Error(`Sem acesso a esta planilha com sua conta Google — confirme se ela foi compartilhada com você no Drive. (detalhe do Google: ${msg || 'sem mensagem'})`)
  }
  if (r.status === 404) throw new Error('Planilha não encontrada — confirme o link.')
  throw new Error(msg || `Erro ${r.status} ao consultar o Google Sheets.`)
}

async function firstSheetTitle(spreadsheetId, accessToken) {
  const meta = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    accessToken,
  )
  const title = meta?.sheets?.[0]?.properties?.title
  if (!title) throw new Error('Não foi possível identificar as abas dessa planilha.')
  return title
}

// Alto o bastante pra qualquer planilha manual real, baixo o bastante pra
// nunca competir de tamanho com uma fonte SQL de verdade (essas já tem seu
// próprio teto, bem maior — ver MAX_ROWS em lakehouseSources.mjs).
const MAX_SHEET_ROWS = 20_000

function coerceCell(v) {
  if (v === '' || v == null) return null
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

// Cabeçalho pode ter células vazias ou repetidas (planilha "de verdade",
// mantida manualmente) — nunca deixa duas colunas colidirem na mesma chave.
function buildHeader(row) {
  const seen = new Map()
  return row.map((h, i) => {
    const base = String(h ?? '').trim() || `coluna_${i + 1}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}_${n + 1}`
  })
}

// Busca os valores de UMA aba (a informada, ou a 1ª da planilha) e devolve
// como rows (array de objetos) — mesmo formato que o resto do motor de
// widgets já espera de qualquer fonte (ver server/widgetQuery.mjs).
export async function fetchSheetRows({ spreadsheetId, sheetName }, accessToken) {
  const tab = sheetName || (await firstSheetTitle(spreadsheetId, accessToken))
  const data = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab)}`,
    accessToken,
  )
  const values = data?.values ?? []
  if (values.length === 0) return { rows: [], sheetName: tab }
  const header = buildHeader(values[0])
  const rows = values
    .slice(1, 1 + MAX_SHEET_ROWS)
    .filter((r) => r.some((c) => c !== '' && c != null))
    .map((r) => {
      const o = {}
      header.forEach((key, i) => { o[key] = coerceCell(r[i]) })
      return o
    })
  return { rows, sheetName: tab }
}

// Lista as abas da planilha (nomes) — usado pelo editor pra deixar o usuário
// escolher qual aba usar, em vez de sempre cair na primeira.
export async function listSheetTabs(spreadsheetId, accessToken) {
  const meta = await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    accessToken,
  )
  return (meta?.sheets ?? []).map((s) => s.properties?.title).filter(Boolean)
}
