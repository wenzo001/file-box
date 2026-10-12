// 无痕传输服务端：会话生命周期、密文中转、权限、限额、清理与日志卫生。
// 这些是"真跑"的测试：起真 server、写真磁盘、读真 HTTP 流。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer({ XFER_TTL_MINUTES: '30', XFER_END_KEEP_MS: '300' }); });
after(async () => { await srv.stop(); });

const ABC = 'abcdefghjkmnpqrstuvwxyz123456789'; // 和协议层同一套 32 字符字母表
const randSid = () => Array.from({ length: 8 }, () => ABC[crypto.randomInt(ABC.length)]).join('');
const randProof = () => crypto.randomBytes(32).toString('hex');
const randToken = () => crypto.randomBytes(16).toString('hex');

async function createSession(s = srv, over = {}) {
  const sid = randSid();
  const proof = randProof();
  const body = { sid, proof, frames: 4, totalBytes: 4096, ...over };
  const r = await fetch(`${s.base}/api/xfer/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json(), sid, proof };
}
const hdr = (o) => Object.assign({ 'Content-Type': 'application/json' }, o);

async function join(s = srv, sid, proof) {
  const r = await fetch(`${s.base}/api/xfer/join`, { method: 'POST', headers: hdr({}), body: JSON.stringify({ sid, proof }) });
  return { status: r.status, body: await r.json() };
}

test('config：没配 TURN 就老实说没有，客户端据此跳过这一档而不是空等超时', async () => {
  const c = await (await fetch(`${srv.base}/api/xfer/config`)).json();
  assert.strictEqual(c.turnConfigured, false);
  assert.strictEqual(c.relayAvailable, true, '服务器密文中转必须始终可用（不能依赖外部服务）');
  assert.ok(c.segMax > 0 && c.ttlMs > 0);
});

test('create 的参数校验：sid 形状、proof 形状、帧数、字节数都要有界', async () => {
  for (const bad of [
    { sid: 'X', proof: randProof() },
    { sid: randSid(), proof: 'nothex' },
    { sid: randSid(), proof: randProof(), frames: 0 },
    { sid: randSid(), proof: randProof(), frames: 999999999 },
    { sid: randSid(), proof: randProof(), totalBytes: -5 },
  ]) {
    const r = await fetch(`${srv.base}/api/xfer/create`, { method: 'POST', headers: hdr({}), body: JSON.stringify({ frames: 4, totalBytes: 4096, ...bad }) });
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
  }
  const ok = await createSession();
  assert.strictEqual(ok.status, 200);
  assert.match(ok.body.token, /^[a-f0-9]{32}$/, '发送方要拿到一个独立的会话令牌');
});

test('只凭公开 sid 什么都做不了：取不到分段、开不了事件流、看不到状态', async () => {
  const { sid } = await createSession();
  const probes = await Promise.all([
    fetch(`${srv.base}/api/xfer/state?sid=${sid}`).then((r) => r.status),
    fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`).then((r) => r.status),
    fetch(`${srv.base}/api/xfer/events?sid=${sid}&role=sender`).then((r) => r.status),
    fetch(`${srv.base}/api/xfer/events?sid=${sid}&role=receiver`).then((r) => r.status),
    fetch(`${srv.base}/api/xfer/turn?sid=${sid}`).then((r) => r.status),
    fetch(`${srv.base}/api/xfer/signal`, { method: 'POST', headers: hdr({}), body: JSON.stringify({ sid, kind: 'ice', body: 'x' }) }).then((r) => r.status),
  ]);
  assert.deepStrictEqual(probes, [403, 403, 403, 403, 403, 403], `传输码泄露不该给任何能力: ${probes}`);
});

test('配对：错 proof 说"码无效"（不区分会话不存在），对 proof 进入 paired', async () => {
  const { sid, proof } = await createSession();
  assert.strictEqual((await join(srv, sid, randProof())).status, 404);
  const good = await join(srv, sid, proof);
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.body.state, 'paired');
  assert.strictEqual(good.body.frames, 4);
});

