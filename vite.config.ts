import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 转发到 server/proxy.mjs（npm run proxy）
    // 前端因此走同源路径，避免 CORS 干扰
    proxy: {
      '/jev': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});