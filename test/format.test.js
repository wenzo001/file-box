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

// 2026-10 重构：样式从单个 app.css 拆成 tokens/base/files/shell 四份，
// 行的模板也从 App.vue 下沉到 components/RowItem.vue。
// 下面四条静态判据因此改成"扫全部样式表 / 扫全部模板"，判据本身一条没删。
const STYLES_DIR = path.join(__dirname, '..', 'web', 'src', 'styles');
const CSS_FILES = ['tokens.css', 'base.css', 'files.css', 'shell.css'];
const cssAll = () => CSS_FILES.map((f) => fs.readFileSync(path.join(STYLES_DIR, f), 'utf8')).join('\n');
const TEMPLATES = () => [
  path.join(__dirname, '..', 'web', 'src', 'App.vue'),
  ...fs.readdirSync(path.join(__dirname, '..', 'web', 'src', 'components'))
    .filter((f) => f.endsWith('.vue'))
    .map((f) => path.join(__dirname, '..', 'web', 'src', 'components', f)),
];
const tplAll = () => TEMPLATES().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const tpl = (name) => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'components', name), 'utf8');
const mediaBlock = (src, query) => (
  (src.match(new RegExp(`@media ${query.replace(/[()]/g, '\\$&')}\\s*\\{[\\s\\S]*?\\n\\}`, 'g')) || []).join('\n')
);

test('删掉的那套重复导航不许长回来：模板与样式里不许再出现那批类名', () => {
  const banned = [
    'sidebar', 'side-item', 'side-sep', 'usage-bar', 'usage-text',
    'table-head', 'check-cell', 'row-main', 'folder-main', 'file-main',
    'selection-bar', 'upload-line',
  ];
  assert.ok(banned.length >= 12, '名单被删空了，这条判据就成了恒真');
  const css = cssAll();
  for (const live of ['col-row', 'col-expiry']) {
    assert.ok(new RegExp(`\\b${live}\\b`).test(css), `扫描器连在用的 ${live} 都找不到，说明它瞎了`);
  }
  const sources = [['全部模板', tplAll()], ...CSS_FILES.map((f) => [f, fs.readFileSync(path.join(STYLES_DIR, f), 'utf8')])];
  for (const [name, src] of sources) {
    const hits = banned.filter((c) => new RegExp(`\\b${c}\\b`).test(src));
    assert.deepStrictEqual(hits, [], `${name} 里还留着已删除的导航类名: ${hits.join(', ')}`);
  }
});

