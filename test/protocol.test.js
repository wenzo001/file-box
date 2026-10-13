// 无痕传输协议层：所有期望值都拿 node:crypto 当独立裁判算一遍，不许"自己跟自己一致"。
// 同时交叉验证 WebCrypto 引擎与纯 JS 引擎产出逐字节相同的帧 —— 三个传输通道共用这一套协议的前提就是它。
const { test } = require('node:test');
const assert = require('node:assert');
const nc = require('node:crypto');
require('../public/crypto.js');
const P = require('../public/xfer-proto.js');

const withEngines = (name, fn) => {
  test(`${name}（native 引擎）`, async () => { P._test.setEngine('native'); await fn(); });
  test(`${name}（纯 JS 引擎）`, async () => { P._test.setEngine('js'); await fn(); P._test.setEngine('native'); });
};

test('SHA-256 / HMAC：两个引擎都和 node:crypto 逐字节一致', async () => {
  const msg = nc.randomBytes(1000);
  const key = nc.randomBytes(32);
  const wantSha = nc.createHash('sha256').update(msg).digest();
  const wantHmac = nc.createHmac('sha256', key).update(msg).digest();
  for (const eng of ['native', 'js']) {
    P._test.setEngine(eng);
    assert.strictEqual(P.hex(await P.sha256(msg)), wantSha.toString('hex'), eng);
    assert.strictEqual(P.hex(await P.hmac(key, msg)), wantHmac.toString('hex'), eng);
  }
  P._test.setEngine('native');
});

test('HKDF-SHA256(RFC 5869)：和 node:crypto.hkdfSync 逐字节一致，含跨越单块长度的输出', async () => {
  for (const len of [16, 32, 44, 64, 68]) {
    const ikm = nc.randomBytes(48); const salt = nc.randomBytes(16); const info = 'filebox-xfer-v1/record-v1';
    const want = Buffer.from(nc.hkdfSync('sha256', ikm, salt, info, len));
    for (const eng of ['native', 'js']) {
      P._test.setEngine(eng);
      const got = await P.hkdf(new Uint8Array(ikm), new Uint8Array(salt), info, len);
      assert.strictEqual(P.hex(got), want.toString('hex'), `len=${len} engine=${eng}`);
    }
  }
  P._test.setEngine('native');
});

test('ECDH P-256：浏览器侧 deriveBits 与 node:crypto 算出的共享秘密相同', async (t) => {
  if (!P.ecdhAvailable) return t.skip('没有 WebCrypto，跳过');
  const a = await P.genEcdh();
  const b = await P.genEcdh();
  const shared = await P.ecdhShared(a.priv, b.pub);
  assert.strictEqual(shared.length, 32, 'ECDH 必须真的算出 32 字节共享值，不能是空的');
  assert.ok(Array.from(shared).some((x) => x !== 0), '共享值全零等于没算');
  // 用 node 的 ECDH 复算：导出 A 的私钥标量(jwk.d) 与 B 的公钥(raw)，各自独立算一遍
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', a.priv);
  const d = Buffer.from(jwk.d, 'base64url');
  const na = nc.createECDH('prime256v1');
  na.setPrivateKey(d);
  const viaNode = na.computeSecret(Buffer.from(b.pub));
  assert.strictEqual(P.hex(shared), viaNode.toString('hex'), 'EC 共享值算错了');
  assert.strictEqual(P.hex(shared), P.hex(await P.ecdhShared(b.priv, a.pub)), '双方算不出同一个共享值');
});

