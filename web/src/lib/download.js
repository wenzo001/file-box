// 下载任务：OPFS 存密文 partial，Range 从断点续；完成后流式解密并按清单明文大小裁剪。
import { api } from './api.js';

const OPFS_DIR = 'fb-lib-dl';

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = String(name || 'download').replace(/[/\\]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

async function opfsRoot() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
  try { return await navigator.storage.getDirectory(); } catch { return null; }
}

async function handleFor(batch, enc, create = true) {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create });
    const bdir = await dir.getDirectoryHandle(batch, { create });
    return await bdir.getFileHandle(enc, { create });
  } catch {
    return null;
  }
}

async function partialSize(handle) {
  try { return (await handle.getFile()).size; } catch { return 0; }
}

function trimTo(blob, plainSize) {
  if (!Number.isFinite(plainSize)) return blob;
  if (blob.size < plainSize) throw new Error('文件长度与清单不符（数据不完整）');
  return blob.size > plainSize ? blob.slice(0, plainSize) : blob;
}

export async function clearDownload(batch, enc) {
  const root = await opfsRoot();
  if (!root) return;
  try {
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    const bdir = await dir.getDirectoryHandle(batch, { create: false });
    await bdir.removeEntry(enc, { recursive: false });
    try { await dir.removeEntry(batch, { recursive: false }); } catch { /* 目录不空就算了 */ }
  } catch { /* 没有 partial 就是干净的 */ }
}

export async function downloadFile(file, { onUpdate = () => {}, signal } = {}) {
  const { batch, enc, name, size, plainSize } = file;
  const total = Number.isFinite(size) ? size : 0;
  const handle = await handleFor(batch, enc);

  if (handle) {
    const offset0 = await partialSize(handle);
    if (offset0 >= total && total > 0) {
      // partial 已经完整，直接解密
    } else {
      const headers = offset0 > 0 ? { Range: `bytes=${offset0}-` } : {};
      const res = await fetch(api.downloadUrl(batch, enc), { headers, signal });
      let append = offset0 > 0 && res.status === 206;
      if (res.status === 416 && offset0 >= total) {
        append = false;
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `下载失败 (${res.status})`);
      } else if (offset0 > 0 && res.status !== 206) {
        // 服务端没按 Range 回，退化为从头写，避免把两份密文拼在一起
        append = false;
      }
      if (res.ok || res.status === 416) {
        if (res.body && res.status !== 416) {
          let offset = append ? offset0 : 0;
          const writable = await handle.createWritable({ keepExistingData: append });
          if (append) await writable.seek(offset);
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writable.write(value);
            offset += value.length;
            onUpdate({ received: offset, total: total || offset });
          }
          await writable.close();
        }
      }
    }

    const fileOnDisk = await handle.getFile();
    const blob = await FBCrypto.decryptStream(fileOnDisk.stream());
    saveBlob(trimTo(blob, plainSize), name);
    await clearDownload(batch, enc);
    onUpdate({ received: total, total, done: true });
    return { name, size: blob.size };
  }

  // 没有 OPFS：可取消、可重试，但不可续传
  const res = await fetch(api.downloadUrl(batch, enc), { signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `下载失败 (${res.status})`);
  }
  const blob = await FBCrypto.decryptStream(res.body);
  saveBlob(trimTo(blob, plainSize), name);
  onUpdate({ received: total, total, done: true });
  return { name, size: blob.size };
}
