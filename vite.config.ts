import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.API_PORT || '8788'
  return {
    plugins: [react()],
    // react-draggable (dependência do react-grid-layout) referencia
    // process.env.NODE_ENV no seu logger de debug; sem isso o navegador
    // lança "process is not defined" a cada mousedown, e a lib aborta o
    // drag silenciosamente antes de anexar os listeners de move/stop.
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // Em dev, encaminha /api para o backend (server/index.mjs). Em produção o
      // nginx faz esse proxy (docker/nginx.conf).
      proxy: {
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      },
    },
    build: {
      rollupOptions: {
        output: {
          // O worker do pdf.js (página "Manual de uso") vem do pacote como .mjs,
          // e o mime.types padrão do nginx da imagem `web` não conhece essa
          // extensão: serviria como application/octet-stream, e o navegador
          // recusa worker de módulo sem MIME de JavaScript — o manual não abriria
          // em produção, só no dev. Como .js, sai com o tipo certo em qualquer
          // servidor.
          assetFileNames: (asset) => {
            // `names` é o campo novo do rollup; chamadas internas do Vite (CSS)
            // ainda mandam só `name`.
            const name = asset.names?.[0] ?? asset.name ?? ''
            return name.endsWith('.mjs') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]'
          },
        },
      },
    },
  }
})