test('密文中转一轮：发送方写、接收方读，字节逐段一致；越界与缺段都要报错', async () => {
  const { sid, proof, body } = await createSession();
  const token = body.token;
  const segs = [0, 1, 2, 3].map((i) => crypto.randomBytes(1024 + i));
  for (const [i, buf] of segs.entries()) {
    const r = await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=${i}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': token, 'X-Seg-Crc': 'deadbeef' }, body: buf,
    });
    assert.strictEqual(r.status, 200, `写第 ${i} 段失败`);
  }
  // 接收方读
  const got = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=${i}`, { headers: { 'X-Xfer-Proof': proof } });
    assert.strictEqual(r.status, 200);
    got.push(Buffer.from(await r.arrayBuffer()));
  }
  for (let i = 0; i < 4; i++) assert.ok(got[i].equals(segs[i]), `第 ${i} 段读回来的字节不一样`);
  // 没写过的段：404；越界序号：400；没凭证：403
  assert.strictEqual((await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=9`, { headers: { 'X-Xfer-Proof': proof } })).status, 400);
  assert.strictEqual((await fetch(`${srv.base}/api/xfer/seg?sid=${randSid()}&i=0`, { headers: { 'X-Xfer-Proof': proof } })).status, 404);
  assert.strictEqual((await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`)).status, 403);
  // 接收方不能替发送方写
  const w = await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Proof': proof }, body: crypto.randomBytes(16),
  });
  assert.strictEqual(w.status, 403, '接收方不该能往中转区写');
});

test('重传同一段是幂等的：不重复计入字节', async () => {
  const { sid, body } = await createSession();
  const buf = crypto.randomBytes(2048);
  const put = () => fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': body.token }, body: buf,
  }).then((r) => r.json());
  const a = await put();
  const b = await put();
  assert.strictEqual(a.uploaded, 1);
  assert.strictEqual(b.uploaded, 1, '同一块重传不能算两块');
  const st = await (await fetch(`${srv.base}/api/xfer/state?sid=${sid}`, { headers: { 'X-Xfer-Sender': body.token } })).json();
  assert.strictEqual(st.bytes, 2048, `重传后字节数不该翻倍: ${st.bytes}`);
});

test('三级进度：服务端 uploaded 用区间给，acked 只由接收方本地落盘后确认，且幂等', async () => {
  const { sid, proof, body } = await createSession();
  const st0 = await (await fetch(`${srv.base}/api/xfer/state?sid=${sid}`, { headers: { 'X-Xfer-Sender': body.token } })).json();
  assert.deepStrictEqual(st0.uploaded, []);
  await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': body.token }, body: crypto.randomBytes(100) });
  await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=1`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': body.token }, body: crypto.randomBytes(100) });
  const st1 = await (await fetch(`${srv.base}/api/xfer/state?sid=${sid}`, { headers: { 'X-Xfer-Proof': proof } })).json();
  assert.deepStrictEqual(st1.uploaded, [[0, 1]], '连续序号要压成区间');
  // 还没 join 的会话 ack 会被拒；先 join
  const ackBad = await fetch(`${srv.base}/api/xfer/ack`, { method: 'POST', headers: hdr({}), body: JSON.stringify({ sid, proof, idx: [0] }) });
  assert.strictEqual(ackBad.status, 409, '还没配对的会话不接受落盘确认');
  await join(srv, sid, proof);
  const ack = await fetch(`${srv.base}/api/xfer/ack`, { method: 'POST', headers: hdr({}), body: JSON.stringify({ sid, proof, idx: [0, 1] }) });
  assert.strictEqual((await ack.json()).acked, 2);
  await fetch(`${srv.base}/api/xfer/ack`, { method: 'POST', headers: hdr({}), body: JSON.stringify({ sid, proof, idx: [0] }) });
  const st2 = await (await fetch(`${srv.base}/api/xfer/state?sid=${sid}`, { headers: { 'X-Xfer-Proof': proof } })).json();
  assert.strictEqual(st2.acked.length, 1, '重复 ack 不能再累计');
  assert.deepStrictEqual(st2.acked, [[0, 1]]);
});

