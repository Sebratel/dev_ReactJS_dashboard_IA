// Dashboard Builder — renderiza uma dashboard específica (pasta+dashboard na
// URL, ver DashboardPage.tsx) da hierarquia Pasta → Dashboard → Guia: abas →
// filtros → widgets em grade drag & drop. Quem gerencia a pasta (admin ou
// gerente) mexe na estrutura inteira (guias/filtros/formato); um usuário
// padrão com edição liberada numa guia específica só mexe nos widgets dela.
import { useEffect, useMemo, useState } from 'react'
import { GridLayout, useContainerWidth, type Layout } from 'react-grid-layout'
// noOverlapCompactor = sem compactação automática (posição livre) + permite
// sobrepor widgets deliberadamente ao arrastar um por cima do outro (por
// padrão o RGL empurra o outro item pra baixo ao colidir; com isso, o usuário
// decide se quer empilhar ou não, sem nada forçando um comportamento).
import { noOverlapCompactor } from 'react-grid-layout/core'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import {
  Loader2, Pencil, Plus, Filter as FilterIcon, Layers, Save, Undo2, AlertTriangle, Lock, RefreshCw, Monitor, Palette, Sparkles,
} from 'lucide-react'
import { AiPanel } from './ai/AiPanel'
import { cn } from '@/utils/cn'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { fetchSources } from './builderApi'
import {
  fetchDashboard, saveDashboardFull, saveTabWidgets, ApiError,
} from '@/features/workspace/workspaceApi'
import type { DashboardTab } from '@/features/workspace/types'
import { registerDynamicSources } from './fieldCatalog'
import { WidgetRenderer } from './WidgetRenderer'
import { FilterBar } from './FilterBar'
import { WidgetEditorModal } from './WidgetEditorModal'
import { FilterEditorModal } from './FilterEditorModal'
import { TabManager } from './TabManager'
import { CanvasSettingsModal } from './CanvasSettingsModal'
import { ThemePickerModal } from './ThemePickerModal'
import { detectAppliedTheme, newWidgetThemeDefaults, themeTextFormats, THEME_PRESETS, type ThemePreset } from './themePresets'
import type { ActiveFilters, FilterConfig, MeasureConfig, WidgetConfig } from './types'

const ROW_HEIGHT = 56
const GRID_COLS = 12