withEngines('帧：加解密往返 + 认证标签挡住各种篡改', async () => {
  const sid = P.genSid();
  const secret = P.genSecret();
  const s = await P.deriveSession({ sid, secret, kex: 'code', shared: new Uint8Array(0), pubSelf: new Uint8Array(0), pubPeer: new Uint8Array(0) });
  const pt = nc.randomBytes(1234);
  const frame = await P.seal({ key: s.kRec, sid8: s.sid8, type: P.TYPE_DATA, fileId: 3, chunkIdx: 45, plaintext: pt });
  const back = await P.open({ key: s.kRec, sid8: s.sid8, frame });
  assert.ok(P.eq(back.plaintext, pt), '解回来的明文不一样');
  assert.strictEqual(back.fileId, 3);
  assert.strictEqual(back.chunkIdx, 45);
  assert.strictEqual(back.plainLen, pt.length);
  assert.strictEqual(frame.length, P.HEADER_LEN + pt.length + P.TAG_LEN);

  const flip = (buf, at) => { const c = Uint8Array.from(buf); c[at] ^= 1; return c; };
  await assert.rejects(P.open({ key: s.kRec, sid8: s.sid8, frame: flip(frame, P.HEADER_LEN + 5) }), /./, '改一个密文字节必须失败');
  await assert.rejects(P.open({ key: s.kRec, sid8: s.sid8, frame: flip(frame, frame.length - 1) }), /./, '改认证标签必须失败');
  await assert.rejects(P.open({ key: s.kRec, sid8: s.sid8, frame: flip(frame, 8) }), /./, '改块号（帧头）必须失败');
  await assert.rejects(P.open({ key: s.kRec, sid8: s.sid8, frame: flip(frame, 4) }), /./, '改文件号（帧头）必须失败');
  await assert.rejects(P.open({ key: s.kRec, sid8: s.sid8, frame: flip(frame, 16) }), /./, '改明文长度必须失败');
  await assert.rejects(P.open({ key: s.kRec, sid8: s.sid8, frame: frame.subarray(0, frame.length - 1) }), /./, '截断必须失败');
  // 跨会话混入：换个 sid 标签
  const other = await P.sidTag(P.genSid());
  await assert.rejects(P.open({ key: s.kRec, sid8: other, frame }), /./, '别的会话的帧不能进来');
  // 密文替换：把另一块（同密钥不同块号）的密文体塞进这块的头
  const frame2 = await P.seal({ key: s.kRec, sid8: s.sid8, type: P.TYPE_DATA, fileId: 3, chunkIdx: 46, plaintext: pt });
  const spliced = P.cat(P.headerBytes({ type: P.TYPE_DATA, fileId: 3, chunkIdx: 45, plainLen: pt.length }), frame2.subarray(P.HEADER_LEN));
  await assert.rejects(P.open({ key: s.kRec, sid8: s.sid8, frame: spliced }), /./, '把 46 块的密文贴到 45 块上必须失败');
  // 错密钥（服务器或第三者拿到帧也解不开）
  const wrong = new Uint8Array(32); nc.randomBytes(32).copy(wrong);
  await assert.rejects(P.open({ key: wrong, sid8: s.sid8, frame }), /./, '没有密钥就解不开');
});

withEngines('帧：重传同一块得到逐字节相同的帧（幂等，且 nonce 不被复用给不同明文）', async () => {
  const sid8 = await P.sidTag('abcd2345');
  const key = new Uint8Array(32).fill(7);
  const pt = nc.randomBytes(700);
  const a = await P.seal({ key, sid8, type: P.TYPE_DATA, fileId: 1, chunkIdx: 9, plaintext: pt });
  const b = await P.seal({ key, sid8, type: P.TYPE_DATA, fileId: 1, chunkIdx: 9, plaintext: pt });
  assert.strictEqual(P.hex(a), P.hex(b), '重传必须完全一样的字节');
  const seen = new Set();
  for (let f = 0; f < 8; f++) {
    for (let c = 0; c < 40; c++) {
      const n = P.hex(P.nonceBytes({ type: P.TYPE_DATA, fileId: f, chunkIdx: c }));
      assert.ok(!seen.has(n), `nonce 撞了：file ${f} chunk ${c}`);
      seen.add(n);
    }
  }
  assert.strictEqual(seen.size, 320);
  // 大块的 chunkIdx 要能进 64 位：跨过 2^32 也不能和别的块撞 nonce
  const big = P.hex(P.nonceBytes({ type: P.TYPE_DATA, fileId: 0, chunkIdx: 2 ** 32 }));
  const small = P.hex(P.nonceBytes({ type: P.TYPE_DATA, fileId: 0, chunkIdx: 0 }));
  assert.notStrictEqual(big, small, 'chunkIdx 超过 32 位就被截断了');
});

test('两个引擎产出逐字节相同的帧，并且能互解', async () => {
  const sid8 = await P.sidTag('zzzz2222');
  const key = nc.randomBytes(32);
  for (const aadLen of [0, 1, 15, 16, 27]) {
    const pt = nc.randomBytes(1000 + aadLen);
    P._test.setEngine('native');
    const fn = await P.seal({ key, sid8, type: P.TYPE_DATA, fileId: 2, chunkIdx: 3, plaintext: pt });
    P._test.setEngine('js');
    const fj = await P.seal({ key, sid8, type: P.TYPE_DATA, fileId: 2, chunkIdx: 3, plaintext: pt });
    assert.strictEqual(P.hex(fn), P.hex(fj), '两个引擎的帧不一样，说明其中一侧的 GHASH/AAD 口径错了');
    // 交叉解开
    assert.ok(P.eq((await P.open({ key, sid8, frame: fn })).plaintext, pt));
    P._test.setEngine('native');
    assert.ok(P.eq((await P.open({ key, sid8, frame: fj })).plaintext, pt));
  }
  P._test.setEngine('native');
});

