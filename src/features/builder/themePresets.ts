// Temas prontos (estilo Power BI) — cada um define um esquema de cores das
// séries/fatias (`palette`), opcionalmente um fundo de card fixo
// (`backgroundColor`) e, só quando há fundo fixo, UMA cor de texto
// (`textColor`) aplicada em TODA a formatação textual do widget — título,
// subtítulo, legenda, eixos X/Y, rótulos de dados, célula/coluna/linha de
// tabela e matriz (ver regra de contraste abaixo). "Aplicar tema"
// (DashboardBuilder → botão "Temas") sobrepõe essas cores em todos os
// widgets da guia atual, de uma vez — ver
// applyTheme em DashboardBuilder.tsx. Não é salvo como config própria: fica
// gravado direto em cada widget (`palette`/`color`/`measures[].color`/
// `backgroundColor`/`titleFormat.color`/`subtitleFormat.color`/
// `legendFormat.color`/`axisXFormat.color`/`axisYFormat.color`/
// `dataLabels.color`/`tableFormat.color`/`matrixRowFormat.color`/
// `matrixColumnFormat.color`), então continua editável widget a widget depois.
//
// Regra de contraste: só temas com `backgroundColor` PRÓPRIO (fundo fixo,
// escuro, que não muda com o tema claro/escuro do app) definem `textColor`
// — sempre branco, já que esse fundo é escuro em qualquer situação. Temas
// SEM fundo próprio (a maioria) deixam `textColor` ausente de propósito:
// eles continuam sobre o fundo padrão do card, que já é claro ou escuro
// dependendo do tema claro/escuro do APP (não do tema de cores do widget) —
// uma cor de texto fixa aqui ficaria ilegível toda vez que o app estivesse
// no modo contrário ao que essa cor foi pensada (ex. um cinza clarinho lido
// bem no modo escuro do app fica quase invisível no modo claro). Sem
// `textColor`, o texto usa as mesmas classes cinza padrão do resto do app,
// que já se adaptam automaticamente aos dois modos.
//
// `palette` usa cores de matizes DIFERENTES entre si (não tons do mesmo azul,
// por exemplo) — mesmo temas com uma "cor-mãe" (Oceano, Floresta...) misturam
// tons complementares/de destaque, senão o gráfico fica monótono e difícil de
// distinguir série por série. "Monocromático azul" é a única exceção
// deliberada (o nome já avisa).
export interface ThemePreset {
  id: string
  name: string
  palette: string[]           // cores das séries/fatias, na ordem de uso
  backgroundColor?: string    // fundo do card do widget — ausente = padrão do app
  textColor?: string          // cor de título/subtítulo/legenda/eixos/rótulos/tabela/matriz — ausente = padrão do app
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: 'Padrão do app',
    palette: ['#ffb000', '#3b82f6', '#10b981', '#7c3aed', '#22d3ee', '#f97316', '#ef4444', '#6366f1'],
  },
  {
    id: 'sebratel',
    name: 'Sebratel',
    palette: ['#3b82f6', '#f59e0b', '#14b8a6', '#e11d48', '#84cc16', '#8b5cf6', '#64748b', '#ec4899'],
  },
  {
    id: 'oceano',
    name: 'Oceano',
    palette: ['#0891b2', '#fb923c', '#22c55e', '#eab308', '#a855f7', '#f472b6', '#38bdf8', '#78716c'],
    backgroundColor: '#0b1f2b',
    textColor: '#ffffff',
  },
  {
    id: 'sunset',
    name: 'Pôr do sol',
    palette: ['#f97316', '#7c3aed', '#f43f5e', '#0ea5e9', '#eab308', '#22c55e', '#d946ef', '#64748b'],
  },
  {
    id: 'floresta',
    name: 'Floresta',
    palette: ['#16a34a', '#a16207', '#0d9488', '#ca8a04', '#65a30d', '#7c3aed', '#dc2626', '#57534e'],
  },
  {
    id: 'roxo',
    name: 'Roxo vibrante',
    palette: ['#7c3aed', '#f59e0b', '#22d3ee', '#ec4899', '#84cc16', '#3b82f6', '#f43f5e', '#14b8a6'],
  },
  {
    id: 'corporativo',
    name: 'Corporativo',
    palette: ['#1e3a5f', '#b45309', '#166534', '#7c2d12', '#4338ca', '#0f766e', '#831843', '#57534e'],
  },
  {
    id: 'vibrante',
    name: 'Vibrante',
    palette: ['#ec4899', '#22c55e', '#0ea5e9', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#eab308'],
  },
  {
    id: 'monocromatico',
    name: 'Monocromático azul',
    palette: ['#1e3a8a', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#dbeafe'],
  },
  {
    id: 'contraste',
    name: 'Alto contraste',
    palette: ['#facc15', '#22d3ee', '#f472b6', '#4ade80', '#f97316', '#a78bfa', '#38bdf8', '#f87171'],
    backgroundColor: '#0a0a0a',
    textColor: '#ffffff',
  },
]

// Descobre qual tema já está em uso na guia, a partir do `palette` gravado em
// qualquer widget (applyTheme grava a mesma paleta, na mesma ordem, em todos)
// — não existe um campo próprio "tema atual da guia" salvo em lugar nenhum,
// então isto é inferido por comparação de valor. Usado só pra abrir o modal
// "Temas" já com o card certo selecionado, em vez de sempre voltar pro
// primeiro da lista. Sem nenhum widget com `palette` (tema nunca aplicado, ou
// cores editadas manualmente depois), retorna undefined.
export function detectAppliedTheme(widgets: { palette?: string[] }[]): string | undefined {
  const withPalette = widgets.find((w) => w.palette?.length)
  const palette = withPalette?.palette
  if (!palette) return undefined
  return THEME_PRESETS.find((t) => t.palette.length === palette.length && t.palette.every((c, i) => c === palette[i]))?.id
}

// Aplica `theme.textColor` (ou undefined, pra voltar ao padrão do app) em
// toda a formatação textual de UM widget — usado tanto pelo applyTheme
// (widgets existentes, mesclando com a formatação que já tinham) quanto pelo
// newWidgetThemeDefaults abaixo (widget novo, sem formatação prévia).
export function themeTextFormats(theme: ThemePreset) {
  const c = theme.textColor
  return {
    titleFormat: { color: c },
    subtitleFormat: { color: c },
    legendFormat: { color: c },
    axisXFormat: { color: c },
    axisYFormat: { color: c },
    dataLabels: { color: c },
    tableFormat: { color: c },
    matrixRowFormat: { color: c },
    matrixColumnFormat: { color: c },
  }
}

// Campos iniciais de um widget NOVO quando a guia já tem um tema aplicado —
// sem isso, um widget criado depois de "Temas" nasce com as cores padrão do
// app, destoando de todo o resto da guia. Usado só ao criar (WidgetEditorModal
// com `initial: null`); um widget já existente sendo editado nunca passa por
// aqui (ver applyTheme em DashboardBuilder.tsx, que já cobre esse caso).
export function newWidgetThemeDefaults(theme: ThemePreset | undefined) {
  if (!theme) return {}
  return {
    palette: theme.palette,
    color: theme.palette[0],
    backgroundColor: theme.backgroundColor,
    backgroundOpacity: theme.backgroundColor ? 100 : undefined,
    ...themeTextFormats(theme),
  }
}
