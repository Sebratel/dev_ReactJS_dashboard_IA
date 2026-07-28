// Modelo de dados do snapshot multi-tabela — um array por tabela de negócio,
// espelhando as tabelas reais extraídas do SemanticModel do relatório Power BI
// original (ver plano). Cada interface lista os campos efetivamente usados
// pelas métricas/telas desta v1 — não é 1:1 com todas as colunas do PBIX.

export type StatusProtocolo = 'Instalado' | 'Não Instalado'
export type Turno = 'MANHÃ' | 'TARDE'
export type Grupo = 'INSTALAÇÃO' | 'MANUTENÇÃO' | 'OUTROS'

// ─── PROTOCOLOS GERAL — fato central (1 linha = 1 protocolo) ───
export interface ProtocoloGeral {
  solicitacao: string
  numeroProtocolo: string
  status: string
  cidade: string
  bairro: string
  rua: string
  equipe: string
  telefone: string
  cliente: string
  responsavel: string
  dataCriado: string | null
  dataAgenda: string | null
  horaAgenda: string | null
  tipoProtocolo: string
  pontoDeAcesso: string | null
  statusContrato: string | null
  numeroContrato: string | null
  item: string | null
  slot: number | null
  porta: number | null
  pop: string | null
  vlan: string | null
  cto: string | null
  olt: string | null
  equipamento: string | null
  contexto: string | null
  problema: string | null
  usuario: string | null
  horaCriado: string | null
  dataAlocacao: string | null
  hrAlocacao: string | null
  tecnicoInstalacao: string | null
  posicao: string | null
  statusFinanceiro: string | null
  dataEncerrado: string | null
  numeroPatrimonio: string | null
  estagioContrato: string | null
  criadoPor: string | null
  dataDaTroca: string | null
  tecnicoTroca: string | null
  tecnico1: string | null
  tecnico2: string | null
  auxiliar: string | null
  plano: string | null
  gestor: string | null
}

// ─── FIELD AGENDA — fato de produtividade/relatos de campo ─────
export interface FieldAgendaRow {
  protocolo: string
  tipoProtocolo: string | null
  statusProtocolo: string | null
  base: string | null
  instalador: string | null
  dataCriado: string | null
  slotAgenda: string | null
  prazoSla: string | null
  relato: string | null
  dataRelato: string | null
}

// ─── PROTOCOLOS TELEFONIA ────────────────────────────────────────
export interface ProtocoloTelefonia {
  solicitacao: string
  numeroProtocolo: string
  dataAgenda: string | null
  dataCriado: string | null
  dataModificado: string | null
  status: string
  cidade: string
  bairro: string | null
  rua: string | null
  telefone: string | null
  cliente: string
  equipe: string | null
  responsavel: string | null
  tipoProtocolo: string
  numeroContrato: string | null
  statusContrato: string | null
}

// ─── PROTOCOLOS PRODUTIVIDADE — base de premiação/diário ────────
export interface ProtocoloProdutividade {
  solicitacao: string
  numeroProtocolo: string
  dataAgenda: string | null
  dataCriado: string | null
  status: string
  cidade: string
  equipe: string | null
  tipoProtocolo: string
  numeroContrato: string | null
  instalador: string | null
  tecnicoTroca: string | null
  dataInstalacao: string | null
  gestor: string | null
}

// ─── REINCIDÊNCIA — instalação × 1º suporte em 30 dias ("garantia") ─
export interface ReincidenciaRow {
  serviceTag: string
  clienteNome: string
  dataInstalacao: string
  dataSuporte: string
  protocol: number
  tituloProtocolo: string | null
  protocoloInstalacao: number | null
  alocadoPor: string | null
  protocolType: string | null
}

// ─── INSTALAÇÕES REINCIDENTES — instalação × manutenção em 30 dias, com categorias ─
export interface InstalacaoReincidenteRow {
  protocoloInstalacao: number
  tipoInstalacao: string
  contrato: string
  cliente: string
  dataInstalacao: string
  tecnicoResponsavel: string | null
  protocoloManutencao: number | null
  tipoManutencao: string | null
  catalogo: string | null
  equipe: string | null
  categoria1: string | null
  categoria2: string | null
  categoria3: string | null
  categoria4: string | null
  categoria5: string | null
  dataManutencao: string | null
  reincidente30d: 'SIM' | 'NÃO'
  diasParaReincidencia: number | null
}

// ─── RETORNO PRIORITARIO ─────────────────────────────────────────
export interface RetornoPrioritarioRow {
  protocoloInstalacao: number
  tipo: string | null
  serviceTag: string
  clienteNomeInstalacao: string
  dataInstalacao: string
  protocoloRetornoPrioritario: number
  dataAbertura: string
  dataRetorno: string | null
}

// ─── BACKLOG (MariaDB) ───────────────────────────────────────────
export interface BacklogInstalacaoRow {
  total: number
  dataCriado: string | null
  tipoProtocolo: string
  equipe: string | null
  dataHoje: string
}

export interface BacklogAgendadoFuturoRow {
  protocoloId: string
  dataInicioSlot: string
  dataCarga: string
  tipoProtocolo: string | null
}

// ─── CONSOLIDADO CLIENTES — indicador mensal ─────────────────────
export interface ConsolidadoClienteRow {
  authenticationTotalizer: number
  created: string
}

// ─── Dimensões ────────────────────────────────────────────────────
export interface ContratoRow {
  cliente: string
  numeroContrato: number
  plano: string | null
  cidade: string | null
  criado: string | null
}

export interface CapacidadeEquipeRow {
  data: string
  tecnico1: string | null
  tecnico2: string | null
  equipe: string | null
  baseDeOrigem: string | null
  gerenteSupervisor: string | null
  capacidadeManha: number
  capacidadeTarde: number
}

export interface QuadroFuncionalRow {
  nome: string
  gestor: string | null
}

export interface FeriadoRow {
  data: string
  feriado: string
}

// ─── Snapshot multi-tabela (o que o ETL grava e a API serve) ─────
export interface InstallSnapshot {
  meta: {
    generatedAt: string
    coverage: 'full' | 'sample'
  }
  protocolosGeral: ProtocoloGeral[]
  fieldAgenda: FieldAgendaRow[]
  protocolosTelefonia: ProtocoloTelefonia[]
  protocolosProdutividade: ProtocoloProdutividade[]
  reincidencia: ReincidenciaRow[]
  instalacoesReincidentes: InstalacaoReincidenteRow[]
  retornoPrioritario: RetornoPrioritarioRow[]
  backlogInstalacao: BacklogInstalacaoRow[]
  backlogAgendadoFuturo: BacklogAgendadoFuturoRow[]
  consolidadoClientes: ConsolidadoClienteRow[]
  contratos: ContratoRow[]
  capacidadeEquipe: CapacidadeEquipeRow[]
  quadroFuncional: QuadroFuncionalRow[]
  feriados: FeriadoRow[]
}
