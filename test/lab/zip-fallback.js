// 降级档（不属于 npm test）：把 OPFS 掐掉、内存上限压到 1MB，打包必须改成"逐个文件下载"，
// 而不是报错或转圈。真 Chromium + 真服务。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer, uploadBundle, hexKey } = require('../helpers');
require('../../public/crypto.js');

globalThis.FBCrypto._test.setEngine('js');
const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const LOG = (m) => console.log(`[fallback-lab] ${m}`);

(async () => {
  const srv = await startServer({ MEM_DOWNLOAD_MAX_MB: '1' });
  let browser = null;
  try {
    const plain = Buffer.alloc(600 * 1024, 7);
    const cipher = Buffer.from(await globalThis.FBCrypto.encryptBytes(new Uint8Array(plain)));
    for (const enc of ['f1.enc', 'f2.enc']) {
      await uploadBundle(srv, hexKey(40), [{ enc, chunks: [cipher.length], data: [cipher] }]);
    }
    LOG(`上传两个 ${(plain.length / 1024).toFixed(0)}KB 文件（合计超过 1MB 上限）`);

    browser = await chromium.launch({ executablePath: EXE, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
    // 掐掉 OPFS：这台"设备"就只剩内存档
    await ctx.addInitScript(() => {
      try { Object.defineProperty(navigator, 'storage', { value: {}, configurable: true }); } catch { /* 已经是空的 */ }
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.columns');
    await page.locator('.folder-row', { hasText: '未分档' }).first().click();
    await page.waitForSelector('.file-row');

    // 两个 waitForEvent 会拿到同一个下载事件；这里自己攒到两个
    const files = [];
    const twoDone = new Promise((resolve) => {
      page.on('download', (d) => { files.push(d); if (files.length >= 2) resolve(files); });
      setTimeout(() => resolve(files), 60000);
    });
    await page.locator('[aria-label="打包下载这个文件夹"]').first().click();
    await twoDone;
    const sizes = [];
    for (const f of files) {
      const p = await f.path();
      sizes.push(fs.readFileSync(p).length);
    }
    LOG(`逐个下载了 ${files.length} 个文件，大小 ${sizes.join(' / ')}`);

    assert.strictEqual(files.length, 2, `应该逐个下载两个文件，实际 ${files.length} 个`);
    for (const n of sizes) assert.strictEqual(n, plain.length, `单文件大小不对：${n} vs ${plain.length}`);
    const rows = await page.locator('.task').allInnerTexts();
    LOG(`任务行：${JSON.stringify(rows)}`);
    assert.ok(rows.some((t) => /逐个文件/.test(t)), '任务行里要写清已降级成逐个文件');

    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${real.join('\n')}`);
    LOG('通过：无 OPFS + 超上限的打包降级成逐个文件，两个文件都下完了');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
    fs.rmSync(path.join(os.tmpdir(), 'fb-fallback-unused'), { force: true });
  }
})().catch((err) => { console.error('[fallback-lab] 失败:', err.message); process.exit(1); });
