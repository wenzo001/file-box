// 这一轮针对"2GB 那一单断了"的三处硬伤：局域网直连、中转配额、以及"我到底能不能确认服务器清干净了"。
// 全部真跑：真 server、真磁盘、真 UDP、真 HTTP。判据打在**服务器回给用户的那几个字段**上，
// 不打在界面文案上 —— 用户要的是"能核对"，不是"看起来像在核对"。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');
const { createStunServer, respond } = require('../lib/stun');

const ABC = 'abcdefghjkmnpqrstuvwxyz123456789';
const randSid = () => Array.from({ length: 8 }, () => ABC[crypto.randomInt(ABC.length)]).join('');
const randProof = () => crypto.randomBytes(32).toString('hex');
const MAGIC = 0x2112a442;

// ---------------- STUN：协议级 ----------------
function bindingRequest() {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);       // Binding Request
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(MAGIC, 4);
  crypto.randomBytes(12).copy(b, 8); // transaction id
  return b;
}

/** 把响应里的 XOR-MAPPED-ADDRESS 解回来 —— 只有解回来对上源地址，才算"服务器真告诉了它自己的地址" */
function decodeXorMapped(res) {
  assert.ok(Buffer.isBuffer(res) && res.length >= 20, '响应太短');
  assert.strictEqual(res.readUInt32BE(4), MAGIC, 'magic cookie 不对');
  assert.strictEqual(res.readUInt16BE(0), 0x0101, '不是 Binding Success Response');
  const len = res.readUInt16BE(2);
  assert.strictEqual(20 + len, res.length, '消息长度字段与实际不符');
  let off = 20;
  while (off + 4 <= 20 + len) {
    const type = res.readUInt16BE(off);
    const alen = res.readUInt16BE(off + 2);
    if (type === 0x0020) {
      const family = res[off + 5];
      const port = res.readUInt16BE(off + 6) ^ (MAGIC >>> 16);
      const addr = Buffer.from(res.subarray(off + 8, off + 8 + (family === 0x02 ? 16 : 4)));
      for (let i = 0; i < addr.length; i++) addr[i] ^= (MAGIC >>> (24 - (i % 4) * 8)) & 0xff;
      return { family, port, address: [...addr].join('.') };
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  return null;
}

test('STUN：把请求方的真实源地址 xor 回给他（这是局域网直连能成立的前提）', () => {
  const req = bindingRequest();
  const res = respond(req, { address: '192.168.1.23', port: 54321, family: 'IPv4' });
  assert.ok(res, '合法 Binding 请求必须有响应');
  assert.deepStrictEqual(Buffer.from(res.subarray(8, 20)), Buffer.from(req.subarray(8, 20)), 'transaction id 必须原样带回');
  assert.deepStrictEqual(decodeXorMapped(res), { family: 1, port: 54321, address: '192.168.1.23' });
});

test('STUN：非 STUN 包与非 Binding 消息一律不回应（不能被当成放大器）', () => {
  assert.strictEqual(respond(Buffer.from('hello, this is not stun'), { address: '10.0.0.2', port: 1 }), null);
  const notBinding = bindingRequest();
  notBinding.writeUInt16BE(0x0003, 0); // Allocate（TURN 的）不是我们的活
  assert.strictEqual(respond(notBinding, { address: '10.0.0.2', port: 1 }), null);
  // 头两位不为 0（RFC 5389 用来区分复用同一端口的其他协议）
  const bad = bindingRequest();
  bad[0] |= 0x40;
  assert.strictEqual(respond(bad, { address: '10.0.0.2', port: 1 }), null);
});

test('STUN：真 UDP 往返一次，拿到的是本机地址与真实源端口', async () => {
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    const p = 39000 + crypto.randomInt(2000);
    const s = createStunServer({ port: p, log: () => {} });
    s.start();
    await new Promise((r) => setTimeout(r, 120));
    if (!s.ready) { s.stop(); continue; }
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    const localPort = sock.address().port;
    const reply = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(null), 1500);
      sock.once('message', (msg) => { clearTimeout(to); resolve(msg); });
      sock.send(bindingRequest(), p, '127.0.0.1', () => {});
    });
    sock.close();
    s.stop();
    assert.ok(reply, 'STUN 服务器必须在 1.5 秒内回应');
    const mapped = decodeXorMapped(reply);
    assert.strictEqual(mapped.address, '127.0.0.1', '应该是它看到的源地址');
    assert.strictEqual(mapped.port, localPort, '应该是它看到的源端口（不是 3478）');
    ok = true;
  }
  assert.ok(ok, '6 次都没抢到可用端口，环境有问题');
});