// Acha o primeiro espaço livre (sem sobrepor nenhum widget existente) do
// tamanho w×h, varrendo linha a linha, esquerda pra direita — usado pra
// posicionar um widget recém-criado (ou duplicado) sem cair em cima de outro.
// Se não achar nenhum buraco livre dentro da área já ocupada (grade cheia),
// centraliza no meio do layout atual em vez de jogar lá embaixo escondido —
// aparece por cima de algo (o compactor permite sobrepor de propósito), mas
// bem visível, pro usuário arrastar pra onde quiser.
function findFreeSpot(widgets: WidgetConfig[], w: number, h: number): { x: number; y: number } {
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

interface DashboardState {
  name: string
  tabs: DashboardTab[]
}

export function DashboardBuilder({ folderId, dashboardId }: { folderId: string; dashboardId: string }) {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null)
  const [savedDashboard, setSavedDashboard] = useState<DashboardState | null>(null)
  const [canManageDashboard, setCanManageDashboard] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activeFilters, setActiveFilters] = useState<Record<string, ActiveFilters>>({})

  const [widgetModal, setWidgetModal] = useState<{ open: boolean; widget: WidgetConfig | null }>({ open: false, widget: null })
  // Rascunho atual do WidgetEditorModal aberto — substitui o widget real na
  // grade enquanto o painel está aberto, pra refletir cor/fonte/campo/etc. no
  // gráfico/tabela de verdade sem precisar clicar em "Salvar" a cada mudança.
  // Puramente visual: nunca entra em `dashboard`, só os botões "Salvar" (do
  // painel e da barra de edição) persistem algo de fato.
  const [previewWidget, setPreviewWidget] = useState<WidgetConfig | null>(null)
  const closeWidgetModal = () => { setWidgetModal({ open: false, widget: null }); setPreviewWidget(null) }
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [filterModalOpen, setFilterModalOpen] = useState(false)
  const [tabManagerOpen, setTabManagerOpen] = useState(false)
  const [canvasModalOpen, setCanvasModalOpen] = useState(false)
  const [themeModalOpen, setThemeModalOpen] = useState(false)
  // Diálogo de confirmação no estilo do app (substitui o confirm() nativo do
  // navegador) — null = fechado; setar preenche título/mensagem/ação e abre.
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void
  } | null>(null)

  // measureBeforeMount: sem isso, o hook usa um "chute" inicial de 1280px
  // antes da 1ª medição real — a grade e os cards renderizam uma vez com
  // esse valor errado, e alguns cards ficam com o tamanho travado nesse
  // cálculo mesmo depois do container corrigir para a largura real (a
  // largura da grade some para o valor certo, mas os itens não recalculam).
  // Sintoma: cards "grandes demais" pro espaço visível, sem espaço real pra
  // mover à direita. Com isso, a grade só nasce depois da medição real.
  //
  // Mas o efeito interno do hook que faz essa medição roda só UMA vez (no
  // 1º commit deste componente) — e nesse exato momento `loading` ainda é
  // `true`, então o <div ref={containerRef}> nem existe no DOM ainda (a
  // função retorna o spinner "Carregando…", não a grade). O efeito acha o
  // container nulo, desiste, e nunca tenta de novo — `mounted` fica travado
  // em `false` para sempre e a grade não aparece mais. Por isso chamamos
  // `measureWidth()` manualmente abaixo, assim que a aba fica disponível
  // (nesse ponto o container real já foi commitado no DOM).
  const { width, containerRef, mounted, measureWidth } = useContainerWidth({ measureBeforeMount: true })

  // Fontes (queries do catálogo) mudam a qualquer momento em Configurações,
  // então a lista é revalidada sempre que o usuário está prestes a criar ou
  // editar algo — não só na carga inicial da página. É uma leitura local do
  // snapshot já em memória (sem round-trip ao banco), então é rápida.
  const refreshSources = async () => {
    try { registerDynamicSources(await fetchSources(folderId)) } catch { /* mantém a lista já carregada */ }
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([fetchDashboard(folderId, dashboardId), fetchSources(folderId)])
      .then(([res, sources]) => {
        if (!alive) return
        registerDynamicSources(sources)
        const ds = { name: res.dashboard.name, tabs: res.dashboard.tabs }
        setDashboard(ds)
        setSavedDashboard(ds)
        setCanManageDashboard(res.folder.canManage)
        setError(null)
        setActiveTabId((prev) => prev && ds.tabs.some((t) => t.id === prev) ? prev : (ds.tabs[0]?.id ?? null))
      })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e : new ApiError(0, 'Erro inesperado.')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [folderId, dashboardId, reloadKey])

  const tab = useMemo(() => dashboard?.tabs.find((t) => t.id === activeTabId) ?? null, [dashboard, activeTabId])
  const dirty = useMemo(() => JSON.stringify(dashboard) !== JSON.stringify(savedDashboard), [dashboard, savedDashboard])
  // Tema já aplicado nesta guia (se algum) — usado só pra um widget NOVO já
  // nascer com as cores certas, em vez de sempre cair no padrão do app (ver
  // newWidgetThemeDefaults). Widgets existentes já carregam suas próprias
  // cores; isto não afeta a edição deles.
  const activeTheme = useMemo(
    () => THEME_PRESETS.find((t) => t.id === detectAppliedTheme(tab?.widgets ?? [])),
    [tab],
  )
  // Pode editar os WIDGETS da guia atual: admin/gerente da pasta (mexe em
  // qualquer guia) ou um usuário padrão com edição liberada especificamente
  // nesta guia (`canEdit`, resolvido pelo servidor). Gerenciar a estrutura da
  // dashboard (guias/filtros/formato) exige `canManageDashboard`.
  const canEditCurrentTab = canManageDashboard || !!tab?.canEdit

  // Dispara a medição real assim que há uma aba pra mostrar — nesse ponto o
  // <div ref={containerRef}> já foi commitado no DOM (ver comentário acima).
  // Depende de tab?.id (não de `tab` inteiro) pra não re-disparar a cada
  // edição — `tab` é um objeto novo (useMemo) sempre que a config muda.
  useEffect(() => {
    if (tab) measureWidth()
  }, [tab?.id, measureWidth])

  // Atualização automática (silenciosa, sem F5) — pensada pra telas expostas
  // sem interação (ex. TV de painel). Não recarrega a página nem a config:
  // só força cada WidgetRenderer da aba a refazer a busca de dados,
  // incrementando `refreshKey` (repassado como prop). Só roda fora do modo
  // edição — evitar reconsultar tudo por baixo de alguém editando é o que
  // importa aqui, não perder trabalho (edição não muda o refetch de dados).
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    if (editMode || !tab?.autoRefresh?.enabled) return
    const ms = Math.max(1, tab.autoRefresh.minutes) * 60_000
    const id = setInterval(() => setRefreshKey((k) => k + 1), ms)
    return () => clearInterval(id)
  }, [editMode, tab?.id, tab?.autoRefresh?.enabled, tab?.autoRefresh?.minutes])

  const tabFilterValues = useMemo(() => {
    if (!tab) return []
    const active = activeFilters[tab.id] ?? {}
    return tab.filters
      .map((filter) => ({ filter, values: active[filter.id] ?? [] }))
      .filter((tf) => tf.values.length > 0)
  }, [tab, activeFilters])

  // Widgets a renderizar de fato na grade: iguais aos salvos em `dashboard`,
  // exceto o que está sendo editado agora (se houver painel aberto) — esse
  // aparece com o rascunho ao vivo. Widget novo (ainda sem lugar na aba)
  // entra como um item extra, num espaço livre, só enquanto o painel some
  // aberto — nunca escrito em `dashboard` até o usuário clicar em salvar.
  const displayWidgets = useMemo(() => {
    const widgets = tab?.widgets ?? []
    if (!previewWidget) return widgets
    const idx = widgets.findIndex((w) => w.id === previewWidget.id)
    if (idx >= 0) return widgets.map((w, i) => (i === idx ? previewWidget : w))
    const { x, y } = findFreeSpot(widgets, previewWidget.layout.w, previewWidget.layout.h)
    return [...widgets, { ...previewWidget, layout: { ...previewWidget.layout, x, y } }]
  }, [tab, previewWidget])

  const gridLayout: Layout = useMemo(
    () => displayWidgets.map((w) => ({ i: w.id, ...w.layout })),
    [displayWidgets],
  )

  const updateTab = (patch: (t: DashboardTab) => DashboardTab) => {
    if (!tab || !dashboard) return
    setDashboard({ ...dashboard, tabs: dashboard.tabs.map((t) => (t.id === tab.id ? patch(t) : t)) })
  }

  const onLayoutChange = (layout: Layout) => {
    if (!editMode || !canEditCurrentTab) return
    updateTab((t) => ({
      ...t,
      widgets: t.widgets.map((w) => {
        const l = layout.find((li) => li.i === w.id)
        return l ? { ...w, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : w
      }),
    }))
  }

  const saveWidget = (widget: WidgetConfig) => {
    updateTab((t) => {
      const exists = t.widgets.some((w) => w.id === widget.id)
      if (exists) return { ...t, widgets: t.widgets.map((w) => (w.id === widget.id ? widget : w)) }
      // Widget novo: ignora a posição-padrão do editor (sempre 0,0) e acha um
      // espaço livre real na aba, pra não nascer em cima de outro widget.
      const { x, y } = findFreeSpot(t.widgets, widget.layout.w, widget.layout.h)
      return { ...t, widgets: [...t.widgets, { ...widget, layout: { ...widget.layout, x, y } }] }
    })
    closeWidgetModal()
  }

  // Widgets propostos pela IA e aprovados pelo usuário (ver ai/AiPanel.tsx).
  // Entram como rascunho, exatamente como um widget feito à mão: só o "Salvar"
  // da barra de edição persiste. Cada um acha o próprio espaço livre — e a
  // lista cresce a cada iteração, senão todos nasceriam na mesma posição.
  const applyAiWidgets = (widgets: WidgetConfig[]) => {
    updateTab((t) => {
      let placed = t.widgets
      for (const w of widgets) {
        const { x, y } = findFreeSpot(placed, w.layout.w, w.layout.h)
        placed = [...placed, { ...w, layout: { ...w.layout, x, y } }]
      }
      return { ...t, widgets: placed }
    })
  }

  // Ajuste rápido de UM widget sem passar pelo painel de edição (hoje só usado
  // pelo arrasto de largura de coluna da tabela, ver TableBody) — mesmo
  // rascunho/dirty de qualquer outra edição, só persiste em "Salvar".
  const patchWidget = (id: string, patch: Partial<WidgetConfig>) => {
    updateTab((t) => ({ ...t, widgets: t.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }))
  }

  const removeWidget = (id: string) => {
    setConfirmState({
      title: 'Remover widget',
      message: 'Tem certeza que quer remover este widget?',
      confirmLabel: 'Remover',
      danger: true,
      onConfirm: () => {
        updateTab((t) => ({ ...t, widgets: t.widgets.filter((w) => w.id !== id) }))
        setConfirmState(null)
      },
    })
  }

  const duplicateWidget = (widget: WidgetConfig) => {
    updateTab((t) => {
      const { x, y } = findFreeSpot(t.widgets, widget.layout.w, widget.layout.h)
      const copy: WidgetConfig = {
        ...widget,
        id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        title: `${widget.title} (cópia)`,
        layout: { ...widget.layout, x, y },
      }
      return { ...t, widgets: [...t.widgets, copy] }
    })
  }

  const addFilter = (filter: FilterConfig) => {
    updateTab((t) => ({ ...t, filters: [...t.filters, filter] }))
    setFilterModalOpen(false)
  }

  const removeFilter = (filterId: string) => {
    updateTab((t) => ({ ...t, filters: t.filters.filter((f) => f.id !== filterId) }))
  }

  // Sobrepõe as cores do tema em TODOS os widgets da guia atual — série
  // (palette + cor principal + cor de cada medida), fundo do card, e
  // `theme.textColor` em título/subtítulo/legenda/eixos X-Y/rótulos de
  // dados/tabela/matriz (todo tema de fundo escuro usa branco aqui, pra
  // manter esses textos legíveis — ver themeTextFormats em themePresets.ts).
  // Sempre sobrescreve (mesmo cores já customizadas por widget, mas mantendo
  // fontSize/negrito/etc. que já existiam nesses formatos): é um "aplicar
  // tema pronto", não um preenchimento seletivo — e como é só rascunho até
  // "Salvar", dá pra descartar se o resultado não agradar.
  const recolorMeasures = (list: MeasureConfig[] | undefined, palette: string[], offset: number): MeasureConfig[] | undefined =>
    list?.map((m, i) => ({ ...m, color: palette[(offset + i) % palette.length] }))

  const applyTheme = (theme: ThemePreset) => {
    const textFormats = themeTextFormats(theme)
    updateTab((t) => ({
      ...t,
      widgets: t.widgets.map((w) => ({
        ...w,
        palette: theme.palette,
        color: theme.palette[0],
        measures: recolorMeasures(w.measures, theme.palette, 0),
        measuresLine: recolorMeasures(w.measuresLine, theme.palette, w.measures?.length ?? 0),
        backgroundColor: theme.backgroundColor,
        backgroundOpacity: theme.backgroundColor ? 100 : undefined,
        titleFormat: { ...w.titleFormat, ...textFormats.titleFormat },
        subtitleFormat: { ...w.subtitleFormat, ...textFormats.subtitleFormat },
        legendFormat: { ...w.legendFormat, ...textFormats.legendFormat },
        axisXFormat: { ...w.axisXFormat, ...textFormats.axisXFormat },
        axisYFormat: { ...w.axisYFormat, ...textFormats.axisYFormat },
        dataLabels: { ...w.dataLabels, ...textFormats.dataLabels },
        tableFormat: { ...w.tableFormat, ...textFormats.tableFormat },
        matrixRowFormat: { ...w.matrixRowFormat, ...textFormats.matrixRowFormat },
        matrixColumnFormat: { ...w.matrixColumnFormat, ...textFormats.matrixColumnFormat },
      })),
    }))
    setThemeModalOpen(false)
  }

  const handleSave = async () => {
    if (!dashboard || !tab) return
    setSaving(true)
    try {
      if (canManageDashboard) {
        await saveDashboardFull(folderId, dashboardId, dashboard.tabs)
      } else {
        await saveTabWidgets(folderId, dashboardId, tab.id, tab.widgets)
      }
      setSavedDashboard(dashboard)
      setEditMode(false)
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao salvar a dashboard.')
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    if (!dirty) { setDashboard(savedDashboard); setEditMode(false); return }
    setConfirmState({
      title: 'Descartar alterações',
      message: 'Descartar todas as alterações não salvas desta sessão de edição?',
      confirmLabel: 'Descartar',
      danger: true,
      onConfirm: () => {
        setDashboard(savedDashboard)
        setEditMode(false)
        setConfirmState(null)
      },
    })
  }

  if (loading && !dashboard) {
    return <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-card px-5 py-16 text-sm text-gray-400 animate-slide-up"><Loader2 size={16} className="animate-spin" /> Carregando dashboard…</div>
  }
  if (error && !dashboard) {
    return (
      <div className="rounded-xl border border-app-border bg-app-card px-5 py-6 space-y-3 animate-slide-up">
        <div className="flex items-start gap-2.5 text-sm text-rose-300">
          {error.status === 401 ? <Lock size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
          <div>
            <p className="font-medium text-gray-100">{error.status === 0 ? 'Servidor indisponível' : error.status === 401 ? 'Sessão expirada' : error.status === 403 ? 'Sem acesso' : 'Não foi possível carregar a dashboard'}</p>
            <p className="mt-0.5 text-[12px] text-gray-400">{error.message}</p>
          </div>
        </div>
        <button onClick={() => setReloadKey((k) => k + 1)} className="flex items-center gap-1.5 rounded-md border border-app-border px-3 py-1.5 text-[12px] text-gray-300 hover:border-app-borderLight hover:text-gray-100 transition-colors"><RefreshCw size={13} /> Tentar novamente</button>
      </div>
    )
  }
  if (!dashboard || !tab) return null

  return (
    <div className="space-y-4 animate-slide-up">
      {/* Barra de abas + controles de edição */}
      <div className="flex items-center justify-between gap-3 border-b border-app-border">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mb-px scrollbar-thin">
          {dashboard.tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTabId(t.id)}
              className={cn(
                'px-3.5 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors',
                activeTabId === t.id ? 'border-brand-blue text-brand-blue' : 'border-transparent text-gray-500 hover:text-gray-300',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 pb-1">
          {!editMode ? (
            canEditCurrentTab && (
              <button onClick={() => { refreshSources(); setEditMode(true) }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue transition-colors">
                <Pencil size={11} /> Editar dashboard
              </button>
            )
          ) : (
            <>
              {canEditCurrentTab && (
                <>
                  <button onClick={() => refreshSources().then(() => setWidgetModal({ open: true, widget: null }))} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue"><Plus size={11} /> Widget</button>
                  {/* Mesma permissão do "+ Widget": quem pode adicionar widget
                      nesta guia pode pedir pra IA montar. */}
                  <button onClick={() => refreshSources().then(() => setAiPanelOpen(true))} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-brand-cyan/30 text-[11px] font-semibold text-brand-cyan hover:bg-brand-cyan/10" title="Montar widgets conversando com a IA"><Sparkles size={11} /> IA</button>
                </>
              )}
              {canManageDashboard && (
                <>
                  <button onClick={() => refreshSources().then(() => setFilterModalOpen(true))} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue"><FilterIcon size={11} /> Filtro</button>
                  <button onClick={() => setTabManagerOpen(true)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue"><Layers size={11} /> Abas</button>
                  <button onClick={() => setCanvasModalOpen(true)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue" title="Configurações de tela"><Monitor size={11} /> Formato</button>
                  <button onClick={() => setThemeModalOpen(true)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue" title="Temas prontos de cores"><Palette size={11} /> Temas</button>
                </>
              )}
              <span className="w-px h-5 bg-app-border mx-0.5" />
              <button onClick={handleSave} disabled={saving || !dirty} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-brand-blue text-white text-[11px] font-semibold hover:bg-brand-blueLight disabled:opacity-50">
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Salvar
              </button>
              <button onClick={handleDiscard} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-app-borderLight"><Undo2 size={11} /> Descartar</button>
            </>
          )}
        </div>
      </div>

      {editMode && (
        <p className="text-[11px] text-brand-blue bg-brand-blue/10 border border-brand-blue/25 rounded-lg px-3 py-2">
          {canManageDashboard
            ? <>Modo edição — arraste os widgets para reposicionar, redimensione pelos cantos, e use os botões de lápis/copiar/lixeira em cada widget. As alterações valem para <strong>todos os usuários</strong> com acesso após salvar.</>
            : <>Modo edição — você pode criar e ajustar widgets nesta guia. As alterações valem para <strong>todos os usuários</strong> com acesso a esta guia após salvar.</>}
        </p>
      )}
      {editMode && !canEditCurrentTab && (
        <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
          Você não tem edição liberada nesta guia — peça ao gerente da pasta ou a um administrador.
        </p>
      )}

      {/* Filtros da aba */}
      <FilterBar
        filters={tab.filters}
        active={activeFilters[tab.id] ?? {}}
        onChange={(filterId, values) => setActiveFilters((prev) => ({ ...prev, [tab.id]: { ...(prev[tab.id] ?? {}), [filterId]: values } }))}
        editMode={editMode && canManageDashboard}
        onRemoveFilter={removeFilter}
      />

      {/* Grade de widgets — sem canvas fixo: largura fluida (padrão atual).
          Com canvas fixo (Formato → Personalizar): tela de tamanho fixo em
          px, estilo Power BI, com rolagem horizontal se a janela for menor. */}
      <div className={cn(tab.canvas && 'overflow-x-auto rounded-2xl border border-app-border bg-app-card shadow-card p-4')}>
        {/* cast: o hook do RGL v2 tipa a ref como RefObject<HTMLDivElement|null>,
            incompatível com a tipagem de ref do React 18 — mesmo objeto em runtime. */}
        <div
          ref={containerRef as React.RefObject<HTMLDivElement>}
          style={tab.canvas ? {
            width: tab.canvas.width,
            minHeight: tab.canvas.height,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: tab.canvas.verticalAlign === 'middle' ? 'center' : tab.canvas.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start',
          } : undefined}
        >
          {mounted && (
            displayWidgets.length === 0 ? (
              <div className="rounded-xl border border-dashed border-app-border px-5 py-16 text-center text-sm text-gray-500">
                Aba vazia — {editMode && canEditCurrentTab ? 'clique em “+ Widget” para adicionar o primeiro gráfico.' : 'entre no modo edição para adicionar conteúdo.'}
              </div>
            ) : (
              <GridLayout
                width={width}
                layout={gridLayout}
                gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [12, 12], containerPadding: [0, 0] }}
                dragConfig={{ enabled: editMode && canEditCurrentTab, cancel: 'button, input, select, a, table' }}
                resizeConfig={{ enabled: editMode && canEditCurrentTab }}
                compactor={noOverlapCompactor}
                onLayoutChange={onLayoutChange}
              >
                {displayWidgets.map((w) => (
                  <div
                    key={w.id}
                    className={cn(
                      editMode && canEditCurrentTab && 'cursor-move',
                      'rounded-2xl transition-shadow',
                      widgetModal.open && previewWidget?.id === w.id && 'ring-2 ring-brand-blue ring-offset-2 ring-offset-app-bg',
                    )}
                  >
                    <WidgetRenderer
                      widget={w}
                      tabFilters={tabFilterValues}
                      editMode={editMode && canEditCurrentTab}
                      refreshKey={refreshKey}
                      onEdit={() => refreshSources().then(() => setWidgetModal({ open: true, widget: w }))}
                      onRemove={() => removeWidget(w.id)}
                      onDuplicate={() => duplicateWidget(w)}
                      onColumnWidthsChange={(columnWidths) => patchWidget(w.id, { tableFormat: { ...w.tableFormat, columnWidths } })}
                    />
                  </div>
                ))}
              </GridLayout>
            )
          )}
        </div>
      </div>

      {/* Modais */}
      {widgetModal.open && (
        <WidgetEditorModal
          initial={widgetModal.widget}
          newWidgetDefaults={newWidgetThemeDefaults(activeTheme)}
          onSave={saveWidget}
          onClose={closeWidgetModal}
          onChange={setPreviewWidget}
          onSourcesChanged={refreshSources}
        />
      )}
      {filterModalOpen && <FilterEditorModal onSave={addFilter} onClose={() => setFilterModalOpen(false)} />}
      {tabManagerOpen && dashboard && (
        <TabManager
          folderId={folderId}
          dashboardId={dashboardId}
          tabs={dashboard.tabs}
          onChange={(tabs) => {
            // TabManager só é aberto por quem gerencia a dashboard (admin ou
            // gerente da pasta) — essa pessoa sempre pode editar qualquer
            // guia, então re-anota `canEdit: true` pras guias que voltam
            // dele (TabConfig puro, sem essa anotação de permissão).
            setDashboard({ ...dashboard, tabs: tabs.map((t) => ({ ...t, canEdit: true })) })
            if (!tabs.some((t) => t.id === activeTabId)) setActiveTabId(tabs[0]?.id ?? null)
          }}
          onClose={() => setTabManagerOpen(false)}
        />
      )}
      {canvasModalOpen && (
        <CanvasSettingsModal
          initial={tab.canvas ?? null}
          initialAutoRefresh={tab.autoRefresh ?? null}
          onSave={(canvas, autoRefresh) => { updateTab((t) => ({ ...t, canvas: canvas ?? undefined, autoRefresh })); setCanvasModalOpen(false) }}
          onClose={() => setCanvasModalOpen(false)}
        />
      )}
      {themeModalOpen && (
        <ThemePickerModal initialThemeId={detectAppliedTheme(tab.widgets)} onApply={applyTheme} onClose={() => setThemeModalOpen(false)} />
      )}
      {aiPanelOpen && (
        <AiPanel folderId={folderId} onApply={applyAiWidgets} onClose={() => setAiPanelOpen(false)} />
      )}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger={confirmState.danger}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  )
}
