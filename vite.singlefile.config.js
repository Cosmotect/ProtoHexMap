// Alternative build: everything (JavaScript, CSS, Three.js) packed into ONE html file.
// Used for quick sharing (for example publishing as a Claude artifact, or sending
// a single file by chat). Run with:  npm run build:single
// Output goes to dist-single/index.html
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-single',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
});
