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
      const headText = () => {
        const el = document.querySelector('.column:last-child .col-sub') || document.querySelector('.mb-title .col-sub');
        return el ? el.textContent : '(读不到表头)';
      };
      // 只认"带着轨道的那一行"：任务中心里也有 .pending-row（没有进度条），
      // 按 .pending-row 抓会抓到它，然后 track 为 null 直接抛错
      const track = document.querySelector('.pending-row .pending-track');
      const row = track && track.closest('.pending-row');
      const cols = [...document.querySelectorAll('.column')];
      if (!row) {
        return {
          ghost: 0,
          real: [...document.querySelectorAll('.file-row')].filter((r) => r.textContent.includes(n)).length,
        };
      }
      const icon = row.querySelector('.row-icon');
      const trackBox = track.getBoundingClientRect();
      const fillBox = track.querySelector('.pending-fill').getBoundingClientRect();
      const colBox = (row.closest('.column') || row.closest('.mb-list')).getBoundingClientRect();
      const metaBox = row.querySelector('.col-meta').getBoundingClientRect();
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
        // 进度条必须独占一行：.col-row 只有两行网格时它和「大小 · 百分比」叠在同一格里（实测 3px 条穿过文字中线）
        metaBottom: Math.round(metaBox.bottom),
        trackTop: Math.round(trackBox.top),
        fillPct: Math.round((fillBox.width / trackBox.width) * 100),
        // 坏的时候要说得出坏在哪一层：轨道有没有宽、内联宽度到没到、行的网格列是什么
        trackW: Math.round(trackBox.width),
        fillW: Math.round(fillBox.width),
        fillCss: getComputedStyle(row.querySelector('.pending-fill')).width,
        // 坏在哪一层：内联 style 到底在不在、它的爹是不是那颗轨道
        fillStyleAttr: row.querySelector('.pending-fill').getAttribute('style'),
        fillParentCls: row.querySelector('.pending-fill').parentElement.className,
        fillDisplay: getComputedStyle(row.querySelector('.pending-fill')).display,
        rowCols: getComputedStyle(row).gridTemplateColumns,
        ariaNow: Number(track.getAttribute('aria-valuenow')),
        ariaLabel: row.getAttribute('aria-label'),
        busy: row.getAttribute('aria-busy'),
        selected: document.querySelectorAll('.col-row.selected').length,
        rowRight: Math.round(rowBox.right),
        colRight: Math.round(colBox.right),
        rowH: Math.round(rowBox.height),
        // 表头：桌面在栏头（.column .col-sub），手机档在 mb-title 里 —— 两棵壳都得读到
        head: headText(),
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
    assert.ok(early.trackTop >= early.metaBottom, `进度条压在「大小 · 百分比」上（条 top=${early.trackTop} < 文字 bottom=${early.metaBottom}）`);
    assert.match(early.head, /1 个上传中/, `表头没交代影子行（写着「${early.head}」）`);

    // 影子条的宽度是**补间**出来的（.pending-fill 有 transition: width）：aria 刚变那一帧
    // 画出来还是 0px，跨调用去"等它追平"又会撞上"上传完成、影子行换成真文件"。
    // 所以这条判据改成页内的一次原子观测：在影子行还活着的时候，用 rAF 盯住
    // "画出来的宽度追上播报的数值"这件事到底发不发生、多久发生。
    // 把宽度写死成 0% 的变异会一直收敛不了 → 超时后照样红（判据没被放宽）。
    const bar = await page.evaluate(() => new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const track = document.querySelector('.pending-row .pending-track');
        const fill = track && track.querySelector('.pending-fill');
        const now = track ? Number(track.getAttribute('aria-valuenow') || 0) : 0;
        const tw = track ? track.getBoundingClientRect().width : 0;
        const painted = fill && tw ? (fill.getBoundingClientRect().width / tw) * 100 : 0;
        const waited = Math.round(performance.now() - t0);
        if (now > 0 && Math.abs(painted - now) <= 2) return resolve({ ok: true, now, painted: Math.round(painted), waited });
        if (!track || !fill) return resolve({ ok: false, why: '影子行先没了', now, painted: Math.round(painted), waited });
        if (waited > 8000) return resolve({ ok: false, why: '一直没长齐', now, painted: Math.round(painted), waited });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    assert.ok(bar.ok, `影子条没长到它播报的长度：${JSON.stringify(bar)}`);
    const mid = await read(names[0]);
    if (mid.ghost) {
      assert.ok(mid.rowRight <= mid.colRight + 1, `影子行溢出了栏（${mid.rowRight} > ${mid.colRight}）`);
      LOG(`上传中：${mid.text} · 进度条 ${bar.painted}%（${bar.waited}ms 长齐）· 表头「${mid.head}」`);
    } else {
      LOG(`影子行已换成真文件（补条在 ${bar.waited}ms 内长到 ${bar.painted}%）`);
    }

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
    assert.ok(m0.trackTop >= m0.metaBottom, `手机档进度条压在字上（条 top=${m0.trackTop} < 文字 bottom=${m0.metaBottom}）`);
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
