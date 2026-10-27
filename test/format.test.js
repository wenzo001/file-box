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
    'selection-bar', 'upload-line',
  ];
  assert.ok(banned.length >= 12, '名单被删空了，这条判据就成了恒真');
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

test('右键菜单三态与触摸档 44pt 必须在 CSS 里真声明（静态守机制）', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const coarse = (css.match(/@media \(pointer: coarse\)\s*\{[\s\S]*?\n\}/g) || []).join('\n');
  assert.ok(coarse.length > 0, '一条 pointer:coarse 规则都没扫到，说明扫描器瞎了');
  assert.match(coarse, /\.context-menu \.menu-item \{[^}]*min-height:\s*44px/, '触摸档没给右键菜单项 44pt 目标');
  assert.match(css, /\.context-menu \.menu-item:hover:not\(:disabled\)/, '右键菜单项没有 hover 规则');
  assert.match(css, /\.context-menu \.menu-item:active:not\(:disabled\)/, '右键菜单项没有按下态');
  assert.match(css, /\.context-menu \.menu-item:disabled/, '右键菜单项没有禁用态');
});

test('file-move 端点一旦被界面调用，台面就必须有真浏览器拖拽判据（防"后端有、界面悄悄上"）', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'App.vue'), 'utf8');
  const lab = fs.readFileSync(path.join(__dirname, '..', 'test', 'lab', 'library-smoke.js'), 'utf8');
  const uiCalls = /api\.moveFile\(/.test(app);
  const hasJudge = /dragTo\(/.test(lab);
  assert.strictEqual(uiCalls && !hasJudge, false,
    `界面已在调用 file-move（uiCalls=${uiCalls}）但台面无拖拽判据（hasJudge=${hasJudge}）——要么补判据，要么别接`);
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

test('手机档守机制：界面层不许钉顶、卡片要有高度地板、44 是命中区不是画出来的框', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'styles', 'app.css'), 'utf8');
  const mobile = (css.match(/@media \(max-width: 560px\)\s*\{[\s\S]*?\n\}/g) || []).join('\n');
  assert.ok(mobile.length > 0, '一条 max-width:560 规则都没扫到，说明扫描器瞎了');
  assert.ok(mobile.includes('position: static'),
    '手机档没让顶栏随页面滚走：sticky 会把 3～4 行界面层永久压在浏览区头上');
  assert.match(mobile, /\.columns\s*\{[^}]*min-height:\s*280px/,
    '手机档分栏卡片没有 280px 高度地板：让卡片和任务面板抢同一屏，实测会被挤到 62px、栏内行永久裁掉');
  const coarse = (css.match(/@media \(pointer: coarse\)\s*\{[\s\S]*?\n\}/g) || []).join('\n');
  // 两条命中区规则要各自点名：只写 /\.check-hit/ 的话，栏头那条会替行那条背锅（下刀试过，摘掉行那条仍绿）
  assert.match(coarse, /\.col-row \.check-hit\s*\{[^}]*width:\s*44px/, '触摸档目录行/文件行的勾选入口没有 44 命中区');
  assert.match(coarse, /\.col-tools \.check-hit\s*\{[^}]*width:\s*44px/, '触摸档栏头「全选本栏」没有 44 命中区');
  assert.match(coarse, /\.col-row \.col-check\s*\{[^}]*width:\s*22px/,
    '触摸档原生方框的尺寸变了：44 应该是命中区（外面那层 label），不是把复选框本身画成 44');
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'App.vue'), 'utf8');
  const wraps = (app.match(/class="check-hit"/g) || []).length;
  assert.ok(wraps >= 3, `勾选入口的命中区包装层只有 ${wraps} 处，应为 3（栏头全选 / 目录行 / 文件行）`);
});
