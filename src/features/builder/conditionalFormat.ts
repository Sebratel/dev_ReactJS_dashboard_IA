// Motor único de formatação condicional (item 2.1 das sugestões) — avalia um
// valor numérico contra a lista de regras do widget (ConditionalRule, ver
// types.ts) e devolve o efeito da última regra que bateu. Reaproveitado por
// KPI (item 11), gráficos/matriz (item 12) e fundo dinâmico (item 13) — a
// lógica de AVALIAR é a mesma em todo lugar; só a forma de aplicar o efeito
// (estilo do card, fill da barra, célula da matriz) muda por widget.
import type { ConditionalEffect, ConditionalRule } from './types'

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
