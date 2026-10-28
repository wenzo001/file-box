// 一键清空：编排层（lib/maintenance.js）的契约。
// 集成面（真的删盘、真的保留目录树）在 maintenance-api.test.js，这里用假的依赖把
// "先校验再动手"、竞态重扫、清不干净就报错这三件逻辑单独钉住。
const { test } = require('node:test');
const assert = require('node:assert');
const { createMaintenance, WIPE_CONFIRM } = require('../lib/maintenance');

function harness(over = {}) {
  const calls = [];
  let batches = over.batches || [];
  let transfer = over.transfer || { sessions: 2, bytes: 300 };
  const m = createMaintenance({
    listBatches: async () => batches.map((b) => ({ ...b })),
    dropBatch: async (name) => { calls.push(`drop:${name}`); batches = batches.filter((b) => b.name !== name); },
    clearStaging: async () => { calls.push('staging'); return { batches: 1, bytes: 10 }; },
    purgeTransfer: async () => { calls.push('transfer'); return transfer; },
    downloadTotal: () => 42,
    ...over,
  });
  return { m, calls, setBatches: (b) => { batches = b; }, batchesLeft: () => batches };
}

test('确认词不对：抛 400，且一个回调都不许被调用（先校验再动手）', async () => {
  const h = harness({ batches: [{ name: '20261028_1200', count: 2, size: 100 }] });
  await assert.rejects(() => h.m.wipe({ confirm: '清空' }), (err) => err.status === 400 && /确认词/.test(err.message));
  assert.deepStrictEqual(h.calls, [], `校验没过就动手了：${h.calls.join(',')}`);
});

test('正常清理：暂存 → 逐批删 → 中转，回执里的数对得上', async () => {
  const h = harness({ batches: [
    { name: '20261028_1200', count: 2, size: 100 },
    { name: '20261028_1201', count: 3, size: 250 },
  ] });
  const r = await h.m.wipe({ confirm: WIPE_CONFIRM });
  assert.deepStrictEqual(h.calls, ['staging', 'drop:20261028_1200', 'drop:20261028_1201', 'transfer']);
  assert.strictEqual(r.removed.batches, 2);
  assert.strictEqual(r.removed.files, 5);
  assert.strictEqual(r.removed.bytes, 350);
  assert.deepStrictEqual(r.removed.transfer, { sessions: 2, bytes: 300 });
  assert.strictEqual(r.kept.downloadTotal, 42);
  assert.strictEqual(r.verified.uploadsEmpty, true);
});

test('竞态：删完之后又有批次冒出来（收尾刚好落地），要再扫一轮把它删掉', async () => {
  let injected = false;
  const h = harness({ batches: [{ name: '20261028_1200', count: 1, size: 10 }] });
  const base = h.m;
  const m = createMaintenance({
    listBatches: async () => h.batchesLeft().map((b) => ({ ...b })),
    dropBatch: async (name) => {
      h.calls.push(`drop:${name}`);
      const left = h.batchesLeft().filter((b) => b.name !== name);
      h.setBatches(left);
      if (!injected) { injected = true; h.setBatches([...left, { name: '20261028_1202', count: 1, size: 7 }]); }
    },
    clearStaging: async () => { h.calls.push('staging'); return { batches: 0, bytes: 0 }; },
    purgeTransfer: async () => { h.calls.push('transfer'); return { sessions: 0, bytes: 0 }; },
    downloadTotal: () => 0,
  });
  const r = await m.wipe({ confirm: WIPE_CONFIRM });
  assert.deepStrictEqual(h.calls.filter((c) => c.startsWith('drop:')), ['drop:20261028_1200', 'drop:20261028_1202']);
  assert.strictEqual(r.removed.rounds, 2, '必须靠第二轮才删干净');
  assert.strictEqual(r.verified.uploadsEmpty, true);
  assert.ok(base);
});

test('三轮都清不干净：拒绝回执，把残留名字报出来（不许说"已清空"）', async () => {
  const m = createMaintenance({
    listBatches: async () => [{ name: '20261028_1200', count: 1, size: 1 }],
    dropBatch: async () => {},
    clearStaging: async () => ({ batches: 0, bytes: 0 }),
    purgeTransfer: async () => ({ sessions: 0, bytes: 0 }),
    downloadTotal: () => 0,
  });
  await assert.rejects(() => m.wipe({ confirm: WIPE_CONFIRM }), (err) => {
    assert.strictEqual(err.status, 409);
    assert.match(err.message, /20261028_1200/);
    return true;
  });
});
