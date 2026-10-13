// 通道决策与降级状态机。
// 台架：真引擎 + 真协议 + 真服务器，只有 DataChannel 是可控排速的桩（本机 Chromium 产不出
// ICE 候选，见 test/lab/engine-harness.js 顶部）。所以这里证明的是**引擎的决策逻辑**，
// 不是真实网络互通 —— 那条只能拿两台真设备验。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');
const { boot, makeLink, sleep, fakeFile, expectBytes } = require('./lab/engine-harness');

const MB = 1024 * 1024;
const FRAME = 131072;

/** 一条用例的完整生命周期：起服务、装台架、跑 body、保证关掉两端会话再停服务 */
async function withLab(opts, body) {
  const srv = await startServer(Object.assign({ XFER_CREATE_LIMIT: '1000' }, opts.serverEnv || {}), null, opts.slot);
  const link = makeLink({ drainRate: opts.drainRate });
  const env = boot({ link, base: srv.base });
  const sender = env.E.Session({ role: 'sender', on() {}, config: opts.cfg });
  const receiver = env.E.Session({ role: 'receiver', on() {}, config: opts.cfg });
  try {
    return await body({ srv, link, env, sender, receiver });
  } finally {
    for (const s of [sender, receiver]) { try { s.close(); } catch { /* 已经关了 */ } }
    await srv.stop();
  }
}
async function waitChannels(link, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (link.aCh && link.bCh) return true;
    await sleep(20);
  }
  return false;
}
async function waitVerified(receiver, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (receiver.state.verified || receiver.state.phase === 'failed') break;
    await sleep(100);
  }
  return receiver.state;
}
async function collectedBytes(receiver) {
  await receiver.saveAll(null);
  const [one] = await receiver.collected();
  return new Uint8Array(await one.blob.arrayBuffer());
}

test('P2P 正常但缓冲区满（背压）时，不许把剩下的块改投服务器中转', () => withLab({ slot: 71, drainRate: 2 * MB }, async ({ link, env, sender, receiver }) => {
  const size = 6 * MB;
  const frames = Math.ceil(size / FRAME) + 1; // +1 清单帧
  const code = (await sender.send([{ relPath: 'big.bin', name: 'big.bin', size, mime: 'application/octet-stream', file: fakeFile('big.bin', size, 11) }])).code;
  assert.ok(await waitChannels(link), '夹具坏了：两端通道没建起来');
  link.connect();
  await receiver.accept(code);

  const st = await waitVerified(receiver, 60000);
  // 现场：缓冲确实越过 4MB 高水位（没有这一条，下面的判据就是空对空绿）
  assert.ok(link.maxBuffered > 4 * MB, `没造出背压现场：maxBuffered=${link.maxBuffered}`);
  // 传输本身要成、内容要逐字节对得上、进度不许重复累计
  assert.ok(st.verified, `接收端没通过校验：phase=${st.phase} error=${st.error}`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 11)), '内容不对');
  assert.strictEqual(sender.state.phase, 'done');
  assert.ok(sender.state.sentFrames <= frames + 2, `发送帧数 ${sender.state.sentFrames} > 应有 ${frames}，进度重复累计了`);
  // 判据一：通道没失效就不许降级
  assert.strictEqual(sender.state.channel, 'p2p', `通道被判成 ${sender.state.channel}，背压不是断线`);
  // 判据二：服务器不该收到本不必发的中转写入
  assert.ok(env.counters.segPut <= 2,
    `背压被当成"直连不可用"：${env.counters.segPut} 帧额外 PUT 到服务器（共 ${frames} 帧）`);
  // 判据三：说"已上线"的字节里绝大部分要真的走了通道（否则界面显示的"直连"是假的）
  assert.ok(sender.state.bytesOnWire - link.dcBytes <= FRAME,
    `bytesOnWire=${sender.state.bytesOnWire}，走通道的只有 ${link.dcBytes}`);
}));

