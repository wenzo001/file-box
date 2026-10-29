// 没有可写 OPFS 的那一档（= 纯 HTTP 局域网地址 / 无痕窗口 / 旧浏览器）：
// 以前把整份明文攒进 JS 数组再 new Blob(parts)，峰值按文件大小涨，所以 50MB 就封顶；
// 现在解密出来的块直接流进 new Response(stream).blob()，只剩浏览器自己那份缓冲。
// 判据三条（都是用户能感知的）：超过旧上限的文件能下完、字节与原文一致、页面不报错。
// 刻意不量 usedJSHeapSize：它不统计 ArrayBuffer / Blob 存储（空跑基线就 87MB，
// "流式"与"攒数组"两条路读数一样，量的是一个看不见这件事的轴）。内存那条轴由上限本身兜着。
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
const SIZE_MB = Number(process.env.NOOPFS_MB || 80);
const LOG = (m) => console.log(`[noopfs-dl] ${m}`);
const te = new TextEncoder();

(async () => {
  const srv = await startServer();
  const plain = Buffer.alloc(SIZE_MB * MB, 9);
  const cipher = Buffer.from(await globalThis.FBCrypto.encryptBytes(new Uint8Array(plain)));
  const manifest = Buffer.from(await globalThis.FBCrypto.encryptBytes(te.encode(JSON.stringify({
    v: 1, files: [{ enc: 'big.bin.enc', name: `没有本地存储-${SIZE_MB}MB.bin`, size: plain.length }],
  }))));
  // 单块上限 32MB：按 4MB 切（客户端就是 4MB 一块）
  const STEP = 4 * MB;
  const chunks = [];
  const data = [];
  for (let off = 0; off < cipher.length; off += STEP) {
    const part = cipher.subarray(off, Math.min(cipher.length, off + STEP));
    chunks.push(part.length);
    data.push(part);
  }
  await uploadBundle(srv, hexKey(40), [
    { enc: 'big.bin.enc', chunks, data },
    { enc: 'manifest.enc', chunks: [manifest.length], data: [manifest] },
  ]);
  LOG(`已上传 ${SIZE_MB}MB（密文 ${(cipher.length / MB).toFixed(1)}MB）`);

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const out = path.join(os.tmpdir(), `fb-noopfs-${Date.now()}.bin`);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    // 这台"设备"没有可写 OPFS —— 与纯 HTTP 局域网地址上的浏览器的处境一致
    await ctx.addInitScript(() => {
      try { Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true }); } catch { /* 已经没了 */ }
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
    await page.goto(`${srv.base}/`, { waitUntil: 'networkidle' });

    const hasOpfs = await page.evaluate(() => Boolean(navigator.storage && navigator.storage.getDirectory));
    assert.strictEqual(hasOpfs, false, '夹具没把 OPFS 掐掉：这条腿测的就不是兜底档了');

    const dl = page.waitForEvent('download', { timeout: 180000 });
    await page.locator('.file-row', { hasText: `没有本地存储-${SIZE_MB}MB` }).first().dblclick();
    await page.waitForFunction(() => [...document.querySelectorAll('.task')]
      .some((t) => /已完成|失败/.test(t.textContent)), null, { timeout: 180000 });
    const taskText = (await page.locator('.task').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
    const saved = await dl.catch((e) => { throw new Error(`没拿到下载事件（${e.message}）；任务行：${taskText}`); });
    await saved.saveAs(out);

    const got = fs.readFileSync(out);
    LOG(`任务行：${taskText}`);
    LOG(`落盘 ${(got.length / MB).toFixed(2)}MB`);
    fs.rmSync(out, { force: true });

    assert.match(taskText, /已完成/, `下载没成功：${taskText}`);
    assert.strictEqual(got.length, plain.length, `落盘大小不对：${got.length} vs ${plain.length}`);
    assert.ok(got.equals(plain), '落盘内容与原文不一致');
    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${real.join('\n')}`);
    LOG('通过：没有本地存储也能下完超过旧上限的文件，字节与原文一致');
  } finally {
    await browser.close().catch(() => {});
    await srv.stop();
    fs.rmSync(out, { force: true });
  }
})().catch((err) => { console.error('[noopfs-dl] 失败:', err.message); process.exit(1); });
