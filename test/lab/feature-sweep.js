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
    // 1400 宽的窗口里名字格约 960px：要真的截断得够长（不然这条判据是空的）
    const longName = `${'很长很长的文件名'.repeat(12)}.txt`;
    const batch = (await uploadWithManifest(srv, [
      { enc: 'a.bin.enc', name: '甲.txt', plain: plainA },
      { enc: 'big.bin.enc', name: '大文件.bin', plain: plainBig },
      { enc: 'long.bin.enc', name: longName, plain: plainA },
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

    // 热乎只标文件：目录行不该有
    assert.strictEqual(await page.locator('.folder-row .tag.hot').count(), 0, '目录行不该有「热乎」标签');
    assert.ok(await page.locator('.file-row .tag.hot').count() >= 2, '文件行应当有「热乎」标签');

    // 超长文件名：只截名字，标签必须完整留在格子里
    const clip = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('.file-row')].find((r) => r.textContent.includes(name.slice(0, 8)));
      if (!row) return null;
      const cell = row.querySelector('.col-name').getBoundingClientRect();
      const text = row.querySelector('.name-text').getBoundingClientRect();
      const tag = row.querySelector('.tag.hot').getBoundingClientRect();
      return {
        cellRight: Math.round(cell.right), textRight: Math.round(text.right),
        tagRight: Math.round(tag.right), tagW: Math.round(tag.width), cellW: Math.round(cell.width),
        textClipped: row.querySelector('.name-text').scrollWidth > Math.ceil(text.width) + 1,
      };
    }, longName);
    assert.ok(clip, '没找到长文件名那一行');
    assert.strictEqual(clip.textClipped, true, `长名字没有被截断（${JSON.stringify(clip)}）—— 这条判据看不出"标签会不会被裁"`);
    assert.ok(clip.tagW >= 20 && clip.tagRight <= clip.cellRight + 1,
      `热乎标签被名字挤出去了：${JSON.stringify(clip)}`);

    // 目录名上限 10 个字：输入框本身卡住第 11 个字，文案里写清上限
    // （服务端拒绝超长的判据在 test/library.test.js —— 界面上走不到"提交 11 个字"那条路）
    await page.locator('[aria-label="新建文件夹"]').first().click();
    await page.waitForSelector('.dialog', { state: 'visible' });
    const nameInput = page.locator('.dialog .input');
    assert.strictEqual(await nameInput.getAttribute('maxlength'), '10', '目录名输入框没有卡在 10 个字');
    await nameInput.fill('一二三四五六七八九十一');
    assert.strictEqual((await nameInput.inputValue()).length, 10, '第 11 个字没有被挡住');
    assert.match(await page.locator('.dialog .char-count').innerText(), /10\/10/, '字数计数没有停在 10');
    assert.match(await page.locator('.dialog p').first().innerText(), /10 个字/, '对话框里没写清上限是 10 个字');
    await page.locator('.dialog .btn').first().click(); // 取消
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 8000 });

    // 1) 文件重命名：行 ⋯ → 重命名 → 输入 → 确定，行上的名字立刻换
    await page.locator('.file-row', { hasText: '甲.txt' }).locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '重命名' }).click();
    await page.locator('.dialog .input').fill('乙.txt');
    await page.locator('.dialog .btn-primary').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.file-row .col-name')].some((n) => n.textContent.includes('乙.txt')), null, { timeout: 15000 });
    LOG('重命名：甲.txt → 乙.txt 已在界面上');
    let lib = await (await fetch(`${srv.base}/api/library`)).json();
    assert.ok(lib.batches[0].files.some((f) => f.name === 'big.bin.enc'), '大文件那份不该被改名影响');
    const before = lib.batches.reduce((n, b) => n + b.count, 0);

    // 2) 文件删除：删掉的那个真的从服务端消失，同批次其余文件不受牵连
    await page.locator('.file-row', { hasText: '乙.txt' }).locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '删除' }).first().click();
    await page.locator('.dialog .btn-danger').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.file-row .col-name')].some((n) => n.textContent.includes('乙.txt')), null, { timeout: 15000 });
    lib = await (await fetch(`${srv.base}/api/library`)).json();
    const left = lib.batches.reduce((n, b) => n + b.count, 0);
    const encs = lib.batches.flatMap((b) => b.files.map((f) => f.name));
    LOG(`文件删除：界面上已消失，服务端剩 ${left} 个文件`);
    assert.strictEqual(left, before - 1, `删一个文件后服务端应当剩 ${before - 1} 个，实际 ${left}`);
    assert.ok(encs.includes('big.bin.enc') && encs.includes('long.bin.enc'), `同批次其余文件被连带删了：${encs.join(' / ')}`);

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