test('右键菜单三态与触摸档 44pt 必须在 CSS 里真声明（静态守机制）', () => {
  const css = cssAll();
  const coarse = mediaBlock(css, '(pointer: coarse)');
  assert.ok(coarse.length > 0, '一条 pointer:coarse 规则都没扫到，说明扫描器瞎了');
  // 44 现在住在 --tap 这一个 token 里：改 token 或删掉这条规则都要能红
  assert.match(css, /--tap:\s*44px/, 'tokens.css 里没有 --tap: 44px，44 这个数失去了唯一来源');
  assert.match(coarse, /\.menu-item \{[^}]*min-height:\s*var\(--tap\)/, '触摸档没给菜单项 44pt 目标');
  // 三态原来写在 `.context-menu .menu-item` 下；新 Shell 里 .menu-item 只属于右键菜单
  // （移动端底表用的是 .sheet-item），所以前缀去掉了。判据跟着认生效的那一句，并要求它真改了底色，
  // 再补一条模板腿：CSS 点名的类必须在 ContextMenu.vue 里真存在，否则三态规则是写给空气的。
  const menuTpl = tpl('ContextMenu.vue');
  assert.match(menuTpl, /class="context-menu"/, 'ContextMenu.vue 不再有 .context-menu 容器');
  assert.match(menuTpl, /class="menu-item"/, 'ContextMenu.vue 的条目不再用 .menu-item，下面的三态规则会落空');
  assert.match(css, /\.menu-item:hover:not\(:disabled\)[^{]*\{[^}]*background:/, '右键菜单项没有 hover 规则');
  assert.match(css, /\.menu-item:active:not\(:disabled\)[^{]*\{[^}]*background:/, '右键菜单项没有按下态');
  assert.match(css, /\.menu-item:disabled[^{]*\{[^}]*opacity:/, '右键菜单项没有禁用态');
});

test('只有一套暗色：不许再出现按系统主题切换的第二套色值', () => {
  const tokens = fs.readFileSync(path.join(STYLES_DIR, 'tokens.css'), 'utf8');
  assert.match(tokens, /color-scheme:\s*dark/, 'tokens.css 没声明 color-scheme: dark（原生控件/滚动条会退回浅色）');
  assert.doesNotMatch(tokens, /prefers-color-scheme/, 'tokens.css 又长出 prefers-color-scheme 了：本产品只有一套暗色，不要第二套');
  // 扫描器先自证看得见：随机挑一个在用的 token，扫不到就说明它瞎了
  assert.match(tokens, /--ink-2:/, '扫描器连 --ink-2 都找不到');
  // 坐字的蓝色/红色底必须用字色 token —— 写死 #fff 在亮蓝/亮红底上分别只有 3.47 / 2.75
  const css = cssAll();
  const hardWhite = css
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*color:\s*#fff(fff)?\s*;/.test(line));
  assert.deepStrictEqual(hardWhite.map(([n]) => n), [], `这些行还在把字色写死成 #fff：${JSON.stringify(hardWhite)}`);
  assert.match(css, /\.btn-danger\s*\{[^}]*color:\s*var\(--on-danger\)/, '.btn-danger 没有用 --on-danger 坐字');
  assert.match(tokens, /--on-danger:\s*#[0-9a-f]{6}/i, 'tokens.css 里没有 --on-danger');
});

test('file-move 端点一旦被界面调用，台面就必须有真浏览器拖拽判据（防"后端有、界面悄悄上"）', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'App.vue'), 'utf8');
  const lab = fs.readFileSync(path.join(__dirname, '..', 'test', 'lab', 'library-smoke.js'), 'utf8');
  const uiCalls = /api\.moveFile\(/.test(app);
  const hasJudge = /dragTo\(/.test(lab);
  assert.strictEqual(uiCalls && !hasJudge, false,
    `界面已在调用 file-move（uiCalls=${uiCalls}）但台面无拖拽判据（hasJudge=${hasJudge}）——要么补判据，要么别接`);
});

test('拖拽落点读目录 id、行身份读命名空间键：这两颗属性不许合回一个', () => {
  // 实测事故：行身份 data-dnd-id 是 folder:<id>，落点当年读的就是这一颗，
  // 于是发给 /api/batches/x/file-move 的 to 变成 "folder:f_xxx"，服务端只能回「目标目录不存在」——
  // 而落点高亮照样亮，看上去一切正常，只有真拖一次才暴露。
  const dndCode = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'lib', 'dnd.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, ''); // 注释里提到这颗属性名是为了记住教训，不该把门判红
  assert.match(tpl('RowItem.vue'), /data-dnd-folder="[^"]*item\.id/,
    'RowItem.vue 的目录行不再输出裸目录 id（data-dnd-folder）——落点没有能发给 API 的值了');
  assert.match(dndCode, /dataset\.dndFolder/, 'dnd.js 的落点没有读 data-dnd-folder');
  assert.doesNotMatch(dndCode, /toFolderId\s*=[^;]*dataset\.dndId/,
    'dnd.js 又把行身份键（folder:<id>）当成落点目录发给了 API');
});

test('到期状态类不许复用元素名：CSS 里任何 display:none 的规则都不能点到它', async () => {
  // 事故口径：状态类曾返回裸 'expiry'，被旧表格的窄屏规则 .file-row > .expiry 命中，
  // 第三行（倒计时）在手机上去掉——文字判据抓不到，只有量渲染几何才看得见。
  const css = cssAll();
  const hiddenIn = (src) => [...src.matchAll(/([^{}]+)\{[^{}]*display:\s*none[^{}]*\}/g)].map((m) => m[1]);
  // 正对照：扫描器必须看得见「隐藏规则点名 expiry」这个形状 —— 否则 0 命中只是它瞎了
  const probe = hiddenIn('.a > .expiry { display: none; }');
  assert.strictEqual(probe.length, 1, '扫描器看不见 display:none 规则，这条判据是空的');
  assert.ok(/expiry/.test(probe[0]), '扫描器抓到的选择器里没有 expiry');
  const hits = hiddenIn(css).filter((sel) => /expiry/i.test(sel));
  assert.deepStrictEqual(hits, [], `有隐藏规则点名 expiry 类，状态类会再被布局吃掉:\n${hits.join('\n')}`);
});

test('手机档守机制：界面层不许钉顶、卡片要有高度地板、44 是命中区不是画出来的框', () => {
  const css = cssAll();
  // 断点从 560 抬到 700（手机换成单层列表），判据跟着认这条新的
  const mobile = mediaBlock(css, '(max-width: 700px)');
  assert.ok(mobile.length > 0, '一条 max-width:700 规则都没扫到，说明扫描器瞎了');
  assert.ok(mobile.includes('position: static'),
    '手机档没让顶栏随页面滚走：sticky 会把 3～4 行界面层永久压在浏览区头上');
  // 高度地板现在由 clamp(地板, 目标, 天花板) 表达：认第一个参数，别认写死的 280。
  // 桌面与平板各写了一条 .columns，两条都是"别让卡片和别的东西抢同一屏"的承诺，
  // 所以取 min —— 之前取 max，把平板那条砍到 100px 也不会红。
  const floors = [...css.matchAll(/\.columns\s*\{[^}]*height:\s*clamp\(\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(floors.length >= 2, `只扫到 ${floors.length} 条 .columns 高度地板，桌面和平板应各一条`);
  assert.ok(Math.min(...floors) >= 280,
    `分栏卡片的高度地板最低只有 ${Math.min(...floors)}px：让卡片和任务面板抢同一屏，实测会被挤到 62px、栏内行永久裁掉`);
  const coarse = mediaBlock(css, '(pointer: coarse)');
  // 两条命中区规则要各自点名：只写 /\.check-hit/ 的话，栏头那条会替行那条背锅（下刀试过，摘掉行那条仍绿）
  assert.match(coarse, /\.col-row \.check-hit\s*\{[^}]*width:\s*var\(--tap\)/, '触摸档目录行/文件行的勾选入口没有 44 命中区');
  assert.match(coarse, /\.col-tools \.check-hit\s*\{[^}]*width:\s*var\(--tap\)/, '触摸档栏头「全选本栏」没有 44 命中区');
  assert.match(coarse, /\.col-row \.col-check\s*\{[^}]*width:\s*20px/,
    '触摸档原生方框的尺寸变了：44 应该是命中区（外面那层 label），不是把复选框本身画成 44');
  // 原来数的是 3 处字面量（栏头全选 / 目录行 / 文件行）；目录行与文件行合成了同一个 RowItem，
  // 计数会凭空少 1。改成按"哪一格该有"各自点名：两颗分属两个文件，摘掉任一颗都必须红，
  // 谁也不能替谁背锅（原来那条靠计数，RowItem 里留一颗就能蒙过栏头那颗）。
  for (const [file, where] of [['RowItem.vue', '目录行/文件行'], ['ColumnBrowser.vue', '栏头「全选本栏」']]) {
    assert.match(tpl(file), /class="check-hit"[\s\S]{0,400}type="checkbox"/,
      `${file} 里 ${where} 的勾选入口没有 44 命中区包装层`);
  }
});

// ---- 吐文件的路由：必须有一句能生效的安全声明 ----
// 上传的文件名是客户端随便声明的（可以叫 evil.html），所以"把文件字节吐回去"的每一条路由
// 都得让浏览器**下载**而不是**当页面渲染**：Content-Disposition: attachment、application/octet-stream，
// 或 res.download()（express 自己会带 attachment）。少了这一句，就是同源存储型 XSS 的口子。
// 静态扫源码（真正的头验证在 pathgate 与 transfer 的行为测试里），注释先剥掉——
// 注释里写 attachment 不算声明。
// 标记只认"把字节写给响应"的五种写法：读盘拼装（pipeline(createReadStream, createWriteStream)）不算；
// res.write( / res.end( 是因为归档手写帧、没有 pipe；SSE 那条的 write 在 sseOpen() 里、不是文件字节，扫不到也不该扫。
function fileEgressRoutes(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const ROUTE = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  const marks = [];
  let m;
  while ((m = ROUTE.exec(code))) marks.push({ at: m.index, route: m[3] });
  // 块边界按"这条路由自己的那次调用"取：从 app.xxx( 的左括号起配对到右括号。
  // 之前按"切到下一条路由"取，最后一条路由会把文件末尾的 application/octet-stream 借来当自己的声明（假绿）。
  const callSpan = (openAt) => {
    let depth = 0;
    for (let i = openAt; i < code.length; i++) {
      const ch = code[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        for (i++; i < code.length && code[i] !== q; i++) if (code[i] === '\\') i++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (!depth) return { start: openAt, end: i + 1 }; }
    }
    return null;
  };
  const MARK = /\.pipe\(res\)|res\.download\(|res\.sendFile\(|res\.write\(|res\.end\(/;
  // text/event-stream 也算安全声明：SSE 只会被当成事件流读，浏览器不会把它渲染成页面
  const SAFE = /Content-Disposition|application\/octet-stream|text\/event-stream|res\.download\(/;
  const out = [];
  for (const mark of marks) {
    const open = code.indexOf('(', mark.at);
    const span = open === -1 ? null : callSpan(open);
    // 括号配对失败就按"没声明"记：仪器没法界定这条路由时必须失败，不能默默放行
    if (!span) { out.push({ route: mark.route, safe: false, bounded: false }); continue; }
    const block = code.slice(span.start, span.end);
    if (!MARK.test(block)) continue;
    out.push({ route: mark.route, safe: SAFE.test(block) });
  }
  // 处理函数被搬到 lib/ 里时（egress 就是这么搬的），按名扫函数体：const x = (req,res) => {...} / function x(req,res) {...}
  const braceSpan = (openAt) => {
    let depth = 0;
    for (let i = openAt; i < code.length; i++) {
      const ch = code[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        for (i++; i < code.length && code[i] !== q; i++) { if (code[i] === '\\') i++; }
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (!depth) return { start: openAt, end: i + 1 }; }
    }
    return null;
  };
  const FN = /(?:const\s+(\w+)\s*=\s*(?:async\s*)?|function\s+(\w+)\s*)\(\s*req\s*,\s*res\s*\)\s*(?:=>\s*)?\{/g;
  let fm;
  while ((fm = FN.exec(code))) {
    const name = fm[1] || fm[2];
    const open = fm.index + fm[0].length - 1;
    const span = braceSpan(open);
    if (!span) { out.push({ route: name, safe: false, bounded: false }); continue; }
    const block = code.slice(span.start, span.end);
    if (!MARK.test(block)) continue;
    out.push({ route: name, safe: SAFE.test(block) });
  }
  return out;
}
test('往外吐文件字节的路由必须声明 attachment 或 octet-stream（同源 XSS 的最后一道门）', () => {
  // 仪器自检：三条假源码必须给出预期答案，否则"0 条不安全"只是扫描器瞎了
  assert.deepStrictEqual(
    fileEgressRoutes("app.get('/api/leak', (req, res) => { res.setHeader('Content-Type', 'text/html'); fs.createReadStream(p).pipe(res); });"),
    [{ route: '/api/leak', safe: false }],
    '扫描器看不见"没有安全声明的吐文件路由"',
  );
  assert.deepStrictEqual(
    fileEgressRoutes("app.get('/api/ok', (req, res) => { res.setHeader('Content-Type', 'application/octet-stream'); fs.createReadStream(p).pipe(res); });"),
    [{ route: '/api/ok', safe: true }],
  );
  assert.deepStrictEqual(
    fileEgressRoutes("app.get('/api/c', (req, res) => { /* Content-Disposition: attachment */ fs.createReadStream(p).pipe(res); });"),
    [{ route: '/api/c', safe: false }],
    '注释里写 attachment 不算声明',
  );
  assert.deepStrictEqual(
    fileEgressRoutes("const leak = (req, res) => { res.end(Buffer.from('x')); };"),
    [{ route: 'leak', safe: false }],
    '扫描器看不见"搬到 lib/ 里的具名处理函数"',
  );

  const seen = [];
  for (const f of ['server.js', 'lib/egress.js', 'lib/transfer.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const it of fileEgressRoutes(src)) seen.push({ file: f, ...it });
  }
  // 下限 + 点名：这几处必须真的被扫到，少一条说明判据对它空着
  const must = [['lib/egress.js', 'download'], ['lib/egress.js', 'archive'], ['lib/transfer.js', '/api/xfer/seg']];
  for (const [file, name] of must) {
    assert.ok(seen.some((s) => s.file === file && s.route === name),
      `没扫到 ${file} 的 ${name}（只扫到 ${seen.map((s) => `${s.file}:${s.route}`).join(', ')}）`);
  }
  const unsafe = seen.filter((s) => !s.safe);
  assert.deepStrictEqual(unsafe, [], `这些路由会把文件字节吐出去却没有 attachment / octet-stream：\n${JSON.stringify(unsafe)}`);
});
