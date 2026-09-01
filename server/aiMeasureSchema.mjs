// ─────────────────────────────────────────────────────────────────────────
// O contrato entre a IA e a "tabela de medidas" da dashboard (ver
// MeasureDef, src/features/builder/types.ts) — espelha aiWidgetSchema.mjs:
// um JSON Schema pra FORMA + validateMeasureBatch/normalizeMeasureBatch pra
// checar o CONTEÚDO real (campo existe? fórmula bem formada? sem ciclo?).
//
// Diferença central de propose_widgets: aqui o modelo referencia OUTRAS
// medidas do MESMO lote por NOME (ainda não têm id nenhum) — então a
// validação é em passes: (1) nomes não-vazios, únicos, sem colidir com
// medida já existente na dashboard; (2) por medida — campo/fonte real
// (simple) ou expressão bem formada + refs resolvendo no lote ou numa
// medida já existente (formula); (3) ciclo no grafo de nomes do PRÓPRIO
// lote (uma referência a uma medida JÁ existente nunca pode fazer parte de
// um ciclo novo, já que toda medida existente já foi validada acíclica
// quando foi salva). Só depois normalizeMeasureBatch gera ids de verdade e
// resolve nome → id.
// ─────────────────────────────────────────────────────────────────────────
import { parseExpression, extractIdentifiers } from './measureExpr.mjs'

const AGGS = ['countDistinct', 'count', 'sum', 'avg']
const MEASURE_FORMATS = ['percent']

// Variante SEM 'shiftYears' — usada só dentro de `base`, pra não precisar de
// schema recursivo de verdade (shiftYears dentro de shiftYears não tem uso
// real: "deslocar 2 anos" já é só years: -2).
const DATE_WINDOW_BASE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['lastNDays', 'lastNMonths', 'yearToDate', 'currentMonth', 'currentQuarter', 'currentYear'] },
    field: { type: 'string', description: 'Campo de data (kind "date") da MESMA fonte da medida.' },
    n: { type: 'integer', minimum: 1, description: 'Só para lastNDays/lastNMonths — quantos dias/meses.' },
  },
  required: ['type', 'field'],
}

const DATE_WINDOW_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: "Janela de data RELATIVA a agora (nunca uma data fixa). 'shiftYears' desloca QUALQUER outra janela por N anos — é assim que se expressa \"mesmo período do ano passado\": shiftYears com years=-1 e base=lastNMonths(3), não um tipo próprio.",
  properties: {
    type: { type: 'string', enum: ['lastNDays', 'lastNMonths', 'yearToDate', 'currentMonth', 'currentQuarter', 'currentYear', 'shiftYears'] },
    field: { type: 'string', description: 'Campo de data — obrigatório em todo tipo, EXCETO shiftYears (que herda o campo de `base`).' },
    n: { type: 'integer', minimum: 1, description: 'Só para lastNDays/lastNMonths.' },
    years: { type: 'integer', description: "Só para shiftYears — quantos anos deslocar (negativo = passado; -1 = \"ano anterior\")." },
    base: { ...DATE_WINDOW_BASE_SCHEMA, description: 'Só para shiftYears — a janela sendo deslocada.' },
  },
  required: ['type'],
}

// Filtro FIXO por valor/categoria, parte da PRÓPRIA medida — diferente de um
// filtro de aba (contextual, escolhido por quem vê a tela): este vale sempre
// que a medida é usada, em qualquer widget/fórmula. É o mecanismo que faltava
// pra "% de reincidência" (isolar Status="Reincidência") ou "total sem contar
// cancelados" (excluir "Cancelado" com op:"notIn") virarem medidas nomeadas.
const MEASURE_FILTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    field: { type: 'string', description: 'Campo da MESMA fonte da medida (categoria/status/texto — não precisa ser data).' },
    op: { type: 'string', enum: ['in', 'notIn'], description: '"in" = mantém só as linhas com um desses valores; "notIn" = exclui as linhas com um desses valores.' },
    values: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Valor(es) exatos do campo, como aparecem no dado (comparação de texto exata) — ex. ["Reincidência"] ou ["Cancelado"].' },
  },
  required: ['field', 'op', 'values'],
}

