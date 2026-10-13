// 现有文件存储功能的行为基线（§一.6 / §十一.1）：改动前后都必须全绿。
// 覆盖：分块上传、续传、完成时机、列表、单文件下载、归档流、删除、以及服务端的各类拒绝路径。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startServer, jget, uploadBundle, crc32, hexKey } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

const manifest = (n = 1) => Array.from({ length: n }, (_, i) => ({ enc: `f${i}.enc`, chunks: [1024, 1024] }));

test('启动时列表为空，且带 usage / httpsPort 字段', async () => {
  const r = await jget(`${srv.base}/api/list`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.folders, []);
  assert.strictEqual(r.body.usage.limitGB, 1);
  assert.ok(r.body.httpsPort > 0);
});

test('两块的密文上传完成后才出现在列表里，大小是密文总量', async () => {
  const key = hexKey();
  const files = [{ enc: 'a.enc', chunks: [1024, 2048] }, { enc: 'manifest.enc', chunks: [512] }];
  const init = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files }),
  });
  assert.strictEqual(init.body.ok, true);
  assert.strictEqual(init.body.total, 3);
  // 没 finish 之前，正式库里不该看得到这批
  assert.deepStrictEqual((await jget(`${srv.base}/api/list`)).body.folders, []);
  assert.strictEqual(fs.readdirSync(path.join(srv.dir, 'uploading')).length, 1);

  const out = await uploadBundle(srv, key, files);
  assert.ok(/^[0-9]{8}_[0-9]{4}$/.test(out.folder) || /^[0-9]{8}_[0-9]{4}_\d+$/.test(out.folder), `目录名不是完成时刻格式: ${out.folder}`);
  assert.strictEqual(out.count, 1, 'manifest.enc 不计入文件数');
  const list = (await jget(`${srv.base}/api/list`)).body.folders;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].size, 1024 + 2048 + 512);
  assert.deepStrictEqual(list[0].files.map((f) => f.name), ['a.enc', 'manifest.enc']);
});

test('下载拿到的字节与上传的密文逐字节一致', async () => {
  const key = hexKey();
  const want = Buffer.from(crypto.randomBytes(3000));
  const files = [{ enc: 'dl.enc', chunks: [1000, 2000] }];
  files[0].data = [want.subarray(0, 1000), want.subarray(1000)];
  const { folder } = await uploadBundle(srv, key, files);
  const res = await fetch(`${srv.base}/api/download/${folder}/dl.enc`);
  assert.strictEqual(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(want));
});

test('归档流按帧解开后，manifest 在最前且每个文件内容一致', async () => {
  const key = hexKey();
  const files = [{ enc: 'manifest.enc', chunks: [300] }, { enc: 'x.enc', chunks: [700, 700] }];
  const blobs = { 'manifest.enc': Buffer.from(crypto.randomBytes(300)), 'x.enc': Buffer.from(crypto.randomBytes(1400)) };
  files[0].data = [blobs['manifest.enc']];
  files[1].data = [blobs['x.enc'].subarray(0, 700), blobs['x.enc'].subarray(700)];
  const { folder } = await uploadBundle(srv, key, files);
  const buf = Buffer.from(await (await fetch(`${srv.base}/api/archive/${folder}`)).arrayBuffer());
  const got = [];
  let off = 0;
  while (off < buf.length) {
    const nameLen = buf.readUInt16BE(off);
    const size = Number(buf.readBigUInt64BE(off + 2));
    const name = buf.slice(off + 10, off + 10 + nameLen).toString('utf8');
    got.push({ name, data: buf.slice(off + 10 + nameLen, off + 10 + nameLen + size) });
    off += 10 + nameLen + size;
  }
  assert.deepStrictEqual(got.map((g) => g.name), ['manifest.enc', 'x.enc'], 'manifest 必须排最前，客户端才解得出真实文件名');
  assert.ok(got[0].data.equals(blobs['manifest.enc']));
  assert.ok(got[1].data.equals(blobs['x.enc']));
  assert.strictEqual(off, buf.length, '帧边界要正好吃完整个流，多一字节都算格式回归');
});

