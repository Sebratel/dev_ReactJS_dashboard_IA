// ─────────────────────────────────────────────────────────────────────────
// Registro central das queries de PRODUÇÃO do ETL (fetch-install.mjs).
// Cada entrada aqui é uma tabela de negócio do snapshot multi-tabela — mesmo
// padrão do dev_ReacJS_HealthyScore-staging/scripts/queries/registry.mjs.
//
// Todas as queries Postgres/MariaDB abaixo foram escritas com base no schema
// REAL confirmado por consulta direta (information_schema) e TESTADAS contra
// o banco de produção durante o desenvolvimento (não são reconstrução às
// cegas do modelo DAX do Power BI original — foram validadas linha a linha).
//
// Exceções conhecidas / pendências:
//  - "EQUIPE" em PROTOCOLOS GERAL/PRODUTIVIDADE usa `ai.team_id` (time do
//    incidente) — não foi possível confirmar o FK exato que gera os nomes
//    de equipe regional vistos no Power BI original (ex.: "Instalação
//    [Brochier]"); os valores atuais tendem a mostrar times administrativos
//    (ex.: "Financeiro"). Não bloqueia KPIs de contagem/data/técnico.
//  - INSTALAÇÕES REINCIDENTES: as 5 categorias (categoria1..5) do relatório
//    original vêm de uma matriz de categorização de solicitação que não foi
//    replicada 1:1 aqui — usamos os títulos de tipo/motivo disponíveis como
//    aproximação até validar com o negócio.
// ─────────────────────────────────────────────────────────────────────────

export const FROM_DATE = '2025-01-01'
// FIELD AGENDA junta com `reports` (histórico de relatos) — em janela ampla o
// volume de linhas é grande demais e estoura o statement_timeout, e o campo
// `description` (HTML longo) piora bastante a transferência — por isso não é
// selecionado (a classificação de produtividade usa `relato`/title, não a
// descrição). Janela operacional curta (~30 dias), suficiente para agendamento
// diário e para o cálculo de médias mensais.
const FIELD_AGENDA_FROM_DATE = '2026-06-17'

// Conjunto de incident_type_id que representam instalação (fibra/rádio/troca
// de endereço/telefonia com portabilidade), confirmado contra incident_types.
const INSTALL_TYPE_IDS = [12, 1014, 1254, 1255, 1256, 1136, 249, 268, 1160, 1015, 279, 15]
const TELEFONIA_TYPE_IDS = [1011, 275, 269]
const SUPORTE_TYPE_IDS = [1174, 1160, 1149, 1124, 1125, 1105]

// ─── Base de protocolos (join comum a PROTOCOLOS GERAL/PRODUTIVIDADE) ───
const PROTOCOLO_BASE_SELECT = `
  ai.protocol::text as solicitacao,
  ai.protocol::text as numero_protocolo,
  ist.title as status,
  ac2.city as cidade,
  ac2.neighborhood as bairro,
  ac2.street as rua,
  t.title as equipe,
  p.phone as telefone,
  p.name as cliente,
  a.created as data_criado,
  a.created::time as hora_criado,
  it.title as tipo_protocolo,
  c.v_status as status_contrato,
  c.contract_number::text as numero_contrato,
  cst.service_tag as ponto_de_acesso,
  ac2.slot_olt as slot,
  ac2.port_olt as porta,
  a.conclusion_date as data_encerrado,
  palloc.name as tecnico_1,
  ppli.out_date as data_alocacao
`
const PROTOCOLO_BASE_FROM = `
from assignment_incidents ai
left join assignments a on a.id = ai.assignment_id
left join incident_types it on it.id = ai.incident_type_id
left join incident_status ist on ist.id = ai.incident_status_id
left join contract_service_tags cst on cst.id = ai.contract_service_tag_id
left join contracts c on c.id = cst.contract_id
left join people p on p.id = c.client_id
left join teams t on t.id = ai.team_id
left join authentication_contracts ac2 on ac2.contract_id = c.id
left join patrimony_packing_lists ppl on ppl.assignment_id = a.id
left join patrimony_packing_list_items ppli on ppli.patrimony_packing_list_id = ppl.id
left join people palloc on palloc.id = ppli.person_allocator_id
`