const MEASURE_PROPOSAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Nome curto e específico, em português — aparece na lista de medidas e no seletor de Eixo Y/KPI (ex. "Protocolos últimos 3 meses"). Único nesta dashboard.' },
    description: { type: 'string', description: 'Explica o cálculo em 1 frase. OBRIGATÓRIO quando kind="formula" combina medidas de fontes DIFERENTES entre si — registre a suposição assumida (o motor não valida que a conta faz sentido, só que é calculável).' },
    kind: { type: 'string', enum: ['simple', 'formula'], description: '"simple" = uma agregação comum, com janela de data opcional. "formula" = combina OUTRAS medidas nomeadas (nunca um campo cru) numa expressão aritmética.' },
    source: { type: 'string', description: 'Só kind="simple" — chave da fonte, exatamente como no catálogo.' },
    agg: { type: 'string', enum: AGGS, description: 'Só kind="simple". sum/avg exigem `field`.' },
    field: { type: 'string', description: 'Só kind="simple" — campo numérico (obrigatório em sum/avg; opcional em count/countDistinct).' },
    dateWindow: { ...DATE_WINDOW_SCHEMA, description: 'Só kind="simple", opcional — restringe a medida a um período relativo a agora (últimos N dias/meses, ano até a data, mês/trimestre/ano atual, ou qualquer um desses deslocado por anos).' },
    filters: { type: 'array', items: MEASURE_FILTER_SCHEMA, description: 'Só kind="simple", opcional — filtro fixo por valor/categoria (ver MEASURE_FILTER_SCHEMA). Use quando o pedido isola um valor específico de uma coluna (um status, uma equipe, um tipo) como parte da definição da medida — não confundir com o filtro de aba, que é escolhido por quem vê a tela.' },
    expression: { type: 'string', description: "Só kind=\"formula\" — combine os aliases de `refs` com + - * / % ( ), ex. \"(atual - anterior) / anterior * 100\". Divisão por zero dá um resultado indeterminado (nunca quebra nem vira infinito), então não precisa se preocupar em evitar." },
    format: { type: 'string', enum: ['percent'], description: 'Opcional, as duas kinds — marque "percent" quando o resultado já é uma taxa/percentual na escala 0-100 (ex. uma razão multiplicada por 100, ou uma "Taxa de X"). Só muda a EXIBIÇÃO (acrescenta "%" num Card/KPI) — não divide nem multiplica o valor, que já precisa estar calculado certo na `expression`/`agg`.' },
    refs: {
      type: 'object', additionalProperties: { type: 'string' },
      description: 'Só kind="formula" — mapa alias (usado na expressão) -> NOME de outra medida. Pode ser uma medida deste MESMO lote (proposta antes ou depois, tanto faz a ordem) ou uma já existente nesta dashboard. Nunca um campo cru — se precisar de um cálculo simples que ainda não existe, proponha-o como outra medida "simple" no mesmo lote.',
    },
  },
  required: ['name', 'kind'],
}

export const PROPOSE_MEASURES_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    measures: { type: 'array', items: MEASURE_PROPOSAL_SCHEMA, description: 'As medidas propostas — pode ser só uma (um cálculo simples) ou várias formando uma cadeia (ex. período atual, período anterior, comparativo entre os dois).' },
    summary: { type: 'string', description: 'Uma ou duas frases dizendo o que você criou e por quê.' },
  },
  required: ['measures', 'summary'],
}

// Igual a MEASURE_PROPOSAL_SCHEMA, mas SEM nada obrigatório — um patch só
// precisa trazer os campos que devem MUDAR (ex. só `format`), o resto
// continua como já estava salvo. `kind` incluído só pra dar erro claro se o
// modelo tentar mudá-lo (não suportado — ver validateMeasureUpdates).
const MEASURE_PATCH_SCHEMA = { ...MEASURE_PROPOSAL_SCHEMA, required: [] }

