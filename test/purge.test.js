// 立即销毁并自证：用户点"忘记/取消并销毁"之后，要能确认服务器上这一单的密文真的没了。
// 这些是"真跑"的测试：真 server、真磁盘、真 HTTP，删完还要再查一次目录与状态码。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startServer, jget } = require('./helpers');

let srv;
before(async () => { srv = await startServer({ XFER_TTL_MINUTES: '30', XFER_END_KEEP_MS: '300', XFER_CREATE_LIMIT: '1000' }); });
after(async () => { await srv.stop(); });

const ABC = 'abcdefghjkmnpqrstuvwxyz123456789';
const randSid = () => Array.from({ length: 8 }, () => ABC[crypto.randomInt(ABC.length)]).join('');
const randProof = () => crypto.randomBytes(32).toString('hex');
const dirOf = (sid) => path.join(srv.dir, 'transfer', sid);

async function create(over = {}) {
  const sid = randSid();
  const proof = randProof();
  const r = await fetch(`${srv.base}/api/xfer/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, proof, frames: 4, totalBytes: 4096, ...over }),
  });
  assert.strictEqual(r.status, 200, `create 失败：${r.status}`);
  const body = await r.json();
  return { sid, proof, token: body.token };
}

async function putSeg(sid, token, i, bytes) {
  const r = await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=${i}`, {
    method: 'PUT',
    headers: { 'X-Xfer-Sender': token, 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(bytes, 7),
  });
  return r.status;
}

async function purge(sid, headers) {
  const r = await fetch(`${srv.base}/api/xfer/purge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ sid }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('purge：发送方凭证一发就立刻删干净，并报出清掉了几块；再发一次仍然 gone', async () => {
  const { sid, token } = await create();
  assert.strictEqual(await putSeg(sid, token, 0, 1024), 200);
  assert.strictEqual(await putSeg(sid, token, 2, 2048), 200);
  assert.ok(fs.existsSync(dirOf(sid)), '前置：密文应该先落盘');

  const r = await purge(sid, { 'X-Xfer-Sender': token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.gone, true, '服务器必须回"真的没了"，不能只说 ok');
  assert.deepStrictEqual(r.body.removed, { segments: 2, bytes: 3072 }, `清掉的账目不对：${JSON.stringify(r.body.removed)}`);
  assert.ok(!fs.existsSync(dirOf(sid)), '删完目录必须不在（这一句是用户看到的那句"已清空"的依据）');

  const st = await fetch(`${srv.base}/api/xfer/state?sid=${sid}`, { headers: { 'X-Xfer-Sender': token } });
  assert.strictEqual(st.status, 404, '销毁后状态查询必须是 404，客户端用它做二次核对');

  const again = await purge(sid, { 'X-Xfer-Sender': token });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.gone, true, '幂等：已经没了也要能确认没了，不能报错让用户以为没清');
  assert.strictEqual(again.body.removed.segments, 0);
});

test('purge：接收方 proof 也能销毁；错凭证 403 且密文原样还在', async () => {
  const { sid, proof, token } = await create();
  const jr = await fetch(`${srv.base}/api/xfer/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, proof }),
  });
  assert.strictEqual(jr.status, 200, '前置：配对要成功');
  assert.strictEqual(await putSeg(sid, token, 0, 512), 200);

  const bad = await purge(sid, { 'X-Xfer-Sender': crypto.randomBytes(16).toString('hex') });
  assert.strictEqual(bad.status, 403);
  assert.ok(fs.existsSync(dirOf(sid)), '凭证不对时绝不能删别人的密文');

  const r = await purge(sid, { 'X-Xfer-Proof': proof });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.gone, true);
  assert.deepStrictEqual(r.body.removed, { segments: 1, bytes: 512 });
  assert.ok(!fs.existsSync(dirOf(sid)));
});

