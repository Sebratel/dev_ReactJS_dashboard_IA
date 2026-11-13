// Agente Elastic APM, carregado por preload (`node -r ./server/apm.cjs ...`) para iniciar ANTES de qualquer
// import e instrumentar http/express (skill observabilidade-backend → elastic-apm.md).
// Sem ELASTIC_APM_SERVER_URL o agente não inicia: sem isso ele assumiria 127.0.0.1:8200 e logaria falha em loop.
// Falha do agente não derruba o processo. As variáveis ELASTIC_APM_* têm precedência sobre o que está aqui.
const serverUrl = String(process.env.ELASTIC_APM_SERVER_URL || '').trim()
let apm = null

if (serverUrl !== '') {
  try {
    apm = require('elastic-apm-node').start({
      // Nome fixo entre ambientes (igual ao campo `service` do log); o ambiente varia em ELASTIC_APM_ENVIRONMENT.
      serviceName: process.env.ELASTIC_APM_SERVICE_NAME || 'indicadores-sebratel-api',
      serverUrl,
      environment: process.env.ELASTIC_APM_ENVIRONMENT || process.env.APP_ENV || process.env.NODE_ENV || 'development',
      serviceVersion: require('../package.json').version,
      captureBody: 'off', // corpo pode ter dado de cliente/credencial
      captureHeaders: false, // authorization/cookie fora, sem depender de sanitização
      transactionIgnoreUrls: ['/api/health'],
      captureExceptions: true,
    })
  } catch (error) {
    console.error(`[apm] falha ao iniciar o agente: ${error?.message || error}`)
  }
}

module.exports = apm
