// 移动端真触摸冒烟（不属于 npm test）：先 npm run build，再 node test/lab/mobile-smoke.js
// 判据全部打在渲染结果上：命中区 44pt、iOS 输入缩放、真实遮挡、够不着的裁切、卡片可用高度、对比度、触摸能不能用。
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
  const shown = (el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) !== 0;
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
  for (const n of document.querySelectorAll('.columns, .col-list, .search-panel, .tasks, .main, .tool-row')) {
    const r = n.getBoundingClientRect();
    if (!r.height || !shown(n)) continue;
    const v = visibleRect(n);
    if (r.height - v.h > 2) cutScrollers.push({ el: label(n), h: Math.round(r.height), visibleH: Math.round(v.h) });
  }

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
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) covered.push({ ...rec, hit: label(hit) });
    }
  }
  const contrast = {};
  for (const [role, sel] of [
    ['meta', '.col-meta'], ['expiry', '.col-expiry'], ['crumb', '.crumb-btn'],
    ['hint', '.config-hint'], ['placeholder', '.search input'], ['taskState', '.task-state'],
  ]) {
    const el = document.querySelector(sel);
    if (el) contrast[role] = ratio(el);
  }
  const cols = document.querySelector('.columns').getBoundingClientRect();
  const list = document.querySelector('.column:last-child .col-list');
  // 固定界面层：顶栏 + 配置条在手机上原本要 3～4 行；一旦还 sticky，分栏永久少一层
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
    // 卡片只要还有一屏的三分之一可用就赢；把它压成一条缝，行就被 overflow-y:hidden 永久裁掉
    colsH: Math.round(cols.height),
    // 不滚就能看到的那一段分栏：这才是手机上真正的浏览区
    colsInView: Math.round(Math.max(0, Math.min(cols.bottom, innerHeight) - Math.max(cols.top, 0))),
    listH: list ? Math.round(list.getBoundingClientRect().height) : null,
    chromeH: Math.round(bar.height + strip.height),
    stickyTop,
    rowsVisible: [...document.querySelectorAll('.column:last-child .col-row')]
      .filter((r) => { const v = visibleRect(r); return v.h >= 24 && v.w >= 24; }).length,
    rowCount: document.querySelectorAll('.column:last-child .col-row').length,
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
    let stepSel = '.columns';
    const tap = async (sel, name) => { step = name; stepSel = sel; await page.locator(sel).first().tap(); };
    try {
      await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.columns');
      await tap('[aria-label="新建文件夹"]', '点新建文件夹');
      await page.waitForSelector('.dialog', { state: 'visible' });
      await page.locator('.dialog .input').fill(`手机目录-${vp.w}`);
      await tap('.dialog .btn-primary', '点确定建目录');
      await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });
      await tap(`.folder-row:has-text("手机目录-${vp.w}")`, '进入新目录');
      await page.waitForTimeout(400);
      await page.locator('input[type=file]').setInputFiles([f]);
      await page.waitForFunction(() => document.querySelectorAll('.column:last-child .file-row').length >= 1, { timeout: 30000 });
      await page.waitForTimeout(500);

      const m = await page.evaluate(MEASURE);
      console.log(`[${tag}]`, JSON.stringify(m));
      if (m.hOverflow > 0) problems.push(`${tag}: 页面横向溢出 ${m.hOverflow}px`);
      if (m.colsH < 260) problems.push(`${tag}: 分栏卡片只有 ${m.colsH}px 高，不足 260 —— 栏会被挤成一条缝`);
      if (m.listH !== null && m.listH < 120) problems.push(`${tag}: 当前栏的行区只有 ${m.listH}px 高`);
      if (m.cutScrollers.length) problems.push(`${tag}: 滚动容器自己被祖先切掉，里面的行再怎么滚也露不出来 → ${JSON.stringify(m.cutScrollers)}`);
      if (m.colsInView < vp.h * 0.4) problems.push(`${tag}: 不滚动时浏览区只有 ${m.colsInView}px（屏高 ${vp.h} 的 ${Math.round((m.colsInView / vp.h) * 100)}%），不足 40%；固定界面层=${m.chromeH}px`);
      if (m.stickyTop.length) problems.push(`${tag}: 手机上还有钉在顶上的界面层，分栏永久少一层 → ${JSON.stringify(m.stickyTop)}`);
      if (m.rowsVisible < 1) problems.push(`${tag}: 当前栏 ${m.rowCount} 行里没有一行看得见`);
      if (m.unreachable.length) problems.push(`${tag}: ${m.unreachable.length} 个控件被滚不动的祖先裁掉、永远够不着 → ${JSON.stringify(m.unreachable)}`);
      if (m.small.length) problems.push(`${tag}: ${m.small.length} 个控件命中区不足 44pt → ${JSON.stringify(m.small)}`);
      if (m.zoom.length) problems.push(`${tag}: ${m.zoom.length} 个文本输入 <16px，iOS 聚焦会放大整页 → ${JSON.stringify(m.zoom)}`);
      if (m.covered.length) problems.push(`${tag}: ${m.covered.length} 个控件中心被别的元素吃掉 → ${JSON.stringify(m.covered)}`);
      for (const [role, v] of Object.entries(m.contrast)) {
        if (v < 4.5) problems.push(`${tag}: 「${role}」对比度 ${v}:1 < 4.5:1`);
      }

      // 触摸真的能用：点复选框要能勾上，点 ⋯ 要能出菜单
      const checkSel = '.column:last-child .file-row .col-check';
      await tap(checkSel, '点文件行复选框');
      assert.strictEqual(await page.locator(checkSel).first().isChecked(), true, `${tag}: 触摸点复选框没勾上`);
      // 命中区是外面那层 label：点它边缘（22px 方框之外）也要勾上，且只能勾一次
      // （label 会把点击转发给 input，行本身的 @click 也会被这一层 .stop 挡掉——少一层就会翻两次）
      await page.locator('.column:last-child .file-row .check-hit').first().tap({ position: { x: 2, y: 22 } });
      assert.strictEqual(await page.locator(checkSel).first().isChecked(), false,
        `${tag}: 点命中区边缘没勾消（勾了两次说明 label 的转发和行本身的 @click 抢同一位）`);
      // 目录行的勾选区不许顺手把目录打开：点边缘只该改勾选
      const crumbBefore = (await page.locator('.crumb-btn.current').last().innerText()).trim();
      await page.locator('.folder-row .check-hit').first().tap({ position: { x: 2, y: 22 } });
      assert.strictEqual((await page.locator('.crumb-btn.current').last().innerText()).trim(), crumbBefore,
        `${tag}: 点目录行的勾选区把目录打开了（label 没挡住冒泡到行的 @click）`);
      assert.strictEqual(await page.locator('.folder-row .col-check').first().isChecked(), true,
        `${tag}: 点目录行的勾选区没勾上`);
      await tap('.column:last-child .file-row .col-more', '点文件行的 ⋯');
      await page.waitForSelector('.context-menu .menu-item');
      const itemH = await page.locator('.context-menu .menu-item').first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
      assert.ok(itemH >= 44, `${tag}: 菜单项只有 ${itemH}px，触摸档要 ≥44`);
      await page.keyboard.press('Escape');
      assert.deepStrictEqual(errs, [], `${tag}: 浏览器报错\n${errs.join('\n')}`);
      await page.screenshot({ path: SHOT(`fb-mob-${tag}.png`) });
    } catch (err) {
      // 超时不算读数：把 Playwright 的等待日志、当前步骤和现场几何一起倒出来
      const diag = await page.evaluate((sel) => {
        const box = (n) => `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ').filter(Boolean).join('.')} ${JSON.stringify(n.getBoundingClientRect().toJSON())}`;
        let el = null;
        try { el = document.querySelector(sel); } catch { return { sel, note: 'selector not DOM-parseable (Playwright pseudo)' }; }
        if (!el) return { sel, found: 0, rows: document.querySelectorAll('.file-row').length, cols: document.querySelectorAll('.column').length };
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
  console.log(`[mobile-smoke] 通过：${VPS.map((v) => v.w).join(' / ')} 各档卡片可用高度、无够不着的裁切、44pt、无 iOS 缩放、无遮挡、对比度达标`);
})().catch((err) => { console.error(err); process.exit(1); });