test('销毁之后才到达的 PUT 不许把目录写回来', async () => {
  const { sid, token } = await create();
  // 用裸 http 分两次写请求体：让服务端的 body 还没凑齐时先销毁，模拟"删除时那一发还在飞"
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: srv.port, method: 'PUT',
      path: `/api/xfer/seg?sid=${sid}&i=1`,
      headers: { 'X-Xfer-Sender': token, 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(Buffer.alloc(1024, 9));
    setTimeout(async () => {
      const r = await purge(sid, { 'X-Xfer-Sender': token });
      assert.strictEqual(r.body.gone, true, '前置：销毁要成功');
      req.end(Buffer.alloc(3072, 9));
    }, 80);
  });
  assert.strictEqual(status, 404, '迟到的写入必须被拒，不能假装收下');
  assert.ok(!fs.existsSync(dirOf(sid)), '迟到的写入不许把已删除的目录重建出来');
});

test('孤儿密文目录：没有活会话时下一次 sweep 会把它回收', async () => {
  const orphan = randSid();
  fs.mkdirSync(path.join(dirOf(orphan)), { recursive: true });
  fs.writeFileSync(path.join(dirOf(orphan), 'seg-0.bin'), Buffer.alloc(256, 3));
  assert.ok(fs.existsSync(dirOf(orphan)), '前置：孤儿目录先造出来');

  // 任何一次 create 都会先 sweep（这里只借它触发一次），孤儿目录必须被清掉
  await create();
  assert.ok(!fs.existsSync(dirOf(orphan)), '不在内存里的 SID 目录不许留着密文');
});

test('没凭证的 purge 与非法 sid 都不碰磁盘', async () => {
  const { sid, token } = await create();
  assert.strictEqual(await putSeg(sid, token, 0, 256), 200);
  const none = await purge(sid, {});
  assert.strictEqual(none.status, 403);
  assert.ok(fs.existsSync(dirOf(sid)));
  const badSid = await jget(`${srv.base}/api/xfer/purge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: 'x' }),
  });
  assert.strictEqual(badSid.status, 400, '非法 sid 必须按参数错误拒掉，不能拿它拼路径');
});

test('keep：页面开着就给会话续期，但整单有硬上限（到点照样清）', async () => {
  const s = await startServer({ XFER_TTL_MINUTES: '1', XFER_MAX_LIFE_MINUTES: '30', XFER_CREATE_LIMIT: '1000' }, null, 77);
  try {
    const { sid, token } = await (async () => {
      const sid2 = randSid(); const proof = randProof();
      const r = await fetch(`${s.base}/api/xfer/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: sid2, proof, frames: 4, totalBytes: 4096 }),
      });
      return { sid: sid2, token: (await r.json()).token };
    })();
    const keep = async () => (await fetch(`${s.base}/api/xfer/keep`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xfer-Sender': token },
      body: JSON.stringify({ sid }),
    })).json();
    const a = await keep();
    assert.strictEqual(a.ok, true);
    await new Promise((r) => setTimeout(r, 1100));
    const b = await keep();
    assert.ok(b.expiresAt > a.expiresAt, `续期要把窗口往后推（${a.expiresAt} → ${b.expiresAt}）`);
    assert.ok(b.expiresAt - (b.capAt - 30 * 60 * 1000) <= 30 * 60 * 1000 + 5000, '续期不许超过整单上限');
  } finally { await s.stop(); }
});

test('keep：上限真的夹得住（上限比 TTL 还短时，一建会话就按上限算，续期也推不动）', async () => {
  const s = await startServer({ XFER_TTL_MINUTES: '30', XFER_MAX_LIFE_MINUTES: '0.05', XFER_CREATE_LIMIT: '1000' }, null, 78);
  try {
    const sid = randSid(); const proof = randProof();
    const cr = await (await fetch(`${s.base}/api/xfer/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, proof, frames: 4, totalBytes: 4096 }),
    })).json();
    assert.ok(cr.expiresAt - Date.now() <= 4000, `创建时就要按整单上限封顶（现在还剩 ${cr.expiresAt - Date.now()}ms）`);
    const j = await (await fetch(`${s.base}/api/xfer/keep`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xfer-Sender': cr.token },
      body: JSON.stringify({ sid }),
    })).json();
    assert.ok(j.expiresAt - Date.now() <= 4000, '续期也不许越过上限');
    assert.ok(j.expiresAt <= j.capAt + 1000, 'expiresAt 不许超过 capAt');
  } finally { await s.stop(); }
});
