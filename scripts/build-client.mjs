#!/usr/bin/env node
/**
 * Build the client bundle (client/index.js) in the DSH client-module format:
 * a script that registers its factory with window.__ModuleLoader__.load({
 * id, factory }); the factory is CJS with require() calls for the shared
 * modules (react & friends), matching the format the DSH web shell serves
 * from /plugins/<id>/client.js.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'client')
mkdirSync(outDir, { recursive: true })

// Shared modules the web shell provides (mirrors the shell's PLATFORM_MODULES
// externals projection in dsh-client-web/lib/types/platform.d.ts); kept
// external so the bundle stays small and hooks share one React instance.
const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const result = await build({
  entryPoints: [resolve(root, 'client/src/entry.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  minify: false,
  sourcemap: false,
  external,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})

const code = result.outputFiles[0]?.text
if (!code) throw new Error('esbuild produced no output')

const wrapped = [
  'window.__ModuleLoader__.load({',
  "  id: 'deepseek-herness-kanban',",
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  code.trim(),
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')

writeFileSync(resolve(outDir, 'index.js'), wrapped)

// minimal types for the ./client export
writeFileSync(resolve(outDir, 'index.d.ts'), [
  '/** Client-plane plugin for the DSH web shell (generated stub). */',
  'export declare const inject: string[]',
  'export declare function apply(ctx: unknown): void',
  '',
].join('\n'))

console.log('client bundle written to client/index.js (' + wrapped.length + ' bytes)')