// ---------------- 真服务器上的三条 ----------------
let srv;
before(async () => { srv = await startServer({ XFER_TTL_MINUTES: '30', XFER_CREATE_LIMIT: '1000', XFER_PROBE_LIMIT: '1000' }); });
after(async () => { await srv.stop(); });

async function createOn(base, over = {}) {
  const sid = randSid();
  const proof = randProof();
  const r = await fetch(`${base}/api/xfer/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, proof, frames: 4, totalBytes: 4096, ...over }),
  });
  const body = await r.json().catch(() => ({})); // 体只能读一次：先解析再断言
  assert.strictEqual(r.status, 200, `create 失败：${r.status} ${JSON.stringify(body)}`);
  return { sid, proof, token: body.token, body };
}
async function putOn(base, sid, token, i, bytes) {
  const r = await fetch(`${base}/api/xfer/seg?sid=${sid}&i=${i}`, {
    method: 'PUT',
    headers: { 'X-Xfer-Sender': token, 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(bytes, 7),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const residue = async (sid) => {
  const r = await fetch(`${srv.base}/api/xfer/residue?sid=${sid}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('残留核验：不需要任何凭据，也能如实报出"还剩几段、多少字节、几时到期"', async () => {
  const { sid, token } = await createOn(srv.base);
  const empty = await residue(sid);
  assert.strictEqual(empty.status, 200);
  assert.strictEqual(empty.body.exists, true, '会话在，账本目录就在');
  assert.strictEqual(empty.body.segments, 0, '还没传任何密文');
  assert.strictEqual(empty.body.bytes, 0);

  assert.strictEqual((await putOn(srv.base, sid, token, 0, 1024)).status, 200);
  assert.strictEqual((await putOn(srv.base, sid, token, 3, 2048)).status, 200);
  const half = await residue(sid);
  assert.strictEqual(half.body.segments, 2);
  assert.strictEqual(half.body.bytes, 3072);
  assert.ok(half.body.expiresAt > Date.now(), '必须能告诉用户"最晚什么时候自己清"');

  // 只回计数，不回内容：这六样之外不该有别的字段（避免以后有人往这里塞密钥或文件名）
  assert.deepStrictEqual(Object.keys(half.body).sort(), ['bytes', 'exists', 'expiresAt', 'segments', 'sid', 'state']);
});

test('残留核验：销毁之后（且**不带凭据**）再查，必须说"什么都没了"', async () => {
  const { sid, token } = await createOn(srv.base);
  assert.strictEqual((await putOn(srv.base, sid, token, 1, 512)).status, 200);
  const p = await fetch(`${srv.base}/api/xfer/purge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xfer-Sender': token },
    body: JSON.stringify({ sid }),
  });
  assert.strictEqual(p.status, 200);
  assert.strictEqual((await p.json()).gone, true);

  const after = await residue(sid);
  assert.strictEqual(after.status, 200, '会话没了也要能查，否则"确认清空"这件事就断了');
  assert.strictEqual(after.body.exists, false);
  assert.strictEqual(after.body.segments, 0);
  assert.strictEqual(after.body.bytes, 0);
  assert.ok(!fs.existsSync(path.join(srv.dir, 'transfer', sid)), '盘上目录必须真的不在');
});

test('残留核验：过期回收之后照样能查到"0"，而不是 404 让用户没法确认', async () => {
  const s2 = await startServer({ XFER_TTL_MINUTES: '0.02', XFER_CREATE_LIMIT: '1000' }, null, 1);
  try {
    const { sid, token } = await createOn(s2.base);
    assert.strictEqual((await putOn(s2.base, sid, token, 0, 256)).status, 200);
    await new Promise((r) => setTimeout(r, 1600)); // TTL 1.2s
    await createOn(s2.base);                        // create 会先 sweep 一次
    const r = await fetch(`${s2.base}/api/xfer/residue?sid=${sid}`).then((x) => x.json());
    assert.strictEqual(r.exists, false, '过期会话的密文必须已被回收');
    assert.strictEqual(r.segments, 0);
    assert.strictEqual(r.bytes, 0);
  } finally {
    await s2.stop();
  }
});

test('残留核验：非法 sid 回 400；返回体里不含任何文件名/路径', async () => {
  assert.strictEqual((await residue('nope')).status, 400);
  const { sid, token } = await createOn(srv.base);
  assert.strictEqual((await putOn(srv.base, sid, token, 0, 64)).status, 200);
  const r = await residue(sid);
  assert.ok(!JSON.stringify(r.body).includes('seg-'), '不该出现任何文件名/路径');
});

// ---------------- 中转配额：2GB 的文件撞 2GB 的墙 ----------------
test('配额：默认值必须比"一个 2GB 的文件"大（否则走中转必定在 2GB 处断）', async () => {
  const cfg = await (await fetch(`${srv.base}/api/xfer/config`)).json();
  assert.ok(cfg.limitBytes >= 4 * 1024 * 1024 * 1024,
    `中转配额默认值太小（${cfg.limitBytes} 字节）：2GB 的文件只要走中转就必定断在 2GB`);
});

test('配额：超预算时 create 就要告诉客户端，413 也要说清"改哪个开关"', async () => {
  const s3 = await startServer({ XFER_LIMIT_GB: '0.001', XFER_CREATE_LIMIT: '1000' }, null, 2); // ≈1MB
  try {
    const { sid, token, body } = await createOn(s3.base, { frames: 40, totalBytes: 40 * 1024 * 1024 });
    assert.strictEqual(body.overBudget, true, '客户端要靠这个字段在开传前就警告，而不是传到一半才停');
    assert.ok(body.limitBytes > 0);

    let last = null;
    for (let i = 0; i < 12 && !last; i++) {
      const r = await putOn(s3.base, sid, token, i, 128 * 1024);
      if (r.status === 413) last = r.body;
    }
    assert.ok(last, '连塞 12 块（1.5MB）必须撞上 1MB 的配额');
    assert.match(last.error, /XFER_LIMIT_GB/, '必须告诉用户改哪个开关');
    assert.match(last.error, /GB/, '必须报出上限与已用量');
  } finally {
    await s3.stop();
  }
});

// ---------------- 内置 STUN 的下发 ----------------
test('配置：STUN_PORT 打开时，config 会用请求自己的 Host 报出内置 STUN 地址', async () => {
  const p = 39600 + crypto.randomInt(300);
  const s4 = await startServer({ STUN_PORT: String(p) }, null, 3);
  try {
    const cfg = await (await fetch(`${s4.base}/api/xfer/config`)).json();
    assert.strictEqual(cfg.stunSelf, true, '内置 STUN 起来了就要如实说');
    assert.ok(cfg.stun.includes(`stun:127.0.0.1:${p}`),
      `按访问地址下发才对，实际 ${JSON.stringify(cfg.stun)}（期望含 stun:127.0.0.1:${p}）`);
  } finally {
    await s4.stop();
  }
});

test('配置：STUN_PORT=0 时不下发（不能广告一个不存在的服务）', async () => {
  const cfg = await (await fetch(`${srv.base}/api/xfer/config`)).json();
  assert.strictEqual(cfg.stunSelf, false);
  assert.deepStrictEqual(cfg.stun, []);
});
