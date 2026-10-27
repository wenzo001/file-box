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

test('有加密清单却缺 expectedManifestHash：拒绝写入，文件不动', async () => {
  const { out, mf } = await bundleWithManifest();
  const next = manifest([{ name: 'b.txt', size: 4, enc: 'b.enc' }]);
  const r = await post(`/api/batches/${out.folder}/file-delete`, {
    file: 'a.enc',
    manifest: b64(next),
  });
  assert.strictEqual(r.status, 400);
  assert.ok(fs.existsSync(path.join(srv.dir, 'uploads', out.folder, 'a.enc')), '缺 CAS 时不能动文件');
  assert.ok(fs.readFileSync(path.join(srv.dir, 'uploads', out.folder, 'manifest.enc')).equals(mf));
});

test('清单临时文件不进列表、不能下载', async () => {
  const { out } = await bundleWithManifest();
  const temp = path.join(srv.dir, 'uploads', out.folder, 'manifest.enc.tmp');
  fs.writeFileSync(temp, 'internal temp');
  const row = (await list()).folders.find((f) => f.name === out.folder);
  assert.ok(row);
  assert.strictEqual(row.files.some((f) => f.name === 'manifest.enc.tmp'), false);
  const dl = await fetch(`${srv.base}/api/download/${out.folder}/manifest.enc.tmp`);
  assert.strictEqual(dl.status, 404);
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

// ---- 单文件跨目录移动（拆批次）----
const BATCH_DIR = /^\d{8}_\d{4}(_\d+)?$/;
const newFolder = async (name) => {
  const r = await jget(`${srv.base}/api/folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  assert.strictEqual(r.status, 200, `建目录失败: ${JSON.stringify(r.body)}`);
  const lib = await jget(`${srv.base}/api/library`);
  const f = lib.body.folders.find((x) => x.name === name);
  assert.ok(f, '新目录没出现在 /api/library 里');
  return f.id;
};
const batchRow = async (name) => {
  const lib = await jget(`${srv.base}/api/library`);
  return lib.body.batches.find((b) => b.name === name) || null;
};
const batchDirs = () => fs.readdirSync(path.join(srv.dir, 'uploads')).filter((n) => BATCH_DIR.test(n));

test('移动单个文件：拆出新批次，源批次与到期时间都不许被改写坏', async () => {
  const { out, mf } = await bundleWithManifest();
  const src = out.folder;
  const to = await newFolder('移动去处');
  const keepB = manifest([{ name: 'b.txt', size: 4, enc: 'b.enc' }]);
  const onlyA = manifest([{ name: 'a.txt', size: 4, enc: 'a.enc' }]);
  const before = await batchRow(src);

  const r = await post(`/api/batches/${src}/file-move`, {
    file: 'a.enc', to, sourceManifest: b64(keepB), targetManifest: b64(onlyA), expectedManifestHash: hash(mf),
  });
  assert.strictEqual(r.status, 200, `移动失败: ${JSON.stringify(r.body)}`);
  const toName = r.body.toBatch;
  assert.ok(BATCH_DIR.test(toName), `新批次名不符合命名规则: ${toName}`);
  assert.strictEqual(r.body.sourceRemoved, false, '源批次还剩一个文件，不该被清理');

  const uploads = path.join(srv.dir, 'uploads');
  assert.strictEqual(fs.existsSync(path.join(uploads, src, 'a.enc')), false, '密文还留在源批次');
  assert.ok(fs.readFileSync(path.join(uploads, src, 'manifest.enc')).equals(keepB), '源清单没换成去掉这一条的版本');
  assert.ok(fs.existsSync(path.join(uploads, toName, 'a.enc')), '新批次里没有这条密文');
  assert.ok(fs.readFileSync(path.join(uploads, toName, 'manifest.enc')).equals(onlyA), '新批次清单不该带上别的文件');

  const moved = await batchRow(toName);
  assert.strictEqual(moved.folderId, to, '新批次没挂到目标目录');
  assert.strictEqual(moved.legacy, false, '拆出来的批次被标成了旧数据');
  assert.strictEqual(moved.uploadedAt, before.uploadedAt, '上传时间被重置了');
  assert.strictEqual(moved.ttlHours, before.ttlHours, 'TTL 快照被改写');
  assert.strictEqual(moved.expiresAt, before.expiresAt, '到期时间被重置，倒计时会偷偷续命');

  const dl = await fetch(`${srv.base}/api/download/${toName}/a.enc`);
  assert.strictEqual(dl.status, 200, '移动后下载不到');
  assert.strictEqual((await dl.arrayBuffer()).byteLength, 4, '下载到的字节数不对');
});

test('移动单个文件：清单 CAS 不匹配时 409，且一个字节都不许动', async () => {
  const { out, mf } = await bundleWithManifest();
  const src = out.folder;
  const to = await newFolder('CAS 拒绝去处');
  const dirsBefore = batchDirs().length;
  const r = await post(`/api/batches/${src}/file-move`, {
    file: 'a.enc', to, sourceManifest: b64(manifest([])), targetManifest: b64(manifest([])),
    expectedManifestHash: hash(Buffer.from('不是这份清单')),
  });
  assert.strictEqual(r.status, 409, `陈旧清单没被拒: ${JSON.stringify(r.body)}`);
  assert.strictEqual(batchDirs().length, dirsBefore, `被拒的移动留下了多余批次目录: ${batchDirs().join(',')}`);
  assert.ok(fs.existsSync(path.join(srv.dir, 'uploads', src, 'a.enc')), '被拒之后源文件不见了');
  assert.ok(fs.readFileSync(path.join(srv.dir, 'uploads', src, 'manifest.enc')).equals(mf), '被拒之后源清单被改过');
});

test('移动单个文件：目标目录不存在要 404，且不许搬走文件', async () => {
  const { out } = await bundleWithManifest();
  const src = out.folder;
  const dirsBefore = batchDirs().length;
  const r = await post(`/api/batches/${src}/file-move`, {
    file: 'a.enc', to: 'no-such-folder', sourceManifest: b64(manifest([])), targetManifest: b64(manifest([])),
    expectedManifestHash: hash(manifest([
      { name: 'a.txt', size: 4, enc: 'a.enc' }, { name: 'b.txt', size: 4, enc: 'b.enc' },
    ])),
  });
  assert.strictEqual(r.status, 404, `不存在的目录没被拒: ${JSON.stringify(r.body)}`);
  assert.strictEqual(batchDirs().length, dirsBefore, '目标目录不存在却已经建了新批次目录');
  assert.ok(fs.existsSync(path.join(srv.dir, 'uploads', src, 'a.enc')), '目标不合法却把文件搬走了');
});

test('移动批次里最后一个文件：源批次连带清掉，不留空目录', async () => {
  const mf = manifest([{ name: 'only.txt', size: 4, enc: 'o.enc' }]);
  const out = await uploadBundle(srv, hexKey(), [
    { enc: 'o.enc', chunks: [4], data: [Buffer.from('oooo')] },
    { enc: 'manifest.enc', chunks: [mf.length], data: [mf] },
  ]);
  const src = out.folder;
  const to = await newFolder('最后一件去处');
  const r = await post(`/api/batches/${src}/file-move`, {
    file: 'o.enc', to,
    sourceManifest: b64(manifest([])), targetManifest: b64(manifest([{ name: 'only.txt', size: 4, enc: 'o.enc' }])),
    expectedManifestHash: hash(mf),
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.sourceRemoved, true, '源批次空了却没报已清理');
  assert.strictEqual(fs.existsSync(path.join(srv.dir, 'uploads', src)), false, '空批次目录留在盘上');
  assert.strictEqual(await batchRow(src), null, '索引里还留着已清理的源批次');
  assert.strictEqual((await batchRow(r.body.toBatch)).folderId, to, '最后一件没落到目标目录');
});