export const UPDATE_MEASURES_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'id EXATO de uma medida já existente nesta dashboard — copie do catálogo de medidas (nunca invente, nunca use o nome aqui).' },
          patch: { ...MEASURE_PATCH_SCHEMA, description: 'Só os campos que devem MUDAR nesta medida — omita os demais, que continuam como estavam. Não dá pra mudar "kind" (simple ↔ formula); se precisar, avise o usuário que isso exige apagar e criar de novo.' },
        },
        required: ['id', 'patch'],
      },
      description: 'Uma ou mais medidas JÁ EXISTENTES a atualizar NO LUGAR, mesmo id de sempre (ex. "marca a Taxa de X como percentual" → id da Taxa de X, patch: {format: "percent"}). Use isto (não propose_measures) sempre que o pedido for sobre editar algo que já existe — propose_measures sempre CRIA, então reaproveitar um nome existente lá vira uma medida NOVA e parecida ("Nome (2)"), não uma edição.',
    },
    summary: { type: 'string', description: 'Uma ou duas frases dizendo o que você mudou e por quê.' },
  },
  required: ['updates', 'summary'],
}

function validateDateWindowShape(w, source, where) {
  if (!w || typeof w !== 'object') return `${where}: janela de data ausente ou inválida.`
  if (w.type === 'shiftYears') {
    if (!Number.isInteger(w.years)) return `${where}: shiftYears exige "years" inteiro.`
    if (!w.base) return `${where}: shiftYears exige "base".`
    return validateDateWindowShape(w.base, source, `${where}.base`)
  }
  const dateFieldKeys = new Set(source.fields.filter((f) => f.kind === 'date').map((f) => f.key))
  if (!w.field || !dateFieldKeys.has(w.field)) {
    return `${where}: campo "${w.field}" não existe (ou não é do tipo data) na fonte "${source.key}".`
  }
  if ((w.type === 'lastNDays' || w.type === 'lastNMonths') && !(w.n > 0)) {
    return `${where}: "${w.type}" exige "n" (inteiro positivo).`
  }
  return null
}

