// 删目录后的定位（不属于 npm test）：删掉当前所在的子目录，应当停在它的**上一级**，
// 分栏路径不重置回根；把上一级也删了才退回根。真 Chromium + 真服务。
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const LOG = (m) => console.log(`[delete-nav] ${m}`);

(async () => {
  const srv = await startServer();
  let browser = null;
  try {
    const mk = async (name, parentId = null) => {
      const r = await fetch(`${srv.base}/api/folders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      });
      const body = await r.json().catch(() => ({}));
      assert.strictEqual(r.status, 200, `建目录失败：${JSON.stringify(body)}`);
      return body.folder;
    };
    const a = await mk('导航甲');
    const b = await mk('导航乙', a._id);
    LOG(`建好 导航甲(${a._id.slice(0, 8)}) / 导航甲/导航乙(${b._id.slice(0, 8)})`);

    browser = await chromium.launch({ executablePath: EXE, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.columns');
    await page.locator('.col-row', { hasText: '导航甲' }).first().click();
    await page.locator('.col-row', { hasText: '导航乙' }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('.column').length === 3);
    assert.deepStrictEqual(await page.locator('.crumb-btn').allInnerTexts(), ['全部文件', '导航甲', '导航乙']);

    // 删掉当前所在的「导航乙」：应停在「导航甲」
    await page.locator('.column').last().locator('.col-head [aria-label="更多操作"]').click();
    await page.locator('.context-menu .menu-item', { hasText: '删除' }).first().click();
    await page.locator('.dialog .btn-danger').click();
    await page.waitForFunction(
      () => [...document.querySelectorAll('.crumb-btn')].map((n) => n.textContent.trim()).join('>') === '全部文件>导航甲',
      null, { timeout: 20000 },
    ).catch(async (e) => {
      LOG(`删 导航乙 后：crumb=${JSON.stringify(await page.locator('.crumb-btn').allInnerTexts())} · 栏数=${await page.locator('.column').count()} · 任务=${JSON.stringify(await page.locator('.task').allInnerTexts())}`);
      throw e;
    });
    const cols = await page.locator('.column').count();
    const current = (await page.locator('.col-row.current').allInnerTexts()).map((t) => t.split('\n')[0]);
    LOG(`删 导航乙 之后：crumb=${JSON.stringify(await page.locator('.crumb-btn').allInnerTexts())} · 栏数=${cols} · 选中行=${JSON.stringify(current)}`);
    assert.strictEqual(cols, 2, `应该停在上一级（根 + 导航甲 两栏），实际 ${cols} 栏`);
    assert.ok(current.some((t) => t.includes('导航甲')), '上一级那一行要带选中态');
    assert.strictEqual(await page.locator('.col-row', { hasText: '导航乙' }).count(), 0, '被删的目录不该还在');

    // 再把上一级也删掉：这时才退回根
    await page.locator('.col-row', { hasText: '导航甲' }).first().locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '删除' }).first().click();
    await page.locator('.dialog .btn-danger').click();
    await page.waitForFunction(() => document.querySelectorAll('.crumb-btn').length === 1, null, { timeout: 20000 });
    LOG(`删 导航甲 之后：crumb=${JSON.stringify(await page.locator('.crumb-btn').allInnerTexts())} · 栏数=${await page.locator('.column').count()}`);
    assert.strictEqual(await page.locator('.column').count(), 1);

    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${real.join('\n')}`);
    LOG('通过：删子目录停在上一级，删到根才回根');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
  }
})().catch((err) => { console.error('[delete-nav] 失败:', err.message); process.exit(1); });
