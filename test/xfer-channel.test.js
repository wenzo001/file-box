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
  let link, env, sender, receiver;
  // 装台架这一步自己也会炸（engine-harness 里那条"台架嵌套"守卫就是）。那时监听已经开了，
  // 不把服务关掉就往上抛，跑测进程永远等不到端口释放 —— 变异台就是这么挂了 6 分钟没出一行结论
  try {
    link = makeLink({ drainRate: opts.drainRate });
    env = boot({ link, base: srv.base });
    sender = env.E.Session({ role: 'sender', on() {}, config: opts.cfg });
    receiver = env.E.Session({ role: 'receiver', on() {}, config: opts.cfg });
  } catch (err) {
    await srv.stop().catch(() => { /* 已经关了 */ });
    throw err;
  }
  try {
    return await body({ srv, link, env, sender, receiver, cfg: opts.cfg });
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
  // 同样要等发送端自己落定：done 是它读完自己那一轮确认账之后才出现的，不跟着接收端的 verified 一起到
  const tD = Date.now();
  while (Date.now() - tD < 20000 && sender.state.phase !== 'done') await sleep(100);
  assert.strictEqual(sender.state.phase, 'done', `发送端没收尾：${sender.state.phase}（等了 ${Date.now() - tD}ms）`);
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

// 接收端刷新重连之后，服务器会给发送方再补一条 joined。发送方那时正在传输，
// 这条事件不许把相位打回"正在配对"——600MB 之外的那轮 48MB 实测里，
// 发送端就停在"正在配对、核对安全码"，而它 385 帧全都发完了。
test('传输途中对端重新加入，不许把发送端相位打回"正在配对"', () => withLab({
  slot: 83, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600 },
}, async ({ srv, env, sender, receiver }) => {
  const size = 4 * MB;
  const code = (await sender.send([{ relPath: 'j.bin', name: 'j.bin', size, mime: 'application/octet-stream', file: fakeFile('j.bin', size, 61) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !sender.state.sentFrames) await sleep(50);
  assert.ok(sender.state.sentFrames > 0, `夹具坏了：发送端一帧都没开始发（phase=${sender.state.phase} error=${sender.state.error}）`);
  const parsed = env.P.parseCode(code);
  const proof = await env.P.proofOf(parsed.sid, parsed.secret);
  const again = await fetch(`${srv.base}/api/xfer/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: parsed.sid, proof }),
  });
  assert.strictEqual(again.status, 200, '对端重连本该被服务器收下');
  await sleep(600);
  assert.notStrictEqual(sender.state.phase, 'pairing', '一条 joined 把正在传输的发送端打回了"正在配对"');
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `重连之后传输断了：phase=${st.phase} error=${st.error}`);
  // 接收端"校验通过"和发送端"收敛到 done"是两个时刻：后者要等它下一轮把确认账读回来。
  // 原来这里紧接着就 assert，等于在 unsettled 的读数上判卷 —— 整机一忙就假红（空载单跑三遍全绿、
  // 整跑里红过一次，就是这么暴露的）。判据本身不变，仍然要求收敛到 done，只是给它落到定的窗口。
  const t1 = Date.now();
  while (Date.now() - t1 < 20000 && sender.state.phase !== 'done') await sleep(100);
  assert.strictEqual(sender.state.phase, 'done',
    `发送端没收敛到 done（停在 ${sender.state.phase}，等了 ${Date.now() - t1}ms），服务器密文就一直不会被清`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 61)));
}));

// 落盘确认丢一次就永远丢：接收端明明存好了，服务器的 acked 却少一批，
// 发送端 done 门永远差这几块 —— 48MB 接收端刷新实测停在"对方已落盘确认 384/385"就是这个洞
// （会话不收尾 → 服务器上的密文一直占着中转配额）。
test('确认请求发不出去时必须重试，并且会话收尾后密文真的被清掉', () => withLab({
  slot: 84, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600 }, serverEnv: { XFER_END_KEEP_MS: '4000' },
}, async ({ srv, env, sender, receiver }) => {
  const size = 4 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  const code = (await sender.send([{ relPath: 'a.bin', name: 'a.bin', size, mime: 'application/octet-stream', file: fakeFile('a.bin', size, 71) }])).code;
  await receiver.accept(code);
  env.counters.failAck = 1;                     // 下一批确认正好丢掉
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `接收端没校验通过：phase=${st.phase} error=${st.error}`);
  const t = Date.now();
  while (Date.now() - t < 25000 && sender.state.phase !== 'done') await sleep(200);
  assert.strictEqual(sender.state.phase, 'done',
    `丢一次确认之后发送端停在 ${sender.state.phase}（已确认 ${sender.state.stored}/${frames} 块）`);
  assert.ok((env.counters.byPath['POST /api/xfer/ack'] || 0) >= 2,
    '这条判据要建立在"确认确实重发过"之上，不能只是碰巧收敛');
  const sid = (await env.P.parseCode(code)).sid;
  const segDir = path.join(srv.dir, 'transfer', sid);
  const t2 = Date.now();
  while (Date.now() - t2 < 15000 && fs.existsSync(segDir)) await sleep(300);
  assert.ok(!fs.existsSync(segDir), 'done 之后中转密文必须被清掉，否则一次丢确认就等于长期占着配额');
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 71)));
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

// 2GB 真浏览器实测撞出来的：中转 PUT 的 socket 死了但连接没断时，fetch **既不 resolve 也不 reject**，
// 就那样一直占着并行槽 —— 四个槽填满之后整段传输静默停摆，界面上没有报错、进度不再动，
// 只有接收端偶尔冒一句 "Failed to fetch"。这条判据要的是"到点自己散开"，不是"最后碰巧收敛"。
test('中转 PUT 挂住不返回时，必须到点重投；不许把并行槽吃满导致整段停摆', () => withLab({
  slot: 85, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, parallel: 4, netTimeoutMs: 400, retryGapMs: 200 },
}, async ({ env, sender, receiver }) => {
  const size = 2 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  // 恰好挂住"填满所有并行槽"那么多请求：这就是那一次网络抖动留下的死连接
  env.counters.hangPut = 4;
  const code = (await sender.send([{ relPath: 'h.bin', name: 'h.bin', size, mime: 'application/octet-stream', file: fakeFile('h.bin', size, 83) }])).code;
  await receiver.accept(code);
  const st = await waitVerified(receiver, 15000);
  assert.ok(st.verified,
    `挂住的 PUT 没被超时接管：接收端 phase=${st.phase} 只存了 ${st.stored}/${frames} 块，发送端 sentFrames=${sender.state.sentFrames}/${frames}`);
  // 发送端的 done 要等它自己那一轮账读回来才落定 —— 接收端 verified 之后立刻断言会读到没收敛的一帧
  // （整跑里就是这么红过一次，和本批 leg 83 是同一根病：借"A 稳了"推"B 也该稳了"）
  const tDone = Date.now();
  while (Date.now() - tDone < 20000 && sender.state.phase !== 'done') await sleep(100);
  // 正向：超时确实触发过重投（挂住的 4 次也算请求）；反向：不许退化成重发风暴
  assert.ok(env.counters.segPut >= frames + 4 && env.counters.segPut <= frames + 8,
    `写入次数应落在 ${frames}+4 到 ${frames}+8 之间（超时重投过、但没乱发），实际 ${env.counters.segPut}`);
  assert.strictEqual(sender.state.phase, 'done', `发送端没收尾：${sender.state.phase}（等了 ${Date.now() - tDone}ms）`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 83)));
}));

// 顺着"裸 fetch 没有超时"这条线往下扫的第二站：收尾那一步（POST /api/xfer/done）。
// 它挂住的时候整单已经传完了，却因为一个收尾请求把用户推进死路（failed），密文也不释放。
test('收尾请求挂住时必须重试并真的收尾，不许把已经传完的一单报成失败', () => withLab({
  slot: 86, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, netTimeoutMs: 300, parallel: 4 },
}, async ({ env, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'f.bin', name: 'f.bin', size, mime: 'application/octet-stream', file: fakeFile('f.bin', size, 91) }])).code;
  // 注入必须在 accept 之前挂上：整单很短，等 verified 之后再设，收尾早就发完了（第一版就是这么空转的）
  env.counters.hangFinish = 1;
  await receiver.accept(code);
  const st = await waitVerified(receiver, 30000);
  assert.ok(st.verified, `接收端没校验通过：phase=${st.phase} error=${st.error}`);
  // 计数要**在断言那一刻**读：收尾的第二投是在这之后才发生的，提前抓一份快照会把"确实重投过"
  // 判成"只发了一次"（第一版就是这么红的 —— 红因在量具上，不在产品上）
  const attempts = () => env.counters.byPath['POST /api/xfer/done'] || 0;
  const t = Date.now();
  while (Date.now() - t < 20000 && sender.state.phase !== 'done') await sleep(100);
  assert.strictEqual(sender.state.phase, 'done',
    `收尾挂住一次之后没能重投回来：phase=${sender.state.phase} error=${sender.state.error} 收尾尝试=${attempts()} 次`);
  assert.ok(attempts() >= 2, `判据要建立在"收尾确实重发过"之上，实际只发了 ${attempts()} 次`);
}));

// 服务器拒收收尾（还有块没被确认落盘）时，客户端原来只看 fetch 成没成、不看响应 —— 于是
// 界面报"传输完成"，服务器那边状态还停在 paired、密文永远占着中转配额。**这是假成功**。
// 这里把"服务器到底怎么写的"当成判据（meta.json），不看客户端自己怎么说。
test('服务器拒收收尾时，不许把界面报成"传输完成"（要看响应，不是看请求发没发出去）', () => withLab({
  slot: 87, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, parallel: 4 },
  serverEnv: { XFER_END_KEEP_MS: '4000' },
}, async ({ srv, env, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'q.bin', name: 'q.bin', size, mime: 'application/octet-stream', file: fakeFile('q.bin', size, 97) }])).code;
  env.counters.refuseFinish = 1;                  // 第一次收尾被 409 挡回来
  await receiver.accept(code);
  const st = await waitVerified(receiver, 30000);
  assert.ok(st.verified, `接收端没校验通过：phase=${st.phase} error=${st.error}`);
  const t = Date.now();
  while (Date.now() - t < 20000 && sender.state.phase !== 'done') await sleep(100);
  // 客户端最终要落定在 done（拒收过一次之后重投成功）
  assert.strictEqual(sender.state.phase, 'done',
    `收尾被拒之后没收敛：phase=${sender.state.phase} error=${sender.state.error} `
    + `收尾尝试=${env.counters.byPath['POST /api/xfer/done'] || 0} 次 `
    + `已确认=${sender.state.stored || '?'}/${sender.state.frames || '?'}`);
  // 而且"报完成"必须与服务器账本一致：meta 里的状态真的是 done（或目录已清）
  const sid = (await env.P.parseCode(code)).sid;
  const metaPath = path.join(srv.dir, 'transfer', sid, 'meta.json');
  const gone = !fs.existsSync(metaPath);
  const persisted = gone ? null : JSON.parse(fs.readFileSync(metaPath, 'utf8')).state;
  assert.ok(gone || persisted === 'done',
    `界面说完成了，服务器账本却还写着 ${persisted} —— 收尾没成就不许报"传输完成"（密文也不会被清）`);
  assert.ok((env.counters.byPath['POST /api/xfer/done'] || 0) >= 2, '判据要建立在"被拒之后确实重投过"之上');
}));

// 上面那条只拒一次，重投就成功了 —— 所以它对"客户端不看响应"这把刀是**等价变异**（我试出来过：
// 把 if (accepted) 改成 if (true) 三条腿全绿）。这条把拒收变成一直拒，
// 于是唯一能区分"看请求"和"看答复"的就是这条判据：客户端不许宣称完成，也不许把服务器没认的单据说成收尾了。
test('收尾被一直拒收时，客户端不许宣称"完成"，报错要留在可以继续的档位', () => withLab({
  slot: 89, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, parallel: 4 },
  serverEnv: { XFER_END_KEEP_MS: '4000' },
}, async ({ srv, env, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'n.bin', name: 'n.bin', size, mime: 'application/octet-stream', file: fakeFile('n.bin', size, 109) }])).code;
  env.counters.refuseFinish = 99;                 // 收尾一直被 409 挡
  await receiver.accept(code);
  const st = await waitVerified(receiver, 30000);
  assert.ok(st.verified, `接收端没校验通过：phase=${st.phase} error=${st.error}`);
  const t = Date.now();
  // 等到"我关心的那件事落定"再读，而不是"相位一变就读"：相位可能因为别的瞬时错误先离开
  // transferring，那一刻屏上挂着的是别的话，判据就会把产品没做错的地方报成红（第一版就是这么抖的）
  while (Date.now() - t < 20000) {
    const s = sender.state;
    if (s.phase === 'done' || /收尾/.test(s.error)) break;
    await sleep(100);
  }
  const s = sender.state;
  assert.notStrictEqual(s.phase, 'done',
    `服务器四次都没收下收尾（拒收=${env.counters.byPath['POST /api/xfer/done'] || 0} 次），界面却直接报"传输完成" —— 这是假成功`);
  assert.ok(/继续|重试/.test(s.error), `要给出可操作动作，实际 phase=${s.phase} error="${s.error}"`);
  const sid = (await env.P.parseCode(code)).sid;
  const meta = JSON.parse(fs.readFileSync(path.join(srv.dir, 'transfer', sid, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.state, 'paired', `服务器账本和界面要说同一件事：账本=${meta.state}，界面 phase=${s.phase}`);
}));

// 2GB 那一跑反复撞到的形状：进度不再动，界面也不报错，会话就那么挂着。
// 网络那一侧已经有超时兜着了（上面那条腿），但 sendSeq 里还有别的 await 点会永远不回来 ——
// 比如某个加密线程被浏览器杀掉：postMessage 发出去、onmessage 再也不来，那一格并行窗口就没了。
// 这条要的不是"救活"（worker 死了救不活），而是**不许装死**：一段时间一块都没进展，必须说出来并且可续传。
test('没有任何一块有进展时，不许静默挂着：到点必须把"卡住了"说出去', () => withLab({
  slot: 88, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, parallel: 4, stallMs: 900, netTimeoutMs: 400 },
}, async ({ env, sender, receiver }) => {
  const size = 4 * MB;
  const code = (await sender.send([{ relPath: 's.bin', name: 's.bin', size, mime: 'application/octet-stream', file: fakeFile('s.bin', size, 103) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && !sender.state.sentFrames) await sleep(50);
  const base = sender.state.sentFrames;
  assert.ok(base > 0, `夹具坏了：一条帧都没发出去就没法证明"之后不动了"（phase=${sender.state.phase} error=${sender.state.error}）`);
  env.counters.stuckSeal = 4;                     // 恰好把 4 个并行槽全喂给不回话的线程
  const t = Date.now();
  let hit = null;
  while (Date.now() - t < 12000) {
    const s = sender.state;
    if (['retrying', 'failed'].includes(s.phase) && /卡住/.test(s.error)) { hit = s; break; }
    await sleep(150);
  }
  assert.ok(hit, `卡住之后一路静默：phase=${sender.state.phase} error="${sender.state.error}" `
    + `（发出 ${sender.state.sentFrames}/${base} 块之后不动了，界面上什么也没有）`);
  assert.notStrictEqual(sender.state.phase, 'done', '一块都没进展却报"传输完成"');
  assert.notStrictEqual(receiver.state.verified, true, '发送端卡住了接收端却被判通过');
  assert.ok(/继续|重试/.test(sender.state.error), `报错要给出可操作动作，实际="${sender.state.error}"`);
  // 报出来只是第一步。这一类（worker 再也不回话）其实**不可自愈**：线程池那一格被永远占着，
  // 重投也排不到活的线程 —— 所以这里要钉的是"先自己试、试不通才交给人"，而不是"最后一定跑得完"。
  // （能自愈的那一类在下面那条腿：慢但最终会回话。）
  const t2 = Date.now();
  let tried = false;
  while (Date.now() - t2 < 40000) {
    const e = sender.state.error || '';
    if (/正在自己重试/.test(e)) tried = true;
    if (/点"继续"/.test(e)) break;
    await sleep(150);
  }
  assert.ok(tried, '一次都没试过自己恢复，直接把恢复动作丢给了用户');
  assert.ok(/点"继续"/.test(sender.state.error),
    `自己试过之后应当退到"给人工出口"，实际="${sender.state.error}"`);
  assert.notStrictEqual(sender.state.phase, 'done', '一块都没进展却报"传输完成"');
  assert.notStrictEqual(receiver.state.verified, true, '发送端卡住了接收端却被判通过');
}));

// 可自愈的那一类：慢但最终会回话。要钉两件事 —— 它要真的自己跑完，
// 而且跑起来之后不许把上一轮的"卡住了"继续挂在脸上（假警报残留）。
test('卡住之后自己恢复了：要跑完，并且不许留着旧的"卡住了"吓用户', () => withLab({
  slot: 90, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, parallel: 4, stallMs: 700, netTimeoutMs: 400, retryGapMs: 300 },
}, async ({ env, srv, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'r.bin', name: 'r.bin', size, mime: 'application/octet-stream', file: fakeFile('r.bin', size, 127) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && !sender.state.sentFrames) await sleep(50);
  assert.ok(sender.state.sentFrames > 0, `夹具坏了：一帧都没发出去（phase=${sender.state.phase}）`);
  env.counters.slowSeal = 2; env.counters.slowSealMs = 2500;   // 两格线程慢 2.5 秒才回话：越过 stallMs，但最终会回来
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `慢线程之后没能跑完：接收端 phase=${st.phase} error=${st.error}`);
  const t = Date.now();
  // 轨迹：红的时候必须能一眼看出是"哪一档没过去"（收尾被 409 / 请求超时 / 又卡住一次），
  // 只报一个 phase='retrying' 等于让下一个人从头猜
  const trail = [];
  let prev = '';
  while (Date.now() - t < 20000 && sender.state.phase !== 'done') {
    const s = sender.state;
    const snap = `${s.phase}|${s.error}|sent=${s.sentFrames}/${s.frames} ack=${s.stored}`;
    if (snap !== prev) { trail.push(`${Math.round((Date.now() - t) / 1000)}s ${snap}`); prev = snap; }
    await sleep(100);
  }
  const where = `轨迹 ${trail.join(' → ') || '(一直没变过)'}；收尾请求的真实下场 ${env.counters.doneLog.join(',') || '(一次都没发)'}`
    + `；本台架 refuse=${env.counters.refuseFinish} hang=${env.counters.hangFinish} 端口 ${srv.port} sid ${sender.state.sid}`;
  assert.strictEqual(sender.state.phase, 'done', `没能收尾：${sender.state.phase}（${where}）`);
  assert.strictEqual(sender.state.error, '',
    `进度已经恢复，界面上还挂着"${sender.state.error}" —— 对着用户说假话（${where}）`);
}));

// 取消/销毁过去只关本地会话、只发一句 cancel，服务器上的密文要等 END_KEEP_MS 才清，
// 用户拿不到任何"已经清空了"的回执。这条钉的是：回执必须来自服务器，且拿到回执之后本地记录才许删。
test('取消并销毁：拿到服务器"已清空"的回执之后，才删本地可续传记录', () => withLab({
  slot: 91, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, netTimeoutMs: 4000, parallel: 2 },
}, async ({ env, srv, sender, receiver }) => {
  const size = 1 * MB;
  const code = (await sender.send([{ relPath: 'c.bin', name: 'c.bin', size, mime: 'application/octet-stream', file: fakeFile('c.bin', size, 71) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !sender.state.sentFrames) await sleep(50);
  assert.ok(sender.state.sentFrames > 0, `夹具坏了：一帧都没发出去（phase=${sender.state.phase}）`);
  const sid = sender.state.sid;
  const dir = path.join(srv.dir, 'transfer', sid);
  assert.ok(env.E.listSaved('sender').some((x) => x.sid === sid), '前置：本地得有可续传记录，否则"取消后删记录"是空判据');

  const r = await sender.cancel();
  assert.strictEqual(r.gone, true, `服务器没确认清空：${r.error || '(无错误信息)'}`);
  assert.strictEqual(sender.state.cleanup.confirmed, true, '界面上必须能显示"已确认清空"');
  assert.ok(!fs.existsSync(dir), '服务器目录必须已经不在（回执与磁盘一致）');
  assert.ok(!env.E.listSaved('sender').some((x) => x.sid === sid), '确认清空之后本地记录必须删掉，否则用户还会看到续传入口');
}));

// 用户刷新页面之后，"再也不想传了"这条路也必须走得通：浏览器里只剩记录、会话对象没了。
// 这条模拟的正是刷新后的状态：close() 掉活会话，只用本地记录去请服务器销毁并核对。
test('刷新之后仍能确认清空：只用本地记录就能让服务器删干净', () => withLab({
  slot: 92, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, netTimeoutMs: 4000, parallel: 2 },
}, async ({ env, srv, sender, receiver }) => {
  const size = 1 * MB;
  const code = (await sender.send([{ relPath: 'r.bin', name: 'r.bin', size, mime: 'application/octet-stream', file: fakeFile('r.bin', size, 72) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !sender.state.sentFrames) await sleep(50);
  assert.ok(sender.state.sentFrames > 0, '夹具坏了：一帧都没发出去');
  const sid = sender.state.sid;
  await receiver.cancel().catch(() => {}); // 另一端先走开，模拟"两个标签页都重载了"
  sender.close();                          // 活会话没了，只剩 localStorage 里的记录
  const list = env.E.listSaved('sender');
  assert.ok(list.some((x) => x.sid === sid), '前置：记录要还在（刷新后靠它）');

  const r = await env.E.purgeSaved('sender', sid);
  assert.strictEqual(r.gone, true, `刷新后没能确认清空：${r.error || '(无错误信息)'}`);
  assert.ok(!fs.existsSync(path.join(srv.dir, 'transfer', sid)), '服务器目录必须已经不在');
  assert.ok(!env.E.listSaved('sender').some((x) => x.sid === sid), '确认之后本地记录才许删除');
}));

// 用户点"续传"过去必失败：listSaved 只给展示字段，没有 keys，send() 直接报"密钥本地已经没了"。
// 这条钉三件事：记录必须带 keys；文件没变时不许再算一遍指纹；接着传真的能跑到校验通过。
test('发送端续传：刷新后能接上原会话，同一批文件不重算指纹', () => withLab({
  slot: 93, drainRate: 2 * MB, cfg: { p2pTimeoutMs: 600, netTimeoutMs: 4000, parallel: 2 },
}, async ({ env, sender, receiver, cfg }) => {
  const size = 3 * MB;
  const list = [{ relPath: 'a.bin', name: 'a.bin', size, mime: 'application/octet-stream', file: fakeFile('a.bin', size, 91) }];
  const code = (await sender.send(list)).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && sender.state.sentFrames < 4) await sleep(50);
  assert.ok(sender.state.sentFrames >= 4, `前置：至少要先发出去几块（现在 ${sender.state.sentFrames}）`);
  const it = env.E.listSaved('sender').find((x) => x.sid === sender.state.sid);
  assert.ok(it && it.record && it.record.keys, '本地记录里必须带 keys，否则界面点"续传"永远是"密钥本地已经没了"');
  const fpBefore = env.counters.fingerprints;

  sender.close(); // 模拟刷新：活会话没了，只剩本地记录
  const s2 = env.E.Session({ role: 'sender', on() {}, config: cfg });
  try {
    const r = await s2.send(list, { record: it.record });
    assert.strictEqual(r.resumed, true, '必须走"接上原会话"这条路');
    assert.strictEqual(env.counters.fingerprints, fpBefore, '文件没变时续传不许重算指纹（2GB 全靠这一条）');

    const st = await waitVerified(receiver, 60000);
    assert.ok(st.verified, `续传之后没跑完：phase=${st.phase} error=${st.error}`);
  } finally {
    // 测试自己开的会话要自己关：SSE 连接会把跑测进程吊住（判据先红时也必须关）
    s2.close();
  }
}));

// 2GB 的指纹要算很久。码不该等它：先给码、指纹后台算，清单帧发送前再等摘要。
test('先给码后算指纹：码在指纹算完之前就能用，接收端照样收到完整清单', () => withLab({
  slot: 94, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, netTimeoutMs: 4000 },
}, async ({ env, sender, receiver }) => {
  env.counters.slowFingerprintMs = 1500;
  const size = 1 * MB;
  const t0 = Date.now();
  const { code } = await sender.send([{ relPath: 'h.bin', name: 'h.bin', size, mime: 'application/octet-stream', file: fakeFile('h.bin', size, 92) }]);
  const elapsed = Date.now() - t0;
  assert.ok(code, '码必须拿到');
  assert.strictEqual(env.counters.fingerprints, 1, '指纹必须已经开始算，而不是压根没启动');
  assert.ok(sender.state.fpDone < sender.state.fpTotal,
    `send() 返回时指纹还没算完，才证明"码不等指纹"（fp=${sender.state.fpDone}/${sender.state.fpTotal}，用了 ${elapsed}ms）`);
  await receiver.accept(code);
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `指纹算完后应正常传完：phase=${st.phase} error=${st.error}`);
}));

// 过期/被销毁之后点续传：过去会挂在"连接中"无限重连。现在必须直说"已经结束、需要重发"。
test('会话已过期时，续传要直说"服务器已清空、需要重发"，不许无限连接中', () => withLab({
  slot: 95, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600, netTimeoutMs: 4000, parallel: 2 },
}, async ({ env, sender, receiver, cfg }) => {
  const size = 1 * MB;
  const list = [{ relPath: 'e.bin', name: 'e.bin', size, mime: 'application/octet-stream', file: fakeFile('e.bin', size, 93) }];
  const code = (await sender.send(list)).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && sender.state.sentFrames < 2) await sleep(50);
  const it = env.E.listSaved('sender').find((x) => x.sid === sender.state.sid);
  assert.ok(it, '前置：本地要有记录');
  sender.close();
  const gone = await env.E.purgeSaved('sender', it.sid);
  assert.strictEqual(gone.gone, true, '前置：先把服务器这一单清掉');

  const s2 = env.E.Session({ role: 'sender', on() {}, config: cfg });
  try {
    await assert.rejects(() => s2.send(list, { record: it.record }), /已经结束（过期或已被清空）[^]*重发/,
      '过期后的续传必须给出一条可操作的话，而不是一个永远转的连接中');
  } finally { s2.close(); }
}));

// 会话续期必须真的在跑：页面开着（含后台节流）时，2GB 不该因为"30 分钟没动"作废
test('会话续期：传输期间客户端会定时 keep，并把新的过期时间反映到状态里', () => withLab({
  slot: 96, drainRate: 2 * MB, cfg: { p2pTimeoutMs: 600, netTimeoutMs: 4000, keepMs: 300 },
}, async ({ env, sender, receiver }) => {
  const size = 2 * MB;
  const code = (await sender.send([{ relPath: 'k.bin', name: 'k.bin', size, mime: 'application/octet-stream', file: fakeFile('k.bin', size, 94) }])).code;
  await receiver.accept(code);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && (env.counters.byPath['POST /api/xfer/keep'] || 0) < 2) await sleep(100);
  const n = env.counters.byPath['POST /api/xfer/keep'] || 0;
  assert.ok(n >= 2, `续期请求没发出来（只发了 ${n} 次）——后台标签页省电节流时，这就是会话被判过期的原因`);
  assert.ok(sender.state.expiresAt > t0, '状态里的过期时间要被续期推后');
  await waitVerified(receiver, 30000);
}));

// ---------------------------------------------------------------------------
// 下面三条是 2GB 现场的直接对症：慢、断、以及"标签页不在前台就停"。
// ---------------------------------------------------------------------------

// 4MB/s 的根因不是带宽也不是加密，而是**接收端一帧一个来回**：128KiB/次、上一帧回来才发下一帧。
// 这里给每一帧的往返加 120ms 延时，把"串行"与"并发"的差别放大到可判定的程度。
test('接收端拉中转必须并发：一帧一个来回会把吞吐钉在 RTT 上（4MB/s 的根因）', () => withLab({
  slot: 97, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 300, netTimeoutMs: 20000 },
}, async ({ env, sender, receiver }) => {
  env.counters.slowGetMs = 120;
  const size = 8 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  const code = (await sender.send([{ relPath: 'p.bin', name: 'p.bin', size, mime: 'application/octet-stream', file: fakeFile('p.bin', size, 61) }])).code;
  await receiver.accept(code);
  const st = await waitVerified(receiver, 90000);
  assert.ok(st.verified, `没传完：phase=${st.phase} error=${st.error}`);
  assert.strictEqual(sender.state.channel, 'server_relay', '夹具坏了：这条腿要的是纯中转');
  assert.ok(env.counters.segGetPeak >= 4,
    `同时在飞的拉取最多只有 ${env.counters.segGetPeak} 个（共 ${frames} 帧、${env.counters.segGet} 次 GET）：`
    + '并发取回来的块按序号落盘，顺序不该成为串行的理由');
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 61)),
    '并发取回之后装配结果必须不变');
}));

// "8 秒没建起直连"曾经等于"整场都走中转"：超时那一下直接把 pc close 了。
// 但 ICE 重选、防火墙提示、STUN 慢一点都会让直连晚到 —— 晚到也该用上。
test('直连超时先走中转，但直连晚到时必须切回 p2p（不许提前把 pc 掐死）', () => withLab({
  slot: 98, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 400 },
}, async ({ link, env, sender, receiver }) => {
  const size = 4 * MB;
  const code = (await sender.send([{ relPath: 'l.bin', name: 'l.bin', size, mime: 'application/octet-stream', file: fakeFile('l.bin', size, 62) }])).code;
  await receiver.accept(code);
  await sleep(900); // 让 400ms 的直连超时先发生
  assert.strictEqual(sender.state.channel, 'server_relay', '夹具坏了：超时之后应当已经改标中转');
  assert.notStrictEqual(link.aCh.readyState, 'closed',
    'pc 在超时那一下就被关掉了：晚到的直连再也没有机会接上（这就是"局域网还走中转"的一半成因）');

  link.connect(); // 直连"晚到"
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && sender.state.channel !== 'p2p') await sleep(50);
  assert.strictEqual(sender.state.channel, 'p2p',
    `直连后来真的开了，通道标识却还停在 ${sender.state.channel}（界面上就是"明明同一局域网还在中转"）`);
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `切回直连后没传完：phase=${st.phase} error=${st.error}`);
  assert.deepStrictEqual(Buffer.from(await collectedBytes(receiver)), Buffer.from(expectBytes(size, 62)),
    '中途切换通道不许丢块或错位');
}));

// Chrome 的 Page Lifecycle 会冻结后台标签页：定时器停、SSE 不读、pump 不动，
// 60 秒后看门狗就把这一单判成"卡住了"—— 用户说的"标签页没在最前面就断了"正是这一档。
// 持有一把 Web Lock 是官方给的豁免条件，所以引擎一开会话就必须去要它。
test('会话开始必须持一把 Web Lock：否则后台标签页会被冻结，传输静默停摆', () => withLab({
  slot: 99, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600 },
}, async ({ env, sender, receiver }) => {
  const size = 1 * MB;
  const code = (await sender.send([{ relPath: 'w.bin', name: 'w.bin', size, mime: 'application/octet-stream', file: fakeFile('w.bin', size, 63) }])).code;
  const locks = env.counters.locks;
  assert.ok(locks.some((l) => l.name.includes(sender.state.sid) && l.mode === 'exclusive'),
    `没有向浏览器要"别冻结我"的那把锁：${JSON.stringify(locks)}`);
  await receiver.accept(code);
  const st = await waitVerified(receiver, 60000);
  assert.ok(st.verified, `没传完：phase=${st.phase} error=${st.error}`);
}));

// 2.5GB 的"校验"和"写盘"各是几十秒到几分钟的活。以前这两段**一个进度数字都不给**，
// 界面上只有一句静态的"正在逐块校验"，用户的原话就是"卡了很久，最后才弹出保存按钮"。
// 这条腿盯的是：这两个相位必须持续往外推帧级进度，界面才有东西可画。
test('校验与写盘都要往外报进度：不能只有一句"正在加载"，那是卡死的长相', () => withLab({
  slot: 101, drainRate: 8 * MB, cfg: { p2pTimeoutMs: 600 },
}, async ({ env, sender, cfg }) => {
  const size = 8 * MB;
  const frames = Math.ceil(size / FRAME) + 1;
  const trace = [];
  const rx = env.E.Session({ role: 'receiver', on(st) { trace.push(st); }, config: cfg });
  try {
    const code = (await sender.send([{ relPath: 'v.bin', name: 'v.bin', size, mime: 'application/octet-stream', file: fakeFile('v.bin', size, 71) }])).code;
    await rx.accept(code);
    const t0 = Date.now();
    while (Date.now() - t0 < 90000 && !rx.state.verified && rx.state.phase !== 'failed') await sleep(50);
    assert.ok(rx.state.verified, `没校验通过：phase=${rx.state.phase} error=${rx.state.error}`);

    const vPts = trace.filter((s) => s.phase === 'verifying' && s.verifyTotal > 0);
    assert.ok(vPts.length >= 3, `校验阶段只报了 ${vPts.length} 次进度（共 ${frames} 帧）：界面无从画百分比`);
    // 0 号是加密清单，复核时不再走它 —— 总数要比帧数少一，否则进度永远差一块、停在 98%
    assert.strictEqual(vPts[vPts.length - 1].verifyTotal, frames - 1, '复核总块数要如实（不含清单帧）');
    assert.ok(vPts.some((s) => s.verifyDone > 0 && s.verifyDone < frames - 1), '没有任何一次"中间进度" —— 等于只有 0 和 100 两个数');

    await rx.saveAll(null);
    const sPts = trace.filter((s) => s.phase === 'saving' && s.saveTotal > 0);
    assert.ok(sPts.length >= 3, `写盘阶段只报了 ${sPts.length} 次进度：界面会一直停在"正在解密写盘"`);
    assert.strictEqual(Math.max(...sPts.map((s) => s.saveDone)), frames - 1, '写盘进度没有走到 100%');

    const [one] = await rx.collected();
    assert.deepStrictEqual(Buffer.from(await one.blob.arrayBuffer()), Buffer.from(expectBytes(size, 71)), '内容不对');
  } finally {
    try { rx.close(); } catch { /* 已经关了 */ }
  }
}));
