// Dicionário & Tipo de dado (item 9 da lista de melhorias, estendido) —
// admin escreve uma descrição/origem por campo de cada fonte (SQL ou
// planilha do Google) e pode sobrescrever o TIPO DE DADO do campo (estilo
// Power BI — Número Decimal/Inteiro/Percentual, Data/Hora, Texto, etc.),
// substituindo o `kind` que o backend infere sozinho a partir da amostra
// real (útil quando a inferência erra: uma data num formato que não é ISO,
// um código numérico que devia ser tratado como texto/dimensão em vez de
// medida somável). A descrição aparece como InfoHint (i) ao lado do campo
// em qualquer seletor do Builder (AxisFieldPicker/MeasureWell/FieldWell/
// TableColumnsWell); o tipo sobrescrito muda em quais desses seletores o
// campo aparece, e o tipo de filtro que ele ganha (ver DATA_TYPES,
// fieldCatalog.ts). Só admin edita — ver requireAdmin() na rota PUT.
import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronRight, Loader2, Check } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Card } from '@/components/ui/Card'
import { fetchSources } from '@/features/builder/builderApi'
import { DATA_TYPES, FIELD_KIND_LABEL, type DataTypeKey, type SourceDef } from '@/features/builder/fieldCatalog'
import { fetchFieldDictionary, saveFieldDictionaryEntry, ApiError, type FieldDictionaryEntry } from './fieldDictionaryApi'

const DATA_TYPE_GROUPS = Array.from(new Set(DATA_TYPES.map((t) => t.group)))

interface DictValue { description: string; dataType: DataTypeKey | undefined }

