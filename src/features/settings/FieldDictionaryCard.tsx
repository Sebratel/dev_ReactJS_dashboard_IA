// Dicionário de dados (item 9 da lista de melhorias) — admin escreve uma
// descrição/origem por campo de cada fonte (SQL ou planilha do Google); o
// texto aparece como InfoHint (i) ao lado do campo em qualquer seletor do
// Builder (AxisFieldPicker/MeasureWell/FieldWell/TableColumnsWell), pra
// qualquer usuário. Só admin edita — ver requireAdmin() na rota PUT.
import { useEffect, useMemo, useState } from 'react'
import { BookOpen, ChevronRight, Loader2, Check } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Card } from '@/components/ui/Card'
import { fetchSources } from '@/features/builder/builderApi'
import type { SourceDef } from '@/features/builder/fieldCatalog'
import { fetchFieldDictionary, saveFieldDescription, ApiError, type FieldDictionaryEntry } from './fieldDictionaryApi'

export function FieldDictionaryCard() {
  const [sources, setSources] = useState<SourceDef[] | null>(null)
  const [dict, setDict] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [savedKey, setSavedKey] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([fetchSources(), fetchFieldDictionary()])
      .then(([srcs, entries]) => {
        if (!alive) return
        setSources(srcs)
        setDict(new Map(entries.map((e: FieldDictionaryEntry) => [`${e.source}::${e.field}`, e.description])))
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

  const save = async (source: string, field: string, description: string) => {
    const key = `${source}::${field}`
    setSavingKey(key)
    try {
      await saveFieldDescription(source, field, description)
      setDict((prev) => {
        const next = new Map(prev)
        if (description.trim()) next.set(key, description.trim()); else next.delete(key)
        return next
      })
      setSavedKey(key)
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500)
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Falha ao salvar a descrição.')
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
    return <Card className="p-4"><div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" /> Carregando dicionário de dados…</div></Card>
  }
  if (error) return <Card className="p-4"><p className="text-sm text-rose-300">{error}</p></Card>
  if (!sources) return null

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen size={13} className="text-brand-cyan" />
        <h2 className="text-xs font-bold text-white uppercase tracking-wider">Dicionário de dados</h2>
      </div>
      <p className="text-[11px] text-gray-500">
        Escreva o que cada coluna significa e de onde vem — o texto aparece como um balão de informação (i) ao lado do campo, em qualquer seletor do Builder, pra qualquer usuário. Campo sem descrição não mostra nada extra.
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
                    return (
                      <div key={f.key} className="px-2.5 py-1.5 flex items-start gap-2">
                        <span className="text-[11px] text-gray-300 w-40 shrink-0 truncate pt-1" title={f.key}>{f.label}</span>
                        <textarea
                          defaultValue={dict.get(key) ?? ''}
                          onBlur={(e) => { if (e.target.value.trim() !== (dict.get(key) ?? '')) save(s.key, f.key, e.target.value) }}
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
