const zh = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const zhFull = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export const collator = nameCollator;

export function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtTime(ts) {
  if (!Number.isFinite(ts)) return '';
  return zh.format(new Date(ts));
}

export function fmtFullTime(ts) {
  if (!Number.isFinite(ts)) return '';
  return zhFull.format(new Date(ts));
}

export function fmtUploaded(ts) {
  if (!Number.isFinite(ts)) return '旧数据';
  return zh.format(new Date(ts));
}

/** 「3 分钟前 / 热乎」沿用旧页面的口径：10 分钟内算热乎 */
export const HOT_MS = 10 * 60_000;

export function isHot(ts, now = Date.now()) {
  // 刚上传时服务端时间可能比这一帧的 now 晚几秒；那也算热乎
  return Number.isFinite(ts) && now - ts < HOT_MS;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '时间未知';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.max(1, Math.floor(diff / 86_400_000))} 天前`;
  return zh.format(new Date(ts));
}

export function dlText(n) {
  return n > 0 ? `下载 ${n} 次` : '未下载';
}

/** 到期倒计时；null = 手动删除 */
export function fmtExpiry(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt)) return '手动删除';
  const left = expiresAt - now;
  if (left <= 0) return '已到期';
  if (left < 60_000) return '即将删除';
  // 服务端 finish 与浏览器 now 有几毫秒差；ceil 会把刚选的「1 小时」显示成 2 小时。
  // 接近整点时向上收敛到整小时，避免刚上传就写「60 分钟后删除」。
  if (left < 3_600_000) {
    const mins = Math.max(1, Math.round(left / 60_000));
    return mins >= 55 ? '1 小时后删除' : `${mins} 分钟后删除`;
  }
  if (left < 86_400_000) return `${Math.max(1, Math.round(left / 3_600_000))} 小时后删除`;
  return `${Math.max(1, Math.round(left / 86_400_000))} 天后删除`;
}

/**
 * 到期颜色态；类名自带 expiry- 前缀，避免和「按列隐藏」的表格样式撞名。
 * 基础观感由调用方的 .col-expiry 负责，这里只表达状态。
 */
export function expiryClass(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt)) return 'expiry-plain';
  const left = expiresAt - now;
  if (left < 10 * 60_000) return 'expiry-danger';
  if (left < 3_600_000) return 'expiry-warn';
  return 'expiry-plain';
}

export function ttlLabel(hours) {
  if (hours === 48) return '2 天';
  if (hours === 72) return '3 天';
  if (hours === 120) return '5 天';
  if (hours === 240) return '10 天';
  if (hours === 2160) return '90 天';
  return `${hours} 小时`;
}

export function shortTime(ts) {
  if (!Number.isFinite(ts)) return '';
  return zh.format(new Date(ts));
}
