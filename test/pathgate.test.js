// 目录闸门：所有"按名字动 uploads 里的东西"的接口，只能碰本服务自己创建的目录，
// 且不能顺着链接走出去。这里用真服务 + 真磁盘 + 真链接验，不用假想载荷。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, uploadBundle, hexKey } = require('./helpers');

let srv, dir, up, outside;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbgate-'));
  outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(outside, 'precious'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'precious', 'topsecret.bin'), 'TOPSECRET');
  fs.writeFileSync(path.join(dir, 'sibling.txt'), 'SIBLING');
  up = path.join(dir, 'uploads');
  srv = await startServer({}, dir, 41);
});
after(async () => { await srv.stop(); });

const snap = (root) => {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(`${r}:${fs.readFileSync(path.join(d, e.name), 'utf8')}`);
    }
  };
  walk(root, '');
  return out.sort().join('|');
};
const status = (p, method = 'GET') => fetch(`${srv.base}${p}`, { method }).then((r) => r.status);

/** Windows 上普通用户建目录软链接要开发者模式，junction 不用；POSIX 用 symlink */
function linkDir(target, name) {
  const p = path.join(up, name);
  fs.rmSync(p, { recursive: true, force: true });
  fs.symlinkSync(target, p, process.platform === 'win32' ? 'junction' : 'dir');
  return p;
}

test('链接不能成为越界读的口：目录名对上服务形状也照样不许跟出去', async () => {
  // 链接的名字**必须**长得像本服务自己建的（YYYYMMDD_HHmm）：用一个不像的名字，
  // 第一道"名字形状"就把它挡了，链接这两层根本没被走到 —— 整条判据会空对空地绿。
  const LINKED = '20260923_1430';
  try { linkDir(path.join(outside, 'precious'), LINKED); }
  catch (e) { assert.fail(`夹具建不了链接（${e.code}），这条判据就没人看守了`); }
  assert.ok(fs.existsSync(path.join(outside, 'precious', 'topsecret.bin')), '夹具自己得先成立：界外文件真的在');
  const before = snap(outside);
  const list = await (await fetch(`${srv.base}/api/list`)).json();
  assert.ok(!list.folders.some((f) => f.name === LINKED), '链接目录不该出现在列表里');
  const dl = await status(`/api/download/${LINKED}/topsecret.bin`);
  assert.ok([400, 403, 404].includes(dl), `下载界外文件必须被拒，实际 ${dl}`);
  const ar = await status(`/api/archive/${LINKED}`);
  assert.ok([400, 403, 404].includes(ar), `归档整个界外目录必须被拒，实际 ${ar}`);
  const del = await status(`/api/folder/${LINKED}`, 'DELETE');
  assert.ok([400, 403, 404].includes(del), `借链接删界外必须被拒，实际 ${del}`);
  assert.strictEqual(snap(outside), before, '界外内容被动过');
});

test('只许删本服务创建的目录：外来目录既看不见也删不掉', async () => {
  fs.mkdirSync(path.join(up, 'manual-ops-backup'), { recursive: true });
  fs.writeFileSync(path.join(up, 'manual-ops-backup', 'note.txt'), 'NOT-SERVICES');
  const list = await (await fetch(`${srv.base}/api/list`)).json();
  assert.ok(!list.folders.some((f) => f.name === 'manual-ops-backup'), '非本服务命名的目录不该进列表（看得见却删不掉更糟）');
  assert.strictEqual(await status('/api/download/manual-ops-backup/note.txt'), 404, '外来目录里的文件不该被服务出去');
  assert.strictEqual(await status('/api/folder/manual-ops-backup', 'DELETE'), 400, '非本服务创建的目录不许删');
  assert.ok(fs.existsSync(path.join(up, 'manual-ops-backup', 'note.txt')), '外来目录被动过了');
});

test('穿越载荷：一律拒，并且界外哨兵一字节都不许变', async () => {
  const before = snap(outside);
  const payloads = [
    '..', '%2e%2e', '....', '..%20', '%2e%2e%2f%2e%2e%2foutside%2fprecious',
    '%2e%2e%5c%2e%2e%5coutside%5cprecious', '%2f..%2f..%2foutside',
    'C%3A%2foutside', 'C%3A%5coutside', '%5c%5cattacker%5cshare',
    'outside%2fprecious', 'outside%2e', 'outside%20', '..%3a', '%2e%2e%3a',
    '..%255c..%255coutside', '%2e%2e%ef%bc%8foutside',
  ];
  for (const p of payloads) {
    const s = await status(`/api/folder/${p}`, 'DELETE');
    assert.ok([400, 403, 404].includes(s), `载荷 ${p} 返回了 ${s}`);
  }
  assert.strictEqual(snap(outside), before, '穿越载荷把界外内容改动了');
  assert.ok(fs.existsSync(up), 'UPLOAD_DIR 自己不能被动掉');
});

