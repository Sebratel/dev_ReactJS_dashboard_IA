// Config declarativa do Dashboard Builder — a fonte de verdade do que cada
// aba mostra. Editada pela UI (modo edição), salva compartilhada no servidor
// (data/dashboard-config.json) e versionada para migrações futuras.

// Id de uma query do catálogo único (Configurações → Queries) — dinâmico,
// não é mais um conjunto fixo de tabelas: qualquer query adicionada/editada
// vira uma fonte selecionável, com campos inferidos dos dados reais (ver
// fieldCatalog.ts/registerDynamicSources e server/widgetQuery.mjs).
export type SourceTable = string

export type WidgetType =
  | 'kpi' | 'bar' | 'barH' | 'barStacked' | 'barHStacked' | 'comboBarLine'
  | 'line' | 'area' | 'pie' | 'scatter' | 'funnel' | 'table' | 'matrix' | 'text' | 'histogram'
export type AggKind = 'countDistinct' | 'count' | 'sum' | 'avg'
export type FilterOp = 'in' | 'notIn'

export interface MeasureConfig {
  agg: AggKind
  field?: string // exigido para sum/avg
  label?: string // rótulo da série (só relevante quando há múltiplas medidas)
  color?: string // cor da série (só relevante quando há múltiplas medidas)
  // Override do widget.dataLabels só para ESTA série — ausente = usa o padrão
  // do widget (aba Formato → Rótulos de dados); definido = liga/desliga e
  // estiliza independente das outras séries. Só relevante com múltiplas
  // medidas ou legenda (uma única medida já é "o widget inteiro").
  dataLabels?: DataLabelFormat
}

export interface WidgetFilter {
  field: string
  op: FilterOp
  values: string[]
}

export interface WidgetLayout { x: number; y: number; w: number; h: number }

// Formatação específica de widgets 'table' — estilo Power BI (painel
// Formato → Cabeçalho da coluna / Valores). columnLabels permite renomear o
// cabeçalho exibido de uma coluna sem mudar o campo/chave real por trás.
export interface TableFormat {
  fontSize?: number                    // px, aplica ao corpo da tabela
  align?: 'left' | 'center' | 'right'  // alinhamento do texto nas células
  headerBold?: boolean
  columnLabels?: Record<string, string>
  color?: string                       // cor do texto (cabeçalho + corpo) — ausente = padrão do app
  // Largura (px) de cada coluna, por chave (mesma chave usada em columnLabels)
  // — ajustada arrastando a borda do cabeçalho (ver TableBody em
  // WidgetRenderer.tsx). Coluna ausente aqui usa a largura automática padrão
  // (cabe o conteúdo, com truncamento). Sem mínimo real além de um valor bem
  // pequeno pra alça ficar arrastável — encolher bastante é permitido mesmo
  // que trunque o texto ou empurre visualmente a coluna vizinha.
  columnWidths?: Record<string, number>
}

// Formatação de texto genérica — usada pelo cabeçalho do Eixo X/Eixo Y (nos
// gráficos) e pelas Linhas/Colunas da Matriz. `backgroundColor` desenha um
// fundo atrás do texto (só nos eixos: exige um tick customizado com <rect>,
// já que SVG <text> não tem fundo nativo; na Matriz é só CSS de célula).
export interface TextFormat {
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  opacity?: number           // 0-100 — opacidade da cor do texto (só faz sentido com `color` definido)
  backgroundColor?: string
  backgroundOpacity?: number // 0-100 — opacidade da cor de fundo (só faz sentido com `backgroundColor` definido)
  // Recuo manual (px), só usado em Eixo X/Eixo Y — soma por cima do espaço
  // reservado calculado automaticamente pro rótulo do eixo (altura no Eixo X,
  // largura no Eixo Y). O cálculo automático nem sempre é suficiente (ex.
  // números grandes cortando mesmo na fonte padrão); aceita negativo, pra
  // apertar o espaço quando o automático reserva mais do que precisa.
  margin?: number
}

// Rótulos de dados sobre o próprio gráfico (valor/nome/% em cada barra,
// ponto, fatia etc.) — estilo Power BI ("Rótulos de dados" no painel Formato).
export type DataLabelPosition = 'inside' | 'outside' | 'top' | 'center'
export type DataLabelContent = 'value' | 'name' | 'percent' | 'valueAndName' | 'all'
export interface DataLabelFormat {
  show?: boolean
  position?: DataLabelPosition
  content?: DataLabelContent
  fontSize?: number
  color?: string
  opacity?: number // 0-100
}

// Motor único de formatação condicional (meta + regra + efeito) — reaproveitado
// por KPI (card muda de cor/pisca conforme a meta), gráficos (barra muda de
// cor conforme o valor daquele ponto) e o "fundo dinâmico" do widget. Uma
// lista de regras "se o valor for {operador} {value}, aplica {efeito}" —
// avaliadas em ORDEM, a ÚLTIMA que bater vence (dá pra empilhar regras em
// cascata, ex. "verde se >= meta" seguida de "vermelho se < meta").
export type ConditionalOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
export interface ConditionalEffect {
  backgroundColor?: string // cor de fundo (card do KPI / barra do gráfico / célula da matriz)
  blink?: boolean          // pisca (animação de opacidade)
  glow?: boolean           // brilho (sombra colorida ao redor)
}
export interface ConditionalRule {
  id: string
  operator: ConditionalOperator
  value: number
  effect: ConditionalEffect
}

