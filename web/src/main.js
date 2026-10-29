import { createApp } from 'vue';
import App from './App.vue';
import './styles/tokens.css';
import './styles/base.css';
import './styles/files.css';
import './styles/shell.css';

async function loadCrypto() {
  if (window.FBCrypto) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../crypto.js', location.href).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error('加密模块加载失败'));
    document.head.appendChild(script);
  });
}

async function boot() {
  try {
    await loadCrypto();
  } catch (err) {
    console.error(err);
    window.__fbCryptoError = err.message;
  }
  createApp(App).mount('#app');
}

boot();
