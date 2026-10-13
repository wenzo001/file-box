// 无痕传输的客户端引擎：一套会话状态机 + 三个通道适配器 + 一份加密协议（xfer-proto.js）。
//
// 三条硬规矩，代码里到处都在为它们服务：
//  1) 明文只在发送端内存里存在一瞬：读一块 → 立刻封帧 → 才交给任何通道。
//  2) 通道只负责"搬运"：P2P / TURN 中继 / 服务器中转走的都是同一批已加密帧。切换通道不重新分配
//     nonce（nonce = f(类型, 文件号, 块号)），重传就是重发同一段字节，接收端按块号幂等 ——
//     所以不会出现"重复写入 / 丢块 / nonce 重用"。
//  3) 进度分三级：已发上通道（本地）、已进中转区（服务器 uploaded）、已落盘（接收端写进
//     IndexedDB 之后才 ack）。只有第三级算"接收完成"，也只有它允许 done。
//
// 直连可用时帧只走 DataChannel，服务器一个字节的内容都看不到；只有直连不可用/掉线时，
// 未确认的那些块才进中转区（密文）。
(function (global) {
  'use strict';

  const P = global.XferProto;
  const META_ID = 0xffffffff;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DEFAULTS = {
    parallel: 6,            // 同时在飞的帧：6 × 128KiB ≈ 0.8MB，内存有上界
    p2pTimeoutMs: 8000,     // 直连建链的耐心，到点走中转，不让用户干等
    pollMs: 1500,
    ackEvery: 8,            // 攒几块再报一次确认，省请求
    dcBufferHigh: 4 * 1024 * 1024,
    dcBufferLow: 1 * 1024 * 1024,   // 背压恢复的低水位：降到这里才继续发（配合 bufferedamountlow）
    dcDrainTimeoutMs: 30000,        // 缓冲 30 秒还排不动 = 链路真的不行了，这时才允许降级
    dcRegraceMs: 5000,              // disconnected 后的宽限：能自己回到 connected 就不必掐掉一条直连
    retryGapMs: 5000,               // 同一帧两次重发之间至少隔这么久：否则慢确认会被当成"没送到"反复重发
  };

  // ---------------- 加密线程池（主线程绝不碰 AES/SHA，否则手机端页面会冻） ----------------
  // 会话被取消时用它给还在排队的线程活计一个出口（身份比对，不靠文案）
  const ABORTED = new Error('会话已结束');

  function Pool(size) {
    const n = Math.max(1, Math.min(size || 4, (navigator.hardwareConcurrency || 4) >= 4 ? 4 : 2));
    const workers = [];
    const idle = [];
    const queue = [];
    const pending = new Map();
    let seq = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker('xfer-worker.js');
      w.onmessage = (e) => {
        const job = pending.get(e.data.id);
        // 进度回信：这条线程还在忙，不能当成"活干完了"把工人放回空闲池
        if (job && e.data.progress != null) { if (job.onProgress) job.onProgress(e.data.progress, e.data.doneBytes); return; }
        pending.delete(e.data.id);
        idle.push(w);
        if (job) job.resolve(e.data);
        drain();
      };
      // 脚本没加载成功时不会有 onmessage，只会 onerror —— 不接住就是永远吊着
      w.onerror = () => dead();
      workers.push(w);
      idle.push(w);
    }
    function dead() {
      const err = new Error('加密线程起不来（xfer-worker.js 没加载成功），传输已停止：刷新页面再试');
      for (const job of queue.splice(0)) job.reject(err);
      for (const job of pending.values()) job.reject(err);
      pending.clear();
      idle.length = 0;
    }
    function drain() {
      while (queue.length && idle.length) {
        const job = queue.shift();
        pending.set(job.id, job);
        idle.shift().postMessage(job.msg, job.transfer || []);
      }
    }
    const call = (op, msg, transfer, onProgress) => new Promise((resolve, reject) => {
      const id = ++seq;
      // resolve/reject 要跟着 job 走：只存 id 的话 worker 回信时找不到出口，每一块都会永远悬着
      queue.push({ id, resolve, reject, onProgress, msg: Object.assign({ id, op }, msg), transfer });
      drain();
    }).then((r) => { if (r.error) throw new Error(r.error); return r; });
    return {
      size: n,
      sha256: (bytes) => call('sha256', { bytes }),
      seal: (o) => call('seal', o, [o.plaintext.buffer]),
      open: (o) => call('open', o, [o.frame.buffer.slice(0)]),
      fingerprint: (file, onProgress) => call('fingerprint', { file }, null, onProgress),
      close() {
        // 线程被 terminate 掉之后不会再回信：排队中和在跑的活都要给个出口，
        // 否则"准备阶段就取消"会让 send() 的 await 永远悬着，界面卡在进度上
        const err = ABORTED;
        queue.splice(0).forEach((j) => j.reject(err));
        pending.forEach((j) => j.reject(err));
        pending.clear();
        idle.length = 0;
        workers.forEach((w) => { try { w.terminate(); } catch { /* 已终止 */ } });
      },
    };
  }

  // ---------------- 接收端本地存储：只存"已通过认证标签的密文帧" ----------------
  const Store = {
    _db: null,
    open() {
      if (!this._db) {
        this._db = new Promise((resolve, reject) => {
          const rq = indexedDB.open('fb-xfer', 1);
          rq.onupgradeneeded = () => rq.result.createObjectStore('frames');
          rq.onsuccess = () => resolve(rq.result);
          rq.onerror = () => reject(new Error('本地存储不可用'));
        });
      }
      return this._db;
    },
    async put(sid, seq, frame) {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('frames', 'readwrite');
        tx.objectStore('frames').put(frame.slice(0), `${sid}#${seq}`);
        tx.onerror = () => reject(tx.error || new Error('本地写入失败'));
        tx.onabort = () => reject(tx.error || new Error('本地写入被中止（磁盘或配额不足？）'));
        tx.oncomplete = resolve;
      });
    },
    async get(sid, seq) {
      const db = await this.open();
      return new Promise((resolve) => {
        const rq = db.transaction('frames').objectStore('frames').get(`${sid}#${seq}`);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => resolve(null);
      });
    },
    // 续传前要先把"本地已经存过哪些块"读回来，否则会照着服务器的 uploaded 重新下一遍
    async seqs(sid) {
      const db = await this.open();
      const p = `${sid}#`;
      return new Promise((resolve) => {
        const rq = db.transaction('frames').objectStore('frames').getAllKeys();
        rq.onsuccess = () => resolve((rq.result || [])
          .filter((k) => String(k).startsWith(p))
          .map((k) => Number(String(k).slice(p.length)))
          .filter((n) => Number.isInteger(n)));
        rq.onerror = () => resolve([]);
      });
    },
    async drop(sid) {
      const db = await this.open();
      const keys = await new Promise((resolve) => {
        const rq = db.transaction('frames').objectStore('frames').getAllKeys();
        rq.onsuccess = () => resolve((rq.result || []).filter((k) => String(k).startsWith(`${sid}#`)));
        rq.onerror = () => resolve([]);
      });
      await new Promise((resolve) => {
        const tx = db.transaction('frames', 'readwrite');
        keys.forEach((k) => tx.objectStore('frames').delete(k));
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
      return keys.length;
    },
  };

  // ---------------- 服务端接口（凭证一律走请求头，不进 URL） ----------------
  function makeApi(role, cred) {
    const hdr = (extra) => Object.assign({}, extra,
      role === 'sender' ? { 'X-Xfer-Sender': cred.token } : { 'X-Xfer-Proof': cred.proof });
    const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const json = async (r) => {
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(b.error || `请求失败 (${r.status})`); e.status = r.status; throw e; }
      return b;
    };
    return {
      config: async () => json(await fetch('api/xfer/config')),
      create: (sid, proof, frames, totalBytes) => fetch('api/xfer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, proof, frames, totalBytes }),
      }).then(json),
      join: (sid, proof) => fetch('api/xfer/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, proof }),
      }).then(json),
      state: (sid) => fetch(`api/xfer/state?${qs({ sid })}`, { headers: hdr({}) }).then(json),
      signal: (sid, kind, body) => fetch('api/xfer/signal', {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid, kind, body }),
      }).then(json),
      turn: (sid) => fetch(`api/xfer/turn?${qs({ sid })}`, { headers: hdr({}) }).then((r) => (r.ok ? r.json() : null)),
      putSeg: (sid, i, frame) => fetch(`api/xfer/seg?${qs({ sid, i })}`, {
        method: 'PUT', headers: hdr({ 'Content-Type': 'application/octet-stream' }), body: frame,
      }).then((r) => (r.status === 429 ? Promise.reject(Object.assign(new Error('中转正忙'), { retry: true })) : json(r))),
      getSeg: async (sid, i) => {
        const r = await fetch(`api/xfer/seg?${qs({ sid, i })}`, { headers: hdr({}) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`拉取第 ${i} 块失败 (${r.status})`);
        return new Uint8Array(await r.arrayBuffer());
      },
      ack: (sid, idx) => fetch('api/xfer/ack', {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid, idx }),
      }).then(json),
      finish: (sid, kind) => fetch(`api/xfer/${kind}`, {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid }),
      }).then((r) => r.ok),
    };
  }

  // EventSource 发不了自定义请求头，而这里凭证绝不能进 URL（会被访问日志记下来）→ 用 fetch 读流
  function sse(url, headers, onEvent, onDown) {
    let closed = false;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, { headers, signal: ac.signal, cache: 'no-store' });
        if (!res.ok) { onDown(new Error((await res.json().catch(() => ({}))).error || `事件流 ${res.status}`)); return; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let bufTxt = '';
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          bufTxt += dec.decode(value, { stream: true });
          let at;
          while ((at = bufTxt.indexOf('\n\n')) >= 0) {
            const block = bufTxt.slice(0, at);
            bufTxt = bufTxt.slice(at + 2);
            const name = (block.match(/^event: (.*)$/m) || [])[1];
            const data = (block.match(/^data: (.*)$/m) || [])[1];
            if (name && data !== undefined) {
              try { onEvent(name, JSON.parse(data)); } catch (err) { onDown(err); }
            }
          }
          if (bufTxt.length > 65536) bufTxt = bufTxt.slice(-4096);
        }
      } catch (err) {
        if (!closed) onDown(err);
      }
    })();
    return { close() { closed = true; try { ac.abort(); } catch { /* 已关 */ } } };
  }

  // ---------------- WebRTC 适配器（直连与 TURN 中继共用一条通道，靠候选类型区分模式） ----------------
  // 预热 WebRTC：Chromium 第一次 new RTCPeerConnection() 要花约 2 秒去初始化网络栈
  // （实测：本机 2088ms，之后每次 1ms；about:blank 上只要 5ms，所以这是本页上下文的一次性开销）。
  // 它正好落在用户点完"生成传输码"之后、码出来之前，看起来就像"卡住了"。
  // 提前在用户挑文件的时候把这份开销付掉，点生成时就只剩指纹要算。
  let warmed = null;
  function warmUp() {
    if (typeof RTCPeerConnection !== 'function') return false;
    if (warmed) return true;
    warmed = true;
    // 用一个立刻关掉的连接把网络栈叫醒；失败了也无所谓，真用时照旧会建
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.close();
    } catch { /* 没有 WebRTC 就算了 */ }
    return true;
  }

  function p2p(iceServers, handlers) {
    if (typeof RTCPeerConnection !== 'function') return null;
    const pc = new RTCPeerConnection({ iceServers: iceServers, iceCandidatePoolSize: 2 });
    let dc = null;
    let open = false;
    const early = [];
    let remoteSet = false;
    pc.onicecandidate = (e) => { if (e.candidate) handlers.onIce(e.candidate.toJSON()); };
    pc.onconnectionstatechange = () => handlers.onState(pc.connectionState, open);
    pc.ondatachannel = (e) => bind(e.channel);
    function bind(ch) {
      dc = ch;
      dc.binaryType = 'arraybuffer';
      // 低水位要先设好：bufferedamountlow 只在"从上往下穿过阈值"时触发
      try { dc.bufferedAmountLowThreshold = DEFAULTS.dcBufferLow; } catch { /* 老实现没这个属性就走轮询 */ }
      dc.onopen = () => { open = true; handlers.onState(pc.connectionState, true); };
      dc.onclose = () => { open = false; handlers.onState(pc.connectionState, false); };
      dc.onmessage = (ev) => handlers.onFrame(new Uint8Array(ev.data));
    }
    const api = {
      get open() { return open && !!dc && dc.readyState === 'open'; },
      offerer() { bind(pc.createDataChannel('xfer', { ordered: true })); },
      async offer() { await pc.setLocalDescription(await pc.createOffer()); return pc.localDescription.sdp; },
      async takeOffer(sdp) {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        remoteSet = true;
        flush();
        await pc.setLocalDescription(await pc.createAnswer());
        return pc.localDescription.sdp;
      },
      async takeAnswer(sdp) { await pc.setRemoteDescription({ type: 'answer', sdp }); remoteSet = true; flush(); },
      async ice(json) {
        if (!remoteSet) { early.push(json); return; }
        try { await pc.addIceCandidate(json); } catch { /* 迟到或重复的候选，丢掉即可 */ }
      },
      send(bytes) {
        if (!api.open) return false;
        if (dc.bufferedAmount > DEFAULTS.dcBufferHigh) return false;  // 背压：让上层等一会再发
        dc.send(bytes);
        return true;
      },
      get buffered() { return dc ? dc.bufferedAmount : Infinity; },
      /**
       * 等发送缓冲排空到低水位。返回：
       *   'ready'   可以继续走通道发了
       *   'closed'  通道/会话已经没了（别等）
       *   'stalled' 等了 timeoutMs 还排不动 —— 这时才可以说"这条直连真的不干活"
       * 事件 + 轮询双保险：bufferedamountlow 在部分实现上不会来，只等事件就是死等。
       */
      drainReady(timeoutMs, shouldStop) {
        if (!api.open) return Promise.resolve('closed');
        const low = dc.bufferedAmountLowThreshold || DEFAULTS.dcBufferLow;
        if (dc.bufferedAmount <= low) return Promise.resolve('ready');
        return new Promise((resolve) => {
          let done = false;
          const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer); clearInterval(probe);
            dc.onbufferedamountlow = null;
            resolve(r);
          };
          dc.onbufferedamountlow = () => finish('ready');
          const timer = setTimeout(() => finish('stalled'), timeoutMs);
          const probe = setInterval(() => {
            if (shouldStop && shouldStop()) return finish('closed');
            if (!api.open) return finish('closed');
            if (dc.bufferedAmount <= low) finish('ready');
          }, 100);
          if (timer.unref) timer.unref();
          if (probe.unref) probe.unref();
        });
      },
      // 只有真的选中了 relay 候选才算"TURN 中继"，不能拿"配了 TURN"当直连成功
      async mode() {
        try {
          const st = await pc.getStats();
          let pair = null;
          st.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.nominated)) pair = r; });
          if (!pair) return 'p2p';
          let relay = false;
          st.forEach((r) => {
            if (r.type !== 'local-candidate' && r.type !== 'remote-candidate') return;
            if (pair.localCandidateId === r.id || pair.remoteCandidateId === r.id) {
              if (r.candidateType === 'relay') relay = true;
            }
          });
          return relay ? 'turn_relay' : 'p2p';
        } catch { return open ? 'p2p' : 'none'; }
      },
      close() { try { dc && dc.close(); } catch { /* noop */ } try { pc.close(); } catch { /* noop */ } },
      // 配对之后才拿到 TURN 凭证时，用它把 relay 服务器补进 ICE（不需要重建 pc）
      setConfig(c) { try { pc.setConfiguration(c); return true; } catch { return false; } },
    };
    function flush() { const list = early.splice(0); list.forEach((c) => api.ice(c)); }
    return api;
  }

  // ---------------- 连续序号压成区间 / 展开 ----------------
  function toRanges(iterable) {
    const arr = [...iterable].sort((a, b) => a - b);
    const out = [];
    for (const n of arr) {
      const last = out[out.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else out.push([n, n]);
    }
    return out;
  }
  const expand = (rs) => { const out = []; for (const [a, b] of rs || []) for (let i = a; i <= b; i++) out.push(i); return out; };

  const LS = 'fb.xfer.';
  const readLs = (k) => { try { return JSON.parse(localStorage.getItem(LS + k) || '{}') || {}; } catch { return {}; } };
  function writeLs(k, sid, obj) {
    try {
      const all = readLs(k);
      if (obj === null) delete all[sid];
      else all[sid] = obj;
      localStorage.setItem(LS + k, JSON.stringify(all));
      return true;
    } catch { return false; } // 隐私模式/配额满：只影响"刷新后能不能续"，不影响本次传输
  }

  // ---------------- 会话引擎 ----------------
  // 一个页面里同一角色只允许一个在跑的会话：两个会话会抢同一批块、各自往 IndexedDB 写、
  // 都上报 ack，界面上就是进度来回跳动。界面自己也要拦，这里是兜住别的入口。
  // 终态（idle/取消/失败/完成）不算在跑：那之后应该能开新的。
  const LIVE_PHASES = ['fingerprinting', 'waiting', 'pairing', 'paired', 'transferring', 'paused', 'retrying', 'verifying', 'ready', 'saving'];
  const liveSession = { sender: null, receiver: null };
  const isLive = (s) => !!s && LIVE_PHASES.includes(s.state.phase);

  function Session(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const role = opts.role;
    const emit = () => opts.on && opts.on(Object.assign({}, st));
    // 凭证在闭包里、配对之后才有值 → 用 getter 视图交给 makeApi，
    // 不能把 opts 直接当凭证袋：那样每个请求头都会是 undefined（服务端一律 403）
    const net = makeApi(role, { get token() { return token; }, get proof() { return proof; } });
    const st = {
      role, phase: 'idle', channel: 'none', code: '', sid: '', frames: 0, totalBytes: 0,
      sentFrames: 0, bytesOnWire: 0, dcFrames: 0, relayFrames: 0,
      uploaded: 0, stored: 0, speed: 0, eta: 0,
      safety: '', kex: '', engine: '', error: '', note: '', expiresAt: 0, files: [], verified: false, saved: false, resumable: false,
      fpDone: 0, fpTotal: 0,          // 准备阶段：已读/总字节，界面拿它画进度和预计耗时
      peerConfirmed: false,
    };
    let pool = null;
    let secret = '';
    let proof = '';
    let token = '';
    let layout = null;
    let selFiles = [];              // 发送端：{relPath,name,size,mime,file}
    let byRel = new Map();
    let sess = null;                // 会话密钥
    let manifest = null;
    let link = null;
    let rtc = null;
    let iceServers = [];
    let myKeys = null;
    let handshakeDone = false;
    let peerConfirmed = false;      // 对方的 confirm 已经对上：这一条链路确认没有第三方
    let pendingConfirm = null;      // 早于密钥到达的对方 confirm，握手完成后补验
    let resumeMode = false;
    const acked = new Set();        // 接收端已落盘并上报过的块（发送端从服务器读到）
    const sentAt = new Map();       // 每帧最后一次发出去的时刻：慢确认不等于"没送到"，别立刻重发
    let upRanges = [];              // 服务器记账"已经收到"的帧区间——这一份才是"送到没送到"的权威口径
    const onServer = (n) => upRanges.some(([a, b]) => n >= a && n <= b);
    const stored = new Set();       // 接收端本地已落盘
    const late = [];                // 清单还没到时的迟到帧
    let running = false;
    let paused = false;
    let closed = false;
    let aborted = false;            // 用户主动取消（准备阶段也要能停）
    let api = null;
    const ackBuf = new Set();
    let ackTimer = null;
    const timers = [];
    let sample = { t: 0, bytes: 0 };

    function patch(o) { Object.assign(st, o); emit(); }
    function fail(msg, recoverable) { patch({ phase: recoverable ? 'retrying' : 'failed', error: String(msg || '出错') }); }

    function claim() {
      if (isLive(liveSession[role]) && liveSession[role] !== api) {
        throw new Error('这个页面上已经有一个在跑的会话了：请先取消它再开始新的');
      }
      liveSession[role] = api;
    }
    // 逐件算指纹：进度按累计字节报（界面拿它画长条 + 预计耗时）。中途取消返回 null。
    async function fingerprintAll(files) {
      const total = files.reduce((a, f) => a + f.size, 0);
      const sha = new Map();
      let done = 0;
      patch({ fpTotal: total, fpDone: 0 });
      try {
        for (const f of files) {
          const base = done;
          const r = await fingerprintFile(pool, f.file, (p, bytes) => patch({ fpDone: Math.min(total, base + bytes) }));
          sha.set(f.relPath, r.fileSha256);
          done = Math.min(total, base + f.size);
          patch({ fpDone: done });
        }
      } catch (err) {
        if (aborted) return null;
        throw err;
      }
      return sha;
    }

    const fileKeyCache = new Map();
    function fileKey(fileId) {
      if (fileKeyCache.has(fileId)) return fileKeyCache.get(fileId);
      const k = P.hkdf(sess.kRec, sess.sid8, `file-v1|${st.sid}|${fileId}`, 32);
      return k.then((kk) => { fileKeyCache.set(fileId, kk); return kk; });
    }

    // ---------- 帧的产出与消费 ----------
    async function frameFor(seqN) {
      if (seqN === 0) {
        const bytes = P.manifestBytes(layout);
        return new Uint8Array((await pool.seal({
          key: Array.from(sess.kMeta), sid8: Array.from(sess.sid8), type: P.TYPE_META,
          fileId: META_ID, chunkIdx: 0, plaintext: bytes,
        })).frame);
      }
      const where = P.frameAt(layout, seqN);
      if (!where) throw new Error(`第 ${seqN} 帧不属于任何文件`);
      const f = byRel.get(where.file.relPath);
      if (!f) throw new Error(`找不到文件 ${where.file.relPath}`);
      const from = where.file.chunks.slice(0, where.chunkIdx).reduce((s, x) => s + x, 0);
      const buf = new Uint8Array(await f.file.slice(from, from + where.plainLen).arrayBuffer());
      const key = await fileKey(where.file.fileId);
      return new Uint8Array((await pool.seal({
        key: Array.from(key), sid8: Array.from(sess.sid8), type: P.TYPE_DATA,
        fileId: where.file.fileId, chunkIdx: where.chunkIdx, plaintext: buf,
      })).frame);
    }

    async function shipFrame(seqN, frame) {
      // 缓冲满 ≠ 直连不可用。先等它排到低水位（带超时与取消），等不动才算链路失效。
      // 以前这里直接掉到下面走中转：一条健康的直连一旦背压，整份文件就被"额外"PUT 进服务器
      // （界面还写着"直连"），既浪费中转配额也自相矛盾。
      // 迟滞：越过 4MB 高水位才等，等到跌回 1MB 低水位才续发。
      // 拿低水位当"能不能发"的门槛会让高水位变成摆设（永远到不了那里），那是另一回事。
      if (rtc && rtc.open && rtc.buffered > cfg.dcBufferHigh) {
        const r = await rtc.drainReady(cfg.dcDrainTimeoutMs, () => closed || aborted);
        if (r === 'stalled') switchChannel('server_relay', '直连长时间排不出数据，已改用服务器中转（只传密文）');
      }
      if (rtc && rtc.open && rtc.send(frame)) {
        st.bytesOnWire += frame.length;
        st.dcFrames++;
        return 'p2p';
      }
      for (let i = 0; i < 5; i++) {
        if (closed) return null;
        try {
          await net.putSeg(st.sid, seqN, frame);
          st.bytesOnWire += frame.length;
          st.relayFrames++;
          // 一个字节都没走通过道却把整包塞进了服务器 —— 通道标识就该说实话，不能停在"正在建立直连"
          if (!st.dcFrames && st.channel !== 'server_relay') switchChannel('server_relay', st.note);
          return 'relay';
        } catch (err) {
          if (!err.retry) throw err;
          await sleep(300 * (i + 1));
        }
      }
      throw new Error('中转区连续 5 次拒收这一块');
    }

    async function sendSeq(seqN) {
      if (acked.has(seqN)) return;
      const frame = await frameFor(seqN);
      await shipFrame(seqN, frame);
      sentAt.set(seqN, Date.now());
      st.sentFrames++;
      // 'pairing' 也要放行：joined 事件会把状态打成 pairing，而 pump 就在这之后立刻起跑 ——
      // 少这一档，整段传输期间发送端都挂着"正在配对"，进度在动、话却不对（真浏览器实测过）
      if (['waiting', 'paired', 'pairing'].includes(st.phase)) patch({ phase: 'transferring' });
      emit();
    }

    function switchChannel(to, why) {
      if (st.channel === to) return;
      // 先把状态落定，再关 rtc：rtc.close() 会当场回调 onconnectionstatechange('closed')，
      // 那条回调走 degradeNow，看的是 st.channel —— 后落定的话它会把这次切换当成"还没降过级"
      // 再降一遍，并且在密钥还没落地时就叫起 afterHandshake（于是把 pendingConfirm 提前验，
      // 报一句 sess.kMeta 读不到，接收端就此卡在 retrying）。
      patch({ channel: to, note: why || st.note });
      if (to === 'server_relay' && rtc) { try { rtc.close(); } catch { /* noop */ } rtc = null; }
    }
    let regraceTimer = null;
    /** 认定直连已失效：改走中转并把该跑的循环叫起来（幂等，重复调用不会重复降级） */
    function degradeNow(why) {
      if (st.channel === 'server_relay') return;
      switchChannel('server_relay', `直连中断（${why}），已改用服务器中转（只传密文）`);
      afterHandshake();
    }

    // ---------- 发送端主循环（并行窗口 + 只补没确认的块） ----------
    async function pump() {
      if (running || closed || !handshakeDone) return;
      running = true;
      try {
        await sendSeq(0);                       // 清单先到，接收端才知道后面怎么摆
        let cursor = 1;
        const inflight = new Set();
        while (cursor < st.frames || inflight.size) {
          if (closed) return;
          while (paused) await sleep(150);
          while (cursor < st.frames && inflight.size < cfg.parallel) {
            const s = cursor++;
            // 已经被确认、或者服务器手上已经有这一块的，都不用再发一遍
            // （续传时这条最要紧：重启/刷新之后服务器账本里的 uploaded 就是"我已经有了"）
            if (acked.has(s) || onServer(s)) continue;
            const slot = {};
            inflight.add(slot);
            slot.p = sendSeq(s)
              .catch((err) => { fail(err.message || err, true); })
              .finally(() => inflight.delete(slot));
          }
          if (inflight.size) await Promise.race([...[...inflight].map((x) => x.p), sleep(300)]);
          await refreshAck();
          if (st.error && st.phase === 'retrying' && acked.size === st.frames) patch({ error: '', phase: 'transferring' });
        }
        for (let guard = 0; guard < 1200 && acked.size < st.frames; guard++) {
          if (closed) return;
          while (paused) await sleep(200);
          await sleep(500);
          await refreshAck();
          // 只补两类帧：① 确实隔了一阵还没被确认、② 服务器手上根本没有这一块。
          // 慢确认（对端在解密/落盘）不等于没送到 —— 以前只看"没确认"就整批重发，
          // 600MB 实测把 4801 帧发成了 5594 次（多烧 133MB），收尾还撞上会话被回收报"写入分段失败"。
          const now = Date.now();
          const due = missingForRetry(acked, st.frames).filter((n) =>
            now - (sentAt.get(n) || 0) >= cfg.retryGapMs && !onServer(n));
          for (const s of due.slice(0, cfg.parallel)) {
            try { await sendSeq(s); } catch (err) { fail(err.message || err, true); }
          }
        }
        if (acked.size === st.frames) {
          await net.finish(st.sid, 'done');
          patch({ phase: 'done' });
          writeLs('sender', st.sid, null);
        } else {
          fail('等接收端落盘的超时了；可以点"继续"接着传', true);
        }
      } catch (err) {
        fail(err.message || err);
      } finally {
        running = false;
      }
    }
    function missingForRetry(set, frames) {
      const out = [];
      for (let i = 0; i < frames && out.length < 64; i++) if (!set.has(i)) out.push(i);
      return out;
    }
    async function refreshAck() {
      try {
        const s = await net.state(st.sid);
        expand(s.acked).forEach((n) => acked.add(n));
        upRanges = Array.isArray(s.uploaded) ? s.uploaded : [];
        st.uploaded = expand(s.uploaded).length;
        st.frames = s.frames;
        st.totalBytes = s.totalBytes;
        if (role === 'sender') { st.stored = acked.size; sampleSpeed(acked.size * P.PLAIN_BLOCK); }
        emit();
      } catch { /* 服务器暂时不回，下一轮再问 */ }
    }
    function sampleSpeed(bytesNow) {
      const now = Date.now();
      if (!sample.t) { sample = { t: now, bytes: bytesNow }; return; }
      const dt = (now - sample.t) / 1000;
      if (dt < 1.5) return;
      const d = bytesNow - sample.bytes;
      st.speed = d > 0 ? d / dt : st.speed;
      const left = Math.max(0, st.totalBytes - bytesNow);
      st.eta = st.speed > 65536 ? Math.round(left / st.speed) : 0;
      sample = { t: now, bytes: bytesNow };
    }

    // ---------- 接收端 ----------
    // 清单里文件号叫 id，发送端自己那份布局叫 fileId：这里一进来就统一成 fileId，
    // 否则 fileMeta()/fileKey() 在接收端永远查不到文件（每块都被判成"不属于任何清单文件"）
    function applyManifest(m) {
      manifest = m;
      let seq = 1;
      const files = m.files.map((f) => {
        const o = Object.assign({}, f, { fileId: f.id, seqBase: seq, relPath: f.relPath || f.name });
        seq += f.chunks.length;
        return o;
      });
      layout = { files, totalFrames: seq, plainBlock: m.plainBlock };
      st.files = files.map((f) => ({ fileId: f.fileId, name: f.name, relPath: f.relPath, size: f.size, seqBase: f.seqBase }));
      st.frames = seq;
      st.totalBytes = m.totalBytes;
      return files;
    }
    function fileMeta(fileId) {
      return (layout ? layout.files : []).find((f) => f.fileId === fileId) || null;
    }
    async function acceptFrame(frame) {
      if (!frame || frame.length < P.HEADER_LEN + P.TAG_LEN || frame[0] !== P.MAGIC) return;
      let head;
      try { head = P.parseHeader(frame); } catch { return; }
      if (head.type === P.TYPE_META) {
        const r = await pool.open({ key: Array.from(sess.kMeta), sid8: Array.from(sess.sid8), frame });
        applyManifest(P.readManifest(new Uint8Array(r.plaintext)));
        await persist(0, frame);
        drainLate();
        patch({ phase: st.phase === 'done' ? 'done' : 'transferring' });
        return;
      }
      if (!layout) { late.push(frame); return; }       // 清单没到，先排队，别急着解
      const f = fileMeta(head.fileId);
      if (!f) throw new Error('收到了不属于任何清单文件的块');
      const key = await fileKey(head.fileId);
      const r = await pool.open({ key: Array.from(key), sid8: Array.from(sess.sid8), frame });
      if (r.chunkIdx !== head.chunkIdx || r.plainLen !== head.plainLen || r.plaintext.length !== head.plainLen) throw new Error('帧自述与认证数据不一致');
      if (head.plainLen !== f.chunks[head.chunkIdx]) throw new Error('这一块的长度和清单不符');
      await persist(f.seqBase + head.chunkIdx, frame);
    }
    function drainLate() {
      const list = late.splice(0);
      list.forEach((fr) => acceptFrame(fr).catch((e) => fail(e.message || e)));
    }
    async function persist(seqN, frame) {
      if (stored.has(seqN)) return;
      await Store.put(st.sid, seqN, frame);
      stored.add(seqN);
      st.stored = stored.size;
      sampleSpeed(stored.size * P.PLAIN_BLOCK);
      emit();
      ackBuf.add(seqN);
      if (ackBuf.size >= cfg.ackEvery) flushAcks();
      else if (!ackTimer) ackTimer = setTimeout(() => { ackTimer = null; flushAcks(); }, 600);
      if (stored.size === st.frames && manifest) finishReceive();
    }
    async function flushAcks() {
      // 注意：序号 0 是加密清单帧，但它在服务器的帧号空间**之内**（frames 含它），
      // done 门按 acked.size === frames 对账 —— 把 0 过滤掉 done 就永远差一块。
      const list = [...ackBuf];
      if (!list.length) return;
      ackBuf.clear();
      try { await net.ack(st.sid, list); }
      catch {
        // 发不出去就退回缓冲，等下一次确认或轮询再试。
        // 以前是"清掉 + 吞掉异常"：一次网络抖动就把已经落盘的块永远不算确认，
        // 发送端 done 门永远差这几块 —— 会话不收尾、服务器密文一直占着配额
        // （48MB 接收端刷新实测：对方已落盘确认停在 384/385）。
        for (const n of list) ackBuf.add(n);
      }
    }
    let pulling = false;
    async function pullMissing() {
      // 轮询和握手可能同时叫它；两边一起拉会把同几块下一遍（块本身幂等，但白占带宽和内存）
      if (pulling) return true;
      pulling = true;
      try {
        const s = await net.state(st.sid);
        const up = new Set(expand(s.uploaded));
        st.uploaded = up.size;
        for (const q of up) {
          if (closed || stored.has(q)) continue;
          const got = await net.getSeg(st.sid, q);
          if (got) await acceptFrame(got);
        }
        if (st.error && st.phase === 'retrying') patch({ error: '', phase: 'transferring' });
      } catch (err) {
        if (err.status === 404) { patch({ phase: 'waiting', error: '服务器上的这个会话已经过期了' }); return false; }
        patch({ error: err.message || '网络不稳，正在重试', phase: 'retrying' });
      } finally {
        pulling = false;
      }
      emit();
      return true;
    }
    // 接收端要主动追问：服务器中转时发送方是一块一块上传的，配对那一刻拉到的只是当时有的。
    // 不轮询就会永远停在"刚配对时的那几块"上，两边互相等，直到超时。
    let pollT = null;
    function schedulePoll() {
      if (pollT || closed || role !== 'receiver') return;
      pollT = setTimeout(async () => {
        pollT = null;
        if (closed || st.verified) return;
        if (!paused && handshakeDone) { await refreshAck(); await pullMissing(); }
        schedulePoll();
      }, cfg.pollMs);
    }
    /** 读本地暂存的某一帧。读不回来时先回服务器补拉这一块，再落一遍盘：
     *  浏览器可能把早先写入的帧从本地暂存里丢掉，读事务也可能只是抖一下 ——
     *  这两种都不是"文件坏了"。直接报"合成错误"就是把一次可恢复的失败说成了不可恢复
     *  （600MB 真浏览器实测：4801 帧全部收齐，重算时第 1799 块读空 → 整单失败）。 */
    async function readStoredFrame(seqN, label) {
      const first = await Store.get(st.sid, seqN);
      if (first && first.length) return new Uint8Array(first);
      stored.delete(seqN);          // 记账说它有、本地实际没有：先如实撤账，补回来再加回
      st.stored = stored.size;
      let got = null;
      try { got = await net.getSeg(st.sid, seqN); } catch { /* 会话已不在服务器上，下面统一报出去 */ }
      if (!got || !got.length) throw new Error(`「${label}」第 ${seqN} 块本地和服务器都读不到了，这一单收不齐：请让对方重发一次`);
      await Store.put(st.sid, seqN, got);
      stored.add(seqN);
      st.stored = stored.size;
      return new Uint8Array(got);
    }
    async function finishReceive() {
      if (st.verified) return;
      patch({ phase: 'verifying' });
      try {
        for (const f of layout.files) {
          const chain = [];
          let total = 0;
          for (let c = 0; c < f.chunks.length; c++) {
            const frame = await readStoredFrame(f.seqBase + c, f.name);
            const key = await fileKey(f.fileId);
            const r = await pool.open({ key: Array.from(key), sid8: Array.from(sess.sid8), frame });
            const pt = new Uint8Array(r.plaintext);
            if (pt.length !== f.chunks[c]) throw new Error(`「${f.name}」第 ${c} 块长度不对`);
            chain.push(await P.sha256(pt));
            total += pt.length;
          }
          if (total !== f.size) throw new Error(`「${f.name}」总长度不对`);
          if (f.sha256 && P.hex(await P.sha256(P.cat(...chain))) !== f.sha256) {
            throw new Error(`「${f.name}」内容校验失败，可能被人动过`);
          }
        }
        await flushAcks();
        // 清掉尾巴上的一次性抖动报错：校验已经通过，界面上还挂着"会话已过期"就是假警报
        patch({ phase: 'ready', verified: true, error: '' });
        writeLs('receiver', st.sid, Object.assign({}, readLs('receiver')[st.sid] || {}, { verified: true }));
      } catch (err) {
        fail(err.message || err);
      }
    }

    // 保存：能流式写盘就流式写；否则交给调用方处理 Blob（浏览器下载会自己落临时文件）
    async function saveAll(streamToFile) {
      if (!st.verified) throw new Error('还没通过完整性校验');
      patch({ phase: 'saving' });
      for (const f of layout.files) {
        const key = await fileKey(f.fileId);
        let w = null;
        if (streamToFile) w = await streamToFile(f);
        for (let c = 0; c < f.chunks.length; c++) {
          const frame = await readStoredFrame(f.seqBase + c, f.name);
          const pt = new Uint8Array((await pool.open({ key: Array.from(key), sid8: Array.from(sess.sid8), frame })).plaintext);
          if (w) await w.write(pt);
          else yieldBlob(f, pt);
        }
        if (w) await w.close();
      }
      patch({ phase: 'done', saved: true });
      // 归组按 relPath 而不是 name：同一批里两个不同子目录下的同名文件，
      // 按名字归组会把两块并成同一个 Blob（另一个则被覆盖）
      function yieldBlob(f, pt) { (blobs[f.relPath] = blobs[f.relPath] || []).push(pt); }
    }
    const blobs = {};
    async function collected() {
      const out = [];
      for (const f of layout.files) {
        const parts = blobs[f.relPath] || [];
        out.push({ name: f.name, relPath: f.relPath, size: f.size, blob: new Blob(parts) });
      }
      return out;
    }

    // ---------- 握手 ----------
    // 密钥对必须在事件流打开之前就备好：服务器会补发对方的 key，晚一步生成就会在
    // "还没有自己的私钥"时去算 ECDH，直接抛错
    async function ensureKeys() { if (!myKeys) myKeys = await P.genEcdh(); }
    async function exchangeKeys() {
      await ensureKeys();
      await net.signal(st.sid, 'key', JSON.stringify({ kex: myKeys.kex, pub: P.hex(myKeys.pub) })).catch(() => {});
    }
    async function onPeerKey(body) {
      // 重连时服务器会把历史 key 再补发一遍：已经握过手就不能再派生一次，
      // 否则会话密钥被换掉，之前确认过的块全都解不开
      if (handshakeDone) return;
      const peer = JSON.parse(body);
      if (resumeMode && sess) { // 恢复：密钥已经缓存，不再重新派生
        await resumeHandshake();
        return;
      }
      const shared = await P.ecdhShared(myKeys && myKeys.priv, P.unhex(peer.pub));
      sess = await P.deriveSession({
        sid: st.sid, secret, kex: myKeys.kex === peer.kex ? myKeys.kex : 'mismatch',
        shared, pubSelf: myKeys.pub, pubPeer: P.unhex(peer.pub),
      });
      if (sess.kex === 'mismatch') throw new Error('两端的加密能力不一致（一边 HTTPS、一边 HTTP），已终止：不做静默降级');
      patch({ safety: sess.safety, kex: sess.kex, engine: P.engine });
      cacheKeys();
      handshakeDone = true;
      await net.signal(st.sid, 'confirm', JSON.stringify(await P.confirmMac(sess, role, st.sid)));
      afterHandshake();
    }
    function afterHandshake() {
      // 对方的 confirm 可能比这一端的密钥还早到（重连时服务器会立刻补发历史），
      // 那时还验不了；先存着，握手一落地马上补验，不然"链路上没有别人"这个结论永远立不起来
      // sess 还没派生出来时不能补验：confirmMac 要读 kConfirm/kMeta，读不到就是一句 TypeError
      if (pendingConfirm && sess) {
        const b = pendingConfirm;
        pendingConfirm = null;
        onPeerConfirm(b).catch((e) => fail(e.message || e));
      }
      if (role === 'sender') pump();
      else { pullMissing(); schedulePoll(); }
    }
    // 恢复：会话密钥已经在本地（localStorage 里那份），绝不能再等对方的 key 信令 ——
    // 对面可能是刷新后新开的会话，也可能服务器补发的是旧 key，两种都不能把这条链路卡住。
    // 所以这里直接进"已握手"，把 confirm 补发出去，然后按本地已有的块决定还缺哪些。
    async function resumeHandshake() {
      if (!resumeMode || !sess || handshakeDone) return;
      handshakeDone = true;
      patch({ safety: sess.safety, kex: sess.kex, engine: P.engine, resumable: true });
      await net.signal(st.sid, 'confirm', JSON.stringify(await P.confirmMac(sess, role, st.sid))).catch(() => {});
      if (role === 'receiver') await hydrateStored();
      afterHandshake();
    }
    // 本地已经落盘的块要先"认领"回来：否则 pullMissing 会照着服务器的 uploaded 把几十 GB 重下一遍，
    // 进度也会从"已经存好"被算回 0
    async function hydrateStored() {
      try {
        for (const s of await Store.seqs(st.sid)) stored.add(s);
        st.stored = stored.size;
        // 认领回来之后还要补一次确认：刷新前那些"已经落盘、但确认请求还没发出去"的块，
        // 服务器一条都没记上；不补，发送端的 done 门就永远差这几块（48MB 刷新实测停在 384/385），
        // 会话不收尾、服务器上的密文也一直占着配额。只补"服务器还不知道"的那些，不重发整本账。
        try {
          const sv = await net.state(st.sid);
          const known = new Set(expand(sv.acked));
          const owed = [...stored].filter((n) => !known.has(n));
          if (owed.length) { for (const n of owed) ackBuf.add(n); await flushAcks(); }
        } catch { /* 问不到服务器就留给下一轮轮询 */ }
        const mframe = new Uint8Array((await Store.get(st.sid, 0)) || []);
        if (mframe.length && !layout) {
          const r = await pool.open({ key: Array.from(sess.kMeta), sid8: Array.from(sess.sid8), frame: mframe });
          applyManifest(P.readManifest(new Uint8Array(r.plaintext)));
        }
        emit();
        if (layout && stored.size >= st.frames) await finishReceive();
      } catch (err) {
        patch({ error: `本地暂存读不回来了：${err.message || err}` });
      }
    }
    async function onPeerConfirm(body) {
      // 已经验过一次，再来的只会是重连时服务器补发的历史 —— 忽略它，
      // 不然一句重复确认会把"链路没有第三方"这个结论冲掉
      if (peerConfirmed) return;
      if (!handshakeDone) { pendingConfirm = body; patch({ phase: 'retrying', error: '还没拿到对方公钥，正在等' }); return; }
      const mine = await P.confirmMac(sess, role === 'sender' ? 'receiver' : 'sender', st.sid);
      if (JSON.parse(body) !== mine) throw new Error('配对校验不通过：链路上可能有第三方，已终止');
      peerConfirmed = true;
      patch({ peerConfirmed: true, error: '' });
      if (role === 'receiver' && !layout) pullMissing();
    }
    function cacheKeys() {
      const rec = {
        code: P.formatCode(st.sid, secret), expiresAt: st.expiresAt, frames: st.frames, totalBytes: st.totalBytes,
        safety: sess.safety, kex: sess.kex,
        keys: { kRec: P.hex(sess.kRec), kMeta: P.hex(sess.kMeta), kConfirm: P.hex(sess.kConfirm), sid8: P.hex(sess.sid8) },
      };
      if (role === 'sender') {
        rec.token = token;
        rec.files = layout ? layout.files.map((f) => ({ relPath: f.relPath, name: f.name, size: f.size, sha256: f.sha256 })) : [];
      } else {
        rec.files = layout ? layout.files.map((f) => ({ relPath: f.relPath, name: f.name, size: f.size, sha256: f.sha256 })) : [];
      }
      st.resumable = writeLs(role, st.sid, rec);
    }
    function restoreKeys(rec) {
      sess = {
        kRec: P.unhex(rec.keys.kRec), kMeta: P.unhex(rec.keys.kMeta),
        kConfirm: P.unhex(rec.keys.kConfirm), sid8: P.unhex(rec.keys.sid8),
        safety: rec.safety || '', kex: rec.kex || 'resumed',
      };
      token = rec.token || token;
      st.expiresAt = rec.expiresAt;
      st.frames = rec.frames;
      st.totalBytes = rec.totalBytes;
    }

    // ---------- 通道 ----------
    let turnApplied = false;
    /**
     * 发送方的 rtc 必须先于事件流建好（否则会漏掉对方的 offer），可那一刻会话还没配对，
     * /turn 会 409 —— 于是发送方永远拿不到 relay 候选，TURN 形同虚设。
     * 收到 joined 之后补取一次，并用 setConfiguration 把 relay 服务器加进正在进行的 ICE。
     */
    async function upgradeIceWithTurn() {
      if (turnApplied || !rtc) return;
      const t = await net.turn(st.sid).catch(() => null);
      if (!t || !t.urls || !t.urls.length) return; // 服务器没配 TURN 就是没有，不是错误
      turnApplied = true;
      iceServers = iceServers.filter((s) => !s.credential).concat([{ urls: t.urls, username: t.username, credential: t.credential }]);
      if (!rtc.setConfig({ iceServers })) {
        console.log('[无痕] 该浏览器不支持配对后补 TURN：直连失败时只能走服务器中转');
      }
    }
    async function setupChannel() {
      const c = await net.config().catch(() => null);
      const caps = global.XferEngine.capabilities();
      if (!c || !caps.rtc || !caps.subtle) { switchChannel('server_relay', caps.secure ? '' : '当前是 HTTP 入口，直连不可用，走服务器中转（仍然只传密文）'); return; }
      iceServers = (c.stun || []).map((u) => ({ urls: u }));
      if (c.turnConfigured) {
        const t = await net.turn(st.sid).catch(() => null);
        if (t && t.urls && t.urls.length) {
          iceServers.push({ urls: t.urls, username: t.username, credential: t.credential });
          turnApplied = true; // 接收方走到这里时已经配对，凭证一次就拿到了
        }
      }
      rtc = p2p(iceServers, {
        onIce: (json) => { net.signal(st.sid, 'ice', JSON.stringify(json)).catch(() => {}); },
        onFrame: (frame) => { if (role === 'receiver') acceptFrame(frame).catch((e) => fail(e.message || e)); },
        onState: async (state, open) => {
          if (open) {
            if (regraceTimer) { clearTimeout(regraceTimer); regraceTimer = null; } // 自己回来了，之前的"要降级"作废
            const mode = await rtc.mode();
            switchChannel(mode); // 直连/TURN 各自的说明由界面 CHAN 文案给，不重复塞一句
            afterHandshake();
          } else if (state === 'failed' || state === 'closed') {
            degradeNow(state);
          } else if (state === 'disconnected') {
            // disconnected 常常几秒内自己回到 connected（切网、休眠唤醒、ICE 重选）。
            // 立刻降级会把一条还能用的直连主动掐掉，所以先等 dcRegraceMs，确实回不来才降级。
            if (regraceTimer) return;
            regraceTimer = setTimeout(() => {
              regraceTimer = null;
              if (!rtc || rtc.open) return;
              degradeNow('disconnected');
            }, cfg.dcRegraceMs);
            if (regraceTimer.unref) regraceTimer.unref();
          }
        },
      });
      if (role === 'sender' && rtc) {
        rtc.offerer();
        patch({ channel: 'p2p_connecting' });
        const sdp = await rtc.offer();
        await net.signal(st.sid, 'offer', sdp).catch(() => {});
      }
      if (role === 'receiver' && rtc) patch({ channel: 'p2p_connecting' });
      // 两端都要有这条超时：以前只有发送方超时改标，接收端界面能一路停在"正在尝试直连"，
      // 而它其实全盘在从服务器拉密文；那条开不了的 pc 也一直悬着不关。
      if (rtc) timers.push(setTimeout(() => {
        if (!rtc || rtc.open) return;
        switchChannel('server_relay', '直连建立超时，已改用服务器中转');
        // 只有发送端需要这一叫把主循环起来；接收端的拉取另有排程，在这里多叫一次只会
        // 在密钥还没落地时凭空报一个错
        if (role === 'sender') afterHandshake();
      }, cfg.p2pTimeoutMs));
    }

    function openStream() {
      const url = `api/xfer/events?sid=${encodeURIComponent(st.sid)}&role=${role}`;
      const headers = role === 'sender' ? { 'X-Xfer-Sender': token } : { 'X-Xfer-Proof': proof };
      link = sse(url, headers, async (name, data) => {
        try {
          if (name === 'joined') {
            // 只在"还没开跑"时才把相位改成配对中。对端刷新重连会让服务器再补一条 joined，
            // 那时发送端明明在传（甚至已经传完），打回 pairing 就是把界面停在"正在配对、核对安全码"
            if (st.phase === 'waiting' || st.phase === 'paired') patch({ phase: 'pairing' });
            upgradeIceWithTurn().catch(() => {});
          }
          else if (name === 'key') await onPeerKey(data.body);
          else if (name === 'confirm') await onPeerConfirm(data.body);
          else if (name === 'offer' || name === 'answer' || name === 'ice') {
            // 降级之后 rtc 已经关了：这些信令对本会话不再有意义，收下就算，
            // 但绝不能拿着 null 去 takeOffer/takeAnswer —— 那会把一句 TypeError 顶到用户界面上
            if (!rtc) return;
            if (name === 'offer') { const sdp = await rtc.takeOffer(data.body); await net.signal(st.sid, 'answer', sdp).catch(() => {}); }
            else if (name === 'answer') await rtc.takeAnswer(data.body);
            else await rtc.ice(JSON.parse(data.body));
          }
          else if (name === 'ack') { await refreshAck(); if (role === 'sender') pump(); }
          else if (name === 'done') { if (role === 'receiver') { await pullMissing(); if (stored.size === st.frames) await finishReceive(); } else patch({ phase: 'done' }); }
          else if (name === 'cancelled') { patch({ phase: 'cancelled', error: '对方取消了这次传输' }); close(); }
        } catch (err) { fail(err.message || err); }
      }, (err) => {
        if (closed) return;
        patch({ error: (err && err.message) || '事件连接断了', phase: 'retrying' });
        timers.push(setTimeout(openStream, 2000));
      });
    }

    function close() {
      closed = true;
      if (liveSession[role] === api) liveSession[role] = null;
      if (regraceTimer) { clearTimeout(regraceTimer); regraceTimer = null; }
      timers.forEach(clearTimeout);
      timers.length = 0;
      if (link) link.close();
      if (rtc) rtc.close();
      if (pollT) { clearTimeout(pollT); pollT = null; }
      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
      pool && pool.close();
    }

    // ---------- 对外：发送 ----------
    // resume = { sid, record }：用之前缓存的会话密钥接着传；重新选的文件必须逐个对指纹
    async function send(list, resume) {
      claim();
      pool = pool || new Pool();
      selFiles = list;
      byRel = new Map(list.map((f) => [f.relPath, f]));
      if (resume && resume.record && resume.record.keys) {
        const rec = resume.record;
        const parsed = P.parseCode(rec.code);
        if (!parsed) throw new Error('本地存的传输码读不回来了');
        // 双向核对：少选一个文件，frame 布局就和原会话对不上，对端会永远等不到那几块 —— 必须拒绝
        const saved = rec.files || [];
        for (const f of list) { // 清单先核完再哈希：不然白等一趟才发现对不上
          const want = saved.find((x) => x.relPath === f.relPath);
          if (!want) throw new Error(`这次的清单里没有「${f.name}」，不能续原会话`);
          if (want.size !== f.size) throw new Error(`「${f.name}」大小变了（${want.size} → ${f.size}），不能续原会话`);
        }
        if (list.length !== saved.length) {
          const miss = saved.find((x) => !list.some((f) => f.relPath === x.relPath));
          throw new Error(`原会话还有 ${saved.length - list.length} 个文件没选上（比如「${miss ? miss.name : '?'}」），要续传必须重新选齐同一批`);
        }
        st.sid = parsed.sid;
        secret = parsed.secret;
        proof = await P.proofOf(parsed.sid, parsed.secret);
        token = rec.token;
        st.code = P.formatCode(parsed.sid, parsed.secret);
        restoreKeys(rec);
        resumeMode = true;
        layout = P.planLayout(list);
        st.frames = layout.totalFrames;
        st.totalBytes = layout.files.reduce((s, f) => s + f.size, 0);
        patch({ phase: 'fingerprinting', code: st.code, resumable: true });
        const sha = await fingerprintAll(list);
        if (!sha) return { code: st.code, cancelled: true };
        if (aborted) return { code: st.code, cancelled: true };
        for (const lf of layout.files) {
          lf.sha256 = sha.get(lf.relPath);
          const want = (rec.files || []).find((x) => x.relPath === lf.relPath);
          if (want && want.sha256 && lf.sha256 !== want.sha256) throw new Error(`「${lf.name}」内容已经变了，不能续原会话：请重新发一次`);
        }
        await ensureKeys();
        await setupChannel(); // 同 fresh 分支：rtc 先于事件流
        openStream();
        await exchangeKeys();
        cacheKeys();
        await resumeHandshake();
        return { code: st.code, resumed: true };
      }
      if (resume && resume.record && !resume.record.keys) {
        throw new Error('这个会话的密钥本地已经没了（换过浏览器或清过站点数据），无法续传：请重新发一次');
      }
      // 帧号只依赖大小和路径，先排好：准备阶段的长条和之后传输用的是同一批格子
      layout = P.planLayout(selFiles);
      st.frames = layout.totalFrames;
      st.totalBytes = layout.files.reduce((s, f) => s + f.size, 0);
      patch({ phase: 'fingerprinting' });
      const sha = await fingerprintAll(selFiles);
      if (!sha) return { code: '', cancelled: true };
      // 用户可能在指纹刚算完、还没来得及建会话的那一瞬间点了"取消生成"。
      // 少了这一检查，取消之后照样会 net.create 出一个会话，界面上就是"取消了还在等对方"。
      if (aborted) return { code: '', cancelled: true };
      layout.files.forEach((lf) => { lf.sha256 = sha.get(lf.relPath); });
      secret = P.genSecret();
      st.sid = P.genSid();
      proof = await P.proofOf(st.sid, secret);
      st.code = P.formatCode(st.sid, secret);
      const created = await net.create(st.sid, proof, layout.totalFrames, st.totalBytes);
      token = created.token;
      st.expiresAt = created.expiresAt;
      if (aborted) { await net.finish(st.sid, 'cancel').catch(() => {}); return { code: '', cancelled: true }; }
      patch({ phase: 'waiting', code: st.code });
      await ensureKeys();
      await setupChannel(); // 同上：rtc 必须先于事件流存在
      openStream();
      await exchangeKeys();
      // 不在这里 cacheKeys：会话密钥要等对方公钥到了才派生得出来（onPeerKey 里落盘），
      // 提前写会把 null 密钥存进本地记录，刷新后"看着能续"其实什么都解不开
      return { code: st.code, frames: st.frames };
    }

    async function accept(codeText) {
      claim();
      pool = pool || new Pool();
      const parsed = P.parseCode(codeText);
      if (!parsed) throw new Error('传输码格式不对：应为 8 + 24 个字符（不含 i/l/o/0）');
      st.sid = parsed.sid;
      secret = parsed.secret;
      proof = await P.proofOf(parsed.sid, parsed.secret);
      st.code = P.formatCode(parsed.sid, parsed.secret);
      const rec = readLs('receiver')[parsed.sid];
      if (rec && rec.keys) { restoreKeys(rec); resumeMode = true; }
      const j = await net.join(parsed.sid, proof);
      if (aborted) return { frames: j.frames, totalBytes: j.totalBytes, cancelled: true };
      st.frames = j.frames;
      st.totalBytes = j.totalBytes;
      st.expiresAt = j.expiresAt;
      patch({ phase: 'pairing', code: st.code, resumable: resumeMode });
      if (!resumeMode) writeLs('receiver', parsed.sid, { code: st.code, expiresAt: j.expiresAt });
      await ensureKeys();
      await setupChannel(); // rtc 先就位，再开流收补发的 offer/ice/key
      openStream();
      await exchangeKeys();
      if (resumeMode) await resumeHandshake(); // 恢复不等对方的 key：本地有密钥就能直接接着拉
      return { frames: j.frames, totalBytes: j.totalBytes };
    }

    return api = {
      state: st,
      send,
      accept,
      pause() { paused = true; patch({ phase: 'paused' }); },
      resume() { paused = false; patch({ phase: 'transferring' }); if (role === 'sender') pump(); else pullMissing(); },
      async cancel() {
        aborted = true;
        close(); // 先关：准备阶段还没有会话号可通知服务器，但读文件的线程必须立刻停下来
        patch({ phase: 'cancelled' }); // 状态先落到界面，别让用户等着网络往返
        if (st.sid) await net.finish(st.sid, 'cancel').catch(() => {});
      },
      async refresh() { await refreshAck(); if (role === 'receiver') await pullMissing(); },
      close,
      saveAll,
      collected,
      blobs,
      _test: {
        get sess() { return sess; },
        get acked() { return acked; },
        get storedSet() { return stored; },
        frameFor, acceptFrame, applyManifest, toRanges, expand,
      },
    };
  }

  // 文件指纹：整件文件的逐块 SHA-256 → 链摘要 → 再哈希。算在工作线程里，主线程只收进度。
  async function fingerprintFile(pool, file, onProgress) {
    const r = await pool.fingerprint(file, onProgress);
    return { fileSha256: r.hex, size: file.size };
  }

  global.XferEngine = {
    Session,
    Pool,
    Store,
    toRanges,
    expand,
    listSaved(role) {
      const all = readLs(role);
      const now = Date.now();
      return Object.entries(all)
        .map(([sid, rec]) => ({ sid, code: rec.code, expiresAt: rec.expiresAt, frames: rec.frames, totalBytes: rec.totalBytes, verified: !!rec.verified, token: rec.token }))
        .filter((x) => x.expiresAt > now);
    },
    forget(role, sid) { writeLs(role, sid, null); },
    // 界面用它兜底"一个角色只允许一个会话"；界面自己也要在开局前拦一次
    liveOf(role) { const s = liveSession[role]; return s && isLive(s) ? s.state.phase : ''; },
    warmUp,
    capabilities() {
      return {
        secure: Boolean(global.isSecureContext),
        subtle: Boolean(global.crypto && global.crypto.subtle),
        rtc: typeof RTCPeerConnection === 'function',
        fsAccess: typeof global.showSaveFilePicker === 'function',
        idb: typeof indexedDB !== 'undefined',
        workers: typeof Worker === 'function',
        sse: typeof EventSource === 'function',
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
