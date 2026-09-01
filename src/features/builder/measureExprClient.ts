// Espelho, só de LEITURA, da gramática restrita de server/measureExpr.mjs —
// usado exclusivamente pra converter uma fórmula existente de volta pro
// construtor "passo a passo" do MeasuresEditorModal.tsx (nunca pra AVALIAR
// uma medida de verdade, que sempre acontece no servidor, sobre dado real).
// Se esse arquivo um dia desalinhar da gramática do servidor, o único efeito
// é `decomposeFormula` falhar com mais frequência — nesse caso a UI cai pro
// "modo avançado" (texto), que continua cobrindo a gramática inteira sem
// depender deste espelho. Nunca usado pra decidir o que É calculável, só
// pra decidir COMO mostrar algo já salvo na UI simples.
import type { MeasureDef } from './types'

type ExprAst =
  | { type: 'num'; value: number }
  | { type: 'ref'; name: string }
  | { type: 'neg'; value: ExprAst }
  | { type: 'bin'; op: '+' | '-' | '*' | '/' | '%' | '^'; left: ExprAst; right: ExprAst }

type Token = { type: 'num'; value: number } | { type: 'ref'; name: string } | { type: 'op'; value: string }

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([+\-*/%^()]))/y

function tokenize(str: string): Token[] {
  const tokens: Token[] = []
  TOKEN_RE.lastIndex = 0
  let lastIndex = 0
  while (lastIndex < str.length) {
    TOKEN_RE.lastIndex = lastIndex
    const m = TOKEN_RE.exec(str)
    if (!m || m.index !== lastIndex) throw new Error('Caractere inesperado.')
    lastIndex = TOKEN_RE.lastIndex
    if (m[1] !== undefined) tokens.push({ type: 'num', value: Number(m[1]) })
    else if (m[2] !== undefined) tokens.push({ type: 'ref', name: m[2] })
    else if (m[3] !== undefined) tokens.push({ type: 'op', value: m[3] })
  }
  return tokens
}

function makeParser(tokens: Token[]) {
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const peekOp = (...values: string[]) => { const t = peek(); return !!t && t.type === 'op' && values.includes(t.value) }

  function parseExpression(): ExprAst {
    let left = parseTerm()
    while (peekOp('+', '-')) {
      const op = (next() as { type: 'op'; value: '+' | '-' }).value
      left = { type: 'bin', op, left, right: parseTerm() }
    }
    return left
  }
  function parseTerm(): ExprAst {
    let left = parseUnary()
    while (peekOp('*', '/', '%')) {
      const op = (next() as { type: 'op'; value: '*' | '/' | '%' }).value
      left = { type: 'bin', op, left, right: parseUnary() }
    }
    return left
  }
  function parseUnary(): ExprAst {
    if (peekOp('-', '+')) {
      const op = (next() as { type: 'op'; value: '+' | '-' }).value
      const value = parseUnary()
      return op === '-' ? { type: 'neg', value } : value
    }
    return parsePower()
  }
  function parsePower(): ExprAst {
    const base = parsePrimary()
    if (peekOp('^')) { next(); return { type: 'bin', op: '^', left: base, right: parseUnary() } }
    return base
  }
  function parsePrimary(): ExprAst {
    const t = peek()
    if (!t) throw new Error('Expressão incompleta.')
    if (t.type === 'num') { next(); return { type: 'num', value: t.value } }
    if (t.type === 'ref') { next(); return { type: 'ref', name: t.name } }
    if (t.type === 'op' && t.value === '(') {
      next()
      const inner = parseExpression()
      if (!peekOp(')')) throw new Error('Parêntese não fechado.')
      next()
      return inner
    }
    throw new Error('Token inesperado.')
  }

  return { parseExpression, remaining: () => tokens.length - pos }
}

function parseExpressionClient(str: string): ExprAst {
  if (!str || !str.trim()) throw new Error('Expressão vazia.')
  const parser = makeParser(tokenize(str))
  const ast = parser.parseExpression()
  if (parser.remaining() > 0) throw new Error('Texto sobrando depois do fim da expressão.')
  return ast
}

// ─── Construtor "passo a passo" (MeasuresEditorModal) ──────────────────────

export type FormulaTerm = { kind: 'measure'; measureId: string } | { kind: 'number'; value: number }
export type FormulaOp = '+' | '-' | '*' | '/'
export interface FormulaStep { op: FormulaOp; term: FormulaTerm }