// `sources`: mesmo formato de validateWidget — [{key, fields:[{key,kind}]}],
// já pré-filtrado pelas fontes selecionadas na conversa (barreira de acesso).
// `existingMeasures`: MeasureDef[] já salvas nesta dashboard — usadas pra
// checar colisão de nome e pra resolver `refs` que apontem pra elas.
export function validateMeasureBatch(proposals, sources, existingMeasures = []) {
  const list = Array.isArray(proposals) ? proposals : []
  if (list.length === 0) return ['Nenhuma medida na proposta.']

  const errors = []
  const namesInBatch = new Set()
  list.forEach((p, i) => {
    const name = String(p?.name ?? '').trim()
    if (!name) { errors.push(`measures[${i}]: name é obrigatório.`); return }
    // Duplicado DENTRO do lote é erro de verdade (quebraria a resolução de
    // `refs` por nome, ambígua entre 2 propostas iguais) — mas colidir com
    // uma medida JÁ SALVA não é mais bloqueado aqui: cobre o pedido ambíguo
    // que legitimamente é uma medida NOVA parecida (ex. "cria uma taxa de
    // encerramento diferente, considerando outro SLA"), sem forçar a IA a
    // adivinhar um nome alternativo ou entrar num loop de erro. Em vez de
    // falhar, normalizeMeasureBatch desambigua sozinho ("Nome (2)", "(3)"...).
    if (namesInBatch.has(name)) { errors.push(`measures[${i}]: nome "${name}" duplicado neste lote.`); return }
    namesInBatch.add(name)
  })
  // Sem nomes únicos e válidos, checar refs não tem base confiável — devolve
  // já aqui pro modelo corrigir isso primeiro.
  if (errors.length) return errors

  const nameToProposal = new Map(list.map((p) => [String(p.name).trim(), p]))
  const existingByName = new Map(existingMeasures.map((m) => [m.name, m]))
  const sourceOf = (name) => {
    const p = nameToProposal.get(name)
    if (p) return p.kind === 'simple' ? p.source : null // fórmula-de-fórmula: fonte não conhecida sem recursão, tratado como "sem fonte única" (best-effort)
    const m = existingByName.get(name)
    return m?.kind === 'simple' ? m.source : null
  }

  list.forEach((p, i) => {
    const where = `measures[${i}] ("${p?.name}")`
    if (p.format !== undefined && !MEASURE_FORMATS.includes(p.format)) {
      errors.push(`${where}: format inválido ${JSON.stringify(p.format)} — use "percent" ou omita.`)
    }
    if (p.kind === 'simple') {
      const source = sources.find((s) => s.key === p.source)
      if (!source) { errors.push(`${where}: fonte "${p.source}" não está disponível nesta conversa.`); return }
      if (!AGGS.includes(p.agg)) { errors.push(`${where}: agg inválida ${JSON.stringify(p.agg)}.`); return }
      if ((p.agg === 'sum' || p.agg === 'avg') && !p.field) { errors.push(`${where}: agg "${p.agg}" exige \`field\`.`); return }
      const fieldKeys = new Set(source.fields.map((f) => f.key))
      if (p.field && !fieldKeys.has(p.field)) { errors.push(`${where}: a fonte "${p.source}" não tem o campo "${p.field}".`); return }
      if (p.dateWindow) {
        const dwErr = validateDateWindowShape(p.dateWindow, source, `${where}.dateWindow`)
        if (dwErr) errors.push(dwErr)
      }
      if (p.filters) {
        if (!Array.isArray(p.filters)) { errors.push(`${where}: filters deve ser uma lista.`); return }
        p.filters.forEach((f, fi) => {
          const fwhere = `${where}.filters[${fi}]`
          if (!f || typeof f !== 'object') { errors.push(`${fwhere}: filtro inválido.`); return }
          if (!f.field || !fieldKeys.has(f.field)) { errors.push(`${fwhere}: a fonte "${p.source}" não tem o campo "${f.field}".`); return }
          if (f.op !== 'in' && f.op !== 'notIn') { errors.push(`${fwhere}: op inválido ${JSON.stringify(f.op)} — use "in" ou "notIn".`); return }
          if (!Array.isArray(f.values) || f.values.length === 0) errors.push(`${fwhere}: "values" precisa ter ao menos 1 valor.`)
        })
      }
    } else if (p.kind === 'formula') {
      if (!p.expression || !String(p.expression).trim()) { errors.push(`${where}: expression é obrigatória.`); return }
      let ast
      try { ast = parseExpression(p.expression) } catch (e) { errors.push(`${where}: expressão inválida — ${e.message}`); return }
      const ids = extractIdentifiers(ast)
      const refs = p.refs ?? {}
      for (const id of ids) {
        if (!(id in refs)) errors.push(`${where}: identificador "${id}" usado na expressão mas ausente em \`refs\`.`)
      }
      const sourcesTouched = new Set()
      for (const [alias, refName] of Object.entries(refs)) {
        const existsInBatch = nameToProposal.has(refName)
        const existsAlready = existingByName.has(refName)
        if (!existsInBatch && !existsAlready) {
          errors.push(`${where}: refs.${alias} referencia "${refName}", que não existe (nem neste lote, nem já salva nesta dashboard).`)
          continue
        }
        const s = sourceOf(refName)
        if (s) sourcesTouched.add(s)
      }
      if (sourcesTouched.size > 1 && !(p.description && String(p.description).trim())) {
        errors.push(`${where}: combina medidas de fontes diferentes (${[...sourcesTouched].join(', ')}) — preencha "description" explicando a suposição assumida antes de propor.`)
      }
    } else {
      errors.push(`${where}: kind inválido ${JSON.stringify(p.kind)} — use "simple" ou "formula".`)
    }
  })

  // Ciclo no grafo de nomes DO LOTE — uma referência a uma medida já
  // existente nunca entra num ciclo novo (ela já foi validada acíclica
  // quando foi salva), então só as arestas formula->formula dentro do
  // próprio lote importam aqui. Mesmo algoritmo (DFS com pilha "na
  // recursão agora", não "já visitada alguma vez") do resolveMeasure real
  // em server/widgetQuery.mjs — um só lugar de verdade pro que conta como
  // ciclo, replicado aqui só porque a validação roda ANTES de qualquer id
  // existir (não dá pra chamar a mesma função, que opera por id).
  const graph = new Map()
  for (const p of list) {
    if (p.kind !== 'formula') continue
    graph.set(String(p.name).trim(), Object.values(p.refs ?? {}).filter((n) => namesInBatch.has(n)))
  }
  const visiting = new Set()
  const visited = new Set()
  const detectCycle = (name, path) => {
    if (visiting.has(name)) { errors.push(`Referência circular entre medidas: ${[...path, name].join(' → ')}.`); return }
    if (visited.has(name)) return
    visiting.add(name)
    for (const ref of graph.get(name) ?? []) detectCycle(ref, [...path, name])
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of graph.keys()) detectCycle(name, [])

  return errors
}