test('通道真的失效时，才允许降级到服务器中转，并且不重复计数、不丢块', () => withLab({ slot: 72, drainRate: 2 * MB }, async ({ link, env, sender, receiver }) => {
  const size = 8 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  const code = (await sender.send([{ relPath: 'm.bin', name: 'm.bin', size, mime: 'application/octet-stream', file: fakeFile('m.bin', size, 5) }])).code;
  assert.ok(await waitChannels(link), '夹具坏了：两端通道没建起来');
  link.connect();
  await receiver.accept(code);
  await sleep(600);
  const doneBefore = receiver.state.stored;
  const putBefore = env.counters.segPut;
  link.drop();
  link.a.connectionState = 'failed';
  link.a.onconnectionstatechange();

  const st = await waitVerified(receiver, 60000);
  assert.ok(doneBefore < frames, `夹具没跟上：断链时已经传完了（${doneBefore}/${frames}），这条测不到降级`);
  assert.ok(st.verified, `断链后没能靠中转完成：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(sender.state.channel, 'server_relay', '降级之后通道标识要如实改');
  assert.ok(env.counters.segPut > putBefore, '降级后应当有中转写入');
  assert.ok(env.counters.segPut <= frames * 2, `中转写入 ${env.counters.segPut} 远超帧数 ${frames}，重复写入没收敛`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 5)), '切通道后内容/顺序不能出问题');
}));

test('服务器中转单独一条路：没有通道可用时也要能传完并逐字节正确', () => withLab({ slot: 73, drainRate: 8 * MB }, async ({ srv, link, env, sender, receiver }) => {
  const size = 2 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  const code = (await sender.send([{ relPath: 'r.bin', name: 'r.bin', size, mime: 'application/octet-stream', file: fakeFile('r.bin', size, 9) }])).code;
  // 故意不调 link.connect()：通道永不打开 → 只能靠服务器中转
  await receiver.accept(code);
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `纯中转路径没传完：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(sender.state.channel, 'server_relay');
  assert.ok(env.counters.segPut >= frames, `纯中转应有足量写入，实际 ${env.counters.segPut}/${frames}`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 9)));
  const tdir = path.join(srv.dir, 'transfer');
  const segs = fs.readdirSync(tdir).flatMap((d) => fs.readdirSync(path.join(tdir, d)).filter((f) => /^seg-\d+\.bin$/.test(f)));
  assert.ok(segs.length >= frames, `中转区磁盘上应有 ${frames} 个密文分段，实际 ${segs.length}`);
}));

test('直连只是抖一下（disconnected 后又自己回来）时，不许把它掐掉改走中转', () => withLab({ slot: 74, drainRate: 8 * MB, cfg: { dcRegraceMs: 1500 } }, async ({ link, env, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'd.bin', name: 'd.bin', size, mime: 'application/octet-stream', file: fakeFile('d.bin', size, 3) }])).code;
  assert.ok(await waitChannels(link), '夹具坏了：两端通道没建起来');
  link.connect();
  await receiver.accept(code);
  await sleep(300);
  link.a.connectionState = 'disconnected';
  link.a.onconnectionstatechange();          // 通道本身还开着：这就是一次抖动
  await sleep(2400);                          // 比宽限期还长
  assert.strictEqual(sender.state.channel, 'p2p', `一次 disconnected 就把直连掐了（channel=${sender.state.channel}）`);
  assert.strictEqual(env.counters.segPut, 0, '抖动期间不该产生任何中转写入');
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `抖完之后没能传完：phase=${st.phase} error=${st.error}`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 3)));
}));

test('disconnected 过了宽限期仍然没回来，这时才降级走中转', () => withLab({ slot: 75, drainRate: 2 * MB, cfg: { dcRegraceMs: 900 } }, async ({ link, env, sender, receiver }) => {
  const size = 12 * MB;   // 排速 2MB/s：降级发生在传输中途，而不是"已经传完了才降级"
  const code = (await sender.send([{ relPath: 'g.bin', name: 'g.bin', size, mime: 'application/octet-stream', file: fakeFile('g.bin', size, 7) }])).code;
  assert.ok(await waitChannels(link), '夹具坏了：两端通道没建起来');
  link.connect();
  await receiver.accept(code);
  await sleep(250);
  link.drop();                                // 通道真的没了
  link.a.connectionState = 'disconnected';
  link.a.onconnectionstatechange();
  await sleep(300);                            // 宽限期 900ms 之内再看一次
  assert.strictEqual(sender.state.channel, 'p2p', '宽限期内就降级了，没给 ICE 自己恢复的机会');
  const st = await waitVerified(receiver, 60000);
  assert.strictEqual(sender.state.channel, 'server_relay', '过了宽限期仍没回来才该降级');
  assert.ok(st.verified, `降级后没能传完：phase=${st.phase} error=${st.error}`);
  assert.ok(env.counters.segPut > 0, '降级后应当有中转写入');
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 7)));
}));

