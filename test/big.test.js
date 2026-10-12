// 大文件：真的起服务、真的写 600MB、真的走中转，全程按 128KiB 一块读写。
// 这里验的是"大文件不发生整文件内存加载 + 前后 SHA-256 一致 + 服务器只见密文"，
// 用的是浏览器同一份协议层（public/xfer-proto.js），所以帧格式与 P2P 路径逐字节相同。
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, jget } = require('./helpers');
const P = require('../public/xfer-proto.js');

const MB = Number(process.env.XFER_BIG_MB || 600);
const SIZE = MB * 1024 * 1024;
const CONC = 8;

const randSid = () => Array.from({ length: P.SID_LEN }, () => P.ALPHABET[crypto.randomInt(P.ALPHABET.length)]).join('');

async function putSeg(base, sid, token, i, frame) {
  const r = await fetch(`${base}/api/xfer/seg?sid=${sid}&i=${i}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': token },
    body: frame,
  });
  assert.strictEqual(r.status, 200, `第 ${i} 块上传失败 ${r.status}`);
}
async function getSeg(base, sid, proof, i) {
  const r = await fetch(`${base}/api/xfer/seg?sid=${sid}&i=${i}`, { headers: { 'X-Xfer-Proof': proof } });
  assert.strictEqual(r.status, 200, `第 ${i} 块拉取失败 ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

test(`大文件 ${MB}MB：分块读写、内存有界、前后校验一致、中转区只有密文`, async () => {
  const srv = await startServer({ XFER_TTL_MINUTES: '30', XFER_LIMIT_GB: String(Math.ceil(SIZE / 1024 ** 3) + 2) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-big-'));
  const src = path.join(tmp, 'big.bin');
  try {
    // ---------- 造源文件：1MiB 一次写，顺手用 node:crypto 算出独立 oracle ----------
    const oracle = crypto.createHash('sha256');
    const fd = fs.openSync(src, 'w');
    let state = crypto.createHash('sha256').update(Buffer.from([0])).digest();
    let written = 0;
    while (written < SIZE) {
      const n = Math.min(1024 * 1024, SIZE - written);
      const buf = Buffer.allocUnsafe(n);
      let at = 0;
      while (at < n) { // 内容可复现且处处不同：一路哈希下去
        state = crypto.createHash('sha256').update(state).digest();
        const take = Math.min(32, n - at);
        state.copy(buf, at, 0, take);
        at += take;
      }
      fs.writeSync(fd, buf, 0, n);
      oracle.update(buf);
      written += n;
    }
    fs.closeSync(fd);
    const wantHex = oracle.digest('hex');
    assert.strictEqual(fs.statSync(src).size, SIZE, '源文件应当正好这么大');

    // ---------- 会话与密钥：和引擎一样的密钥阶梯 ----------
    const sid = randSid();
    const proof = crypto.randomBytes(32).toString('hex');
    const layout = P.planLayout([{ relPath: '机密大文件#1.bin', name: '机密大文件#1.bin', size: SIZE, mime: 'application/octet-stream' }]);
    const created = await jget(`${srv.base}/api/xfer/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, proof, frames: layout.totalFrames, totalBytes: SIZE }),
    });
    assert.strictEqual(created.status, 200, JSON.stringify(created.body));
    const token = created.body.token;
    await jget(`${srv.base}/api/xfer/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, proof }),
    });
    const kRec = crypto.randomBytes(32);
    const kMeta = crypto.randomBytes(32);
    const sid8 = crypto.randomBytes(8);
    const f = layout.files[0];
    const fileKey = await P.hkdf(kRec, sid8, `file-v1|${sid}|${f.fileId}`, 32);

    // ---------- 发送端：一次只把一块读进内存 ----------
    // 每块各用一个新 buffer：seal 是异步的，共用一块会在等待期间被下一块覆盖掉
    const rfd = fs.openSync(src, 'r');
    let peakRss = 0;
    const t0 = Date.now();
    const metaFrame = await P.seal({
      key: kMeta, sid8, type: P.TYPE_META, fileId: 0xffffffff, chunkIdx: 0,
      plaintext: P.manifestBytes(layout),
    });
    await putSeg(srv.base, sid, token, 0, metaFrame);
    let sent = 0;
    while (sent < f.chunks.length) {
      const batch = [];
      for (let k = 0; k < CONC && sent + k < f.chunks.length; k++) {
        const c = sent + k;
        const len = f.chunks[c];
        const readBuf = Buffer.allocUnsafe(len);
        const got = fs.readSync(rfd, readBuf, 0, len, c * P.PLAIN_BLOCK);
        assert.strictEqual(got, len, `第 ${c} 块该读 ${len} 实际 ${got}`);
        batch.push(P.seal({ key: fileKey, sid8, type: P.TYPE_DATA, fileId: f.fileId, chunkIdx: c, plaintext: readBuf })
          .then((frame) => putSeg(srv.base, sid, token, f.seqBase + c, frame)));
      }
      await Promise.all(batch);
      sent += CONC;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    fs.closeSync(rfd);
    const upMs = Date.now() - t0;

    // ---------- 服务器侧：账本对上，且盘上没有明文与文件名 ----------
    const st = await jget(`${srv.base}/api/xfer/state?sid=${sid}`, { headers: { 'X-Xfer-Proof': proof } });
    assert.strictEqual(st.status, 200);
    const upCount = st.body.uploaded.reduce((n, [a, b]) => n + (b - a + 1), 0);
    assert.strictEqual(upCount, layout.totalFrames, '中转区应该收齐所有帧');
    const segDir = path.join(srv.dir, 'transfer', sid);
    const sample = [1, Math.floor(layout.totalFrames / 2), layout.totalFrames - 1];
    for (const i of sample) {
      const onDisk = fs.readFileSync(path.join(segDir, `seg-${i}.bin`));
      const plain = Buffer.allocUnsafe(f.chunks[i - 1]);
      const fd2 = fs.openSync(src, 'r');
      fs.readSync(fd2, plain, 0, plain.length, (i - 1) * P.PLAIN_BLOCK);
      fs.closeSync(fd2);
      assert.strictEqual(onDisk.indexOf(plain.subarray(0, 64)), -1, `seg-${i} 里不该出现明文`);
      assert.strictEqual(onDisk[0], P.MAGIC, '每帧应当以协议 magic 开头');
    }
    assert.doesNotMatch(fs.readFileSync(path.join(segDir, 'meta.json'), 'utf8'), /机密大文件/, '服务端账本不该有真实文件名');

    // ---------- 接收端：逐块开帧验标签，明文只留在增量哈希里 ----------
    const t1 = Date.now();
    const recv = crypto.createHash('sha256');
    const dfd = fs.openSync(path.join(tmp, 'out.bin'), 'w');
    const man = await P.open({ key: kMeta, sid8, frame: await getSeg(srv.base, sid, proof, 0) });
    const gotLayout = P.planLayout(JSON.parse(new TextDecoder().decode(man.plaintext)).files.map((x) => ({ relPath: x.name, name: x.name, size: x.size })));
    assert.strictEqual(gotLayout.files[0].chunks.length, f.chunks.length, '清单里的块数要对上');
    let got2 = 0;
    while (got2 < f.chunks.length) {
      const batch = [];
      for (let k = 0; k < CONC && got2 + k < f.chunks.length; k++) {
        const c = got2 + k;
        batch.push(getSeg(srv.base, sid, proof, f.seqBase + c).then(async (frame) => {
          const r = await P.open({ key: fileKey, sid8, frame });
          assert.strictEqual(r.chunkIdx, c, '帧序号不能错位');
          assert.strictEqual(r.plaintext.length, f.chunks[c], '解出来的长度要和帧头一致');
          return r.plaintext;
        }));
      }
      const parts = await Promise.all(batch);
      for (const pt of parts) { recv.update(pt); fs.writeSync(dfd, pt, 0, pt.length); }
      got2 += CONC;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    fs.closeSync(dfd);
    const downMs = Date.now() - t1;

    assert.strictEqual(recv.digest('hex'), wantHex, '收完的 SHA-256 必须和发出去的一致');
    assert.strictEqual(fs.statSync(path.join(tmp, 'out.bin')).size, SIZE, '长度也要一致');
    // 整文件 600MB 若被一次读进内存，RSS 一定远高过这条线
    assert.ok(peakRss < 600 * 1024 * 1024, `峰值 RSS ${(peakRss / 1024 / 1024) | 0}MB，不该接近文件大小`);
    console.log(`# 大文件 ${MB}MB：上传 ${upMs}ms（${(SIZE / 1048576 / (upMs / 1000)).toFixed(1)}MB/s）`
      + `，下载解密 ${downMs}ms（${(SIZE / 1048576 / (downMs / 1000)).toFixed(1)}MB/s）`
      + `，峰值 RSS ${(peakRss / 1024 / 1024) | 0}MB，引擎 ${P.engine}`);
  } finally {
    await srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