// Converte o lote aprovado em MeasureDef[] reais: gera um id de verdade por
// medida e resolve `refs` de NOME pra ID (o único lugar onde isso precisa
// acontecer — dali em diante o resto do motor só conhece id, nunca nome).
export function normalizeMeasureBatch(proposals, existingMeasures = []) {
  const existingIdByName = new Map(existingMeasures.map((m) => [m.name, m.id]))
  const stamp = Date.now().toString(36)
  // `idByName` indexa pelo nome ORIGINAL da proposta (o que os `refs` de
  // outras medidas do MESMO lote referenciam, já validado assim em
  // validateMeasureBatch) — a desambiguação de nome abaixo NUNCA muda essa
  // resolução, só o `name` final gravado na MeasureDef.
  const idByName = new Map()
  const withIds = proposals.map((p, i) => {
    const id = `ai-msr-${stamp}-${i}-${Math.random().toString(36).slice(2, 6)}`
    idByName.set(String(p.name).trim(), id)
    return { ...p, id }
  })

  // Nome que colide com uma medida JÁ SALVA (nomes DENTRO do lote já são
  // garantidos únicos por validateMeasureBatch) ganha "(2)", "(3)"... em vez
  // de falhar — cobre o pedido ambíguo que legitimamente é uma medida NOVA
  // parecida com uma existente (ex. "cria uma taxa de encerramento
  // diferente, considerando outro SLA"), sem forçar a IA a adivinhar um
  // nome alternativo ou travar num loop de erro de validação. Resolvido por
  // ÍNDICE (não por nome) porque mais de uma proposta do lote pode, em
  // teoria, colidir com a MESMA medida existente — cada uma desambigua pro
  // próximo número livre, na ordem em que aparecem.
  const usedNames = new Set(existingMeasures.map((m) => m.name))
  const finalNames = withIds.map((p) => {
    const original = String(p.name).trim()
    let final = original
    if (usedNames.has(final)) {
      let n = 2
      while (usedNames.has(`${original} (${n})`)) n++
      final = `${original} (${n})`
    }
    usedNames.add(final)
    return final
  })

  return withIds.map((p, i) => {
    const base = { id: p.id, name: finalNames[i], description: (p.description ?? '').trim() || undefined, format: p.format ?? undefined }
    if (p.kind === 'simple') {
      return { ...base, kind: 'simple', source: p.source, agg: p.agg, field: p.field || undefined, dateWindow: p.dateWindow ?? undefined, filters: p.filters?.length ? p.filters : undefined }
    }
    const refs = {}
    for (const [alias, refName] of Object.entries(p.refs ?? {})) {
      refs[alias] = idByName.get(refName) ?? existingIdByName.get(refName)
    }
    return { ...base, kind: 'formula', expression: p.expression, refs }
  })
}