test('正常路径不许被闸门挡死：真实上传的目录能列、能下、能归档、能删', async () => {
  const key = hexKey(40);
  const { folder } = await uploadBundle(srv, key, [
    { enc: 'a.enc', chunks: [4096] },
    { enc: 'b.enc', chunks: [2048] },
  ]);
  const list = await (await fetch(`${srv.base}/api/list`)).json();
  const got = list.folders.find((f) => f.name === folder);
  assert.ok(got, `刚上传的 ${folder} 没出现在列表里`);
  assert.strictEqual(got.files.length, 2);
  assert.strictEqual(await status(`/api/download/${folder}/a.enc`), 200);
  assert.strictEqual(await status(`/api/archive/${folder}`), 200);
  assert.strictEqual(await status(`/api/folder/${folder}`, 'DELETE'), 200);
  assert.ok(!fs.existsSync(path.join(up, folder)), '正常目录要真删掉');
});

test('同一分钟内的序号目录（20260923_1430_2）也算本服务创建的', async () => {
  const name = '20260923_1430_2';
  fs.mkdirSync(path.join(up, name), { recursive: true });
  fs.writeFileSync(path.join(up, name, 'x.bin'), 'X');
  const list = await (await fetch(`${srv.base}/api/list`)).json();
  assert.ok(list.folders.some((f) => f.name === name), 'commitStaging 生成的带序号目录必须被认下来');
  assert.strictEqual(await status(`/api/folder/${name}`, 'DELETE'), 200);
});

// 静态门只能证明"这一块里有声明"，抓不住"同一条路由里有一支漏了"（比如 Range 续传那一支）。
// 这里读真响应头：文件名是客户端声明的，叫 evil.html 也必须让浏览器下载而不是当页面渲染。
test('吐文件的四条路都带安全声明：attachment 或 octet-stream', async () => {
  const batch = '20260923_1444';
  const dir = path.join(up, batch);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evil.html'), '<script>alert(1)</script>');

  const plain = await fetch(`${srv.base}/api/download/${batch}/evil.html`);
  assert.strictEqual(plain.status, 200);
  assert.match(plain.headers.get('content-disposition') || '', /attachment/, '普通下载没有 attachment');
  await plain.arrayBuffer();

  const ranged = await fetch(`${srv.base}/api/download/${batch}/evil.html`, { headers: { Range: 'bytes=0-10' } });
  assert.strictEqual(ranged.status, 206);
  assert.match(ranged.headers.get('content-disposition') || '', /attachment/, 'Range 续传那一支没有 attachment');
  await ranged.arrayBuffer();

  const archived = await fetch(`${srv.base}/api/archive/${batch}`);
  assert.strictEqual(archived.status, 200);
  assert.strictEqual(archived.headers.get('content-type'), 'application/octet-stream', '归档没有 octet-stream');
  await archived.arrayBuffer();

  // 无痕分段：接收方凭 proof 取密文，同样不许让浏览器把它当页面
  const sid = Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz123456789'[crypto.randomInt(31)]).join('');
  const proof = crypto.randomBytes(32).toString('hex');
  const created = await (await fetch(`${srv.base}/api/xfer/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, proof, frames: 2, totalBytes: 2048 }),
  })).json();
  const joined = await fetch(`${srv.base}/api/xfer/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, proof }),
  });
  assert.strictEqual(joined.status, 200, '前置：配对要成功');
  assert.strictEqual((await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, {
    method: 'PUT',
    headers: { 'X-Xfer-Sender': created.token, 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(256, 7),
  })).status, 200, '前置：密文要先落盘');
  const seg = await fetch(`${srv.base}/api/xfer/seg?sid=${sid}&i=0`, { headers: { 'X-Xfer-Proof': proof } });
  assert.strictEqual(seg.status, 200);
  assert.strictEqual(seg.headers.get('content-type'), 'application/octet-stream', '无痕分段没有 octet-stream');
  await seg.arrayBuffer();
});
