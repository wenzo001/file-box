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

test('到期状态类不许复用元素名：CSS 里任何 display:none 的规则都不能点到它', async () => {
  // 事故口径：状态类曾返回裸 'expiry'，被旧表格的窄屏规则 .file-row > .expiry 命中，
  // 第三行（倒计时）在手机上去掉——文字判据抓不到，只有量渲染几何才看得见。
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const hidden = [...css.matchAll(/([^{}]+)\{[^{}]*display:\s*none[^{}]*\}/g)].map((m) => m[1]);
  assert.ok(hidden.length > 0, 'CSS 里一条 display:none 都没扫到，说明扫描器瞎了');
  const hits = hidden.filter((sel) => /expiry/i.test(sel));
  assert.deepStrictEqual(hits, [], `有隐藏规则点名 expiry 类，状态类会再被布局吃掉:\n${hits.join('\n')}`);
});
