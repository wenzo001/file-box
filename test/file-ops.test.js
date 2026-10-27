// 单文件删除 / 重命名、Range 续传、未完成上传列表与取消。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startServer, jget, uploadBundle, hexKey } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

const b64 = (buf) => Buffer.from(buf).toString('base64');
const manifest = (files) => Buffer.from(JSON.stringify({ v: 1, files }));
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const post = (url, body) => jget(`${srv.base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const list = async () => (await jget(`${srv.base}/api/list`)).body;

async function bundleWithManifest() {
  const mf = manifest([
    { name: 'a.txt', size: 4, enc: 'a.enc' },
    { name: 'b.txt', size: 4, enc: 'b.enc' },
  ]);
  const files = [
    { enc: 'a.enc', chunks: [4], data: [Buffer.from('aaaa')] },
    { enc: 'b.enc', chunks: [4], data: [Buffer.from('bbbb')] },
    { enc: 'manifest.enc', chunks: [mf.length], data: [mf] },
  ];
  const out = await uploadBundle(srv, hexKey(), files);
  return { out, mf };
}

test('单文件删除：清单原子重写、密文删除、最后一个文件走完整批清理', async () => {
  const { out, mf } = await bundleWithManifest();
  const batch = out.folder;
  const next = manifest([{ name: 'b.txt', size: 4, enc: 'b.enc' }]);

  const del = await post(`/api/batches/${batch}/file-delete`, {
    file: 'a.enc',
    manifest: b64(next),
    expectedManifestHash: hash(mf),
  });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.batchRemoved, false);
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'uploads', batch, 'a.enc')), false);
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'uploads', batch, 'b.enc')), true);
  assert.ok(fs.readFileSync(path.join(srv.dir, 'uploads', batch, 'manifest.enc')).equals(next));

  let data = await list();
  assert.strictEqual(data.folders.find((f) => f.name === batch).count, 1);

  const empty = manifest([]);
  const last = await post(`/api/batches/${batch}/file-delete`, {
    file: 'b.enc',
    manifest: b64(empty),
    expectedManifestHash: hash(next),
  });
  assert.strictEqual(last.status, 200);
  assert.strictEqual(last.body.batchRemoved, true);
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'uploads', batch)), false);
  data = await list();
  assert.strictEqual(data.folders.some((f) => f.name === batch), false);
});

test('并发删除：同一份旧清单只能成功一个，另一个 409 且不能复活已删文件', async () => {
  const { out, mf } = await bundleWithManifest();
  const batch = out.folder;
  const keepA = manifest([{ name: 'a.txt', size: 4, enc: 'a.enc' }]);
  const keepB = manifest([{ name: 'b.txt', size: 4, enc: 'b.enc' }]);
  const oldHash = hash(mf);

  const [one, two] = await Promise.all([
    post(`/api/batches/${batch}/file-delete`, { file: 'b.enc', manifest: b64(keepA), expectedManifestHash: oldHash }),
    post(`/api/batches/${batch}/file-delete`, { file: 'a.enc', manifest: b64(keepB), expectedManifestHash: oldHash }),
  ]);
  const statuses = [one.status, two.status].sort((a, b) => a - b);
  assert.deepStrictEqual(statuses, [200, 409]);
  const remaining = fs.readdirSync(path.join(srv.dir, 'uploads', batch)).filter((n) => n !== 'manifest.enc');
  assert.strictEqual(remaining.length, 1, '只能有一个文件被删，另一个必须保留');
});

test('重命名：只替换清单，密文与下载计数不变；过期哈希 409', async () => {
  const { out, mf } = await bundleWithManifest();
  const batch = out.folder;
  const cipherBefore = fs.readFileSync(path.join(srv.dir, 'uploads', batch, 'a.enc'));
  const renamed = manifest([
    { name: '改名后.txt', size: 4, enc: 'a.enc' },
    { name: 'b.txt', size: 4, enc: 'b.enc' },
  ]);

  const r = await post(`/api/batches/${batch}/file-rename`, {
    file: 'a.enc',
    manifest: b64(renamed),
    expectedManifestHash: hash(mf),
  });
  assert.strictEqual(r.status, 200);
  assert.ok(fs.readFileSync(path.join(srv.dir, 'uploads', batch, 'manifest.enc')).equals(renamed));
  assert.ok(fs.readFileSync(path.join(srv.dir, 'uploads', batch, 'a.enc')).equals(cipherBefore));
  const row = (await list()).folders.find((f) => f.name === batch).files.find((f) => f.name === 'a.enc');
  assert.strictEqual(row.downloads, 0);

  const stale = await post(`/api/batches/${batch}/file-rename`, {
    file: 'a.enc',
    manifest: b64(renamed),
    expectedManifestHash: hash(mf),
  });
  assert.strictEqual(stale.status, 409);

  const missing = await post(`/api/batches/${batch}/file-rename`, {
    file: 'none.enc',
    manifest: b64(renamed),
    expectedManifestHash: hash(renamed),
  });
  assert.strictEqual(missing.status, 404);
});

test('旧数据无清单：允许直接删密文，删空整批消失', async () => {
  const out = await uploadBundle(srv, hexKey(), [{ enc: 'legacy.enc', chunks: [4], data: [Buffer.from('old!')] }]);
  const del = await post(`/api/batches/${out.folder}/file-delete`, { file: 'legacy.enc' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.batchRemoved, true);
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'uploads', out.folder)), false);
});

test('删除路径闸门：manifest.enc / 路径分隔符 / 有清单却不交新清单一律拒', async () => {
  const { out, mf } = await bundleWithManifest();
  const batch = out.folder;
  const m = await post(`/api/batches/${batch}/file-delete`, { file: 'manifest.enc', manifest: b64(mf) });
  assert.strictEqual(m.status, 400);
  const traversal = await post(`/api/batches/${batch}/file-delete`, { file: '../a.enc', manifest: b64(mf) });
  assert.strictEqual(traversal.status, 400);
  const noManifest = await post(`/api/batches/${batch}/file-delete`, { file: 'a.enc' });
  assert.strictEqual(noManifest.status, 400);
});

test('Range：206 字节正确、416 越界、续传不重复计下载次数', async () => {
  const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const out = await uploadBundle(srv, hexKey(), [{ enc: 'r.enc', chunks: [1000], data: [body] }]);
  const batch = out.folder;

  const part = await fetch(`${srv.base}/api/download/${batch}/r.enc`, { headers: { Range: 'bytes=100-' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers.get('content-range'), 'bytes 100-999/1000');
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(body.subarray(100)));

  const full = await fetch(`${srv.base}/api/download/${batch}/r.enc`);
  assert.strictEqual(full.status, 200);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(body));

  const bad = await fetch(`${srv.base}/api/download/${batch}/r.enc`, { headers: { Range: 'bytes=2000-' } });
  assert.strictEqual(bad.status, 416);

  const row = (await list()).folders.find((f) => f.name === batch).files.find((f) => f.name === 'r.enc');
  assert.strictEqual(row.downloads, 1, 'Range 续传不计数，只有从头取那一次计数');
});

test('未完成上传：列表不含真实名、取消会清掉暂存', async () => {
  const key = hexKey();
  const files = [{ enc: 'u.enc', chunks: [100, 100] }];
  const init = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, files }),
  });
  assert.strictEqual(init.status, 200);

  let uploads = (await jget(`${srv.base}/api/uploads`)).body.uploads;
  let item = uploads.find((u) => u.uploadId === key);
  assert.ok(item);
  assert.strictEqual(item.fileCount, 1);
  assert.strictEqual(item.totalChunks, 2);
  assert.strictEqual(item.receivedChunks, 0);
  assert.strictEqual('enc' in item, false, '未完成列表不能泄露密文名');

  const buf = Buffer.alloc(100, 7);
  const crc = (() => {
    const { crc32 } = require('./helpers');
    return crc32(buf).toString(16).padStart(8, '0');
  })();
  const put = await fetch(`${srv.base}/api/upload/part?u=${key}&f=0&c=0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc },
    body: buf,
  });
  assert.strictEqual(put.status, 200);
  uploads = (await jget(`${srv.base}/api/uploads`)).body.uploads;
  item = uploads.find((u) => u.uploadId === key);
  assert.strictEqual(item.receivedChunks, 1);

  const del = await fetch(`${srv.base}/api/uploads/${key}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'uploading', key)), false);
  uploads = (await jget(`${srv.base}/api/uploads`)).body.uploads;
  assert.strictEqual(uploads.some((u) => u.uploadId === key), false);

  const missing = await fetch(`${srv.base}/api/uploads/${hexKey()}`, { method: 'DELETE' });
  assert.strictEqual(missing.status, 404);
});
