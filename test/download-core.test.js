// 下载核心：断线续传 / 卡住重连 / 进度 / 能力上限 / 解密写盘。
// 网络与存储都注入成假的，crypto 用真的（public/crypto.js 的纯 JS 引擎），
// 这样"第一次只给 40% 再断"这种现场可以精确复现。
const { test, before } = require('node:test');
const assert = require('node:assert');
require('../public/crypto.js');

globalThis.FBCrypto._test.setEngine('js');
const MB = 1024 * 1024;
let core;

before(async () => { core = await import('../web/src/lib/download-core.mjs'); });

/** 假存储：按写入顺序拼起来 */
function fakeStore() {
  let chunks = [];
  let writes = [];
  return {
    get size() { return chunks.reduce((s, c) => s + c.length, 0); },
    bytes: () => Buffer.concat(chunks),
    writes: () => writes,
    api: {
      size: async () => chunks.reduce((s, c) => s + c.length, 0),
      clear: async () => { chunks = []; writes = []; },
      openWriter: async ({ append }) => {
        if (!append) chunks = [];
        return {
          write: async (u8) => { writes.push(u8.length); chunks.push(Buffer.from(u8)); },
          close: async () => {},
        };
      },
    },
  };
}

function streamResponse(buf, status = 200, chunkSize = 64 * 1024) {
  let off = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (off >= buf.length) return c.close();
      c.enqueue(new Uint8Array(buf.subarray(off, off + chunkSize)));
      off += chunkSize;
    },
  });
  return new Response(stream, { status });
}

const payload = bytes(300 * 1024);
function bytes(n, seed = 3) {
  const a = Buffer.alloc(n);
  for (let i = 0; i < n; i++) a[i] = (i * 7 + seed) & 255;
  return a;
}

test('正常下载：一片片写进 store，进度递增，字节完整', async () => {
  const store = fakeStore();
  const updates = [];
  const fetchImpl = async () => streamResponse(payload, 200, 32 * 1024);
  const r = await core.transferToStore({
    url: '/x', store: store.api, total: payload.length, fetchImpl,
    onUpdate: (p) => updates.push(p),
  });
  assert.strictEqual(r.received, payload.length);
  assert.deepStrictEqual(store.bytes(), payload);
  assert.ok(updates.length >= 9, `进度回调太少：${updates.length}`);
  assert.ok(updates.every((u) => u.phase === 'download'));
  for (let i = 1; i < updates.length; i++) assert.ok(updates[i].received > updates[i - 1].received, '进度必须递增');
});

test('中途断线：自动带上 Range 从已存字节续，最终字节完整', async () => {
  const store = fakeStore();
  const seen = [];
  let calls = 0;
  const cut = Math.floor(payload.length * 0.4);
  const fetchImpl = async (url, opt = {}) => {
    calls++;
    seen.push(opt.headers || {});
    const start = opt.headers && opt.headers.Range ? Number(/bytes=(\d+)-/.exec(opt.headers.Range)[1]) : 0;
    if (calls === 1) return streamResponse(payload.subarray(0, cut), 200, 16 * 1024); // 只给 40% 就断
    return streamResponse(payload.subarray(start), start ? 206 : 200, 16 * 1024);
  };
  // 重试上界放在睡眠里：判据写错时红在断言上，而不是挂成无限重试（真跑过一次 428 秒）
  const r = await core.transferToStore({
    url: '/x', store: store.api, total: payload.length, fetchImpl,
    sleep: async () => { if (calls > 3) throw new Error('重试次数过多'); },
  });
  assert.strictEqual(calls, 2, `应该重试一次，实际请求了 ${calls} 次`);
  assert.strictEqual(seen[0].Range, undefined, '第一次不该带 Range');
  assert.strictEqual(seen[1].Range, `bytes=${cut}-`, '续传必须带上已存字节的 Range（否则就是从头上再下一遍）');
  assert.strictEqual(r.received, payload.length);
  assert.deepStrictEqual(store.bytes(), payload, '拼起来必须与原文一致（不许重复一段）');
});

test('卡住不动（无字节）：按空闲超时重连，退避是指数的', async () => {
  const store = fakeStore();
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls <= 3) return new Response(new ReadableStream({ pull() { /* 永不产出 */ } }), { status: 200 });
    return streamResponse(payload, 200);
  };
  const r = await core.transferToStore({
    url: '/x', store: store.api, total: payload.length, fetchImpl,
    idleMs: 20,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.strictEqual(r.received, payload.length);
  assert.strictEqual(calls, 4, `卡住三次应该重连三次，实际请求 ${calls} 次`);
  assert.deepStrictEqual(sleeps.slice(0, 3), [1000, 2000, 4000], `退避不对：${sleeps.join(',')}`);
});

