// 全局 90 天保留期已经被整体删除：旧批次不会因为目录名日期老而在启动 / 上传前被清掉。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, jget } = require('./helpers');

let srv;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbret-'));
  const old = path.join(dir, 'uploads', '20190101_1200');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'old.enc'), Buffer.from('old'));
  srv = await startServer({}, dir, 0);
});

after(async () => { await srv.stop(); });

test('很多年前的旧批次在启动和上传前都不会被自动删除', async () => {
  let list = await jget(`${srv.base}/api/list`);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.folders.some((f) => f.name === '20190101_1200'), '启动后旧批次必须还在');
  assert.ok(!('retentionDays' in list.body.usage), '用法里不再有全局保留期字段');

  const key = 'a'.repeat(32);
  const init = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, files: [{ enc: 'x.enc', chunks: [4] }] }),
  });
  assert.strictEqual(init.status, 200);

  list = await jget(`${srv.base}/api/list`);
  assert.ok(list.body.folders.some((f) => f.name === '20190101_1200'), '上传 init 不能顺手清掉旧批次');
});

test('服务端源码不再包含全局保留期实现', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(src, /RETENTION_DAYS|RETENTION_MS|cleanupExpired|retentionDays/);
});
