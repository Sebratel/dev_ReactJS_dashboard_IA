// Fontes do Data Hub (lakehouse) em Configurações — o terceiro tipo de fonte
// do Builder, ao lado das queries SQL e das planilhas do Google.
//
// A ideia é consumir o dado pelo BARRAMENTO: em vez de uma query SQL batendo
// no banco de origem, cadastra-se um dataset já publicado no Data Hub mais um
// token de acesso próprio. Auto-serviço — qualquer usuário logado cadastra a
// sua fonte, com o seu token; só quem cadastrou (ou um admin) edita/remove.
//
// O token é enviado uma vez e nunca volta do servidor: a tela mostra só a
// dica ("dhub_…6T97"). Por isso, ao editar, deixar o campo de token vazio
// mantém o token que já está salvo.
import { useEffect, useRef, useState } from 'react'
import {
  Waypoints, Plus, Pencil, Trash2, Loader2, AlertTriangle, RefreshCw, FolderCog, X, Play, KeyRound,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/utils/cn'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { useAuthStore } from '@/store/authStore'
import type { Folder } from '@/features/workspace/types'
import { Toggle, RefreshControl, FolderControl, type RefreshPatch } from './SourceControls'
import {
  fetchLakehouseSources, createLakehouseSource, updateLakehouseSource, deleteLakehouseSource,
  setLakehouseEnabled, setLakehouseRefresh, setLakehouseFolders, syncLakehouseSource,
  testLakehouseSource, fetchLakehouseSourceUsage, waitForSourceColumns, builderKey,
  ApiError, type LakehouseSource, type LakehousePreview,
} from './lakehouseSourceApi'

const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

// Amostra de linhas/colunas devolvida pelo teste — a mesma tabelinha do
// editor de query SQL, pra pessoa reconhecer o dataset antes de salvar.
function PreviewTable({ preview }: { preview: LakehousePreview }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <p className="text-[10px] text-gray-500 mb-1.5">
        Conectado a <span className="font-mono text-gray-400">{preview.dataset}</span>
        {preview.total != null && ` · ${preview.total.toLocaleString('pt-BR')} linha(s) no total`}
        {` · ${preview.columns.length} coluna(s)`}
      </p>
      {preview.columns.length > 0 && (
        <table className="text-[10px] w-full">
          <thead>
            <tr className="text-left text-gray-500 border-b border-app-border">
              {preview.columns.map((c) => <th key={c} className="px-2 py-1 font-medium whitespace-nowrap">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.rows.slice(0, 5).map((r, i) => (
              <tr key={i} className="border-b border-app-border/60">
                {preview.columns.map((c) => <td key={c} className="px-2 py-1 text-gray-300 whitespace-nowrap max-w-[160px] truncate">{String(r[c] ?? '—')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function LakehouseSourceModal({ initial, defaultBaseUrl, onSaved, onClose }: {
  initial: LakehouseSource | null // null = criar nova
  defaultBaseUrl: string
  // Recebe a fonte já gravada: quem chama precisa do id pra esperar o ETL
  // trazer as colunas dela (ver waitForSourceColumns).
  onSaved: (saved: LakehouseSource) => void
  onClose: () => void
}) {
  const isEdit = !!initial
  const [label, setLabel] = useState(initial?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? defaultBaseUrl)
  const [datasetSlug, setDatasetSlug] = useState(initial?.datasetSlug ?? '')
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState(false)
  const [preview, setPreview] = useState<LakehousePreview | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Criar exige token; editar pode reusar o que já está salvo.
  const canTest = datasetSlug.trim().length > 0 && (isEdit || token.trim().length > 0)
  const canSave = label.trim().length > 0 && canTest

  // Colar a URL inteira do curl no campo de dataset já preenche tudo — é como
  // a credencial chega na mão de quem vai integrar. O servidor também aceita a
  // URL inteira em qualquer um dos campos (ver normalizeSlug/normalizeToken em
  // server/lakehouseSources.mjs), mas resolver aqui deixa visível o que foi
  // entendido, em vez de parecer que o campo aceitou lixo.
  const onDatasetChange = (raw: string) => {
    const value = raw.trim()
    if (!/^https?:\/\//i.test(value)) { setDatasetSlug(value); return }
    try {
      const url = new URL(value)
      const slug = /\/datasets\/([^/?#]+)/.exec(url.pathname)?.[1]
      const urlToken = url.searchParams.get('token')
      setBaseUrl(url.origin)
      setDatasetSlug(slug ? decodeURIComponent(slug) : value)
      if (urlToken) setToken(urlToken)
    } catch {
      setDatasetSlug(value)
    }
  }

  const runTest = async () => {
    setTesting(true); setTestError(null); setPreview(null)
    try {
      setPreview(await testLakehouseSource({
        baseUrl, datasetSlug,
        ...(token.trim() ? { token: token.trim() } : { id: initial?.id }),
      }))
    } catch (e) {
      setTestError(e instanceof ApiError ? e.message : 'Erro inesperado ao testar.')
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!canSave) return
    setSaving(true); setSaveError(null)
    try {
      const payload = { label, baseUrl, datasetSlug, ...(token.trim() ? { token: token.trim() } : {}) }
      const saved = isEdit ? await updateLakehouseSource(initial.id, payload) : await createLakehouseSource(payload)
      onSaved(saved)
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Erro inesperado ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-2xl border border-app-border bg-app-card shadow-card-lg">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border sticky top-0 bg-app-card z-10">
          <h2 className="text-sm font-bold text-gray-100">{isEdit ? 'Editar fonte do Data Hub' : 'Nova fonte do Data Hub'}</h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Nome (como aparece no Builder)</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex.: Clientes cancelados" className={cn(inputCls, 'mt-1')} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Dataset</span>
              <input
                value={datasetSlug}
                onChange={(e) => onDatasetChange(e.target.value)}
                placeholder="ex.: clientes-cancelados"
                className={cn(inputCls, 'mt-1 font-mono')}
              />
              <span className="text-[10px] text-gray-500">Pode colar a URL inteira do curl — o dataset e o token são extraídos dela.</span>
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Endereço do Data Hub</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={cn(inputCls, 'mt-1 font-mono')} />
          </label>

          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Token de acesso</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              placeholder={isEdit ? `deixe vazio para manter o token atual (${initial.tokenHint ?? '—'})` : 'dhub_…'}
              className={cn(inputCls, 'mt-1 font-mono')}
            />
            <span className="text-[10px] text-gray-500">
              Gerado no Data Hub, em Integrações. Fica guardado cifrado no servidor e nunca é exibido de volta — só a dica ({isEdit ? initial.tokenHint ?? '—' : 'dhub_…XXXX'}).
            </span>
          </label>

          <div className="rounded-lg border border-app-border p-3">
            <button onClick={runTest} disabled={testing || !canTest} className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight disabled:opacity-40">
              {testing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Testar conexão
            </button>
            {testError && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-risk-critical"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {testError}</p>
            )}
            {preview && <PreviewTable preview={preview} />}
          </div>

          {saveError && <p className="text-[11px] text-risk-critical">{saveError}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border sticky bottom-0 bg-app-card">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">Cancelar</button>
          <button onClick={save} disabled={!canSave || saving} className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight disabled:opacity-50">
            {saving ? 'Salvando…' : isEdit ? 'Salvar alterações' : 'Criar fonte'}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}

function SourceRow({ source, isAdmin, canManage, allFolders, onEdit, onDelete, onToggleEnabled, onSaveRefresh, onSaveFolders, onSynced }: {
  source: LakehouseSource
  isAdmin: boolean
  canManage: boolean
  allFolders: Folder[]
  onEdit: () => void
  onDelete: () => void
  onToggleEnabled: (enabled: boolean) => void
  onSaveRefresh: (refresh: RefreshPatch) => Promise<void>
  onSaveFolders: (folderIds: string[] | null) => Promise<void>
  onSynced: () => void
}) {
  const [open, setOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const sync = async () => {
    setSyncing(true); setSyncMsg(null)
    try {
      await syncLakehouseSource(source.id)
      setSyncMsg('Busca iniciada em segundo plano — as linhas novas aparecem no Builder em instantes.')
      // O PATCH só dispara o ETL; quem espera ele terminar (e recarrega o
      // dicionário desta mesma tela) é o card pai.
      onSynced()
    } catch (e) {
      setSyncMsg(e instanceof ApiError ? e.message : 'Falha ao iniciar a busca.')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <Card className={cn(!source.enabled && 'opacity-60')}>
      <div className="w-full flex items-center justify-between gap-3 px-5 py-4">
        <Toggle
          on={source.enabled}
          onChange={onToggleEnabled}
          title={source.enabled ? 'Desativar fonte (para de atualizar e sai do Builder)' : 'Ativar fonte'}
        />
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 text-left flex-1">
          <p className="text-xs font-semibold text-gray-100">{source.label}</p>
          <p className="text-[10px] text-gray-500 mt-0.5 font-mono">
            {source.datasetSlug}
            {!source.enabled && <span className="text-risk-critical"> · desativada</span>}
            {source.enabled && <span> · {source.refreshMode === 'realtime' ? 'tempo real' : `a cada ${source.refreshMinutes}min`}</span>}
            {source.rowCount != null && <span> · {source.rowCount.toLocaleString('pt-BR')} linhas</span>}
          </p>
        </button>
        {source.lastError && (
          <span
            className="text-[10px] font-semibold px-2 py-1 rounded shrink-0 flex items-center gap-1 text-risk-critical bg-risk-critical/10"
            title={`Última busca falhou: ${source.lastError}`}
          >
            <AlertTriangle size={10} /> falhou
          </span>
        )}
        <span className="text-[10px] font-semibold px-2 py-1 rounded shrink-0 flex items-center gap-1" style={{ color: '#a855f7', background: '#a855f715' }}>
          <Waypoints size={10} /> Data Hub
        </span>
        {source.folderIds && (
          <span
            className="text-[10px] font-semibold px-2 py-1 rounded shrink-0 flex items-center gap-1 text-gray-400 bg-app-surface"
            title={source.folderIds.length === 0 ? 'Nenhuma pasta liberada — some do Builder em todo lugar' : `Liberada em ${source.folderIds.length} pasta(s), não em todas`}
          >
            <FolderCog size={10} /> {source.folderIds.length}
          </span>
        )}
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onEdit} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-500 hover:text-brand-blue hover:bg-brand-blue/10" title="Editar"><Pencil size={12} /></button>
            <button onClick={onDelete} className="h-7 w-7 flex items-center justify-center rounded-md text-gray-500 hover:text-risk-critical hover:bg-risk-critical/10" title="Remover"><Trash2 size={12} /></button>
          </div>
        )}
      </div>
      {open && (
        <div className="border-t border-app-border p-4 space-y-4">
          {source.lastError && (
            <p className="flex items-start gap-1.5 text-[11px] text-risk-critical">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              Última busca falhou{source.lastErrorAt ? ` em ${new Date(source.lastErrorAt).toLocaleString('pt-BR')}` : ''}: {source.lastError}
            </p>
          )}
          <RefreshControl source={source} noun="fonte" onSave={onSaveRefresh} />
          {isAdmin && (
            <FolderControl
              source={source}
              noun="fonte"
              allFolders={allFolders}
              fetchUsage={fetchLakehouseSourceUsage}
              onSave={onSaveFolders}
            />
          )}
          <div className="space-y-1.5">
            <button onClick={sync} disabled={syncing} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue disabled:opacity-50">
              {syncing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Sincronizar agora
            </button>
            {syncMsg && <p className="text-[10px] text-gray-400">{syncMsg}</p>}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-gray-500">
            <div><dt className="inline font-semibold">Chave no Builder: </dt><dd className="inline font-mono">dhub:{source.id}</dd></div>
            <div><dt className="inline font-semibold">Endereço: </dt><dd className="inline font-mono">{source.baseUrl}</dd></div>
            <div className="flex items-center gap-1"><KeyRound size={10} /> <dt className="font-semibold">Token: </dt><dd className="font-mono">{source.tokenHint ?? '—'}</dd></div>
            {source.createdBy && <div><dt className="inline font-semibold">Cadastrada por: </dt><dd className="inline">{source.createdBy}</dd></div>}
          </dl>
        </div>
      )}
    </Card>
  )
}

// `onSourcesChanged` avisa a tela toda (hoje: o dicionário de dados logo
// abaixo) que o catálogo de campos mudou — e só DEPOIS que o ETL terminou de
// reescrever o snapshot, que é quando as colunas realmente existem.
export function LakehouseSourcesCard({ allFolders, onSourcesChanged }: {
  allFolders: Folder[]
  onSourcesChanged?: () => void
}) {
  const isAdmin = useAuthStore((s) => s.isAdmin)
  const myEmail = useAuthStore((s) => s.user?.email ?? null)
  const [sources, setSources] = useState<LakehouseSource[] | null>(null)
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState<{ open: boolean; source: LakehouseSource | null }>({ open: false, source: null })
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null)
  // Enquanto o ETL busca as linhas da fonte que acabou de ser mexida. Sem isso
  // a tela ficava muda nesses segundos e parecia que nada tinha acontecido —
  // que foi o que levou a apagar e recadastrar a fonte achando que quebrou.
  const [awaitingEtl, setAwaitingEtl] = useState<string | null>(null)
  // A espera pelo ETL dura até 3 min; se a pessoa sair da tela nesse meio, não
  // há mais card pra atualizar — e a sondagem precisa parar junto.
  //
  // O `unmounted.current = false` na ENTRADA não é redundante: em StrictMode
  // (dev) o React monta, roda a limpeza e monta de novo. Só com o valor
  // inicial, a limpeza dessa primeira montagem deixava o ref preso em `true`
  // pro resto da vida do componente — e aí toda espera se cancelava sozinha no
  // primeiro giro, deixando o aviso na tela pra sempre e nunca recarregando.
  const unmounted = useRef(false)
  useEffect(() => {
    unmounted.current = false
    return () => { unmounted.current = true }
  }, [])

  // Espera o snapshot alcançar a mudança e só então recarrega a lista e avisa
  // a tela. `gone` = a fonte foi removida (aí o que se espera é ela sumir).
  const awaitEtl = async (id: string, label: string, gone = false) => {
    setAwaitingEtl(label)
    try {
      await waitForSourceColumns(builderKey(id), { gone, isCancelled: () => unmounted.current })
    } finally {
      if (!unmounted.current) {
        setAwaitingEtl(null)
        setReloadKey((k) => k + 1)
        onSourcesChanged?.()
      }
    }
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchLakehouseSources()
      .then((r) => { if (alive) { setSources(r.sources); setDefaultBaseUrl(r.defaultBaseUrl); setError(null) } })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e.message : 'Erro inesperado.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [reloadKey])

  const replace = (saved: LakehouseSource) =>
    setSources((prev) => prev && prev.map((s) => (s.id === saved.id ? saved : s)))

  const toggleEnabled = async (id: string, enabled: boolean) => {
    // Otimista — reflete na hora; se falhar, recarrega do servidor pra desfazer.
    setSources((prev) => prev && prev.map((s) => (s.id === id ? { ...s, enabled } : s)))
    try {
      replace(await setLakehouseEnabled(id, enabled))
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao atualizar.')
      setReloadKey((k) => k + 1)
    }
  }

  const remove = (source: LakehouseSource) => {
    setConfirmState({
      title: 'Remover fonte do Data Hub',
      message: `Remover a fonte "${source.label}" (${source.datasetSlug})? Os widgets que usam essa fonte deixarão de funcionar. Isso não afeta nada no Data Hub — só o cadastro aqui.`,
      onConfirm: async () => {
        setConfirmState(null)
        try {
          await deleteLakehouseSource(source.id)
          setReloadKey((k) => k + 1)
          await awaitEtl(source.id, source.label, true)
        } catch (e) {
          alert(e instanceof ApiError ? e.message : 'Falha ao remover.')
        }
      },
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Waypoints size={13} className="text-purple-400" />
          <h2 className="text-xs font-bold text-white uppercase tracking-wider">Data Hub (lakehouse)</h2>
        </div>
        <button
          onClick={() => setEditorOpen({ open: true, source: null })}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-app-border text-[11px] font-semibold text-gray-300 hover:border-brand-blue/50 hover:text-brand-blue"
        >
          <Plus size={11} /> Nova fonte
        </button>
      </div>

      <p className="text-[10px] text-gray-500">
        Consome datasets publicados no Data Hub pela API pública dele, em vez de bater direto no banco de origem. Cada
        pessoa cadastra o dataset e o próprio token — o token fica cifrado no servidor e nunca é exibido de volta.
      </p>

      {loading && !sources && (
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500"><Loader2 size={11} className="animate-spin" /> carregando fontes…</div>
      )}
      {error && (
        <p className="flex items-start gap-1.5 text-[11px] text-risk-critical"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}</p>
      )}

      {sources?.length === 0 && (
        <p className="text-[11px] text-gray-500 rounded-xl border border-dashed border-app-border px-4 py-6 text-center">
          Nenhuma fonte do Data Hub cadastrada ainda — clique em "Nova fonte" e cole o dataset e o token.
        </p>
      )}

      <div className="space-y-2">
        {sources?.map((s) => (
          <SourceRow
            key={s.id}
            source={s}
            isAdmin={isAdmin}
            canManage={isAdmin || s.createdBy === myEmail}
            allFolders={allFolders}
            onEdit={() => setEditorOpen({ open: true, source: s })}
            onDelete={() => remove(s)}
            onToggleEnabled={(enabled) => toggleEnabled(s.id, enabled)}
            onSaveRefresh={async (refresh) => { replace(await setLakehouseRefresh(s.id, refresh)) }}
            onSaveFolders={async (folderIds) => { replace(await setLakehouseFolders(s.id, folderIds)) }}
            onSynced={() => { void awaitEtl(s.id, s.label) }}
          />
        ))}
      </div>

      {awaitingEtl && (
        <p className="flex items-center justify-center gap-1.5 text-[11px] text-brand-cyan">
          <Loader2 size={11} className="animate-spin shrink-0" />
          Buscando as linhas de "{awaitingEtl}" no Data Hub — as colunas aparecem aqui e no Builder assim que terminar.
        </p>
      )}

      {!awaitingEtl && sources && sources.length > 0 && (
        <p className="text-[10px] text-gray-500 text-center">
          Ao cadastrar, editar ou remover uma fonte, o snapshot é atualizado em segundo plano — as colunas aparecem no
          editor de widgets do Builder em pouco tempo.
        </p>
      )}

      {editorOpen.open && (
        <LakehouseSourceModal
          initial={editorOpen.source}
          defaultBaseUrl={defaultBaseUrl}
          onSaved={(saved) => {
            setEditorOpen({ open: false, source: null })
            setReloadKey((k) => k + 1)
            void awaitEtl(saved.id, saved.label)
          }}
          onClose={() => setEditorOpen({ open: false, source: null })}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel="Remover"
          danger
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  )
}
