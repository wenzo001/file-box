// 加密清单：下载 → 解密 → 改 → 重新加密。真实文件名只在浏览器里出现。
import { api } from './api.js';

const cache = new Map();
const MAX_CACHE = 50;
const te = new TextEncoder();
const td = new TextDecoder();

function remember(batch, value) {
  cache.set(batch, value);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

export function invalidateManifest(batch) {
  cache.delete(batch);
}

export async function fetchManifest(batch, { force = false } = {}) {
  if (!force && cache.has(batch)) return cache.get(batch);
  const res = await fetch(api.downloadUrl(batch, 'manifest.enc'));
  if (res.status === 404) {
    remember(batch, null);
    return null;
  }
  if (!res.ok) throw new Error(`清单拉取失败 (${res.status})：点「重试」或刷新页面`);
  const cipher = new Uint8Array(await res.arrayBuffer());
  const plain = await FBCrypto.decryptBytes(cipher);
  const data = JSON.parse(td.decode(plain));
  const rec = { data, cipher, hash: FBCrypto.sha256Hex(cipher) };
  remember(batch, rec);
  return rec;
}

export async function encodeManifest(data) {
  const bytes = te.encode(JSON.stringify(data));
  const cipher = await FBCrypto.encryptBytes(bytes);
  return { cipher, b64: toBase64(cipher), hash: FBCrypto.sha256Hex(cipher) };
}

export function manifestMap(rec) {
  const map = new Map();
  if (rec && rec.data && Array.isArray(rec.data.files)) {
    for (const f of rec.data.files) map.set(f.enc, f);
  }
  return map;
}

export function toBase64(u8) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    s += String.fromCharCode(...u8.subarray(i, i + step));
  }
  return btoa(s);
}
