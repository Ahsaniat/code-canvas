import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    base: '',
    build: {
        outDir: path.resolve(__dirname, '../extension/media'), // note ../
        emptyOutDir: true,
        // P1-1: ship a minified bundle with an EXTERNAL (not inline) source map so
        // the production JS is no longer an ~11 MB blob held resident in memory.
        sourcemap: true,
        minify: true,
        rollupOptions: {
            input: path.resolve(__dirname, 'index.html'),
        },
        target: 'chrome120'
    }
});
