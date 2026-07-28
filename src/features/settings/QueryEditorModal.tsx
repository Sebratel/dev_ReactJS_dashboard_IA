// Modal de criação/edição de uma query do catálogo único — título, banco,
// SQL (só leitura) e um botão de teste ao vivo (amostra de linhas/colunas)
// antes de salvar.
import { useState } from 'react'
import { X, Play, Loader2, AlertTriangle } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { createQuery, updateQuery, testQuery, ApiError, type QueryDef, type QueryTestResult } from './queryCatalogApi'

const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

export function QueryEditorModal({ initial, onSaved, onClose }: {
  initial: QueryDef | null // null = criar nova
  onSaved: () => void
  onClose: () => void
}) {
  const isEdit = !!initial
  const [id, setId] = useState(initial?.id ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [db, setDb] = useState<'postgres' | 'mariadb'>(initial?.db ?? 'postgres')
  const [sql, setSql] = useState(initial?.sql ?? '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<QueryTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const idValid = /^[a-zA-Z][a-zA-Z0-9_]{2,63}$/.test(id)
  const canSave = title.trim().length > 0 && sql.trim().length > 0 && (isEdit || idValid)

  const runTest = async () => {
    setTesting(true); setTestError(null); setTestResult(null)
    try {
      setTestResult(await testQuery(db, sql))
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
      if (isEdit) await updateQuery(initial.id, { title, db, sql })
      else await createQuery({ id, title, db, sql })
      onSaved()
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
          <h2 className="text-sm font-bold text-gray-100">{isEdit ? 'Editar query' : 'Nova query'}</h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Id (chave da fonte no Builder)</span>
              <input
                value={id}
                onChange={(e) => setId(e.target.value.trim())}
                disabled={isEdit}
                placeholder="ex.: clientesVip"
                className={cn(inputCls, 'mt-1', isEdit && 'opacity-60')}
              />
              {!isEdit && id.length > 0 && !idValid && (
                <span className="text-[10px] text-risk-critical">Use letras/números/underscore, começando com letra.</span>
              )}
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Título</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={cn(inputCls, 'mt-1')} />
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Banco de dados</span>
            <div className="mt-1 flex gap-1.5">
              {(['postgres', 'mariadb'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDb(d)}
                  className={cn('px-2.5 py-1.5 rounded-lg border text-[11px] font-medium', db === d ? 'border-brand-blue bg-brand-blue/10 text-brand-blue' : 'border-app-border text-gray-400')}
                >
                  {d === 'postgres' ? 'PostgreSQL (DB_ELLEVEN)' : 'MariaDB (DB_Applicattion)'}
                </button>
              ))}
            </div>
          </label>

          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">SQL (apenas leitura — SELECT/WITH)</span>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={9}
              spellCheck={false}
              className={cn(inputCls, 'mt-1 font-mono text-[11px] leading-relaxed resize-y')}
            />
          </label>

          <div className="rounded-lg border border-app-border p-3">
            <button onClick={runTest} disabled={testing || !sql.trim()} className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight disabled:opacity-40">
              {testing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Testar (amostra de linhas)
            </button>
            {testError && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-risk-critical"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {testError}</p>
            )}
            {testResult && (
              <div className="mt-2 overflow-x-auto">
                <p className="text-[10px] text-gray-500 mb-1.5">{testResult.rowCount} linha(s) de amostra · {testResult.columns.length} coluna(s)</p>
                {testResult.columns.length > 0 && (
                  <table className="text-[10px] w-full">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-app-border">
                        {testResult.columns.map((c) => <th key={c} className="px-2 py-1 font-medium whitespace-nowrap">{c}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {testResult.rows.slice(0, 8).map((r, i) => (
                        <tr key={i} className="border-b border-app-border/60">
                          {testResult.columns.map((c) => <td key={c} className="px-2 py-1 text-gray-300 whitespace-nowrap max-w-[160px] truncate">{String(r[c] ?? '—')}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {saveError && <p className="text-[11px] text-risk-critical">{saveError}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border sticky bottom-0 bg-app-card">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-app-border text-xs text-gray-300 hover:border-app-borderLight">Cancelar</button>
          <button onClick={save} disabled={!canSave || saving} className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight disabled:opacity-50">
            {saving ? 'Salvando…' : isEdit ? 'Salvar alterações' : 'Criar query'}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}