test('404 不重试：直接失败并带上状态码；已经完整的 416 视为完成', async () => {
  const store = fakeStore();
  let calls = 0;
  await assert.rejects(
    () => core.transferToStore({ url: '/x', store: store.api, total: 10, fetchImpl: async () => { calls++; return new Response('no', { status: 404 }); } }),
    /404/,
  );
  assert.strictEqual(calls, 1, '404 不该重试');

  const store2 = fakeStore();
  await store2.api.openWriter({ append: false }).then((w) => w.close());
  await store2.api.openWriter({ append: true }).then((w) => w.write(payload));
  let calls2 = 0;
  const r = await core.transferToStore({
    url: '/x', store: store2.api, total: payload.length,
    fetchImpl: async () => { calls2++; return new Response(null, { status: 416 }); },
  });
  assert.strictEqual(calls2, 0, '已经完整时不该再发请求');
  assert.strictEqual(r.received, payload.length);
});

test('取消：立刻停，不再发请求', async () => {
  const store = fakeStore();
  const ctrl = new AbortController();
  let calls = 0;
  ctrl.abort();
  await assert.rejects(
    () => core.transferToStore({ url: '/x', store: store.api, total: 10, signal: ctrl.signal, fetchImpl: async () => { calls++; return streamResponse(payload); } }),
    (err) => err.name === 'AbortError' || /取消/.test(err.message),
  );
  assert.strictEqual(calls, 0);
});

test('能力上限：没有 OPFS 时按上限给话术（默认 512MB），并指名真正的出路是 HTTPS', () => {
  assert.strictEqual(core.memoryCapProblem({ hasOpfs: true, size: 700 * MB }), null, '有 OPFS 就不该有上限');
  assert.strictEqual(core.memoryCapProblem({ hasOpfs: false, size: 10 * MB }), null);
  const msg = core.memoryCapProblem({ hasOpfs: false, size: 600 * MB });
  assert.ok(msg && /本地存储/.test(msg), `没给出可读的理由：${msg}`);
  assert.ok(/512MB/.test(msg), `话术里要写清上限：${msg}`);
  // 用户看到这句话时最需要的是"那我该怎么办"：地址不安全 + HTTPS 入口必须写在里面
  assert.ok(/HTTPS/.test(msg), `话术没给出路（HTTPS 入口）：${msg}`);
  assert.ok(/无痕|HTTP/.test(msg), `话术没点明是哪一类页面：${msg}`);
  // 上限可以由部署下调，判据跟着传进来的值走
  assert.strictEqual(core.memoryCapProblem({ hasOpfs: false, size: 300 * MB, capBytes: 300 * MB }), null, '部署把上限放宽到 300MB 时，300MB 就该放行');
  assert.ok(core.memoryCapProblem({ hasOpfs: false, size: 301 * MB, capBytes: 300 * MB }), '超一点点就该挡');
});

test('解密写盘：按块写进明文 store，内容一致、进度到总量、长度不符要报错', async () => {
  const plain = bytes(2 * MB, 11);
  // 文件真实格式是"一串加密块"，不是单块：按 512KB 一块拼出来，才测得到"一块一块写"
  const BLOCK = 512 * 1024;
  const ciphers = [];
  for (let off = 0; off < plain.length; off += BLOCK) {
    ciphers.push(await globalThis.FBCrypto.encryptBytes(new Uint8Array(plain.subarray(off, off + BLOCK))));
  }
  const cipher = Buffer.concat(ciphers);
  const cipherFile = new Blob([cipher]);
  const store = fakeStore();
  const progress = [];
  const r = await core.decryptToStore({
    cipherFile, plainStore: store.api, decryptBytes: globalThis.FBCrypto.decryptBytes,
    plainSize: plain.length, onProgress: (p) => progress.push(p),
  });
  assert.strictEqual(r.size, plain.length);
  assert.deepStrictEqual(store.bytes(), plain, '解出来的明文与原文不一致');
  const writes = store.writes();
  assert.ok(writes.length >= 2, `明文要一块一块写进 store（现在写了 ${writes.length} 次，像是整文件攒完再写）`);
  assert.ok(Math.max(...writes) <= 1024 * 1024, `单次写入 ${Math.max(...writes)} 字节：块太大，内存还是会顶上去`);
  assert.ok(progress.length >= 1);
  assert.strictEqual(progress[progress.length - 1].decrypted, plain.length);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].decrypted > progress[i - 1].decrypted);

  await assert.rejects(
    () => core.decryptToStore({
      cipherFile, plainStore: fakeStore().api,
      decryptBytes: globalThis.FBCrypto.decryptBytes, plainSize: plain.length + 1,
    }),
    /长度与清单不符/,
  );

  // 产品里明文是向上补到 64KiB 的：清单 size 比解密长度小，必须**裁掉填充**而不是报错
  const real = bytes(11, 4);
  const padded = Buffer.alloc(64 * 1024);
  real.copy(padded);
  const padCipher = new Blob([Buffer.from(await globalThis.FBCrypto.encryptBytes(new Uint8Array(padded)))]);
  const trimmed = fakeStore();
  const tr = await core.decryptToStore({
    cipherFile: padCipher, plainStore: trimmed.api,
    decryptBytes: globalThis.FBCrypto.decryptBytes, plainSize: real.length,
  });
  assert.strictEqual(tr.size, real.length, `补到 64KiB 的文件要裁回真实大小（现在 ${tr.size}）`);
  assert.deepStrictEqual(trimmed.bytes(), real, '裁出来的内容不对');
});