export function FieldDictionaryCard() {
  const [sources, setSources] = useState<SourceDef[] | null>(null)
  const [dict, setDict] = useState<Map<string, DictValue>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  // Descrição continua um <textarea> NÃO controlado (defaultValue + salva no
  // blur) — igual a antes. Guardar uma ref por campo é só pra conseguir ler
  // o texto ATUAL dela quando o tipo de dado muda (um <select> ao lado, que
  // salva na hora): sem isso, mudar o tipo enquanto uma descrição ainda não
  // salva está no meio de ser digitada apagaria essa descrição no próximo save.
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map())

  useEffect(() => {
    let alive = true
    Promise.all([fetchSources(), fetchFieldDictionary()])
      .then(([srcs, entries]) => {
        if (!alive) return
        setSources(srcs)
        setDict(new Map(entries.map((e: FieldDictionaryEntry) => [`${e.source}::${e.field}`, { description: e.description ?? '', dataType: e.dataType }])))
        setError(null)
      })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e.message : 'Erro ao carregar o dicionário de dados.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const toggle = (key: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  // As duas colunas (descrição + tipo) viajam juntas em cada salvamento —
  // evita que mudar uma apague a outra (ver upsertFieldDictionaryEntry,
  // server/fieldDictionary.mjs: as duas são a mesma entrada).
  const saveEntry = async (source: string, field: string, description: string, dataType: DataTypeKey | undefined) => {
    const key = `${source}::${field}`
    setSavingKey(key)
    try {
      await saveFieldDictionaryEntry(source, field, description, dataType)
      setDict((prev) => {
        const next = new Map(prev)
        if (description.trim() || dataType) next.set(key, { description: description.trim(), dataType })
        else next.delete(key)
        return next
      })
      setSavedKey(key)
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500)
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao salvar.')
    } finally {
      setSavingKey(null)
    }
  }

  const filteredSources = useMemo(() => {
    if (!sources) return []
    if (!search) return sources
    const q = search.toLowerCase()
    return sources
      .map((s) => ({ ...s, fields: s.fields.filter((f) => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)) }))
      .filter((s) => s.label.toLowerCase().includes(q) || s.fields.length > 0)
  }, [sources, search])

  if (loading) {
    return <Card className="p-4"><div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" /> Carregando dicionário & tipo de dado…</div></Card>
  }
  if (error) return <Card className="p-4"><p className="text-sm text-rose-300">{error}</p></Card>
  if (!sources) return null

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen size={13} className="text-brand-cyan" />
        <h2 className="text-xs font-bold text-white uppercase tracking-wider">Dicionário & Tipo de dado</h2>
      </div>
      <p className="text-[11px] text-gray-500">
        Escreva o que cada coluna significa e de onde vem — o texto aparece como um balão de informação (i) ao lado do campo, em qualquer seletor do Builder, pra qualquer usuário. Campo sem descrição não mostra nada extra. Além disso, dá pra <strong className="text-gray-400">sobrescrever o tipo de dado</strong> de um campo (estilo Power BI) quando a detecção automática erra — ex. uma data num formato que ela não reconhece, ou um código numérico que devia ser tratado como texto, não como medida somável.
      </p>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Pesquisar fonte ou campo…"
        className="w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50"
      />
      <div className="space-y-1.5 max-h-[480px] overflow-y-auto">
        {filteredSources.length === 0 && <p className="text-[11px] text-gray-500 py-2">Nenhuma fonte encontrada.</p>}
        {filteredSources.map((s) => {
          const isOpen = expanded.has(s.key) || !!search
          return (
            <div key={s.key} className="rounded-lg border border-app-border overflow-hidden">
              <button onClick={() => toggle(s.key)} className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-semibold text-gray-300 hover:bg-app-surface/60">
                <ChevronRight size={11} className={cn('shrink-0 transition-transform text-gray-500', isOpen && 'rotate-90')} />
                <span className="truncate">{s.label}</span>
                <span className="text-[10px] text-gray-500 font-normal shrink-0">({s.fields.length} campos)</span>
              </button>
              {isOpen && (
                <div className="divide-y divide-app-border/60 border-t border-app-border">
                  {s.fields.length === 0 && <p className="px-2.5 py-1.5 text-[10px] text-gray-600 italic">sem colunas</p>}
                  {s.fields.map((f) => {
                    const key = `${s.key}::${f.key}`
                    const value = dict.get(key)
                    const autoKind = f.kindAuto ?? f.kind
                    return (
                      <div key={f.key} className="px-2.5 py-1.5 flex items-start gap-2">
                        <span className="text-[11px] text-gray-300 w-36 shrink-0 truncate pt-1" title={f.key}>{f.label}</span>
                        <select
                          value={value?.dataType ?? ''}
                          onChange={(e) => {
                            const dataType = (e.target.value || undefined) as DataTypeKey | undefined
                            const currentDescription = textareaRefs.current.get(key)?.value ?? value?.description ?? ''
                            saveEntry(s.key, f.key, currentDescription, dataType)
                          }}
                          title="Tipo de dado — sobrescreve a detecção automática"
                          className="w-40 shrink-0 rounded-md border border-app-border bg-app-surface px-1.5 py-1 text-[11px] text-gray-200 outline-none focus:border-brand-blue/50"
                        >
                          <option value="">{`Automático (${FIELD_KIND_LABEL[autoKind]})`}</option>
                          {DATA_TYPE_GROUPS.map((group) => (
                            <optgroup key={group} label={group}>
                              {DATA_TYPES.filter((t) => t.group === group).map((t) => (
                                <option key={t.key} value={t.key}>{t.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <textarea
                          ref={(el) => { if (el) textareaRefs.current.set(key, el); else textareaRefs.current.delete(key) }}
                          defaultValue={value?.description ?? ''}
                          onBlur={(e) => { if (e.target.value.trim() !== (value?.description ?? '')) saveEntry(s.key, f.key, e.target.value, value?.dataType) }}
                          placeholder="Sem descrição — clique e escreva"
                          rows={1}
                          className="flex-1 min-w-0 resize-y rounded-md border border-app-border bg-app-surface px-2 py-1 text-[11px] text-gray-200 outline-none focus:border-brand-blue/50"
                        />
                        <span className="w-4 shrink-0 pt-1.5">
                          {savingKey === key && <Loader2 size={11} className="animate-spin text-gray-500" />}
                          {savedKey === key && <Check size={11} className="text-emerald-500" />}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
