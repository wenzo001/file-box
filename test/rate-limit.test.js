// 每 IP 的固定窗口计数（与 lib/transfer.js 里那三套桶同形）。
const { test } = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../lib/rate-limit');
const { startServer, hexKey } = require('./helpers');

test('固定窗口：限 N 次，超了拒绝，窗口过了重新开始', () => {
  let t = 1000;
  const lim = createRateLimiter({ limit: 2, windowMs: 100, now: () => t });
  assert.strictEqual(lim.hit('a'), true);
  assert.strictEqual(lim.hit('a'), true);
  assert.strictEqual(lim.hit('a'), false, '第 3 次该被拒');
  assert.strictEqual(lim.hit('b'), true, '不同 key 互不影响');
  t += 101;
  assert.strictEqual(lim.hit('a'), true, '窗口过了要重新放行');
});

test('键有上界：刷不同 IP 不会把表撑爆', () => {
  const lim = createRateLimiter({ limit: 1, windowMs: 10, maxKeys: 5, now: () => 0 });
  for (let i = 0; i < 50; i++) lim.hit(`ip-${i}`);
  assert.ok(lim.size() <= 5, `键数 ${lim.size()} 超过了上界`);
});

test('上界只挤掉最老的键：新来的不受影响', () => {
  let t = 0;
  const lim = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => t });
  lim.hit('old');
  lim.hit('mid');
  lim.hit('new');
  assert.strictEqual(lim.hit('new'), false, '新键自己该还记着（被挤掉的应是 old）');
  assert.strictEqual(lim.hit('old'), true, 'old 已被挤掉，按新键重新计数');
});

test('真服务：init 与 library 各有自己的桶，超了 429，窗口过了恢复，别的接口不受牵连', async () => {
  const srv = await startServer({ INIT_PER_WINDOW: '2', LIBRARY_PER_WINDOW: '2', RATE_WINDOW_MS: '600' });
  try {
    const init = (key) => fetch(`${srv.base}/api/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: hexKey(40), files: [{ enc: 'a.enc', chunks: [8] }] }),
    });
    assert.strictEqual((await init()).status, 200);
    assert.strictEqual((await init()).status, 200);
    assert.strictEqual((await init()).status, 429, '第 3 次 init 该被限速');

    assert.strictEqual((await fetch(`${srv.base}/api/library`)).status, 200);
    assert.strictEqual((await fetch(`${srv.base}/api/library`)).status, 200);
    assert.strictEqual((await fetch(`${srv.base}/api/library`)).status, 429, '第 3 次 library 该被限速');

    // 井水不犯河水：别的接口不走这个桶
    assert.strictEqual((await fetch(`${srv.base}/api/settings`)).status, 200);
    assert.strictEqual((await fetch(`${srv.base}/api/uploads`)).status, 200);

    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual((await fetch(`${srv.base}/api/library`)).status, 200, '窗口过了要恢复');
  } finally {
    await srv.stop();
  }
});
