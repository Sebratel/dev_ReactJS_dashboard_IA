// ─────────────────────────────────────────────────────────────────────────
// Teste da lógica do FILTRO POR CLIQUE (src/features/builder/clickFilter.ts).
// Roda com: npm run test:click
//
// Só a parte pura: do que foi clicado para condições (valor, nível de data,
// campo de outra fonte, chave composta), a seleção depois de cada clique (com
// e sem Ctrl), os filtros de guia que cada widget recebe (o de origem nunca se
// filtra), o que fica aceso no widget clicado e o texto do balão.
//
// Que o filtro gerado dá o MESMO número que a barra clicada — por mês,
// hierarquia de datas, relação, célula de matriz e medidas nomeadas, na cópia
// e na leitura direta — está no test:direct, que tem as duas fontes montadas.
// ─────────────────────────────────────────────────────────────────────────
import { dirname, resolve as resolvePath } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const RAIZ = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const cf = await import(pathToFileURL(resolvePath(RAIZ, 'src', 'features', 'builder', 'clickFilter.ts')).href)

let falhas = 0
let total = 0
function ok(cond, nome, detalhe = '') {
  total++
  if (cond) console.log(`  PASS  ${nome}`)
  else { falhas++; console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ''}`) }
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const P = 'dhub:protocolos'
const B = 'dhub:bases'
const ctx = { source: P, relatedSources: [B] }

console.log('\n── nível de data → período ──')
ok(igual(cf.bucketRange('year', '2026'), { from: '2026-01-01', to: '2026-12-31' }), 'ano inteiro')
ok(igual(cf.bucketRange('quarter', '2026-Q1'), { from: '2026-01-01', to: '2026-03-31' })
  && igual(cf.bucketRange('quarter', '2026-Q4'), { from: '2026-10-01', to: '2026-12-31' }), 'trimestre (1º e 4º)')
ok(igual(cf.bucketRange('month', '2028-02'), { from: '2028-02-01', to: '2028-02-29' })
  && igual(cf.bucketRange('month', '2026-02'), { from: '2026-02-01', to: '2026-02-28' }), 'mês, com fevereiro bissexto e não bissexto')
ok(igual(cf.bucketRange('day', '2026-03-05'), { from: '2026-03-05', to: '2026-03-05' }), 'dia')
ok(cf.bucketRange('month', 'Março') === null && cf.bucketRange('quarter', '2026-Q5') === null, 'chave fora do formato não vira período')

console.log('\n── do clique para condições ──')
ok(igual(cf.resolveField(`${B}.Região`, ctx), { source: B, field: 'Região' }), 'campo de outra fonte vai para a fonte dele')
ok(igual(cf.resolveField('Valor R$.bruto', ctx), { source: P, field: 'Valor R$.bruto' }), 'campo nativo com ponto no nome continua nativo')
ok(igual(cf.condsOf(['Cidade'], 'Natal', ctx), [{ source: P, field: 'Cidade', value: 'Natal' }]), 'uma dimensão: o valor inteiro (sem partir em " / ")')
ok(igual(cf.condsOf(['Cidade'], 'A / B', ctx), [{ source: P, field: 'Cidade', value: 'A / B' }]), 'valor com " / " numa dimensão só fica inteiro')
const composta = cf.condsOf(['Cidade', `${B}.Região`], 'Natal / Nordeste', ctx)
ok(igual(composta, [{ source: P, field: 'Cidade', value: 'Natal' }, { source: B, field: 'Região', value: 'Nordeste' }]), 'eixo com duas dimensões: uma condição por parte, cada uma na sua fonte')
ok(cf.condsOf(['Cidade', 'Status'], 'Natal / Aberto / extra', ctx) === null, 'partes que não batem com as dimensões: não arrisca')
const hier = cf.condsOf(['year:Data', 'month:Data'], '2026 / 2026-03', ctx)
ok(hier?.length === 2 && hier[1].bucket === 'month' && hier[1].from === '2026-03-01' && hier[1].to === '2026-03-31', 'hierarquia de datas: um período por nível')
ok(cf.condsOf(['month:Data'], 'Março', ctx) === null, 'rótulo bonito ("Março") sem a chave crua não filtra')
ok(cf.condsOf([], 'x', ctx) === null && cf.condsOf(undefined, 'x', ctx) === null, 'sem dimensão (KPI): nada para filtrar')

console.log('\n── seleção ──')
const natal = { conds: [{ source: P, field: 'Cidade', value: 'Natal' }] }
const mossoro = { conds: [{ source: P, field: 'Cidade', value: 'Mossoró' }] }
const aberto = { conds: [{ source: P, field: 'Status', value: 'Aberto' }] }
let sel = cf.applyClick(cf.NO_SELECTION, 'w1', natal, { multi: false })
ok(igual(sel, { w1: [natal] }), 'clique simples seleciona')
ok(cf.applyClick(sel, 'w1', natal, { multi: false }) === cf.NO_SELECTION, 'clicar de novo no mesmo desfaz')
ok(igual(cf.applyClick(sel, 'w1', mossoro, { multi: false }), { w1: [mossoro] }), 'clicar em outro troca')
sel = cf.applyClick(sel, 'w1', mossoro, { multi: true })
ok(igual(sel, { w1: [natal, mossoro] }), 'Ctrl+clique soma no mesmo widget')
sel = cf.applyClick(sel, 'w2', aberto, { multi: true })
ok(igual(sel, { w1: [natal, mossoro], w2: [aberto] }), 'Ctrl+clique em outro widget mantém os dois')
ok(igual(cf.applyClick(sel, 'w2', aberto, { multi: false }), { w2: [aberto] }), 'clique simples num item já escolhido, com outros junto, fica só com ele')
let s2 = cf.applyClick(sel, 'w1', natal, { multi: true })
s2 = cf.applyClick(s2, 'w1', mossoro, { multi: true })
ok(igual(s2, { w2: [aberto] }), 'Ctrl+clique tira; widget sem itens sai da seleção')
ok(cf.applyClick(cf.applyClick(cf.NO_SELECTION, 'w1', natal, { multi: true }), 'w1', natal, { multi: true }) === cf.NO_SELECTION, 'tirar o último item zera a seleção')
ok(cf.selectionItems({ w1: [natal], w2: [natal, aberto] }).length === 2, 'o balão não repete o mesmo item de dois widgets')

console.log('\n── filtros que cada widget recebe ──')
const rotulo = (f) => f.field
const filtrosW3 = cf.selectionToTabFilters(sel, 'w3', rotulo)
ok(filtrosW3.length === 2 && igual(filtrosW3[0].values, ['Natal', 'Mossoró']) && filtrosW3[0].filter.type === 'multiselect'
  && filtrosW3[1].filter.field === 'Status', 'outro widget: um filtro por campo, valores do mesmo widget somados (OU)')
ok(cf.selectionToTabFilters(sel, 'w1', rotulo).every((t) => t.filter.field !== 'Cidade'), 'o widget onde se clicou não se filtra pelo próprio clique')
ok(new Set(filtrosW3.map((t) => t.filter.id)).size === filtrosW3.length && filtrosW3.every((t) => cf.isClickFilterId(t.filter.id)), 'ids únicos e reconhecíveis como filtro por clique')
const mes = (k) => ({ conds: cf.condsOf(['month:Data'], k, ctx) })
const periodo = cf.selectionToTabFilters({ w1: [mes('2026-03'), mes('2026-05')] }, 'w9', rotulo)
ok(periodo.length === 1 && periodo[0].filter.type === 'daterange' && igual(periodo[0].values, ['2026-03-01', '2026-05-31']), 'vários meses com Ctrl viram o período do primeiro ao último')
const hierItem = { conds: cf.condsOf(['year:Data', 'month:Data'], '2026 / 2026-03', ctx) }
const doHier = cf.selectionToTabFilters({ w1: [hierItem] }, 'w9', rotulo)
ok(doHier.length === 1 && igual(doHier[0].values, ['2026-03-01', '2026-03-31']), 'ano e mês do mesmo campo se cruzam: fica o mês')
const regiao = { conds: cf.condsOf([`${B}.Região`], 'Nordeste', ctx) }
const viaRelacao = cf.selectionToTabFilters({ w1: [regiao] }, 'w9', rotulo)
ok(viaRelacao[0].filter.source === B && viaRelacao[0].filter.field === 'Região', 'campo de outra fonte vira filtro DAQUELA fonte (a relação traz de volta)')
const vazio = { conds: cf.condsOf(['Cidade'], '', ctx) }
ok(igual(cf.selectionToTabFilters({ w1: [vazio] }, 'w9', rotulo)[0].values, ['']), 'célula vazia filtra pelo vazio')

console.log('\n── o que fica aceso no widget clicado ──')
ok(cf.isLit([], natal.conds), 'sem nada clicado, tudo aceso')
ok(cf.isLit([natal], natal.conds) && !cf.isLit([natal], mossoro.conds), 'acende o clicado, esmaece o resto')
ok(cf.isLit([natal, mossoro], mossoro.conds), 'com Ctrl, os dois acesos')
const linhaA = cf.condsOf(['Técnico'], 'Ana', ctx)
const celulaItem = { conds: [...linhaA, ...cf.condsOf(['Hora'], '08:00', ctx)] }
ok(cf.isLit([celulaItem], linhaA), 'matriz: célula clicada deixa o rótulo da linha aceso')
ok(!cf.isLit([celulaItem], [...linhaA, ...cf.condsOf(['Hora'], '09:00', ctx)]), 'e esmaece as outras células da linha')
ok(cf.isLit([mes('2026-03'), mes('2026-05')], cf.condsOf(['month:Data'], '2026-04', ctx)), 'período do primeiro ao último: o mês do meio acende junto')
ok(!cf.isLit([mes('2026-03')], cf.condsOf(['month:Data'], '2026-04', ctx)), 'e o mês de fora esmaece')
ok(cf.isLit([natal], null), 'elemento sem condições não esmaece')

console.log('\n── texto do balão ──')
const nome = (c) => (c.field === 'Cidade' ? 'Cidade' : c.field)
ok(cf.describeItem(natal, nome) === 'Cidade: Natal', 'um campo: "Campo: valor"')
ok(cf.describeItem({ conds: composta }, nome) === 'Natal · Nordeste', 'vários campos: valores separados por ·')
ok(cf.describeItem(mes('2026-03'), (c) => c.field) === 'Data: 03/2026', 'mês em mm/aaaa')
ok(cf.describeItem(vazio, nome) === 'Cidade: (vazio)', 'vazio como "(vazio)"')
ok(cf.condValueText({ source: P, field: 'Abertura', value: '2026-03-05T10:00:00' }) === '05/03/2026', 'data crua de tabela em dd/mm/aaaa')

console.log(`\n${total - falhas}/${total} conferências passaram`)
process.exit(falhas ? 1 : 0)