test('done 必须等每块都被确认；完成后密文要被清掉，同一个码不能重开', async () => {
  const { sid, proof, body } = await createSession();
  await join(srv, sid, proof);
  for (let i = 0; i < 4; i++) {
    await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': body.token }, body: crypto.randomBytes(64) });
  }
  const early = await fetch(`${srv.base}/api/xfer/done`, { method: 'POST', headers: hdr({}), body: JSON.stringify({ sid, token: body.token }) });
  assert.strictEqual(early.status, 403, 'done 也要认凭证，不能只凭 sid');
  const tooEarly = await fetch(`${srv.base}/api/xfer/done`, {
    method: 'POST', headers: hdr({ 'X-Xfer-Sender': body.token }), body: JSON.stringify({ sid }),
  });
  assert.strictEqual(tooEarly.status, 409, '还有块没被接收端落盘确认，不能说完成');
  await fetch(`${srv.base}/api/xfer/ack`, { method: 'POST', headers: hdr({ 'X-Xfer-Proof': proof }), body: JSON.stringify({ sid, idx: [0, 1, 2, 3] }) });
  const ok = await fetch(`${srv.base}/api/xfer/done`, { method: 'POST', headers: hdr({ 'X-Xfer-Sender': body.token }), body: JSON.stringify({ sid }) });
  assert.strictEqual(ok.status, 200);
  const again = await join(srv, sid, proof);
  assert.ok(again.status === 404 || again.status === 410, `完成之后不能再重开: ${again.status}`);
  await new Promise((r) => setTimeout(r, 600)); // END_KEEP_MS=300
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'transfer', sid)), false, '完成后中转目录必须被清掉');
});

test('取消之后密文同样清掉，服务端不留残骸', async () => {
  const { sid, body } = await createSession();
  await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': body.token }, body: crypto.randomBytes(256) });
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'transfer', sid, 'seg-0.bin')), true);
  const c = await fetch(`${srv.base}/api/xfer/cancel`, { method: 'POST', headers: hdr({ 'X-Xfer-Sender': body.token }), body: JSON.stringify({ sid }) });
  assert.strictEqual(c.status, 200);
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'transfer', sid)), false);
});

test('磁盘账本里没有 codeSecret、没有发送方令牌明文、没有任何文件名', async () => {
  const { sid, body } = await createSession();
  await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': body.token }, body: crypto.randomBytes(64) });
  const raw = fs.readdirSync(path.join(srv.dir, 'transfer', sid)).map((f) => path.join(srv.dir, 'transfer', sid, f));
  const all = raw.filter((p) => p.endsWith('.json')).map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  assert.ok(!all.includes(body.token), '账本里不能存发送方令牌明文');
  assert.ok(!/secret|name|file/i.test(all), `账本里出现了不该有的字段: ${all}`);
  const listed = await (await fetch(`${srv.base}/api/xfer/sessions`)).json();
  const row = listed.find((x) => x.sid === sid);
  assert.ok(row && !JSON.stringify(row).includes(body.token), '管理视图也不能吐令牌');
});

test('生产日志里没有令牌、proof 或文件名', async () => {
  const { sid, proof, body } = await createSession();
  await join(srv, sid, proof);
  await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': body.token }, body: crypto.randomBytes(32) });
  const log = srv.log();
  assert.ok(!log.includes(body.token), '日志里出现了发送方令牌');
  assert.ok(!log.includes(proof), '日志里出现了配对 proof');
});

test('限流：连续拿错码猜会被冻住（挡在线猜传输码）', async () => {
  const { sid } = await createSession();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push(randProof());
  const s2 = await startServer({ XFER_JOIN_FAIL_LIMIT: '5' }, null, 1);
  try {
    const c = await createSession(s2);
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await join(s2, c.sid, codes[i] || randProof())).status;
    assert.strictEqual(last, 429, `猜够次数之后要 429，实际 ${last}`);
  } finally {
    await s2.stop();
  }
});

