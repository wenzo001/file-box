// 下载能力阶梯：同样的文件，各端走不同方式，但都要能下完。
const { test, before } = require('node:test');
const assert = require('node:assert');
let cap;
before(async () => { cap = await import('../web/src/lib/capability.mjs'); });

const MB = 1024 * 1024;

test('有可写 OPFS：无条件走磁盘（单文件与打包都不设上限）', () => {
  for (const kind of ['file', 'zip']) {
    const r = cap.pickTier({ kind, opfs: true, bytes: 700 * MB, capBytes: 50 * MB });
    assert.strictEqual(r.tier, 'disk', `${kind} 有 OPFS 就该走磁盘`);
    assert.ok(r.reason);
  }
});

test('没有 OPFS：小文件进内存，超上限的单文件直接给话术，超上限的打包降级成逐个文件', () => {
  const small = cap.pickTier({ kind: 'file', opfs: false, bytes: 10 * MB, capBytes: 50 * MB });
  assert.strictEqual(small.tier, 'memory');

  const big = cap.pickTier({ kind: 'file', opfs: false, bytes: 700 * MB, capBytes: 50 * MB });
  assert.strictEqual(big.tier, 'memory', '单文件没有更低的一档：仍标 memory，由调用方按话术拒掉');

  const bigZip = cap.pickTier({ kind: 'zip', opfs: false, bytes: 700 * MB, capBytes: 50 * MB });
  assert.strictEqual(bigZip.tier, 'per-file', '大包在无 OPFS 的端上要降级成逐个文件，而不是整包失败');
  assert.ok(/逐个文件/.test(bigZip.reason));
});

test('大小未知（bytes=0）时不许误判成"超限"', () => {
  const r = cap.pickTier({ kind: 'zip', opfs: false, bytes: 0, capBytes: 50 * MB });
  assert.strictEqual(r.tier, 'memory');
});

test('打包总量：有清单用明文，没清单（旧文件）退回密文，别算成 0', () => {
  const a = cap.zipBytes([
    { path: 'a', plainSize: 100 },
    { path: 'b', cipherSize: 70 },
    { path: 'd/', dir: true, cipherSize: 999 },
  ]);
  assert.strictEqual(a, 170);
  assert.strictEqual(cap.zipBytes([]), 0);
});

test('标签只有一处来源', () => {
  assert.strictEqual(cap.tierLabel('disk'), '磁盘流式');
  assert.strictEqual(cap.tierLabel('per-file'), '逐个文件');
  assert.strictEqual(cap.tierLabel('memory'), '内存（有上限）');
});
