// 无痕传输的加密工作线程：SHA-256、封帧、开帧都在这边做。
// 为什么必须有它：HTTP 入口没有 WebCrypto，纯 JS AES 单线程只有约 2.6MB/s，
// 放在主线程上会把页面冻住（上传那边已经踩过一次），所以加密封装全部离线到线程池。
importScripts('crypto.js', 'xfer-proto.js');

let pinned = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.engine && m.engine !== pinned) {
      XferProto._test.setEngine(m.engine);
      pinned = m.engine;
    }
    if (m.op === 'sha256') {
      const d = await XferProto.sha256(new Uint8Array(m.bytes));
      self.postMessage({ id: m.id, hex: XferProto.hex(d) });
      return;
    }
    if (m.op === 'fingerprint') {
      // 整件文件的逐块哈希放在这一条线程里跑完：主线程只收进度，2GB 也不该让它卡一下。
      // 读盘按 8MiB 一批：以前每 128KiB 走一次 slice().arrayBuffer()，2GB 就是 16384 次异步往返，
      // 一次 I/O 只摊到 128KiB 上 —— 用户看到的"解析哈希要执行一会儿"主要就是这笔开销。
      // 逐块摘要与链的顺序完全不变（协议与接收端校验都依赖它），只是把 I/O 批量化。
      //
      // from/to：只算这一段（多个线程并行算同一份文件的不同段）。块的切法必须与整份一致 ——
      // 切分点只落在 128KiB 的整数倍上，所以段内的块和整份里的块是同几块。
      const B = XferProto.PLAIN_BLOCK;
      const READ = 8 * 1024 * 1024;
      const file = m.file;
      const from = Number.isFinite(m.from) ? Math.max(0, m.from) : 0;
      const to = Number.isFinite(m.to) ? Math.min(file.size, m.to) : file.size;
      const span = Math.max(0, to - from);
      const chain = [];
      let sentAt = 0;
      const report = (doneBytes) => {
        const now = Date.now();
        if (doneBytes >= span || now - sentAt > 80) {
          sentAt = now;
          self.postMessage({ id: m.id, progress: span ? Math.min(1, doneBytes / span) : 1, doneBytes });
        }
      };
      for (let off = from; off < to; off += READ) {
        const chunk = new Uint8Array(await file.slice(off, Math.min(to, off + READ)).arrayBuffer());
        for (let p = 0; p < chunk.length; p += B) {
          chain.push(await XferProto.sha256(chunk.subarray(p, Math.min(chunk.length, p + B))));
        }
        report(Math.min(span, off + READ - from));
      }
      // digests 交回主线程按段序拼接；整份一个线程时这仍然是同一条链
      self.postMessage({ id: m.id, digests: chain });
      return;
    }
    if (m.op === 'seal') {
      const frame = await XferProto.seal({
        key: new Uint8Array(m.key), sid8: new Uint8Array(m.sid8), type: m.type,
        fileId: m.fileId, chunkIdx: m.chunkIdx, plaintext: new Uint8Array(m.plaintext),
      });
      self.postMessage({ id: m.id, frame }, [frame.buffer]);
      return;
    }
    if (m.op === 'open') {
      const r = await XferProto.open({
        key: new Uint8Array(m.key), sid8: new Uint8Array(m.sid8), frame: new Uint8Array(m.frame),
      });
      // plainLen 必须带回去：主线程拿它和帧头自述的长度对账，漏了这一项就永远比不出相等
      self.postMessage({ id: m.id, fileId: r.fileId, chunkIdx: r.chunkIdx, type: r.type, plainLen: r.plainLen, plaintext: r.plaintext }, [r.plaintext.buffer]);
      return;
    }
    self.postMessage({ id: m.id, error: `未知操作 ${m.op}` });
  } catch (err) {
    self.postMessage({ id: m.id, error: (err && err.message) || '加密失败' });
  }
};
