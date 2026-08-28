// Motor único de formatação condicional (item 2.1 das sugestões) — avalia um
// valor numérico contra a lista de regras do widget (ConditionalRule, ver
// types.ts) e devolve o efeito da última regra que bateu. Reaproveitado por
// KPI (item 11), gráficos/matriz (item 12) e fundo dinâmico (item 13) — a
// lógica de AVALIAR é a mesma em todo lugar; só a forma de aplicar o efeito
// (estilo do card, fill da barra, célula da matriz) muda por widget.
import type { ConditionalEffect, ConditionalRule, TableConditionalRule } from './types'

export function matchesRule(value: number, rule: ConditionalRule): boolean {
  switch (rule.operator) {
    case 'gt': return value > rule.value
    case 'gte': return value >= rule.value
    case 'lt': return value < rule.value
    case 'lte': return value <= rule.value
    case 'eq': return value === rule.value
    case 'neq': return value !== rule.value
    default: return false
  }
}

export function resolveConditionalEffect(value: number, rules: ConditionalRule[] | undefined): ConditionalEffect | undefined {
  if (!rules?.length || !Number.isFinite(value)) return undefined
  let matched: ConditionalEffect | undefined
  for (const rule of rules) {
    if (matchesRule(value, rule)) matched = rule.effect
  }
  return matched
}

export const OPERATOR_LABELS: Record<ConditionalRule['operator'], string> = {
  gt: 'maior que', gte: 'maior ou igual a', lt: 'menor que', lte: 'menor ou igual a', eq: 'igual a', neq: 'diferente de',
}

// Formatação condicional POR COLUNA da Tabela (ver TableConditionalRule,
// types.ts) — motor SEPARADO do de cima: compara TEXTO de célula, não valor
// numérico. Sempre sem diferenciar maiúsculas/minúsculas e com espaço nas
// pontas ignorado — mesmo problema real já visto neste projeto ("Concluído"
// vs "CONCLUIDO" vs "concluido" no dado de origem).
export function matchesTableRule(cellText: string, rule: TableConditionalRule): boolean {
  const match = rule.match.trim().toLowerCase()
  if (!match) return false
  const value = cellText.trim().toLowerCase()
  return rule.operator === 'contains' ? value.includes(match) : value === match
}

// Só considera regras da MESMA coluna da célula — a última que bater vence
// (mesma semântica de "última regra vence" do motor numérico, só que
// filtrada por coluna primeiro, já que regras de colunas diferentes não
// competem entre si).
export function resolveTableCellEffect(cellText: string, column: string, rules: TableConditionalRule[] | undefined): TableConditionalRule | undefined {
  if (!rules?.length) return undefined
  let matched: TableConditionalRule | undefined
  for (const rule of rules) {
    if (rule.column !== column) continue
    if (matchesTableRule(cellText, rule)) matched = rule
  }
  return matched
}

// Regras com `applyTo: 'row'` — a linha inteira, não só a célula da coluna
// avaliada. Testa a regra contra o valor DA LINHA na coluna dela (não uma
// célula específica sendo desenhada), então é calculado uma vez por linha e
// reaproveitado pra toda célula — não uma vez por célula, como o de cima.
// Todas as regras de linha competem entre si (não só as da mesma coluna),
// a última que bater vence.
export function resolveTableRowEffect(row: Record<string, unknown>, rules: TableConditionalRule[] | undefined): TableConditionalRule | undefined {
  if (!rules?.length) return undefined
  let matched: TableConditionalRule | undefined
  for (const rule of rules) {
    if (rule.applyTo !== 'row') continue
    const raw = row[rule.column]
    const text = raw == null ? '' : String(raw)
    if (matchesTableRule(text, rule)) matched = rule
  }
  return matched
}
