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
      // File 可以直接结构化克隆进来，切片读也是异步的，不会把这边也堵死。
      const B = XferProto.PLAIN_BLOCK;
      const file = m.file;
      const chain = [];
      let sentAt = 0;
      for (let off = 0; off < file.size; off += B) {
        const bytes = new Uint8Array(await file.slice(off, Math.min(file.size, off + B)).arrayBuffer());
        chain.push(await XferProto.sha256(bytes));
        const p = Math.min(1, (off + B) / file.size);
        const now = Date.now();
        if (p >= 1 || now - sentAt > 80) { sentAt = now; self.postMessage({ id: m.id, progress: p, doneBytes: Math.min(file.size, off + B) }); }
      }
      if (!chain.length) chain.push(await XferProto.sha256(new Uint8Array(0)));
      const total = await XferProto.sha256(XferProto.cat(...chain));
      self.postMessage({ id: m.id, hex: XferProto.hex(total) });
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
