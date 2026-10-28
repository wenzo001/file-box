// 下载/归档的并发上限：匿名者并发开流能把文件句柄吃光，之后整台机器都打不开。
// 这里用裸 http 客户端故意不读 body（流保持打开），占住名额后再要一个，必须被 429 挡下。
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startServer, uploadBundle, hexKey } = require('./helpers');

const open = (port, p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => resolve({ res, req }));
  req.on('error', reject);
});
const drain = ({ res, req }) => new Promise((r) => { res.resume(); res.on('end', r); res.on('close', r); req.destroy(); });

test('下载与归档都有并发上限：占满后回 429，腾出来立刻恢复', async () => {
  const srv = await startServer({ MAX_EGRESS: '2' });
  try {
    const big = crypto.randomBytes(4 * 1024 * 1024);
    const up = await uploadBundle(srv, hexKey(40), [{ enc: 'big.enc', chunks: [big.length], data: [big] }]);
    const url = `/api/download/${up.folder}/big.enc`;

    const a = await open(srv.port, url);
    const b = await open(srv.port, url);
    assert.strictEqual(a.res.statusCode, 200);
    assert.strictEqual(b.res.statusCode, 200);

    const third = await open(srv.port, url);
    assert.strictEqual(third.res.statusCode, 429, `第三个并发下载没被挡（${third.res.statusCode}）`);
    await drain(third);

    // 归档和下载共用一个池：下载占满时归档也要被挡
    const archive = await open(srv.port, `/api/archive/${up.folder}`);
    assert.strictEqual(archive.res.statusCode, 429, '归档没跟下载共用同一个并发池');
    await drain(archive);

    // 腾出两个名额之后必须立刻能下
    await Promise.all([drain(a), drain(b)]);
    await new Promise((r) => setTimeout(r, 100));
    const again = await open(srv.port, url);
    assert.strictEqual(again.res.statusCode, 200, '名额释放后仍然被拒');
    await drain(again);
  } finally {
    await srv.stop();
  }
});

test('并发上限只管吐文件的路：普通 JSON 接口不受影响', async () => {
  const srv = await startServer({ MAX_EGRESS: '1' });
  try {
    const big = crypto.randomBytes(4 * 1024 * 1024);
    const up = await uploadBundle(srv, hexKey(40), [{ enc: 'x.enc', chunks: [big.length], data: [big] }]);
    const held = await open(srv.port, `/api/download/${up.folder}/x.enc`);
    const blocked = await open(srv.port, `/api/download/${up.folder}/x.enc`);
    assert.strictEqual(blocked.res.statusCode, 429);
    await drain(blocked);
    const lib = await (await fetch(`${srv.base}/api/library`)).json();
    assert.ok(Array.isArray(lib.folders), '名额占满时列表接口被误伤');
    await drain(held);
  } finally {
    await srv.stop();
  }
});
