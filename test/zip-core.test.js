// 打包下载的流式核心：边解密边写 sink，产物是合法 zip（用真 fflate 解回来核对）。
const { test, before } = require('node:test');
const assert = require('node:assert');
require('../public/crypto.js');
globalThis.FBCrypto._test.setEngine('js');

const MB = 1024 * 1024;
let core, fflate;

before(async () => {
  core = await import('../web/src/lib/zip-core.mjs');
  fflate = await import('fflate');
});

/** 造一个多块的密文 Blob（与文件真实格式一致：一串加密块） */
async function cipherOf(buf, block = 512 * 1024) {
  const parts = [];
  for (let off = 0; off < buf.length; off += block) {
    parts.push(Buffer.from(await globalThis.FBCrypto.encryptBytes(new Uint8Array(buf.subarray(off, off + block)))));
  }
  return new Blob([Buffer.concat(parts)]);
}

const bytes = (n, seed) => {
  const a = Buffer.alloc(n);
  for (let i = 0; i < n; i++) a[i] = (i * 17 + seed) & 255;
  return a;
};

test('流式打包：两个文件边解密边写 sink，产物能被标准 unzip 解开且内容一致', async () => {
  const a = bytes(700 * 1024, 3);
  const b = bytes(1200 * 1024, 9);
  const files = { '甲/a.bin': a, '乙/b.bin': b };
  const writes = [];
  const chunks = [];
  let sinkOpen = true;
  const sink = {
    write: async (u8) => { assert.ok(sinkOpen, '写进了已关闭的 sink'); writes.push(u8.length); chunks.push(Buffer.from(u8)); },
    close: async () => { sinkOpen = false; },
  };
  const progress = [];
  const r = await core.createZipJob(
    [
      { path: '甲/', dir: true },
      { path: '甲/a.bin', plainSize: a.length, key: '甲/a.bin' },
      { path: '乙/b.bin', plainSize: b.length, key: '乙/b.bin' },
    ],
    {
      sink,
      getCipher: async (item) => cipherOf(files[item.key]),
      decryptBytes: globalThis.FBCrypto.decryptBytes,
      onProgress: (p) => progress.push(p),
    },
  ).run({});

  assert.strictEqual(r.blob, null, '有 sink 时不该再留一份内存 zip');
  assert.strictEqual(sinkOpen, false, '结束后 sink 必须关掉');
  assert.ok(writes.length >= 3, `输出应该分多次写（现在 ${writes.length} 次）`);
  assert.ok(Math.max(...writes) <= 2 * MB, `单次写 ${Math.max(...writes)} 字节：块太大`);

  const unzipped = fflate.unzipSync(new Uint8Array(Buffer.concat(chunks)));
  assert.deepStrictEqual(Buffer.from(unzipped['甲/a.bin']), a);
  assert.deepStrictEqual(Buffer.from(unzipped['乙/b.bin']), b);
  assert.ok(progress.some((p) => p.received === a.length + b.length), `进度要到总量：${JSON.stringify(progress.slice(-2))}`);
});

test('没有 sink：回退到内存 parts，仍返回合法 zip（旧行为要保住）', async () => {
  const a = bytes(300 * 1024, 5);
  const r = await core.createZipJob(
    [{ path: 'one.bin', plainSize: a.length }],
    { getCipher: async () => cipherOf(a), decryptBytes: globalThis.FBCrypto.decryptBytes },
  ).run({});
  assert.ok(r.blob instanceof Blob, '没有 sink 时必须给 Blob');
  const unzipped = fflate.unzipSync(new Uint8Array(await r.blob.arrayBuffer()));
  assert.deepStrictEqual(Buffer.from(unzipped['one.bin']), a);
});

test('重名与非法路径：同名加序号、.. 与绝对路径被剥掉', async () => {
  const a = bytes(1024, 1);
  const r = await core.createZipJob(
    [
      { path: '../../etc/passwd', plainSize: a.length },
      { path: '/abs/x.bin', plainSize: a.length },
      { path: 'dup.bin', plainSize: a.length },
      { path: 'dup.bin', plainSize: a.length },
    ],
    { getCipher: async () => cipherOf(a), decryptBytes: globalThis.FBCrypto.decryptBytes },
  ).run({});
  const names = Object.keys(fflate.unzipSync(new Uint8Array(await r.blob.arrayBuffer()))).sort();
  assert.deepStrictEqual(names, ['abs/x.bin', 'dup (2).bin', 'dup.bin', 'etc/passwd']);
});
