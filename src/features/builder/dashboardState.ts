// O estado da dashboard no Builder e as contas sobre ele que mais de um lugar
// faz — o DashboardBuilder (salvar, trazer a versão nova) e o salvamento
// automático do que a IA entrega (useAiAutoSave.ts).
import type { DashboardResponse, DashboardTab } from '@/features/workspace/types'
import type { MeasureDef, TabConfig, WidgetConfig } from './types'

export interface DashboardState {
  name: string
  tabs: DashboardTab[]
  measures: MeasureDef[]
}

export function toDashboardState(res: DashboardResponse): DashboardState {
  return { name: res.dashboard.name, tabs: res.dashboard.tabs, measures: res.dashboard.measures ?? [] }
}

// Colunas da grade (ver ROW_HEIGHT no DashboardBuilder.tsx, que explica a
// resolução dobrada).
export const GRID_COLS = 24

// Acha o primeiro espaço livre (sem sobrepor nenhum widget existente) do
// tamanho w×h, varrendo linha a linha, esquerda pra direita — usado pra
// posicionar um widget recém-criado (ou duplicado) sem cair em cima de outro.
// Se não achar nenhum buraco livre dentro da área já ocupada (grade cheia),
// centraliza no meio do layout atual em vez de jogar lá embaixo escondido —
// aparece por cima de algo (o compactor permite sobrepor de propósito), mas
// bem visível, pro usuário arrastar pra onde quiser.
export function findFreeSpot(widgets: WidgetConfig[], w: number, h: number): { x: number; y: number } {
  const occupied = widgets.map((wg) => wg.layout)
  const maxY = occupied.reduce((m, o) => Math.max(m, o.y + o.h), 0)
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= GRID_COLS - w; x++) {
      const collides = occupied.some((o) => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y)
      if (!collides) return { x, y }
    }
  }
  return { x: Math.max(0, Math.floor((GRID_COLS - w) / 2)), y: Math.max(0, Math.floor(maxY / 2)) }
}

// Posiciona um lote de widgets novos, cada um no próprio espaço livre — a
// lista cresce a cada iteração, senão todos nasceriam na mesma posição.
export function placeWidgets(existing: WidgetConfig[], incoming: WidgetConfig[]): WidgetConfig[] {
  let placed = existing
  const out: WidgetConfig[] = []
  for (const w of incoming) {
    const { x, y } = findFreeSpot(placed, w.layout.w, w.layout.h)
    const positioned = { ...w, layout: { ...w.layout, x, y } }
    placed = [...placed, positioned]
    out.push(positioned)
  }
  return out
}

// Conteúdo de uma guia, pra saber se esta tela mudou alguma coisa nela. Fora
// da comparação: `canEdit` (anotação de permissão), `rev` (versão no
// servidor) e `access` (o acesso grava na hora, pela rota própria) — mesmo
// critério do servidor (tabContent em server/workspace.mjs) — que também deixa
// de fora quem gravou por último e quando.
export function tabContent(tab: DashboardTab): string {
  const { canEdit, rev, access, updatedBy, updatedByName, updatedAt, ...content } = tab
  return JSON.stringify(content)
}

// Guia nova em branco — "Nova guia", ou "Nova guia 2", "Nova guia 3"… quando
// o nome já existe. Nasce bloqueada (só admin/gerente veem), igual ao "Criar"
// manual do TabManager.tsx; `canEdit: true` porque só quem gerencia a
// dashboard chega aqui.
export function blankTab(existing: DashboardTab[]): DashboardTab {
  const labels = new Set(existing.map((t) => t.label))
  let label = 'Nova guia'
  for (let n = 2; labels.has(label); n++) label = `Nova guia ${n}`
  return {
    id: `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, label, filters: [], widgets: [],
    access: { mode: 'restricted', view: [], edit: [] }, canEdit: true,
  }
}

// Cópia de uma guia pro rascunho ("Nome (cópia)"), logo depois da original.
// Widgets ganham id novo (os comentários são pelo id do widget — a cópia não
// herda a conversa) e as medidas continuam as mesmas (são da dashboard). O
// acesso NÃO vem junto: a cópia nasce restrita, como toda guia nova — copiar a
// guia de um supervisor pra montar a de outro não leva as pessoas do primeiro.
export function copyTab<T extends TabConfig>(tab: T, existing: { label: string }[]): T {
  const labels = new Set(existing.map((t) => t.label))
  let label = `${tab.label} (cópia)`
  for (let n = 2; labels.has(label); n++) label = `${tab.label} (cópia ${n})`
  const stamp = Date.now().toString(36)
  const rand = () => Math.random().toString(36).slice(2, 6)
  const clone = JSON.parse(JSON.stringify(tab)) as T
  delete clone.rev
  delete clone.isWelcome
  delete clone.updatedBy
  delete clone.updatedByName
  delete clone.updatedAt
  return {
    ...clone,
    id: `tab-${stamp}-${rand()}`,
    label,
    widgets: clone.widgets.map((w) => ({ ...w, id: `w-${stamp}-${rand()}` })),
    access: { mode: 'restricted', view: [], edit: [] },
  }
}

// ─── Medidas, uma a uma (ver saveDashboardMeasures em server/workspace.mjs) ──
export interface MeasureChanges {
  upsert: MeasureDef[]
  remove: string[]
}

// O que esta tela mudou nas medidas em relação à versão salva — é isso que vai
// pro servidor, nunca a lista inteira (que apagava a medida criada por outra
// pessoa nesse meio-tempo).
export function diffMeasures(local: MeasureDef[], saved: MeasureDef[]): MeasureChanges {
  const savedById = new Map(saved.map((m) => [m.id, JSON.stringify(m)]))
  const localIds = new Set(local.map((m) => m.id))
  return {
    upsert: local.filter((m) => savedById.get(m.id) !== JSON.stringify(m)),
    remove: saved.filter((m) => !localIds.has(m.id)).map((m) => m.id),
  }
}

// Mesmo merge do servidor (mergeMeasures): por id, mantendo a ordem.
export function mergeMeasureList(current: MeasureDef[], { upsert, remove }: MeasureChanges): MeasureDef[] {
  const removed = new Set(remove)
  const byId = new Map(current.filter((m) => !removed.has(m.id)).map((m) => [m.id, m]))
  for (const m of upsert) byId.set(m.id, m)
  return [...byId.values()]
}
