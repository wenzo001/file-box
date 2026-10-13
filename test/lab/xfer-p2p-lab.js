// 无痕传输真链路实验室（不属于 npm test：需要本机 chromium，跑法见文件末尾）
//
// 它要回答的问题只有一个：**P2P 正常的时候，服务器有没有收到本不该发的中转写入？**
// 判据分三条，缺一不可：
//   B 先证明"背压现场真的成立"（max bufferedAmount 越过 4MB 高水位）——
//     没有这条，C 就是空对空绿：链路从没被堵住过，当然一个中转包都不发。
//   C 再证明中转写入次数在"只有建链前那几帧"的量级内。
//   A 保证传输本身是成功的（否则 B/C 都没意义）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../helpers');

const EXE_CANDIDATES = [
  process.env.XFER_LAB_CHROME,
  'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe',
].filter(Boolean);
const arg = (k, d) => { const m = process.argv.find((s) => s.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const MB = Number(arg('mb', 24));                 // 单文件大小：24MB = 192 帧
const THROTTLE = Number(arg('throttle', 12));     // 接收端 CPU 降速倍数：制造真背压
const WAIT_MS = Number(arg('wait', 180000));
const RELAY_TOLERANCE = Number(arg('relay-max', 12)); // 允许的中转写入帧数（建链前的那几帧）

function findChromium() {
  for (const p of EXE_CANDIDATES) if (p && fs.existsSync(p)) return p;
  const root = 'C:/Users/lhcz-fu/AppData/Local/ms-playwright';
  try {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const p = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 没有 ms-playwright 目录 */ }
  return null;
}

async function main() {
  const exe = findChromium();
  if (!exe) throw new Error('找不到可用的 chromium：设 XFER_LAB_CHROME=<chrome.exe> 再跑');
  const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xferlab-'));
  const srv = await startServer({ XFER_CREATE_LIMIT: '1000' }, dir, 61);
  const browser = await chromium.launch({ executablePath: exe });
  const report = { file: `${MB}MB`, frames: Math.ceil((MB * 1048576) / 131072), throttle: THROTTLE };
  const segPuts = [];
  let senderPage = null;

  try {
    const ctxA = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const ctxB = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const pa = await ctxA.newPage(); const pb = await ctxB.newPage();
    senderPage = pa;
    pa.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('/api/xfer/seg')) {
        segPuts.push({ at: Date.now(), i: Number(new URL(r.url()).searchParams.get('i')) });
      }
    });
    const errs = [];
    pa.on('pageerror', (e) => errs.push('sender: ' + e.message));
    pb.on('pageerror', (e) => errs.push('receiver: ' + e.message));

    for (const p of [pa, pb]) await p.goto(`${srv.base}/transfer.html`, { waitUntil: 'load' });

    const cdp = await ctxB.newCDPSession(pb);
    const setThrottle = async (rate) => { await cdp.send('Emulation.setCPUThrottlingRate', { rate }); };

    // 在发送端挂观察点：记录每次 dc.send 时的 bufferedAmount（只读，不改行为）
    await pa.evaluate(() => {
      window.__probe = { buffered: [] };
      const orig = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (...a) {
        const dc = orig.apply(this, a);
        const send = dc.send.bind(dc);
        dc.send = (b) => { window.__probe.buffered.push(dc.bufferedAmount); return send(b); };
        return dc;
      };
    });

    const size = MB * 1048576;
    const started = await pa.evaluate(async ({ size }) => {
      const block = new Uint8Array(1048576);
      for (let i = 0; i < block.length; i++) block[i] = i & 255;
      const parts = [];
      for (let i = 0; i < size / 1048576; i++) parts.push(block);
      const file = new File(parts, 'big.bin', { type: 'application/octet-stream' });
      window.s = window.XferEngine.Session({ role: 'sender', on() {} });
      const r = await window.s.send([{ relPath: 'big.bin', name: 'big.bin', size: file.size, mime: file.type, file }]);
      return r.code;
    }, { size });

    const recv = await pb.evaluate(async ({ code }) => {
      window.r = window.XferEngine.Session({ role: 'receiver', on() {} });
      window.r.accept(code).catch(() => {});
      return true;
    }, { code: started });
    if (!recv) throw new Error('接收端没起来');

    // 等建链出结果再降速：建链阶段就把接收端 CPU 压住，ICE 协商会超过 8s 的直连耐心，
    // 量到的就不是"背压被误判成断线"，而是"根本没连上"。
    const t1 = Date.now();
    let ch = '';
    while (Date.now() - t1 < Number(arg('link-wait', 25000))) {
      ch = await pa.evaluate(() => window.s.state.channel);
      if (ch === 'p2p' || ch === 'turn_relay' || ch === 'server_relay') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    report.channelAtLink = ch;
    if (THROTTLE > 1) await setThrottle(THROTTLE);

    const t0 = Date.now();
    let snap = {};
    while (Date.now() - t0 < WAIT_MS) {
      snap = await pb.evaluate(() => ({ phase: window.r.state.phase, stored: window.r.state.stored, frames: window.r.state.frames, verified: window.r.state.verified, error: window.r.state.error }));
      if (snap.verified || snap.phase === 'failed') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    report.receiver = snap;
    report.elapsedS = +((Date.now() - t0) / 1000).toFixed(1);
    report.sender = await pa.evaluate(() => ({
      phase: window.s.state.phase, channel: window.s.state.channel,
      sentFrames: window.s.state.sentFrames, bytesOnWire: window.s.state.bytesOnWire,
      maxBuffered: Math.max(0, ...(window.__probe.buffered.length ? window.__probe.buffered : [0])),
      dcSends: window.__probe.buffered.length,
    }));
    report.segPuts = segPuts.length;
    const sid = (await pa.evaluate(() => window.s.state.sid));
    const tdir = path.join(dir, 'transfer', sid);
    report.segFiles = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => /^seg-\d+\.bin$/.test(f)).length : 0;
    report.transferBytesOnDisk = fs.existsSync(tdir)
      ? fs.readdirSync(tdir).filter((f) => /^seg-/.test(f)).reduce((s, f) => s + fs.statSync(path.join(tdir, f)).size, 0) : 0;
    report.pageErrors = errs;

    report.gates = {
      A_传输完成: !!snap.verified,
      B_背压现场成立: report.sender.maxBuffered > 4 * 1024 * 1024,
      C_中转写入受限: report.segPuts <= RELAY_TOLERANCE,
    };
    console.log(JSON.stringify(report, null, 1));
    const ok = report.gates.A_传输完成 && report.gates.B_背压现场成立 && report.gates.C_中转写入受限;
    console.log(ok
      ? `LAB PASS：P2P 下 max bufferedAmount=${(report.sender.maxBuffered / 1048576).toFixed(1)}MB 越过 4MB 高水位，中转写入只有 ${report.segPuts} 帧`
      : `LAB FAIL：A=${report.gates.A_传输完成} B=${report.gates.B_背压现场成立}(maxBuffered=${(report.sender.maxBuffered / 1048576).toFixed(1)}MB) C=${report.gates.C_中转写入受限}(segPuts=${report.segPuts}/${report.frames} 帧, 容差 ${RELAY_TOLERANCE})`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
main().catch((e) => { console.error('LAB ERROR', e); process.exitCode = 2; });

// 跑法：node test/lab/xfer-p2p-lab.js [--mb=24] [--throttle=12] [--relay-max=12]
