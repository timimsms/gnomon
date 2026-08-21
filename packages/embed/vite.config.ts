import { defineConfig } from 'vite';

/**
 * Two entries, both ESM.
 *
 * `gnomon-embed` is what the loader imports for the inline path.
 * `gnomon-frame` is the iframe fallback's page script (phase 4.7), which
 * takes its token by postMessage rather than from a URL.
 *
 * Everything is bundled in -- no externals -- because these are loaded by a
 * <script> tag on someone else's page, where a bare import specifier has
 * nothing to resolve against.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    lib: {
      entry: { 'gnomon-embed': 'src/register.ts', 'gnomon-frame': 'src/frame.ts' },
      formats: ['es'],
    },
    rollupOptions: { output: { entryFileNames: '[name].js' } },
  },
});
