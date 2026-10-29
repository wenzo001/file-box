// 下载任务：密文断点续传进 OPFS → 按块解密写进第二个 OPFS 文件 → 把**磁盘上的 File** 交给保存锚点。
// 内存只留一块（JS 引擎 512KB / 原生 4MB）；断线或卡住都从已存字节续，直到用户取消。
// 拿不到可写 OPFS 的页面（纯 HTTP 局域网地址 / 无痕窗口 / 旧浏览器）只能经内存走一趟 Blob：
// 上限由 MEM_DOWNLOAD_MAX_MB 下发，默认 512MB；真正的解法是改用 HTTPS 入口（那里有 OPFS，还能断点续传）。
import { api } from './api.js';
import { MEM_MAX_BYTES, decryptToStore, memoryCapProblem, transferToStore } from './download-core.mjs';

const OPFS_DIR = 'fb-lib-dl';
const PLAIN_SUFFIX = '.plain';

export function saveBlob(blob, name, after) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = String(name || 'download').replace(/[/\\]/g, '_');
  a.click();
  // 浏览器是异步读这个 blob 的：对象 URL 撤销之前不能删源文件，删早了保存会被取消（实测 canceled）
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    if (typeof after === 'function') { try { after(); } catch { /* 清理失败下次覆盖 */ } }
  }, 30_000);
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

/** 有的浏览器有 getDirectory 但没有 createWritable（或私密模式下直接抛）：这类设备不能续存 */
const canWrite = (h) => Boolean(h && typeof h.createWritable === 'function');

/** 把一个 FileSystemFileHandle 包成 download-core 要的 store */
function opfsStore(handle) {
  const size = async () => { try { return (await handle.getFile()).size; } catch { return 0; } };
  return {
    size,
    clear: async () => {
      try {
        const w = await handle.createWritable({ keepExistingData: false });
        await w.close();
      } catch { /* 文件本来就不在 */ }
    },
    openWriter: async ({ append }) => {
      const start = append ? await size() : 0;
      const w = await handle.createWritable({ keepExistingData: Boolean(append) });
      if (append && start > 0) await w.seek(start);
      return { write: (u8) => w.write(u8), close: () => w.close() };
    },
  };
}

/** 拿不到 OPFS 可写句柄时的兜底：把解密出来的块推进一个流，交给浏览器自己落盘。
    以前是攒成 ArrayBuffer 数组再 new Blob(parts)：所有分片同时活着，还多一份拷贝。
    改成流之后 JS 侧不再持有整份明文，剩下的那份缓冲归浏览器管（所以上限仍存在，只是可以放宽）。 */
function streamStore() {
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  let bytes = 0;
  return {
    stream: ts.readable,
    size: async () => bytes,
    clear: async () => { /* 流是一次性的，没有可清的中途状态 */ },
    openWriter: async ({ append }) => {
      if (append) throw new Error('流式落盘不支持续写');
      return {
        write: async (u8) => { bytes += u8.length; await writer.write(u8); },
        close: async () => { await writer.close(); },
      };
    },
    abort: async (err) => { try { await writer.abort(err); } catch { /* 已经关了 */ } },
  };
}

/** 按路径拿 OPFS 文件句柄（打包时用：[目录..., 文件名]），拿不到返回 null */
export async function openOpfsPath(parts, create = true) {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    let dir = root;
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
    return await dir.getFileHandle(parts[parts.length - 1], { create });
  } catch {
    return null;
  }
}

export async function removeOpfsPath(parts) {
  const root = await opfsRoot();
  if (!root) return;
  try {
    let dir = root;
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
    await dir.removeEntry(parts[parts.length - 1], { recursive: false });
  } catch { /* 本来就不在 */ }
}

export { canWrite as canWriteHandle, opfsStore as handleStore };