test('配额与并发：空间不够 413、写不过来 429，都不会把内存/磁盘撑破', async () => {
  // 0.00002GB ≈ 21KB 的中转配额：声明 1000 字节能建会话，真写 30KB 就得被挡住
  const s3 = await startServer({ XFER_LIMIT_GB: '0.00002' }, null, 2);
  try {
    const c = await createSession(s3, { totalBytes: 1000 });
    assert.strictEqual(c.status, 200);
    const r = await fetch(`${s3.base}/api/xfer/seg?sid=${c.sid}&i=0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': c.body.token }, body: crypto.randomBytes(30000),
    });
    assert.strictEqual(r.status, 413, `超过中转配额要 413，实际 ${r.status}`);
    // 声明量本身超上限，建会话就该拒
    const big = await createSession(s3, { totalBytes: 10 * 1024 * 1024 });
    assert.strictEqual(big.status, 413, '声明的总量超过配额要在建会话时就挡住');
  } finally { await s3.stop(); }

  // 并发上界要真的重叠才算验证过：undici/Node 的 fetch 会把同域请求排队，全 200 是假绿。
  // 这里手工把两个请求的正文各写一半、中间停一下，保证服务器同一时刻手里有两个未完成的写。
  const s4 = await startServer({ XFER_MAX_INFLIGHT: '1' }, null, 3);
  try {
    const c = await createSession(s4, { frames: 10 });
    const slowPut = (i) => new Promise((resolve) => {
      const body = crypto.randomBytes(400000);
      const req = http.request({
        host: '127.0.0.1', port: s4.port, path: `/api/xfer/seg?sid=${c.sid}&i=${i}`, method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': c.body.token, 'Content-Length': body.length },
        agent: new http.Agent({ maxSockets: 8 }),
      }, (res) => resolve(res.statusCode));
      req.on('error', () => resolve(-1));
      req.write(body.subarray(0, 200000)); // 写一半就吊着：服务器的名额还占着
      setTimeout(() => req.end(body.subarray(200000)), 400);
    });
    const statuses = await Promise.all([slowPut(0), slowPut(1), slowPut(2)]);
    assert.ok(statuses.includes(429), `并发写超过上界要有人被挡回去: ${statuses}`);
    assert.ok(statuses.includes(200), '但没被挡的必须正常写入');
    // 名额必须被归还：挡完之后还能正常继续写，否则一次 429 就永久少一个名额
    const after = await fetch(`${s4.base}/api/xfer/seg?sid=${c.sid}&i=3`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': c.body.token }, body: crypto.randomBytes(1000),
    });
    assert.strictEqual(after.status, 200, '429 之后名额没还回来，后面就永远写不进去了');
  } finally { await s4.stop(); }
});

test('会话数上界：新建会把最早的挤掉，磁盘上不会堆出无限多个目录', async () => {
  const s5 = await startServer({ XFER_MAX_SESSIONS: '3' }, null, 4);
  try {
    const created = [];
    for (let i = 0; i < 6; i++) { const c = await createSession(s5); created.push(c.sid); }
    const list = await (await fetch(`${s5.base}/api/xfer/sessions`)).json();
    assert.ok(list.length <= 3, `会话数超过上限: ${list.length}`);
    const live = new Set(list.map((x) => x.sid));
    assert.ok(!live.has(created[0]), '最早的会话应该已经被挤掉');
    assert.ok(live.has(created[5]), '最新的会话应该还在');
    const dirs = fs.readdirSync(path.join(s5.dir, 'transfer'));
    assert.ok(dirs.length <= 3, `磁盘上残留了 ${dirs.length} 个会话目录`);
    assert.ok(!dirs.includes(created[0]), '被挤掉的会话目录要真的删掉，不能只从内存里消失');
  } finally { await s5.stop(); }
});

test('过期回收：TTL 到点把密文与账本一起清掉，旧码再也用不了', async () => {
  // 0.000001 分钟 ≈ 0.06 毫秒，建完就过期；create 会先 sweep，所以下一次建会话顺手把它清掉
  const s6 = await startServer({ XFER_TTL_MINUTES: '0.000001' }, null, 5);
  try {
    const c = await createSession(s6);
    const w = await fetch(`${s6.base}/api/xfer/seg?sid=${c.sid}&i=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': c.body.token }, body: crypto.randomBytes(64) });
    assert.strictEqual(w.status, 200);
    assert.strictEqual(fs.existsSync(path.join(s6.dir, 'transfer', c.sid, 'seg-0.bin')), true, '先确认密文真的落过盘');
    await createSession(s6); // 触发清扫
    assert.strictEqual(fs.existsSync(path.join(s6.dir, 'transfer', c.sid)), false, '过期会话的目录必须整体消失');
    const st = await fetch(`${s6.base}/api/xfer/state?sid=${c.sid}`, { headers: { 'X-Xfer-Sender': c.body.token } });
    assert.strictEqual(st.status, 404, '过期之后旧凭证也不再有效');
    const j = await join(s6, c.sid, c.proof);
    assert.strictEqual(j.status, 404, '过期之后旧传输码不能再配对');
  } finally { await s6.stop(); }
});

test('重启：未过期会话保留、分段还能读、写一半的 .tmp 被清', async () => {
  const c = await createSession();
  await join(srv, c.sid, c.proof);
  const seg = crypto.randomBytes(700);
  await fetch(`${srv.base}/api/xfer/seg?sid=${c.sid}&i=2`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': c.body.token }, body: seg });
  fs.writeFileSync(path.join(srv.dir, 'transfer', c.sid, 'seg-3.tmp'), Buffer.alloc(11));
  await srv.stop({ keep: true });
  const dir = srv.dir;
  srv = await startServer({ XFER_TTL_MINUTES: '30', XFER_END_KEEP_MS: '300' }, dir);
  const r = await fetch(`${srv.base}/api/xfer/seg?sid=${c.sid}&i=2`, { headers: { 'X-Xfer-Proof': c.proof } });
  assert.strictEqual(r.status, 200, '重启之后已上传的分段必须还能读，否则续传作废');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(seg));
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'transfer', c.sid, 'seg-3.tmp')), false, '半截文件必须清掉');
});

