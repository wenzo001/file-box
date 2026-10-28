// 弱网续传（不属于 npm test）：先只给 40% 就断，看界面会不会带 Range 从断点接着下，
// 并且最终存下来的文件能解密、字节与原文一致。真 Chromium + 真服务 + 真 OPFS。
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
const LOG = (m) => console.log(`[resume-lab] ${m}`);

(async () => {
  const srv = await startServer();
  const out = path.join(os.tmpdir(), `fb-resume-${Date.now()}.bin`);
  let browser = null;
  try {
    // 造一个 6MB 的密文（按文件真实格式：一块一块拼）
    const plain = Buffer.alloc(6 * MB);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 13 + 7) & 255;
    const blocks = [];
    const BLOCK = 512 * 1024;
    for (let off = 0; off < plain.length; off += BLOCK) {
      blocks.push(Buffer.from(await globalThis.FBCrypto.encryptBytes(new Uint8Array(plain.subarray(off, off + BLOCK)))));
    }
    const cipher = Buffer.concat(blocks);
    const thirds = [cipher.subarray(0, Math.ceil(cipher.length / 3)),
      cipher.subarray(Math.ceil(cipher.length / 3), Math.ceil(cipher.length * 2 / 3)),
      cipher.subarray(Math.ceil(cipher.length * 2 / 3))];
    const batch = (await uploadBundle(srv, hexKey(40), [{
      enc: 'resume.bin.enc', chunks: thirds.map((t) => t.length), data: thirds,
    }])).folder;
    LOG(`上传完成：批次 ${batch}，密文 ${(cipher.length / MB).toFixed(1)}MB，明文 ${(plain.length / MB).toFixed(1)}MB`);

    browser = await chromium.launch({ executablePath: EXE, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

    // 第一次只给 40% 就断（206 + 短 body），之后放行给真服务
    const ranges = [];
    let calls = 0;
    const cut = Math.floor(cipher.length * 0.4);
    // 只拦这个文件的下载：清单 manifest.enc 也走 /api/download/，按形状拦会把它一起打断
    await page.route('**/api/download/**', async (route) => {
      const req = route.request();
      if (!/resume\.bin\.enc$/.test(req.url())) return route.continue();
      const range = req.headers().range || '';
      ranges.push(range);
      calls += 1;
      if (calls === 1) {
        await route.fulfill({
          status: 206,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes 0-${cut - 1}/${cipher.length}`,
            'Content-Length': String(cut),
          },
          body: cipher.subarray(0, cut),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.columns');
    await page.locator('.folder-row', { hasText: '未分档' }).first().click();
    await page.waitForSelector('.file-row');
    LOG('双击文件行开始下载（第一次会被断开）');
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).catch((e) => { LOG('等下载事件失败：' + e.message); throw e; });
    await page.locator('.file-row', { hasText: 'resume.bin.enc' }).first().dblclick();
    LOG('拿到下载事件');
    const download = await downloadPromise;
    await download.saveAs(out);
    const got = fs.readFileSync(out);
    LOG(`下载结束：${ranges.length} 次请求，Range=${JSON.stringify(ranges)}，落盘 ${(got.length / MB).toFixed(2)}MB`);

    assert.strictEqual(ranges.length >= 2, true, `应该断线重连至少一次，实际只请求了 ${ranges.length} 次`);
    assert.strictEqual(ranges[0], '', '第一次不该带 Range');
    assert.strictEqual(ranges[1], `bytes=${cut}-`, `续传必须从断点起（现在是 ${ranges[1]}）`);
    assert.strictEqual(got.length, plain.length, `存下来的大小不对：${got.length} vs ${plain.length}`);
    assert.deepStrictEqual(got, plain, '存下来的内容与原文不一致（续传拼坏了）');
    // 没清单的批次会 404 一次清单（产品行为，前端吞掉并缓存 null）；浏览器仍会打一条 console 错误
    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${errs.join('\n')}`);
    LOG('通过：断线后带 Range 续传，最终字节与原文一致');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
    fs.rmSync(out, { force: true });
  }
})().catch((err) => { console.error('[resume-lab] 失败:', err.message); process.exit(1); });
