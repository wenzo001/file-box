// 打包下载的浏览器接线：先按能力选档，再决定"边写盘 / 内存 / 降级成逐个文件"。
// 纯逻辑在 zip-core.mjs（流式）与 capability.mjs（选档），这里只负责 OPFS 与保存。
import { api } from './api.js';
import { MEM_MAX_BYTES, transferToStore } from './download-core.mjs';
import { TIER, pickTier, zipBytes } from './capability.mjs';
import { createZipJob } from './zip-core.mjs';
import { canWriteHandle, handleStore, openOpfsPath, removeOpfsPath, saveBlob } from './download.js';

const ZIP_DIR = '_zips';

/** 打包该怎么下：磁盘流式 / 内存 / 逐个文件 */
export async function zipPlan(items, capBytes = MEM_MAX_BYTES) {
  const sum = zipBytes(items);
  const probe = await openOpfsPath([ZIP_DIR, 'probe'], true);
  const opfs = canWriteHandle(probe);
  if (probe) await removeOpfsPath([ZIP_DIR, 'probe']).catch(() => {});
  const picked = pickTier({ kind: 'zip', opfs, bytes: sum, capBytes });
  return { ...picked, sum, opfs, capBytes };
}

/**
 * 打包 runner。暂停后继续会**从头重新打包**（zip 是顺序写入的流，半截条目没法续），
 * 但每个文件的密文 partial 还在 OPFS 里，所以不会重新下载，只是重新解密。
 * @param {{items:Array, tier:string, filename:string, onProgress?:Function}} o
 */
export function createZipRunner({ items, tier, filename, onProgress = () => {} }) {
  const isDisk = tier === TIER.DISK;
  const zipKey = `${String(filename).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'archive'}-${Date.now().toString(36)}`;
  let zipHandle = null;
  let zipWriter = null;
  let prepared = null;

  const prepare = () => {
    if (!prepared) {
      prepared = (async () => {
        if (!isDisk) return;
        zipHandle = await openOpfsPath([ZIP_DIR, zipKey], true);
        if (!canWriteHandle(zipHandle)) throw new Error('这台设备拿不到可写的本地存储，无法边写盘打包');
      })();
    }
    return prepared;
  };

  const getCipher = async (item, { signal, onProgress: op } = {}) => {
    if (!isDisk) {
      const res = await fetch(api.downloadUrl(item.batch, item.enc), { signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `下载失败 (${res.status})`);
      }
      return res.body;
    }
    const handle = await openOpfsPath([item.batch, item.enc], true);
    if (!handle) throw new Error('拿不到本地存储句柄，无法断点续传这个文件');
    await transferToStore({
      url: api.downloadUrl(item.batch, item.enc),
      store: handleStore(handle),
      total: Number.isFinite(item.cipherSize) ? item.cipherSize : 0,
      signal,
      onUpdate: (p) => op && op({ received: p.received }),
    });
    return handle.getFile();
  };

  const cleanupCipher = async (item) => {
    if (!isDisk) return;
    await removeOpfsPath([item.batch, item.enc]).catch(() => {});
  };

  const job = createZipJob(items, {
    getCipher,
    cleanupCipher,
    onProgress,
    sink: isDisk
      ? {
        write: async (u8) => { await zipWriter.write(u8); },
        close: async () => { if (zipWriter) { const w = zipWriter; zipWriter = null; await w.close(); } },
      }
      : null,
  });

  /** 每次（重新）开始都换一份新 sink：上一轮的半截压缩包不参与这一轮 */
  const run = async ({ signal } = {}) => {
    await prepare();
    if (isDisk) {
      if (zipWriter) { try { await zipWriter.close(); } catch { /* 上一轮已废 */ } }
      zipWriter = await zipHandle.createWritable({ keepExistingData: false });
    }
    const result = await job.run({ signal });
    if (isDisk) {
      saveBlob(await zipHandle.getFile(), filename, () => removeOpfsPath([ZIP_DIR, zipKey]));
      return { saved: 'disk', bytes: result.bytes };
    }
    saveBlob(result.blob, filename);
    return { saved: 'memory', bytes: result.bytes };
  };

  /** 放弃这一轮（暂停 / 取消）：关掉写入器并删掉半截压缩包 */
  const dispose = async () => {
    if (zipWriter) { const w = zipWriter; zipWriter = null; try { await w.close(); } catch { /* 已废 */ } }
    if (isDisk && zipHandle) await removeOpfsPath([ZIP_DIR, zipKey]).catch(() => {});
  };

  return { total: job.total, tier, prepare, run, dispose };
}