test('现有 FBCrypto 的单块加密不受 AAD 改动影响（空 AAD 与旧行为一致）', async () => {
  const F = globalThis.FBCrypto;
  const key = nc.randomBytes(32);
  const iv = nc.randomBytes(12);
  const pt = nc.randomBytes(500);
  const noAad = F._test.jsGcmSeal(key, iv, pt);
  const emptyAad = F._test.jsGcmSeal(key, iv, pt, new Uint8Array(0));
  assert.strictEqual(Buffer.from(noAad.tag).toString('hex'), Buffer.from(emptyAad.tag).toString('hex'));
  // 并且和 node 的标准 AES-256-GCM（无 AAD）对得上：这证明改动没破坏原口径
  const c = nc.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(pt), c.final()]);
  assert.strictEqual(Buffer.from(noAad.ct).toString('hex'), ct.toString('hex'));
  assert.strictEqual(Buffer.from(noAad.tag).toString('hex'), c.getAuthTag().toString('hex'));
});

test('会话密钥阶梯：诚实双方算出同一套；换码/换公钥都会对不上，并且安全码不一致', async () => {
  const sid = P.genSid();
  const secret = P.genSecret();
  const a = await P.genEcdh();
  const b = await P.genEcdh();
  const sa = await P.deriveSession({ sid, secret, kex: a.kex, shared: await P.ecdhShared(a.priv, b.pub), pubSelf: a.pub, pubPeer: b.pub });
  const sb = await P.deriveSession({ sid, secret, kex: b.kex, shared: await P.ecdhShared(b.priv, a.pub), pubSelf: b.pub, pubPeer: a.pub });
  assert.strictEqual(P.hex(sa.kRec), P.hex(sb.kRec));
  assert.strictEqual(P.hex(sa.kMeta), P.hex(sb.kMeta));
  assert.strictEqual(sa.safety, sb.safety, '安全码必须两边一致');
  assert.match(sa.safety, /^[a-z1-9]{5}$/);
  // 互相确认：各自的 confirmMac 对方能验（角色不同，不能拿对方的确认冒充）
  const ca = await P.confirmMac(sa, 'sender', sid);
  const cb = await P.confirmMac(sb, 'receiver', sid);
  assert.strictEqual(ca, await P.confirmMac(sb, 'sender', sid));
  assert.notStrictEqual(ca, cb, '发送方和接收方的确认值不能相同，否则可互相冒充');
  assert.notStrictEqual(ca, await P.confirmMac(sb, 'nonsense', sid));
  assert.notStrictEqual(ca, await P.confirmMac(sb, 'sender', P.genSid()), '换个会话号确认值必须不同');

  // 中间人：知道全部公钥但不知道秘密段 → 密钥完全不同
  const eve = await P.deriveSession({ sid, secret: P.genSecret(), kex: 'p256', shared: await P.ecdhShared(a.priv, b.pub), pubSelf: a.pub, pubPeer: b.pub });
  assert.notStrictEqual(P.hex(eve.kRec), P.hex(sa.kRec));
  assert.notStrictEqual(eve.safety, sa.safety, '安全码不同 → 用户能在 UI 上看出被人换了公钥');

  // 替换公钥的 MITM：A 和 "E" 的 transcript 不同 → 安全码不同
  const e = await P.genEcdh();
  const sa2 = await P.deriveSession({ sid, secret, kex: 'p256', shared: await P.ecdhShared(a.priv, e.pub), pubSelf: a.pub, pubPeer: e.pub });
  assert.notStrictEqual(sa2.safety, sa.safety);

  // 没有 ECDH 的入口（kex=code）：两边仍能算出同一套密钥，但与 p256 那套不同 → 不允许静默降级
  const c1 = await P.deriveSession({ sid, secret, kex: 'code', shared: new Uint8Array(0), pubSelf: new Uint8Array(0), pubPeer: new Uint8Array(0) });
  const c2 = await P.deriveSession({ sid, secret, kex: 'code', shared: new Uint8Array(0), pubSelf: new Uint8Array(0), pubPeer: new Uint8Array(0) });
  assert.strictEqual(P.hex(c1.kRec), P.hex(c2.kRec));
  assert.notStrictEqual(P.hex(c1.kRec), P.hex(sa.kRec), 'kex 不同必须导出完全不同的密钥');
  const c3 = await P.deriveSession({ sid, secret, kex: 'p256', shared: await P.ecdhShared(a.priv, b.pub), pubSelf: a.pub, pubPeer: b.pub });
  assert.notStrictEqual(P.hex(c3.kRec), P.hex(c1.kRec));
});

