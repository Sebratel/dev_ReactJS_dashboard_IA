// Aviso flutuante quando saiu uma versão nova do app (ver useNewVersion). Fica
// no rodapé, por cima de tudo — visível em qualquer ponto da rolagem, sem
// disputar o topo com o TopBar fixo nem com a barra do modo edição. Não
// recarrega sozinho (a pessoa pode estar no meio de uma edição), mas não sai
// até atualizar: com a versão antiga, salvar é recusado pelo servidor.
import { RefreshCw, Sparkles } from 'lucide-react'

export function NewVersionBanner() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div role="status" className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-risk-high/50 bg-app-card px-4 py-2.5 text-[12px] text-gray-200 shadow-card-lg">
        <Sparkles size={14} className="shrink-0 text-risk-high" />
        <span>
          <strong className="font-semibold text-gray-100">Saiu uma versão nova do app.</strong>{' '}
          Atualize a página — com esta versão, o que você salvar pode ser recusado.
        </span>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-blue px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-brand-blueLight"
        >
          <RefreshCw size={12} /> Atualizar agora
        </button>
      </div>
    </div>
  )
}