test('TURN：发送方建链时还没配对拿不到凭证，joined 之后必须补进 ICE', () => withLab({
  slot: 76, drainRate: 8 * MB,
  serverEnv: { TURN_URLS: 'turn:10.20.30.40:3478', TURN_SECRET: 'lab-secret', TURN_TTL_SECONDS: '600' },
}, async ({ link, sender, receiver }) => {
  const size = 1 * MB;
  const code = (await sender.send([{ relPath: 't.bin', name: 't.bin', size, mime: 'application/octet-stream', file: fakeFile('t.bin', size, 21) }])).code;
  assert.ok(await waitChannels(link), '夹具坏了：两端通道没建起来');
  link.stats = [
    { type: 'candidate-pair', selected: true, localCandidateId: 'l1', remoteCandidateId: 'r1' },
    { type: 'local-candidate', id: 'l1', candidateType: 'relay' },
    { type: 'remote-candidate', id: 'r1', candidateType: 'host' },
  ];
  link.connect();
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !link.setConfigs.length) await sleep(100);
  const cfg = link.setConfigs[0];
  assert.ok(cfg, 'joined 之后没往 pc 上补 TURN 配置：发送方永远拿不到 relay 候选');
  const turn = (cfg.iceServers || []).find((s) => String(s.urls).includes('turn:'));
  assert.ok(turn, `补的配置里没有 TURN 服务器：${JSON.stringify(cfg.iceServers)}`);
  assert.match(turn.username, /^\d+:[a-f0-9]{16}$/, '补的应当是短期凭证（用户名带过期时间戳）');
  assert.ok(Number(turn.username.split(':')[0]) >= Math.floor(Date.now() / 1000), '过期时间必须在将来');
  assert.strictEqual(sender.state.channel, 'turn_relay', '选中 relay 候选时要报 turn_relay，不能报成"直连"');
}));

// 下面两条由真浏览器实验室（test/lab/xfer-big-lab.js）报出来：那边两台 Chromium 谁都
// 产不出候选，8 秒后各自降级，迟到的 answer 就把一句 TypeError 顶到了用户界面上，
// 而接收端的通道标识一直停在"正在尝试点对点直连…"，实际全盘在走中转。
test('降级之后迟到的 offer/answer/ice 只当没听见，不许变成抛给用户的报错', () => withLab({
  slot: 77, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 800 },
}, async ({ srv, env, sender, receiver }) => {
  const size = 2 * MB;
  // 故意不 link.connect()：两端都会超时降级，rtc 变成 null，此时对端补发的信令就是"迟到"
  const code = (await sender.send([{ relPath: 'l.bin', name: 'l.bin', size, mime: 'application/octet-stream', file: fakeFile('l.bin', size, 13) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && sender.state.channel !== 'server_relay') await sleep(100);
  assert.strictEqual(sender.state.channel, 'server_relay', '夹具坏了：发送端没降级，这条测不到迟到信令');

  const parsed = env.P.parseCode(code);
  const proof = await env.P.proofOf(parsed.sid, parsed.secret);
  const senderRec = JSON.parse(env.stores.get('fb.xfer.sender') || '{}')[parsed.sid] || {};
  assert.ok(senderRec.token, '夹具坏了：本地没存到发送方 token，投不出发送方向的迟到信令');
  const late = [
    ['answer', 'v=0 late-answer', { 'X-Xfer-Proof': proof }],   // 迟到的 answer 发给发送方
    ['ice', '{"candidate":"late"}', { 'X-Xfer-Proof': proof }], // 迟到的 candidate 发给发送方
    ['offer', 'v=0 late-offer', { 'X-Xfer-Sender': senderRec.token }], // 迟到的 offer 发给接收方
  ];
  for (const [kind, body, cred] of late) {
    const r = await fetch(`${srv.base}/api/xfer/signal`, {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cred),
      body: JSON.stringify({ sid: parsed.sid, kind, body }),
    });
    assert.strictEqual(r.status, 200, `${kind} 信令本该被服务器收下：${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);
  }
  await sleep(600);
  assert.strictEqual(sender.state.error, '', `迟到的信令把错误抛给了用户：${sender.state.error}`);
  assert.strictEqual(receiver.state.error, '', `接收端也被迟到信令报错：${receiver.state.error}`);
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `收下迟到信令之后传输断了：phase=${st.phase} error=${st.error}`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 13)));
}));

test('接收端也要在直连超时后如实改通道标识，不能让用户界面停在"正在尝试直连"', () => withLab({
  slot: 78, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 800 },
}, async ({ env, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'c.bin', name: 'c.bin', size, mime: 'application/octet-stream', file: fakeFile('c.bin', size, 17) }])).code;
  await receiver.accept(code);
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `没传完：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(sender.state.channel, 'server_relay', '夹具坏了：发送端没降级');
  assert.strictEqual(receiver.state.channel, 'server_relay',
    `接收端全程在从中转拉数据，界面却还写着 ${receiver.state.channel}`);
  assert.ok(env.counters.segGet > 0, '这条判据要建立在"接收端确实走了中转"之上');
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 17)));
}));