test('传输码：形状、字母表、无歧义字符、码长对应的熵、以及配对凭证的独立复算', async () => {
  const sid = P.genSid(); const secret = P.genSecret();
  assert.match(sid, /^[a-z1-9]{8}$/);
  assert.match(secret, /^[a-z1-9]{24}$/);
  assert.ok(!/[ilo0]/.test(sid + secret), '字母表里不该有看得清容易认错的字符');
  const shown = P.formatCode(sid, secret);
  const back = P.parseCode(shown);
  assert.deepEqual(back, { sid, secret }, '带分隔符显示后还要能原样输入回来');
  assert.deepEqual(P.parseCode(shown.toUpperCase().replace(/-/g, ' ')), { sid, secret }, '大小写和空格也要能吃下');
  assert.strictEqual(P.parseCode('short'), null);
  assert.strictEqual(P.parseCode(''), null);
  // proof 用 node:crypto 独立复算：不是"和自己对两次"
  const want = nc.createHmac('sha256', `filebox-xfer-v1/proof|${sid}`).update(secret).digest('hex');
  assert.strictEqual(await P.proofOf(sid, secret), want);
  assert.notStrictEqual(await P.proofOf(P.genSid(), secret), want, '换个会话的凭证必须不同');
  // 码长对应的熵：8 字符 40bit + 24 字符 120bit
  assert.strictEqual(Math.log2(P.ALPHABET.length) * P.SID_LEN, 40);
  assert.strictEqual(Math.log2(P.ALPHABET.length) * P.SEC_LEN, 120);
});

test('分块布局与选择顺序无关，并且边界大小算得对', () => {
  const B = P.PLAIN_BLOCK;
  const files = [
    { relPath: 'b/2.bin', name: '2.bin', size: B * 2 + 1 },
    { relPath: 'a/1.bin', name: '1.bin', size: B },
    { relPath: 'c/空.bin', name: '空.bin', size: 0 },
    { relPath: 'd.txt', name: 'd.txt', size: 1 },
  ];
  const l1 = P.planLayout(files);
  const l2 = P.planLayout(files.slice().reverse());
  const l3 = P.planLayout(files.slice().sort((a, b) => b.relPath.localeCompare(a.relPath)));
  assert.deepEqual(l1.files, l2.files, '换选择顺序不能改变布局，否则续传对不上号');
  assert.deepEqual(l1.files, l3.files, 'localeCompare 那种随语言环境变的不算数');
  assert.strictEqual(l1.files[0].relPath, 'a/1.bin');
  assert.strictEqual(l1.totalFrames, 1 + (2 + 1) + 1 + 1 + 1);
  const sum = l1.files.reduce((s, f) => s + f.chunks.reduce((x, y) => x + y, 0), 0);
  assert.strictEqual(sum, files.reduce((s, f) => s + f.size, 0), '每块加起来必须正好等于文件总长');
  // 每个 seq 都能落回 (fileId, chunkIdx)，且不重不漏
  const hit = new Set();
  for (let seq = 1; seq < l1.totalFrames; seq++) {
    const f = P.frameAt(l1, seq);
    assert.ok(f, `第 ${seq} 帧没归属`);
    hit.add(`${f.file.fileId}:${f.chunkIdx}`);
    assert.strictEqual(f.plainLen, f.file.chunks[f.chunkIdx]);
  }
  assert.strictEqual(hit.size, l1.totalFrames - 1);
  assert.strictEqual(P.frameAt(l1, l1.totalFrames), null, '越界要返回空，不能默默兜底');
});

withEngines('文件指纹：与 node:crypto 的逐块 SHA-256 串联一致，改一个字节就变', async () => {
  const data = nc.randomBytes(P.PLAIN_BLOCK * 2 + 77);
  const fp = await P.fingerprint(new Uint8Array(data));
  const per = [];
  for (let i = 0; i < fp.chunks; i++) {
    per.push(nc.createHash('sha256').update(data.subarray(i * P.PLAIN_BLOCK, (i + 1) * P.PLAIN_BLOCK)).digest());
  }
  assert.strictEqual(fp.digestChain, Buffer.concat(per).toString('hex'));
  assert.strictEqual(fp.fileSha256, nc.createHash('sha256').update(Buffer.concat(per)).digest('hex'));
  assert.strictEqual(fp.size, data.length);
  assert.strictEqual(fp.chunks, 3);
  const mutated = Buffer.from(data);
  mutated[10] ^= 1;
  const fp2 = await P.fingerprint(new Uint8Array(mutated));
  assert.notStrictEqual(fp2.fileSha256, fp.fileSha256, '改一个字节指纹必须变');
  assert.notStrictEqual(fp2.digestChain, fp.digestChain);
});

