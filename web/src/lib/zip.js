// 打包下载：浏览器内解密后按明文重新封成 zip。服务端只见过密文，
// 所以目录 zip 只能在这里做；不压缩（store）换取速度和可中断。
import { Zip, ZipPassThrough } from 'fflate';
import { api } from './api.js';

function safePath(input) {
  const parts = String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/');
}

function trimTo(blob, plainSize) {
  if (!Number.isFinite(plainSize)) return blob;
  if (blob.size < plainSize) throw new Error('文件长度与清单不符（数据不完整）');
  return blob.size > plainSize ? blob.slice(0, plainSize) : blob;
}

/**
 * 可暂停 / 继续的 zip 任务：zip 状态与已完成的条目留在闭包里，
 * 暂停只 abort 当前文件；继续时从下一个未完成条目接着做。
 */
export function createZipJob(items, { onProgress = () => {} } = {}) {
  const list = Array.isArray(items) ? items : [];
  const total = list.reduce((n, it) => n + (it.dir ? 0 : (Number.isFinite(it.totalSize) ? it.totalSize
    : Number.isFinite(it.cipherSize) ? it.cipherSize
      : Number.isFinite(it.plainSize) ? it.plainSize : 0)), 0);
  const chunks = [];
  const used = new Set();
  let zip = null;
  let index = 0;
  let received = 0;
  let ended = false;
  let finish = null;

  function init() {
    if (zip) return;
    zip = new Zip((err, data, final) => {
      if (err) {
        if (finish) finish.reject(err);
        return;
      }
      if (data && data.length) chunks.push(data);
      if (final && finish) finish.resolve();
    });
    finish = {};
    finish.promise = new Promise((resolve, reject) => {
      finish.resolve = resolve;
      finish.reject = reject;
    });
  }

  function unique(path) {
    const base = safePath(path) || 'file';
    if (!used.has(base)) { used.add(base); return base; }
    const slash = base.lastIndexOf('/');
    const dir = slash >= 0 ? base.slice(0, slash + 1) : '';
    const name = slash >= 0 ? base.slice(slash + 1) : base;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) {
      const candidate = `${dir}${stem} (${i})${ext}`;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
  }

  async function run({ signal } = {}) {
    init();
    for (; index < list.length; index++) {
      if (signal?.aborted) throw new DOMException('已暂停', 'AbortError');
      const item = list[index];
      if (item.dir) {
        const path = unique(item.path);
        const entry = new ZipPassThrough(`${path.replace(/\/$/, '')}/`);
        zip.add(entry);
        entry.push(new Uint8Array(0), true);
        continue;
      }
      const res = await fetch(api.downloadUrl(item.batch, item.enc), { signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `下载失败 (${res.status})`);
      }
      const blob = await FBCrypto.decryptStream(res.body, (n) => {
        const cap = Number.isFinite(item.plainSize) ? item.plainSize : n;
        onProgress({ received: received + Math.min(n, cap), total });
      });
      if (signal?.aborted) throw new DOMException('已暂停', 'AbortError');
      const out = trimTo(blob, item.plainSize);
      const bytes = new Uint8Array(await out.arrayBuffer());
      // 只有真正要写入 zip 才占用路径：暂停 / 失败的那一版不能把名字“用掉”
      const path = unique(item.path);
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      entry.push(bytes, true);
      received += Number.isFinite(item.plainSize)
        ? item.plainSize
        : (Number.isFinite(item.totalSize) ? item.totalSize
          : (Number.isFinite(item.cipherSize) ? item.cipherSize : bytes.length));
      onProgress({ received, total });
    }
    if (!ended) {
      zip.end();
      ended = true;
    }
    await finish.promise;
    return { blob: new Blob(chunks, { type: 'application/zip' }), bytes: received };
  }

  return {
    total,
    get index() { return index; },
    run,
  };
}

/** 一次性用法（测试 / 不需要暂停的场景） */
export async function buildZip(items, { signal, onProgress } = {}) {
  return createZipJob(items, { onProgress }).run({ signal });
}