export const FORMULA_OP_LABELS: Record<FormulaOp, string> = { '+': 'Somar', '-': 'Subtrair', '*': 'Multiplicar', '/': 'Dividir' }
export const FORMULA_OP_SYMBOLS: Record<FormulaOp, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' }

function isLeaf(node: ExprAst): node is { type: 'num'; value: number } | { type: 'ref'; name: string } {
  return node.type === 'num' || node.type === 'ref'
}

function leafToTerm(node: { type: 'num'; value: number } | { type: 'ref'; name: string }, refs: Record<string, string>): FormulaTerm | null {
  if (node.type === 'num') return { kind: 'number', value: node.value }
  const measureId = refs[node.name]
  return measureId ? { kind: 'measure', measureId } : null
}

// Decompõe um AST em { first, steps } SE (e só se) ele for uma cadeia
// left-fold de + - * / sobre folhas (número ou referência) — a forma que
// buildFormulaFromSteps sempre gera (parênteses amarrados à esquerda), e que
// a maioria das fórmulas reais (inclusive as escritas pela IA, ex. "(atual -
// anterior) / anterior * 100") também tem, já que + - * / só mudam de ordem
// de verdade quando misturados com parênteses "invertidos" — raro na prática.
// Qualquer coisa fora disso (negação unária, %, ^, parênteses agrupando dos
// dois lados de um operador) devolve null — cai no modo avançado (texto) em
// vez de forçar uma UI que não representa a conta de verdade.
export function decomposeFormula(expression: string, refs: Record<string, string>): { first: FormulaTerm; steps: FormulaStep[] } | null {
  let ast: ExprAst
  try { ast = parseExpressionClient(expression) } catch { return null }
  const steps: FormulaStep[] = []
  let node = ast
  while (node.type === 'bin' && (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '/') && isLeaf(node.right)) {
    const term = leafToTerm(node.right, refs)
    if (!term) return null
    steps.unshift({ op: node.op, term })
    node = node.left
  }
  if (!isLeaf(node) || steps.length === 0) return null
  const first = leafToTerm(node, refs)
  return first ? { first, steps } : null
}

export function isFormulaTermValid(t: FormulaTerm): boolean {
  return t.kind === 'number' ? Number.isFinite(t.value) : !!t.measureId
}

// Monta expression+refs a partir da cadeia — SEMPRE com parênteses
// explícitos amarrando à esquerda, garantindo que o motor (que respeita a
// precedência normal de * / sobre + -) calcule na MESMA ordem, passo a
// passo, que a UI mostra — nunca uma ordem de conta diferente da sequência
// visível na tela, mesmo misturando operadores de precedência diferente.
export function buildFormulaFromSteps(first: FormulaTerm, steps: FormulaStep[]): { expression: string; refs: Record<string, string> } | null {
  if (!isFormulaTermValid(first) || steps.length === 0 || steps.some((s) => !isFormulaTermValid(s.term))) return null
  const refs: Record<string, string> = {}
  let nextIdx = 1
  const aliasFor = (measureId: string) => {
    const existing = Object.entries(refs).find(([, id]) => id === measureId)
    if (existing) return existing[0]
    const alias = `ref${nextIdx++}`
    refs[alias] = measureId
    return alias
  }
  const termStr = (t: FormulaTerm) => (t.kind === 'number' ? String(t.value) : aliasFor(t.measureId))
  let expr = termStr(first)
  for (const s of steps) expr = `(${expr} ${s.op} ${termStr(s.term)})`
  return { expression: expr, refs }
}

// Resumo em português (nomes de medida, não aliases/expressão crua) pra
// mostrar na lista fechada de medidas — cai pra expressão bruta quando não
// decompõe (fórmula complexa demais, escrita à mão ou por IA fora do padrão
// left-fold), pra nunca esconder informação por causa do resumo.
export function humanFormulaLabel(expression: string, refs: Record<string, string>, measures: MeasureDef[]): string {
  const decomp = decomposeFormula(expression, refs)
  if (!decomp) return expression
  const nameOf = (t: FormulaTerm) => (t.kind === 'number' ? String(t.value) : measures.find((m) => m.id === t.measureId)?.name ?? 'medida removida')
  let s = nameOf(decomp.first)
  for (const step of decomp.steps) s = `${s} ${FORMULA_OP_SYMBOLS[step.op]} ${nameOf(step.term)}`
  return s
}
