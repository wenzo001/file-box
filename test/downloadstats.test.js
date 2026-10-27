// 下载次数：口径要钉死在"真的开始吐字节才算、清单文件不算、失败不算"，
// 并且重启还在、目录删掉账本就跟着走。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, uploadBundle, hexKey } = require('./helpers');

const list = async (s) => (await (await fetch(`${s.base}/api/list`)).json());
const folderOf = async (s, name) => (await list(s)).folders.find((f) => f.name === name);
const fileOf = async (s, name, enc) => {
  const f = await folderOf(s, name);
  return f && f.files.find((x) => x.name === enc);
};
const get = (s, p) => fetch(`${s.base}${p}`).then(async (r) => ({ status: r.status, len: (await r.arrayBuffer()).byteLength }));

async function oneShot(extra = {}, dirOverride = null, slot = 0) {
  const srv = await startServer(extra, dirOverride, slot);
  const up = path.join(srv.dir, 'uploads');
  fs.mkdirSync(path.join(up, '20260923_1430'), { recursive: true });
  fs.writeFileSync(path.join(up, '20260923_1430', 'a.enc'), 'AAAA');
  fs.writeFileSync(path.join(up, '20260923_1430', 'b.enc'), 'BBBBBB');
  fs.writeFileSync(path.join(up, '20260923_1430', 'manifest.enc'), 'M');
  return srv;
}

test('下载两次就是 2：文件级与目录级同步，清单文件本身不计数', async () => {
  const srv = await oneShot({}, null, 51);
  try {
    assert.strictEqual((await folderOf(srv, '20260923_1430')).downloads, 0, '一开始该是 0 次，而不是缺字段');
    assert.strictEqual((await get(srv, '/api/download/20260923_1430/a.enc')).status, 200);
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'a.enc')).downloads, 1);
    await get(srv, '/api/download/20260923_1430/a.enc');
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'a.enc')).downloads, 2, 'b.enc 不该跟着涨');
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'b.enc')).downloads, 0);
    assert.strictEqual((await folderOf(srv, '20260923_1430')).downloads, 2, '目录级 = 各文件之和');

    // 前端每次展开目录都会自动拉 manifest.enc：一旦计数，界面上就是"被点开的次数"
    await get(srv, '/api/download/20260923_1430/manifest.enc');
    await get(srv, '/api/download/20260923_1430/manifest.enc');
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'manifest.enc')).downloads, 0, '清单文件不该计数');
    assert.strictEqual((await folderOf(srv, '20260923_1430')).downloads, 2, '拉清单不该把目录汇总抬上去');
  } finally { await srv.stop(); }
});

test('归档算取走整包：每个非清单文件各 +1，目录级仍是各文件之和', async () => {
  const srv = await oneShot({}, null, 52);
  try {
    const r = await get(srv, '/api/archive/20260923_1430');
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'a.enc')).downloads, 1);
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'b.enc')).downloads, 1);
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'manifest.enc')).downloads, 0);
    assert.strictEqual((await folderOf(srv, '20260923_1430')).downloads, 2);
  } finally { await srv.stop(); }
});

test('没吐成字节就不许计数：404、闸门拒绝、外来目录', async () => {
  const srv = await oneShot({}, null, 53);
  try {
    assert.strictEqual((await get(srv, '/api/download/20260923_1430/没有这个文件.enc')).status, 404);
    assert.strictEqual((await get(srv, '/api/download/20260923_1430/..%2f..%2foutside')).status, 404);
    assert.strictEqual((await get(srv, '/api/archive/不是本服务建的目录')).status, 404);
    fs.mkdirSync(path.join(srv.dir, 'uploads', 'manual-ops'), { recursive: true });
    fs.writeFileSync(path.join(srv.dir, 'uploads', 'manual-ops', 'x.enc'), 'X');
    assert.strictEqual((await get(srv, '/api/download/manual-ops/x.enc')).status, 404);
    const l = await list(srv);
    const f = l.folders.find((x) => x.name === '20260923_1430');
    assert.strictEqual(f.downloads, 0, '失败的那几次一次都不该算');
    assert.ok(f.files.every((x) => x.downloads === 0), JSON.stringify(f.files));
  } finally { await srv.stop(); }
});

test('重启后计数还在；目录被手动删除时账本就跟着清掉', async () => {
  const dir = fs.mkdtempSync(require('os').tmpdir() + '/fbdl-');
  let srv = await oneShot({}, dir, 54);
  try {
    await get(srv, '/api/download/20260923_1430/a.enc');
    await get(srv, '/api/download/20260923_1430/a.enc');
    await get(srv, '/api/archive/20260923_1430');
    const file = path.join(dir, '.stats', 'downloads.json');
    const t0 = Date.now();
    while (!fs.existsSync(file) && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(file), '账本该落在 uploads 之外的 .stats/downloads.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(raw['20260923_1430'], { 'a.enc': 3, 'b.enc': 1 }, `账本内容不对: ${JSON.stringify(raw)}`);
    await srv.stop({ keep: true });

    srv = await oneShot({}, dir, 55);
    assert.strictEqual((await fileOf(srv, '20260923_1430', 'a.enc')).downloads, 3, '重启后次数要接得上');
    assert.strictEqual((await folderOf(srv, '20260923_1430')).downloads, 4);

    assert.strictEqual((await fetch(`${srv.base}/api/folder/20260923_1430`, { method: 'DELETE' })).status, 200);
    const t1 = Date.now();
    let raw2 = {};
    while (Date.now() - t1 < 6000) {
      raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!('20260923_1430' in raw2)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!('20260923_1430' in raw2), `删掉的目录还在账本里: ${JSON.stringify(raw2)}`);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('真实上传链路也要能记上次数（前端走的就是这条路）', async () => {
  const srv = await startServer({}, null, 56);
  try {
    const { folder } = await uploadBundle(srv, hexKey(40), [{ enc: 'f_deadbeef0012ab.enc', chunks: [2048] }]);
    assert.strictEqual((await folderOf(srv, folder)).downloads, 0);
    await get(srv, `/api/download/${folder}/f_deadbeef0012ab.enc`);
    const f = await folderOf(srv, folder);
    assert.strictEqual(f.downloads, 1);
    assert.strictEqual(f.files.find((x) => x.name === 'f_deadbeef0012ab.enc').downloads, 1);
  } finally { await srv.stop(); }
});
