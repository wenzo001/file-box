// 目录 API 集成测试：用真服务 + 真磁盘，验证 /api/library、目录 CRUD、批次归属、TTL 与删除。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, jget, uploadBundle, hexKey } = require('./helpers');
const { createLibrary } = require('../lib/library');

let srv;

before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

const folder = (body) => jget(`${srv.base}/api/folders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const patchFolder = (id, body) => jget(`${srv.base}/api/folders/${id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const library = () => jget(`${srv.base}/api/library`);
const folderById = (data, id) => data.folders.find((f) => f.id === id);

test('空库：/api/library 返回未分档、TTL 选项和用量；旧 /api/list 兼容', async () => {
  const r = await library();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.libraryReady, true);
  assert.ok(r.body.folders.some((f) => f.id === '__unfiled__' && f.system === true));
  assert.deepStrictEqual(r.body.batches, []);
  assert.deepStrictEqual(r.body.ttlOptions, [1, 4, 8, 48, 72, 120, 240, 2160]);
  assert.strictEqual(r.body.usage.limitGB, 1);

  const old = await jget(`${srv.base}/api/list`);
  assert.strictEqual(old.status, 200);
  assert.deepStrictEqual(old.body.folders, []);
});

test('目录 CRUD：同名 409、非法名 400、移动 / 重命名 / 空目录删除', async () => {
  const a = await folder({ name: 'API 项目组 A' });
  assert.strictEqual(a.status, 200);
  assert.match(a.body.folder._id, /^f_[a-f0-9]{12}$/);
  assert.strictEqual(a.body.folder.parentId, null);

  const dup = await folder({ name: 'API 项目组 a' });
  assert.strictEqual(dup.status, 409);

  const bad = await folder({ name: 'bad/name' });
  assert.strictEqual(bad.status, 400);

  const child = await folder({ name: 'API 2026Q4', parentId: a.body.folder._id });
  assert.strictEqual(child.status, 200);
  assert.strictEqual(child.body.folder.parentId, a.body.folder._id);

  const renamed = await patchFolder(child.body.folder._id, { name: 'API 2026Q4-改' });
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.body.folder.name, 'API 2026Q4-改');

  const badPatch = await patchFolder(child.body.folder._id, { name: 'x', parentId: a.body.folder._id });
  assert.strictEqual(badPatch.status, 400, '一次只能改名称或位置');

  const empty = await folder({ name: 'API 空目录' });
  const del = await fetch(`${srv.base}/api/folders/${empty.body.folder._id}?mode=empty`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(folderById((await library()).body, empty.body.folder._id), undefined);
});

test('上传到目录：folderId / TTL 写入、目录汇总、批次移动、expectFolder 防误删', async () => {
  const src = await folder({ name: 'API 源目录' });
  const dst = await folder({ name: 'API 目标目录' });
  const srcId = src.body.folder._id;
  const dstId = dst.body.folder._id;

  const key = hexKey();
  const files = [
    { enc: 'a.enc', chunks: [4, 4] },
    { enc: 'manifest.enc', chunks: [4] },
  ];
  const out = await uploadBundle(srv, key, files, { folderId: srcId, ttlHours: 1 });
  assert.strictEqual(out.folderId, srcId);
  assert.strictEqual(out.indexed, true);
  assert.strictEqual(out.folderMissing, false);
  assert.ok(out.expiresAt > Date.now());

  let data = (await library()).body;
  const batch = data.batches.find((b) => b.name === out.folder);
  assert.ok(batch, '上传完成后必须出现在目录视图');
  assert.strictEqual(batch.folderId, srcId);
  assert.strictEqual(batch.ttlHours, 1);
  assert.strictEqual(batch.legacy, false);
  assert.strictEqual(folderById(data, srcId).count, 1);
  assert.strictEqual(folderById(data, srcId).size, batch.size);
  assert.strictEqual(folderById(data, srcId).earliestExpiresAt, out.expiresAt);

  const moved = await jget(`${srv.base}/api/batches/${out.folder}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId: dstId }),
  });
  assert.strictEqual(moved.status, 200);
  data = (await library()).body;
  assert.strictEqual(folderById(data, srcId).count, 0);
  assert.strictEqual(folderById(data, dstId).count, 1);

  const wrong = await fetch(`${srv.base}/api/folder/${out.folder}?expectFolder=${srcId}`, { method: 'DELETE' });
  assert.strictEqual(wrong.status, 409, '批次已被移走，旧归属删除必须拒绝');
  const right = await fetch(`${srv.base}/api/folder/${out.folder}?expectFolder=${dstId}`, { method: 'DELETE' });
  assert.strictEqual(right.status, 200);
  assert.deepStrictEqual((await library()).body.batches, []);
});

test('旧批次：无索引时归未分档；批量移动会补 legacy 条目', async () => {
  const target = await folder({ name: 'API 旧数据目标' });
  const oldName = '20190101_1200';
  const oldDir = path.join(srv.dir, 'uploads', oldName);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'old.enc'), Buffer.from('old'));

  let data = (await library()).body;
  const legacy = data.batches.find((b) => b.name === oldName);
  assert.ok(legacy);
  assert.strictEqual(legacy.folderId, null);
  assert.strictEqual(legacy.legacy, true);

  const moved = await jget(`${srv.base}/api/batches`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: [oldName], folderId: target.body.folder._id }),
  });
  assert.strictEqual(moved.status, 200);
  data = (await library()).body;
  const after = data.batches.find((b) => b.name === oldName);
  assert.strictEqual(after.folderId, target.body.folder._id);
  assert.strictEqual(after.legacy, true);
  assert.ok(after.uploadedAt > 0);
});

test('递归删除目录：物理批次和索引一起走；mode=empty 遇到文件 409', async () => {
  const root = await folder({ name: 'API 删除根' });
  const child = await folder({ name: 'API 删除子', parentId: root.body.folder._id });
  const key = hexKey();
  const out = await uploadBundle(srv, key, [{ enc: 'del.enc', chunks: [4] }], {
    folderId: child.body.folder._id,
    ttlHours: 4,
  });
  const physical = path.join(srv.dir, 'uploads', out.folder);
  assert.ok(fs.existsSync(physical));

  const notEmpty = await fetch(`${srv.base}/api/folders/${child.body.folder._id}?mode=empty`, { method: 'DELETE' });
  assert.strictEqual(notEmpty.status, 409);

  const del = await fetch(`${srv.base}/api/folders/${root.body.folder._id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(fs.existsSync(physical), false);
  const data = (await library()).body;
  assert.strictEqual(folderById(data, root.body.folder._id), undefined);
  assert.strictEqual(folderById(data, child.body.folder._id), undefined);
  assert.strictEqual(data.batches.some((b) => b.name === out.folder), false);
});

test('启动 TTL 扫描：过期批次物理删除、索引删除、目录保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbttl-'));
  const batchName = '20260101_1000';
  const physical = path.join(dir, 'uploads', batchName);
  fs.mkdirSync(physical, { recursive: true });
  fs.writeFileSync(path.join(physical, 'expired.enc'), Buffer.from('x'));

  const lib = await createLibrary({ libraryDir: path.join(dir, 'library'), backupDelayMs: 5 }).init();
  const f = await lib.createFolder({ name: 'TTL 保留目录', parentId: null });
  await lib.setBatch(batchName, {
    folderId: f._id,
    uploadedAt: Date.now() - 3600_000,
    ttlHours: 1,
    expiresAt: Date.now() - 1000,
  });
  await lib.close();

  const ttlSrv = await startServer({ TTL_SWEEP_MS: '60000' }, dir, 7);
  try {
    const data = (await jget(`${ttlSrv.base}/api/library`)).body;
    assert.strictEqual(data.batches.some((b) => b.name === batchName), false);
    assert.ok(data.folders.some((x) => x.id === f._id), '目录本身不能被 TTL 删掉');
    assert.strictEqual(fs.existsSync(physical), false);
    assert.deepStrictEqual((await jget(`${ttlSrv.base}/api/list`)).body.folders, []);
  } finally {
    await ttlSrv.stop();
  }
});
