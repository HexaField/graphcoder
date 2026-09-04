import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'

/** Dev-server port. High in the range so it does not collide with other tooling. */
const DEFAULT_CLIENT_PORT = 3356

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [solid(), tailwindcss()],
    build: {
      sourcemap: true
    },
    server: {
      host: env.HOST || '0.0.0.0',
      port: parseInt(env.PORT || String(DEFAULT_CLIENT_PORT)),
      allowedHosts: true
    },
    preview: {
      host: '0.0.0.0',
      port: DEFAULT_CLIENT_PORT,
      allowedHosts: true
    }
  }
})