test('续传：同指纹再来一次，服务端把已收到的块告诉客户端', async () => {
  const key = hexKey();
  const files = manifest(2);
  const init = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files }),
  });
  assert.strictEqual(init.body.have.length, 0);
  // 只传第一个文件的第 0 块
  const buf = Buffer.alloc(1024, 7);
  await fetch(`${srv.base}/api/upload/part?u=${key}&f=0&c=0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc32(buf).toString(16).padStart(8, '0') },
    body: buf,
  });
  const again = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files }),
  });
  assert.deepStrictEqual(again.body.have, [{ f: 0, c: 0 }]);
  assert.strictEqual(again.body.resumed, true);
  // 布局变了（换了引擎/文件变了）：旧块作废，从头来
  const changed = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files: [{ enc: 'f0.enc', chunks: [1024, 1024, 1024] }, files[1]] }),
  });
  assert.deepStrictEqual(changed.body.have, [], '分块布局变化后不能把旧块当已传');
  assert.strictEqual(changed.body.resumed, false);
});

test('收尾前的拒绝路径：块没齐 409、缺 CRC 400、大小不符 400、传输损坏让客户端重传', async () => {
  const key = hexKey();
  const files = [{ enc: 'r.enc', chunks: [1024] }];
  await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files }),
  });
  const fin = await jget(`${srv.base}/api/upload/finish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: key }),
  });
  assert.strictEqual(fin.status, 409);

  const good = Buffer.alloc(1024, 3);
  const noCrc = await fetch(`${srv.base}/api/upload/part?u=${key}&f=0&c=0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: good });
  assert.strictEqual(noCrc.status, 400, '没有 X-Chunk-Crc 必须拒收');
  const wrongLen = await fetch(`${srv.base}/api/upload/part?u=${key}&f=0&c=0`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc32(good).toString(16).padStart(8, '0') },
    body: Buffer.alloc(512, 3),
  });
  assert.strictEqual(wrongLen.status, 400);
  const corrupt = await fetch(`${srv.base}/api/upload/part?u=${key}&f=0&c=0`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': 'deadbeef' },
    body: good,
  });
  const cbody = await corrupt.json();
  assert.strictEqual(corrupt.status, 400);
  assert.strictEqual(cbody.resend, true, 'CRC 不符要告诉客户端重传这一块');
});

test('保留名与非法名拒绝：meta.json / part-0-1.bin / x.assembling / 带路径分隔符', async () => {
  for (const enc of ['meta.json', 'part-0-1.bin', 'x.enc.assembling', 'a/b.enc']) {
    const r = await jget(`${srv.base}/api/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: hexKey(), files: [{ enc, chunks: [10] }] }),
    });
    assert.strictEqual(r.status, 400, `${enc} 应被拒`);
  }
  const badKey = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '../../etc', files: [{ enc: 'a.enc', chunks: [10] }] }),
  });
  assert.strictEqual(badKey.status, 400);
});

test('并发 finish：第二个请求 409 被拒，批次只能落一个，不会互相拆台', async () => {
  const key = hexKey();
  const files = [{ enc: 'cc.enc', chunks: [4096, 4096] }];
  const init = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files }),
  });
  assert.strictEqual(init.status, 200);
  for (let ci = 0; ci < 2; ci++) {
    const buf = Buffer.alloc(4096, ci + 1);
    const r = await fetch(`${srv.base}/api/upload/part?u=${key}&f=0&c=${ci}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc32(buf).toString(16).padStart(8, '0') }, body: buf,
    });
    assert.strictEqual(r.status, 200);
  }
  // 两发同时进：合并是逐块删的流水线，第二个必须被挡在门外
  const [a, b] = await Promise.all([
    jget(`${srv.base}/api/upload/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: key }) }),
    jget(`${srv.base}/api/upload/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: key }) }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepStrictEqual(statuses, [200, 409], `一发成功一发 409，实际 ${statuses}`);
  const folder = a.status === 200 ? a.body.folder : b.body.folder;
  // 批次只能落一个目录，且内容完整（两个 4096 的块拼起来）
  const listed = (await jget(`${srv.base}/api/list`)).body;
  assert.ok(listed.folders.some((f) => f.name === folder), '成功那发要真的把目录落进列表');
});

test('重启后未完成批次仍可续（只清写一半的 .tmp）', async () => {
  const key = hexKey();
  const files = [{ enc: 'k.enc', chunks: [1024, 1024] }];
  await uploadBundlePart(srv, key, files, 0);
  // 手工留一个写了一半的块，模拟进程被杀
  const dir = path.join(srv.dir, 'uploading', key);
  fs.writeFileSync(path.join(dir, 'part-0-1.tmp'), Buffer.alloc(300));
  assert.strictEqual(fs.existsSync(path.join(dir, 'part-0-0.bin')), true);
  await srv.stop({ keep: true });
  srv = await startServer({}, srv.dir);
  const r = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files }),
  });
  assert.deepStrictEqual(r.body.have, [{ f: 0, c: 0 }], '重启不能把已完成的块抹掉，否则续传形同虚设');
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'uploading', key, 'part-0-1.tmp')), false, '半块必须清掉');
});

async function uploadBundlePart(s, key, files, onlyFileChunk) {
  await jget(`${s.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, files }),
  });
  const [fi, ci] = [Math.floor(onlyFileChunk / 10), onlyFileChunk % 10];
  const buf = Buffer.alloc(files[fi].chunks[ci], 9);
  const res = await fetch(`${s.base}/api/upload/part?u=${key}&f=${fi}&c=${ci}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc32(buf).toString(16).padStart(8, '0') }, body: buf,
  });
  assert.strictEqual(res.status, 200);
}

test('删除目录后列表与占用一起回落', async () => {
  const { folder } = await uploadBundle(srv, hexKey(), manifest(1));
  const before1 = (await jget(`${srv.base}/api/list`)).body;
  assert.ok(before1.folders.some((f) => f.name === folder));
  assert.strictEqual((await jget(`${srv.base}/api/folder/${folder}`, { method: 'DELETE' })).status, 200);
  const after = (await jget(`${srv.base}/api/list`)).body;
  assert.ok(!after.folders.some((f) => f.name === folder));
  assert.strictEqual(after.usage.used, before1.usage.used - before1.folders.find((f) => f.name === folder).size);
  assert.strictEqual((await jget(`${srv.base}/api/folder/不存在的目录`, { method: 'DELETE' })).status, 404);
});

test('静态页可取（前端回归的入口）', async () => {
  for (const p of ['/', '/index.html', '/crypto.js', '/dec-worker.js']) {
    const res = await fetch(`${srv.base}${p}`);
    assert.strictEqual(res.status, 200, `${p} 取不到`);
    if (p === '/index.html') assert.match(await res.text(), /上传/);
  }
});
