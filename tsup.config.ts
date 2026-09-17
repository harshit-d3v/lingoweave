import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // Only entry points that are actually implemented. A declared export that
    // resolves to an empty module is worse than a missing one, consumers hit it
    // and get silence instead of an error they can act on.
    entry: {
      index: 'src/index.ts',
      providers: 'src/providers.ts',
      switcher: 'src/switcher.ts',
    },
    format: ['esm', 'cjs'],
    // Declarations come from `tsc -p tsconfig.build.json` instead. tsup's
    // bundled rollup-plugin-dts crashes against TypeScript 7's native compiler
    // ("Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')"),
    // since it expects the old JS compiler API.
    dts: false,
    clean: true,
    treeshake: true,
    splitting: false,
    sourcemap: true,
    target: 'es2020',
    external: ['react'],
  },
  // Standalone build for <script> tags. Everything inlined, no imports.
  {
    entry: { lingoweave: 'src/global.ts' },
    format: ['iife'],
    globalName: 'lingoweave',
    outExtension: () => ({ js: '.global.js' }),
    minify: true,
    // No map for this one. It was 150 kB, the largest file in the package by
    // far, and it maps minified CDN output that npm consumers never load.
    // The esm/cjs builds keep their maps, which is where debugging actually
    // happens.
    sourcemap: false,
    target: 'es2020',
    dts: false,
    clean: false,
  },
])
