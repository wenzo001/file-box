// 目录索引的纯单元测试：不启动服务，直接验证 NeDB 目录树 / 批次 / TTL / 备份恢复。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibrary } = require('../lib/library');

let dir;
let lib;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fblib-'));
  lib = await createLibrary({ libraryDir: path.join(dir, '.library'), backupDelayMs: 5 }).init();
});

after(async () => {
  if (lib) await lib.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const expectCode = (code) => (err) => {
  assert.strictEqual(err.code, code);
  return true;
};

test('目录：同名去重（大小写不敏感）、不同父级可同名、保留名 / 非法名拒绝', async () => {
  const a = await lib.createFolder({ name: '项目组 A', parentId: null });
  assert.match(a._id, /^f_[a-f0-9]{12}$/);
  assert.strictEqual(a.parentId, null);

  await assert.rejects(
    () => lib.createFolder({ name: '项目组 a', parentId: null }),
    expectCode('DUPLICATE_NAME'),
  );

  const b = await lib.createFolder({ name: '2026Q4', parentId: a._id });
  const c = await lib.createFolder({ name: '项目组 A', parentId: b._id });
  assert.strictEqual(c.parentId, b._id);

  await assert.rejects(
    () => lib.createFolder({ name: '未分档', parentId: null }),
    expectCode('INVALID_NAME'),
  );
  await assert.rejects(
    () => lib.createFolder({ name: 'a/b', parentId: null }),
    expectCode('INVALID_NAME'),
  );
  await assert.rejects(
    () => lib.createFolder({ name: '  ', parentId: null }),
    expectCode('INVALID_NAME'),
  );
});

test('目录：重命名、移动、禁止移入自身 / 后代、深度上限', async () => {
  const a = await lib.createFolder({ name: '移动-A', parentId: null });
  const b = await lib.createFolder({ name: '移动-B', parentId: a._id });

  const renamed = await lib.renameFolder(a._id, { name: '移动-A2' });
  assert.strictEqual(renamed.name, '移动-A2');

  await assert.rejects(
    () => lib.moveFolder(a._id, { parentId: b._id }),
    expectCode('CYCLE'),
  );
  await assert.rejects(
    () => lib.moveFolder(a._id, { parentId: a._id }),
    expectCode('CYCLE'),
  );

  const moved = await lib.moveFolder(b._id, { parentId: null });
  assert.strictEqual(moved.parentId, null);
  const back = await lib.moveFolder(b._id, { parentId: a._id });
  assert.strictEqual(back.parentId, a._id);

  let parentId = null;
  for (let i = 1; i <= 8; i++) {
    const f = await lib.createFolder({ name: `层-${i}`, parentId });
    assert.strictEqual(await lib.depthOf(f._id), i);
    parentId = f._id;
  }
  await assert.rejects(
    () => lib.createFolder({ name: '层-9', parentId }),
    expectCode('DEPTH_LIMIT'),
  );
});

test('批次：归属、清单哈希、批量移动、旧批次补条目、TTL 到期查询', async () => {
  const a = await lib.createFolder({ name: '批次-A', parentId: null });
  const b = await lib.createFolder({ name: '批次-B', parentId: null });
  const now = 1_700_000_000_000;

  await lib.setBatch('20260101_1000', {
    folderId: a._id, uploadedAt: now, ttlHours: 1, expiresAt: now + 3600_000, manifestHash: 'a'.repeat(64),
  });
  const got = await lib.getBatch('20260101_1000');
  assert.strictEqual(got.folderId, a._id);
  assert.strictEqual(got.expiresAt, now + 3600_000);
  assert.strictEqual(got.manifestHash, 'a'.repeat(64));

  await lib.setBatchHash('20260101_1000', 'b'.repeat(64));
  assert.strictEqual((await lib.getBatch('20260101_1000')).manifestHash, 'b'.repeat(64));

  const moved = await lib.moveBatches(
    ['20260101_1000', '20250101_0900'],
    b._id,
    { '20250101_0900': { uploadedAt: 1_600_000_000_000 } },
  );
  assert.strictEqual(moved.moved, 2);
  assert.strictEqual((await lib.getBatch('20260101_1000')).folderId, b._id);
  const legacy = await lib.getBatch('20250101_0900');
  assert.strictEqual(legacy.folderId, b._id);
  assert.strictEqual(legacy.legacy, true);
  assert.strictEqual(legacy.uploadedAt, 1_600_000_000_000);

  await lib.setBatch('20250102_0900', { folderId: null, uploadedAt: now, ttlHours: null });
  const expired = await lib.listExpired(now + 2 * 3600_000);
  assert.deepStrictEqual(expired.map((x) => x._id).sort(), ['20260101_1000']);
});

test('TTL 扫描：删除成功才移除索引；删除失败保留条目', async () => {
  const now = 1_700_000_000_000;
  await lib.setBatch('20260103_1000', { folderId: null, uploadedAt: now, ttlHours: 1, expiresAt: now - 1 });
  await lib.setBatch('20260103_1100', { folderId: null, uploadedAt: now, ttlHours: 1, expiresAt: now - 1 });

  const deleted = [];
  await lib.sweepExpired({
    now,
    deleteBatch: async (name) => {
      if (name === '20260103_1100') throw new Error('模拟删除失败');
      deleted.push(name);
    },
  });
  assert.deepStrictEqual(deleted, ['20260103_1000']);
  assert.strictEqual(await lib.getBatch('20260103_1000'), null);
  assert.ok(await lib.getBatch('20260103_1100'), '删除失败时必须保留索引条目以便下次重试');
  await lib.removeBatch('20260103_1100');
});

test('目录子树：空目录检查、递归删目录、路径与高度', async () => {
  const a = await lib.createFolder({ name: '子树-A', parentId: null });
  const b = await lib.createFolder({ name: '子树-B', parentId: a._id });
  await lib.setBatch('20260104_1000', { folderId: b._id, uploadedAt: 1_700_000_000_000 });

  const subtree = await lib.folderSubtree(a._id);
  assert.deepStrictEqual(subtree.folderIds.sort(), [a._id, b._id].sort());
  assert.deepStrictEqual(subtree.batches, ['20260104_1000']);
  assert.deepStrictEqual((await lib.folderPath(b._id)).map((x) => x.name), ['子树-A', '子树-B']);
  assert.strictEqual(await lib.subtreeHeight(a._id), 2);

  await assert.rejects(() => lib.deleteEmptyFolder(a._id), expectCode('FOLDER_NOT_EMPTY'));
  await assert.rejects(() => lib.deleteEmptyFolder(b._id), expectCode('FOLDER_NOT_EMPTY'));

  await lib.removeBatch('20260104_1000');
  await lib.deleteEmptyFolder(b._id);
  await lib.deleteEmptyFolder(a._id);
  assert.strictEqual(await lib.getFolder(a._id), null);
});

test('递归删目录：多个目录一次删干净，遗留批次归未分档而不是变成孤儿', async () => {
  const a = await lib.createFolder({ name: '删-A', parentId: null });
  const b = await lib.createFolder({ name: '删-B', parentId: a._id });
  await lib.setBatch('20260106_1000', { folderId: b._id, uploadedAt: 1_700_000_000_000 });

  const out = await lib.deleteFolders([a._id, b._id]);
  assert.strictEqual(out.deleted, 2);
  assert.strictEqual(await lib.getFolder(a._id), null);
  assert.strictEqual(await lib.getFolder(b._id), null);
  assert.strictEqual((await lib.getBatch('20260106_1000')).folderId, null);
  await lib.removeBatch('20260106_1000');
});

test('持久化 / 备份 / 损坏恢复：优先主文件，坏文件退 .bak，两个都坏从空库启动', async () => {
  const persistDir = path.join(dir, 'persist');
  const first = await createLibrary({ libraryDir: persistDir, backupDelayMs: 5 }).init();
  const folder = await first.createFolder({ name: '持久化-A', parentId: null });
  await first.setBatch('20260105_1000', { folderId: folder._id, uploadedAt: 1_700_000_000_000 });
  await first.flushBackup();
  await first.close();

  const reopened = await createLibrary({ libraryDir: persistDir, backupDelayMs: 5 }).init();
  assert.strictEqual((await reopened.getFolder(folder._id)).name, '持久化-A');
  assert.strictEqual((await reopened.getBatch('20260105_1000')).folderId, folder._id);
  await reopened.close();

  fs.writeFileSync(path.join(persistDir, 'folders.db'), '这不是 NeDB 数据\n');
  const fromBak = await createLibrary({ libraryDir: persistDir, backupDelayMs: 5 }).init();
  assert.ok(await fromBak.getFolder(folder._id), '主文件坏了应回退 .bak');
  await fromBak.close();

  fs.writeFileSync(path.join(persistDir, 'folders.db'), '坏\n');
  fs.writeFileSync(path.join(persistDir, 'folders.db.bak'), '也坏\n');
  const empty = await createLibrary({ libraryDir: persistDir, backupDelayMs: 5 }).init();
  assert.deepStrictEqual(await empty.allFolders(), []);
  await empty.close();
});
