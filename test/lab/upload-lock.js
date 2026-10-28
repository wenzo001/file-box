// 上传持锁（不属于 npm test）：手机上切后台时，持 Web Lock 的页面不会被冻结。
// 这里把 navigator.locks.request 换成记录器，验"上传期间真的持了锁、结束真的放了"。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const LOG = (m) => console.log(`[upload-lock] ${m}`);

(async () => {
  const srv = await startServer();
  const f = path.join(os.tmpdir(), `fb-lock-${Date.now()}.txt`);
  fs.writeFileSync(f, 'lock-content');
  let browser = null;
  try {
    browser = await chromium.launch({ executablePath: EXE, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    await ctx.addInitScript(() => {
      window.__locks = [];
      const locks = navigator.locks;
      if (!locks) return;
      locks.request = (name, opts, cb) => {
        const rec = { name, mode: (opts && opts.mode) || 'exclusive', state: 'held' };
        window.__locks.push(rec);
        const p = Promise.resolve(cb({ name, mode: rec.mode }));
        p.then(() => { rec.state = 'released'; }, () => { rec.state = 'released'; });
        return p;
      };
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.columns');
    await page.locator('input[type=file]').setInputFiles([f]);
    await page.waitForFunction(
      () => [...document.querySelectorAll('.task')].some((t) => /已完成/.test(t.textContent)),
      null, { timeout: 30000 },
    );
    // 结束之后读一次：锁必须已经放掉，不然会一直"占着"（真锁上就是永远不释放）
    const locks = await page.evaluate(() => window.__locks);
    LOG(`记录到的锁：${JSON.stringify(locks)}`);
    const mine = locks.filter((l) => l.name === 'filebox-upload');
    assert.strictEqual(mine.length >= 1, true, '上传期间没有申请 Web Lock');
    assert.strictEqual(mine[0].mode, 'shared', '同时开多个上传要能共存，锁应该是 shared');
    assert.strictEqual(mine[mine.length - 1].state, 'released', '上传结束后锁没释放');

    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${real.join('\n')}`);
    LOG('通过：上传持锁、结束释放');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
    fs.rmSync(f, { force: true });
  }
})().catch((err) => { console.error('[upload-lock] 失败:', err.message); process.exit(1); });