export async function clearDownload(batch, enc) {
  const root = await opfsRoot();
  if (!root) return;
  try {
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    const bdir = await dir.getDirectoryHandle(batch, { create: false });
    for (const name of [enc, `${enc}${PLAIN_SUFFIX}`]) {
      try { await bdir.removeEntry(name, { recursive: false }); } catch { /* 没有就算了 */ }
    }
    try { await dir.removeEntry(batch, { recursive: false }); } catch { /* 目录不空就算了 */ }
  } catch { /* 没有 partial 就是干净的 */ }
}

async function memoryDownload(file, { total, onUpdate, signal }) {
  const res = await fetch(api.downloadUrl(file.batch, file.enc), { signal });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `下载失败 (${res.status})`);
  }
  const store = streamStore();
  // 消费端要先挂上：TransformStream 的读端没人拉时，写端会在一个块之后阻塞，解密就停在那儿
  const blobPromise = new Response(store.stream).blob();
  let r;
  try {
    r = await decryptToStore({
      cipherSource: res.body,
      plainStore: store,
      decryptBytes: FBCrypto.decryptBytes,
      plainSize: file.plainSize,
      onProgress: (p) => onUpdate({ phase: 'decrypt', received: p.decrypted, total: p.total }),
    });
  } catch (err) {
    // 中途失败（取消 / 断流）要把流也掐掉，否则 Blob 那一侧会一直挂着等数据
    await store.abort(err);
    await blobPromise.catch(() => {});
    throw err;
  }
  onUpdate({ phase: 'save', received: r.size, total: r.size });
  saveBlob(await blobPromise, file.name);
  onUpdate({ received: total || r.size, total: total || r.size, done: true, phase: 'done' });
  return { name: file.name, size: r.size };
}

export async function downloadFile(file, { onUpdate = () => {}, signal, memCapBytes } = {}) {
  const { batch, enc, name, size, plainSize } = file;
  const total = Number.isFinite(size) ? size : 0;
  const cipher = await handleFor(batch, enc, true);
  const plain = await handleFor(batch, `${enc}${PLAIN_SUFFIX}`, true);
  const hasOpfs = canWrite(cipher) && canWrite(plain);

  const problem = memoryCapProblem({ hasOpfs, size: total, capBytes: memCapBytes || MEM_MAX_BYTES });
  if (problem) throw new Error(problem);
  if (!hasOpfs) return memoryDownload(file, { total, onUpdate, signal });

  const plainStore = opfsStore(plain);
  // 上一轮已经解密完整、只是保存那一步失败：直接再存一次，不重下也不重解
  if (Number.isFinite(plainSize) && (await plainStore.size()) === plainSize) {
    onUpdate({ phase: 'save', received: plainSize, total: plainSize });
    saveBlob(await plain.getFile(), name, () => clearDownload(batch, enc));
    onUpdate({ received: total || plainSize, total: total || plainSize, done: true, phase: 'done' });
    return { name, size: plainSize };
  }

  try {
    await transferToStore({
      url: api.downloadUrl(batch, enc),
      store: opfsStore(cipher),
      total,
      signal,
      onUpdate: (p) => onUpdate({ ...p, total: p.total || total }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // OPFS 在私密模式 / 配额已满时会在这里抛：换成能看懂的话，别让用户看着重试转圈
    if (/createWritable|NotSupported|QuotaExceeded|UnknownError/i.test(String(err.message))) {
      throw new Error('这个浏览器的存储不支持断点续存（或是空间不足），换普通窗口或换设备再试');
    }
    throw err;
  }

  const decrypted = await decryptToStore({
    cipherSource: await cipher.getFile(),
    plainStore,
    decryptBytes: FBCrypto.decryptBytes,
    plainSize,
    onProgress: (p) => onUpdate({ phase: 'decrypt', received: p.decrypted, total: p.total }),
  });
  onUpdate({ phase: 'save', received: decrypted.size, total: decrypted.size });
  saveBlob(await plain.getFile(), name, () => clearDownload(batch, enc));
  onUpdate({ received: total || decrypted.size, total: total || decrypted.size, done: true, phase: 'done' });
  return { name, size: decrypted.size };
}

