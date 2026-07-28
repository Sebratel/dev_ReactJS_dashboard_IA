// Conexão PostgreSQL (ERP Voalle, mesmo banco DB_ELLEVEN do HealthyScore).
// Lê credenciais do .env; nunca imprime a senha.
import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg

export function makePool() {
  const required = ['DB_ELLEVEN_HOST', 'DB_ELLEVEN_DATABASE', 'DB_ELLEVEN_USER', 'DB_ELLEVEN_PASSWORD']
  const missing = required.filter((k) => !process.env[k])
  if (missing.length) {
    throw new Error(`Variáveis ausentes no .env: ${missing.join(', ')}`)
  }
  return new Pool({
    host: process.env.DB_ELLEVEN_HOST,
    port: Number(process.env.DB_ELLEVEN_PORT) || 5432,
    database: process.env.DB_ELLEVEN_DATABASE,
    user: process.env.DB_ELLEVEN_USER,
    password: process.env.DB_ELLEVEN_PASSWORD,
    ssl: process.env.DB_ELLEVEN_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
  })
}
