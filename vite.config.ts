// vite.config.ts
import { defineConfig } from 'vite'
import pkg from './package.json'
// https://vitejs.dev/guide/build.html#library-mode

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        ...Object.keys(pkg.dependencies), // don't bundle dependencies
        /defender-relay-client/,
        /node_modules/,
        /^node:.*/ // don't bundle built-in Node.js modules (use protocol imports!)
      ]
    },
    minify: false,
    lib: {
      entry: { 'CeloGDOracle/index': 'tasks/CeloGDOracle.ts' },
      formats: ['cjs']
    }
  }
})
