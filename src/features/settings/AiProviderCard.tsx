// Provedor de IA — a configuração que antes vivia no .env (chave, modelo,
// esforço, tetos e orçamento) editável na tela. Só admin: aqui se decide quanto
// a empresa gasta com IA e com qual credencial (ver requireAdmin() nas rotas
// /api/ai/config em server/index.mjs).
//
// GRAVAÇÃO EM RASCUNHO, e não a cada tecla: são ~10 campos que fazem sentido
// juntos (trocar de provedor implica trocar chave E modelo). Salvar a cada
// alteração mandaria o servidor operar meia configuração — provedor novo com o
// modelo antigo — e a primeira conversa quebraria com uma mensagem do provedor.
// Por isso: rascunho local, contagem do que mudou, Descartar e Salvar.
//
// A CREDENCIAL nunca chega aqui inteira; o campo mostra a máscara como
// placeholder e só envia algo se a pessoa digitar (ver aiConfigApi.ts).
import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Loader2, Check, AlertTriangle, ExternalLink, Plug, Info } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Card, CardHeader } from '@/components/ui/Card'
import {
  fetchAiConfig, saveAiConfig, testAiProvider, ApiError,
  type AiConfig, type AiConfigPatch, type ProviderId, type TestResult,
} from './aiConfigApi'

// Rótulo curto de cada campo numérico, e o porquê no title — nome de campo
// raramente basta ("idas por turno" não se explica sozinho).
const NUMEROS = [
  {
    key: 'dailyBudgetUsd' as const,
    label: 'Orçamento por dia (US$)',
    hint: 'Teto de gasto POR USUÁRIO por dia, somando montagem de widget e leitura de gráfico. Zero desliga o teto.',
    step: '0.5',
  },
  {
    key: 'maxTokens' as const,
    label: 'Teto de tokens',
    hint: 'Máximo que o modelo pode gerar numa resposta — cobre raciocínio, texto e o JSON dos widgets juntos.',
    step: '1000',
  },
  {
    key: 'maxIterations' as const,
    label: 'Idas por turno',
    hint: 'Quantas vezes o modelo pode ir e voltar (chamar ferramenta, ver o resultado, decidir) dentro de um único pedido. Baixo demais faz ele explorar e não entregar.',
    step: '1',
  },
]

const PRECOS = [
  { key: 'input' as const, label: 'Entrada' },
  { key: 'output' as const, label: 'Saída' },
  { key: 'cacheWrite' as const, label: 'Escrita de cache' },
  { key: 'cacheRead' as const, label: 'Leitura de cache' },
]

// Campo de texto/número no visual da casa. Fundo e cor de texto sempre juntos:
// definir só um dos dois é como um campo fica invisível num dos temas.
const campoBase =
  'w-full rounded-lg border border-app-border bg-app-bg text-gray-100 px-2.5 py-1.5 text-xs ' +
  'placeholder:text-gray-500 focus:outline-none focus:border-app-borderLight disabled:opacity-50'

function Rotulo({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1" title={hint}>
      {children}
    </label>
  )
}

