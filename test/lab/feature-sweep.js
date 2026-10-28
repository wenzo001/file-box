// 界面级功能扫查（不属于 npm test）：补上"只有端点判据、没有界面判据"的几条主路径。
// 文件重命名 / 文件删除 / 目录「移动到…」/ 下载暂停→继续。真 Chromium + 真服务 + 真加密。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer, uploadBundle, hexKey } = require('../helpers');
require('../../public/crypto.js');

globalThis.FBCrypto._test.setEngine('js');
const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const MB = 1024 * 1024;
const LOG = (m) => console.log(`[feature-sweep] ${m}`);
const te = new TextEncoder();

/** 带加密清单的一批：清单是重命名 / 显示真实文件名的前提 */
async function uploadWithManifest(srv, files) {
  const key = hexKey(40);
  const parts = [];
  const meta = [];
  for (const f of files) {
    const cipher = Buffer.from(await globalThis.FBCrypto.encryptBytes(new Uint8Array(f.plain)));
    parts.push({ enc: f.enc, chunks: [cipher.length], data: [cipher] });
    meta.push({ enc: f.enc, name: f.name, size: f.plain.length });
  }
  const manifest = Buffer.from(await globalThis.FBCrypto.encryptBytes(te.encode(JSON.stringify({ v: 1, files: meta }))));
  parts.push({ enc: 'manifest.enc', chunks: [manifest.length], data: [manifest] });
  return uploadBundle(srv, key, parts);
}

(async () => {
  const srv = await startServer();
  let browser = null;
  try {
    const plainA = Buffer.alloc(600 * 1024, 3);
    const plainBig = Buffer.alloc(8 * MB, 9);
    const batch = (await uploadWithManifest(srv, [
      { enc: 'a.bin.enc', name: '甲.txt', plain: plainA },
      { enc: 'big.bin.enc', name: '大文件.bin', plain: plainBig },
    ])).folder;
    await (await fetch(`${srv.base}/api/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '目标目录' }),
    })).json();
    LOG(`造好批次 ${batch}：甲.txt / 大文件.bin + 一个「目标目录」`);

    browser = await chromium.launch({ executablePath: EXE, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.columns');
    await page.locator('.folder-row', { hasText: '未分档' }).first().click();
    await page.waitForSelector('.file-row');

    // 1) 文件重命名：行 ⋯ → 重命名 → 输入 → 确定，行上的名字立刻换
    await page.locator('.file-row', { hasText: '甲.txt' }).locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '重命名' }).click();
    await page.locator('.dialog .input').fill('乙.txt');
    await page.locator('.dialog .btn-primary').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.file-row .col-name')].some((n) => n.textContent.includes('乙.txt')), null, { timeout: 15000 });
    LOG('重命名：甲.txt → 乙.txt 已在界面上');
    let lib = await (await fetch(`${srv.base}/api/library`)).json();
    assert.ok(lib.batches[0].files.some((f) => f.name === 'big.bin.enc'), '大文件那份不该被改名影响');

    // 2) 文件删除：最后一个文件删掉后，批次整个消失
    await page.locator('.file-row', { hasText: '乙.txt' }).locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '删除' }).first().click();
    await page.locator('.dialog .btn-danger').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.file-row .col-name')].some((n) => n.textContent.includes('乙.txt')), null, { timeout: 15000 });
    lib = await (await fetch(`${srv.base}/api/library`)).json();
    const left = lib.batches.reduce((n, b) => n + b.count, 0);
    LOG(`文件删除：界面上已消失，服务端剩 ${left} 个文件`);
    assert.strictEqual(left, 1, `应该只剩大文件那一个，实际 ${left}`);

    // 3) 文件「⋯ → 移动这批上传到…」：选目标目录后归属真的改了
    const batchName = lib.batches[0].name;
    assert.strictEqual(lib.batches[0].folderId, null, '前置：这份批次在未分档');
    await page.locator('.file-row', { hasText: '大文件.bin' }).locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '移动这批上传到…' }).click();
    await page.locator('.dialog select').selectOption({ label: '目标目录' });
    await page.locator('.dialog .btn-primary').click();
    await page.waitForFunction(async (b) => {
      const l = await (await fetch(`${location.origin}/api/library`)).json();
      const hit = l.batches.find((x) => x.name === b);
      return Boolean(hit && hit.folderId);
    }, batchName, { timeout: 15000 });
    lib = await (await fetch(`${srv.base}/api/library`)).json();
    const moved = lib.batches.find((x) => x.name === batchName);
    const target = lib.folders.find((f) => f.name === '目标目录');
    assert.strictEqual(moved.folderId, target.id, `移动到…之后批次的归属没变（${moved.folderId} vs ${target.id}）`);
    LOG(`移动到…：批次现在挂在「${target.name}」下`);

    // 4) 下载暂停 → 继续：先把那一发请求扣住，暂停后再放行
    let releaseFirst = null;
    let heldOnce = false;
    let hits = 0;
    await page.route('**/api/download/**', async (route) => {
      if (!/big\.bin\.enc$/.test(route.request().url())) return route.continue();
      hits++;
      LOG(`下载请求 #${hits}（range=${route.request().headers().range || '无'}）`);
      if (!heldOnce) {
        heldOnce = true;
        await new Promise((r) => { releaseFirst = r; });
        await route.continue().catch(() => {}); // 暂停会掐掉这一发：继续失败就算了
        return;
      }
      await route.continue();
    });
    await page.locator('.folder-row', { hasText: '目标目录' }).first().click();
    await page.waitForSelector('.file-row');
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await page.locator('.file-row', { hasText: '大文件.bin' }).first().dblclick();
    await page.waitForSelector('.task');
    await page.locator('.task [title="暂停"]').first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.task')].some((t) => /已暂停/.test(t.textContent)), null, { timeout: 15000 });
    LOG('下载暂停：任务行显示已暂停');
    await page.locator('.task [title="继续"]').first().click();
    const release = releaseFirst;
    if (release) release();
    const saved = await dl;
    fs.rmSync(await saved.path().catch(() => ''), { force: true });
    await page.waitForFunction(() => [...document.querySelectorAll('.task')].some((t) => /已完成/.test(t.textContent)), null, { timeout: 60000 })
      .catch(async (e) => {
        LOG(`等"已完成"超时；任务行=${JSON.stringify(await page.locator('.task').allInnerTexts())} · 请求数=${hits}`);
        throw e;
      });
    LOG('下载继续：任务行显示已完成');

    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${real.join('\n')}`);
    LOG('通过：重命名 / 文件删除 / 移动到… / 下载暂停继续');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
  }
})().catch((err) => { console.error('[feature-sweep] 失败:', err.message); process.exit(1); });
