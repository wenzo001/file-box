// 请求体限额要真的生效：server.js 里挂的全局 express.json 会先把 body 解析掉，
// 各路由再挂 express.json({limit}) 时 req._body 已置位、直接被跳过 —— 那些限额就成了死代码。
const { test } = require('node:test');
const assert = require('node:assert');
const { startServer, jget, hexKey } = require('./helpers');

const big = (kb, extra = {}) => JSON.stringify({ sid: 'ab1cd2e1', proof: 'a'.repeat(64), frames: 1, totalBytes: 10, kind: 'offer', idx: [0], ...extra, pad: 'x'.repeat(kb * 1024) });

test('无痕传输各路由声明的 body 限额要真挡住（不是被全局 json 先吃掉）', async () => {
  const srv = await startServer({ XFER_CREATE_LIMIT: '1000' });
  try {
    const legs = [
      ['/api/xfer/create', 100, 413],
      ['/api/xfer/join', 100, 413],
      ['/api/xfer/signal', 400, 413],
      ['/api/xfer/ack', 400, 413],
    ];
    for (const [route, kb, want] of legs) {
      const r = await jget(`${srv.base}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big(kb),
      });
      assert.strictEqual(r.status, want, `${route} 声明 ${kb <= 64 ? 64 : 256}KB 限额，${kb}KB 的体却拿到 ${r.status}：${JSON.stringify(r.body)}`);
      assert.ok(!/分块/.test(JSON.stringify(r.body)), `JSON 请求超限的文案不该说"分块": ${JSON.stringify(r.body)}`);
    }
    // 界内的小体照常工作（限额不是把接口关掉）
    const ok = await jget(`${srv.base}/api/xfer/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: 'ab1cd2e1', proof: 'a'.repeat(64), frames: 1, totalBytes: 10 }),
    });
    assert.strictEqual(ok.status, 200, `界内请求被误伤: ${JSON.stringify(ok.body)}`);
  } finally { await srv.stop(); }
});

test('文件库两个 JSON 端点各自的上限：init 仍容得下 200 个文件的声明，finish 收紧', async () => {
  const srv = await startServer();
  try {
    const files = Array.from({ length: 200 }, (_, i) => ({ enc: `f_deadbeef0012${i.toString(16).padStart(2, '0')}.enc`, chunks: [1024] }));
    const many = await jget(`${srv.base}/api/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: hexKey(40), files }),
    });
    assert.strictEqual(many.status, 200, `200 个文件的合法声明被拒: ${JSON.stringify(many.body)}`);
    const huge = await jget(`${srv.base}/api/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big(3000, { key: hexKey(40) }),
    });
    assert.strictEqual(huge.status, 413, 'init 的 2MB 上限要还在');
    const fin = await jget(`${srv.base}/api/upload/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big(100, { uploadId: hexKey(40) }),
    });
    assert.strictEqual(fin.status, 413, `finish 该有独立的小限额，实际 ${fin.status}`);
  } finally { await srv.stop(); }
});
