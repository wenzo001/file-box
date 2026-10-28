// 上传中的「影子文件」：把进行中的上传任务摊成目标目录里的行，完成 / 失败 / 取消即消失。
// 目录归属口径与 filesForFolder 一致：null 表示「未分档」那一栏。
const LIVE = new Set(['queued', 'running', 'finishing', 'paused']);

export function pendingRows(tasks, folderId) {
  const out = [];
  const want = folderId || null;
  for (const t of tasks || []) {
    if (t.kind !== 'upload' || !LIVE.has(t.state)) continue;
    if ((t.folderId || null) !== want) continue;
    const names = t.names || [];
    for (let i = 0; i < names.length; i++) {
      const p = Number(t.fileProgress?.[i]);
      out.push({
        key: `${t.id}-${i}`,
        name: names[i],
        size: Number(t.sizes?.[i]) || 0,
        progress: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0,
        paused: t.state === 'paused',
      });
    }
  }
  return out;
}
