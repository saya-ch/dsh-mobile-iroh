import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'

/** DSH executes registered client factories, not standalone ESM entrypoints. */
export default defineConfig({
  entry:{ client:fileURLToPath(new URL('./client.mjs',import.meta.url)) },outDir:fileURLToPath(new URL('../lib',import.meta.url)),format:['cjs'],platform:'browser',target:'es2022',
  dts:false,sourcemap:false,clean:false,deps:{ neverBundle:['react'] },
  outputOptions:{
    entryFileNames:'client.js',
    banner:'window.__ModuleLoader__.load({ id: "dsh-mobile-iroh", factory: (require) => {',
    intro:'var module = { exports: {} }; var exports = module.exports;',
    footer:'return module.exports; } });',
  },
})
