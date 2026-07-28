// Conexão MariaDB (DB_Applicattion — backlog e equipes de instalação, mesmo
// banco DB_MARIA do HealthyScore). Lê credenciais do .env; nunca imprime a senha.
import 'dotenv/config'
import mysql from 'mysql2/promise'

export async function makeMariaPool() {
  const required = ['DB_MARIA_HOST', 'DB_MARIA_DATABASE', 'DB_MARIA_USER', 'DB_MARIA_PASSWORD']
  const missing = required.filter((k) => !process.env[k])
  if (missing.length) throw new Error(`Variáveis ausentes no .env: ${missing.join(', ')}`)
  return mysql.createPool({
    host: process.env.DB_MARIA_HOST,
    port: Number(process.env.DB_MARIA_PORT) || 3306,
    database: process.env.DB_MARIA_DATABASE,
    user: process.env.DB_MARIA_USER,
    password: process.env.DB_MARIA_PASSWORD,
    connectionLimit: 5,
    connectTimeout: 15000,
    dateStrings: true,
  })
}
