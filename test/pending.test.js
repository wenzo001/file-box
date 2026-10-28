// 影子行的口径：只收"还在路上"的任务，按目标目录分栏，进度按文件摊开。
const { test, before } = require('node:test');
const assert = require('node:assert');
let mod;
before(async () => { mod = await import('../web/src/lib/pending.mjs'); });

const task = (over = {}) => ({
  id: 'task-1', kind: 'upload', state: 'running', folderId: null,
  names: ['甲.txt'], sizes: [10], fileProgress: [0.5], ...over,
});

test('只收进行中的上传：完成 / 失败 / 取消 / 下载任务都不出现在目录里', () => {
  const rows = mod.pendingRows([
    task({ id: 'a' }),
    task({ id: 'b', state: 'done' }),
    task({ id: 'c', state: 'failed' }),
    task({ id: 'd', state: 'canceled' }),
    task({ id: 'e', state: 'paused' }),
    task({ id: 'f', kind: 'download' }),
  ], null);
  assert.deepStrictEqual(rows.map((r) => r.key), ['a-0', 'e-0']);
  assert.strictEqual(rows[1].paused, true, '暂停的要标出来');
});

test('按目标目录分栏：null 与目录 id 互不串台', () => {
  const tasks = [
    task({ id: 'root', folderId: null, names: ['r.txt'] }),
    task({ id: 'f1', folderId: 'f_1', names: ['a.txt', 'b.txt'], sizes: [1, 2], fileProgress: [1, 0.25] }),
  ];
  assert.deepStrictEqual(mod.pendingRows(tasks, null).map((r) => r.name), ['r.txt']);
  assert.deepStrictEqual(mod.pendingRows(tasks, 'f_1').map((r) => r.name), ['a.txt', 'b.txt']);
  assert.deepStrictEqual(mod.pendingRows(tasks, 'f_2'), []);
  // 一次上传多份：每份一行，键按任务 + 序号唯一
  const keys = mod.pendingRows(tasks, 'f_1').map((r) => r.key);
  assert.strictEqual(new Set(keys).size, 2);
});

test('进度夹在 0..1，缺字段不许变成 NaN / 负数宽度', () => {
  const rows = mod.pendingRows([
    task({ id: 'x', names: ['a', 'b', 'c'], sizes: [1, undefined, 3], fileProgress: [1.4, -2, undefined] }),
  ], null);
  assert.deepStrictEqual(rows.map((r) => r.progress), [1, 0, 0]);
  assert.deepStrictEqual(rows.map((r) => r.size), [1, 0, 3]);
});
