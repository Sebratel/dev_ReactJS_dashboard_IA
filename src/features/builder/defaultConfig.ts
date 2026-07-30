// Conteúdo padrão usado pelo workspace (server/workspace.mjs): toda dashboard
// nova nasce com uma guia de boas-vindas (sempre aberta pra quem acessa a
// pasta) explicando o funcionamento do app — as demais guias nascem
// bloqueadas até o gerente da pasta ou um admin liberar (ver DOCUMENTACAO.md).
import type { TabConfig } from './types'

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// Texto de boas-vindas. Reescrito para começar pelo caminho da IA: a versão
// anterior abria ensinando "+ Widget → escolha o tipo → escolha a fonte →
// diga o que vai no eixo X e no eixo Y", ou seja, exigia entender vocabulário
// de BI antes de ver o primeiro gráfico. Montar à mão continua documentado,
// como o segundo caminho.
const WELCOME_TEXT = `Bem-vindo(a) ao Indicadores Sebratel! 👋

Aqui você monta as suas telas de indicadores conversando — do jeito que você falaria com um colega.

💬 COMECE PERGUNTANDO
Em qualquer guia vazia (ou no botão "IA", no modo de edição), escreva o que você quer ver. Por exemplo:
- "Quais são os principais indicadores destes dados?"
- "Analise o churn e me mostre onde estão os problemas."
- "Compare o volume por mês e destaque o que mudou."

A IA lê os dados disponíveis, monta os gráficos e te mostra a proposta. Você aprova o que gostou e descarta o resto — nada entra na tela sem o seu ok.

Depois de aprovado, todo gráfico é normal: dá pra editar, trocar cor, mudar o tipo, do jeito que você quiser.

📁 COMO TUDO SE ORGANIZA
Pense em 3 gavetas, uma dentro da outra:
- Pasta → o seu setor (ex. Comercial, Instalação, Financeiro), no menu à esquerda.
- Dashboard → uma tela dentro da pasta.
- Guia → uma aba dentro da dashboard, como esta aqui, "Boas-vindas".

🔒 QUEM VÊ O QUÊ
- Administradores veem qualquer pasta, sempre.
- Gerentes cuidam do próprio setor.
- Você vê o que foi liberado especialmente para você.

Uma guia nova nasce fechada, até alguém liberar o acesso — só esta aqui, a de boas-vindas, fica sempre aberta.

✏️ MODO DE EDIÇÃO
O botão "Editar dashboard", no canto de cima, libera os controles:
- IA → conversa para montar os gráficos (o caminho mais rápido).
- + Widget → monta um gráfico à mão, se você preferir escolher tudo.
- Filtro → adiciona um filtro no topo da tela (ex. período, cidade).
- Abas, Formato e Temas → organizam as guias, o tamanho da tela e as cores.

Fique tranquilo(a): nada é salvo até você clicar em "Salvar". Não gostou? "Descartar" desfaz tudo.

📦 DE ONDE VÊM OS DADOS
Os dados chegam do Data Hub, cadastrados em Configurações. Sentiu falta de alguma informação? Fale com um administrador para publicar o conjunto de dados que você precisa.

💬 FICOU ALGUMA DÚVIDA?
Fale com o gerente do seu setor ou com um administrador — eles ajudam com acessos e com qualquer dúvida.

Agora é sua vez: diga o que você quer ver. 🚀`

// Versões anteriores do texto de boas-vindas, para a migração em
// server/workspace.mjs. A regra é: só substitui quando o conteúdo salvo é
// EXATAMENTE um destes — assim um texto que alguém editou nunca é perdido.
//
// A v1 abria ensinando "+ Widget → escolha o tipo → escolha a fonte → diga o
// que vai no eixo X e no eixo Y": exigia vocabulário de BI antes do primeiro
// gráfico, e mencionava o catálogo de queries, que não existe mais.
export const LEGACY_WELCOME_TEXTS: string[] = [
  `Bem-vindo(a) ao Indicadores Sebratel! 👋

Este é o seu espaço para montar dashboards do seu jeito — sem precisar escrever uma linha de código. É só escolher os dados, escolher o gráfico, e organizar tudo como fizer mais sentido para você.

Vamos te mostrar rapidinho como as coisas funcionam por aqui. 😊

📁 COMO TUDO SE ORGANIZA
Pense em 3 gavetas, uma dentro da outra:
- Pasta → o seu setor (ex. Comercial, Instalação, Financeiro), no menu à esquerda.
- Dashboard → uma tela dentro da pasta.
- Guia → uma aba dentro da dashboard, como esta aqui, "Boas-vindas".

Cada guia tem seus próprios gráficos, tabelas e filtros — bem do jeitinho que você (ou quem monta) preferir.

🔒 QUEM VÊ O QUÊ
Para manter tudo organizado, nem todo mundo vê tudo:
- Administradores veem qualquer pasta, sempre.
- Gerentes cuidam do próprio setor.
- Você vê o que foi liberado especialmente para você.

Uma guia nova nasce fechada, até alguém liberar o acesso — só esta aqui, a de boas-vindas, fica sempre aberta.

✏️ MODO DE EDIÇÃO
Viu um botão "Editar dashboard" no canto de cima? Se sim, você pode personalizar! Clicando nele, aparecem novos botões:
- + Widget → cria um gráfico, tabela ou card novo.
- Filtro → adiciona um filtro no topo da tela (ex. período, cidade).
- Abas → organiza as guias da dashboard.
- Formato → ajusta o tamanho da tela e a atualização automática.
- Temas → troca as cores de tudo com um clique só.

Fique tranquilo(a): nada é salvo até você clicar em "Salvar" — então pode ir experimentando sem medo. Não gostou? "Descartar" desfaz tudo.

🎨 CRIANDO SEU PRIMEIRO GRÁFICO
Clique em "+ Widget" e é só seguir 3 passinhos:
1. Escolha o tipo (barra, linha, pizza, tabela...).
2. Escolha a fonte de dados.
3. Diga o que você quer ver no eixo X e no eixo Y.

Depois, se quiser, dá pra deixar mais bonito ainda ajustando cores e fontes na aba "Formato" do próprio painel.

📦 DE ONDE VÊM OS DADOS
Tudo que aparece pra você escolher já vem pronto do catálogo de Configurações. Sentiu que falta algum dado? É só pedir para um administrador liberar.

💬 FICOU ALGUMA DÚVIDA?
Sem problema! Fale com o gerente do seu setor ou com um administrador — eles te ajudam com acessos e com qualquer dúvida que aparecer.

Agora é sua vez: explore, clique, e monte a dashboard que faz sentido para o seu dia a dia! 🚀`,
]

export const CURRENT_WELCOME_TEXT = WELCOME_TEXT

export function createWelcomeTab(): TabConfig {
  return {
    id: genId('tab'),
    label: 'Boas-vindas',
    icon: 'Sparkles',
    filters: [],
    isWelcome: true,
    access: { mode: 'open', view: [], edit: [] },
    widgets: [
      {
        id: genId('w'),
        type: 'text',
        title: 'Bem-vindo(a)',
        content: WELCOME_TEXT,
        layout: { x: 0, y: 0, w: 12, h: 14 },
      },
    ],
  }
}
