import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 前端源码在 web/；public/ 只保留静态源（crypto.js / transfer.html 等）。
// 构建产物 dist-web/ 由 Express 直接托管在站点根目录。
export default defineConfig({
  root: 'web',
  base: './',
  publicDir: '../public',
  plugins: [vue()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/crypto.js': 'http://localhost:3000',
      '/dec-worker.js': 'http://localhost:3000',
      '/transfer.html': 'http://localhost:3000',
      '/progress-strip.css': 'http://localhost:3000',
      '/xfer-': 'http://localhost:3000',
    },
  },
});
