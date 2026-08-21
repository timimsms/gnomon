import { defineConfig } from 'vite';

/**
 * IIFE, because this is a plain <script src> that must work on any page --
 * including ones that predate modules. The ESM path is for integrators who
 * bundle @gnomon/embed themselves and never touch this file.
 */
export default defineConfig({
  build: {
    lib: { entry: 'src/loader.ts', formats: ['iife'], name: 'GnomonLoader', fileName: () => 'embed.js' },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    target: 'es2020',
    // The loader is the ONLY thing in this bundle. If a dependency ever
    // appears here, the size budget will say so loudly.
    rollupOptions: { external: [] },
  },
});