test('加密清单必须带得回相对路径：不同子目录下的同名文件不能分不出谁是谁', async () => {
  const sid8 = await P.sidTag('nnnn3333');
  const key = nc.randomBytes(32);
  const layout = P.planLayout([
    { relPath: 'a/x.bin', name: 'x.bin', size: 10, mime: '' },
    { relPath: 'b/x.bin', name: 'x.bin', size: 20, mime: '' },
  ]);
  const frame = await P.seal({ key, sid8, type: P.TYPE_META, fileId: 0xffffffff, chunkIdx: 0, plaintext: P.manifestBytes(layout) });
  const back = P.readManifest((await P.open({ key, sid8, frame })).plaintext);
  assert.deepStrictEqual(
    back.files.map((f) => f.relPath), ['a/x.bin', 'b/x.bin'],
    '清单丢了相对路径：接收端只剩 name 可归组，两个同名文件的块会被并成同一个 Blob（或后一个盖掉前一个）',
  );
  assert.deepStrictEqual(back.files.map((f) => f.size), [10, 20], '相对路径要跟着原来的顺序一起回来');
});

test('传输码分组：每组固定 4 位、段边界对齐，不许出现 "--" 和落单的尾巴', () => {
  for (let i = 0; i < 300; i++) {
    const sid = P.genSid();
    const secret = P.genSecret();
    const shown = P.formatCode(sid, secret);
    assert.ok(!shown.includes('--'), `码里有连写的分隔符（分组跨了 sid/secret 边界）: ${shown}`);
    assert.match(shown, /^[a-z1-9]{4}(-[a-z1-9]{4}){7}$/, `应当是 8 组、每组 4 位: ${shown}`);
    assert.strictEqual(shown.split('-')[1], sid.slice(4, 8), 'sid 那 8 位要正好落在前两组里，边界不能骑在分隔符上');
    assert.deepStrictEqual(P.parseCode(shown), { sid, secret }, '换了分组还得吃得回来');
  }
});

test('加密清单：特殊字符文件名原样往返，明文里不含真实名也说明不了什么 —— 但它只在密钥对了才解得开', async () => {
  const sid8 = await P.sidTag('mmmm3333');
  const key = nc.randomBytes(32);
  const layout = P.planLayout([
    { relPath: '中文 报告 (终).pdf', name: '中文 报告 (终).pdf', size: 10, mime: 'application/pdf' },
    { relPath: 'quote"\'and\\slash/', name: 'quote"\'and\\slash/', size: 3, mime: '' },
    { relPath: '🍌 emoji.bin', name: '🍌 emoji.bin', size: 1, mime: 'application/octet-stream' },
  ]);
  const bytes = P.manifestBytes(layout);
  const frame = await P.seal({ key, sid8, type: P.TYPE_META, fileId: 0xffffffff, chunkIdx: 0, plaintext: bytes });
  const opened = await P.open({ key, sid8, frame });
  const back = P.readManifest(opened.plaintext);
  assert.strictEqual(back.files.length, 3);
  // 按名字配对，不按位置：位置是排序的结果，拿位置当期望值等于把"排序"这件事重复断言两遍
  const byName = Object.fromEntries(back.files.map((f) => [f.name, f]));
  assert.deepStrictEqual(Object.keys(byName).sort(), [
    'quote"\'and\\slash/', '中文 报告 (终).pdf', '🍌 emoji.bin',
  ].sort());
  assert.strictEqual(byName['中文 报告 (终).pdf'].size, 10);
  assert.strictEqual(byName['中文 报告 (终).pdf'].mime, 'application/pdf');
  assert.strictEqual(byName['quote"\'and\\slash/'].size, 3);
  assert.strictEqual(byName['🍌 emoji.bin'].size, 1);
  assert.strictEqual(back.totalBytes, 14);
  // 清单里的顺序就是协议顺序（码元序），换设备/换语言环境都必须一模一样
  assert.deepStrictEqual(back.files.map((f) => f.name), ['quote"\'and\\slash/', '中文 报告 (终).pdf', '🍌 emoji.bin']);
  // 清单确实是密文：帧里找不到任何文件名的字节
  const inFrame = Buffer.from(frame).toString('latin1');
  assert.ok(!inFrame.includes('emoji'), '清单没被加密就是泄露元数据');
  assert.ok(!inFrame.includes('quote'), '清单没被加密就是泄露元数据');
});
