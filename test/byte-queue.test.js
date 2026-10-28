// 按块读流的队列：正确性 + "缓冲有界"（这一条才是旧实现的病灶）。
// 旧实现每来一个网络分片就把整段已读数据重新拷一遍，4MB 块 / 64KB 分片放大 32 倍。
import { test } from 'node:test';
import assert from 'node:assert';
import { queueOf } from '../web/src/lib/byte-queue.mjs';

/** 把一串 Uint8Array 包成 ReadableStream */
function streamOf(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      controller.enqueue(chunks[i++]);
    },
  });
}

const bytes = (n, seed = 7) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 255;
  return a;
};

test('跨分片拼出恰好一块，内容逐字节对得上', async () => {
  const all = bytes(100000);
  const chunks = [];
  for (let off = 0; off < all.length; off += 1000) chunks.push(all.subarray(off, Math.min(off + 1000, all.length)));
  const q = queueOf(streamOf(chunks));
  for (let off = 0; off < all.length; off += 1500) {
    const want = Math.min(1500, all.length - off);
    const got = await q.take(want);
    assert.strictEqual(got.length, want);
    assert.deepStrictEqual(Buffer.from(got), Buffer.from(all.subarray(off, off + want)), `偏移 ${off} 处内容不对`);
  }
});

test('缓冲有界：4MB 块配 64KB 分片，每取完一块手上只留 <1 个分片', async () => {
  const MB = 1024 * 1024;
  const CHUNK = 64 * 1024;
  const BLOCK = 4 * MB;
  const total = 4 * BLOCK;
  const chunks = [];
  for (let off = 0; off < total; off += CHUNK) chunks.push(new Uint8Array(CHUNK).fill((off / CHUNK) & 255));
  const q = queueOf(streamOf(chunks));
  let taken = 0;
  while (taken < total) {
    const block = await q.take(BLOCK);
    taken += block.length;
    assert.ok(q.buffered < CHUNK * 2, `取完一块后还留着 ${q.buffered} 字节（应 <${CHUNK * 2}）——内部又把整段攒起来了`);
  }
  assert.strictEqual(taken, total);
});

test('流提前结束：抛"数据不完整"，不是悄悄返回半块', async () => {
  const q = queueOf(streamOf([bytes(100)]));
  const half = await q.take(100);
  assert.strictEqual(half.length, 100);
  await assert.rejects(() => q.take(50), /数据不完整/);
});
