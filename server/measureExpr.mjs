// ─────────────────────────────────────────────────────────────────────────
// Motor de expressão aritmética das medidas "fórmula" (ver MeasureDef,
// src/features/builder/types.ts) — combina medidas nomeadas já resolvidas
// (sempre um número escalar cada) numa conta tipo "(atual - anterior) /
// anterior * 100".
//
// NUNCA passa perto de eval/Function/vm: a string é tokenizada e parseada
// numa árvore (AST) própria, percorrida com um `switch(node.type)` na hora
// de avaliar — não existe caminho nenhum pra virar código JS de verdade,
// então não é "sandbox", é estruturalmente impossível gerar/injetar código
// a partir do texto da fórmula (que pode ter vindo da IA).
//
// Gramática (só o necessário pra combinar escalares — sem função, string,
// comparação):
//   expression := term (('+' | '-') term)*
//   term       := unary (('*' | '/' | '%') unary)*
//   unary      := ('-' | '+') unary | power
//   power      := primary ('^' unary)?      // ^ associa à direita
//   primary    := NUMBER | IDENTIFIER | '(' expression ')'
// ─────────────────────────────────────────────────────────────────────────

export const MAX_EXPR_LENGTH = 500
export const MAX_EXPR_DEPTH = 32

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([+\-*/%^()]))/y

function tokenize(str) {
  if (typeof str !== 'string') throw new Error('Expressão precisa ser um texto.')
  if (str.length === 0) throw new Error('Expressão vazia.')
  if (str.length > MAX_EXPR_LENGTH) throw new Error(`Expressão longa demais (máximo ${MAX_EXPR_LENGTH} caracteres).`)
  const tokens = []
  TOKEN_RE.lastIndex = 0
  let lastIndex = 0
  while (lastIndex < str.length) {
    TOKEN_RE.lastIndex = lastIndex
    const m = TOKEN_RE.exec(str)
    if (!m || m.index !== lastIndex) {
      throw new Error(`Caractere inesperado em "${str.slice(lastIndex, lastIndex + 10)}".`)
    }
    lastIndex = TOKEN_RE.lastIndex
    if (m[1] !== undefined) tokens.push({ type: 'num', value: Number(m[1]) })
    else if (m[2] !== undefined) tokens.push({ type: 'ref', name: m[2] })
    else if (m[3] !== undefined) tokens.push({ type: 'op', value: m[3] })
    // token vazio (só espaço em branco no fim) — nada a empurrar
  }
  return tokens
}

// Parser recursivo-descendente com contador de profundidade explícito —
// protege contra estouro de pilha tanto aqui quanto em evaluateExpression
// (mesma forma recursiva), já que uma expressão gigante tipo
// "((((((...))))))" passaria pelo limite de tamanho de string mas não pelo
// de profundidade sem essa checagem própria.
function makeParser(tokens) {
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  const checkDepth = (depth) => {
    if (depth > MAX_EXPR_DEPTH) throw new Error(`Expressão aninhada demais (máximo ${MAX_EXPR_DEPTH} níveis).`)
  }

  function parseExpression(depth) {
    checkDepth(depth)
    let left = parseTerm(depth + 1)
    while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value
      const right = parseTerm(depth + 1)
      left = { type: 'bin', op, left, right }
    }
    return left
  }

  function parseTerm(depth) {
    checkDepth(depth)
    let left = parseUnary(depth + 1)
    while (peek()?.type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = next().value
      const right = parseUnary(depth + 1)
      left = { type: 'bin', op, left, right }
    }
    return left
  }

  function parseUnary(depth) {
    checkDepth(depth)
    if (peek()?.type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = next().value
      const value = parseUnary(depth + 1)
      return op === '-' ? { type: 'neg', value } : value
    }
    return parsePower(depth + 1)
  }

  function parsePower(depth) {
    checkDepth(depth)
    const base = parsePrimary(depth + 1)
    if (peek()?.type === 'op' && peek().value === '^') {
      next()
      const exp = parseUnary(depth + 1) // ^ associa à direita: 2^3^2 = 2^(3^2)
      return { type: 'bin', op: '^', left: base, right: exp }
    }
    return base
  }

  function parsePrimary(depth) {
    checkDepth(depth)
    const t = peek()
    if (!t) throw new Error('Expressão incompleta.')
    if (t.type === 'num') { next(); return { type: 'num', value: t.value } }
    if (t.type === 'ref') { next(); return { type: 'ref', name: t.name } }
    if (t.type === 'op' && t.value === '(') {
      next()
      const inner = parseExpression(depth + 1)
      if (!(peek()?.type === 'op' && peek().value === ')')) throw new Error('Parêntese não fechado.')
      next()
      return inner
    }
    throw new Error(`Token inesperado "${t.type === 'op' ? t.value : t.name ?? t.value}".`)
  }

  return { parseExpression, remaining: () => tokens.length - pos }
}

