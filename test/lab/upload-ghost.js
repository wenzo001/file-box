// 上传中影子行（不属于 npm test）：进行中的文件要立刻出现在目标目录那栏，
// 虚线 + 淡图标 + 进度条，完成后由真实文件行接管。真 Chromium + 真服务 + 真加密。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const LOG = (m) => console.log(`[upload-ghost] ${m}`);
const TMP = os.tmpdir();

(async () => {
  const srv = await startServer();
  const files = [0, 1].map((i) => path.join(TMP, `fb-ghost-${Date.now()}-${i}.bin`));
  fs.writeFileSync(files[0], Buffer.alloc(12 * 1024 * 1024, 7));
  fs.writeFileSync(files[1], Buffer.alloc(8 * 1024 * 1024, 8));
  const names = files.map((f) => path.basename(f));
  let browser = null;
  try {
    await fetch(`${srv.base}/api/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '影子目录' }),
    });
    browser = await chromium.launch({ executablePath: EXE, headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

    // 扣住每次上传的第一发分块：其余分块照常传完，影子行会停在 33% / 67% 这种中间态
    let release = null;
    let hold = false;
    await page.route('**/api/upload/part**', async (route) => {
      if (hold) {
        hold = false;
        await new Promise((r) => { release = r; });
      }
      await route.continue();
    });

    await page.goto(`${srv.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.columns');
    await page.locator('.folder-row', { hasText: '影子目录' }).click();
    await page.waitForTimeout(400);

    const read = (name) => page.evaluate((n) => {
      const row = document.querySelector('.pending-row');
      const cols = [...document.querySelectorAll('.column')];
      if (!row) {
        return {
          ghost: document.querySelectorAll('.pending-row').length,
          real: [...document.querySelectorAll('.file-row')].filter((r) => r.textContent.includes(n)).length,
        };
      }
      const icon = row.querySelector('.row-icon');
      const track = row.querySelector('.pending-track');
      const trackBox = track.getBoundingClientRect();
      const fillBox = row.querySelector('.pending-fill').getBoundingClientRect();
      const colBox = row.closest('.column').getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return {
        ghost: document.querySelectorAll('.pending-row').length,
        real: document.querySelectorAll('.file-row').length,
        colIndex: cols.indexOf(row.closest('.column')),
        colPending: cols.map((c) => c.querySelectorAll('.pending-row').length),
        text: row.innerText.replace(/\s+/g, ' ').trim(),
        outline: getComputedStyle(row).outlineStyle,
        pointer: getComputedStyle(row).pointerEvents,
        iconOpacity: Number(getComputedStyle(icon).opacity),
        trackH: Math.round(trackBox.height),
        fillPct: Math.round((fillBox.width / trackBox.width) * 100),
        ariaNow: Number(track.getAttribute('aria-valuenow')),
        ariaLabel: row.getAttribute('aria-label'),
        busy: row.getAttribute('aria-busy'),
        selected: document.querySelectorAll('.col-row.selected').length,
        rowRight: Math.round(rowBox.right),
        colRight: Math.round(colBox.right),
        rowH: Math.round(rowBox.height),
        head: document.querySelector('.column:last-child .col-sub').textContent,
        overlapX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        name: n,
      };
    }, name);

    // —— 桌面：上传到「影子目录」，第一发分块被扣住 ——
    hold = true;
    await page.locator('input[type=file]').setInputFiles([files[0]]);
    await page.waitForSelector('.pending-row', { timeout: 15000 });
    const early = await read(names[0]);
    assert.strictEqual(early.ghost, 1, `上传中应在目录里出现 1 行影子文件（实际 ${early.ghost}）`);
    assert.strictEqual(early.colPending[0], 0, '影子行不该出现在最上面那栏（那栏只列目录）');
    assert.deepStrictEqual(early.colPending, [0, 1], `影子行要落在目标目录那一栏：${JSON.stringify(early.colPending)}`);
    assert.match(early.text, /上传中/, `影子行没写「上传中」：${early.text}`);
    assert.ok(early.text.includes(names[0]), `影子行不是刚选的文件：${early.text}`);
    assert.match(early.text, /12\.0 MB/, `影子行没标大小：${early.text}`);
    assert.strictEqual(early.outline, 'dashed', '影子行不是虚线框');
    assert.ok(early.iconOpacity < 1, `文件名前的图标没有半透明（opacity=${early.iconOpacity}）`);
    assert.strictEqual(early.pointer, 'none', '影子行还能点：它还不是文件，不许被选中 / 拖拽');
    assert.strictEqual(early.busy, 'true', '影子行没标 aria-busy');
    assert.ok(early.trackH >= 2, `进度条没渲染出来（高 ${early.trackH}px）`);
    assert.match(early.head, /1 个上传中/, `表头没交代影子行（写着「${early.head}」）`);

    await page.waitForFunction(() => Number(document.querySelector('.pending-row .pending-track')?.getAttribute('aria-valuenow') || 0) > 0, null, { timeout: 20000 });
    const mid = await read(names[0]);
    assert.ok(mid.ariaNow > 0 && mid.ariaNow < 100, `中间态进度应停在 0..100 之间（读到 ${mid.ariaNow}）`);
    assert.ok(Math.abs(mid.fillPct - mid.ariaNow) <= 1, `进度条宽度（${mid.fillPct}%）与 aria-valuenow（${mid.ariaNow}）不一致`);
    assert.ok(mid.rowRight <= mid.colRight + 1, `影子行溢出了栏（${mid.rowRight} > ${mid.colRight}）`);
    LOG(`上传中：${mid.text} · 进度条 ${mid.fillPct}% · 表头「${mid.head}」`);

    const box = await page.locator('.pending-row').boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);
    assert.strictEqual((await read(names[0])).selected, 0, '点了影子行就把勾按上了：它不该能被选中');

    if (release) release();
    await page.waitForFunction((n) => {
      const rows = [...document.querySelectorAll('.file-row')];
      return rows.some((r) => r.textContent.includes(n)) && !document.querySelector('.pending-row');
    }, names[0], { timeout: 30000 });
    const done = await read(names[0]);
    assert.strictEqual(done.ghost, 0, '上传完成后影子行还赖在目录里');
    assert.strictEqual(done.real, 1, `完成后应只剩 1 个真实文件行（实际 ${done.real}）`);
    LOG('完成后：影子行消失，换成真实文件行（带「热乎」）');

    // —— 手机档：390 宽，影子行同样不许溢出、进度条要看得见 ——
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    hold = true;
    await page.locator('input[type=file]').setInputFiles([files[1]]);
    await page.waitForSelector('.pending-row', { timeout: 15000 });
    const m0 = await read(names[1]);
    assert.strictEqual(m0.ghost, 1, '手机上上传中没出现影子行');
    assert.ok(m0.overlapX === false, '影子行让页面出现了横向滚动');
    assert.ok(m0.rowRight <= m0.colRight + 1, `手机档影子行溢出了栏（${m0.rowRight} > ${m0.colRight}）`);
    assert.ok(m0.trackH >= 2, `手机档进度条没渲染出来（高 ${m0.trackH}px）`);
    assert.ok(m0.rowH >= 44, `手机档影子行只有 ${m0.rowH}px，点不到也不像一行`);
    await page.screenshot({ path: path.join(TMP, 'fb-ghost-390.png') });
    if (release) release();
    await page.waitForFunction(() => !document.querySelector('.pending-row'), null, { timeout: 30000 });
    LOG(`手机档：影子行高 ${m0.rowH}px、进度条 ${m0.trackH}px、表头「${m0.head}」`);

    const real = errs.filter((e) => !/Failed to load resource/.test(e));
    assert.deepStrictEqual(real, [], `浏览器报错：\n${real.join('\n')}`);
    LOG('通过：上传中显示影子行（虚线 + 进度），完成换成真实文件');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await srv.stop();
    for (const f of files) fs.rmSync(f, { force: true });
  }
})().catch((err) => { console.error('[upload-ghost] 失败:', err.message); process.exit(1); });
