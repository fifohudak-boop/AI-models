import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The page is built into ../web, which the app's own server (python -m hub) serves.
// `npm run dev` proxies to that server so you can work on the page with live reload.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8790', headers: { host: '127.0.0.1:8790' } },
      '/ws': { target: 'ws://127.0.0.1:8790', ws: true },
    },
  },
});
