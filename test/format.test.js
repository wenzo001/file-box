// 展示层判据：热乎窗口、到期标红、刚上传的 1 小时不被取整成 2 小时。
// format.js 是前端 ESM 且没有任何依赖，用 data: URL 直接导入，不引构建链。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let mod;
const load = async () => {
  if (mod) return mod;
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'lib', 'format.js'), 'utf8');
  mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  return mod;
};

test('热乎：刚上传时服务端时间略晚于本帧 now 也算；超过 10 分钟不算', async () => {
  const { isHot, HOT_MS, fmtAgo } = await load();
  const now = 1_700_000_000_000;
  assert.strictEqual(isHot(now + 3_000, now), true);
  assert.strictEqual(isHot(now - 60_000, now), true);
  assert.strictEqual(isHot(now - HOT_MS + 1, now), true);
  assert.strictEqual(isHot(now - HOT_MS, now), false);
  assert.strictEqual(fmtAgo(now + 3_000, now), '刚刚');
  assert.strictEqual(fmtAgo(now - 3 * 60_000, now), '3 分钟前');
});

test('到期：10 分钟内标红、1 小时内黄、刚上传的 1 小时写成 1 小时', async () => {
  const { expiryClass, fmtExpiry } = await load();
  const now = 1_700_000_000_000;
  assert.strictEqual(expiryClass(now + 5 * 60_000, now), 'expiry-danger');
  assert.strictEqual(expiryClass(now + 30 * 60_000, now), 'expiry-warn');
  assert.strictEqual(expiryClass(now + 2 * 3_600_000, now), 'expiry-plain');
  assert.strictEqual(expiryClass(undefined, now), 'expiry-plain');
  assert.strictEqual(fmtExpiry(now + 3_600_000 - 5_000, now), '1 小时后删除');
  assert.strictEqual(fmtExpiry(now + 5 * 60_000, now), '5 分钟后删除');
});

test('删掉的那套重复导航不许长回来：App.vue 与 app.css 里不许再出现那批类名', () => {
  const banned = [
    'sidebar', 'side-item', 'side-sep', 'usage-bar', 'usage-text',
    'table-head', 'check-cell', 'row-main', 'folder-main', 'file-main',
  ];
  assert.ok(banned.length >= 10, '名单被删空了，这条判据就成了恒真');
  const files = [
    ['App.vue', path.join(__dirname, '..', 'web', 'src', 'App.vue')],
    ['app.css', path.join(__dirname, '..', 'web', 'src', 'styles', 'app.css')],
  ];
  const css = fs.readFileSync(files[1][1], 'utf8');
  for (const live of ['col-row', 'col-expiry']) {
    assert.ok(new RegExp(`\\b${live}\\b`).test(css), `扫描器连在用的 ${live} 都找不到，说明它瞎了`);
  }
  for (const [name, file] of files) {
    const src = fs.readFileSync(file, 'utf8');
    const hits = banned.filter((c) => new RegExp(`\\b${c}\\b`).test(src));
    assert.deepStrictEqual(hits, [], `${name} 里还留着已删除的导航类名: ${hits.join(', ')}`);
  }
});

test('到期状态类不许复用元素名：CSS 里任何 display:none 的规则都不能点到它', async () => {
  // 事故口径：状态类曾返回裸 'expiry'，被旧表格的窄屏规则 .file-row > .expiry 命中，
  // 第三行（倒计时）在手机上去掉——文字判据抓不到，只有量渲染几何才看得见。
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const hiddenIn = (src) => [...src.matchAll(/([^{}]+)\{[^{}]*display:\s*none[^{}]*\}/g)].map((m) => m[1]);
  // 正对照：扫描器必须看得见「隐藏规则点名 expiry」这个形状 —— 否则 0 命中只是它瞎了
  const probe = hiddenIn('.a > .expiry { display: none; }');
  assert.strictEqual(probe.length, 1, '扫描器看不见 display:none 规则，这条判据是空的');
  assert.ok(/expiry/.test(probe[0]), '扫描器抓到的选择器里没有 expiry');
  const hits = hiddenIn(css).filter((sel) => /expiry/i.test(sel));
  assert.deepStrictEqual(hits, [], `有隐藏规则点名 expiry 类，状态类会再被布局吃掉:\n${hits.join('\n')}`);
});