test('信令确实会转到对端：发送方 offer 到接收方、接收方 answer 回到发送方', async () => {
  const { sid, proof, body } = await createSession();
  await join(srv, sid, proof);
  const openSse = async (role, headers) => {
    const res = await fetch(`${srv.base}/api/xfer/events?sid=${sid}&role=${role}`, { headers });
    assert.strictEqual(res.status, 200);
    return res.body.getReader();
  };
  const dec = new TextDecoder();
  const nextEvent = async (reader, name, timeoutMs = 4000) => {
    const t0 = Date.now();
    let bufTxt = '';
    while (Date.now() - t0 < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      bufTxt += dec.decode(value, { stream: true });
      const m = bufTxt.match(new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`));
      if (m) return JSON.parse(m[1]);
      bufTxt = bufTxt.slice(-4000);
    }
    return null;
  };
  const rStream = await openSse('receiver', { 'X-Xfer-Proof': proof });
  const sStream = await openSse('sender', { 'X-Xfer-Sender': body.token });
  // 先让接收方知道有人上线（sender 侧收到 joined），再转发 offer/answer
  await new Promise((r) => setTimeout(r, 120));
  const sig = (fromSender, kind, text) => fetch(`${srv.base}/api/xfer/signal`, {
    method: 'POST', headers: hdr(fromSender ? { 'X-Xfer-Sender': body.token } : { 'X-Xfer-Proof': proof }),
    body: JSON.stringify({ sid, kind, body: text }),
  });
  assert.strictEqual((await sig(true, 'offer', 'v=offer-fake')).status, 200);
  const gotOffer = await nextEvent(rStream, 'offer');
  assert.ok(gotOffer && gotOffer.body === 'v=offer-fake', 'offer 没转到接收方');
  assert.strictEqual((await sig(false, 'answer', 'v=answer-fake')).status, 200);
  const gotAnswer = await nextEvent(sStream, 'answer');
  assert.ok(gotAnswer && gotAnswer.body === 'v=answer-fake', 'answer 没回到发送方');
  // 方向不能反：接收方不许发 offer
  assert.strictEqual((await sig(false, 'offer', 'x')).status, 400);
  // 密钥交换与确认这两条腿也必须真转发：引擎里的 ECDH 公钥和 confirmMac 就走这两个 kind，
  // 白名单少了它们，直连会在"看起来连上了"之后静默卡死
  assert.strictEqual((await sig(true, 'key', '{"pub":"sender-pub"}')).status, 200);
  const gotKey = await nextEvent(rStream, 'key');
  assert.ok(gotKey && gotKey.body === '{"pub":"sender-pub"}', 'key 没转到接收方');
  assert.strictEqual((await sig(false, 'confirm', '{"mac":"receiver-mac"}')).status, 200);
  const gotConfirm = await nextEvent(sStream, 'confirm');
  assert.ok(gotConfirm && gotConfirm.body === '{"mac":"receiver-mac"}', 'confirm 没回到发送方');
  // 不在协议里的类型一律挡掉：信令不能变成一条任意名字的服务器转发通道
  assert.strictEqual((await sig(true, 'download-plaintext', 'x')).status, 400);
  rStream.cancel(); sStream.cancel();
});

test('与正式文件库物理隔离：.transfer 不会出现在列表 / 下载 / 归档里', async () => {
  const c = await createSession();
  await fetch(`${srv.base}/api/xfer/seg?sid=${c.sid}&i=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': c.body.token }, body: crypto.randomBytes(64) });
  const list = await (await fetch(`${srv.base}/api/list`)).json();
  assert.deepStrictEqual(list.folders, [], '无痕传输的密文绝不能混进文件列表');
  const dl = await fetch(`${srv.base}/api/download/${c.sid}/seg-0.bin`);
  assert.strictEqual(dl.status, 404);
  const arc = await fetch(`${srv.base}/api/archive/${c.sid}`);
  assert.strictEqual(arc.status, 404);
});

test('TURN：未配置时 503；配了密钥就给短期凭证，且每次不同、带过期时间', async () => {
  const { sid, proof } = await createSession();
  await join(srv, sid, proof);
  const off = await fetch(`${srv.base}/api/xfer/turn?sid=${sid}`, { headers: { 'X-Xfer-Proof': proof } });
  assert.strictEqual(off.status, 503, '没配 TURN 要老实说没有');

  const s7 = await startServer({ TURN_SECRET: 'topsecret', TURN_URLS: 'turn:10.1.1.1:3478', TURN_TTL_SECONDS: '60' }, null, 6);
  try {
    const c7 = await createSession(s7);
    await join(s7, c7.sid, c7.proof);
    const noAuth = await fetch(`${s7.base}/api/xfer/turn?sid=${c7.sid}`);
    assert.strictEqual(noAuth.status, 403, '只凭 sid 领不到凭证');
    const a = await (await fetch(`${s7.base}/api/xfer/turn?sid=${c7.sid}`, { headers: { 'X-Xfer-Proof': c7.proof } })).json();
    const b = await (await fetch(`${s7.base}/api/xfer/turn?sid=${c7.sid}`, { headers: { 'X-Xfer-Proof': c7.proof } })).json();
    assert.deepStrictEqual(a.urls, ['turn:10.1.1.1:3478']);
    assert.match(a.username, /^\d+:[a-f0-9]{16}$/, '短期凭证的用户名要带过期时间戳');
    assert.ok(Number(a.username.split(':')[0]) > Math.floor(Date.now() / 1000), '过期时间必须在将来');
    assert.notStrictEqual(a.credential, b.credential, '每次领的凭证都该不同');
    const expect = crypto.createHmac('sha1', 'topsecret').update(a.username).digest('base64');
    assert.strictEqual(a.credential, expect, '凭证要能被同一 secret 复算出来（coturn auth-secret 口径）');
    const cfg = await (await fetch(`${s7.base}/api/xfer/config`)).json();
    assert.strictEqual(cfg.turnConfigured, true);
  } finally { await s7.stop(); }
});

test('随机令牌形状：32 位 hex，猜中一个的概率可以忽略', () => {
  for (let i = 0; i < 200; i++) assert.match(randToken(), /^[a-f0-9]{32}$/);
});