export function AiProviderCard() {
  const [saved, setSaved] = useState<AiConfig | null>(null)
  const [draft, setDraft] = useState<AiConfigPatch | null>(null)
  // Chave digitada agora. `undefined` = não mexeu (a salva continua valendo);
  // '' = pediu pra remover.
  const [novaChave, setNovaChave] = useState<string | undefined>(undefined)
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [salvou, setSalvou] = useState(false)
  const [testando, setTestando] = useState(false)
  const [teste, setTeste] = useState<TestResult | null>(null)

  const carregar = () => {
    setErro(null)
    fetchAiConfig()
      .then((cfg) => {
        // Rascunho montado ANTES de publicar o `saved`: se a resposta vier de
        // um servidor mais antigo (campo que ainda não existia lá), o erro
        // acontece aqui e cai no catch — com `saved` já preenchido e `draft`
        // não, o render ficaria no "Carregando…" para sempre e o estado de erro
        // seria inalcançável. Foi exatamente o que aconteceu na 1ª vez que abri
        // esta tela no navegador, com a API rodando uma versão anterior.
        const rascunho = paraRascunho(cfg)
        setSaved(cfg)
        setDraft(rascunho)
        setNovaChave(undefined)
      })
      .catch((e) => {
        setSaved(null)
        setDraft(null)
        setErro(e instanceof ApiError ? e.message : 'Erro ao carregar a configuração de IA.')
      })
  }

  useEffect(carregar, [])

  const meta = saved && draft ? saved.providers[draft.provider] : null

  // O que mudou em relação ao salvo — alimenta a contagem da barra de Salvar.
  const mudancas = useMemo(() => {
    if (!saved || !draft) return []
    const lista: string[] = []
    if (draft.provider !== saved.provider) lista.push('provedor')
    if (draft.model !== saved.model) lista.push('modelo')
    if (draft.effort !== saved.effort) lista.push('esforço')
    if (draft.maxTokens !== saved.maxTokens) lista.push('teto de tokens')
    if (draft.maxIterations !== saved.maxIterations) lista.push('idas por turno')
    if (draft.dailyBudgetUsd !== saved.dailyBudgetUsd) lista.push('orçamento')
    if (draft.baseUrl !== (saved.baseUrls?.[draft.provider] ?? '')) lista.push('endpoint')
    if (PRECOS.some((p) => draft.price[p.key] !== saved.price[p.key])) lista.push('preço')
    if (novaChave !== undefined) lista.push(novaChave ? 'credencial' : 'remoção da credencial')
    return lista
  }, [saved, draft, novaChave])

  const set = <K extends keyof AiConfigPatch>(key: K, valor: AiConfigPatch[K]) => {
    setDraft((d) => (d ? { ...d, [key]: valor } : d))
    setSalvou(false)
  }

  // Trocar de provedor troca junto o modelo, o endpoint e o preço — os três são
  // propriedade DO provedor. Manter o modelo anterior deixaria o formulário
  // num estado que nenhum provedor aceita.
  const trocarProvedor = (id: ProviderId) => {
    if (!saved || !draft || id === draft.provider) return
    const p = saved.providers[id]
    const modelo = id === saved.provider ? saved.model : p.defaultModel
    const preco = p.models.find((m) => m.id === modelo)?.price ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    setDraft({
      ...draft,
      provider: id,
      model: modelo,
      baseUrl: saved.baseUrls?.[id] ?? '',
      price: id === saved.provider ? saved.price : preco,
    })
    setNovaChave(undefined)
    setTeste(null)
    setSalvou(false)
  }

  // Escolher um modelo conhecido traz o preço dele — evita a pessoa ter que
  // saber a tabela de preços de cor pro medidor de gasto funcionar.
  const trocarModelo = (id: string) => {
    if (!draft || !meta) return
    const conhecido = meta.models.find((m) => m.id === id)
    setDraft({ ...draft, model: id, ...(conhecido ? { price: conhecido.price } : {}) })
    setTeste(null)
    setSalvou(false)
  }

  const salvar = async () => {
    if (!draft) return
    setSalvando(true)
    setErro(null)
    try {
      const cfg = await saveAiConfig({ ...draft, ...(novaChave !== undefined ? { apiKey: novaChave } : {}) })
      setSaved(cfg)
      setDraft(paraRascunho(cfg))
      setNovaChave(undefined)
      setSalvou(true)
      setTimeout(() => setSalvou(false), 2500)
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao salvar a configuração de IA.')
    } finally {
      setSalvando(false)
    }
  }

  const testar = async () => {
    if (!draft) return
    setTestando(true)
    setTeste(null)
    try {
      setTeste(await testAiProvider({
        provider: draft.provider, model: draft.model, baseUrl: draft.baseUrl,
        ...(novaChave ? { apiKey: novaChave } : {}),
      }))
    } catch (e) {
      setTeste({ ok: false, error: e instanceof ApiError ? e.message : 'Falha ao testar.' })
    } finally {
      setTestando(false)
    }
  }

  // ─── Os três estados. Sem eles, a tela mostra um card vazio e a pessoa
  // conclui que não há configuração nenhuma.
  if (erro && !saved) {
    return (
      <Card className="px-5 py-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <AlertTriangle size={18} className="text-risk-critical" />
          <p className="text-sm font-medium text-gray-100">Não foi possível carregar a configuração de IA</p>
          <p className="text-[11px] text-gray-500">{erro}</p>
          <button onClick={carregar} className="mt-1 rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-[11px] text-gray-300 hover:border-app-borderLight">
            Tentar de novo
          </button>
        </div>
      </Card>
    )
  }

  if (!saved || !draft || !meta) {
    return (
      <Card className="flex items-center gap-2 px-5 py-8 text-xs text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Carregando o provedor de IA…
      </Card>
    )
  }

  const mascara = saved.keyMasks[draft.provider]
  const semChave = !mascara && !novaChave
  const chaveIlegivel = mascara === 'ilegível'
  const semPreco = draft.price.input === 0 && draft.price.output === 0

  return (
    <Card>
      <CardHeader
        title="Provedor de IA"
        subtitle="Credencial, modelo e limites de gasto da montagem com IA e da leitura de gráfico"
        icon={<Sparkles size={15} />}
        action={
          saved.updatedAt ? (
            <span className="text-[10px] text-gray-500" title={`Última alteração por ${saved.updatedBy ?? 'desconhecido'}`}>
              {new Date(saved.updatedAt).toLocaleString('pt-BR')}
            </span>
          ) : (
            <span className="text-[10px] text-gray-500" title="Nenhuma gravação por esta tela ainda: os valores vêm do .env do servidor.">
              vindo do .env
            </span>
          )
        }
      />

      <div className="space-y-4 px-5 py-4">
        {/* Provedor: três opções, então botões — diálogo aqui seria cerimônia. */}
        <div>
          <Rotulo hint="Quem responde. A troca vale a partir do próximo pedido; conversas abertas continuam no provedor em que começaram.">Provedor</Rotulo>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(saved.providers) as ProviderId[]).map((id) => {
              const ativo = draft.provider === id
              const temChave = !!saved.keyMasks[id]
              return (
                <button
                  key={id}
                  onClick={() => trocarProvedor(id)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                    ativo
                      ? 'border-primary bg-primary/10 text-gray-100 font-medium'
                      : 'border-app-border bg-app-bg text-gray-400 hover:border-app-borderLight hover:text-gray-300',
                  )}
                >
                  {saved.providers[id].label}
                  {/* Marcador de "tem credencial salva" — sem isso, trocar de
                      provedor é um pulo no escuro. */}
                  <span className={cn('ml-1.5 text-[10px]', temChave ? 'text-risk-low' : 'text-gray-500')}>
                    {temChave ? '• chave salva' : '• sem chave'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Credencial */}
          <div>
            <Rotulo hint="Guardada cifrada no servidor e nunca devolvida ao navegador — o campo mostra só o começo e o fim da chave salva.">
              {meta.keyLabel}
            </Rotulo>
            <div className="flex gap-1.5">
              <input
                type="password"
                autoComplete="off"
                value={novaChave ?? ''}
                onChange={(e) => { setNovaChave(e.target.value); setTeste(null); setSalvou(false) }}
                placeholder={mascara ? `salva: ${mascara}` : 'nenhuma chave salva'}
                className={campoBase}
              />
              <button
                onClick={testar}
                disabled={testando || (semChave && !novaChave) || !draft.model}
                title="Faz uma chamada mínima ao provedor para confirmar credencial e modelo, antes de salvar."
                className="flex shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-bg px-2.5 py-1.5 text-[11px] text-gray-300 hover:border-app-borderLight disabled:opacity-40"
              >
                {testando ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
                Testar
              </button>
            </div>
            <a
              href={meta.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300"
            >
              Onde gerar a chave <ExternalLink size={9} />
            </a>
          </div>

          {/* Modelo: texto livre com sugestões. Catálogo de modelo muda mais
              rápido que release de app — lista fechada viraria bloqueio. */}
          <div>
            <Rotulo hint="Id exato do modelo no provedor. As sugestões são atalhos; qualquer id válido serve, e o Testar confirma.">Modelo</Rotulo>
            <input
              list={`modelos-${draft.provider}`}
              value={draft.model}
              onChange={(e) => trocarModelo(e.target.value)}
              placeholder={meta.defaultModel || 'ex.: nome-do-modelo'}
              className={campoBase}
            />
            <datalist id={`modelos-${draft.provider}`}>
              {meta.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </datalist>
            {meta.models.length === 0 && (
              <p className="mt-1 text-[10px] text-gray-500">
                Sem sugestões para este provedor — confirme o id na documentação dele e use o Testar.
              </p>
            )}
          </div>

          {/* Esforço: existe só na Anthropic. Desabilitado e explicado em vez
              de escondido — controle que não faz nada engana quem clica. */}
          <div>
            <Rotulo hint={meta.supportsEffort
              ? 'Quanto o modelo pensa antes de responder. É o principal controle de custo e de espera.'
              : `${meta.label} não expõe esse controle — o valor fica salvo e volta a valer se você retornar à Anthropic.`}>
              Esforço
            </Rotulo>
            <select
              value={draft.effort}
              disabled={!meta.supportsEffort}
              onChange={(e) => set('effort', e.target.value)}
              title={meta.supportsEffort ? undefined : `Não se aplica a ${meta.label}.`}
              className={cn(campoBase, 'appearance-none')}
            >
              {saved.effortLevels.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            {!meta.supportsEffort && (
              <p className="mt-1 text-[10px] text-gray-500">Não se aplica a {meta.label}.</p>
            )}
          </div>

          {/* Endpoint alternativo */}
          <div>
            <Rotulo hint="Deixe vazio para o endpoint oficial. Use para gateway/proxy da empresa ou serviço compatível com a API do provedor.">
              Endpoint (opcional)
            </Rotulo>
            <input
              value={draft.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
              placeholder="endpoint oficial"
              className={campoBase}
            />
          </div>
        </div>

        {/* Limites */}
        <div className="grid gap-3 sm:grid-cols-3">
          {NUMEROS.map((n) => (
            <div key={n.key}>
              <Rotulo hint={n.hint}>{n.label}</Rotulo>
              <input
                type="number"
                step={n.step}
                min={0}
                value={draft[n.key]}
                onChange={(e) => set(n.key, Number(e.target.value))}
                className={cn(campoBase, 'text-right tabular-nums')}
              />
            </div>
          ))}
        </div>

        {/* Preço: entra no medidor de gasto, então precisa estar certo — e é
            editável porque preço de API muda sem avisar. */}
        <div>
          <Rotulo hint="Usado só para somar o gasto e aplicar o orçamento. Não é cobrado por nós: é a tabela do provedor, em dólar por milhão de tokens.">
            Preço por milhão de tokens (US$)
          </Rotulo>
          <div className="grid gap-3 sm:grid-cols-4">
            {PRECOS.map((p) => (
              <div key={p.key}>
                <span className="block text-[10px] text-gray-500 mb-1">{p.label}</span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={draft.price[p.key]}
                  onChange={(e) => set('price', { ...draft.price, [p.key]: Number(e.target.value) })}
                  className={cn(campoBase, 'text-right tabular-nums')}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Avisos: cada um é uma situação em que a IA parece quebrada sem dizer
            por quê. */}
        <div className="space-y-1.5">
          {chaveIlegivel && (
            <Aviso tom="critico">
              Existe uma credencial salva que o servidor não consegue abrir (a chave de cifra mudou — ver SECRETS_KEY).
              Cadastre a chave de novo para voltar a funcionar.
            </Aviso>
          )}
          {semChave && !chaveIlegivel && (
            <Aviso tom="atencao">
              Sem credencial para {meta.label}: a montagem com IA e a leitura de gráfico ficam indisponíveis. O resto do app funciona normalmente.
            </Aviso>
          )}
          {semPreco && (
            <Aviso tom="atencao">
              Sem preço cadastrado para este modelo, o medidor de gasto fica em US$ 0,00 e o orçamento diário não segura nada. Preencha entrada e saída com a tabela do provedor.
            </Aviso>
          )}
          {!meta.supportsPromptCache && (
            <Aviso tom="neutro">
              {meta.label} não tem cache de prompt controlável por requisição. O catálogo de campos é reenviado a cada ida, então o custo por conversa fica maior que na Anthropic.
            </Aviso>
          )}
          {teste && (
            <Aviso tom={teste.ok ? 'ok' : 'critico'}>
              {teste.ok
                ? `Conexão ok em ${teste.ms} ms — ${teste.model} respondeu "${teste.reply}".`
                : `O provedor recusou: ${teste.error}`}
            </Aviso>
          )}
          {erro && <Aviso tom="critico">{erro}</Aviso>}
        </div>
      </div>

      {/* Barra de rascunho: aparece só quando há o que salvar. */}
      {mudancas.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border px-5 py-3">
          <span className="text-[11px] text-gray-400">
            {mudancas.length} {mudancas.length === 1 ? 'alteração' : 'alterações'} sem salvar
            <span className="text-gray-500"> · {mudancas.join(', ')}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setDraft(paraRascunho(saved)); setNovaChave(undefined); setTeste(null); setErro(null) }}
              disabled={salvando}
              className="rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-[11px] text-gray-300 hover:border-app-borderLight disabled:opacity-40"
            >
              Descartar
            </button>
            <button
              onClick={salvar}
              disabled={salvando}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-gray-900 hover:bg-primary-container disabled:opacity-40"
            >
              {salvando ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Salvar
            </button>
          </div>
        </div>
      )}

      {salvou && mudancas.length === 0 && (
        <div className="flex items-center gap-1.5 border-t border-app-border px-5 py-2.5 text-[11px] text-risk-low">
          <Check size={12} /> Configuração salva. Vale a partir do próximo pedido à IA.
        </div>
      )}
    </Card>
  )
}

function Aviso({ tom, children }: { tom: 'critico' | 'atencao' | 'ok' | 'neutro'; children: React.ReactNode }) {
  // Fundo e texto sempre no mesmo par — variante que troca um e esquece o
  // outro produz texto invisível num dos temas.
  const tons = {
    critico: 'border-risk-critical/40 bg-risk-critical/10 text-risk-critical',
    atencao: 'border-risk-medium/40 bg-risk-medium/10 text-risk-medium',
    ok: 'border-risk-low/40 bg-risk-low/10 text-risk-low',
    neutro: 'border-app-border bg-app-bg text-gray-400',
  }[tom]
  // Ícone segue o tom: triângulo de alerta num aviso de sucesso contradiz o
  // texto, e a pessoa lê o ícone antes da frase.
  const Icone = tom === 'ok' ? Check : tom === 'neutro' ? Info : AlertTriangle
  return (
    <p className={cn('flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] leading-relaxed', tons)}>
      <Icone size={11} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  )
}

function paraRascunho(cfg: AiConfig): AiConfigPatch {
  return {
    provider: cfg.provider,
    model: cfg.model,
    effort: cfg.effort,
    maxTokens: cfg.maxTokens,
    maxIterations: cfg.maxIterations,
    dailyBudgetUsd: cfg.dailyBudgetUsd,
    price: { ...cfg.price },
    baseUrl: cfg.baseUrls?.[cfg.provider] ?? '',
  }
}
