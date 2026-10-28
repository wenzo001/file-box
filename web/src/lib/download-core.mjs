// 下载核心（纯逻辑，可在 Node 里用假网络/假存储验）：
//  - transferToStore：把密文拉进 store，断线 / 卡住都从已存字节续，直到用户取消
//  - decryptToStore：按块解密并写进明文 store（内存只留一块，不再整文件进内存）
//  - memoryCapProblem：没有可写 OPFS 的设备，超过上限直接给话术（实测 64MB 要 355MB 堆）
// 浏览器侧的真实依赖（fetch / OPFS / FBCrypto / Blob）由 download.js 注入。
import { queueOf } from './byte-queue.mjs';

export const IDLE_MS = 15000;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30000;
// 实测：16MB 文件解密时 JS 堆峰值 +173MB，64MB +355MB（≈5×）。手机标签页预算只有几百 MB，
// 所以"整文件进内存"这条路只给没有 OPFS 可写能力的设备兜底，50MB 封顶。
export const MEM_MAX_BYTES = 50 * 1024 * 1024;

const abortError = () => Object.assign(new Error('已取消下载'), { name: 'AbortError' });
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export function memoryCapProblem({ hasOpfs, size, capBytes = MEM_MAX_BYTES }) {
  if (hasOpfs) return null;
  if (Number.isFinite(size) && size > capBytes) {
    const cap = Math.round(capBytes / 1024 / 1024);
    return `这台设备的浏览器不支持断点续存（OPFS），大于 ${cap}MB 的文件传不完：请用电脑下载，或让发送方走「无痕传输」`;
  }
  return null;
}

const isRetryableStatus = (status) => status === 429 || status >= 500;

/** 读一次，超过 idleMs 没有字节就按"卡住"拒绝（同时掐掉这次请求） */
function readWithIdle(reader, idleMs, abort) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { abort(); } catch { /* 已经断了 */ }
      reject(Object.assign(new Error('连接空闲，准备重连'), { code: 'IDLE' }));
    }, idleMs);
    reader.read().then(
      (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
    );
  });
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {{size:()=>Promise<number>, clear:()=>Promise<void>, openWriter:(o:{append:boolean})=>Promise<{write:(u8:Uint8Array)=>Promise<void>, close:()=>Promise<void>}>}} o.store
 * @param {number} [o.total] 密文总字节（来自清单；不知道就不校验"够不够"）
 * @param {Function} [o.fetchImpl]
 * @param {AbortSignal} [o.signal] 用户取消
 * @param {number} [o.idleMs]
 * @param {number} [o.retryBaseMs]
 * @param {number} [o.retryMaxMs]
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 * @param {Function} [o.onUpdate]
 */
export async function transferToStore(o) {
  const {
    url, store, total = 0, fetchImpl = fetch, signal,
    idleMs = IDLE_MS, retryBaseMs = RETRY_BASE_MS, retryMaxMs = RETRY_MAX_MS,
    sleep = sleepDefault, onUpdate = () => {},
  } = o;

  let attempt = 0;
  for (;;) {
    if (signal && signal.aborted) throw abortError();
    const offset = await store.size();
    if (total > 0 && offset >= total) return { received: offset };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let failure = null;
    try {
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (res.status === 416) {
        // 服务端说这段没法给：已存字节可能比文件还大 → 丢掉重来，别卡在死循环里
        if (offset >= total) return { received: offset };
        await store.clear();
        failure = new Error('续传范围无效，已从头重来');
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = new Error(data.error || `下载失败 (${res.status})`);
        err.status = res.status;
        if (!isRetryableStatus(res.status)) throw err;
        failure = err;
      } else {
        let append = offset > 0 && res.status === 206;
        if (offset > 0 && !append) {
          // 服务端没按 Range 回：从头写，别把两份密文拼在一起
          await store.clear();
          append = false;
        }
        const writer = await store.openWriter({ append });
        const reader = res.body.getReader();
        let received = append ? offset : 0;
        try {
          for (;;) {
            const { done, value } = await readWithIdle(reader, idleMs, () => controller.abort());
            if (done) break;
            if (!value || !value.length) continue;
            await writer.write(value);
            received += value.length;
            onUpdate({ phase: 'download', received, total: total || received, attempt });
          }
        } finally {
          try { await writer.close(); } catch { /* 关不上就当这次失败 */ }
          try { reader.cancel(); } catch { /* 已经结束 */ }
        }
        if (total > 0 && received < total) {
          failure = new Error(`连接提前结束（${received}/${total}）`);
        } else {
          return { received };
        }
      }
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      if (err.code === 'IDLE') failure = err;
      else if (err.name === 'AbortError') failure = new Error('连接被中断');
      else if (err.status && !isRetryableStatus(err.status)) throw err;
      else failure = err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    // 走到这里都是可重试的：无限退避，直到用户取消
    attempt += 1;
    const wait = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
    onUpdate({
      phase: 'waiting', attempt, retryInMs: wait, total,
      received: await store.size(),
      message: failure ? failure.message : '连接中断',
    });
    await sleep(wait);
  }
}

/**
 * 按块解密，写进明文 store（内存只留一块）。
 * cipherSource 可以是 Blob/File（有 .stream()），也可以是已经拿到的 ReadableStream。
 * @param {{cipherSource?: any, cipherFile?: Blob, plainStore: object, decryptBytes: Function, plainSize?: number, onProgress?: Function}} o
 */
export async function decryptToStore(o) {
  const { cipherSource, cipherFile, plainStore, decryptBytes, plainSize, onProgress = () => {} } = o;
  const src = cipherSource || cipherFile;
  await plainStore.clear();
  const writer = await plainStore.openWriter({ append: false });
  const q = queueOf(typeof src.stream === 'function' ? src.stream() : src);
  // 上传时明文是**向上补到 64KiB 的**：清单里的 size 才是真实大小。
  // 所以这里只能"多出来的裁掉、少了才报错"，判"严格相等"会把所有带填充的文件当成损坏。
  let plainTotal = 0;
  let decryptedTotal = 0;
  try {
    for (;;) {
      let head;
      try {
        head = await q.take(16);
      } catch (err) {
        if (q.ended && q.buffered === 0) break; // 干净的结尾
        throw err;
      }
      const len = new DataView(head.buffer, head.byteOffset, 16).getUint32(0);
      const ct = await q.take(len + 16);
      const block = new Uint8Array(16 + len + 16);
      block.set(head, 0);
      block.set(ct, 16);
      const plain = await decryptBytes(block);
      decryptedTotal += plain.length;
      const need = Number.isFinite(plainSize) ? plainSize - plainTotal : plain.length;
      if (need > 0) {
        const out = need >= plain.length ? plain : plain.subarray(0, need);
        await writer.write(out);
        plainTotal += out.length;
      }
      onProgress({ decrypted: plainTotal, total: Number.isFinite(plainSize) ? plainSize : decryptedTotal });
    }
  } finally {
    try { await writer.close(); } catch { /* 关不上也不能把半截当成品 */ }
  }
  if (Number.isFinite(plainSize) && plainTotal < plainSize) {
    throw new Error('文件长度与清单不符（数据不完整）');
  }
  return { size: plainTotal };
}
