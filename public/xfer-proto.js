// 无痕传输的统一加密协议：会话配对、密钥阶梯、分块帧格式、nonce 与 AAD 绑定。
//
// 一份实现同时跑在浏览器与 Node（测试直接 require），并且 **WebCrypto 引擎与纯 JS 引擎必须
// 产出逐字节相同的帧** —— 这一点由测试用另一侧引擎解开交叉验证。三个传输通道（P2P 直连、
// TURN 中继、服务器密文中转）都只是搬运这里的帧，谁都不许自己再发明一套加密或续传。
//
// 设计要点（为什么长这样）：
// * 传输码 = sid(8) + 秘密段(24)，都用 32 字符字母表（剔掉 i/l/o/0/1 这类看不清的）＝ 40bit + 120bit。
//   sid 是公开的会话地址，服务器看得到；秘密段从不发给服务器，因此"只拿到公开那半"没有解密能力，
//   也拿不到配对凭证。120bit 的熵让"服务器离线猜码"失去意义（不需要额外上一套自研 PAKE）。
// * 密钥阶梯：HKDF-SHA256(RFC 5869)，输入材料 = ECDH 共享值（安全上下文下）+ 秘密段，
//   salt 绑定 transcript（双方公钥与 kex 的哈希）→ 派生 record / meta / confirm 三把独立密钥。
//   中间人若替换公钥，transcript 变了 → confirm MAC 对不上 → 两端的安全码不一致，当场可见。
// * 帧的 AAD = 帧头（版本/类型/文件号/块号/明文长度）+ 会话标签 → 密文替换、块重排、跨会话混入
//   都会在认证标签这一步直接失败，而不是解密之后才发现内容不对。
// * nonce = f(类型, 文件号, 块号)，不再另发：同一块重传时是**完全相同的字节**，接收端按块号幂等，
//   因此"重传/恢复/换通道"都不会造成同一密钥下 nonce 被两个不同明文复用。
(function (global) {
  'use strict';

  const MAGIC = 0xfb;
  const VER = 1;
  const TYPE_META = 1;
  const TYPE_DATA = 2;
  const HEADER_LEN = 19; // magic+ver+type(3) | fileId(4) | chunkIdx(8) | plainLen(4)
  const TAG_LEN = 16;
  const NONCE_LEN = 12;
  const PLAIN_BLOCK = 128 * 1024; // 密文帧 ≈ 128KiB+35 < DataChannel 单条 256KiB 上限
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz123456789'; // 正好 32 个：26 个字母去掉 i/l/o + 数字 1-9，一字节取 5bit 无偏
  const SID_LEN = 8;
  const SEC_LEN = 24;
  const te = new TextEncoder();
  const td = new TextDecoder();

  const W = global.crypto || null;
  const hasNative = !!(W && W.subtle);
  const F = () => global.FBCrypto;

  let engineWanted = 'auto'; // 'auto' | 'native' | 'js'
  const nativeOn = () => engineWanted !== 'js' && hasNative;
  const ecdhOn = () => nativeOn(); // ECDH 只有 WebCrypto 有；纯 JS 引擎下走"仅口令"密钥阶梯

  // ---------- 小工具 ----------
  const cat = (...arr) => {
    const out = new Uint8Array(arr.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of arr) { out.set(a, o); o += a.length; }
    return out;
  };
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => Uint8Array.from((s.match(/../g) || []).map((h) => parseInt(h, 16)));
  const eq = (a, b) => {
    if (!a || !b || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  };
  const random = (n) => {
    const u = new Uint8Array(n);
    W.getRandomValues(u);
    return u;
  };

  // ---------- 传输码 ----------
  const randChars = (n) => {
    const b = random(n);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[b[i] & 31]; // 256 % 32 == 0 → 取样无偏
    return s;
  };
  const genSid = () => randChars(SID_LEN);
  const genSecret = () => randChars(SEC_LEN);
  const formatCode = (sid, secret) => `${sid}-${secret}`.replace(/(.{4})(?=.)/g, '$1-');
  function parseCode(str) {
    const clean = String(str || '').toLowerCase().replace(/[^a-z1-9]/g, '');
    if (clean.length !== SID_LEN + SEC_LEN) return null;
    const sid = clean.slice(0, SID_LEN);
    const secret = clean.slice(SID_LEN);
    return { sid, secret };
  }
  /** 配对凭证：服务器只存这个 HMAC 摘要，既验得出"你有没有码"，又反推不出码、更派生不出解密密钥 */
  async function proofOf(sid, secret) {
    return hex(await hmac(te.encode(`filebox-xfer-v1/proof|${sid}`), te.encode(secret)));
  }

  // ---------- SHA-256 / HMAC / HKDF（两个引擎结果必须一致） ----------
  async function sha256(u8) {
    if (nativeOn()) return new Uint8Array(await W.subtle.digest('SHA-256', u8));
    return F()._test.sha256(u8);
  }
  async function hmac(key, msg) {
    if (nativeOn()) {
      const k = await W.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await W.subtle.sign('HMAC', k, msg));
    }
    return F()._test.hmacSha256(key, msg);
  }
  /** HKDF-SHA256 (RFC 5869)：extract + expand，一字不改照标准来。
   *  手写是因为非安全上下文没有 subtle HKDF；正确性由测试对 node:crypto 的 hkdfSync 逐字节复算来卡。 */
  async function hkdf(ikm, salt, info, len) {
    const infoB = te.encode(info);
    const prk = await hmac(salt, ikm); // ExtractKeyMaterial(salt, IKM)
    let t = new Uint8Array(0);
    const out = [];
    let got = 0;
    for (let i = 1; got < len; i++) {
      t = await hmac(prk, cat(t, infoB, new Uint8Array([i]))); // T(i) = HMAC(PRK, T(i-1) | Info | i)
      out.push(t);
      got += t.length;
    }
    return cat(...out).subarray(0, len);
  }

  // ---------- ECDH（仅安全上下文；没有时 kex='code'，仍然端到端加密，只是没有前向保密） ----------
  async function genEcdh() {
    if (!ecdhOn()) return { kex: 'code', priv: null, pub: new Uint8Array(0) };
    const kp = await W.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await W.subtle.exportKey('raw', kp.publicKey));
    return { kex: 'p256', priv: kp.privateKey, pub: raw };
  }
  async function ecdhShared(privKey, peerPub) {
    if (!privKey) return new Uint8Array(0); // kex='code' 那一档没有临时密钥对，共享值就是空
    const pub = await W.subtle.importKey('raw', peerPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await W.subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256);
    const out = new Uint8Array(bits);
    if (out.length !== 32 || Array.from(out).every((b) => b === 0)) throw new Error('ECDH 没算出共享秘密');
    return out;
  }

  // ---------- 会话密钥阶梯 ----------
  const sidTag = async (sid) => (await sha256(te.encode(`filebox-xfer-v1/sid|${sid}`))).subarray(0, 8);

  /**
   * @returns {kex, transcript, safety, kRec, kMeta, kConfirm, sid8}
   * 两端各自算：pubSelf/pubPeer 互换即可，transcript 用排序后的公钥对，保证两侧算出同一个值。
   */
  async function deriveSession({ sid, secret, kex, shared, pubSelf, pubPeer }) {
    const pubs = [hex(pubSelf || new Uint8Array(0)), hex(pubPeer || new Uint8Array(0))].sort();
    const transcript = await sha256(te.encode(`filebox-xfer-v1|${sid}|${kex}|${pubs[0]}|${pubs[1]}`));
    const ikm = cat(shared || new Uint8Array(0), te.encode('|'), te.encode(secret));
    const salt = cat(te.encode(`filebox-xfer-v1/salt|${sid}`), transcript);
    const kRec = await hkdf(ikm, salt, 'record-v1', 32);
    const kMeta = await hkdf(ikm, salt, 'meta-v1', 32);
    const kConfirm = await hkdf(ikm, salt, 'confirm-v1', 32);
    const safetyRaw = await hmac(kConfirm, cat(te.encode(`filebox-xfer-v1/safety|${sid}`), transcript));
    let safety = '';
    for (let i = 0; i < 5; i++) safety += ALPHABET[safetyRaw[i] & 31];
    return { kex, transcript, safety, kRec, kMeta, kConfirm, sid8: await sidTag(sid) };
  }
  /** 配对完成后的相互认证。绑 协议版本 + 角色 + 会话号，**不绑本次连接的 transcript**：
   *  这样"刷新页面 / 换通道重连"还能用同一份会话密钥重新确认；而中间人替换公钥会让 kConfirm
   *  本身变掉，确认照样过不了 —— 防冒充的强度来自密钥派生，不来自这个 MAC 里写了什么。 */
  async function confirmMac(s, role, sid) {
    return hex(await hmac(s.kConfirm, te.encode(`filebox-xfer-v1/confirm|${role}|${sid}`)));
  }

  // ---------- 帧 ----------
  function headerBytes({ type, fileId, chunkIdx, plainLen }) {
    const h = new Uint8Array(HEADER_LEN);
    h[0] = MAGIC; h[1] = VER; h[2] = type;
    const dv = new DataView(h.buffer);
    dv.setUint32(3, fileId);
    dv.setBigUint64(7, BigInt(chunkIdx));
    dv.setUint32(15, plainLen);
    return h;
  }
  function parseHeader(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
    if (u8.length < HEADER_LEN) throw new Error('帧太短');
    if (u8[0] !== MAGIC) throw new Error('不是无痕传输的帧');
    if (u8[1] !== VER) throw new Error(`协议版本不匹配：${u8[1]}`);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { type: u8[2], fileId: dv.getUint32(3), chunkIdx: Number(dv.getBigUint64(7)), plainLen: dv.getUint32(15), header: u8.subarray(0, HEADER_LEN) };
  }
  function nonceBytes({ type, fileId, chunkIdx }) {
    const n = new Uint8Array(NONCE_LEN);
    n[0] = 0x78; n[1] = type;
    const dv = new DataView(n.buffer);
    dv.setUint32(2, fileId);
    // 块号只剩 6 字节 = 48bit（够 2.8 亿 TB 的分块数），高低位分开写，不能截成 32bit
    const c = BigInt(chunkIdx);
    n[6] = Number((c >> 32n) & 0xffn);
    n[7] = Number((c >> 40n) & 0xffn);
    dv.setUint32(8, Number(c & 0xffffffffn));
    return n;
  }

  const aesCache = new Map();
  async function aesKey(keyBytes) {
    const k = hex(keyBytes);
    if (aesCache.has(k)) return aesCache.get(k);
    const ck = await W.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    aesCache.set(k, ck);
    return ck;
  }
  /** 加密一帧：返回完整帧字节（帧头 + 密文 + 认证标签）。明文绝不会离开这里 */
  async function seal({ key, sid8, type, fileId, chunkIdx, plaintext }) {
    const pt = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    const header = headerBytes({ type, fileId, chunkIdx, plainLen: pt.length });
    const aad = cat(header, sid8);
    const iv = nonceBytes({ type, fileId, chunkIdx });
    let body;
    if (nativeOn()) {
      body = new Uint8Array(await W.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aesKey(key), pt));
    } else {
      const r = F()._test.jsGcmSeal(key, iv, pt, aad);
      body = cat(r.ct, r.tag);
    }
    return cat(header, body);
  }
  /** 打开一帧：认证标签先过，才把明文交出去；帧头任何一个字段被改都会在这里失败 */
  async function open({ key, sid8, frame }) {
    const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame.buffer || frame, frame.byteOffset || 0, frame.byteLength);
    const h = parseHeader(u8);
    const aad = cat(h.header, sid8);
    const iv = nonceBytes(h);
    const body = u8.subarray(HEADER_LEN);
    if (body.length < TAG_LEN) throw new Error('帧不完整');
    if (nativeOn()) {
      const pt = await W.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aesKey(key), body);
      return { ...h, plaintext: new Uint8Array(pt) };
    }
    const pt = F()._test.jsGcmOpen(key, iv, body.subarray(0, body.length - TAG_LEN), body.subarray(body.length - TAG_LEN), aad);
    return { ...h, plaintext: pt };
  }

  // ---------- 布局：两端用同一函数算出同一张表，续传才能对上号 ----------
  /** 名字按码元序排（不用 localeCompare：引擎/语言环境不同会排出不同顺序，块号就错位了） */
  function planLayout(files) {
    const sorted = files.slice().sort((a, b) => (String(a.relPath) < String(b.relPath) ? -1 : String(a.relPath) > String(b.relPath) ? 1 : 0));
    let seq = 1; // 0 号帧固定是加密清单
    const out = [];
    sorted.forEach((f, fileId) => {
      const chunks = Math.max(1, Math.ceil(f.size / PLAIN_BLOCK)); // 0 字节也要 1 块（空块），两端都得排上号
      const list = [];
      for (let c = 0; c < chunks; c++) list.push(Math.min(PLAIN_BLOCK, Math.max(0, f.size - c * PLAIN_BLOCK)));
      if (f.size === 0) list[0] = 0;
      out.push({ fileId, relPath: f.relPath, name: f.name, size: f.size, mime: f.mime || '', chunks: list, sha256: f.sha256 || null, seqBase: seq });
      seq += list.length;
    });
    return { files: out, totalFrames: seq, plainBlock: PLAIN_BLOCK };
  }
  function frameAt(layout, seq) {
    for (const f of layout.files) {
      if (seq < f.seqBase + f.chunks.length) return { file: f, chunkIdx: seq - f.seqBase, plainLen: f.chunks[seq - f.seqBase] };
    }
    return null;
  }

  /** 逐块 SHA-256 → 文件指纹 = SHA-256(所有块摘要串起来)；流式，不整文件进内存 */
  async function fingerprint(u8) {
    const digests = [];
    const n = Math.max(1, Math.ceil(u8.length / PLAIN_BLOCK));
    for (let i = 0; i < n; i++) {
      digests.push(await sha256(u8.subarray(i * PLAIN_BLOCK, Math.min(u8.length, (i + 1) * PLAIN_BLOCK))));
    }
    return { digestChain: hex(cat(...digests)), fileSha256: hex(await sha256(cat(...digests))), size: u8.length, chunks: n };
  }

  const manifestBytes = (layout) => te.encode(JSON.stringify({
    v: VER, plainBlock: PLAIN_BLOCK, totalBytes: layout.files.reduce((s, f) => s + f.size, 0),
    files: layout.files.map((f) => ({ id: f.fileId, name: f.name, size: f.size, mime: f.mime, sha256: f.sha256, chunks: f.chunks })),
  }));
  const readManifest = (u8) => JSON.parse(td.decode(u8));

  global.XferProto = {
    MAGIC, VER, TYPE_META, TYPE_DATA, HEADER_LEN, TAG_LEN, PLAIN_BLOCK, ALPHABET, SID_LEN, SEC_LEN,
    genSid, genSecret, formatCode, parseCode, proofOf,
    sha256, hmac, hkdf, genEcdh, ecdhShared, deriveSession, confirmMac, sidTag,
    seal, open, headerBytes, parseHeader, nonceBytes,
    planLayout, frameAt, fingerprint, manifestBytes, readManifest,
    cat, hex, unhex, eq, random,
    get engine() { return nativeOn() ? 'native' : 'js'; },
    get ecdhAvailable() { return ecdhOn(); },
    _test: { setEngine(name) { engineWanted = name; } },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = (typeof globalThis !== 'undefined' ? globalThis : this).XferProto;