// 降级这一步本身不许留下副作用：rtc.close() 会当场回调 state='closed'，那条回调又走一遍
// 降级 → 在密钥还没落地时叫起 afterHandshake → 提前补验 confirm 就读到 null 的 kMeta。
// 现场是"传输中途超时降级"，所以把超时压到 400ms、文件放大到 8MB，让降级必定落在飞行中。
//
// 诚实边界：switchChannel 的"先落状态再关 pc"次序 + afterHandshake 的 sess 复查这两处，
// 单独变异任何一处（含两处一起变异，见 mutate-channel.js 的 switch-order / no-sess-guard /
// degrade-reentrancy）这 9 条腿都不变红 —— 台架里 confirm 从来没有早于密钥到达过。
// 那次现场只在全量并跑时出现过一次（接收端卡 retrying、报 kMeta），没能在这条腿上钉死；
// 这条腿证的是"中途降级不留报错、不丢块"，那两处改动按预防性纵深登记，不算已被门禁覆盖。
// 600MB 真浏览器实测暴露出来的：接收端确认落后时，发送端把"服务器已经收下但对方还没确认"
// 的帧当成丢包又 PUT 了一遍 —— 4801 帧发了 5594 次、多烧 133MB 线上字节，
// 还在收尾时撞上会话被回收，报出一句"写入分段失败"。
// 「分块重排」在协议层已经由 protocol.test.js 钉住（帧头里的 fileId/chunkIdx 进 AAD，
// 把 46 块的密文贴到 45 块上必须失败）。这条补的是装配层：到达顺序被打乱时，
// 接收端要按块号归位，而不是按"先到先存"排。
test('帧乱序到达也要按块号归位：装配结果与到达顺序无关', () => withLab({
  slot: 81, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600 },
}, async ({ srv, env, sender, receiver }) => {
  const size = 2 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  const code = (await sender.send([{ relPath: 's.bin', name: 's.bin', size, mime: 'application/octet-stream', file: fakeFile('s.bin', size, 41) }])).code;
  await receiver.accept(code);
  receiver.pause();   // 先按住接收端：不然引擎自己按序拉完，我这一步就成了空跑
  const parsed = env.P.parseCode(code);
  const proof = await env.P.proofOf(parsed.sid, parsed.secret);
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && sender.state.uploaded < frames) await sleep(100);
  assert.strictEqual(sender.state.uploaded, frames, `夹具坏了：服务器还没收齐（${sender.state.uploaded}/${frames}）`);
  // 先把清单喂进去（没有清单就没有布局），其余按"倒序 + 隔位"这种确定性的乱序喂
  const order = [];
  for (let i = frames - 1; i >= 1; i -= 2) order.push(i);
  for (let i = frames - 2; i >= 1; i -= 2) order.push(i);
  const get = async (i) => {
    const r = await fetch(`${srv.base}/api/xfer/seg?sid=${parsed.sid}&i=${i}`, { headers: { 'X-Xfer-Proof': proof } });
    assert.strictEqual(r.status, 200, `第 ${i} 帧取不到：${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  await receiver._test.acceptFrame(await get(0));
  for (const i of order) await receiver._test.acceptFrame(await get(i));

  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `乱序喂完没通过校验：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(st.stored, frames, `本地该有 ${frames} 帧，实际 ${st.stored}`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 41)),
    '乱序到达若真按到达顺序装配，这里必然对不上');
}));

