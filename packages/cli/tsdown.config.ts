import { defineConfig } from 'tsdown'

// @graphcoder/core ships TypeScript source, which Node cannot run; bundle it.
// Everything else stays external and resolves from this package's node_modules.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: true,
  noExternal: [/^@graphcoder\//],
  outExtensions: () => ({ js: '.js' })
})