// parseExpression(str) → AST. Lança erro claro (não silencioso) em
// qualquer forma de entrada malformada — sintaxe inválida, parêntese
// desbalanceado, texto sobrando depois de uma expressão válida.
export function parseExpression(str) {
  const tokens = tokenize(str)
  const parser = makeParser(tokens)
  const ast = parser.parseExpression(1)
  if (parser.remaining() > 0) throw new Error('Texto sobrando depois do fim da expressão.')
  return ast
}

// Todo identificador (`ref`) citado na árvore — usado na validação pra
// conferir que cada um tem uma entrada correspondente em `refs` ANTES de
// salvar a medida, não só na primeira vez que alguém tenta calculá-la.
export function extractIdentifiers(ast) {
  const names = new Set()
  const visit = (node) => {
    if (!node) return
    if (node.type === 'ref') { names.add(node.name); return }
    if (node.type === 'neg') { visit(node.value); return }
    if (node.type === 'bin') { visit(node.left); visit(node.right); return }
  }
  visit(ast)
  return names
}

// evaluateExpression(ast, scope) → number. `scope` é um Record<nome,
// número> com o valor JÁ RESOLVIDO de cada medida referenciada — nunca
// avalia nada além de aritmética sobre números concretos.
//
// Divisão/módulo por zero são normalizados pra NaN explicitamente (em vez
// do Infinity/NaN inconsistente do JS puro: 5/0 é Infinity, 0/0 é NaN) —
// um resultado indeterminado deve sempre se comportar da mesma forma daqui
// pra frente, pra quem for exibir o número tratar "indeterminado" como um
// caso só (nunca 0, que pareceria um resultado real e enganaria num
// comparativo).
export function evaluateExpression(ast, scope = {}, depth = 1) {
  if (depth > MAX_EXPR_DEPTH) throw new Error(`Expressão aninhada demais (máximo ${MAX_EXPR_DEPTH} níveis).`)
  if (!ast) throw new Error('Árvore de expressão vazia.')
  if (ast.type === 'num') return ast.value
  if (ast.type === 'ref') {
    if (!(ast.name in scope)) throw new Error(`Identificador desconhecido "${ast.name}".`)
    const v = scope[ast.name]
    return typeof v === 'number' ? v : NaN
  }
  if (ast.type === 'neg') return -evaluateExpression(ast.value, scope, depth + 1)
  if (ast.type === 'bin') {
    const a = evaluateExpression(ast.left, scope, depth + 1)
    const b = evaluateExpression(ast.right, scope, depth + 1)
    switch (ast.op) {
      case '+': return a + b
      case '-': return a - b
      case '*': return a * b
      case '/': return b === 0 ? NaN : a / b
      case '%': return b === 0 ? NaN : a % b
      case '^': return Math.pow(a, b)
      default: throw new Error(`Operador desconhecido "${ast.op}".`)
    }
  }
  throw new Error(`Tipo de nó desconhecido "${ast.type}".`)
}
