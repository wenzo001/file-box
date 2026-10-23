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
    // 接收端一次并发拉几帧。以前是 for..of + await：一帧一个来回，128KiB/次，
    // 中转路径实测被压在 4MB/s 上下 —— 局域网里这是几十倍的浪费。
    pullParallel: 8,
    p2pTimeoutMs: 8000,     // 直连建链的耐心，到点先走中转（但**不掐死**那条 pc，见 switchChannel）
    lateRtcMs: 120000,      // 已改走中转之后，直连最多再在后台等这么久；一旦 open 就切回直连
    keepMs: 5 * 60 * 1000,  // 会话续期的心跳：页面开着（含后台节流）就别让 2GB 因为"没动"过期
    pollMs: 1500,           // 空转时的轮询间隔（有块子在流进来时退到 40ms，见 schedulePoll）
    pollFastMs: 40,
    ackEvery: 8,            // 攒几块再报一次确认，省请求
    dcBufferHigh: 4 * 1024 * 1024,
    dcBufferLow: 1 * 1024 * 1024,   // 背压恢复的低水位：降到这里才继续发（配合 bufferedamountlow）
    dcDrainTimeoutMs: 30000,        // 缓冲 30 秒还排不动 = 链路真的不行了，这时才允许降级
    dcRegraceMs: 5000,              // disconnected 后的宽限：能自己回到 connected 就不必掐掉一条直连
    retryGapMs: 5000,               // 同一帧两次重发之间至少隔这么久：否则慢确认会被当成"没送到"反复重发
    netTimeoutMs: 30000,            // 单个请求的耐心：超时不算失败到底，只把这一槽位放出来重投
    stallMs: 60000,                 // 主发送循环里"任何一块都没进展"的耐心。只用于主循环：
                                    // 那一段 sentFrames 本该连续推进；而"发完了等对方逐块确认/校验"
                                    // 那一段本来就可能几分钟没有发送侧进展（2GB 的校验就要几分钟），
                                    // 它有自己的 1200×500ms 上界，不该被这把尺子量。
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
      // 只算 [from, to) 这一段：多个线程并行读同一份文件的不同段，2GB 的准备时间约除以线程数。
      // 返回的是**块摘要的有序数组**（不是段摘要），主线程按段序拼起来再链哈希 —— 与单线程逐字节一致。
      fingerprintRange: (file, from, to, onProgress) => call('fingerprint', { file, from, to }, null, onProgress),
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
  function makeApi(role, cred, getCfg) {
    const hdr = (extra) => Object.assign({}, extra,
      role === 'sender' ? { 'X-Xfer-Sender': cred.token } : { 'X-Xfer-Proof': cred.proof });
    const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const json = async (r) => {
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 带上接口路径：一条光秃秃的 "请求失败 (404)" 没法判断是会话过期、路由写错还是代理挡了。
        // 服务端给了 error 文案就用它的（那些文案本来就是说给用户看的）。
        const e = new Error(b.error || `请求失败 (${r.status})${r.__xferUrl ? ` · ${r.__xferUrl}` : ''}`);
        e.status = r.status;
        throw e;
      }
      return b;
    };
    // 每个请求都带超时。理由不是"慢一点不好看"：socket 死了但连接没断时 fetch **既不 resolve 也不 reject**，
    // 于是那一个请求会永远占着发送窗口的一个并行槽 —— 槽被吃满之后整段传输静默停摆，
    // 界面上不报错、进度不动（2GB 真浏览器实测：四个槽全挂住，停在 506/16385 块）。
    // 超时只标成"可重试"，交回原有的重投路；重投同一块是幂等的（nonce 由 type/fileId/chunkIdx 决定，字节完全一样）。
    const timed = (url, opt = {}) => {
      const ms = ((getCfg && getCfg()) || DEFAULTS).netTimeoutMs;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), ms);
      return fetch(url, Object.assign({}, opt, { signal: ac.signal })).catch((err) => {
        if (err && err.name === 'AbortError') throw Object.assign(new Error(`请求超时（${ms}ms 没回来）`), { retry: true });
        throw err;
      }).then((r) => { r.__xferUrl = String(url).split('?')[0]; return r; }) // 出错时能说清是哪一路接口
        .finally(() => clearTimeout(t));
    };
    return {
      config: async () => json(await timed('api/xfer/config')),
      create: (sid, proof, frames, totalBytes) => timed('api/xfer/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, proof, frames, totalBytes }),
      }).then(json),
      join: (sid, proof) => timed('api/xfer/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, proof }),
      }).then(json),
      state: (sid) => timed(`api/xfer/state?${qs({ sid })}`, { headers: hdr({}) }).then(json),
      signal: (sid, kind, body) => timed('api/xfer/signal', {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid, kind, body }),
      }).then(json),
      turn: (sid) => timed(`api/xfer/turn?${qs({ sid })}`, { headers: hdr({}) }).then((r) => (r.ok ? r.json() : null)),
      putSeg: (sid, i, frame) => timed(`api/xfer/seg?${qs({ sid, i })}`, {
        method: 'PUT', headers: hdr({ 'Content-Type': 'application/octet-stream' }), body: frame,
      }).then((r) => (r.status === 429 ? Promise.reject(Object.assign(new Error('中转正忙'), { retry: true })) : json(r))),
      getSeg: async (sid, i) => {
        const r = await timed(`api/xfer/seg?${qs({ sid, i })}`, { headers: hdr({}) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`拉取第 ${i} 块失败 (${r.status})`);
        return new Uint8Array(await r.arrayBuffer());
      },
      ack: (sid, idx) => timed('api/xfer/ack', {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid, idx }),
      }).then(json),
      finish: (sid, kind) => timed(`api/xfer/${kind}`, {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid }),
      }).then((r) => r.ok),
      // 立即销毁并自证。返回 { ok, gone, removed:{segments,bytes} }；gone 才是"可以删本地记录"的前提
      purge: (sid) => timed('api/xfer/purge', {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid }),
      }).then(json),
      // 只读状态码：用来二次核对"会话真的不在了"，而不是只信 purge 的自我声明
      stateStatus: (sid) => timed(`api/xfer/state?${qs({ sid })}`, { headers: hdr({}) }).then((r) => r.status),
      // 残留核验：**不需要凭证**。用户在隐私模式里丢了本地记录、或者换了台机器时，
      // 这是他唯一能"自己核对"服务器上还有没有那 2GB 密文的路（服务端只回段数/字节/到期时间）。
      residue: (sid) => timed(`api/xfer/residue?${qs({ sid })}`, { headers: hdr({}) }).then(json),
      keep: (sid) => timed('api/xfer/keep', {
        method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sid }),
      }).then(json),
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
    // 直连诊断：用户问"同一个局域网为什么还走服务器中转"，界面必须答得出来。
    // host 且地址是 .local 的是 Chrome 的 mDNS 混淆候选 —— 跨机器解析不了就只能里转。
    const diag = { host: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0, gathering: 'new', lastError: '' };
    pc.onicecandidate = (e) => {
      if (!e.candidate) { diag.gathering = 'complete'; handlers.onDiag && handlers.onDiag(diag); return; }
      const c = e.candidate.toJSON();
      const t = c.type || 'host';
      diag[t] = (diag[t] || 0) + 1;
      if (t === 'host' && /\.local$/i.test(String(c.address || ''))) diag.mdns++;
      handlers.onIce(c);
      handlers.onDiag && handlers.onDiag(diag);
    };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState) diag.gathering = pc.iceGatheringState; };
    pc.onicecandidateerror = (e) => { diag.lastError = `${e && e.url || ''} ${e && e.errorText || ''}`.trim().slice(0, 120); };
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
          const chosen = { local: '', remote: '' };
          st.forEach((r) => {
            if (r.type !== 'local-candidate' && r.type !== 'remote-candidate') return;
            if (pair.localCandidateId === r.id) chosen.local = r.candidateType || '';
            if (pair.remoteCandidateId === r.id) chosen.remote = r.candidateType || '';
            if (pair.localCandidateId === r.id || pair.remoteCandidateId === r.id) {
              if (r.candidateType === 'relay') relay = true;
            }
          });
          diag.chosen = chosen;
          return relay ? 'turn_relay' : 'p2p';
        } catch { return open ? 'p2p' : 'none'; }
      },
      close() { try { dc && dc.close(); } catch { /* noop */ } try { pc.close(); } catch { /* noop */ } },
      // 给界面看的直连诊断：候选按类型计数、是不是 mDNS、选中的 pair 两侧类型
      diag: () => Object.assign({}, diag, { chosen: diag.chosen && Object.assign({}, diag.chosen) }),
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
    const net = makeApi(role, { get token() { return token; }, get proof() { return proof; } }, () => cfg);
    const st = {
      role, phase: 'idle', channel: 'none', code: '', sid: '', frames: 0, totalBytes: 0,
      sentFrames: 0, bytesOnWire: 0, dcFrames: 0, relayFrames: 0,
      uploaded: 0, stored: 0, speed: 0, eta: 0,
      safety: '', kex: '', engine: '', error: '', note: '', expiresAt: 0, files: [], verified: false, saved: false, resumable: false,
      // 本机记录到底存下来了没有：''=还不知道，'ok'/'fail'。fail 意味着刷新/关页之后就再也
      // 续不上、也没法用本地凭据请服务器销毁（隐私模式、存储配额满、站点数据被清都会这样）——
      // 这件事必须告诉用户，而不是让他以为"下次还能接着传"。
      persist: '',
      // 这一单比中转配额还大：直连不占中转，所以不是拒绝，但一旦只能走中转就会在配额处停下
      overBudget: false, budget: 0,
      // 本机存储配额 vs 这一单要落的密文量（接收端才有）：配额不够时提前说，别传到 60% 才 QuotaExceeded
      quota: null,
      fpDone: 0, fpTotal: 0,          // 准备阶段：已读/总字节，界面拿它画进度和预计耗时
      // 校验 / 写盘阶段的帧进度。2.5GB 这两个阶段各要几十秒到几分钟，
      // 没有这两个数界面上就只能挂一句静态文案 —— 用户会以为卡死了。
      verifyDone: 0, verifyTotal: 0,
      saveDone: 0, saveTotal: 0,
      peerConfirmed: false,
      // 服务端清空的回执：只有 confirmed 才是"服务器已确认没有这一单的密文"。
      // 用户点了"忘记"却拿不到回执时，本地记录必须留着 —— 否则连"再确认一次"的凭据都没了
      cleanup: null,
      // 直连诊断（候选类型计数 / mDNS / 选中的 pair / 没走直连的原因）
      diag: null,
    };
    let pool = null;
    let secret = '';
    let proof = '';
    let token = '';
    let layout = null;
    let selFiles = [];              // 发送端：{relPath,name,size,mime,file}
    let byRel = new Map();
    let hashP = null;               // 指纹在后台算：码先给用户，清单发送前才等它
    let hashErr = null;
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
    // 卡住之后"自己再试几次"的预算。放在会话作用域而不是 pump() 里：
    // 每次自愈都要重新叫起一个 pump()，若计数器跟着重置，就会变成 stallMs 一轮无限重试 —— 那是另一种无限等待
    let stallTries = 0;
    let beatSent = 0;   // 只有"真的又发出去过块"才把预算还回去；光换一个新的 pump() 不算进展
    let closed = false;
    let aborted = false;            // 用户主动取消（准备阶段也要能停）
    let api = null;
    const ackBuf = new Set();
    let ackTimer = null;
    let keepT = null;
    /** 页面开着就给会话续期：后台标签页的定时器会被节流，但不会完全停（冻结/丢弃另说），
     *  所以 5 分钟一次足够把"30 分钟没动就作废"挡在门外；整单仍有服务端硬上限。 */
    function armKeep() {
      if (keepT || !st.sid) return;
      holdAgainstFreeze();
      keepT = setInterval(() => {
        if (closed || aborted || !st.sid) return;
        if (['done', 'cancelled', 'failed', 'idle'].includes(st.phase)) return;
        net.keep(st.sid).then((r) => { if (r && r.expiresAt) patch({ expiresAt: r.expiresAt }); }).catch(() => {});
      }, Math.max(200, cfg.keepMs || 300000));
      if (keepT.unref) keepT.unref();
    }
    // 让浏览器**不要冻结**这个标签页。定时器节流（1 秒 / 1 分钟一跳）可以忍 —— 传输会慢但还在走；
    // 冻结是另一回事：整个 JS 停下，SSE 读不到、pump 不动，60 秒后看门狗就把这一单判成"卡住了"。
    // 用户嘴里"标签页没在最前面，任务就断了"就是这一档，而且**跟无痕无关**，前台标签之外都算后台。
    // Chrome 的 Page Lifecycle 写明"持有 Web Lock 的页面不会被冻结"，所以这里持一把永不释放的锁，
    // 关页时浏览器自己回收。没有 Web Locks 的浏览器（Firefox/Safari）照旧 —— 那一档只节流，不冻结。
    let lockRelease = null;
    let lockHeld = false;
    function holdAgainstFreeze() {
      if (lockHeld) return;
      const locks = global.navigator && navigator.locks;
      if (!locks || typeof locks.request !== 'function') return;
      lockHeld = true;
      const held = new Promise((resolve) => { lockRelease = resolve; });
      try {
        locks.request(`filebox-xfer|${st.sid}|${role}`, { mode: 'exclusive' }, () => held).catch(() => { lockHeld = false; });
      } catch { lockHeld = false; }
    }
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
      // 先出码的那条路里 phase 已经是 waiting（码已经能给用户看了）：这里顺手把"还要准备多久"说出来，
      // 否则界面上只有一个码，用户不知道背后还在读 2GB
      const upd = (n) => patch(st.phase === 'fingerprinting'
        ? { fpDone: n }
        : { fpDone: n, note: `正在准备文件指纹 ${Math.round((n / total) * 100)}%（可以先把码发给对方）` });
      try {
        for (const f of files) {
          const base = done;
          const r = await fingerprintFile(pool, f.file, (p, bytes) => upd(Math.min(total, base + bytes)));
          sha.set(f.relPath, r.fileSha256);
          done = Math.min(total, base + f.size);
          upd(done);
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
        // 清单里带的是逐件 SHA-256：对方要靠它验完整份内容。码可以先给，但这一帧必须等真摘要，
        // 否则早期版本会把 undefined 写进清单，接收端验到一半才报"内容不符"
        if (hashP) await hashP;
        if (hashErr) throw hashErr;
        if (aborted || closed) return null;
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
          // 一个字节都没走通过道却把整包塞进了服务器 —— 通道标识就该说实话，不能停在"正在建立直连"。
          // 但**不掐死**那条 pc：此刻没开只是因为还没握完手，开了就自动切回直连（keepRtc）。
          if (!st.dcFrames && st.channel !== 'server_relay') switchChannel('server_relay', st.note, { keepRtc: true });
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
      if (!frame || closed || aborted) return;
      await shipFrame(seqN, frame);
      sentAt.set(seqN, Date.now());
      st.sentFrames++;
      // 'pairing' 也要放行：joined 事件会把状态打成 pairing，而 pump 就在这之后立刻起跑 ——
      // 少这一档，整段传输期间发送端都挂着"正在配对"，进度在动、话却不对（真浏览器实测过）
      if (['waiting', 'paired', 'pairing'].includes(st.phase)) patch({ phase: 'transferring' });
      emit();
    }

    /**
     * @param {{keepRtc?: boolean}} [opts]
     *   keepRtc：改走中转，但**先留着那条 pc**。8 秒没建起直连不等于永远建不起来
     *   （ICE 重选、防火墙提示、STUN 响应慢、对端刚切网都会晚到）。以前一律 close()，
     *   于是一次性的建链慢就把整场传输钉死在 4MB/s 的中转上。留着它，一旦 open 就切回直连。
     */
    function switchChannel(to, why, opts) {
      if (st.channel === to) return;
      // 先把状态落定，再关 rtc：rtc.close() 会当场回调 onconnectionstatechange('closed')，
      // 那条回调走 degradeNow，看的是 st.channel —— 后落定的话它会把这次切换当成"还没降过级"
      // 再降一遍，并且在密钥还没落地时就叫起 afterHandshake（于是把 pendingConfirm 提前验，
      // 报一句 sess.kMeta 读不到，接收端就此卡在 retrying）。
      patch({ channel: to, note: why || st.note });
      if (to === 'server_relay' && rtc) {
        if (opts && opts.keepRtc) {
          if (!lateRtcT) {
            lateRtcT = setTimeout(() => {
              lateRtcT = null;
              if (rtc && !rtc.open) { try { rtc.close(); } catch { /* noop */ } rtc = null; }
            }, cfg.lateRtcMs);
            if (lateRtcT.unref) lateRtcT.unref();
          }
        } else {
          try { rtc.close(); } catch { /* noop */ }
          rtc = null;
        }
      }
    }
    let lateRtcT = null;
    let regraceTimer = null;
    /** 认定直连已失效：改走中转并把该跑的循环叫起来（幂等，重复调用不会重复降级） */
    function degradeNow(why) {
      if (st.channel === 'server_relay') return;
      patch({ diag: collectDiag(null, `直连中断（${why}）`) });
      switchChannel('server_relay', `直连中断（${why}），已改用服务器中转（只传密文）`);
      afterHandshake();
    }
    function collectDiag(d, reason) {
      const base = d || (rtc && rtc.diag ? rtc.diag() : {});
      return Object.assign(
        { stun: iceServers.filter((s) => /^stuns?:/i.test(String(s.urls))).length, turn: turnApplied },
        base,
        reason ? { reason } : {},
      );
    }

    // ---------- 发送端主循环（并行窗口 + 只补没确认的块） ----------
    async function pump() {
      if (running || closed || !handshakeDone) return;
      running = true;
      try {
        await sendSeq(0);                       // 清单先到，接收端才知道后面怎么摆
        let cursor = 1;
        const inflight = new Set();
        // 卡住看门狗：主循环每 300ms 转一圈，可"在转圈"不等于"在前进"。
        // sendSeq 里除了网络还有别的会永远不回来的 await（比如某个加密线程被浏览器杀掉：
        // postMessage 发出去了、onmessage 再也不来），那种情况下并行槽被占满、
        // 进度不再动、界面也不报错 —— 2GB 实测撞到的就是这种"静默挂着"。
        // 这里先试着自己恢复（下面 stalled() 那一段：退出去、隔一会儿重新叫起 pump），
        // 试不通才把话说出来并留在"点继续"的档位上 —— 而不是停在"传输中"永远等一个不会来的东西。
        let beatKey = '', beatAt = Date.now();
        const stalled = () => {
          const now = Date.now();
          // 暂停是用户按的，不是卡住：暂停期间不检查，恢复时把计时基准挪过去，
          // 否则"按下暂停 → 过一分钟继续"会被报成卡住（假警报比沉默更糟）
          if (paused) { beatAt = now; return false; }
          const key = `${st.sentFrames}|${acked.size}|${cursor}`;
          if (key !== beatKey) {
            const hadStalled = st.phase === 'retrying' && /卡住/.test(st.error);
            beatKey = key; beatAt = now;
            // 自愈预算只在"真的又发出去过块"时才还：换个新 pump 重进不算进展。
            // 否则线程池死格那种**不可自愈**的卡住会被无限重试下去 —— 正是要消灭的"无限等待"
            if (st.sentFrames > beatSent) { beatSent = st.sentFrames; stallTries = 0; }
            // 自己好了就不能再把"卡住了"挂在脸上：留着旧报错就是"进度在动、话却不对"
            if (hadStalled) patch({ error: '', phase: 'transferring' });
            return false;
          }
          return now - beatAt > cfg.stallMs;
        };
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
          if (stalled()) {
            // 先自己再试两次，而不是把恢复交给人手：这一类卡住多数会自己过去（worker 被重启、
            // 链路恢复）。必须"退出当前 pump 再重进"才有意义 —— 卡住的那些 promise 还挂在
            // inflight 里，留在同一个循环里 continue 只是继续占满窗口。
            const secs = Math.round(cfg.stallMs / 1000);
            if (stallTries < 2) {
              stallTries++;
              fail(`传输卡住了：${secs} 秒没有任何一块有进展，正在自己重试（第 ${stallTries} 次）`, true);
              setTimeout(() => { if (!closed && !aborted) pump(); }, Math.max(300, cfg.retryGapMs)).unref?.();
            } else {
              fail(`传输卡住了：${secs} 秒没有任何一块有进展；点"继续"接着传`, true);
            }
            return;
          }
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
          // 收尾以前是"请求发出去就算成"：服务器 409 拒收时界面照样报"传输完成"，
          // 而服务器账本还停在 paired —— 中转配额不释放，同时对用户撒了谎（实测：账本 paired / 界面说完成）。
          // 现在只认服务器的答复；挂住或抖动就重投，四次都不成也留在"可以继续"的档位，不报死。
          let accepted = false;
          for (let i = 0; i < 4 && !accepted; i++) {
            if (closed) return;
            try { accepted = await net.finish(st.sid, 'done'); }
            catch { /* 超时或抖动：下一轮再来，别把已经传完的一单报成失败 */ }
            if (!accepted && i < 3) await sleep(400 * (i + 1));
          }
          if (accepted) {
            patch({ phase: 'done' });
            writeLs('sender', st.sid, null);
          } else {
            fail('这一单内容都传完了，但服务器没收下收尾；点"继续"可以再收一次', true);
          }
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
    let pullHadWork = false;   // 上一轮真的取到了块 → 下一轮几乎不用等，立刻再问
    async function pullMissing() {
      // 轮询和握手可能同时叫它；两边一起拉会把同几块下一遍（块本身幂等，但白占带宽和内存）
      if (pulling) return true;
      pulling = true;
      let got = 0;
      try {
        const s = await net.state(st.sid);
        expand(s.acked).forEach((n) => acked.add(n));
        st.frames = s.frames;
        st.totalBytes = s.totalBytes;
        const up = expand(s.uploaded);
        st.uploaded = up.length;
        // 0 号帧是加密清单：必须先落地，否则后面那些块排不进布局（acceptFrame 会报"不属于任何清单文件"）
        if (up.length && up[0] === 0 && !stored.has(0)) {
          const m = await net.getSeg(st.sid, 0);
          if (m) { await acceptFrame(m); got++; }
        }
        const need = up.filter((q) => !stored.has(q));
        if (need.length) {
          // 以前是 for..of + await：一帧一个来回、128KiB/次。局域网里这就是 4MB/s 的上限 ——
          // 瓶颈不在带宽也不在加密，而在"同一时刻只有一个请求在飞"。
          let cursor = 0;
          const errs = [];
          const worker = async () => {
            while (cursor < need.length) {
              // 暂停要能立刻停住：8 路并发如果只在轮次之间检查，按了暂停还会再拉一整批
              if (closed || aborted || paused) return;
              const q = need[cursor++];
              if (stored.has(q)) continue;
              let frame = null;
              try { frame = await net.getSeg(st.sid, q); }
              catch (e) { if (e.status !== 404) errs.push(e); return; }
              if (!frame || stored.has(q)) continue;
              try { await acceptFrame(frame); got++; }
              catch (e) { errs.push(e); return; }
            }
          };
          const width = Math.max(1, Math.min(cfg.pullParallel || 8, need.length));
          await Promise.all(Array.from({ length: width }, worker));
          if (errs.length) throw errs[0];
        }
        if (st.error && st.phase === 'retrying') patch({ error: '', phase: 'transferring' });
      } catch (err) {
        pullHadWork = false;
        if (err.status === 404) { patch({ phase: 'waiting', error: '服务器上的这个会话已经过期了' }); return false; }
        patch({ error: err.message || '网络不稳，正在重试', phase: 'retrying' });
      } finally {
        pulling = false;
      }
      // 已经从服务器拉到过块，却一个字节都没走通过道 —— 标识就该如实改成中转。
      // 发送端早就有这条规矩，接收端一直没有：短传输会在整段时间里显示"正在尝试点对点直连"，
      // 而它每一块都是从服务器拉下来的（冒烟实测：长条走到 100% 时还写着"正在建直连"）。
      // keepRtc：直连还在后台试，开了就切回去。
      if (got > 0 && !(rtc && rtc.open) && st.channel !== 'server_relay') {
        switchChannel('server_relay', '正在走服务器中转（直连仍在后台尝试）', { keepRtc: true });
      }
      pullHadWork = got > 0;
      emit();
      return true;
    }
    // 接收端要主动追问：服务器中转时发送方是一块一块上传的，配对那一刻拉到的只是当时有的。
    // 不轮询就会永远停在"刚配对时的那几块"上，两边互相等，直到超时。
    // 间隔是自适应的：取到过块就几乎不歇（否则每个来回后面白等 1.5 秒，占空比被压到 40% 以下），
    // 空转则退到 pollMs —— 既不空烧请求，也不给吞吐设天花板。
    let pollT = null;
    function schedulePoll() {
      if (pollT || closed || role !== 'receiver') return;
      pollT = setTimeout(async () => {
        pollT = null;
        if (closed || st.verified) return;
        if (!paused && handshakeDone) await pullMissing();
        schedulePoll();
      }, pullHadWork ? (cfg.pollFastMs || 40) : cfg.pollMs);
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
    // 校验/写盘都要把每一块重新解一遍。以前是 for 里 await，一帧一个来回 ——
    // 2.5GB 两万帧，光调度就够几十秒到几分钟，而界面这段时间**一个字都不变**
    // （用户的原话："卡了很久，最后才弹出保存按钮"）。现在按批并发开帧，
    // 每批推一次 verifyDone，界面上的百分比才是活的。
    const VERIFY_BATCH = 8;
    // 校验要跑几十秒到几分钟。`persist()` 在"最后一块到达"之后还可能再进来一次（重复帧幂等），
    // 以前校验很快所以撞不上；现在必须挡住，否则会同时跑两条复核循环（CPU 翻倍、百分比乱跳）。
    let verifying = false;
    async function finishReceive() {
      if (st.verified || verifying) return;
      verifying = true;
      // 0 号帧是加密清单：它在 acceptFrame 里已经开过一次，复核/写盘都不再走它。
      // 所以这里的"总块数"要减掉它，否则进度永远差一块、停在 98%。
      const dataFrames = Math.max(1, layout.totalFrames - 1);
      patch({ phase: 'verifying', verifyDone: 0, verifyTotal: dataFrames });
      try {
        let done = 0;
        for (const f of layout.files) {
          const key = await fileKey(f.fileId);
          const digests = new Array(f.chunks.length);
          let total = 0;
          for (let c = 0; c < f.chunks.length; c += VERIFY_BATCH) {
            const upto = Math.min(f.chunks.length, c + VERIFY_BATCH);
            const batch = [];
            for (let k = c; k < upto; k++) batch.push(k);
            const parts = await Promise.all(batch.map(async (k) => {
              const frame = await readStoredFrame(f.seqBase + k, f.name);
              const r = await pool.open({ key: Array.from(key), sid8: Array.from(sess.sid8), frame });
              const pt = new Uint8Array(r.plaintext);
              if (pt.length !== f.chunks[k]) throw new Error(`「${f.name}」第 ${k} 块长度不对`);
              return pt;
            }));
            // 哈希必须按块序算（链），所以"并发只并发解密，摘要仍然顺序算"
            for (let i = 0; i < parts.length; i++) {
              digests[c + i] = await P.sha256(parts[i]);
              total += parts[i].length;
              done++;
            }
            patch({ verifyDone: done });
          }
          if (total !== f.size) throw new Error(`「${f.name}」总长度不对`);
          if (f.sha256 && P.hex(await P.sha256(catChunked(digests))) !== f.sha256) {
            throw new Error(`「${f.name}」内容校验失败，可能被人动过`);
          }
        }
        await flushAcks();
        // 清掉尾巴上的一次性抖动报错：校验已经通过，界面上还挂着"会话已过期"就是假警报
        patch({ phase: 'ready', verified: true, error: '', verifyDone: st.verifyTotal });
        writeLs('receiver', st.sid, Object.assign({}, readLs('receiver')[st.sid] || {}, { verified: true }));
      } catch (err) {
        fail(err.message || err);
      } finally {
        // 只有"没验成"才允许重来：验过了就锁死，别让后来的重复帧再跑一遍
        if (!st.verified) verifying = false;
      }
    }

    // 保存分三条路，按"能不能不把整份文件攥在内存里"排序：
    //   1) 调用方给了 streamToFile（FS Access 选到真实目录）→ 直接流式写盘；
    //   2) 没有 FS Access 但有 OPFS（Chrome 86+/Safari 15.2+）→ 逐块写进 OPFS 暂存，
    //      collected() 交回的是**磁盘支撑的 File**，浏览器下载时自己流式读，不在 JS 堆里攒整份；
    //   3) 两样都没有 → 才退回"明文块攒进 blobs，最后 new Blob 一次"（移动端小文件尚可，
    //      大文件会占住整份内存 —— 120MB 实测留着 120MB 明文，就是这条兜底）。
    // 暂存目录是**明文**，所以有它自己的清理路径：dropSaved() + 每次新会话开工前 sweepSaved()。
    const OUT_DIR = 'xfer-out';
    async function outDir(create) {
      try {
        if (!global.navigator || !navigator.storage || !navigator.storage.getDirectory) return null;
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(OUT_DIR, { create: !!create });
      } catch { return null; }
    }
    async function sweepSaved() {
      const d = await outDir(false);
      if (!d) return;
      for await (const k of d.keys()) { try { await d.removeEntry(k, { recursive: true }); } catch { /* 还被人开着，下次再清 */ } }
    }
    async function dropSaved() {
      savedHandles.clear();
      await sweepSaved();
    }
    const savedHandles = new Map();
    async function saveAll(streamToFile) {
      if (!st.verified) throw new Error('还没通过完整性校验');
      patch({ phase: 'saving', saveDone: 0, saveTotal: Math.max(1, layout.totalFrames - 1) });
      await sweepSaved();          // 上一轮的明文暂存先清掉，再落这一轮的
      let done = 0;
      for (const f of layout.files) {
        const key = await fileKey(f.fileId);
        let w = null;
        if (streamToFile) w = await streamToFile(f);
        else {
          const d = await outDir(true);
          const fh = d && await d.getFileHandle(String(f.fileId), { create: true });
          if (fh) { savedHandles.set(f.relPath, fh); w = await fh.createWritable(); }
        }
        for (let c = 0; c < f.chunks.length; c += VERIFY_BATCH) {
          const upto = Math.min(f.chunks.length, c + VERIFY_BATCH);
          // 解密并发、写盘有序：写是流水（顺序不能乱），解是纯计算（可以并行）。
          // 以前整条链路串着走，2.5GB 的"保存"要几分钟且界面停在"正在解密写盘"一句话上。
          const parts = await Promise.all(Array.from({ length: upto - c }, (_, i) => (async () => {
            const frame = await readStoredFrame(f.seqBase + c + i, f.name);
            return new Uint8Array((await pool.open({ key: Array.from(key), sid8: Array.from(sess.sid8), frame })).plaintext);
          })()));
          for (const pt of parts) {
            if (w) await w.write(pt);
            else yieldBlob(f, pt);
            done++;
          }
          patch({ saveDone: done });
        }
        if (w) await w.close();
      }
      patch({ phase: 'done', saved: true, saveDone: st.saveTotal });
      // 归组按 relPath 而不是 name：同一批里两个不同子目录下的同名文件，
      // 按名字归组会把两块并成同一个 Blob（另一个则被覆盖）
      function yieldBlob(f, pt) { (blobs[f.relPath] = blobs[f.relPath] || []).push(pt); }
    }
    const blobs = {};
    async function collected() {
      const out = [];
      for (const f of layout.files) {
        const fh = savedHandles.get(f.relPath);
        // File 是 Blob 的子类，界面那侧 URL.createObjectURL 一行都不用改
        const blob = fh ? await fh.getFile() : new Blob(blobs[f.relPath] || []);
        out.push({ name: f.name, relPath: f.relPath, size: f.size, blob });
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
    /** 清单里每个文件的续传指纹：尺寸 + 修改时间 + 摘要。mtime 用来判断"还是不是上次那一份"，
     *  对得上就沿用摘要，2GB 不必为了续传再把整份读一遍。 */
    function fileRecs() {
      return layout ? layout.files.map((f) => {
        const src = byRel.get(f.relPath);
        return { relPath: f.relPath, name: f.name, size: f.size, sha256: f.sha256, mtime: (src && src.file && src.file.lastModified) || 0 };
      }) : [];
    }
    function refreshSavedFiles() {
      const rec = readLs(role)[st.sid];
      if (!rec) return;
      rec.files = fileRecs();
      writeLs(role, st.sid, rec);
    }
    /** 码已经给出去之后再算：算完把摘要补进 layout（清单必须带真摘要），并刷新本地记录 */
    function startHashing() {
      hashErr = null;
      hashP = fingerprintAll(selFiles).then((sha) => {
        if (!sha) return null;
        layout.files.forEach((lf) => { lf.sha256 = sha.get(lf.relPath); });
        refreshSavedFiles();
        if (st.note && /准备文件指纹/.test(st.note)) patch({ note: '' });
        return sha;
      }).catch(async (err) => {
        hashErr = err;
        if (closed || aborted) return null;
        await net.purge(st.sid).catch(() => {}); // 会话已建：算不出来就把账本和密文一起收掉，别留一单孤儿
        writeLs(role, st.sid, null);
        fail(`准备文件指纹失败：${err.message || err}`);
        return null;
      });
      hashP.catch(() => { /* frameFor 会把它抛给用户，这里只防未处理 rejection */ });
      return hashP;
    }
    function cacheKeys() {
      const rec = {
        code: P.formatCode(st.sid, secret), expiresAt: st.expiresAt, frames: st.frames, totalBytes: st.totalBytes,
        safety: sess.safety, kex: sess.kex,
        keys: { kRec: P.hex(sess.kRec), kMeta: P.hex(sess.kMeta), kConfirm: P.hex(sess.kConfirm), sid8: P.hex(sess.sid8) },
      };
      if (role === 'sender') rec.token = token;
      rec.files = fileRecs();
      st.resumable = writeLs(role, st.sid, rec);
      // 存不下来就说出来。隐私模式/配额满时这里会失败，而用户看到的上一版什么都没有 ——
      // 他以为能接着传，刷新之后才知道不能，那时也没了销毁的凭据。
      st.persist = st.resumable ? 'ok' : 'fail';
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
    // 服务端到底配没配 TURN。不记住它的话，upgradeIceWithTurn 会对着一个
    // 明确说了"没配"的服务器再问一次，拿到 503 —— 浏览器控制台就多一条红字，
    // 读起来像传输出错了（实际什么都没发生）。
    let turnPossible = false;
    /**
     * 发送方的 rtc 必须先于事件流建好（否则会漏掉对方的 offer），可那一刻会话还没配对，
     * /turn 会 409 —— 于是发送方永远拿不到 relay 候选，TURN 形同虚设。
     * 收到 joined 之后补取一次，并用 setConfiguration 把 relay 服务器加进正在进行的 ICE。
     */
    async function upgradeIceWithTurn() {
      if (turnApplied || !rtc || !turnPossible) return;
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
      turnPossible = !!c.turnConfigured;
      if (c.turnConfigured) {
        const t = await net.turn(st.sid).catch(() => null);
        if (t && t.urls && t.urls.length) {
          iceServers.push({ urls: t.urls, username: t.username, credential: t.credential });
          turnApplied = true; // 接收方走到这里时已经配对，凭证一次就拿到了
        }
      }
      rtc = p2p(iceServers, {
        onIce: (json) => { net.signal(st.sid, 'ice', JSON.stringify(json)).catch(() => {}); },
        onDiag: (d) => patch({ diag: collectDiag(d) }),
        onFrame: (frame) => { if (role === 'receiver') acceptFrame(frame).catch((e) => fail(e.message || e)); },
        onState: async (state, open) => {
          if (open) {
            if (regraceTimer) { clearTimeout(regraceTimer); regraceTimer = null; } // 自己回来了，之前的"要降级"作废
            // 已经关掉的 pc 不该走到这里；真走到（对端重新拉起通道）也只是没有它可用，
            // 不能拿 null 去调 mode() 把一句 TypeError 顶上用户界面
            const mode = rtc ? await rtc.mode() : 'server_relay';
            switchChannel(mode); // 直连/TURN 各自的说明由界面 CHAN 文案给，不重复塞一句
            patch({ diag: collectDiag(null) });
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
        // keepRtc：先走中转把进度推起来，但直连仍在后台继续试。它一旦 open，
        // onState 里会把通道如实改回 p2p —— 而不是"第一秒没建好就整场 4MB/s"。
        switchChannel('server_relay', '直连建立超时，已先用服务器中转（直连仍在后台尝试）', { keepRtc: true });
        patch({ diag: collectDiag(null, `直连建立超时（${Math.round(cfg.p2pTimeoutMs / 1000)} 秒内没建起来）`) });
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
      if (lateRtcT) { clearTimeout(lateRtcT); lateRtcT = null; }
      // 放掉那把防冻结的锁：会话结束了就不该再拦着浏览器回收这个页面
      if (lockRelease) { lockRelease(); lockRelease = null; lockHeld = false; }
      timers.forEach(clearTimeout);
      timers.length = 0;
      if (link) link.close();
      if (rtc) rtc.close();
      if (pollT) { clearTimeout(pollT); pollT = null; }
      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
      if (keepT) { clearInterval(keepT); keepT = null; }
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
        // 文件没变（尺寸 + 修改时间 + 上次摘要都在）就沿用上次的摘要：
        // 续传不该为了同一份 2GB 再把盘读一遍（用户点的"接着传"要立刻动起来）
        const savedByRel = new Map((rec.files || []).map((x) => [x.relPath, x]));
        const reusable = list.every((f) => {
          const w = savedByRel.get(f.relPath);
          return !!(w && w.sha256 && w.size === f.size && w.mtime && f.file && f.file.lastModified === w.mtime);
        });
        if (reusable) {
          layout.files.forEach((lf) => { lf.sha256 = savedByRel.get(lf.relPath).sha256; });
          patch({ phase: 'fingerprinting', code: st.code, resumable: true, fpTotal: st.totalBytes, fpDone: st.totalBytes, note: '沿用上次的校验值（文件没变），不重算' });
        } else {
          patch({ phase: 'fingerprinting', code: st.code, resumable: true });
          const sha = await fingerprintAll(list);
          if (!sha) return { code: st.code, cancelled: true };
          if (aborted) return { code: st.code, cancelled: true };
          for (const lf of layout.files) {
            lf.sha256 = sha.get(lf.relPath);
            const want = (rec.files || []).find((x) => x.relPath === lf.relPath);
            if (want && want.sha256 && lf.sha256 !== want.sha256) throw new Error(`「${lf.name}」内容已经变了，不能续原会话：请重新发一次`);
          }
        }
        await ensureKeys();
        // 先问一句服务器：这一单还在不在。不在就别装模作样地"连接中"——
        // 用户要的是"已经没了、需要重发"，而不是盯着一个永远不会动的进度条（过期后 SSE 只会无限重连）
        try {
          const sv = await net.state(st.sid);
          st.frames = sv.frames;
          st.totalBytes = sv.totalBytes;
          st.expiresAt = sv.expiresAt;
        } catch (err) {
          if (err.status === 404 || err.status === 410) {
            throw new Error('这一单在服务器上已经结束（过期或已被清空），需要重新发一次。刚才的校验值还留在本地，重发时不用重算');
          }
          throw err;
        }
        await setupChannel(); // 同 fresh 分支：rtc 先于事件流
        openStream();
        await exchangeKeys();
        cacheKeys();
        armKeep();
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
      secret = P.genSecret();
      st.sid = P.genSid();
      proof = await P.proofOf(st.sid, secret);
      st.code = P.formatCode(st.sid, secret);
      // 先把码建出来给用户：2GB 的指纹要算一阵，不能让"把码发给对方"这一步排在它后面空等。
      // 指纹在后台并行算；清单帧（frameFor(0)）发送前才等它，所以不会把半个清单发出去。
      const created = await net.create(st.sid, proof, layout.totalFrames, st.totalBytes);
      token = created.token;
      st.expiresAt = created.expiresAt;
      // 预算如实带回界面：走直连一个字节都不进中转区，所以只在"最终只能中转"时才真的卡住。
      // 以前这里一声不响，用户看到的就是"跑到 2GB 忽然断了"。
      patch({ overBudget: !!created.overBudget, budget: Number(created.limitBytes) || 0 });
      if (aborted) {
        await net.purge(st.sid).catch(() => {});
        return { code: '', cancelled: true };
      }
      patch({ phase: 'waiting', code: st.code });
      startHashing();
      armKeep();
      await ensureKeys();
      await setupChannel(); // 同上：rtc 必须先于事件流存在
      openStream();
      await exchangeKeys();
      // 不在这里 cacheKeys：会话密钥要等对方公钥到了才派生得出来（onPeerKey 里落盘），
      // 提前写会把 null 密钥存进本地记录，刷新后"看着能续"其实什么都解不开
      return { code: st.code, frames: st.frames };
    }

    /** 接收端要把密文帧落到本机（断点续传全指望它）。浏览器给的存储配额比这一单还小时，
     *  传到一半必定 QuotaExceeded —— 隐私模式尤其明显。问一句 `storage.estimate()` 就能提前说，
     *  比让它在 60% 处停住强。问不到（旧浏览器/被策略拦）就什么都不说，不猜。 */
    function quotaHint(need) {
      try {
        if (!global.navigator || !navigator.storage || !navigator.storage.estimate) return;
        navigator.storage.estimate().then((est) => {
          if (est && est.quota) patch({ quota: { need, quota: est.quota } });
        }).catch(() => {});
      } catch { /* 没有这个接口就不提 */ }
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
      // 上一轮可能留下过明文暂存（下载没走完就关了页）：进来先扫一遍再干活
      await sweepSaved().catch(() => {});
      const rec = readLs('receiver')[parsed.sid];
      if (rec && rec.keys) { restoreKeys(rec); resumeMode = true; }
      let j;
      try {
        j = await net.join(parsed.sid, proof);
      } catch (err) {
        if (err.status === 404 || err.status === 410) throw new Error('这一单在服务器上已经结束（过期或已被清空），请让对方重新发一次');
        throw err;
      }
      if (aborted) return { frames: j.frames, totalBytes: j.totalBytes, cancelled: true };
      st.frames = j.frames;
      st.totalBytes = j.totalBytes;
      st.expiresAt = j.expiresAt;
      patch({ phase: 'pairing', code: st.code, resumable: resumeMode });
      quotaHint(j.totalBytes);
      armKeep();
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
      /**
       * 「继续」——也从"卡住了 / 出错了"这一档回到传输。
       * 以前只有一个 pause()/resume() 对：界面在 retrying 上把按钮写成"暂停"，
       * 点一下反而把一单正在重试的传输停住，用户以为坏了（这也是"没法重新发"的一部分体感）。
       * 现在这一档的按钮就叫「继续」，走的就是这里：清掉旧报错、重新起循环。
       */
      resume() {
        paused = false;
        patch({ phase: handshakeDone ? 'transferring' : 'pairing', error: '' });
        if (role === 'sender') { pump(); refreshAck(); }
        else { pullMissing(); schedulePoll(); }
      },
      async cancel() {
        aborted = true;
        const sid = st.sid;
        // 准备阶段还没有会话号：这一下只是"别算了"，没有密文可清，如实标成已确认 0 字节
        const r = sid
          ? await net.purge(sid).catch((err) => ({ ok: false, gone: false, error: err.message || String(err) }))
          : { ok: true, gone: true, removed: { segments: 0, bytes: 0 } };
        close(); // 先关：读文件的线程必须立刻停下来
        if (sid && r.gone) { writeLs(role, sid, null); st.resumable = false; } // 服务器确认清空了，本地凭据才删
        patch({
          phase: 'cancelled',
          cleanup: {
            confirmed: !!r.gone,
            segments: (r.removed && r.removed.segments) || 0,
            bytes: (r.removed && r.removed.bytes) || 0,
            error: r.gone ? '' : (r.error || '服务器没有确认清空'),
          },
        });
        return r;
      },
      async refresh() { if (st.sid) await net.keep(st.sid).catch(() => {}); await refreshAck(); if (role === 'receiver') await pullMissing(); },
      close,
      saveAll,
      collected,
      blobs,
      dropSaved,
      _test: {
        get sess() { return sess; },
        get acked() { return acked; },
        get storedSet() { return stored; },
        frameFor, acceptFrame, applyManifest, toRanges, expand,
      },
    };
  }

  /** 按序拼接若干个定长摘要再哈希。分 4096 个一批拼接：20 万块时一次性展开进
   *  `P.cat(...chain)` 会直接 RangeError（参数个数上限），那是"大文件算指纹必崩"的隐患。 */
  function catChunked(list, size = 4096) {
    if (!list.length) return new Uint8Array(0);
    const parts = [];
    for (let i = 0; i < list.length; i += size) parts.push(P.cat(...list.slice(i, i + size)));
    return parts.length === 1 ? parts[0] : P.cat(...parts);
  }

  // 文件指纹：整件文件的逐块 SHA-256 → 链摘要 → 再哈希。算在工作线程里，主线程只收进度。
  //
  // 单文件按线程数切段并行：切点只落在 128KiB 的整数倍上，所以段内的块与整份的块是同一批，
  // 拼回来的链与单线程逐字节相同（`test/fingerprint.test.js` 对的是同一条参考实现）。
  // 以前是一条线程从头读到尾 —— 2GB 要几十秒，而"码已经给出去了、进度条却卡在指纹上"正是
  // 用户体感最差的那一段（配置里 4 条加密线程，3 条一直闲着）。
  async function fingerprintFile(pool, file, onProgress) {
    const B = P.PLAIN_BLOCK;
    const blocks = Math.max(1, Math.ceil(file.size / B));
    // 小文件不值得切：一个线程 16MiB 只要几十毫秒，切段反而多出调度与拼装。
    const parts = file.size < 16 * 1024 * 1024 ? 1 : Math.max(1, Math.min(pool.size, blocks));
    const per = Math.ceil(blocks / parts);
    const ranges = [];
    for (let i = 0; i < parts; i++) {
      const a = i * per;
      const b = Math.min(blocks, (i + 1) * per);
      if (a >= b) break;
      ranges.push({ from: a * B, to: Math.min(file.size, b * B) });
    }
    const got = new Array(ranges.length).fill(0);
    const report = () => {
      if (!onProgress) return;
      const sum = got.reduce((x, y) => x + y, 0);
      onProgress(file.size ? Math.min(1, sum / file.size) : 1, sum);
    };
    const res = await Promise.all(ranges.map((r, i) => pool.fingerprintRange(file, r.from, r.to, (p, bytes) => {
      got[i] = Math.max(0, Math.min(r.to - r.from, Number(bytes) || 0));
      report();
    })));
    const chain = [];
    for (const r of res) for (const d of ((r && r.digests) || [])) chain.push(d);
    if (!chain.length) chain.push(await P.sha256(new Uint8Array(0))); // 空文件也有"一块"
    return { fileSha256: P.hex(await P.sha256(catChunked(chain))), size: file.size };
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
        .map(([sid, rec]) => ({
          sid, code: rec.code, expiresAt: rec.expiresAt, frames: rec.frames, totalBytes: rec.totalBytes,
          verified: !!rec.verified, token: rec.token, files: rec.files || [],
          // 续传必须拿到完整记录（含 keys）：以前这里只给出展示字段，界面点"续传"时
          // send() 看到 record.keys 不存在，直接报"密钥本地已经没了" —— 发送端续传从来没成功过
          record: rec,
          // 过期的不再隐藏：用户需要能对"我传过的那一单"再核一次服务器，而不是让记录凭空消失
          expired: !(rec.expiresAt > now),
        }))
        .sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
    },
    /**
     * 让服务器立即销毁这一单，并核对两件事：它回了 gone，且再查状态是 404/410。
     * 只有两件都成立才删本地记录；否则返回 gone:false，本地凭据留着等用户再点一次。
     */
    async purgeSaved(role, sid) {
      const rec = readLs(role)[sid];
      if (!rec) return { gone: true, removed: { segments: 0, bytes: 0 }, already: true };
      let cred;
      if (role === 'sender') {
        if (!rec.token) return { gone: false, error: '本地记录里没有发送方凭证，没法请服务器销毁（可在服务器端按过期回收）' };
        cred = { token: rec.token };
      } else {
        const parsed = P.parseCode(rec.code || '');
        if (!parsed) return { gone: false, error: '本地记录里没有可用的传输码，没法请服务器销毁（可在服务器端按过期回收）' };
        cred = { proof: await P.proofOf(parsed.sid, parsed.secret) };
      }
      const api = makeApi(role, cred, () => DEFAULTS);
      let j;
      try {
        j = await api.purge(sid);
      } catch (err) {
        // 销毁请求本身失败时，用只读状态码分辨"其实已经没了"和"真的没清"
        const code = await api.stateStatus(sid).catch(() => 0);
        if (code === 404 || code === 410) { writeLs(role, sid, null); return { gone: true, removed: { segments: 0, bytes: 0 }, already: true }; }
        return { gone: false, error: err.message || String(err) };
      }
      if (!j || !j.gone) return { gone: false, removed: (j && j.removed) || null, error: '服务器说还没清干净' };
      const code = await api.stateStatus(sid).catch(() => 0);
      if (code !== 404 && code !== 410) return { gone: false, removed: j.removed, error: `服务器仍能查到这一单（HTTP ${code || '?'}）` };
      writeLs(role, sid, null);
      return { gone: true, removed: j.removed || { segments: 0, bytes: 0 } };
    },
    forget(role, sid) { writeLs(role, sid, null); },
    /**
     * 只读残留核验，**不需要任何凭据**（本地记录没了也能问）。
     * 返回 { exists, segments, bytes, state, expiresAt }。
     * 为什么要有它：能销毁这一单的 token/proof 只存在浏览器本地，隐私模式、清站点数据、
     * 换台机器都会让它消失 —— 那时用户除了"相信 30 分钟后会清"，本来没有任何可核对的话。
     */
    async residue(sid) {
      const r = await fetch(`api/xfer/residue?sid=${encodeURIComponent(String(sid))}`, { cache: 'no-store' });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || `查询失败 (${r.status})`);
      return b;
    },
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
        // 有没有 Web Locks：有则能阻止浏览器冻结后台标签页（Chrome/Edge），
        // 没有（Firefox/Safari）就只有定时器节流 —— 传输会变慢但不会断
        locks: !!(global.navigator && navigator.locks && typeof navigator.locks.request === 'function'),
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
