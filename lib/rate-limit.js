// 每 IP 的固定窗口计数：文件库侧的限速用它（无痕传输那边自有一套私有的，同形）。
// 键有上界：被刷的时候表不能只涨不落。
function createRateLimiter({ limit, windowMs, maxKeys = 10000, now = Date.now } = {}) {
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('createRateLimiter 需要 limit');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('createRateLimiter 需要 windowMs');
  const hits = new Map(); // key -> { count, resetAt }，Map 的插入顺序就是"最老在前"
  return {
    /** 记一次；返回 false 表示这一发该被拒 */
    hit(key) {
      const t = now();
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= t) {
        hits.delete(key);
        hits.set(key, { count: 1, resetAt: t + windowMs });
        while (hits.size > maxKeys) hits.delete(hits.keys().next().value); // 挤掉最老的
        return true;
      }
      if (cur.count >= limit) return false;
      cur.count += 1;
      return true;
    },
    size: () => hits.size,
  };
}

module.exports = { createRateLimiter };