// ─── "Garantia" — instalação × suporte/manutenção em até 30 dias ───
// Padrão comum a REINCIDÊNCIA, INSTALAÇÕES REINCIDENTES e RETORNO PRIORITARIO:
// junta a base de instalações com uma base de manutenção/retorno pelo mesmo
// service_tag (ponto de acesso do contrato), dentro de uma janela de 30 dias.
function garantiaSql(manutencaoTypeIds, extra = '') {
  return `
with instalacoes as (
  select
    ai.protocol as protocolo_instalacao,
    it.title as tipo_instalacao,
    c.contract_number as contrato,
    p.name as cliente,
    coalesce(ppli.out_date, a.conclusion_date) as data_instalacao,
    cst.service_tag as service_tag,
    palloc.name as tecnico_responsavel
  from assignment_incidents ai
  left join assignments a on a.id = ai.assignment_id
  left join incident_types it on it.id = ai.incident_type_id
  left join contract_service_tags cst on cst.id = ai.contract_service_tag_id
  left join contracts c on c.id = cst.contract_id
  left join people p on p.id = c.client_id
  left join patrimony_packing_lists ppl on ppl.assignment_id = a.id
  left join patrimony_packing_list_items ppli on ppli.patrimony_packing_list_id = ppl.id
  left join people palloc on palloc.id = ppli.person_allocator_id
  where ai.incident_type_id in (${INSTALL_TYPE_IDS.join(',')})
    and a.created >= '${FROM_DATE}'
    and coalesce(ppli.out_date, a.conclusion_date) is not null
),
manutencoes as (
  select
    ai.protocol as protocolo_manutencao,
    it.title as tipo_manutencao,
    cst.service_tag as service_tag,
    a.created as data_manutencao,
    t.title as equipe
  from assignment_incidents ai
  left join assignments a on a.id = ai.assignment_id
  left join incident_types it on it.id = ai.incident_type_id
  left join contract_service_tags cst on cst.id = ai.contract_service_tag_id
  left join contracts c on c.id = cst.contract_id
  left join teams t on t.id = ai.team_id
  where ai.incident_type_id in (${manutencaoTypeIds.join(',')})
    and a.created >= '${FROM_DATE}'
    and c.v_status <> 'Cancelado'
)
select
  i.protocolo_instalacao, i.tipo_instalacao, i.contrato, i.cliente, i.data_instalacao,
  i.tecnico_responsavel, i.service_tag,
  m.protocolo_manutencao, m.tipo_manutencao, m.data_manutencao, m.equipe
from instalacoes i
left join manutencoes m on m.service_tag = i.service_tag
  and m.data_manutencao between i.data_instalacao and i.data_instalacao + interval '30 days'
${extra}
`
}

