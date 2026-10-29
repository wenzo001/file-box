// 移动端真触摸冒烟（不属于 npm test）：先 npm run build，再 node test/lab/mobile-smoke.js
// 判据全部打在渲染结果上：命中区 44pt、iOS 输入缩放、真实遮挡、够不着的裁切、列表在不在首屏、对比度、触摸能不能用。
// 2026-10 重构后手机档是单层列表（.mobile-browser + .mb-list），⋯ 走底部操作表，动作栏只在多选态出现。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const ALL_VPS = [{ w: 390, h: 844 }, { w: 360, h: 740 }, { w: 320, h: 568 }];
// MOBILE_VP=320 只跑一档（给变异测试省时间）；过滤后的绿不等于整条台面绿
const VPS = process.env.MOBILE_VP
  ? ALL_VPS.filter((v) => process.env.MOBILE_VP.split(',').map(Number).includes(v.w))
  : ALL_VPS;
if (!VPS.length) { console.error(`[mobile-smoke] MOBILE_VP=${process.env.MOBILE_VP} 没匹配到任何视口（可选 390/360/320），拒绝开跑`); process.exit(1); }
const tmp = (n) => path.join(os.tmpdir(), n);
const SHOT = (n) => path.join(os.tmpdir(), n);

// 在页面里跑的那段测量：命中区 / 缩放 / 遮挡 / 够不着的裁切 / 对比度 / 固定界面层高度
const MEASURE = () => {
  const parse = (s) => (/^color\(srgb/i.test(s)
    ? s.match(/[\d.]+/g).slice(0, 3).map((v) => Math.round(Number(v) * 255))
    : (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number));
  const alpha = (s) => ((s.match(/[\d.]+/g) || []).length > 3 ? Number(s.match(/[\d.]+/g)[3]) : 1);
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bgOf = (el) => {
    let acc = [255, 255, 255];
    for (let n = el; n; n = n.parentElement) {
      const b = getComputedStyle(n).backgroundColor;
      if (b === 'rgba(0, 0, 0, 0)' || b === 'transparent') continue;
      const a = alpha(b);
      acc = parse(b).map((c, i) => c * a + acc[i] * (1 - a));
      if (a >= 1) break;
    }
    return acc;
  };
  const ratio = (el) => {
    const l1 = lum(parse(getComputedStyle(el).color));
    const l2 = lum(bgOf(el));
    return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
  };
  const label = (el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).join('.')}`;
  // "看得见"的矩形要沿每一层可滚动祖先裁；不裁就会把半滚出的行误报成遮挡
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let { top, bottom, left, right } = r;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (!/auto|scroll|hidden|overlay/.test(cs.overflowX + cs.overflowY)) continue;
      const p = n.getBoundingClientRect();
      top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom);
      left = Math.max(left, p.left); right = Math.min(right, p.right);
    }
    return { top, bottom, left, right, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  };
  // 祖先 display:none 时自己的 computed display 还是 flex —— 必须看"有没有渲染出来的矩形"
  const shown = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && el.getClientRects().length > 0;
  };
  // 能滚到 ≠ 看得见：从里往外找第一个真把它裁住的祖先——那个祖先滚不动，才是永久够不着
  const canReveal = (n, axis) => {
    const cs = getComputedStyle(n);
    if (!/auto|scroll|overlay/.test(axis === 'y' ? cs.overflowY : cs.overflowX)) return false;
    return axis === 'y' ? n.scrollHeight > n.clientHeight + 1 : n.scrollWidth > n.clientWidth + 1;
  };
  const unreachable = [];
  for (const el of document.querySelectorAll('button, a, input, select, .col-row')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let clipY = true;
    let clipX = true;
    for (let n = el.parentElement; n && n !== document.documentElement && (clipY || clipX); n = n.parentElement) {
      const p = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      if (clipY && (r.bottom - p.bottom > 1 || p.top - r.top > 1)) {
        if (canReveal(n, 'y')) clipY = false;
        else if (/hidden|clip/.test(cs.overflowY)) { unreachable.push({ el: label(el), rect: [Math.round(r.top), Math.round(r.bottom)], by: label(n), axis: 'y' }); break; }
      }
      if (clipX && (r.right - p.right > 1 || p.left - r.left > 1)) {
        if (canReveal(n, 'x')) clipX = false;
        else if (/hidden|clip/.test(cs.overflowX)) { unreachable.push({ el: label(el), rect: [Math.round(r.left), Math.round(r.right)], by: label(n), axis: 'x' }); break; }
      }
    }
  }
  // 反过来的那种挤压：滚动容器自己的盒子被祖先切掉，里面的行再怎么滚也露不出来（320 档实测卡片只剩 61px）
  const cutScrollers = [];
  for (const n of document.querySelectorAll('.columns, .mobile-browser, .mb-list, .col-list, .search-panel, .tasks, .main, .tool-row')) {
    const r = n.getBoundingClientRect();
    if (!r.height || !shown(n)) continue;
    const v = visibleRect(n);
    if (r.height - v.h > 2) cutScrollers.push({ el: label(n), h: Math.round(r.height), visibleH: Math.round(v.h) });
  }

  // 固定底栏（.action-bar）会盖住首屏底部：页面还能滚 ⇒ 用户滚得出来，不算"被吃掉"；
  // 页面滚不动时它盖住什么就是真的够不着
  const barEl = document.querySelector('.action-bar');
  const barRect = barEl && getComputedStyle(barEl).display !== 'none' ? barEl.getBoundingClientRect() : null;
  const canScroll = document.documentElement.scrollHeight > innerHeight + 4;
  const small = [];
  const zoom = [];
  const covered = [];
  // 只有原生转发生效的包装层（label/button/a/summary）才算命中区的一部分；
  // 布局容器（整行、整条工具行）再高也不算，否则会把"点到别处没反应"当成能点。
  const forwards = (n) => ['LABEL', 'BUTTON', 'A', 'SUMMARY'].includes(n.tagName);
  for (const el of document.querySelectorAll('button, a, input, select, .col-row')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const rec = { el: label(el), text: (el.textContent || el.placeholder || el.title || '').trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height) };
    let hitW = r.width;
    let hitH = r.height;
    for (let n = el.parentElement; n && (hitW < 44 || hitH < 44); n = n.parentElement) {
      if (!forwards(n)) break;
      const pr = n.getBoundingClientRect();
      if (pr.width >= hitW && pr.height >= hitH && pr.height <= 80) { hitW = pr.width; hitH = pr.height; } else break;
    }
    if (hitW < 44 || hitH < 44) small.push({ ...rec, hitW: Math.round(hitW), hitH: Math.round(hitH) });
    const isText = el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'range'].includes(el.type));
    if (isText && parseFloat(cs.fontSize) < 16) zoom.push(rec);
    const v = visibleRect(el);
    const cx = Math.round(v.left + v.w / 2);
    const cy = Math.round(v.top + v.h / 2);
    if (v.w >= 24 && v.h >= 24 && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        const underBar = barRect && cy > barRect.top - 2 && canScroll;
        if (!underBar) covered.push({ ...rec, hit: label(hit) });
      }
    }
  }
  const contrast = {};
  for (const [role, sel] of [
    ['meta', '.col-meta'], ['expiry', '.col-expiry'], ['crumb', '.crumb-btn'],
    ['hint', '.config-hint'], ['placeholder', '.search input'], ['taskState', '.task-state'],
  ]) {
    const el = document.querySelector(sel);
    if (el && shown(el)) contrast[role] = ratio(el); // 收进底表的元素在页面上是隐藏的，别量它

  }
  // 手机档不再渲染分栏卡片：量"当前这一屏的浏览区"，两种壳（.columns / .mobile-browser）共用同一组读数
  const card = document.querySelector('.columns') || document.querySelector('.mobile-browser');
  const cols = card.getBoundingClientRect();
  const scope = document.querySelector('.mb-list') || document.querySelector('.column:last-child');
  const list = document.querySelector('.mb-list') || document.querySelector('.column:last-child .col-list');
  const rows = [...scope.querySelectorAll('.col-row')];
  // 「多选」这颗的标签必须和"当前这一层是不是全选了"说的是同一件事
  const head = document.querySelector('.mb-actions [aria-label="多选"], .mb-actions [aria-label="退出多选"]');
  // 固定界面层：顶栏 + 配置条（手机档配置条整块进底表，量到 0 才对）
  const bar = document.querySelector('.topbar').getBoundingClientRect();
  const strip = document.querySelector('.config-strip').getBoundingClientRect();
  const stickyTop = [...document.querySelectorAll('*')].filter((n) => {
    const cs = getComputedStyle(n);
    if (cs.position !== 'sticky' && cs.position !== 'fixed') return false;
    if (cs.pointerEvents === 'none') return false;
    const r = n.getBoundingClientRect();
    return r.top < 8 && r.height > 0 && r.width > innerWidth * 0.5;
  }).map((n) => `${label(n)}:${Math.round(n.getBoundingClientRect().height)}`);
  return {
    small, zoom, covered, unreachable, cutScrollers, contrast,
    hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // 手机档的列表跟着内容长（不再是固定高度的卡片），"卡片可用高度"那条承诺在这里不再是可量的东西；
    // 改量列表的顶边：被推到首屏外 = 这一屏打开时没有任何可浏览的行
    listTop: Math.round(list ? list.getBoundingClientRect().top : cols.top),
    colsH: Math.round(cols.height),
    // 不滚就能看到的那一段浏览区
    colsInView: Math.round(Math.max(0, Math.min(cols.bottom, innerHeight) - Math.max(cols.top, 0))),
    listH: list ? Math.round(list.getBoundingClientRect().height) : null,
    chromeH: Math.round(bar.height + strip.height),
    barH: barEl && getComputedStyle(barEl).display !== 'none' ? Math.round(barEl.getBoundingClientRect().height) : 0,
    mainPadBottom: Math.round(parseFloat(getComputedStyle(document.querySelector('.main')).paddingBottom) || 0),
    stickyTop,
    headLabel: head ? head.getAttribute('aria-label') : null,
    rowsSel: rows.filter((r) => r.classList.contains('selected')).length,
    rowsPickable: rows.filter((r) => !r.classList.contains('pending-row')).length,
    rowsVisible: rows.filter((r) => { const v = visibleRect(r); return v.h >= 24 && v.w >= 24; }).length,
    rowCount: rows.length,
  };
};

(async () => {
  const srv = await startServer();
  const f = tmp('fb-mob-文件.txt');
  fs.writeFileSync(f, 'AAA-content');
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const problems = [];
  for (const vp of VPS) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
    const tag = `${vp.w}x${vp.h}`;
    let step = '打开首页';
    let stepSel = '.mobile-browser';
    // 按下态是 transform: scale(0.94) 且带 transition：不等补间收掉就量几何，
    // 读到的是"正在回弹"的那一帧（实测把 44pt 的键量成 43，报了一条假缺陷）。
    // 上限 800ms：页面里有无限循环的进度动画时不许把台面挂住。
    const settle = () => page.evaluate(async () => {
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, 800)),
      ]);
    });
    const tap = async (sel, name) => {
      step = name; stepSel = sel;
      await page.locator(sel).first().tap();
      await settle();
    };
    // 「多选」这颗的标签必须说的是"这一层是不是已经全选"，而不是"有没有选中过任何东西"：
    // 期望从现场读数推（这一层几行、选中几行），不写死顺序 —— 写死就会把产品说什么听成什么
    const headState = async () => {
      const s = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.mb-list .col-row')].filter((r) => !r.classList.contains('pending-row'));
        const head = document.querySelector('.mb-actions [aria-label="多选"], .mb-actions [aria-label="退出多选"]');
        return {
          label: head ? head.getAttribute('aria-label') : null,
          sel: rows.filter((r) => r.classList.contains('selected')).length,
          total: rows.length,
        };
      });
      const want = s.total > 0 && s.sel === s.total ? '退出多选' : '多选';
      assert.strictEqual(s.label, want,
        `${tag}: 头部写着「${s.label}」，但这一层是 ${s.sel}/${s.total} 选中（该写「${want}」）`);
      return s;
    };
    // 按当前标签按下这颗（标签自己就该说清它这一次做什么），点完再核对标签
    const tapHead = async (name) => {
      const s = await headState();
      await tap(`.mb-actions [aria-label="${s.label}"]`, name);
      return s;
    };
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.mobile-browser');
      // 手机档是单层列表：当前这一格里要同时有目录行和文件行，勾选与导航才各验得动 ⇒ 建两层再上传
      await tap('.mb-actions [aria-label="在此新建文件夹"]', '点新建文件夹');
      await page.waitForSelector('.dialog', { state: 'visible' });
      await page.locator('.dialog .input').fill(`手机目录-${vp.w}`);
      await tap('.dialog .btn-primary', '点确定建目录');
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });
      await tap(`.folder-row:has-text("手机目录-${vp.w}")`, '进入新目录');
      await page.waitForFunction((n) => document.querySelector('.mb-title b')?.textContent === n, `手机目录-${vp.w}`);
      await tap('.mb-actions [aria-label="在此新建文件夹"]', '在新目录里再建一层');
      await page.waitForSelector('.dialog', { state: 'visible' });
      await page.locator('.dialog .input').fill(`子目录-${vp.w}`);
      await tap('.dialog .btn-primary', '点确定建子目录');
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });
      await page.locator('input[type=file]').setInputFiles([f]);
      await page.waitForFunction(() => document.querySelectorAll('.mb-list .file-row').length >= 1, { timeout: 30000 });
      await page.waitForTimeout(500);

      const m = await page.evaluate(MEASURE);
      console.log(`[${tag}]`, JSON.stringify(m));
      if (m.hOverflow > 0) problems.push(`${tag}: 页面横向溢出 ${m.hOverflow}px`);
      // 手机档的列表高度跟着内容长，不再量"卡片有没有被压扁"；量它从哪开始：
      // 顶边出了首屏 = 这一屏打开时一行都看不见
      if (m.listTop > vp.h) problems.push(`${tag}: 列表顶边在 ${m.listTop}px，首屏（${vp.h}px）里没有任何可浏览的行；固定界面层=${m.chromeH}px`);
      if (m.cutScrollers.length) problems.push(`${tag}: 滚动容器自己被祖先切掉，里面的行再怎么滚也露不出来 → ${JSON.stringify(m.cutScrollers)}`);
      if (m.stickyTop.length) problems.push(`${tag}: 手机上还有钉在顶上的界面层，浏览区永久少一层 → ${JSON.stringify(m.stickyTop)}`);
      if (m.rowsVisible < 1) problems.push(`${tag}: 当前目录 ${m.rowCount} 行里没有一行看得见`);
      if (m.unreachable.length) problems.push(`${tag}: ${m.unreachable.length} 个控件被滚不动的祖先裁掉、永远够不着 → ${JSON.stringify(m.unreachable)}`);
      if (m.small.length) problems.push(`${tag}: ${m.small.length} 个控件命中区不足 44pt → ${JSON.stringify(m.small)}`);
      if (m.zoom.length) problems.push(`${tag}: ${m.zoom.length} 个文本输入 <16px，iOS 聚焦会放大整页 → ${JSON.stringify(m.zoom)}`);
      if (m.covered.length) problems.push(`${tag}: ${m.covered.length} 个控件中心被别的元素吃掉 → ${JSON.stringify(m.covered)}`);
      if (m.barH && m.mainPadBottom < m.barH + 8) {
        problems.push(`${tag}: 正文底部只留了 ${m.mainPadBottom}px，动作栏高 ${m.barH}px —— 最后一屏会压在栏下面`);
      }
      for (const [role, v] of Object.entries(m.contrast)) {
        if (v < 4.5) problems.push(`${tag}: 「${role}」对比度 ${v}:1 < 4.5:1`);
      }

      // 触摸真的能用：先进多选（非多选态勾选区是 visibility:hidden，量不到也算不得命中区）。
      // 「多选」这颗是"全选可见"：进去之后每项都已勾上，所以边缘那一下的期望是先勾消、再勾上。
      await tapHead('进多选（全选这一层）');
      const sel = await page.evaluate(MEASURE);
      if (sel.small.length) problems.push(`${tag}: 多选态下 ${sel.small.length} 个控件命中区不足 44pt → ${JSON.stringify(sel.small)}`);
      const checkSel = '.mb-list .file-row .col-check';
      // 命中区是外面那层 label：点它边缘（方框之外）也要算数，且只能翻一次
      // （label 把点击转发给 input，行本身的 @click 被这一层 .stop 挡掉——少一层就会翻两次）
      await page.locator('.mb-list .file-row .check-hit').first().tap({ position: { x: 2, y: 22 } });
      assert.strictEqual(await page.locator(checkSel).first().isChecked(), false, `${tag}: 点命中区边缘没勾消`);
      await page.locator('.mb-list .file-row .check-hit').first().tap({ position: { x: 2, y: 22 } });
      assert.strictEqual(await page.locator(checkSel).first().isChecked(), true,
        `${tag}: 再点一次没勾上（一次边缘点只该翻一次）`);
      // 目录行的勾选区不许顺手把目录打开：点边缘只该改勾选
      const titleBefore = (await page.locator('.mb-title b').innerText()).trim();
      await page.locator('.folder-row .check-hit').first().tap({ position: { x: 2, y: 22 } });
      assert.strictEqual((await page.locator('.mb-title b').innerText()).trim(), titleBefore,
        `${tag}: 点目录行的勾选区把目录打开了（label 没挡住冒泡到行的 @click）`);
      assert.strictEqual(await page.locator('.folder-row .col-check').first().isChecked(), false,
        `${tag}: 点目录行的勾选区没改勾选`);
      // 手机档的 ⋯ 走底部操作表，不是桌面的右键菜单：条目要 ≥44 且能关得掉
      await tap('.mb-list .file-row .col-more', '点文件行的 ⋯');
      await page.waitForSelector('.sheet-item');
      const itemH = await page.locator('.sheet-item').first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
      assert.ok(itemH >= 44, `${tag}: 操作表条目只有 ${itemH}px，触摸档要 ≥44`);
      await page.locator('.dialog .btn').first().tap(); // 取消
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });
      // 关掉操作表不许把选中项或当前目录弄丢
      assert.strictEqual((await page.locator('.mb-title b').innerText()).trim(), titleBefore,
        `${tag}: 关闭操作表后目录被重置了`);
      let s = await headState();
      await tap(`.mb-actions [aria-label="${s.label}"]`, '点头部多选键（补齐这一层的全选）');
      s = await headState();
      assert.strictEqual(s.label, '退出多选', `${tag}: 这一层 ${s.sel}/${s.total} 全选后头部还写着「${s.label}」`);
      await tap('.mb-actions [aria-label="退出多选"]', '退出多选');
      assert.strictEqual(await page.locator('.action-bar').count(), 0, `${tag}: 退出多选后底部动作栏没收`);
      await headState();

      // 确认词没填就点，报错但不许删（红底被 hover 换掉那条腿在触摸档复现不了，见 library-smoke）
      const beforeWipe = await (await fetch(`${srv.base}/api/library`)).json();
      // 手机档：配置条整块收进「设置」底表，清空入口也跟着搬进去
      await tap('[aria-label="设置"]', '打开设置底表');
      await page.waitForSelector('.dialog', { state: 'visible' });
      assert.strictEqual(await page.locator('.config-strip').isVisible(), false, '手机档不该再显示顶部配置条');
      const sheetHint = await page.locator('.dialog .config-hint').evaluate((el) => {
        const cs = getComputedStyle(el);
        const rgb = (str) => (str.match(/[\d.]+/g) || []).map(Number).slice(0, 3);
        const lum = (c) => c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; })
          .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
        let acc = [255, 255, 255];
        for (let n = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          const nums = (bg.match(/[\d.]+/g) || []).map(Number);
          if (!nums.length || (nums.length === 4 && nums[3] === 0)) continue;
          const a = nums.length === 4 ? nums[3] : 1;
          acc = nums.slice(0, 3).map((v, i) => v * a + acc[i] * (1 - a));
          if (a >= 1) break;
        }
        const fg = lum(rgb(cs.color));
        const bgc = lum(acc);
        return Number(((Math.max(fg, bgc) + 0.05) / (Math.min(fg, bgc) + 0.05)).toFixed(2));
      });
      assert.ok(sheetHint >= 4.5, `设置底表里的说明对比度只有 ${sheetHint}:1`);
      assert.strictEqual(await page.locator('.dialog .ttl-global').count(), 1, '设置底表里没有自动删除时长');
      await page.locator('.dialog .danger-text').tap(); // 清空所有文件…
      await page.waitForSelector('.dialog .dialog-error', { timeout: 1 }).catch(() => {});
      await page.waitForSelector('.dialog .input', { state: 'visible' });
      await page.locator('.dialog .btn-danger').tap(); // 空确认词：报错，但不许删
      await page.waitForSelector('.dialog .dialog-error');
      // 触摸档没有 hover（(hover:hover) 不成立），所以"红底被 hover 换掉"那条腿在 library-smoke 里验
      const afterTry = await (await fetch(`${srv.base}/api/library`)).json();
      assert.strictEqual(afterTry.batches.length, beforeWipe.batches.length, `${tag}: 确认词没填就把文件删了`);
      await page.locator('.dialog .btn').first().tap(); // 取消
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });

      // 底部动作栏：手机档设计决定是"只在多选时出现"（常驻会长期吃掉一屏的底），
      // 所以两头都要验：进多选它得在且每颗 ≥44，退出多选它得真的收起
      await tapHead('进多选（全选这一层）');
      const bar = page.locator('.action-bar');
      await bar.waitFor({ state: 'visible', timeout: 8000 });
      const barBoxes = await bar.locator('.linkbtn').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return Math.round(Math.min(r.width, r.height));
      }));
      assert.ok(barBoxes.length >= 5, `动作栏只有 ${barBoxes.length} 颗按钮，全选/链接/打包/删除/取消该都在`);
      assert.ok(barBoxes.every((n) => n >= 44), `动作栏里有按钮小于 44：${JSON.stringify(barBoxes)}`);
      // 「多选」那颗是全选可见 ⇒ 动作栏该报出这么多项，且没有一颗因为"没选中"而按不动
      assert.strictEqual(await bar.locator('.action-count').innerText(), `已选 ${sel.rowsPickable} 项`,
        '动作栏的选中数量和「全选这一层」对不上');
      assert.deepStrictEqual(await bar.locator('.linkbtn').evaluateAll((els) => els.map((el) => el.disabled)),
        barBoxes.map(() => false), '全选后仍有动作按不动');
      await bar.locator('[aria-label="取消选择"]').tap();
      await page.waitForSelector('.action-bar', { state: 'detached', timeout: 8000 });
      // 退出多选后回到"点行=进目录/开操作表"：勾选区要重新藏起来
      assert.strictEqual(await page.locator('.mb-list .check-hit').first().evaluate((el) => getComputedStyle(el).visibility), 'hidden',
        '退出多选后勾选框还露在外面');

      assert.deepStrictEqual(errs, [], `${tag}: 浏览器报错\n${errs.join('\n')}`);
      await page.screenshot({ path: SHOT(`fb-mob-${tag}.png`) });
    } catch (err) {
      // 超时不算读数：把 Playwright 的等待日志、当前步骤和现场几何一起倒出来
      const diag = await page.evaluate((sel) => {
        const box = (n) => `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ').filter(Boolean).join('.')} ${JSON.stringify(n.getBoundingClientRect().toJSON())}`;
        let el = null;
        try { el = document.querySelector(sel); } catch { return { sel, note: 'selector not DOM-parseable (Playwright pseudo)' }; }
        if (!el) return { sel, found: 0, rows: document.querySelectorAll('.file-row').length, lists: document.querySelectorAll('.mb-list, .column').length };
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return { sel, rect: r.toJSON(), centerHit: at ? box(at) : 'null', innerH: innerHeight, scroller: box(document.querySelector('.main')) };
      }, stepSel).catch((e) => `diag failed: ${e.message}`);
      problems.push([
        `${tag}: 失败于「${step}」`,
        ...err.message.split('\n').slice(0, 18),
        `[diag] ${JSON.stringify(diag)}`,
      ].join('\n'));
      await page.screenshot({ path: SHOT(`fb-mob-${tag}-fail.png`) }).catch(() => {});
    } finally {
      await ctx.close();
    }
  }
  await browser.close();
  await srv.stop();
  fs.rmSync(f, { force: true });
  if (problems.length) {
    console.error('[mobile-smoke] 失败:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log(`[mobile-smoke] 通过：${VPS.map((v) => v.w).join(' / ')} 各档列表在首屏内、无够不着的裁切、44pt（含多选态）、无 iOS 缩放、无遮挡、对比度达标、多选↔动作栏可进可退`);
})().catch((err) => { console.error(err); process.exit(1); });