// Coluna extra de uma tabela relacionada, mesclada por chave (só type 'table').
// Ex.: numa tabela de protocolosGeral, trazer o instalador que veio de
// fieldAgenda casando protocolosGeral.numeroProtocolo = fieldAgenda.protocolo.
// Quando a fonte relacionada tem múltiplas linhas para a mesma chave (ex.
// vários relatos no mesmo protocolo), usa-se a primeira linha encontrada.
export interface LookupColumn {
  source: SourceTable
  localKey: string   // campo na fonte principal do widget
  foreignKey: string // campo correspondente na fonte relacionada
  field: string       // campo a trazer da fonte relacionada
  label: string
}

export interface WidgetConfig {
  id: string
  type: WidgetType
  title: string
  subtitle?: string
  content?: string // type 'text' — texto simples (sem markdown), renderizado com quebras de linha preservadas
  // Widgets genéricos (bar/barH/barStacked/barHStacked/comboBarLine/line/area/pie/scatter/funnel/kpi/table)
  source?: SourceTable
  dimensions?: string[]       // Eixo X — 1+ campos (ou bucket de data 'day:<campo>' | 'month:<campo>'); múltiplos = agrupamento composto, rótulo "A / B"
  legendDimension?: string    // 2ª dimensão (bar*/line/area/comboBarLine) — quebra em série por valor
  measure?: MeasureConfig     // legado/single — kpi, pie, funnel e table (fallback) usam só esta
  measures?: MeasureConfig[]  // bar*/line/area/comboBarLine — 1 série por medida (ignorado se legendDimension setado)
  measuresLine?: MeasureConfig[] // comboBarLine — série(s) de LINHA no eixo Y secundário (à direita)
  measureX?: MeasureConfig    // scatter — medida do eixo X; `measure`/`measures` seguem sendo o eixo Y
  histogramField?: string     // type 'histogram' — campo numérico cujos valores são divididos em faixas
  histogramBins?: number      // type 'histogram' — quantidade de faixas (padrão 10)
  widgetFilters?: WidgetFilter[]
  limit?: number
  sort?: 'asc' | 'desc'
  columns?: string[]          // type 'table' — ordem define a ordem das colunas exibidas
  lookups?: LookupColumn[]    // type 'table' — colunas mescladas de outras fontes
  tableFormat?: TableFormat   // type 'table' — fonte/alinhamento/cabeçalho/renomear coluna
  matrixRows?: string[]       // type 'matrix' — 1+ campos, hierarquia de linhas (com subtotal por nível)
  matrixColumns?: string[]    // type 'matrix' — 1+ campos, agrupamento de colunas (combinados em rótulo composto)
  matrixValue?: MeasureConfig // type 'matrix' — medida única, uma célula por (linha × coluna)
  axisXFormat?: TextFormat        // gráficos com eixo — formatação do texto do Eixo X
  axisYFormat?: TextFormat        // gráficos com eixo — formatação do texto do Eixo Y
  matrixRowFormat?: TextFormat    // type 'matrix' — formatação do texto das Linhas
  matrixColumnFormat?: TextFormat // type 'matrix' — formatação do cabeçalho das Colunas
  dataLabels?: DataLabelFormat    // rótulos de dados sobre o gráfico (barra/ponto/fatia)
  titleFormat?: TextFormat        // formatação do texto do título do widget
  subtitleFormat?: TextFormat     // formatação do texto do subtítulo do widget
  legendFormat?: TextFormat       // formatação do texto da legenda (embaixo do gráfico)
  gridLines?: 'both' | 'horizontal' | 'vertical' | 'none' // linhas de grade pontilhadas do fundo — padrão 'both'
  backgroundColor?: string        // cor de fundo do card do widget (ausente = padrão do tema)
  backgroundOpacity?: number      // 0-100 — opacidade do fundo do card (só com `backgroundColor` definido)
  seriesOpacity?: number          // 0-100 — opacidade das colunas/linhas/fatias do gráfico
  iconColor?: string              // cor dos ícones de editar/duplicar/excluir no cabeçalho (modo edição)
  color?: string
  // Meta e alertas (motor de formatação condicional — ver ConditionalRule):
  // `target` desenha uma linha de referência no gráfico (bar/line/area/
  // comboBarLine) e é o valor comparado no KPI; `conditionalRules` decide
  // cor de fundo/pisca/brilho conforme o valor (do KPI, de cada barra do
  // gráfico, ou do card do widget) em relação às regras.
  target?: number
  conditionalRules?: ConditionalRule[]
  // Efeitos visuais estáticos (sempre ativos, independente de dado) — aba
  // Formato → Aparência do widget.
  shadow?: boolean
  glow?: boolean
  blink?: boolean
  // Sequência de cores usada nas séries/fatias sem cor própria definida (pizza,
  // funil, dispersão, ou barra/linha sem `color`/`measures[].color`) — ausente
  // = paleta padrão do app. Só é preenchida ao aplicar um tema (ver
  // themePresets.ts); não tem editor próprio no WidgetEditorModal.
  palette?: string[]
  layout: WidgetLayout
}

