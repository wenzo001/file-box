// UI 重构台架（不属于 npm test）：真 Chromium、真服务器、真上传。
// 判据全部打在**渲染后的几何与真实业务结果**上，不打在"代码里有没有这个类"。
// 每条都先问：这一条能不能 FAIL？能不能（见文件末尾的 selfcheck）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const OUT = process.env.AUDIT_OUT || path.join(os.tmpdir(), 'fb-ui-audit');

const DESKTOP = [[1024, 768], [1280, 800], [1440, 900], [1920, 1080]];
const NARROW = [[320, 640], [360, 640], [390, 844], [430, 932], [560, 800], [700, 900], [768, 1024]];
const TABLET = [[701, 900], [768, 1024]];

let fails = 0;
let checks = 0;
const notes = [];
function ok(cond, label, detail = '') {
  checks++;
  if (cond) { console.log(`PASS  ${label}${detail ? `  [${detail}]` : ''}`); return true; }
  fails++;
  console.log(`FAIL  ${label}  ${detail}`);
  return false;
}

async function newPage(browser, w, h, { touch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  page.__errs = errs;
  page.__ctx = ctx;
  return page;
}

// 横向溢出：量 document 的真实滚动宽度，不是某个元素的
async function overflowOf(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        offenders.push(`${el.className || el.tagName}#${el.id || ''}@${Math.round(r.left)}→${Math.round(r.right)}`);
      }
    }
    return { scrollW: de.scrollWidth, clientW: de.clientWidth, offenders: offenders.slice(0, 6) };
  });
}

/** 等这块元素的入场动画真的跑完再量 —— 补间中的 rect 读到的是位移，不是最终几何 */
async function settle(page, sel) {
  await page.waitForFunction((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    return el.getAnimations().length === 0;
  }, sel, { timeout: 8000 });
}

/** 名字格与标签的几何：标签不许被格子裁掉，也不许把文件名挤到读不出来（两棵壳都走 RowItem，量法共用） */
async function nameTagGeometry(page) {
  return page.evaluate(() => {
    const rows = [];
    for (const cell of document.querySelectorAll('.col-name')) {
      const tags = [...cell.querySelectorAll('.tag')].filter((t) => t.getBoundingClientRect().width > 0);
      if (!tags.length) continue;
      const box = cell.getBoundingClientRect();
      const name = cell.querySelector('.name-text').getBoundingClientRect();
      const last = tags[tags.length - 1].getBoundingClientRect();
      rows.push({
        name: cell.textContent.trim().slice(0, 10),
        nameW: Math.round(name.width),
        // 正数=标签右边界还在格子里；负数=已经被裁出去多少像素
        slack: Math.round(box.right - last.right),
        gap: Math.round(tags[0].left - name.right),
      });
    }
    return rows;
  });
}

/** 一条判据：logo 方块必须画出来，里面的图标必须落在方块正中（±1px）。
    曾经 `.brand span` 把方块一起命中：≤700 变 inline（图标掉到左上角，实测 dx/dy=-5），
    701–1023 直接 display:none（整个 logo 消失，0×0）。 */
async function brandMarkLeg(page, where) {
  const r = await page.evaluate(() => {
    const box = document.querySelector('.brand-mark');
    const svg = box && box.querySelector('svg');
    if (!box || !svg) return { missing: true };
    const b = box.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    return {
      w: Math.round(b.width), h: Math.round(b.height),
      dx: Math.abs(Math.round((s.left + s.width / 2) - (b.left + b.width / 2))),
      dy: Math.abs(Math.round((s.top + s.height / 2) - (b.top + b.height / 2))),
    };
  });
  ok(!r.missing && r.w >= 20 && r.h >= 20 && r.dx <= 1 && r.dy <= 1,
    `${where} logo 方块画得出来、图标居中`, r.missing ? '找不到 .brand-mark 或它的 svg' : `${r.w}×${r.h} · 偏移 ${r.dx}/${r.dy}px`);
}

