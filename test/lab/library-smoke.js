// 目录界面的真浏览器冒烟（不属于 npm test）。
// 先 npm run build，再 node test/lab/library-smoke.js；默认打开 dist-web 根页面。
// 判据打在渲染结果上：多栏展开、右键建目录、上传 / 热乎 / 到期、全局 TTL、
// 目录与文件分享高亮、目录 / 多选 zip、全局搜索路径、拖拽上传、窄屏可见性。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { unzipSync, strFromU8 } = require('fflate');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const EXE = process.env.CHROME_PATH || 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';
const SHOT = (name) => path.join(os.tmpdir(), name);
const tmp = (name) => path.join(os.tmpdir(), name);

(async () => {
  const srv = await startServer();
  const f1 = tmp('fb-library-甲.txt');
  const f2 = tmp('fb-library-乙.txt');
  fs.writeFileSync(f1, 'AAA-content');
  fs.writeFileSync(f2, 'BBB-content');
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srv.base });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  const readClip = () => page.evaluate(() => navigator.clipboard.readText());
  const fileRow = (name) => page.locator('.file-row', { hasText: name });

  try {
    await page.goto(`${srv.base}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.columns');

    // 公共 TTL：改成 4 小时，必须落到服务端；上传不带 TTL 时按它记账
    await page.locator('#ttl-select').selectOption('4');
    await page.waitForTimeout(400);
    let lib = await (await fetch(`${srv.base}/api/library`)).json();
    assert.strictEqual(lib.settings.defaultTtlHours, 4, '全局 TTL 没有落到服务端');

    // 目录栏头新建；输入框 20 字上限
    await page.locator('.column').first().getByRole('button', { name: '新建文件夹' }).click();
    const input = page.locator('.dialog .input');
    assert.strictEqual(await input.evaluate((el) => el.maxLength), 20, '目录名输入框没有 20 字上限');
    await input.fill('冒烟项目');
    await page.locator('.dialog .btn-primary').click();
    await page.waitForSelector('.folder-row');
    await page.locator('.folder-row', { hasText: '冒烟项目' }).click();
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.column').count(), 2, '点目录后没有展开第二栏');
    // 最后一栏必须吃掉卡片剩余宽度：右侧留空档 = 界面看着"外面还套了一层"
    const gutter = await page.evaluate(() => {
      const card = document.querySelector('.columns').getBoundingClientRect();
      const last = [...document.querySelectorAll('.column')].pop().getBoundingClientRect();
      return Math.round(card.right - last.right);
    });
    assert.ok(gutter <= 2, `最后一栏右侧留了 ${gutter}px 空档，卡片看着像多套了一层`);

    // 空白处右键新建子目录
    await page.locator('.column').last().locator('.col-list').click({ button: 'right', position: { x: 60, y: 260 } });
    await page.locator('.context-menu .menu-item', { hasText: '新建子文件夹' }).click();
    await page.locator('.dialog .input').fill('子目录乙');
    await page.locator('.dialog .btn-primary').click();
    await page.waitForSelector('.folder-row:has-text("子目录乙")');
    await page.locator('.folder-row', { hasText: '子目录乙' }).click();
    await page.waitForTimeout(400);

    // 导航只留一套：左侧那棵重复的目录树必须不在场（分栏 + 面包屑已覆盖）
    assert.strictEqual(await page.locator('.sidebar').count(), 0, '左侧栏那棵重复的目录树还在');

    // 一级一级都要有选中态：路径上那几行必须亮，且真渲染出来、文字对比度够
    const lit = await page.evaluate(() => {
      const chan = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const alpha = (s) => (s.match(/[\d.]+/g) || []).length > 3 ? Number(s.match(/[\d.]+/g)[3]) : 1;
      const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
      const bgOf = (el) => {
        let acc = [255, 255, 255];
        for (let n = el; n; n = n.parentElement) {
          const b = getComputedStyle(n).backgroundColor;
          if (b === 'rgba(0, 0, 0, 0)' || b === 'transparent') continue;
          const a = alpha(b);
          acc = over(chan(b), a, acc);
          if (a >= 1) break;
        }
        return acc;
      };
      const lum = (c) => c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      const ratio = (fg, bg) => {
        const [l1, l2] = [fg, bg].map((c) => { const [r, g, b] = lum(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }).sort((a, b) => b - a);
        return (l1 + 0.05) / (l2 + 0.05);
      };
      return [...document.querySelectorAll('.column')].map((col, i) => {
        const row = col.querySelector('.col-row.current');
        if (!row) return { col: i, current: null };
        const name = row.querySelector('.col-name');
        const r = row.getBoundingClientRect();
        return {
          col: i,
          current: name.textContent.trim().split(/\s+/)[0],
          h: Math.round(r.height),
          contrast: Number(ratio(chan(getComputedStyle(name).color), bgOf(row)).toFixed(2)),
        };
      });
    });
    console.log('[library-smoke] 各级选中态:', JSON.stringify(lit));
    const litRows = lit.filter((x) => x.current);
    assert.strictEqual(litRows.length, 2, `三级路径上该有两行选中态，实到 ${litRows.length} 行: ${JSON.stringify(lit)}`);
    assert.deepStrictEqual(litRows.map((x) => x.current), ['冒烟项目', '子目录乙'], '选中态没落在路径那两行上');
    for (const row of litRows) {
      assert.ok(row.h > 20, `第 ${row.col + 1} 栏的选中行没渲染出高度: ${JSON.stringify(row)}`);
      assert.ok(row.contrast >= 4.5, `第 ${row.col + 1} 栏选中行文字对比度 ${row.contrast}:1 < 4.5:1`);
    }

    // 上传两件；目录行有文件数与最后更新；文件在 10 分钟内标「热乎」
    await page.locator('input[type=file]').setInputFiles([f1, f2]);
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length >= 2, { timeout: 30000 });
    const parent = page.locator('.column').nth(1).locator('.folder-row', { hasText: '子目录乙' });
    const parentMeta = await parent.locator('.col-meta').innerText();
    assert.match(parentMeta, /2 个文件/);
    assert.match(parentMeta, /最后更新/);
    assert.ok(await page.locator('.file-row .tag.hot').count() >= 2, '刚上传的文件没有「热乎」标');
    const expiry = await page.locator('.file-row .col-expiry').first().innerText();
    assert.match(expiry, /4 小时后删除/);
    lib = await (await fetch(`${srv.base}/api/library`)).json();
    assert.strictEqual(lib.batches[0].ttlHours, 4, '上传没有使用全局 TTL');
    await page.screenshot({ path: SHOT('fb-library-desktop.png'), fullPage: true });

    // 目录「⋯」菜单：重命名 / 删除 / 分享链接都在
    await parent.locator('.col-more').click();
    const folderMenu = await page.locator('.context-menu .menu-item').allInnerTexts();
    assert.ok(folderMenu.includes('重命名') && folderMenu.includes('删除文件夹') && folderMenu.includes('复制文件夹链接'));
    await page.keyboard.press('Escape');

    // 分享链接改名后仍指向同一个目录 ID
    await parent.locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '复制文件夹链接' }).click();
    await page.waitForTimeout(250);
    const beforeLink = new URL(await readClip());
    const folderId = beforeLink.searchParams.get('f');
    assert.ok(folderId, '文件夹链接没有带 f=<id>');
    await parent.locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '重命名' }).click();
    await page.locator('.dialog .input').fill('子目录乙-改');
    await page.locator('.dialog .btn-primary').click();
    await page.waitForSelector('.folder-row:has-text("子目录乙-改")');
    const renamed = page.locator('.column').nth(1).locator('.folder-row', { hasText: '子目录乙-改' });
    await renamed.locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '复制文件夹链接' }).click();
    await page.waitForTimeout(250);
    const afterLink = new URL(await readClip());
    assert.strictEqual(afterLink.searchParams.get('f'), folderId, '改名后文件夹链接变了');

    // 文件分享：打开后文件与所在目录高亮
    await page.locator('.file-row').first().locator('.col-more').click();
    await page.locator('.context-menu .menu-item', { hasText: '复制文件分享链接' }).click();
    await page.waitForTimeout(250);
    const shareUrl = await readClip();
    assert.match(shareUrl, /[?&]file=/);
    await page.goto(shareUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.file-row.shared');
    assert.strictEqual(await page.locator('.file-row.shared').count(), 1);
    assert.strictEqual(await page.locator('.banner.share').count(), 1);
    assert.ok(await page.locator('.folder-row.shared').count() >= 1);

    // 目录 zip：逐个解开并核对内容
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('.column').last().locator('.col-head button[aria-label="打包下载这个文件夹"]').click(),
    ]);
    const names = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(await dl.path()))));
    assert.ok(names.some((n) => n.endsWith('fb-library-甲.txt')));
    assert.ok(names.some((n) => n.endsWith('fb-library-乙.txt')));
    assert.strictEqual(strFromU8(unzipSync(new Uint8Array(fs.readFileSync(await dl.path())))[
      names.find((n) => n.endsWith('fb-library-甲.txt'))
    ]), 'AAA-content');

    // 全局搜索：文件名 + 所在目录路径
    await page.locator('.search input').fill('fb-library-乙');
    await page.waitForTimeout(350);
    assert.strictEqual(await page.locator('.result-row').count(), 1);
    const resultPath = await page.locator('.result-path').innerText();
    assert.match(resultPath, /冒烟项目/);
    assert.match(resultPath, /子目录乙-改/);
    await page.locator('.search input').fill('');
    await page.waitForTimeout(350);

    // 多选 zip
    await page.locator('.file-row .col-check').nth(0).check();
    await page.locator('.file-row .col-check').nth(1).check();
    const [dl2] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('.selection-bar .linkbtn', { hasText: '打包下载' }).click(),
    ]);
    const multi = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(await dl2.path()))));
    assert.ok(multi.filter((n) => !n.endsWith('/')).length >= 2);

    // 整批上传移动：从子目录移回父目录，两个文件一起走
    await page.locator('.file-row', { hasText: 'fb-library-甲' }).locator('.col-more').click();
    const fileMenu = await page.locator('.context-menu .menu-item').allInnerTexts();
    assert.ok(fileMenu.includes('移动这批上传到…'), '文件菜单缺少整批移动');
    await page.locator('.context-menu .menu-item', { hasText: '移动这批上传到…' }).click();
    await page.locator('.dialog select').selectOption({ label: '冒烟项目' });
    await page.locator('.dialog .btn-primary').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.column:last-child .file-row').length === 0,
      { timeout: 15000 },
    );
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('.column:first-child .folder-row')]
        .find((r) => r.textContent.includes('冒烟项目'));
      return row && /2 个文件/.test(row.textContent);
    }, { timeout: 15000 });
    const projectMeta = await page.locator('.column').first().locator('.folder-row', { hasText: '冒烟项目' }).locator('.col-meta').innerText();
    assert.match(projectMeta, /2 个文件/, '整批移动后父目录文件数不对');

    // 拖拽上传到当前栏
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(['drop-content'], '拖拽.txt', { type: 'text/plain' }));
      return d;
    });
    await page.locator('.column').last().locator('.col-list').dispatchEvent('drop', { dataTransfer: dt });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.file-row .col-name')].some((n) => n.textContent.includes('拖拽.txt')),
      { timeout: 30000 },
    );

    // 窄屏：当前栏必须自动滚到视野内
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const box = await page.locator('.column:last-child .file-row').first().boundingBox();
    assert.ok(box && box.x >= 0 && box.x < 390, `窄屏下当前目录不在视野内: ${JSON.stringify(box)}`);
    // 三行都要真渲染：旧表格的窄屏规则曾把倒计时那一行整行 display:none 掉
    const expiryCell = page.locator('.column:last-child .file-row .col-expiry').first();
    const expiryBox = await expiryCell.boundingBox();
    assert.ok(
      expiryBox && expiryBox.height > 8 && expiryBox.width > 20,
      `窄屏倒计时那一行没渲染出尺寸: ${JSON.stringify(expiryBox)}`,
    );
    assert.match(await expiryCell.innerText(), /小时后删除/, '窄屏倒计时文字不对');
    await page.screenshot({ path: SHOT('fb-library-mobile.png') });

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
    fs.rmSync(f1, { force: true });
    fs.rmSync(f2, { force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
