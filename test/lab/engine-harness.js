// 无痕传输引擎台架（Node 里跑真引擎 + 真协议 + 真服务器，只有"传输通道"是桩）
//
// 为什么要桩：本机 Chromium 连一个 ICE 候选都产不出来（裸 RTCPeerConnection 实测
// gathering=complete、候选 0 个，换 --no-sandbox / 关特性开关都一样），所以"P2P 正常时
// 会不会误走中转"这类判据在真浏览器里根本造不出现场。这里把 DataChannel 换成一个
// 可控排速的桩，加密/协议/服务器/账本全是真代码。
//
// 结论边界（写下来免得被误用）：台架证明的是**引擎的决策逻辑**，不是真实网络互通。
// 真链路的证据只能来自两台真设备。
'use strict';
const path = require('path');

const PUB = path.join(__dirname, '..', '..', 'public');

/** 可控 DataChannel 桩：send 只涨缓冲，按 rate 匀速排空，跌回低水位发 bufferedamountlow */
class FakeChannel {
  constructor(link, name) {
    this.link = link; this.name = name;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.onopen = null; this.onclose = null; this.onmessage = null; this.onbufferedamountlow = null;
    this._timer = null; this._wasAbove = false;
  }
  open() { if (this.readyState === 'open') return; this.readyState = 'open'; this.onopen && this.onopen(); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this._stop(); this.onclose && this.onclose(); }
  send(data) {
    if (this.readyState !== 'open') throw new Error('DataChannel 没开');
    const n = data.byteLength || data.length;
    this.bufferedAmount += n;
    this.link.dcSends++; this.link.dcBytes += n;
    this.link.maxBuffered = Math.max(this.link.maxBuffered, this.bufferedAmount);
    if (this.bufferedAmount > this.bufferedAmountLowThreshold) this._wasAbove = true;
    this._pump();
    const peer = this.link.other(this);
    const copy = Uint8Array.from(data).buffer;
    if (peer) setTimeout(() => { if (peer.readyState === 'open') peer.onmessage && peer.onmessage({ data: copy }); }, 0);
  }
  _pump() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      const step = Math.max(1, Math.round(this.link.drainRate / 20)); // 20 次/秒
      this.bufferedAmount = Math.max(0, this.bufferedAmount - step);
      if (this._wasAbove && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this._wasAbove = false;
        this.onbufferedamountlow && this.onbufferedamountlow();
      }
      if (this.bufferedAmount === 0) this._stop();
    }, 50);
    if (this._timer.unref) this._timer.unref(); // 别让桩把测试进程吊住
  }
  _stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}

class FakePC {
  constructor(cfg, link, side) {
    this.cfg = cfg; this.link = link; this.side = side;
    this.connectionState = 'new';
    this.onicecandidate = null; this.onconnectionstatechange = null; this.ondatachannel = null;
    this.localDescription = null; this.remoteDescription = null;
  }
  createDataChannel(name) {
    const mine = new FakeChannel(this.link, name);
    const peer = new FakeChannel(this.link, name);
    if (this.side === 'a') { this.link.aCh = mine; this.link.bCh = peer; } else { this.link.bCh = mine; this.link.aCh = peer; }
    return mine;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0 fake' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 fake' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    // 应答端在 setRemoteDescription(offer) 之后拿到对端建的通道，这与浏览器行为一致
    if (d.type === 'offer' && this.side === 'b' && this.link.aCh && this.ondatachannel) {
      setTimeout(() => this.ondatachannel && this.ondatachannel({ channel: this.link.bCh }), 0);
    }
  }
  async addIceCandidate() {}
  setConfiguration(c) { this.link.setConfigs.push(c); return true; }
  async getStats() { const arr = this.link.stats || []; arr.forEach = Array.prototype.forEach.bind(arr); return arr; }
  close() {
    if (this.connectionState === 'closed') return; // 真 pc.close() 不会再触发状态回调；不拦住就是引擎↔桩的无限递归
    this.connectionState = 'closed';
    if (this.link.aCh) this.link.aCh.close();
    if (this.link.bCh) this.link.bCh.close();
    this.onconnectionstatechange && this.onconnectionstatechange();
  }
}

