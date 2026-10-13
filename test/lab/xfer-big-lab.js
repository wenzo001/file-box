// 无痕传输大文件 / 断点续传真链路实验室（不属于 npm test：需要本机 chromium，跑法见文件末尾）
//
// 与 xfer-p2p-lab.js 的分工：那个答"P2P 正常时服务器有没有多余写入"，这个答
// "600MB 量级真在两个浏览器上下文之间走一遍，端到端字节是否一致、内存是否有界、
// 中途掉线/刷新/重启之后是否还能续上"。
//
// 所有判据打在引擎状态 + 服务器磁盘 + 落盘文件的实测值上，不打在界面文案上。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { startServer } = require('../helpers');

const arg = (k, d) => { const m = process.argv.find((s) => s.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const SCENARIO = arg('scenario', 'basic');
const MB = Number(arg('mb', 600));
const DO_SAVE = arg('save', SCENARIO === 'save' ? '1' : '0') === '1';
const WAIT_MS = Number(arg('wait', 900000));
const HEAP_BUDGET_MB = Number(arg('heap', 200));   // 浏览器 JS 堆峰值上限：整文件进内存必然冲破
const RSS_BUDGET_MB = Number(arg('rss', 500));     // 服务器进程 RSS 上限
const SIZE = MB * 1048576;

const EXES = [process.env.XFER_LAB_CHROME, 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe'].filter(Boolean);
function findChromium() {
  for (const p of EXES) if (p && fs.existsSync(p)) return p;
  const root = 'C:/Users/lhcz-fu/AppData/Local/ms-playwright';
  try {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const p = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 没装 playwright 浏览器 */ }
  return null;
}

/** 内容可复现且处处不同；顺手算出与浏览器无关的两条参照值：
 *  sha   —— 整文件 SHA-256（下载落盘后对得上就说明字节没变）
 *  chain —— 引擎那套"逐 128KiB 块哈希再串起来哈希"（发送端指纹 / 接收端校验都对得上） */
function makeSource(dir, size) {
  const p = path.join(dir, 'big.bin');
  const hash = crypto.createHash('sha256');
  let state = crypto.createHash('sha256').update(Buffer.from([1])).digest();
  const fd = fs.openSync(p, 'w');
  let written = 0;
  while (written < size) {
    const n = Math.min(1048576, size - written);
    const buf = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      state = crypto.createHash('sha256').update(state).digest();
      const take = Math.min(32, n - at);
      state.copy(buf, at, 0, take);
      at += take;
    }
    fs.writeSync(fd, buf, 0, n);
    hash.update(buf);
    written += n;
  }
  fs.closeSync(fd);
  const chain = [];
  const rfd = fs.openSync(p, 'r');
  let off = 0;
  while (off < size) {
    const len = Math.min(131072, size - off);
    const b = Buffer.allocUnsafe(len);
    fs.readSync(rfd, b, 0, len, off);
    chain.push(crypto.createHash('sha256').update(b).digest());
    off += len;
  }
  fs.closeSync(rfd);
  return { p, sha: hash.digest('hex'), chain: crypto.createHash('sha256').update(Buffer.concat(chain)).digest('hex'), size };
}

function dirBytes(p) {
  let total = 0;
  try {
    for (const n of fs.readdirSync(p)) {
      const f = path.join(p, n);
      const st = fs.lstatSync(f);
      total += st.isDirectory() ? dirBytes(f) : st.size;
    }
  } catch { /* 还没生成 */ }
  return total;
}

/** 服务器进程 RSS：tasklist 的 MEM_USAGE 列（KiB）。取不到就报 0，不假装量到了 */
function rssMb(pid) {
  try {
    const out = cp.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'latin1' });
    const cols = out.trim().split('","');
    if (cols.length < 5) return 0;
    return Math.round(Number(String(cols[4]).replace(/[^\d]/g, '')) / 1024);
  } catch { return 0; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 独立校验：不碰引擎的 finishReceive，也不走"整文件进内存"的下载兜底 ——
 *  直接从 IndexedDB 读回每一帧密文，用本地存的会话密钥逐帧解开，按同一套哈希链算一遍。
 *  这一条既是大文件端到端的字节证明，也是对"引擎自己说校验通过"的第三方复核。 */
const independentHashScript = () => ({
  // 在页面里跑的那段：清单帧(0) 用 kMeta 解开，其余按清单里的 chunks 长度逐块解
  fn: async () => {
    const P = window.XferProto;
    const E = window.XferEngine;
    const rec = Object.values(JSON.parse(localStorage.getItem('fb.xfer.receiver') || '{}'))[0];
    if (!rec || !rec.keys) return { err: '本地没有密钥记录，独立复核无从下手' };
    // 传输码是分组的（每 4 字符一个 -），所以只能用协议自己的解析器取 sid，
    // 直接 split('-')[0] 只会拿到前 4 个字符 —— 那样每一帧都读不到，报"帧太短"
    const parsed = P.parseCode(rec.code);
    const sid = parsed && parsed.sid;
    if (!sid) return { err: '本地存的传输码解析不出 sid' };
    const kRec = P.unhex(rec.keys.kRec), kMeta = P.unhex(rec.keys.kMeta), sid8 = P.unhex(rec.keys.sid8);
    const mf0 = await E.Store.get(sid, 0);
    if (!mf0 || !mf0.length) return { err: '清单帧(seq 0)本地读不到，独立复核没法起步' };
    const man = await P.open({ key: kMeta, sid8, frame: new Uint8Array(mf0) });
    const mf = JSON.parse(new TextDecoder().decode(man.plaintext));
    let seq = 1;
    let bytes = 0;
    const fileShas = [];
    for (const f of mf.files) {
      const key = await P.hkdf(kRec, sid8, `file-v1|${sid}|${f.id}`, 32);
      const chain = [];
      for (let c = 0; c < f.chunks.length; c++) {
        const got = await E.Store.get(sid, seq + c);
        if (!got || !got.length) return { err: `第 ${f.id} 个文件的第 ${c} 块本地读不到` };
        const pt = new Uint8Array((await P.open({ key, sid8, frame: new Uint8Array(got) })).plaintext);
        if (pt.length !== f.chunks[c]) return { err: `第 ${f.id}/${c} 块长度 ${pt.length} ≠ 清单里的 ${f.chunks[c]}` };
        chain.push(await P.sha256(pt));
        bytes += pt.length;
      }
      seq += f.chunks.length;
      fileShas.push(P.hex(await P.sha256(P.cat(...chain))));
    }
    return { fileShas, manifestShas: mf.files.map((f) => f.sha256), bytes, frames: seq };
  },
});

async function main() {
  const exe = findChromium();
  if (!exe) throw new Error('找不到可用的 chromium：设 XFER_LAB_CHROME=<chrome.exe> 再跑');
  const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xferbig-'));
  const ttlMin = SCENARIO === 'expired' ? '0.2' : '30';
  let srv = await startServer({
    XFER_TTL_MINUTES: ttlMin,
    XFER_LIMIT_GB: String(Math.ceil(SIZE / 1024 ** 3) + 2),
    XFER_CREATE_LIMIT: '1000',
    XFER_END_KEEP_MS: '10000',   // 默认 60 秒太长，实验室要在合理时间内看到"完成即清"
  }, dir, 71);

  const browser = await chromium.launch({ executablePath: exe });
  const rep = { scenario: SCENARIO, mb: MB, frames: Math.ceil(SIZE / 131072), startedAt: new Date().toISOString() };
  const src = makeSource(dir, SIZE);
  rep.sourceSha256 = src.sha;
  rep.sourceChainSha = src.chain;
  const segPuts = [];
  const segGets = [];
  const pageErrs = [];
  const peak = { A: 0, B: 0 };
  let srvRssPeak = 0;
  let relayPeakMB = 0;
  let senderLsSha = '';
  let sampler = null, diskSampler = null;
  let ctxA, ctxB, pa, pb;

  const newReceiverPage = async () => {
    if (pb) { try { await pb.close(); } catch { /* 已经关了 */ } }
    pb = await ctxB.newPage();
    pb.on('pageerror', (e) => pageErrs.push('receiver: ' + e.message));
    pb.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/api/xfer/seg')) segGets.push(r.url()); });
    await pb.goto(`${srv.base}/transfer.html`, { waitUntil: 'load' });
    await installHooks(pb);
    return pb;
  };

  // 会话对象本来只在页面模块作用域里；这里换一层薄壳把 api 暴露出来读实测值，不改行为。
  // （FS Access 的兜底说明见 dropFsAccess：那是环境准备，不是这里做的事。）
  const installHooks = (page) => page.evaluate(() => {
    const E = window.XferEngine;
    window.__s = [];
    const orig = E.Session;
    E.Session = function (o) { const s = orig(o); window.__s.push(s); return s; };
  }).catch(() => {});

  // headless 里没有"取消原生保存框"的手，留着 showSaveFilePicker 就会一直挂着等一个不点的对话框。
  // 盖成不可用，让 #recv-save 真走移动端/Safari 那条兜底下载路径。
  const dropFsAccess = (ctx) => ctx.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });

  const readState = (page) => page.evaluate(() => {
    const s = window.__s && window.__s[window.__s.length - 1];
    if (!s) return null;
    const st = s.state;
    return {
      phase: st.phase, channel: st.channel, sid: st.sid, frames: st.frames, stored: st.stored,
      sentFrames: st.sentFrames, bytesOnWire: st.bytesOnWire, relayFrames: st.relayFrames,
      dcFrames: st.dcFrames, verified: st.verified, error: st.error || '', note: st.note || '',
      firstFileSha: (st.files && st.files[0] && st.files[0].sha256) || '',
    };
  }).catch(() => null);

  const sampleMem = async () => {
    const m = await Promise.all([
      cdpA.send('Performance.getMetrics').catch(() => null),
      cdpB ? cdpB.send('Performance.getMetrics').catch(() => null) : Promise.resolve(null),
    ]);
    const pick = (x) => { const f = x && x.metrics && x.metrics.find((k) => k.name === 'JSHeapUsedSize'); return f ? f.value : 0; };
    peak.A = Math.max(peak.A, pick(m[0]));
    peak.B = Math.max(peak.B, pick(m[1]));
    srvRssPeak = Math.max(srvRssPeak, rssMb(srv.child.pid));
  };
  // 中转区的峰值要在传输途中量：收尾一 done，服务器 60 秒后就把整个会话清了
  const sampleDisk = async () => {
    relayPeakMB = Math.max(relayPeakMB, dirBytes(path.join(dir, 'transfer')) / 1048576);
    if (!senderLsSha) {
      const v = await pa.evaluate(() => {
        const all = JSON.parse(localStorage.getItem('fb.xfer.sender') || '{}');
        const rec = Object.values(all).find((x) => x && x.files && x.files.length);
        return rec ? rec.files[0].sha256 : '';
      }).catch(() => '');
      if (v) senderLsSha = v;
    }
  };

  let cdpA = null, cdpB = null;
  let code = '';
  let finished = false;
  let crashNote = '';

  try {
    ctxA = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    ctxB = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    await dropFsAccess(ctxA); await dropFsAccess(ctxB);
    pa = await ctxA.newPage();
    pa.on('pageerror', (e) => pageErrs.push('sender: ' + e.message));
    pa.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/xfer/seg')) segPuts.push(r.url()); });
    await pa.goto(`${srv.base}/transfer.html`, { waitUntil: 'load' });
    await pa.evaluate(() => {
      const E = window.XferEngine;
      window.__s = [];
      const orig = E.Session;
      E.Session = function (o) { const s = orig(o); window.__s.push(s); return s; };
    });
    cdpA = await ctxA.newCDPSession(pa);
    await cdpA.send('Performance.enable');
    await newReceiverPage();
    cdpB = await ctxB.newCDPSession(pb);
    await cdpB.send('Performance.enable');

    rep.caps = await pa.evaluate(() => window.XferEngine.capabilities());

    // ---------- 发送端：真选文件（走 <input type=file>，Chromium 里 File 由磁盘句柄支撑） ----------
    await pa.click('#tab-send');
    await pa.setInputFiles('#pick-in', src.p);
    await pa.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 20000 });
    const t0 = Date.now();
    await pa.click('#start');
    await pa.waitForFunction(() => {
      const t = document.querySelector('#send-code').textContent.trim();
      return /^[a-z0-9]{4,8}-[a-z0-9-]+$/.test(t) || document.querySelector('#send-status').textContent.includes('失败');
    }, null, { timeout: 300000 }); // 600MB 的指纹要先算完才出码
    code = await pa.evaluate(() => document.querySelector('#send-code').textContent.trim());
    rep.codeReadyS = +((Date.now() - t0) / 1000).toFixed(1);

    // ---------- 接收端：真输码 ----------
    await pb.click('#tab-recv');
    await pb.fill('#recv-in', code);
    await pb.click('#recv-go');

    // 配对之后立刻看一眼两端的本地续传记录：发送方那份是"刷新后接着传"的依据，
    // 没有它就没有恢复可言（resumable 是 writeLs 的返回值，能区分"没写"和"写了但读不到"）
    await sleep(4000);
    rep.lsProbe = {
      sender: await pa.evaluate(() => ({
        resumable: window.__s[window.__s.length - 1].state.resumable,
        raw: (localStorage.getItem('fb.xfer.sender') || '').slice(0, 120),
      })).catch((e) => ({ err: e.message })),
      receiver: await pb.evaluate(() => ({
        resumable: window.__s[window.__s.length - 1].state.resumable,
        raw: (localStorage.getItem('fb.xfer.receiver') || '').slice(0, 120),
      })).catch((e) => ({ err: e.message })),
    };

    sampler = setInterval(() => { sampleMem().catch(() => {}); }, 1000);
    diskSampler = setInterval(() => { sampleDisk().catch(() => {}); }, 10000);

    // ---------- 场景注入：中途刷新 / 断网 / 重启 / 过期 ----------
    const progress = async () => (await readState(pb, 'receiver')) || {};
    if (SCENARIO === 'refresh' || SCENARIO === 'restart' || SCENARIO === 'netdrop') {
      while (true) {
        const st = await progress();
        if (!st.phase) break;
        if ((st.stored || 0) > (st.frames || 1) * 0.25) break;
        if (st.verified || st.phase === 'failed') break;
        await sleep(700);
      }
      rep.injectAtStored = (await progress()).stored;
    }
    if (SCENARIO === 'refresh') {
      await pb.reload({ waitUntil: 'load' });
      await installHooks(pb);
      await pb.click('#tab-recv');
      await pb.fill('#recv-in', code);
      await pb.click('#recv-go');
      rep.refreshed = true;
    } else if (SCENARIO === 'netdrop') {
      await ctxA.setOffline(true);
      rep.offlineFor = 8000;
      await sleep(8000);
      await ctxA.setOffline(false);
    } else if (SCENARIO === 'restart') {
      await srv.stop({ keep: true });
      srv = await startServer({
        XFER_TTL_MINUTES: ttlMin, XFER_LIMIT_GB: String(Math.ceil(SIZE / 1024 ** 3) + 2),
        XFER_CREATE_LIMIT: '1000', XFER_END_KEEP_MS: '10000',
      }, dir, 71);
      rep.restartedOn = srv.base;
    } else if (SCENARIO === 'expired') {
      const runSid = await pa.evaluate(() => window.__s[window.__s.length - 1].state.sid);
      await pb.close(); pb = null;
      await pa.click('#send-pause');
      await sleep(Number(arg('expire-wait', 16000)));
      await newReceiverPage();
      cdpB = await ctxB.newCDPSession(pb);
      await pb.click('#tab-recv');
      await pb.fill('#recv-in', code);
      await pb.click('#recv-go');
      await sleep(3000);
      rep.expiredText = await pb.evaluate(() => document.querySelector('#toast').textContent.trim());
      rep.expiredState = await readState(pb);
      rep.expiredSidDirGone = !fs.existsSync(path.join(dir, 'transfer', runSid));
      rep.senderAfterExpire = await readState(pa);
      finished = true;
    }

    // ---------- 等收尾 ----------
    const t1 = Date.now();
    let last = {};
    while (!finished && Date.now() - t1 < WAIT_MS) {
      last = (await readState(pb, 'receiver')) || {};
      if (last.verified || last.phase === 'failed') break;
      await sleep(1500);
    }
    rep.receiver = last;
    rep.sender = await readState(pa, 'sender');
    rep.elapsedS = +((Date.now() - t0) / 1000).toFixed(1);
    const t2 = Date.now();
    rep.independent = await pb.evaluate(independentHashScript().fn).catch((e) => ({ err: '复核没跑成：' + e.message }));
    rep.independentMs = Date.now() - t2;
    // 本地续传记录里的指纹（发送端对磁盘文件逐块哈希链出来的那份）在 done 之后会被清掉
    // —— 那是正确行为（完成的任务不必再续），所以要在途中由 sampleDisk 抓下来
    rep.senderChainSha = senderLsSha;
    rep.senderLsRaw = await pa.evaluate(() => (localStorage.getItem('fb.xfer.sender') || '').slice(0, 160)).catch(() => '读不到');
    if (SCENARIO === 'basic' || SCENARIO === 'save') {
      // 接收端的直连耐心是 8 秒：到点必须自己改标，不能让用户界面一直停在"正在尝试直连"
      await sleep(9500);
      rep.receiverChannelAfterPatience = (await readState(pb) || {}).channel;
    }

    // ---------- 落盘：走"无 FS Access"的下载兜底，拿到的是真文件 ----------
    if (DO_SAVE && last.verified) {
      const dl = path.join(dir, 'out.bin');
      const got = new Promise((resolve, reject) => {
        pb.once('download', async (d) => {
          try { await d.saveAs(dl); resolve(d); } catch (e) { reject(e); }
        });
        setTimeout(() => reject(new Error('没等到下载')), 300000);
      });
      await pb.click('#recv-save');
      try { await got; rep.savedTo = dl; rep.savedSha256 = crypto.createHash('sha256').update(fs.readFileSync(dl)).digest('hex'); }
      catch (e) { crashNote = 'save: ' + e.message; }
      rep.savedSize = fs.existsSync(dl) ? fs.statSync(dl).size : 0;
    }

    // 发送端指纹：引擎落在 localStorage 里的那份清单（sha256 是对磁盘文件逐块哈希链出来的），
    // 和 Node 自己算的参照值对上，才说明"浏览器读到的就是盘上那份"
    rep.senderChainSha = Array.isArray(rep.senderLs) && rep.senderLs[0] ? rep.senderLs[0].sha : '';

    await sampleMem();
    rep.peakHeap = { senderMB: Math.round(peak.A / 1048576), receiverMB: Math.round(peak.B / 1048576) };
    rep.serverRssPeakMB = srvRssPeak;
    rep.transferDirMB = Math.round(dirBytes(path.join(dir, 'transfer')) / 1048576);
    rep.relayPeakMB = Math.round(relayPeakMB);
    // done 之后服务器只留 END_KEEP 那么久；留够时间再验一次"真的清了"（本实验室把它是设成 10 秒）
    if (last.verified) {
      await sleep(14000);
      rep.relayDirAfterCleanupMB = Math.round(dirBytes(path.join(dir, 'transfer')) / 1048576);
    }
    // 浏览器侧落盘量：IndexedDB 里那批密文帧占的存储（profile 目录拿不到，问浏览器自己）
    rep.browserStorageMB = pb
      ? Math.round(((await pb.evaluate(() => navigator.storage.estimate().then((e) => e.usage || 0)).catch(() => 0))) / 1048576)
      : -1;
    rep.segPuts = segPuts.length;
    rep.segGets = segGets.length;
    rep.pageErrors = pageErrs.slice(0, 6);
    rep.crashNote = crashNote;
    // 失败时要有东西可看：界面文案只作诊断线索，判据一律打在上面的实测值上
    rep.ui = {
      send: await pa.evaluate(() => document.querySelector('#send-status').textContent.trim()).catch(() => ''),
      sendChan: await pa.evaluate(() => document.querySelector('#send-chan-t').textContent.trim()).catch(() => ''),
      recv: pb ? await pb.evaluate(() => document.querySelector('#recv-status').textContent.trim()).catch(() => '') : '',
      recvChan: pb ? await pb.evaluate(() => document.querySelector('#recv-chan-t').textContent.trim()).catch(() => '') : '',
    };
    rep.srvLogTail = srv.log().split(/\r?\n/).slice(-6).join(' / ');
    rep.throughputMBs = +(SIZE / 1048576 / rep.elapsedS).toFixed(2);

    const indep = rep.independent || {};
    // 主判据：把 IndexedDB 里那批密文帧逐帧解开重算的哈希链 == Node 在源文件上算的参照值，
    // 且解出来的总字节数 == 文件大小。选了落盘的跑法再叠一条"下载下来的文件本身 SHA-256 也对"。
    const shaOk = !!(indep.fileShas && indep.fileShas[0] === src.chain && indep.bytes === SIZE)
      && (!DO_SAVE || rep.savedSha256 === src.sha);
    rep.independentErr = indep.err || '';
    rep.gates = {
      A_传输完成: SCENARIO === 'expired' ? undefined : !!last.verified,
      // 有落盘就按下盘上那份文件独立算 SHA-256（最强的一条）；没有落盘时退一步：
      // 发送端对磁盘文件的指纹 == Node 自己算的哈希链，且接收端逐块重开重算通过
      B_端到端哈希一致: SCENARIO === 'expired' ? undefined : shaOk,
      C_浏览器堆峰值有界: peak.B / 1048576 < HEAP_BUDGET_MB,
      D_服务器内存有界: srvRssPeak > 0 && srvRssPeak < RSS_BUDGET_MB,
      // 中转区峰值应该正好装下这份文件的密文（+35B/帧头 + 清单帧），不多存一遍；
      // 尾巴上的重发会把峰值顶过这条线，所以这条同时也是"没有重复写入"的证据
      E_中转量与文件大小同量级: SCENARIO === 'expired' ? undefined
        : rep.relayPeakMB >= MB * 0.9 && rep.relayPeakMB <= MB + 8,
      // done 之后服务器要把整个会话的密文清干净（本实验室把 XFER_END_KEEP_MS 设成 10 秒）
      G_完成后中转区被清空: SCENARIO === 'expired' ? undefined : rep.relayDirAfterCleanupMB === 0,
      // 发送端发出的帧数不许超过帧数本身：每多一帧就是白烧一遍带宽
      H_没有重复发送: SCENARIO === 'expired' ? undefined
        : (rep.sender ? rep.sender.sentFrames <= rep.frames + 1 : undefined),
      F_恢复类场景给出可操作结果: SCENARIO === 'expired'
        ? /过期|作废|失效|重新/.test(rep.expiredText + JSON.stringify(rep.expiredState || {})) : undefined,
    };
    if (rep.sender) {
      rep.senderOnWireMB = +((rep.sender.bytesOnWire || 0) / 1048576).toFixed(1);
      rep.nonces = { dc: rep.sender.dcFrames, relay: rep.sender.relayFrames };
    }
    console.log(JSON.stringify(rep, null, 1));
    const legKeys = Object.keys(rep.gates).filter((k) => rep.gates[k] !== undefined);
    const ok = legKeys.length > 0 && legKeys.every((k) => rep.gates[k]);
    console.log(ok
      ? `LAB PASS[${SCENARIO}] ${MB}MB/${rep.elapsedS}s/${rep.throughputMBs}MB/s 接收堆峰 ${rep.peakHeap.receiverMB}MB 服务器RSS峰 ${srvRssPeak}MB`
      : `LAB FAIL[${SCENARIO}] ` + legKeys.filter((k) => !rep.gates[k]).join(','));
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    // 中途炸了也要留下能看的东西：否则下一遍还是瞎跑
    rep.fatal = String((e && e.message) || e);
    rep.srvLogTail = srv.log().split(/\r?\n/).slice(-8).join(' / ');
    rep.pageErrors = pageErrs.slice(0, 8);
    console.log(JSON.stringify(rep, null, 1));
    throw e;
  } finally {
    if (sampler) clearInterval(sampler);
    if (diskSampler) clearInterval(diskSampler);
    // browser.close() 在这台机的 playwright-core / chromium 组合上会挂住不返回（实测），
    // 报告已经打出来了，没必要让一个量具把自己吊死：给 8 秒，到点自己退出并留着 chrome 由系统回收
    await Promise.race([browser.close().catch(() => {}), sleep(8000)]);
    try { await Promise.race([srv.stop(), sleep(8000)]); } catch { /* 已经停了 */ }
    if (arg('keep', '0') === '1') console.log('KEEP ' + dir);
    else fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    process.exit(process.exitCode || 0);
  }
}
main().catch((e) => { console.error('LAB ERROR', e); process.exitCode = 2; });

// 跑法：node test/lab/xfer-big-lab.js [--mb=600] [--scenario=basic|save|refresh|netdrop|restart|expired] [--save=1] [--keep=1]
