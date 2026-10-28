// 一键清空（真服务、真磁盘）：清完之后要能自证"文件夹里啥都没有了"，
// 同时目录树、全局设置、历史下载累计这三种"要留住的东西"一个都不许少。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startServer, jget, uploadBundle, hexKey } = require('./helpers');
const { WIPE_CONFIRM } = require('../lib/maintenance');

let srv;
before(async () => { srv = await startServer({ XFER_CREATE_LIMIT: '1000' }); });
after(async () => { await srv.stop(); });

const CONFIRM = WIPE_CONFIRM;
const uploadsDir = () => path.join(srv.dir, 'uploads');
const stagingDir = () => path.join(srv.dir, 'uploading');
const transferDir = () => path.join(srv.dir, 'transfer');

const wipe = (body) => jget(`${srv.base}/api/maintenance/wipe`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const library = async () => (await jget(`${srv.base}/api/library`)).body;
const download = (batch, file) => fetch(`${srv.base}/api/download/${batch}/${file}`);

/** 造一个真实的批次（可选落进某个目录） */
async function makeBatch({ folderId = null, enc = 'a.enc', bytes = 64 } = {}) {
  const key = hexKey(40);
  const out = await uploadBundle(srv, key, [{ enc, chunks: [bytes] }], folderId ? { folderId } : {});
  return out.folder;
}

test('确认词不对：400，且一个批次都不许被删', async () => {
  const batch = await makeBatch();
  const r = await wipe({ confirm: '清空' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /确认词/);
  assert.ok(fs.existsSync(path.join(uploadsDir(), batch)), '校验没过就动手了');
});

test('清空：uploads / 暂存 / 中转全空，目录树与全局设置原样保留，回执数对得上', async () => {
  // 前置现场：一个用户目录 + 目录里的一个批次 + 未分档里的一个批次 + 一次下载 +
  // 一个传了一半的上传 + 一个无痕传输会话
  const folder = (await jget(`${srv.base}/api/folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '清理前目录' }),
  })).body.folder;
  await jget(`${srv.base}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultTtlHours: 4 }),
  });
  const inFolder = await makeBatch({ folderId: folder.id });
  const unfiled = await makeBatch({ enc: 'b.enc' });
  const dl = await download(inFolder, 'a.enc');
  assert.strictEqual(dl.status, 200, '前置：下载要成功（否则下载累计无从谈起）');
  await dl.arrayBuffer();

  const stagedKey = hexKey(40);
  assert.strictEqual((await jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: stagedKey, files: [{ enc: 'c.enc', chunks: [32] }] }),
  })).status, 200);
  const sid = Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz123456789'[crypto.randomInt(31)]).join('');
  const proof = crypto.randomBytes(32).toString('hex');
  const cr = await jget(`${srv.base}/api/xfer/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, proof, frames: 2, totalBytes: 2048 }),
  });
  assert.strictEqual(cr.status, 200, '前置：无痕会话要建得起来');
  assert.strictEqual((await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Xfer-Sender': cr.body.token },
    body: Buffer.alloc(1024, 5),
  })).status, 200, '前置：无痕密文要落盘');

  assert.ok(fs.existsSync(path.join(uploadsDir(), inFolder)), '前置：批次要先在盘上');
  assert.ok(fs.existsSync(path.join(stagingDir(), stagedKey)), '前置：未完成上传要先在盘上');
  assert.ok(fs.existsSync(path.join(transferDir(), sid)), '前置：无痕密文要先在盘上');

  // 回执要按"清空前的事实"对账（前面几条腿也在同一个服务上造过数据）
  const before = await library();
  const wantBatches = before.batches.length;
  const wantFiles = before.batches.reduce((s, b) => s + b.count, 0);
  const wantBytes = before.batches.reduce((s, b) => s + b.size, 0);

  const r = await wipe({ confirm: CONFIRM });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(fs.readdirSync(uploadsDir()).filter((n) => /^\d{8}_\d{4}/.test(n)), [], 'uploads 里不许剩批次目录');
  assert.deepStrictEqual(fs.readdirSync(stagingDir()), [], '未完成上传要一起清掉');
  assert.deepStrictEqual(fs.readdirSync(transferDir()), [], '无痕中转区要一起清掉');
  assert.strictEqual(r.body.removed.batches, wantBatches, `回执批次数对不上：${JSON.stringify(r.body.removed)} vs 清空前 ${wantBatches}`);
  assert.strictEqual(r.body.removed.files, wantFiles, '回执文件数与清空前对不上');
  assert.strictEqual(r.body.removed.bytes, wantBytes, '回执字节数与清空前对不上');
  assert.strictEqual(r.body.verified.uploadsEmpty, true);
  assert.strictEqual(r.body.verified.stagingEmpty, true);
  assert.strictEqual(r.body.verified.transferEmpty, true);
  assert.ok(r.body.kept.downloadTotal >= 1, `历史下载累计要留住：${JSON.stringify(r.body.kept)}`);

  const lib = await library();
  assert.strictEqual(lib.batches.length, 0, '索引里不许剩批次');
  const kept = lib.folders.find((f) => f.name === '清理前目录');
  assert.ok(kept, '目录树必须保留');
  assert.strictEqual(kept.count, 0);
  assert.strictEqual(lib.settings.defaultTtlHours, 4, '全局设置必须保留');
  assert.ok(lib.folders.every((f) => f.count === 0), '所有目录的计数都要归零');
});

test('只删本服务自己建的批次目录：外来目录一个字节都不动', async () => {
  const mine = path.join(uploadsDir(), '我的资料');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'keep.txt'), '别人放的东西');
  const batch = await makeBatch({ enc: 'only.enc' });

  const r = await wipe({ confirm: CONFIRM });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(fs.readFileSync(path.join(mine, 'keep.txt'), 'utf8'), '别人放的东西');
  assert.ok(!fs.existsSync(path.join(uploadsDir(), batch)), '自己建的批次仍要删掉');
  fs.rmSync(mine, { recursive: true, force: true });
});

test('连清两次幂等：第二次照样 200，removed 全是 0', async () => {
  await makeBatch({ enc: 'twice.enc' });
  const first = await wipe({ confirm: CONFIRM });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.removed.batches, 1, '第一次要真删掉刚造的那个批次');
  const again = await wipe({ confirm: CONFIRM });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.removed.batches, 0);
  assert.strictEqual(again.body.removed.files, 0);
  assert.strictEqual(again.body.removed.bytes, 0);
  assert.strictEqual(again.body.verified.uploadsEmpty, true);
});
