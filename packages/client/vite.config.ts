import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [solid(), tailwindcss()],
    build: {
      sourcemap: true
    },
    server: {
      host: env.HOST || '0.0.0.0',
      port: parseInt(env.PORT || '3000'),
      allowedHosts: true
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true
    }
  }
})
