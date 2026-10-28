// 打包下载（纯逻辑，可在 Node 里用真 fflate + 真 FBCrypto 验）：
// 边解密边写 sink —— 有 OPFS 时直接落到磁盘（压缩包多大都行），没有 sink 时才回退到内存 parts。
// 每个文件怎么取密文（断点续 / 直连）由调用方注入，这里只管"取到密文 → 解密 → 按块写进 zip"。
import { Zip, ZipPassThrough } from 'fflate';
import { decryptToStore } from './download-core.mjs';

export function safeZipPath(input) {
  const parts = String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/');
}

function uniquifier() {
  const used = new Set();
  return (path) => {
    const base = safeZipPath(path) || 'file';
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
  };
}

/**
 * @param {Array<{path:string, dir?:boolean, batch?:string, enc?:string, plainSize?:number}>} items
 * @param {object} opts
 * @param {(p:{received:number,total:number})=>void} [opts.onProgress]
 * @param {{write:(u8:Uint8Array)=>Promise<void>, close?:()=>Promise<void>}|null} [opts.sink] 给了就边写边落盘
 * @param {(item:object, o:{signal?:AbortSignal, onProgress?:Function})=>Promise<any>} [opts.getCipher] 拿到密文（Blob 或 ReadableStream）
 * @param {(item:object)=>Promise<void>} [opts.cleanupCipher] 该文件的密文 partial 用完清掉
 * @param {Function} [opts.decryptBytes]
 */
export function createZipJob(items, opts = {}) {
  const {
    onProgress = () => {}, sink = null, getCipher, cleanupCipher,
    decryptBytes = (...a) => globalThis.FBCrypto.decryptBytes(...a),
  } = opts;
  const list = Array.isArray(items) ? items : [];
  const total = list.reduce((n, it) => n + (it.dir ? 0 : (Number.isFinite(it.plainSize) ? it.plainSize : 0)), 0);
  const memoryParts = [];
  const unique = uniquifier();

  let zip = null;
  let pending = [];
  let done = null;
  let index = 0;
  let received = 0;
  let ended = false;

  async function flush() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    for (const chunk of batch) {
      if (sink) await sink.write(chunk);
      else memoryParts.push(chunk);
    }
  }

  function init() {
    if (zip) return;
    done = {};
    done.promise = new Promise((resolve, reject) => { done.resolve = resolve; done.reject = reject; });
    zip = new Zip((err, data, final) => {
      if (err) { done.reject(err); return; }
      if (data && data.length) pending.push(data);
      if (final) done.resolve();
    });
  }

  async function run({ signal } = {}) {
    init();
    for (; index < list.length; index++) {
      if (signal?.aborted) throw new DOMException('已暂停', 'AbortError');
      const item = list[index];
      if (item.dir) {
        const dirEntry = new ZipPassThrough(`${unique(item.path).replace(/\/$/, '')}/`);
        zip.add(dirEntry);
        dirEntry.push(new Uint8Array(0), true);
        continue;
      }
      const path = unique(item.path);
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      const cipher = await getCipher(item, {
        signal,
        onProgress: (p) => onProgress({ received: received + Math.min(p.received || 0, Number.isFinite(item.plainSize) ? item.plainSize : Infinity), total }),
      });
      // 把"解密输出"接到 zip 条目上：每块推一次，推完就把攒下的输出交给 sink（有界）
      const entryStore = {
        clear: async () => {},
        openWriter: async () => ({
          write: async (u8) => { entry.push(u8, false); await flush(); },
          close: async () => {},
        }),
      };
      const r = await decryptToStore({
        cipherSource: cipher,
        plainStore: entryStore,
        decryptBytes,
        plainSize: item.plainSize,
        onProgress: (p) => onProgress({ received: received + p.decrypted, total }),
      });
      entry.push(new Uint8Array(0), true);
      await flush();
      if (cleanupCipher) { try { await cleanupCipher(item); } catch { /* 清不掉下次覆盖 */ } }
      received += Number.isFinite(item.plainSize) ? item.plainSize : r.size;
      onProgress({ received, total });
    }
    if (!ended) { zip.end(); ended = true; }
    await done.promise;
    await flush();
    if (sink && typeof sink.close === 'function') await sink.close();
    return { blob: sink ? null : new Blob(memoryParts, { type: 'application/zip' }), bytes: received };
  }

  return { total, run, get index() { return index; } };
}
