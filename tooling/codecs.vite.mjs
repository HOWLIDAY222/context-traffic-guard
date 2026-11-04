import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  build:{
    outDir:fileURLToPath(new URL('../vendor',import.meta.url)),
    emptyOutDir:false,
    lib:{entry:fileURLToPath(new URL('./codecs.mjs',import.meta.url)),formats:['es'],fileName:()=> 'setup-codecs.mjs'},
    minify:false,
  },
});
