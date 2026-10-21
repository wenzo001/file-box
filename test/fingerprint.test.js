// 指纹（逐块 SHA-256 → 链摘要）是 2GB 传输前最重的一段本地活。
// 这条测试守三件事：
//   ① 把读盘批量化之后摘要必须逐字节不变（接收端按同一算法验完整性）；
//   ② 把文件切成几段并行算，拼回来的链必须与整份一遍算出来的完全相同 —— 切点落在 128KiB 边界上
//      这件事是"并行"能成立的唯一理由，只要错一位，接收端就会判"内容被人动过"；
//   ③ 同一份数据新旧两种读法的耗时一起打出来，别拿"感觉快了"当证据。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../public/xfer-proto.js');

const B = P.PLAIN_BLOCK;

function loadWorker() {
  const sandbox = {
    console, Date, Math, JSON, Promise, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, setTimeout, clearTimeout,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...names) => names.forEach((n) =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', n), 'utf8'), ctx, { filename: n }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'xfer-worker.js'), 'utf8'), ctx, { filename: 'xfer-worker.js' });
  return sandbox;
}

const worker = loadWorker();

/** 跑一次 worker 的 fingerprint，把"块摘要数组"拿回来（链哈希由引擎侧拼，worker 只负责逐块摘要） */
function runFingerprint(file, from, to) {
  return new Promise((resolve, reject) => {
    worker.postMessage = (msg) => {
      if (msg.error) reject(new Error(msg.error));
      else if (msg.digests) resolve(msg.digests);
    };
    worker.onmessage({ data: { id: 1, op: 'fingerprint', file, from, to } });
  });
}

/** 块摘要 → 链摘要。空文件也有"一块"（与 planLayout 的 0 字节 1 块对齐）。 */
async function chainHash(digests) {
  const list = digests.length ? digests : [await P.sha256(new Uint8Array(0))];
  return P.hex(await P.sha256(P.cat(...list)));
}

async function reference(bytes) {
  const chain = [];
  for (let off = 0; off < bytes.length; off += B) chain.push(await P.sha256(bytes.subarray(off, Math.min(bytes.length, off + B))));
  return chainHash(chain);
}

/** 旧读法：每 128KiB 一次 slice().arrayBuffer() —— 只用来量"批量读"省了多少，不参与断言 */
async function oldFingerprint(file) {
  const chain = [];
  for (let off = 0; off < file.size; off += B) {
    chain.push(await P.sha256(new Uint8Array(await file.slice(off, Math.min(file.size, off + B)).arrayBuffer())));
  }
  return chainHash(chain);
}

function makeFile(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7 + (i >> 13)) & 255;
  return new File([bytes], 'f.bin', { type: 'application/octet-stream' });
}

test('指纹：批量读盘之后摘要与逐块参考实现逐字节一致（含块边界）', async () => {
  for (const size of [0, 1, B - 1, B, B + 1, 2 * B, 8 * 1024 * 1024 + 12345]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7 + (i >> 13)) & 255;
    const got = await chainHash(await runFingerprint(makeFile(size)));
    const want = await reference(bytes);
    assert.strictEqual(got, want, `大小 ${size} 的摘要变了 —— 接收端的完整性校验会全线对不上`);
  }
});

test('指纹：切成 n 段并行算，拼回来的链与整份一遍算的完全相同（切点必须落在块边界）', async () => {
  // 特意挑几个"切不整齐"的大小：多一块、少一块、正好整除、块中间
  for (const [size, parts] of [[3 * B, 3], [4 * B + 17, 3], [8 * B, 4], [1, 4], [0, 4]]) {
    const file = makeFile(size);
    const whole = await runFingerprint(file);
    const blocks = Math.max(1, Math.ceil(size / B));
    const per = Math.ceil(blocks / parts);
    const ranges = [];
    for (let i = 0; i < parts; i++) {
      const a = i * per;
      const b = Math.min(blocks, (i + 1) * per);
      if (a >= b) break;
      ranges.push([a * B, Math.min(size, b * B)]);
    }
    const got = [];
    for (const [from, to] of ranges) got.push(...await runFingerprint(file, from, to));
    assert.strictEqual(got.length, whole.length, `size=${size} 段数 ${ranges.length}：块数对不上（${got.length} vs ${whole.length}）`);
    for (let i = 0; i < whole.length; i++) {
      assert.strictEqual(P.hex(got[i]), P.hex(whole[i]), `size=${size}：第 ${i} 块的摘要不一致 —— 切点没落在块边界上`);
    }
  }
});

test('指纹：64MB 的实测耗时（新批量读 vs 旧逐块读）', async () => {
  const size = 64 * 1024 * 1024;
  const file = makeFile(size);
  const t0 = Date.now();
  const a = await chainHash(await runFingerprint(file));
  const tNew = Date.now() - t0;
  const t1 = Date.now();
  const b = await oldFingerprint(file);
  const tOld = Date.now() - t1;
  assert.strictEqual(a, b, '两种读法的摘要必须一样');
  console.log(`[指纹] 64MB：批量读 ${tNew}ms（${(size / 1024 / 1024 / (tNew / 1000)).toFixed(1)}MB/s）`
    + ` vs 逐块读 ${tOld}ms（${(size / 1024 / 1024 / (tOld / 1000)).toFixed(1)}MB/s）`);
});