// ─── Atualizar medida(s) JÁ EXISTENTE(S) — ver update_measures, aiAssistant.mjs ───
// Diferente de propose_measures (sempre CRIA — mesmo colidindo com um nome já
// usado, o que vira "(2)", "(3)"... em vez de editar), isto aplica um PATCH
// parcial numa medida que já existe, encontrada por ID (não por nome — evita
// qualquer ambiguidade quando duas medidas têm nome parecido). Cada `patch`
// segue o MESMO contrato de campo de uma proposta nova (refs por NOME, não
// por id — resolvido em normalizeMeasureUpdates), só que nenhum campo é
// obrigatório: o que não vier no patch continua como estava.
// Não suporta mudar `kind` (simple <-> formula é uma medida fundamentalmente
// diferente, não um "ajuste") nem remover um `format` já setado (a IA só
// LIGA; desligar é uma ação manual no modal — caso raro, não vale a
// complexidade de um terceiro estado "limpar" no schema agora).
export function validateMeasureUpdates(updates, sources, existingMeasures = []) {
  const list = Array.isArray(updates) ? updates : []
  if (list.length === 0) return ['Nenhuma atualização na proposta.']

  const errors = []
  const byId = new Map(existingMeasures.map((m) => [m.id, m]))
  const existingByName = new Map(existingMeasures.map((m) => [m.name, m]))
  const sourceOfName = (name) => existingByName.get(name)?.kind === 'simple' ? existingByName.get(name).source : null

  list.forEach((u, i) => {
    const where = `updates[${i}]`
    const existing = byId.get(u?.id)
    if (!existing) { errors.push(`${where}: medida "${u?.id}" não encontrada nesta dashboard — confira o id no catálogo.`); return }
    const patch = u?.patch
    if (!patch || typeof patch !== 'object') { errors.push(`${where}: patch ausente ou inválido.`); return }
    if (patch.kind !== undefined && patch.kind !== existing.kind) {
      errors.push(`${where}: não dá pra mudar "kind" (${existing.kind} → ${patch.kind}) numa atualização — para isso, apague a medida e crie outra.`); return
    }
    if (patch.format !== undefined && !MEASURE_FORMATS.includes(patch.format)) {
      errors.push(`${where}: format inválido ${JSON.stringify(patch.format)} — use "percent" ou omita.`)
    }
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) errors.push(`${where}: name não pode ficar vazio.`)
      else if (existingMeasures.some((m) => m.id !== existing.id && m.name === name)) {
        errors.push(`${where}: já existe outra medida chamada "${name}" nesta dashboard.`)
      }
    }

    if (existing.kind === 'simple') {
      const sourceKey = patch.source ?? existing.source
      const source = sources.find((s) => s.key === sourceKey)
      if (!source) { errors.push(`${where}: fonte "${sourceKey}" não está disponível nesta conversa.`); return }
      const agg = patch.agg ?? existing.agg
      if (patch.agg !== undefined && !AGGS.includes(patch.agg)) { errors.push(`${where}: agg inválida ${JSON.stringify(patch.agg)}.`); return }
      const field = patch.field !== undefined ? patch.field : existing.field
      if ((agg === 'sum' || agg === 'avg') && !field) { errors.push(`${where}: agg "${agg}" exige \`field\`.`); return }
      const fieldKeys = new Set(source.fields.map((f) => f.key))
      if (field && !fieldKeys.has(field)) { errors.push(`${where}: a fonte "${sourceKey}" não tem o campo "${field}".`); return }
      if (patch.dateWindow !== undefined && patch.dateWindow !== null) {
        const dwErr = validateDateWindowShape(patch.dateWindow, source, `${where}.dateWindow`)
        if (dwErr) errors.push(dwErr)
      }
      if (patch.filters !== undefined) {
        if (!Array.isArray(patch.filters)) { errors.push(`${where}: filters deve ser uma lista.`); return }
        patch.filters.forEach((f, fi) => {
          const fwhere = `${where}.filters[${fi}]`
          if (!f || typeof f !== 'object') { errors.push(`${fwhere}: filtro inválido.`); return }
          if (!f.field || !fieldKeys.has(f.field)) { errors.push(`${fwhere}: a fonte "${sourceKey}" não tem o campo "${f.field}".`); return }
          if (f.op !== 'in' && f.op !== 'notIn') { errors.push(`${fwhere}: op inválido ${JSON.stringify(f.op)} — use "in" ou "notIn".`); return }
          if (!Array.isArray(f.values) || f.values.length === 0) errors.push(`${fwhere}: "values" precisa ter ao menos 1 valor.`)
        })
      }
    } else if (existing.kind === 'formula' && (patch.expression !== undefined || patch.refs !== undefined)) {
      const expression = patch.expression ?? existing.expression
      let ast
      try { ast = parseExpression(expression) } catch (e) { errors.push(`${where}: expressão inválida — ${e.message}`); return }
      // refs do patch é por NOME (mesmo contrato de propose_measures) — se só
      // `expression` mudou, `refs` no patch continua opcional (mantém os de
      // antes), mas então os ALIASES da expressão precisam bater com o que já
      // existe; simplifica exigindo refs explícito sempre que expression muda.
      if (patch.expression !== undefined && patch.refs === undefined) {
        errors.push(`${where}: mudando "expression", informe "refs" (por nome) de novo também — não dá pra inferir se os aliases continuam os mesmos.`); return
      }
      const refs = patch.refs ?? {}
      const ids = extractIdentifiers(ast)
      for (const id of ids) {
        if (!(id in refs)) errors.push(`${where}: identificador "${id}" usado na expressão mas ausente em \`refs\`.`)
      }
      const sourcesTouched = new Set()
      for (const [alias, refName] of Object.entries(refs)) {
        const target = existingByName.get(refName) ?? (byId.get(refName) ? { name: refName } : null)
        if (!target) { errors.push(`${where}: refs.${alias} referencia "${refName}", que não existe nesta dashboard.`); continue }
        const s = sourceOfName(refName) ?? (byId.get(refName)?.kind === 'simple' ? byId.get(refName).source : null)
        if (s) sourcesTouched.add(s)
      }
      const description = patch.description !== undefined ? patch.description : existing.description
      if (sourcesTouched.size > 1 && !(description && String(description).trim())) {
        errors.push(`${where}: combina medidas de fontes diferentes (${[...sourcesTouched].join(', ')}) — preencha "description" explicando a suposição assumida.`)
      }
    }
  })

  return errors
}

