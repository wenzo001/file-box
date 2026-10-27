// 新目录界面的真浏览器冒烟（不属于 npm test）。
// 先 npm run build，再 node test/lab/library-smoke.js；默认打开 dist-web/next。
// 判据打在渲染结果上：目录创建、上传后 TTL、下载字节、重命名、搜索、删除、移动端列宽。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const SHOT = (name) => path.join(os.tmpdir(), name);

(async () => {
  const srv = await startServer();
  const uploadFile = path.join(os.tmpdir(), 'fb-library-smoke.txt');
  fs.writeFileSync(uploadFile, 'hello from library smoke');
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

  try {
    await page.goto(`${srv.base}/next/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.topbar');

    // 建目录并进入
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.locator('.dialog .input').fill('冒烟目录');
    await page.locator('.dialog .btn-primary').click();
    const folderRow = page.locator('.folder-row', { hasText: '冒烟目录' });
    await folderRow.waitFor({ timeout: 10000 });
    await folderRow.locator('.folder-main').click();
    await page.waitForTimeout(200);

    // 上传：默认 1 小时；文件行必须显示到期，且不能写成 2 小时
    await page.locator('input[type=file]').setInputFiles(uploadFile);
    await page.waitForSelector('.file-row .name', { timeout: 30000 });
    const firstName = await page.locator('.file-row .name').first().innerText();
    assert.strictEqual(firstName, 'fb-library-smoke.txt');
    const expiry = await page.locator('.file-row .expiry').first().innerText();
    assert.match(expiry, /(1 小时|60 分钟)/, `默认 TTL 显示不对: ${expiry}`);
    assert.doesNotMatch(expiry, /2 小时/, `默认 1 小时被取整成 2 小时: ${expiry}`);
    await page.screenshot({ path: SHOT('fb-library-desktop.png'), fullPage: true });

    // 下载字节
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('.file-row .linkbtn').first().click(),
    ]);
    const downloaded = await download.path();
    assert.strictEqual(download.suggestedFilename(), 'fb-library-smoke.txt');
    assert.strictEqual(fs.readFileSync(downloaded, 'utf8'), 'hello from library smoke');

    // 重命名
    await page.locator('.file-row .icon-btn').first().click();
    await page.locator('.menu-item', { hasText: '重命名' }).click();
    await page.locator('.dialog .input').fill('冒烟改名.txt');
    await page.locator('.dialog .btn-primary').click();
    await page.waitForFunction(() => document.querySelector('.file-row .name')?.textContent.includes('冒烟改名.txt'), { timeout: 10000 });
    assert.ok((await page.locator('.file-row .name').first().innerText()).includes('冒烟改名.txt'));

    // 搜索
    await page.locator('.search input').fill('冒烟改名');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('.file-row').count(), 1);
    await page.locator('.search input').fill('不存在');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('.empty').count(), 1);
    await page.locator('.search input').fill('');
    await page.waitForTimeout(200);

    // 移动端：文件名列不能被挤没，到期文案要留在名字下面
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const nameBox = await page.locator('.file-row .name').first().boundingBox();
    assert.ok(nameBox && nameBox.width > 100, `移动端文件名列太窄: ${JSON.stringify(nameBox)}`);
    const metaText = await page.locator('.file-row .meta').first().innerText();
    assert.ok(/小时|分钟/.test(metaText), `移动端到期文案丢了: ${metaText}`);
    const actionsBox = await page.locator('.file-row .actions').first().boundingBox();
    assert.ok(actionsBox && actionsBox.x + actionsBox.width <= 390, '移动端操作列溢出了屏幕');
    await page.screenshot({ path: SHOT('fb-library-mobile.png'), fullPage: true });

    // 删文件 → 删目录
    await page.locator('.file-row .icon-btn').first().click();
    await page.locator('.menu-item.danger').click();
    await page.locator('.dialog .btn-danger').click();
    await page.waitForTimeout(1000);
    assert.strictEqual(await page.locator('.file-row').count(), 0);
    await page.locator('.crumb-btn').first().click();
    await page.waitForTimeout(400);
    const folderRow2 = page.locator('.folder-row', { hasText: '冒烟目录' });
    await folderRow2.locator('.icon-btn').click();
    await page.locator('.menu-item.danger').click();
    await page.locator('.dialog .btn-danger').click();
    await page.waitForTimeout(1000);
    assert.strictEqual(await page.locator('.folder-row', { hasText: '冒烟目录' }).count(), 0);

    assert.deepStrictEqual(errs, [], `浏览器有 console/page 错误:\n${errs.join('\n')}`);
    console.log('[library-smoke] 通过');
    console.log('[library-smoke] 截图:', SHOT('fb-library-desktop.png'), SHOT('fb-library-mobile.png'));
  } catch (err) {
    await page.screenshot({ path: SHOT('fb-library-fail.png'), fullPage: true }).catch(() => {});
    console.error('[library-smoke] 失败:', err.message);
    console.error('[library-smoke] 错误日志:', errs.length ? errs : 'none');
    console.error('[library-smoke] 失败截图:', SHOT('fb-library-fail.png'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    await srv.stop();
    fs.rmSync(uploadFile, { force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
