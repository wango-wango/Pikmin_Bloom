import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json'

const apiProxyTarget = process.env.VITE_PROXY_API_TARGET || 'http://localhost:5679'
const wsProxyTarget = process.env.VITE_PROXY_WS_TARGET || 'ws://localhost:5679'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    port: 5678,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: wsProxyTarget,
        ws: true,
      },
    },
  },
})
