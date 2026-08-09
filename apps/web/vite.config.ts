import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // dev：浏览器只使用 canonical :5173 origin；API、OAuth discovery 与健康检查代理到 :3000。
      '/api': 'http://localhost:3000',
      '/.well-known': 'http://localhost:3000',
      '/codex-plugin': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/ready': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
