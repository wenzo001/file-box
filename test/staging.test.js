// 收尾搬运（暂存区 → uploads）的两条路：同盘 rename、跨盘 复制+删源。
// 跨盘那条在真机上无法稳定复现（要两块盘），所以把 fs 注入进来，用"renameSync 抛 EXDEV"当证人。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commitStaging } = require('../lib/staging');

function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbstage-'));
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(uploads);
  const staging = path.join(root, 'uploading', 'abcdef0123456789');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'a.enc'), 'AAA');
  fs.writeFileSync(path.join(staging, 'b.enc'), 'BB');
  return { root, uploads, staging };
}

/** 名字队列：第一个是 20261028_1200，之后加序号；用真目录判断碰撞 */
function namer(uploads) {
  let n = 1;
  return () => {
    const name = n === 1 ? '20261028_1200' : `20261028_1200_${n}`;
    n++;
    return { name, target: path.join(uploads, name) };
  };
}

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });

test('同盘：整目录搬进 uploads，源消失、内容一致、返回批次名', () => {
  const { root, uploads, staging } = scene();
  try {
    const name = commitStaging(staging, { nextBatchDir: namer(uploads) });
    assert.strictEqual(name, '20261028_1200');
    const target = path.join(uploads, name);
    assert.strictEqual(fs.readFileSync(path.join(target, 'a.enc'), 'utf8'), 'AAA');
    assert.strictEqual(fs.readFileSync(path.join(target, 'b.enc'), 'utf8'), 'BB');
    assert.ok(!fs.existsSync(staging), '源目录必须搬走，不能留一份');
  } finally { cleanup(root); }
});

test('跨盘（EXDEV）：退化为 复制+删源，不重试 rename，源目录照样消失', () => {
  const { root, uploads, staging } = scene();
  try {
    let renames = 0;
    const fsx = Object.assign({}, fs, {
      renameSync: () => {
        renames++;
        const err = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      },
    });
    const name = commitStaging(staging, { nextBatchDir: namer(uploads), fsx });
    assert.strictEqual(name, '20261028_1200');
    assert.strictEqual(renames, 1, `EXDEV 不该被当成"撞名"重试（rename 调了 ${renames} 次）`);
    const target = path.join(uploads, name);
    assert.strictEqual(fs.readFileSync(path.join(target, 'a.enc'), 'utf8'), 'AAA');
    assert.strictEqual(fs.readFileSync(path.join(target, 'b.enc'), 'utf8'), 'BB');
    assert.ok(!fs.existsSync(staging), '复制完必须删源，否则同一批会被收尾两次');
  } finally { cleanup(root); }
});

test('跨盘且源删不掉：撤掉目标并抛错，源原样留着（下次还能重试）', () => {
  const { root, uploads, staging } = scene();
  try {
    const fsx = Object.assign({}, fs, {
      renameSync: () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; },
      rmSync: (p, o) => {
        if (p === staging) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }
        return fs.rmSync(p, o);
      },
    });
    assert.throws(() => commitStaging(staging, { nextBatchDir: namer(uploads), fsx }), /EPERM/);
    assert.ok(fs.existsSync(staging), '源删不掉时不许假装搬成功');
    assert.ok(!fs.existsSync(path.join(uploads, '20261028_1200')), '目标必须撤掉，否则会留下一份重复批次');
  } finally { cleanup(root); }
});

test('跨盘时目标目录已存在：换下一个名字，已存在的那个一个字节都不动', () => {
  const { root, uploads, staging } = scene();
  try {
    const taken = path.join(uploads, '20261028_1200');
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, 'keep.enc'), '别动我');
    const fsx = Object.assign({}, fs, {
      renameSync: () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; },
    });
    const name = commitStaging(staging, { nextBatchDir: namer(uploads), fsx });
    assert.strictEqual(name, '20261028_1200_2', `撞名后应换下一个名字，实际用了 ${name}`);
    assert.strictEqual(fs.readFileSync(path.join(taken, 'keep.enc'), 'utf8'), '别动我');
    assert.strictEqual(fs.readFileSync(path.join(uploads, name, 'a.enc'), 'utf8'), 'AAA');
  } finally { cleanup(root); }
});