export interface FilterConfig {
  id: string
  source: SourceTable
  field: string
  label: string
  type: 'multiselect' | 'daterange'
}

// Tamanho de tela fixo, estilo Power BI ("Configurações de tela" → Tipo
// Personalizar). Sem isso, a aba usa a largura fluida do container (padrão
// atual). Com isso, a grade passa a ter exatamente `width` px (rolagem
// horizontal se a janela for menor) e a caixa da tela tem no mínimo `height`
// px, com o conteúdo alinhado dentro dela por `verticalAlign`.
export interface CanvasConfig {
  width: number
  height: number
  verticalAlign?: 'top' | 'middle' | 'bottom'
}

// Atualização automática (silenciosa, sem F5) — pensada pra telas expostas
// sem interação, ex. TV de painel de um setor. Refaz a busca de dados de
// todos os widgets da aba a cada `minutes`, sem recarregar a página nem
// afetar o modo edição (só roda quando a aba está em modo visualização).
export interface TabAutoRefresh {
  enabled: boolean
  minutes: number
}

// Controle de acesso de uma guia dentro da hierarquia Pasta → Dashboard →
// Guia (ver server/workspace.mjs). 'open' = qualquer um com acesso à pasta
// vê a guia (usado pela guia de boas-vindas, sempre aberta); 'restricted' =
// só quem está em `view`/`edit` (além de admin/gerente da pasta, que sempre
// têm acesso total). `edit` é independente de `view` — um usuário pode ter
// só visualização, ou visualização + criação/modificação de widgets.
export interface TabAccess {
  mode: 'open' | 'restricted'
  view: string[]
  edit: string[]
}

export interface TabConfig {
  id: string
  label: string
  icon?: string               // nome de ícone lucide (fallback: LayoutDashboard)
  canvas?: CanvasConfig
  autoRefresh?: TabAutoRefresh
  filters: FilterConfig[]
  widgets: WidgetConfig[]
  access?: TabAccess           // ausente = tratado como 'open' (guias legadas/migradas)
  isWelcome?: boolean          // guia de boas-vindas auto-criada — não pode ser removida
}

export interface DashboardConfig {
  version: number
  tabs: TabConfig[]
}

// Filtros ativos escolhidos pelo usuário numa aba (estado de visualização,
// não persiste na config — cada um vê seus próprios filtros ativos).
export interface ActiveFilters {
  // filterId → valores selecionados (multiselect) ou [from, to] ISO (daterange)
  [filterId: string]: string[]
}

export interface WidgetDataRequest {
  widget: WidgetConfig
  tabFilters: { filter: FilterConfig; values: string[] }[]
  page?: number               // type 'table'
  pageSize?: number
}

export interface WidgetDataPoint { label: string; value: number; x?: number }

// Metadado de uma série extra num ponto (quando o widget tem measures[] ou
// legendDimension) — a chave real do valor no ponto vive em WidgetDataPoint
// como propriedade dinâmica (ex. point['s0'] ou point['Equipe Norte']).
// `role` só é usado por comboBarLine, pra distinguir séries de coluna (eixo Y
// principal) das de linha (eixo Y secundário) na hora de renderizar.
export interface SeriesMeta { key: string; label: string; color?: string; role?: 'bar' | 'line'; dataLabels?: DataLabelFormat }

// Nó da árvore de linhas da Matrix — um por valor distinto de cada campo em
// matrixRows, aninhado por nível. `values` tem uma entrada por coluna
// dinâmica (matrixColumns) + `total` da própria linha/subtotal.
export interface MatrixColumnMeta { key: string; label: string }
export interface MatrixRowNode {
  key: string
  label: string
  level: number                        // índice (0-based) do campo em matrixRows
  values: Record<string, number>       // columnKey -> valor agregado nesta linha/subtotal
  total: number                        // total da linha (agregado sobre todas as colunas)
  children?: MatrixRowNode[]           // presente quando matrixRows tem mais de 1 campo
}
export interface MatrixResult {
  columns: MatrixColumnMeta[]
  rows: MatrixRowNode[]
  grandTotal: Record<string, number>   // columnKey -> total geral da coluna
  grandTotalAll: number
}

export interface WidgetDataResponse {
  points?: WidgetDataPoint[]                       // gráficos/kpi
  seriesKeys?: SeriesMeta[]                        // presente quando há >1 série (measures[] ou legendDimension)
  rows?: Record<string, unknown>[]                 // table
  matrix?: MatrixResult                            // type 'matrix'
  total?: number
  page?: number
  pageSize?: number
}
