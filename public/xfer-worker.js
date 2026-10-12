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
