// 上传声明的文件名：按"两侧文件系统都能安全落盘"的最严交集收；
// 以及对外错误回显不许带服务器绝对路径（审计里已用 enc="a.enc:" 复现过一次泄露）。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startServer, jget, uploadBundle, hexKey, crc32 } = require('./helpers');

const part = (buf) => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc32(buf).toString(16).padStart(8, '0') },
  body: buf,
});

async function tryInit(srv, enc) {
  return jget(`${srv.base}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: hexKey(40), files: [{ enc, chunks: [16] }] }),
  });
}

test('落不了盘的名字要在 init 就拒掉，别等传完整批再在合并处炸', async () => {
  const srv = await startServer();
  try {
    const bad = [
      'CON', 'con.enc', 'NUL', 'COM1.enc', 'LPT9.txt', 'aux', 'PRN.enc',
      'a.enc:', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b.enc', 'trail.', 'trail.',
      '..:', '.:', 'a\x00b', 'a\x01b.enc', 'x'.repeat(201) + '.enc',
    ];
    for (const name of bad) {
      const r = await tryInit(srv, name);
      assert.strictEqual(r.status, 400, `名字 ${JSON.stringify(name)} 竟然被收下了: ${JSON.stringify(r.body)}`);
    }
  } finally { await srv.stop(); }
});

test('正常密文名不许被误伤（含中文、点号、空格、下划线、长但合法）', async () => {
  const srv = await startServer();
  try {
    const good = ['manifest.enc', 'a.enc', '2026_10_13 1430.enc', '报告 汇总.enc', 'a.b.c.enc', '_x.enc', 'f_deadbeef0012ab.enc', 'x'.repeat(190) + '.enc'];
    for (const name of good) {
      const r = await tryInit(srv, name);
      assert.strictEqual(r.status, 200, `合法名字被拒 ${JSON.stringify(name)}: ${JSON.stringify(r.body)}`);
    }
    const { folder } = await uploadBundle(srv, hexKey(40), [{ enc: '报告 汇总.enc', chunks: [1024] }]);
    const list = await jget(`${srv.base}/api/list`);
    assert.ok(list.body.folders.some((f) => f.name === folder && f.files.some((x) => x.name === '报告 汇总.enc')), '带空格与中文的名要能走完整个链路');
  } finally { await srv.stop(); }
});

test('合并失败对外不回服务器绝对路径（在目标名上先占一个同名目录，逼出真失败）', async () => {
  const fs = require('fs');
  const srv = await startServer();
  try {
    const key = hexKey(40);
    const init = await jget(`${srv.base}/api/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, files: [{ enc: 'a.enc', chunks: [16] }] }),
    });
    assert.strictEqual(init.status, 200);
    const buf = Buffer.alloc(16, 7);
    assert.strictEqual((await fetch(`${srv.base}/api/upload/part?u=${key}&f=0&c=0`, part(buf))).status, 200);
    // 块齐了，但改名要落到的位置上站着一个非空目录：rename 必失败（EPERM/EISDIR/ENOTEMPTY）
    const blocker = path.join(srv.dir, 'uploading', key, 'a.enc');
    fs.mkdirSync(blocker, { recursive: true });
    fs.writeFileSync(path.join(blocker, 'inner.bin'), 'X');
    const fin = await jget(`${srv.base}/api/upload/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: key }),
    });
    assert.strictEqual(fin.status, 500, `合并该失败，实际 ${JSON.stringify(fin)}`);
    const leaked = JSON.stringify(fin.body);
    assert.ok(!leaked.includes(srv.dir), `响应里带了服务器绝对路径: ${leaked}`);
    assert.ok(!/ENOENT|EPERM|EISDIR|ENOTEMPTY|EINVAL|[A-Za-z]:[\\/]/.test(leaked), `响应里漏了底层错误细节: ${leaked}`);
    assert.ok(typeof fin.body.error === 'string' && fin.body.error.length > 0, '总得给用户一句能看懂的话');
  } finally { await srv.stop(); }
});

test('请求体超限与解析失败的回显不带内部路径（全局错误处理那一层）', async () => {
  const srv = await startServer();
  try {
    const huge = '{"key":"' + '1'.repeat(3 * 1024 * 1024) + '"}';
    const probes = [
      await jget(`${srv.base}/api/upload/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: huge }),
      await jget(`${srv.base}/api/upload/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json' }),
      await jget(`${srv.base}/api/folder/%c0%ae%c0%ae%c0%afoutside`, { method: 'DELETE' }),
      await jget(`${srv.base}/api/upload/part?u=zz&f=0&c=0`, part(Buffer.alloc(4))),
    ];
    for (const p of probes) {
      const s = JSON.stringify(p.body);
      assert.ok(!s.includes(srv.dir), `回显里出现服务器路径: ${s}`);
      assert.ok(!/ENOENT|EPERM|EINVAL|ERR_[A-Z_]+/.test(s), `回显里出现内部错误码: ${s}`);
    }
  } finally { await srv.stop(); }
});
