// 下载能力阶梯（纯逻辑，可在 Node 里单测）。
// 目标：**每一端都能下**，只是方式不同 —— 有磁盘就写磁盘（无大小限制、可断点续），
// 没有就内存兜底（有上限），连内存都不够时打包改成"逐个文件下载"，而不是整包失败。
export const TIER = Object.freeze({ DISK: 'disk', MEMORY: 'memory', PER_FILE: 'per-file' });

/**
 * @param {object} o
 * @param {'file'|'zip'} o.kind
 * @param {boolean} o.opfs   能拿到可写的 OPFS 文件句柄
 * @param {number}  o.bytes  zip 的明文总量 / 单文件大小（不知道就传 0）
 * @param {number}  o.capBytes 内存兜底上限（服务端下发）
 * @returns {{tier: string, reason: string}}
 */
export function pickTier({ kind, opfs, bytes = 0, capBytes = 0 }) {
  if (opfs) {
    return { tier: TIER.DISK, reason: kind === 'zip' ? '边解密边写盘，压缩包多大都行' : '断点续存，断了自己接' };
  }
  if (bytes > 0 && capBytes > 0 && bytes > capBytes) {
    if (kind === 'zip') return { tier: TIER.PER_FILE, reason: '这台设备不支持大包断点续存，改为逐个文件下载' };
    return { tier: TIER.MEMORY, reason: '超过内存上限，无法下载' };
  }
  return { tier: TIER.MEMORY, reason: '整文件经内存（这个页面拿不到本地存储：纯 HTTP、无痕窗口或旧浏览器）' };
}

/** 打包总量：优先用清单里的明文大小，没有清单（旧文件）时退回密文大小 ——
 *  否则"没有清单的大目录"永远算成 0，会被误判成小包内存路线，正好撞上要防的那种崩。 */
export function zipBytes(items) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return (items || []).reduce((sum, it) => sum + (it.dir ? 0 : (n(it.plainSize) || n(it.cipherSize))), 0);
}

/** 阶梯的可读标签（界面/日志用，别在别处再抄一份） */
export function tierLabel(tier) {
  return {
    [TIER.DISK]: '磁盘流式',
    [TIER.MEMORY]: '内存（有上限）',
    [TIER.PER_FILE]: '逐个文件',
  }[tier] || tier;
}
