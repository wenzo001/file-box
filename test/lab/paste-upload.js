// 粘贴上传（不属于 npm test）：PC 上在页面空白处粘贴截图 / 复制的文件 → 直接传到当前目录。
// 用合成的 ClipboardEvent + DataTransfer 造剪贴板（真系统剪贴板在无头浏览器里拿不到）；
// 走的是页面真正读的那条路（event.clipboardData.files）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const LOG = (m) => console.log(`[paste-upload] ${m}`);

(async () => {
  const srv = await startServer();
  let browser = null;
  let page = null;
  const errs = [];
  try {
    const target = (await (await fetch(`${srv.base}/api/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '粘贴目录' }),
    })).json()).folder;
    browser = await chromium.launch({ executablePath: EXE, headless: true });
    page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.columns');
    await page.locator('.folder-row', { hasText: '粘贴目录' }).click();
    await page.waitForTimeout(400);

    const lib = async () => (await (await fetch(`${srv.base}/api/library`)).json());
    const tasks = () => page.locator('.task').count();
    const pasteFile = (name, bytes = 200 * 1024) => page.evaluate(([n, size]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(size)], n, { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [name, bytes]);
    const pasteText = () => page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '只是文字');
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    // 1) 在目录里粘贴一张图：立刻出现影子行，传完落到这个目录
    const before = await lib();
    await pasteFile('粘贴图片.png');
    await page.waitForSelector('.pending-row', { timeout: 15000 });
    const pendingText = await page.locator('.pending-row').first().innerText();
    assert.match(pendingText, /粘贴图片\.png/, `影子行不是刚粘贴的文件：${pendingText}`);
    assert.deepStrictEqual(
      await page.evaluate(() => [...document.querySelectorAll('.column')].map((c) => c.querySelectorAll('.pending-row').length)),
      [0, 1], '粘贴上传的影子行没落在当前目录那栏',
    );
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.file-row')];
      return rows.some((r) => r.textContent.includes('粘贴图片.png')) && !document.querySelector('.pending-row');
    }, null, { timeout: 30000 });
    const after = await lib();
    assert.strictEqual(after.batches.length, before.batches.length + 1, '粘贴后服务端没多出批次');
    const fresh = after.batches.find((b) => !before.batches.some((x) => x.name === b.name));
    assert.strictEqual(fresh.folderId, target._id, `粘贴上传落错了目录：${fresh.folderId} vs ${target._id}`);
    assert.ok(await page.locator('.file-row', { hasText: '粘贴图片.png' }).count(), '传完之后目录里没有这个文件');
    LOG('目录内粘贴：影子行 → 真实文件，落在当前目录');

    // 2) 纯文本粘贴：什么都不该发生
    const n0 = await tasks();
    const errs0 = errs.length;
    await pasteText();
    await page.waitForTimeout(600);
    assert.strictEqual(await tasks(), n0, '粘贴纯文本也发了上传');
    assert.strictEqual(await page.locator('.pending-row').count(), 0, '粘贴纯文本冒出了影子行');
    assert.strictEqual(errs.length, errs0, `粘贴纯文本把页面弄错了：\n${errs.slice(errs0).join('\n')}`);

    // 3) 在输入框里粘贴文件：不抢（用户是在往外框里贴内容）
    await page.locator('.search input, input[type=search], .search').first().click();
    await page.keyboard.type('x');
    const n1 = await tasks();
    await page.evaluate(() => {
      const input = document.querySelector('.search input') || document.querySelector('.search');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(1024)], '不该上传.png', { type: 'image/png' }));
      (input || document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);
    assert.strictEqual(await tasks(), n1, '在搜索框里粘贴文件也触发了上传');
    await page.locator('.search input, input[type=search], .search').first().fill('');
    await page.keyboard.press('Escape');

    // 4) 弹层开着时粘贴：不做后台动作
    await page.locator('[aria-label="新建文件夹"]').first().click();
    await page.waitForSelector('.dialog', { state: 'visible' });
    const n2 = await tasks();
    await pasteFile('弹层里.png', 1024);
    await page.waitForTimeout(600);
    assert.strictEqual(await tasks(), n2, '弹层开着时粘贴仍然后台上传了');
    await page.locator('.dialog .btn').first().click();
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });

    // 5) 没有选中目录（根 / 未分档）时粘贴：落到未分档
    await page.evaluate(() => { history.pushState(null, '', location.pathname); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForTimeout(600);
    assert.match(await page.locator('.crumb').innerText(), /全部文件\s*$/, `没回到根：${(await page.locator('.crumb').innerText()).trim()}`);
    const beforeNames = (await lib()).batches.map((b) => b.name);
    await pasteFile('未分档粘贴.png', 128 * 1024);
    // 等"这一发自己"完成：批次在收尾（正在合并）时就已出现在列表里，按"多了个批次"会读到归属没定的它
    await page.waitForFunction(() => [...document.querySelectorAll('.task')]
      .some((t) => /未分档粘贴\.png/.test(t.textContent) && /已完成/.test(t.textContent)), null, { timeout: 30000, polling: 500 });
    const after2 = await lib();
    const fresh2 = after2.batches.find((b) => !beforeNames.includes(b.name));
    assert.ok(fresh2, '根目录粘贴后服务端没多出批次');
    assert.strictEqual(fresh2.folderId, null, `没有选中目录时该落到未分档，实际 ${fresh2.folderId}`);
    LOG('根目录粘贴：落到未分档');

    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${real.join('\n')}`);
    LOG('通过：粘贴文件即上传（当前目录 / 未分档），文本与输入框内的粘贴不触发');
  } catch (err) {
    console.error('[paste-upload] 失败:', err.message);
    console.error('[paste-upload] 浏览器错误:', errs.length ? errs : 'none');
    console.error('[paste-upload] 任务行:', JSON.stringify(await page.locator('.task').allInnerTexts().catch(() => [])));
    console.error('[paste-upload] 目录里的行:', JSON.stringify(await page.locator('.col-row').allInnerTexts().catch(() => [])));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
  }
})().catch((err) => { console.error('[paste-upload] 失败:', err.message); process.exit(1); });