// 600MB 真浏览器实测的原始症状："接收完了，合成错误"（用户最初报的就是这个）。
// 现场是 finishReceive 逐块重算时，某一块从 IndexedDB 读不回来（读事务抖 / 浏览器丢缓存），
// 引擎把这一次可恢复的读失败当成"文件坏了"直接失败 —— 而那一帧服务器手上还在。
test('本地暂存有一块读不回来时，要回服务器补拉那一块继续校验，而不是报"合成错误"', () => withLab({
  slot: 82, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600 },
}, async ({ env, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'v.bin', name: 'v.bin', size, mime: 'application/octet-stream', file: fakeFile('v.bin', size, 53) }])).code;
  const parsed = env.P.parseCode(code);
  env.idbDrop.add(`${parsed.sid}#7`);   // 只让这一帧"本地读不到"一次
  await receiver.accept(code);
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `本地有一帧读不回来就整个失败收场：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(st.error, '', `恢复过程给用户留了报错：${st.error}`);
  assert.strictEqual(st.stored, Math.ceil(size / FRAME) + 1, '补拉回来之后本地该凑齐全部帧');
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 53)),
    '补拉那一帧之后装配必须逐字节正确');
}));

test('服务器已经收下这一块，就不许再把它 PUT 第二遍（慢确认 ≠ 丢包）', () => withLab({
  slot: 80, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, retryGapMs: 200 },
}, async ({ env, sender, receiver }) => {
  const size = 4 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  const code = (await sender.send([{ relPath: 'k.bin', name: 'k.bin', size, mime: 'application/octet-stream', file: fakeFile('k.bin', size, 31) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && sender.state.sentFrames < frames) await sleep(100);
  assert.strictEqual(sender.state.sentFrames, frames, `夹具坏了：主循环没把每块正好发一遍（${sender.state.sentFrames}/${frames}）`);
  const putAfterMainLoop = env.counters.segPut;
  receiver.pause();                     // 对端不再确认（真机上等价于"正在解密/落盘"）
  await sleep(2500);                    // 足够尾巴轮好几圈（retryGapMs=200）
  receiver.resume();
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `恢复确认之后没传完：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(env.counters.segPut, putAfterMainLoop,
    `等确认期间又被 PUT 了 ${env.counters.segPut - putAfterMainLoop} 帧 —— 服务器早就有了，这一遍纯属白烧`);
  assert.strictEqual(sender.state.sentFrames, frames, `发送帧数 ${sender.state.sentFrames} ≠ 应有 ${frames}，重发没收敛`);
  assert.strictEqual(sender.state.error, '', `尾巴期给用户留了报错：${sender.state.error}`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 31)));
}));

test('传输中途降级：关 pc 的那一下不许把降级再触发一遍，也不许留下报错', () => withLab({
  slot: 79, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 400 },
}, async ({ sender, receiver }) => {
  const size = 8 * MB;
  const code = (await sender.send([{ relPath: 'm2.bin', name: 'm2.bin', size, mime: 'application/octet-stream', file: fakeFile('m2.bin', size, 23) }])).code;
  await receiver.accept(code);
  const st = await waitVerified(receiver, 60000);
  assert.strictEqual(receiver.state.channel, 'server_relay', '接收端没在超时后改标');
  assert.ok(st.verified, `中途降级把传输带崩了：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(receiver.state.error, '', `降级过程给用户留了报错：${receiver.state.error}`);
  assert.strictEqual(sender.state.error, '', `发送端同样被报错：${sender.state.error}`);
  assert.ok(sender.state.sentFrames > 0, '这条判据要建立在"降级确实发生在传输中途（已经有块发出去）"之上');
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 23)));
}));