// Aplica o(s) patch(es) validado(s) sobre a cópia de cada medida existente —
// resolve `patch.refs` (por NOME ou id) pra id, igual à criação. Devolve as
// MeasureDef completas já atualizadas (mesmo id de sempre — é uma edição no
// lugar, não uma medida nova), prontas pra upsert no rascunho da dashboard.
export function normalizeMeasureUpdates(updates, existingMeasures = []) {
  const byId = new Map(existingMeasures.map((m) => [m.id, m]))
  const nameToId = new Map(existingMeasures.map((m) => [m.name, m.id]))
  return updates.map((u) => {
    const existing = byId.get(u.id)
    const patch = u.patch ?? {}
    const merged = { ...existing }
    if (patch.name !== undefined) merged.name = String(patch.name).trim()
    if (patch.description !== undefined) merged.description = (patch.description ?? '').trim() || undefined
    if (patch.format !== undefined) merged.format = patch.format
    if (existing.kind === 'simple') {
      if (patch.source !== undefined) merged.source = patch.source
      if (patch.agg !== undefined) merged.agg = patch.agg
      if (patch.field !== undefined) merged.field = patch.field || undefined
      if (patch.dateWindow !== undefined) merged.dateWindow = patch.dateWindow ?? undefined
      if (patch.filters !== undefined) merged.filters = patch.filters?.length ? patch.filters : undefined
    } else {
      if (patch.expression !== undefined) merged.expression = patch.expression
      if (patch.refs !== undefined) {
        const refs = {}
        for (const [alias, refName] of Object.entries(patch.refs)) {
          refs[alias] = nameToId.get(refName) ?? refName // aceita nome OU um id já direto
        }
        merged.refs = refs
      }
    }
    return merged
  })
}
