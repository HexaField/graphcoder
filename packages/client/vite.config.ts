import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [solid(), tailwindcss()],
    server: {
      host: env.HOST || 'localhost',
      port: parseInt(env.PORT || '3000')
    }
  }
})