/** 一条判据：带标签的行里，标签整颗留在名字格内，文件名自己还得留得读出一截 */
async function nameTagLeg(page, where) {
  const rows = await nameTagGeometry(page);
  const minName = rows.length ? Math.min(...rows.map((r) => r.nameW)) : -1;
  const minSlack = rows.length ? Math.min(...rows.map((r) => r.slack)) : -999;
  const detail = `${rows.length} 行带标签 · 最窄名字 ${minName}px · 标签最小余量 ${minSlack}px`;
  ok(rows.length > 0 && minSlack >= -1 && minName >= 20, `${where} 标签不被裁、文件名不被挤没`, detail);
}

/** 真实长按：CDP 派发 touchStart → 等待 → touchEnd，不走合成的 PointerEvent 猜测 */
async function realLongPress(page, sel, holdMs = 650) {
  const box = await page.locator(sel).first().boundingBox();
  const cdp = await page.__ctx.newCDPSession(page);
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  const t = [{ x: cx, y: cy, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: t });
  await new Promise((r) => setTimeout(r, holdMs));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** 触摸滚动：同样的起点长按路径移动 —— 用来证"滚动不会误进多选" */
async function realSwipeUp(page, sel, dy = 120) {
  const box = await page.locator(sel).first().boundingBox();
  const cdp = await page.__ctx.newCDPSession(page);
  const cx = Math.round(box.x + box.width / 2);
  const p = (y) => [{ x: cx, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(box.y + 20) });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(box.y + 20 - (dy * i) / 6) });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await startServer();
  const browser = await chromium.launch({ executablePath: EXE });
  const tmp = path.join(os.tmpdir(), '台架样本.txt');
  fs.writeFileSync(tmp, '文件盒子 UI 重构台架样本\n');
  // 另一份内容不同的样本：同一份文件重复上传会按指纹并回同一个批次，落不到第二个目录
  const tmpRoot = path.join(os.tmpdir(), '根层样本.txt');
  fs.writeFileSync(tmpRoot, '放在最外层的那一份\n');

  // ============================ 桌面：业务主路径 ============================
  {
    const page = await newPage(browser, 1440, 900);
    await page.goto(srv.base, { waitUntil: 'networkidle' });
    ok(page.__errs.length === 0, '桌面首屏无未捕获异常', page.__errs.join(' | '));

    ok(await page.locator('.columns .column').count() >= 1, '桌面渲染 Finder 分栏');
    ok(await page.locator('.mb-list').count() === 0, '桌面不渲染手机单层列表');

    // 最外层也放一份文件：没有归属目录的批次就排在这里（根这栏不再只有目录）。
    // 顺带给「标签几何」「方向键」两条腿留一个 2 行以上的现场。
    await page.setInputFiles('input[type=file]', tmpRoot);
    await page.waitForSelector('.file-row', { timeout: 30000 });
    await page.waitForSelector('.pending-row', { state: 'detached', timeout: 15000 }).catch(() => {});

    // 新建文件夹：走真实弹层 + 回车提交
    await page.locator('.col-icon[aria-label="在此新建文件夹"]').first().click();
    await page.waitForSelector('.dialog input');
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    ok(focused === 'INPUT', '弹层把焦点放在输入框（回车=主键的前提）', focused);
    await page.fill('.dialog input', '台架目录');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });
    const made = page.locator('.folder-row').filter({ hasText: '台架目录' });
    await made.first().waitFor({ state: 'visible', timeout: 8000 });
    ok(await made.count() === 1, '回车提交真的建出了目录', `${await made.count()} 行匹配「台架目录」`);

    // 进入目录
    await made.first().click();
    await page.waitForTimeout(400);
    ok((await page.locator('.crumb-btn.current').textContent()).trim() === '台架目录', '面包屑跟着当前目录走');

    // 真实上传：影子行必须出现，完成换成真实文件行
    await page.setInputFiles('input[type=file]', tmp);
    await page.waitForSelector('.pending-row', { timeout: 8000 });
    const track = await page.locator('.pending-row .pending-track').boundingBox();
    ok(track && track.width > 40 && track.height >= 2, '影子行画出了看得见进度条', track ? `${Math.round(track.width)}x${Math.round(track.height)}` : 'no box');
    // 等的是"台架目录这一栏"里的真文件行 —— 根上本来就有一条，等全局 .file-row 会立刻返回，
    // 于是下面那条"这一栏只剩它"读在文件名还没落定的那一帧上
    await page.locator('.column').last().locator('.file-row').first().waitFor({ timeout: 30000 });
    await page.waitForSelector('.pending-row', { state: 'detached', timeout: 15000 }).catch(() => {});
    const folderRows = await page.locator('.column').last().locator('.file-row').count();
    if (folderRows !== 1) {
      const dump = await page.evaluate(async () => {
        const l = await (await fetch('/api/library')).json();
        return {
          cols: [...document.querySelectorAll('.column')].map((c) => (c.querySelector('.col-title-text b')?.textContent || '') + ':' + c.querySelectorAll('.file-row').length),
          batches: l.batches.map((b) => `${b.name}@${b.folderId}`),
          folders: l.folders.map((f) => `${f.name}#${f.id}`),
        };
      });
      console.log('现场:', JSON.stringify(dump));
    }
    ok(folderRows === 1, '上传完成后影子行换成真实文件行（这一栏只剩它）',
      `这一栏 ${folderRows} 行 · 全页 ${await page.locator('.file-row').count()} 行 · 栏数 ${await page.locator('.column').count()}`);
    // 根上也有一份文件 ⇒ 下面三读都点名"刚上传的那一行"，不再全页找
    const uploadedRow = page.locator('.column').last().locator('.file-row').first();
    ok((await uploadedRow.locator('.col-size').textContent()).includes('B'), '文件行带出大小', (await uploadedRow.locator('.col-meta').textContent()).trim());
    const expiry = await uploadedRow.locator('.col-expiry').textContent();
    ok(/删除|手动删除/.test(expiry || ''), '文件行带出自动删除状态', (expiry || '').trim());

    // 任务中心：真实上传完成后必须有任务行，且状态措辞是真实状态
    ok(await page.locator('.tasks .task').count() >= 1, '任务中心出现真实任务行');
    ok((await page.locator('.task-state').first().textContent()).trim().length > 0, '任务行有状态文字');

    // 右键菜单 与 ⋯ 菜单 必须给出同一批业务动作
    await page.locator('.column').last().locator('.file-row').first().click({ button: 'right' });
    await page.waitForSelector('.context-menu');
    const viaRight = await page.locator('.context-menu .menu-item').allTextContents();
    await page.keyboard.press('Escape');
    const menuClosed = await page.locator('.context-menu').count();
    ok(menuClosed === 0, 'Escape 关掉了右键菜单', `剩余 ${menuClosed}`);
    await page.locator('.column').last().locator('.file-row .col-more').first().click();
    await page.waitForSelector('.context-menu');
    const viaDots = await page.locator('.context-menu .menu-item').allTextContents();
    ok(viaRight.join('|') === viaDots.join('|'), '右键菜单与「⋯」菜单动作一致', `${viaRight.length} 项`);

    // 菜单不许顶出屏幕：在视口右下角开
    await page.locator('.file-row').first().click({ button: 'right', position: { x: 5, y: 5 } });
    const rect = await page.locator('.context-menu').boundingBox();
    ok(rect && rect.x + rect.width <= 1440 && rect.y + rect.height <= 900, '菜单夹紧在视口内', rect ? `${Math.round(rect.x)}+${Math.round(rect.width)},${Math.round(rect.y)}+${Math.round(rect.height)}` : 'no box');
    await page.mouse.click(700, 500);

    // 键盘：Tab 进列表，方向键走行
    await page.evaluate(() => document.querySelector('.col-list')?.focus());
    const beforeFocus = await page.evaluate(() => document.activeElement?.className);
    await page.keyboard.press('ArrowDown');
    const afterFocus = await page.evaluate(() => document.activeElement?.className);
    ok(beforeFocus !== afterFocus, '方向键在列表行间移动焦点', `${beforeFocus} → ${afterFocus}`);

    // 搜索：真实匹配 + Escape 退回。这一发之前必须没有选中项 ——
    // Escape 是"一层层退"的（菜单→多选→搜索），叠了选中态就会先退多选，那才是要的行为。
    await page.fill('.search input', '台架');
    await page.waitForTimeout(600);
    ok(await page.locator('.search-panel').count() === 1, '搜索面板出现');
    ok(await page.locator('.result-row').count() >= 2, '搜索结果同时带出目录与文件', `${await page.locator('.result-row').count()} 条`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok(await page.locator('.search-panel').count() === 0, 'Escape 退出搜索回到分栏');

    // 多选：点行选中 + Ctrl+A 全选（全选的含义 = 当前可见的每一行，目录也算）
    await page.locator('.file-row').first().click();
    ok(await page.locator('.col-row.selected').count() === 1, '点文件行进入选中态');
    await page.keyboard.press('Control+a');
    const selectable = await page.locator('.col-row:not(.pending-row)').count();
    const chosen = await page.locator('.col-row.selected').count();
    ok(chosen === selectable, 'Ctrl+A 全选当前可见的每一行', `选中 ${chosen} / 可见 ${selectable}`);
    ok((await page.locator('.tool-count').textContent()).includes(String(chosen)), '工具行报出已选数量', (await page.locator('.tool-count').textContent()).trim());
    await page.keyboard.press('Escape');
    ok(await page.locator('.col-row.selected').count() === 0, 'Escape 退出多选');

    // 删除：危险操作必须有确认步骤，确认后才真删
    // 根上和台架目录里各有一份，删的是被选中那一行 ⇒ 断"少了一条"，不断"一条都不剩"
    const filesBefore = await page.locator('.file-row').count();
    // 删台架目录里的那一份：根上那份留着，后面的视口扫描要靠它的「热乎」标签
    await page.locator('.column').last().locator('.file-row').first().click();
    await page.locator('.tool-actions .linkbtn[aria-label="删除"]').click();
    await page.waitForSelector('.dialog');
    ok((await page.locator('.dialog .dialog-primary').textContent()).includes('删除'), '删除走确认弹层，主键写明「删除」');
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.file-row').length < n, filesBefore, { timeout: 12000 });
    const filesLeft = await page.locator('.file-row').count();
    ok(filesLeft === filesBefore - 1, '确认后文件真的被删除（只少了选中的那一条）', `${filesBefore} → ${filesLeft}`);

    ok(page.__errs.length === 0, '桌面主路径全程无异常', page.__errs.join(' | '));
    await page.screenshot({ path: path.join(OUT, 'desktop-1440.png'), fullPage: false });
    await page.__ctx.close();
  }

  // ============================ 桌面：断点几何 ============================
  for (const [w, h] of DESKTOP) {
    const page = await newPage(browser, w, h);
    await page.goto(srv.base, { waitUntil: 'networkidle' });
    const o = await overflowOf(page);
    ok(o.scrollW <= o.clientW + 1, `桌面 ${w} 无横向溢出`, `scrollW=${o.scrollW} clientW=${o.clientW} ${o.offenders.join(' / ')}`);
    const cols = await page.locator('.columns').count();
    ok(cols === 1, `桌面 ${w} 仍是分栏模型`, `${cols}`);
    await nameTagLeg(page, `桌面 ${w}`);
    await brandMarkLeg(page, `桌面 ${w}`);
    await page.screenshot({ path: path.join(OUT, `desktop-${w}.png`) });
    await page.__ctx.close();
  }

  // ============================ 手机 / 平板 ============================
  for (const [w, h] of [...NARROW, ...TABLET]) {
    const mobile = w <= 700;
    const page = await newPage(browser, w, h, { touch: mobile });
    await page.goto(srv.base, { waitUntil: 'networkidle' });
    const o = await overflowOf(page);
    ok(o.scrollW <= o.clientW + 1, `${w}x${h} 无横向溢出`, `scrollW=${o.scrollW} clientW=${o.clientW} ${o.offenders.slice(0, 3).join(' / ')}`);

    const list = await page.locator(mobile ? '.mb-list' : '.columns').count();
    ok(list === 1, `${w}x${h} 用${mobile ? '单层列表' : '分栏'}模型`);
    await nameTagLeg(page, `${w}x${h}`);
    await brandMarkLeg(page, `${w}x${h}`);

    if (mobile) {
      // 顶栏不许吃掉半屏：量它占的可视区比例
      const bar = await page.locator('.topbar').boundingBox();
      ok(bar && bar.height <= h * 0.3, `${w} 顶栏不超过三成屏`, `${Math.round(bar?.height || 0)}px / ${h}`);
      // 配置条必须收进设置底表，不再压在列表上方
      ok(await page.locator('.config-strip').count() === 0 || !(await page.locator('.config-strip').isVisible()),
        `${w} 配置条不在手机主屏上`);
      // 命中区：可见的图标按钮 ≥44
      const small = await page.evaluate(() => [...document.querySelectorAll('button, input, select')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          if (getComputedStyle(el).visibility === 'hidden') return false;
          // 勾选框的命中区由外面那层 label 承担，只量控件自己够不够 44 的邻居们
          return el.tagName !== 'INPUT' || el.type !== 'checkbox';
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { t: `${el.className}|${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 12)}`, w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((x) => x.h < 44 && !x.t.startsWith('col-check')));
      ok(small.length === 0, `${w} 可见控件命中区 ≥44`, small.slice(0, 4).map((x) => `${x.t}:${x.w}x${x.h}`).join(' / '));
    }
    await page.screenshot({ path: path.join(OUT, `view-${w}x${h}.png`) });
    await page.__ctx.close();
  }

  // ============================ 手机：触控交互路径 ============================
  {
    const page = await newPage(browser, 390, 844, { touch: true });
    await page.goto(srv.base, { waitUntil: 'networkidle' });

    // 进目录 → 返回
    const folderName = (await page.locator('.folder-row .name-text').first().textContent()).trim();
    await page.locator('.folder-row').first().tap();
    await page.waitForTimeout(500);
    ok((await page.locator('.mb-title b').textContent()).trim() === folderName, '手机点目录=进入该目录', (await page.locator('.mb-title b').textContent()).trim());
    ok(await page.locator('.mb-back').count() === 1, '进入后出现返回键');
    await page.locator('.mb-back').tap();
    await page.waitForTimeout(500);
    ok((await page.locator('.mb-title b').textContent()).trim() === '全部文件', '返回键回到上一层');

    // 根这一层现在也列文件（没有归属目录的批次），但上传落点要验的是"目标目录对不对"，所以照样先进一层
    await page.locator('.folder-row').first().tap();
    await page.waitForTimeout(500);
    await page.setInputFiles('input[type=file]', tmp);
    await page.waitForSelector('.file-row', { timeout: 30000 });
    await realLongPress(page, '.file-row');
    await page.waitForTimeout(400);
    ok(await page.locator('.col-row.selected').count() === 1, '长按文件行进入多选并选中该行', `${await page.locator('.col-row.selected').count()}`);
    ok(await page.locator('.action-bar').isVisible(), '多选后底部动作栏出现');
    ok((await page.locator('.action-bar .action-count').textContent()).includes('1'), '动作栏报出已选数量', (await page.locator('.action-bar .action-count').textContent()).trim());
    // 动作栏不许盖住最后一行
    const covered = await page.evaluate(() => {
      const bar = document.querySelector('.action-bar')?.getBoundingClientRect();
      if (!bar) return -1;
      const rows = [...document.querySelectorAll('.col-row')].map((r) => r.getBoundingClientRect());
      const hit = rows.filter((r) => r.bottom > bar.top && r.top < bar.bottom);
      return hit.length;
    });
    ok(covered === 0, '底部动作栏没有遮住列表行', `被盖 ${covered} 行`);

    // 短按文件行 = 开操作表，不是选中（两条手势不许抢同一件事）
    await page.locator('.action-bar .linkbtn[aria-label="取消选择"]').tap();
    await page.waitForTimeout(300);
    await page.locator('.file-row').first().tap();
    await page.waitForSelector('.sheet-item', { timeout: 4000 });
    const sheetLabels = (await page.locator('.sheet-item').allTextContents()).map((s) => s.trim());
    ok(sheetLabels.includes('下载') && sheetLabels.includes('删除文件'), '点文件行给出操作表且业务齐全', sheetLabels.join('|'));
    await page.locator('.dialog .btn:not(.dialog-primary)').last().tap();
    await page.waitForTimeout(400);
    ok(await page.locator('.sheet-item').count() === 0, '操作表能关掉');
    ok(await page.locator('.col-row.selected').count() === 0, '关掉操作表没有顺手改掉选中态');

    // 滚动不许误进多选
    await realSwipeUp(page, '.mb-list');
    await page.waitForTimeout(700);
    ok(await page.locator('.action-bar').count() === 0, '滚动列表不会误触多选', `选中 ${await page.locator('.col-row.selected').count()}`);

    // 软键盘：抽屉里的输入框被键盘盖住时整块要抬起来
    await page.locator('.toolbar-actions .btn.settings-entry').tap();
    await page.waitForSelector('.dialog.sheet');
    await settle(page, '.dialog.sheet');
    const sheetBox = await page.locator('.dialog.sheet').boundingBox();
    ok(sheetBox && sheetBox.y >= 0 && sheetBox.y + sheetBox.height <= 844 + 1, '设置底表完整在屏内', sheetBox ? `${Math.round(sheetBox.y)}+${Math.round(sheetBox.height)}` : 'no box');
    await page.evaluate(() => document.documentElement.style.setProperty('--kb-inset', '300px'));
    await page.waitForTimeout(150);
    // 量的是"那颗键还够不够得着"，不是抽屉外框 —— 外框贴住屏幕底边是对的，
    // 键盘盖住的那一段由底表自己的 padding 让出来。
    const liftBtn = await page.locator('.dialog.sheet .dialog-actions .btn').last().boundingBox();
    ok(liftBtn && liftBtn.y + liftBtn.height <= 844 - 300 + 12, '软键盘抬起时主键跟着抬到键盘上方', liftBtn ? `${Math.round(liftBtn.y)}+${Math.round(liftBtn.height)}` : 'no box');
    await page.evaluate(() => document.documentElement.style.setProperty('--kb-inset', '0px'));
    // 设置底表里必须还留着清空入口（原来那条配置条收进来了，不能丢功能）
    ok((await page.locator('.dialog.sheet').textContent()).includes('清空所有文件'), '设置底表保留了清空入口');
    await page.locator('.dialog.sheet .btn-primary').tap();
    await page.waitForTimeout(400);
    ok(await page.locator('.dialog.sheet').count() === 0, '设置底表可关闭');

    // 无痕传输与任务入口都在
    ok(await page.locator('.toolbar-actions a.btn[href*="transfer"]').count() === 1, '手机保留无痕传输入口');
    await page.locator('.toolbar-actions .icon-btn[aria-label="任务中心"]').tap();
    await page.waitForSelector('.dialog.task-drawer', { timeout: 4000 });
    ok(await page.locator('.dialog.task-drawer .task').count() >= 1, '手机任务抽屉里有真实任务');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    ok(await page.locator('.dialog.task-drawer').count() === 0, '任务抽屉能关掉');

    ok(page.__errs.length === 0, '手机路径全程无异常', page.__errs.join(' | '));
    await page.screenshot({ path: path.join(OUT, 'mobile-390.png') });
    await page.__ctx.close();
  }

  console.log(`\n== 台架读数：checks=${checks} fails=${fails} 截图在 ${OUT} ==`);
  await browser.close();
  await srv.stop();
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error('台架自己崩了：', err); process.exit(2); });
