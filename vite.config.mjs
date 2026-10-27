import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 新界面先挂在 /next/，默认页面仍是 public/index.html；切换根页面之前互不影响。
// 构建产物 dist-web/next 由 Express 的 /next 静态路由托管。
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [vue()],
  build: {
    outDir: '../dist-web/next',
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