function makeLink(opts = {}) {
  const link = {
    drainRate: opts.drainRate || 2 * 1024 * 1024,
    highMark: opts.highMark || 4 * 1024 * 1024,
    dcSends: 0, dcBytes: 0, maxBuffered: 0,
    setConfigs: [], stats: null,
    a: null, b: null, aCh: null, bCh: null,
    other(ch) { return ch === link.aCh ? link.bCh : ch === link.bCh ? link.aCh : null; },
    /** 模拟 ICE 选通、通道打开 */
    connect() { link.aCh && link.aCh.open(); link.bCh && link.bCh.open(); },
    /** 模拟链路失效（对端不再收，通道关闭） */
    drop() { link.aCh && link.aCh.close(); link.bCh && link.bCh.close(); },
  };
  return link;
}

/** 装好浏览器宿主环境并加载真引擎；同一个进程里可以挂一个发送方 + 一个接收方 */
function boot({ link, base }) {
  const g = globalThis;
  // Node 里有些全局是只读访问器（navigator 等），直接赋值会抛
  const defg = (k, v) => { try { g[k] = v; } catch { Object.defineProperty(g, k, { value: v, writable: true, configurable: true }); } };
  // Node 18+ 自带 globalThis.crypto（WebCrypto）；它是只读访问器，别去赋值
  if (!g.crypto || !g.crypto.subtle) throw new Error('这台 Node 没有 WebCrypto，台架跑不了');
  defg('navigator', { hardwareConcurrency: 4 });
  defg('isSecureContext', true);
  defg('location', { origin: base, pathname: '/transfer.html' });
  const stores = new Map();
  defg('localStorage', {
    getItem: (k) => (stores.has(k) ? stores.get(k) : null),
    setItem: (k, v) => stores.set(k, String(v)),
    removeItem: (k) => stores.delete(k),
  });
  let RTC = function (cfg) { const side = link.a ? 'b' : 'a'; const pc = new FakePC(cfg, link, side); if (side === 'a') link.a = pc; else link.b = pc; return pc; };
  RTC.prototype = FakePC.prototype;
  defg('RTCPeerConnection', RTC);
  defg('showSaveFilePicker', undefined); defg('showDirectoryPicker', undefined);

  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; this._dead = false; }
    postMessage(msg) {
      setTimeout(async () => {
        if (this._dead || !this.onmessage) return;
        const P = g.XferProto;
        const back = (data) => this.onmessage && this.onmessage({ data: Object.assign({ id: msg.id }, data) });
        try {
          if (msg.op === 'sha256') back({ hex: P.hex(await P.sha256(new Uint8Array(msg.bytes))) });
          else if (msg.op === 'seal') back({ frame: await P.seal({ key: new Uint8Array(msg.key), sid8: new Uint8Array(msg.sid8), type: msg.type, fileId: msg.fileId, chunkIdx: msg.chunkIdx, plaintext: new Uint8Array(msg.plaintext) }) });
          else if (msg.op === 'open') {
            const r = await P.open({ key: new Uint8Array(msg.key), sid8: new Uint8Array(msg.sid8), frame: new Uint8Array(msg.frame) });
            back({ fileId: r.fileId, chunkIdx: r.chunkIdx, type: r.type, plainLen: r.plainLen, plaintext: r.plaintext });
          } else if (msg.op === 'fingerprint') {
            const B = P.PLAIN_BLOCK; const f = msg.file; const chain = [];
            for (let off = 0; off < f.size; off += B) {
              chain.push(await P.sha256(new Uint8Array(await f.slice(off, Math.min(f.size, off + B)).arrayBuffer())));
              back({ progress: Math.min(1, (off + B) / f.size), doneBytes: Math.min(f.size, off + B) });
            }
            if (!chain.length) chain.push(await P.sha256(new Uint8Array(0)));
            back({ hex: P.hex(await P.sha256(P.cat(...chain))) });
          } else back({ error: '未知操作 ' + msg.op });
        } catch (err) { back({ error: (err && err.message) || '加密失败' }); }
      }, 0);
    }
    terminate() { this._dead = true; }
  }
  defg('Worker', FakeWorker);

  const idb = new Map();
  // 测试用：把这个集合里的 key 的"下一次读"变成读不到（模拟浏览器把这一帧从本地暂存里掉了、
  // 或事务抖了一下）。一次性：读掉之后就恢复正常，避免把恢复逻辑拖进死循环。
  const idbDrop = new Set();
  const tx = () => ({
    objectStore: () => ({
      put: (v, k) => { idb.set(k, v); },
      get: (k) => {
        const rq = {};
        setTimeout(() => {
          if (idbDrop.has(k)) { idbDrop.delete(k); rq.result = undefined; } else rq.result = idb.get(k);
          rq.onsuccess && rq.onsuccess();
        }, 0);
        return rq;
      },
      getAllKeys: () => { const rq = {}; setTimeout(() => { rq.result = [...idb.keys()]; rq.onsuccess && rq.onsuccess(); }, 0); return rq; },
      delete: (k) => { idb.delete(k); },
    }),
    set oncomplete(fn) { setTimeout(fn, 0); },
  });
  defg('indexedDB', { open: () => { const req = {}; setTimeout(() => { req.result = { transaction: () => tx() }; req.onsuccess && req.onsuccess(); }, 0); return req; } });

  const counters = { segPut: 0, segGet: 0, byPath: {}, failAck: 0, hangPut: 0 };
  const nativeFetch = g.fetch;
  defg('fetch', (url, opt = {}) => {
    const u = String(url).startsWith('http') ? String(url) : base + '/' + String(url).replace(/^\//, '');
    const method = opt.method || 'GET';
    const pathname = new URL(u).pathname;
    if (pathname === '/api/xfer/seg') { if (method === 'PUT') counters.segPut++; else counters.segGet++; }
    counters.byPath[method + ' ' + pathname] = (counters.byPath[method + ' ' + pathname] || 0) + 1;
    // 注入一次"确认请求发不出去"：落盘确认丢一次就永久丢，是 done 门不收尾的根因
    if (pathname === '/api/xfer/ack' && method === 'POST' && counters.failAck > 0) {
      counters.failAck--;
      return Promise.reject(new TypeError('fetch 失败（夹具注入）'));
    }
    // 注入"请求挂住不返回"：真浏览器里 socket 死了但连接没断时 fetch 就是这个样子 ——
    // 它既不 resolve 也不 reject，只会一直占着那个并行槽（2GB 实测就是这么整段停摆的）。
    // 只有拿 signal 取消它的人才拿得回来，所以这里如实实现 signal 语义。
    if (pathname === '/api/xfer/seg' && method === 'PUT' && counters.hangPut > 0) {
      counters.hangPut--;
      return new Promise((_res, rej) => {
        const sig = opt && opt.signal;
        if (sig) {
          if (sig.aborted) return rej(new DOMException('Aborted', 'AbortError'));
          sig.addEventListener && sig.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
        }
      });
    }
    return nativeFetch(u, opt);
  });

  for (const f of ['xfer-proto.js', 'xfer-engine.js']) delete require.cache[require.resolve(path.join(PUB, f))];
  require(path.join(PUB, 'xfer-proto.js'));
  require(path.join(PUB, 'xfer-engine.js'));
  return { P: g.XferProto, E: g.XferEngine, counters, idb, idbDrop, stores, link };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 字节内容由绝对位置决定，且**每 128KiB 一块都得不同**：
 *  以前写的是 (seed + p) & 255，而 131072 = 512×256 —— 于是每一块的字节序列完全一样，
 *  "乱序装配对不对"、"按位置取帧对不对"这类判据全都成了空对空绿（reverse-read 那把刀不下血暴露的）。
 *  加一项 (p >> 17)：第 k 块整体偏移 k，131073 mod 256 = 1 → 相邻块必然不同。 */
const byteAt = (seed, p) => (seed + p + (p >> 17)) & 255;
/** 造一个内容可复算的文件（seed 决定字节，接收端能逐字节比对） */
function fakeFile(name, size, seed) {
  const parts = [];
  for (let off = 0; off < size; off += 65536) {
    const n = Math.min(65536, size - off);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = byteAt(seed, off + i);
    parts.push(b);
  }
  return new File(parts, name, { type: 'application/octet-stream' });
}
const expectBytes = (size, seed) => {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = byteAt(seed, i);
  return b;
};

module.exports = { boot, makeLink, sleep, fakeFile, expectBytes, FakeChannel };