export const QUERIES = [
  // ── Instalação — protocolo a protocolo (fato central) ──────────
  {
    id: 'Q_PROTOCOLOS_GERAL', engine: 'instalacao', db: 'postgres',
    title: 'Protocolos de instalação (fato central)',
    description: 'Um protocolo por linha: instalação de fibra/rádio, troca de endereço, migração — com técnico, status, contrato e localização.',
    params: [],
    sql: `select${PROTOCOLO_BASE_SELECT}${PROTOCOLO_BASE_FROM}where ai.incident_type_id in (${INSTALL_TYPE_IDS.join(',')}) and a.created >= '${FROM_DATE}'`,
  },
  {
    id: 'Q_PROTOCOLOS_PRODUTIVIDADE', engine: 'instalacao', db: 'postgres',
    title: 'Protocolos de instalação — base de produtividade/premiação',
    description: 'Mesma base de PROTOCOLOS GERAL, usada para ranking de produtividade por instalador (Diário e Premiação).',
    params: [],
    sql: `select${PROTOCOLO_BASE_SELECT}${PROTOCOLO_BASE_FROM}where ai.incident_type_id in (${INSTALL_TYPE_IDS.join(',')}) and a.created >= '${FROM_DATE}' and palloc.name is not null`,
  },

  // ── Agendamento / produtividade de campo ────────────────────────
  {
    id: 'Q_FIELD_AGENDA', engine: 'field', db: 'postgres',
    title: 'Agenda e relatos de campo (Field)',
    description: 'Um relato por linha, a partir da view de produtividade de agendamento — status do dia, base/região e histórico de relatos do protocolo.',
    params: [],
    sql: `
select
  v.protocol::text as protocolo,
  v.incident_type_title as tipo_protocolo,
  v.incident_status_title as status_protocolo,
  v.region_title as base,
  v.resource_name as instalador,
  v.assignment_created as data_criado,
  v.begin_date_slot as slot_agenda,
  v.conclusion_date as data_conclusao,
  r.title as relato,
  r.created as data_relato
from v_service_desk_slots_productivity_informative v
left join reports r on r.assignment_id = v.assignment_id and r.created >= '${FIELD_AGENDA_FROM_DATE}'
where v.begin_date_slot >= '${FIELD_AGENDA_FROM_DATE}'
`,
  },

  // ── Telefonia / Ouvidoria ────────────────────────────────────────
  {
    id: 'Q_PROTOCOLOS_TELEFONIA', engine: 'telefonia', db: 'postgres',
    title: 'Protocolos de telefonia e ouvidoria',
    description: 'Instalação de telefonia, portabilidade e registros de ouvidoria.',
    params: [],
    sql: `
select
  ai.protocol::text as numero_protocolo,
  it.title as tipo_protocolo,
  ist.title as status,
  ac2.city as cidade,
  ac2.neighborhood as bairro,
  ac2.street as rua,
  p.phone as telefone,
  p.name as cliente,
  t.title as equipe,
  a.created as data_criado,
  a.conclusion_date as data_encerrado,
  c.contract_number::text as numero_contrato,
  c.v_status as status_contrato
from assignment_incidents ai
left join assignments a on a.id = ai.assignment_id
left join incident_types it on it.id = ai.incident_type_id
left join incident_status ist on ist.id = ai.incident_status_id
left join contract_service_tags cst on cst.id = ai.contract_service_tag_id
left join contracts c on c.id = cst.contract_id
left join people p on p.id = c.client_id
left join teams t on t.id = ai.team_id
left join authentication_contracts ac2 on ac2.contract_id = c.id
where ai.incident_type_id in (${TELEFONIA_TYPE_IDS.join(',')})
  and a.created >= '${FROM_DATE}'
`,
  },

  // ── "Garantia" — reincidência pós-instalação (30 dias) ──────────
  {
    id: 'Q_REINCIDENCIA', engine: 'reincidencia', db: 'postgres',
    title: 'Reincidência — instalação × 1º suporte em 30 dias',
    description: 'Clientes que abriram protocolo de suporte/manutenção dentro de 30 dias da instalação (garantia). Usado em Manutenção Inicial.',
    params: [],
    sql: garantiaSql(SUPORTE_TYPE_IDS),
  },
  {
    id: 'Q_INSTALACOES_REINCIDENTES', engine: 'reincidencia', db: 'postgres',
    title: 'Instalações reincidentes — recorte de fibra',
    description: 'Mesmo cruzamento de garantia, recortado para instalações de fibra — base da aba Instalação/Reincidente.',
    params: [],
    sql: garantiaSql(SUPORTE_TYPE_IDS, `where i.tipo_instalacao ilike '%fibra%'`),
  },
  {
    id: 'Q_RETORNO_PRIORITARIO', engine: 'reincidencia', db: 'postgres',
    title: 'Retorno prioritário em 30 dias',
    description: 'Instalações que geraram um protocolo de "Suporte de Retorno Prioritário" em até 30 dias.',
    params: [],
    sql: garantiaSql([1160]),
  },

  // ── Indicadores consolidados / dimensões ─────────────────────────
  {
    id: 'Q_CONSOLIDADO_CLIENTES', engine: 'base', db: 'postgres',
    title: 'Consolidado mensal da base de clientes',
    description: 'Totalizador de autenticações ativas por mês — evolução da base (Relatório do Ano).',
    params: [],
    sql: `select authentication_totalizer, created from erp.consolidated_indicators where created > '${FROM_DATE}' order by created`,
  },
  {
    id: 'Q_CONTRATOS', engine: 'base', db: 'postgres',
    title: 'Contratos (dimensão)',
    description: 'Cliente, plano e cidade por contrato — usado como dimensão de apoio.',
    params: [],
    sql: `
select
  p.name as cliente,
  c.contract_number::text as numero_contrato,
  ac2.city as cidade,
  c.created as criado
from contracts c
left join people p on p.id = c.client_id
left join authentication_contracts ac2 on ac2.contract_id = c.id
where c.created >= '${FROM_DATE}'
`,
  },

  // ── Backlog (MariaDB — DB_Applicattion, snapshot diário) ─────────
  {
    id: 'Q_BACKLOG_INSTALACAO', engine: 'backlog', db: 'mariadb',
    title: 'Backlog de instalação (snapshot diário)',
    description: 'Total de protocolos em aberto por tipo/equipe, capturado diariamente.',
    params: [],
    sql: 'select TOTAL as total, `DATA CRIADO` as data_criado, `TIPO DE PROTOCOLO` as tipo_protocolo, EQUIPE as equipe, `DATA HOJE` as data_hoje from DB_Applicattion.Backlog_Installation order by `DATA HOJE` desc',
  },
  {
    id: 'Q_BACKLOG_AGENDADO_FUTURO', engine: 'backlog', db: 'mariadb',
    title: 'Backlog agendado futuro (snapshot diário)',
    description: 'Protocolos com agendamento futuro carregado diariamente.',
    params: [],
    sql: 'select protocolo_id, data_inicio_slot, data_carga from DB_Applicattion.Backlog_Schedules order by data_carga desc',
  },
  {
    id: 'Q_CAPACIDADE_EQUIPE', engine: 'field', db: 'mariadb',
    title: 'Capacidade das equipes por dia',
    description: 'Capacidade manhã/tarde por técnico e equipe — mesma tabela usada no Power BI original (achada em MariaDB, não é preciso Google Sheets para esta).',
    params: [],
    sql: 'select DATA as data, `TÉCNICO 1` as tecnico1, `TÉCNICO 2` as tecnico2, EQUIPE as equipe, `BASE DE ORIGEM` as base_de_origem, `GERENTE/SUPERVISOR` as gerente_supervisor, `CAPACIDADE MANHÃ` as capacidade_manha, `CAPACIDADE TARDE` as capacidade_tarde from DB_Applicattion.Installation_Teams order by DATA desc',
  },

  // ── Google Sheets (QUADRO FUNCIONAL — sem equivalente em banco) ──
  {
    id: 'Q_QUADRO_FUNCIONAL', engine: 'base', db: 'sheets',
    title: 'Quadro funcional (RH)',
    description: 'Nome e gestor de cada colaborador — mantido em planilha, sem tabela equivalente encontrada nos bancos. Ver scripts/sheets.mjs.',
    params: [],
    sql: 'Google Sheets — SHEET_ID_QUADRO_FUNCIONAL, aba "QUADRO FUNCIONAL"',
  },
]
