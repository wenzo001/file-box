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
  const srv = await startServer({ XFER_CREATE_LIMIT: '1000' }, null, opts.slot);
  const link = makeLink({ drainRate: opts.drainRate });
  const env = boot({ link, base: srv.base });
  const sender = env.E.Session({ role: 'sender', on() {} });
  const receiver = env.E.Session({ role: 'receiver', on() {} });
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
