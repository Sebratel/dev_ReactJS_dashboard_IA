// Modal de gerenciamento dos relacionamentos entre fontes da ABA (ver
// TabRelation, types.ts) — o mecanismo que faz "filtrar uma tabela filtra
// as relacionadas": declarar que um campo de uma fonte é a mesma chave de
// outra faz o filtro da aba propagar entre widgets das duas, mesmo usando
// fontes diferentes. Uma mesma fonte pode aparecer em quantas relações
// forem necessárias — ex. "Bases" relacionada com várias fontes de fato ao
// mesmo tempo (o padrão "várias fato → poucas dimensão" de um dashboard
// com 2 a 10+ fontes relacionadas não precisa de nenhum conceito à parte
// pra isso, só uma TabRelation por par).
import { useState } from 'react'
import { AlertTriangle, Link2, Plus, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { ModalPortal } from '@/components/ui/ModalPortal'
import { getAllSources, getSourceDef } from './fieldCatalog'
import type { SourceTable, TabRelation } from './types'

const inputCls = 'w-full rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-gray-200 outline-none focus:border-brand-blue/50'

// Este par de fontes já tem uma relação, em qualquer ordem — bloqueado por
// completo (não só duplicata EXATA de campos): o servidor só usa a PRIMEIRA
// relação que casa um par de fontes (resolveIndirectFilter, widgetQuery.mjs)
// — uma segunda relação entre as mesmas duas fontes, mesmo com campos-chave
// diferentes, ficaria permanentemente inerte e sem nenhum aviso.
function pairAlreadyRelated(relations: TabRelation[], sourceA: string, sourceB: string): boolean {
  return relations.some((r) =>
    (r.sourceA === sourceA && r.sourceB === sourceB) || (r.sourceA === sourceB && r.sourceB === sourceA),
  )
}

export function RelationsEditorModal({ relations, onChange, onClose }: {
  relations: TabRelation[]
  onChange: (relations: TabRelation[]) => void
  onClose: () => void
}) {
  const sources = getAllSources()
  const [sourceA, setSourceA] = useState<SourceTable>(sources[0]?.key ?? '')
  const [fieldA, setFieldA] = useState('')
  const [sourceB, setSourceB] = useState<SourceTable>(sources[1]?.key ?? sources[0]?.key ?? '')
  const [fieldB, setFieldB] = useState('')
  const [label, setLabel] = useState('')

  const defA = getSourceDef(sourceA)
  const defB = getSourceDef(sourceB)
  const labelOf = (source: string) => sources.find((s) => s.key === source)?.label ?? source

  const isSelfPair = sourceA === sourceB && !!sourceA
  const isDuplicatePair = !isSelfPair && pairAlreadyRelated(relations, sourceA, sourceB)
  const canAdd = !!fieldA && !!fieldB && !!sourceA && !!sourceB && !isSelfPair && !isDuplicatePair

  const add = () => {
    if (!canAdd) return
    const rel: TabRelation = { id: `rel-${Date.now().toString(36)}`, sourceA, fieldA, sourceB, fieldB, label: label.trim() || undefined }
    onChange([...relations, rel])
    setFieldA(''); setFieldB(''); setLabel('')
  }
  const remove = (id: string) => onChange(relations.filter((r) => r.id !== id))

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="w-full max-w-lg rounded-2xl border border-app-border bg-app-card shadow-card-lg max-h-[85vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border shrink-0">
            <h2 className="text-sm font-bold text-gray-100">Relacionamentos entre fontes</h2>
            <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-200"><X size={14} /></button>
          </div>
          <div className="p-5 space-y-4 overflow-y-auto">
            <p className="text-[11px] text-gray-500">
              Declare que um campo de uma fonte é a MESMA chave de outra — a partir daí, as duas fontes ficam
              "compatíveis": (1) um filtro da aba aplicado numa das duas passa a filtrar também os widgets que
              usam a outra, e (2) qualquer widget de uma das fontes já enxerga TODOS os campos da outra nos
              seletores de Eixo X, Eixo Y, Legenda, Filtro e Coluna, como se fossem campos nativos — sem precisar
              mesclar campo por campo. Uma fonte pode entrar em quantas relações forem necessárias (ex. "Bases"
              relacionada com várias fontes ao mesmo tempo). Não encadeia: só vale entre fontes com relação DIRETA.
            </p>

            {relations.length > 0 ? (
              <div className="space-y-1.5">
                {relations.map((r) => {
                  // Fonte removida (ex. admin excluiu a fonte do Data Hub)
                  // depois que a relação foi criada — sinaliza em vez de
                  // mostrar como se estivesse tudo normal: essa relação não
                  // propaga filtro nenhum até apontar pra uma fonte real de novo.
                  const orphan = !getSourceDef(r.sourceA) || !getSourceDef(r.sourceB)
                  return (
                    <div key={r.id} className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-2', orphan ? 'border-amber-500/40 bg-amber-500/10' : 'border-app-border bg-app-surface')}>
                      {orphan ? <AlertTriangle size={12} className="text-amber-400 shrink-0" /> : <Link2 size={12} className="text-brand-blue shrink-0" />}
                      <div className="min-w-0 flex-1 text-[11px] text-gray-300 truncate">
                        {r.label && <span className="font-semibold text-gray-200">{r.label}: </span>}
                        {labelOf(r.sourceA)}.{r.fieldA} ↔ {labelOf(r.sourceB)}.{r.fieldB}
                        {orphan && <span className="ml-1.5 text-amber-400">— fonte não encontrada, esta relação não tem efeito</span>}
                      </div>
                      <button onClick={() => remove(r.id)} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-risk-critical shrink-0"><X size={12} /></button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-[11px] text-gray-500 py-1">Nenhum relacionamento ainda.</p>
            )}

            <div className="rounded-lg border border-dashed border-app-border p-3 space-y-2">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Nova relação</span>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-[10px] text-gray-500 mb-0.5">Fonte 1</span>
                  <select value={sourceA} onChange={(e) => { setSourceA(e.target.value); setFieldA('') }} className={inputCls}>
                    {sources.length === 0 && <option value="">Nenhuma fonte cadastrada ainda</option>}
                    {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[10px] text-gray-500 mb-0.5">Campo-chave</span>
                  <select value={fieldA} onChange={(e) => setFieldA(e.target.value)} className={inputCls}>
                    <option value="">Selecione…</option>
                    {defA?.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[10px] text-gray-500 mb-0.5">Fonte 2</span>
                  <select value={sourceB} onChange={(e) => { setSourceB(e.target.value); setFieldB('') }} className={inputCls}>
                    {sources.length === 0 && <option value="">Nenhuma fonte cadastrada ainda</option>}
                    {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[10px] text-gray-500 mb-0.5">Campo-chave correspondente</span>
                  <select value={fieldB} onChange={(e) => setFieldB(e.target.value)} className={inputCls}>
                    <option value="">Selecione…</option>
                    {defB?.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">Rótulo (opcional)</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex.: Base" className={inputCls} />
              </label>
              {isSelfPair && (
                <p className="text-[10px] text-amber-400">Escolha duas fontes diferentes.</p>
              )}
              {isDuplicatePair && (
                <p className="text-[10px] text-amber-400">Essas duas fontes já têm uma relação — remova a existente antes de criar outra entre elas.</p>
              )}
              <button
                onClick={add}
                disabled={!canAdd}
                className={cn('flex items-center gap-1 text-[11px] font-semibold text-brand-blue hover:text-brand-blueLight disabled:opacity-40')}
              >
                <Plus size={12} /> Adicionar relação
              </button>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-app-border shrink-0">
            <button onClick={onClose} className="px-3.5 py-2 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-brand-blueLight">Concluído</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
