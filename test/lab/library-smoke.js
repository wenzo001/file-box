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
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(1, 5).join('\n')}`));
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

    // 目录栏头新建；输入框 10 字上限
    await page.locator('.column').first().getByRole('button', { name: '新建文件夹' }).click();
    const input = page.locator('.dialog .input');
    assert.strictEqual(await input.evaluate((el) => el.maxLength), 10, '目录名输入框没有 10 字上限');
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

    // 工具行常驻：勾选前后分栏卡片的 y 必须一模一样（旧选中栏一出现就把界面顶下去）
    const cardY = async () => Math.round((await page.locator('.columns').boundingBox()).y);
    // 工具行的可见标签在窄处会压短（全选 / 打包 / 取消），可访问名才是不变的契约 ⇒ 按 aria-label 找
    const toolBtn = (name) => page.locator(`.tool-actions .linkbtn[aria-label^="${name}"]`);
    const yIdle = await cardY();
    assert.strictEqual(await toolBtn('复制分享链接').isDisabled(), true, '一件没选时「复制分享链接」应不可点');
    assert.strictEqual(await toolBtn('删除').isDisabled(), true, '一件没选时「删除」应不可点');
    assert.strictEqual(await toolBtn('全选当前可见').isDisabled(), false, '「全选当前可见」是入口，必须一直可点');
    assert.strictEqual(await page.locator('.tool-count').innerText(), '未选择');
    await toolBtn('全选当前可见').click();
    await page.waitForTimeout(300);
    const yOn = await cardY();
    assert.strictEqual(yOn, yIdle, `勾选后界面被顶下去 ${yOn - yIdle}px，工具行不该改变布局`);
    assert.strictEqual(await toolBtn('复制分享链接').isDisabled(), false, '勾选后「复制分享链接」应可用');
    assert.match(await page.locator('.tool-count').innerText(), /已选 \d+ 项/);
    await toolBtn('取消').click();
    await page.waitForTimeout(250);
    assert.strictEqual(await page.locator('.tool-count').innerText(), '未选择', '取消后计数没回到「未选择」');
    assert.strictEqual(await cardY(), yIdle, '取消选择后界面高度回不去');

    // 目录「⋯」菜单：重命名 / 删除 / 分享链接都在
    await parent.locator('.col-more').click();
    const folderMenu = await page.locator('.context-menu .menu-item').allInnerTexts();
    assert.ok(folderMenu.includes('重命名') && folderMenu.includes('删除文件夹') && folderMenu.includes('复制文件夹链接'));

    // 自绘右键菜单拿不到 Reka 的 data-highlighted，三态必须自己画：hover 变底色、删除标红、禁用不亮
    const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
    const fg = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
    const renameItem = page.locator('.context-menu .menu-item', { hasText: '重命名' });
    const dangerItem = page.locator('.context-menu .menu-item.danger');
    assert.strictEqual(await dangerItem.count(), 1, '目录菜单里没有唯一那颗删除项');
    const idleBg = await bg(renameItem);
    assert.notStrictEqual(await fg(dangerItem), await fg(renameItem), '删除项文字色和普通项一样，没标红');
    await renameItem.hover();
    const hoverBg = await bg(renameItem);
    assert.notStrictEqual(hoverBg, idleBg, `菜单项 hover 没有反馈：底色前后都是 ${idleBg}`);
    await dangerItem.hover();
    assert.notStrictEqual(await bg(dangerItem), idleBg, '删除项 hover 没画底色');
    await page.keyboard.press('Escape');

    // 「禁用项不许被 hover 点亮」这条腿原先拿「未分档」那颗禁用的删除项当靶子；
    // 系统目录取消之后菜单里再没有禁用项（重命名只在没有清单的旧数据上是禁用的），
    // 这一格改由 test/format.test.js 的静态门守着（.menu-item:disabled 必须真声明 opacity），
    // 行为层的同形状判据登记为欠账：造一条旧数据才能再验一次。

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

    console.log('[step] 目录 zip');
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

    console.log('[step] 多选 zip');
    // 多选 zip
    await page.locator('.file-row .col-check').nth(0).check();
    await page.locator('.file-row .col-check').nth(1).check();
    const [dl2] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      toolBtn('打包下载').click(),
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
    // 目录行要标大小（目录汇总），文件行也要标（清单里的真实大小）
    assert.match(projectMeta, /\d+(\.\d+)?\s?(B|KB|MB|GB)/, `目录行没标大小：${projectMeta}`);
    const fileMeta = await page.locator('.file-row').first().locator('.col-meta').innerText();
    assert.match(fileMeta, /\d+(\.\d+)?\s?(B|KB|MB|GB)/, `文件行没标大小：${fileMeta}`);
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

    // ---- 拖拽移动（真鼠标，落点由 @formkit/drag-and-drop 决定）：放在最后，避免改动前面几条的夹具 ----
    for (const name of ['拖拽去处', '拖拽载体']) {
      await page.locator('.column').first().getByRole('button', { name: '新建文件夹' }).click();
      await page.locator('.dialog .input').fill(name);
      await page.locator('.dialog .btn-primary').click();
      await page.waitForSelector(`.folder-row:has-text("${name}")`);
    }
    const rowOf = (name) => page.locator('.col-row', { hasText: name }).first();

    // 文件行拖到别的目录行：只搬这一条，同批另一条留在原批次
    const before = await (await fetch(`${srv.base}/api/library`)).json();
    const src = before.batches.find((b) => b.count === 2);
    const toFolder = before.folders.find((f) => f.name === '拖拽去处');
    assert.ok(src && toFolder, '夹具里没有两文件的批次或目标目录，后面判据无从比对');
    // 用户要的是「没松手什么都不执行」：这里真的**按住 1 秒**再松，而不是用原子化的 dragTo。
    // 按住期间：① 不许有移动请求；② 目标行要亮出「接受」样式（.drop-here）。
    await page.evaluate(() => {
      window.__moveReqs = [];
      const realFetch = window.fetch;
      window.fetch = (input, opt = {}) => {
        const url = String(input && input.url ? input.url : input);
        if (/\/api\/(batches\/[^/]+\/file-move|folders\/)/.test(url)) window.__moveReqs.push(url);
        return realFetch(input, opt);
      };
    });
    const srcBox = await rowOf('fb-library-甲.txt').boundingBox();
    const dstBox = await rowOf('拖拽去处').boundingBox();
    await page.mouse.move(srcBox.x + srcBox.width * 0.4, srcBox.y + srcBox.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(
        srcBox.x + srcBox.width * 0.4 + (dstBox.x + 40 - (srcBox.x + srcBox.width * 0.4)) * (i / 15),
        srcBox.y + srcBox.height / 2 + (dstBox.y + dstBox.height / 2 - (srcBox.y + srcBox.height / 2)) * (i / 15),
      );
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(900); // 按住不放
    const held = await page.evaluate(() => ({
      reqs: window.__moveReqs.slice(),
      rowHere: [...document.querySelectorAll('.col-row.drop-here')].map((n) => n.textContent.trim().slice(0, 14)),
      colHere: document.querySelectorAll('.column.drop-here').length,
    }));
    assert.deepStrictEqual(held.reqs, [], `鼠标还没松手就发出去了：${JSON.stringify(held.reqs)}`);
    assert.ok(held.rowHere.some((t) => t.includes('拖拽去处')),
      `悬停在目标目录上时没有「接受」样式：${JSON.stringify(held)}`);
    assert.ok(held.colHere >= 1, '悬停的那一栏没有落点提示（.drop-here）');
    await page.mouse.up();
    await page.waitForFunction(async (id) => {
      const l = await (await fetch(`${location.origin}/api/library`)).json();
      return l.batches.some((b) => b.folderId === id && b.count === 1);
    }, toFolder.id, { timeout: 20000 });
    const released = await page.evaluate(() => window.__moveReqs.slice());
    assert.strictEqual(released.length, 1, `松手后应当恰好发出一次移动请求：${JSON.stringify(released)}`);
    lib = await (await fetch(`${srv.base}/api/library`)).json();
    const landed = lib.batches.filter((b) => b.folderId === toFolder.id);
    assert.strictEqual(landed.length, 1, `拖进来的这条没有单独成批: `
      + `去处=${toFolder.id} 全部批次=${JSON.stringify(lib.batches.map((b) => [b.name, b.folderId, b.count]))} `
      + `目录=${JSON.stringify(lib.folders.map((f) => [f.name, f.id]))}`);
    assert.strictEqual(landed[0].count, 1, '拖一条不该把同批另一条也带走');
    assert.strictEqual(lib.batches.find((b) => b.name === src.name).count, 1, '源批次没剩下那一条');

    // 目录行拖到别的目录行（同一栏内）：换父级。前置断言必须有：否则"夹具本来就把它放那儿"会伪装成拖拽成功
    let pre = await (await fetch(`${srv.base}/api/library`)).json();
    const preTarget = pre.folders.find((f) => f.name === '拖拽去处');
    const preKid = pre.folders.find((f) => f.name === '拖拽载体');
    assert.notStrictEqual(preKid.parentId, preTarget.id, '拖之前「拖拽载体」就已经在目标目录里，这条判据是空的');
    // 只断"父级变了"不够：那件事可能不是这次调用干的。要同时抓到这次 PATCH 真的发出去了。
    const patched = [];
    const spy = (req) => { if (req.method() === 'PATCH' && req.url().includes('/api/folders/')) patched.push(req.url()); };
    page.on('request', spy);
    await rowOf('拖拽载体').dragTo(rowOf('拖拽去处'));
    await page.waitForFunction(async () => {
      const l = await (await fetch(`${location.origin}/api/library`)).json();
      const target = l.folders.find((f) => f.name === '拖拽去处');
      const kid = l.folders.find((f) => f.name === '拖拽载体');
      return Boolean(kid.parentId && kid.parentId === target.id);
    }, null, { timeout: 20000 });
    page.off('request', spy);
    assert.ok(patched.length >= 1, '拖拽目录行没有发出改父级的 PATCH —— 父级变化不能归因于这次拖拽');

    // 窄屏：当前目录的行必须真的在视野里，且倒计时那一行要画得出来
    // （2026-10 重构后 ≤700px 换的是手机档那棵壳，`.column` 已经不存在了 ——
    //   这里不能再按"最后一栏"找行，改按"这一屏看得见的文件行"找，判的是同一件事：别把内容挤到视野外）
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const box = await page.locator('.file-row').first().boundingBox();
    assert.ok(box && box.x >= 0 && box.x < 390 && box.y >= 0 && box.y < 844,
      `窄屏下当前目录的行不在视野内: ${JSON.stringify(box)}`);
    // 三行都要真渲染：旧表格的窄屏规则曾把倒计时那一行整行 display:none 掉
    const expiryCell = page.locator('.file-row .col-expiry').first();
    const expiryBox = await expiryCell.boundingBox();
    assert.ok(
      expiryBox && expiryBox.height > 8 && expiryBox.width > 20,
      `窄屏倒计时那一行没渲染出尺寸: ${JSON.stringify(expiryBox)}`,
    );
    assert.match(await expiryCell.innerText(), /小时后删除/, '窄屏倒计时文字不对');
    await page.screenshot({ path: SHOT('fb-library-mobile.png') });

    // ---- 一键清空：确认词不对不许动，打对了要真删光，但目录树与历史累计留着 ----
    const readLib = () => fetch(`${srv.base}/api/library`).then((r) => r.json());
    const libBefore = await readLib();
    assert.ok(libBefore.batches.length > 0, '前置：清空前要有批次');
    assert.ok(libBefore.downloadsTotal >= 1, '前置：前面几条腿下载过，累计不该是 0');
    assert.ok(libBefore.wipeConfirm, '前置：确认词要由服务端下发（界面不再自己存一份）');
    // 窄屏的配置条收进了设置底表（这条腿走桌面入口）：先回到桌面档
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.locator('.wipe-open').click();
    await page.waitForSelector('.dialog', { state: 'visible' });
    // 回车 = 按「清空所有文件」：这里空着确认词按下去，必须被挡住而不是静默
    assert.strictEqual(await page.evaluate(() => document.activeElement?.classList?.contains('input')), true,
      '清空弹层打开后焦点不在确认词输入框里');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.dialog .dialog-error');
    await page.screenshot({ path: SHOT('fb-wipe-dialog.png') });
    // 危险键悬停时不许变隐形：.btn:hover 是 (0,2,0)，没有自己的 hover 规则时红底会被换成 --fill，白字压在浅灰上
    const dangerBtn = page.locator('.dialog .btn-danger');
    const bgIdle = await dangerBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    await dangerBtn.hover();
    const bgHover = await dangerBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.strictEqual(bgHover, bgIdle,
      `危险键悬停后底色变了（${bgIdle} → ${bgHover}）：.btn:hover 的权重比 .btn-danger 高，白字会压在浅灰上`);
    // "看得清"单独量一遍：底色要按 alpha 逐层合成（rgba(0,0,0,.045) 不是黑）
    const dangerContrast = await dangerBtn.evaluate((el) => {
      const nums = (s) => (s.match(/[\d.]+/g) || []).map(Number);
      const lum = (c) => c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; })
        .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      let acc = [255, 255, 255];
      for (let n = el; n; n = n.parentElement) {
        const c = nums(getComputedStyle(n).backgroundColor);
        if (!c.length || (c.length === 4 && c[3] === 0)) continue;
        const a = c.length === 4 ? c[3] : 1;
        acc = c.slice(0, 3).map((v, i) => v * a + acc[i] * (1 - a));
        if (a >= 1) break;
      }
      const fg = lum(nums(getComputedStyle(el).color).slice(0, 3));
      const bg = lum(acc);
      return Number(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toFixed(2));
    });
    assert.ok(dangerContrast >= 4.5, `危险键悬停后文字对比度只有 ${dangerContrast}:1（底色 ${bgHover}）`);
    const stillThere = await readLib();
    assert.strictEqual(stillThere.batches.length, libBefore.batches.length, '确认词没打对就把文件删了');
    await page.locator('.dialog .input').fill(libBefore.wipeConfirm);
    await page.locator('.dialog .btn-danger').click();
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 20000 });
    const libAfter = await readLib();
    assert.strictEqual(libAfter.batches.length, 0, '清空后索引里还有批次');
    assert.strictEqual(libAfter.folders.length, libBefore.folders.length, '目录树必须原样保留');
    assert.strictEqual(libAfter.downloadsTotal, libBefore.downloadsTotal, '历史累计下载不许被清空');
    assert.strictEqual(await page.locator('.file-row').count(), 0, '清空后界面上还看得见文件行');
    // 顶栏那颗容量药丸是"历史累计下载"在桌面档唯一的落点（旧类名 .topbar-usage 已随旧壳删掉）
    assert.match(
      await page.locator('.usage-chip').first().evaluate((el) => el.textContent || ''),
      /下载 \d+ 次/,
      '顶栏没显示历史累计下载',
    );

    // ---- 清空的回执丢了（服务在重启 / 网络掐了）：界面不许只甩一句"失败" ----
    // ① 请求根本没到服务器 → 仍报错，但要报"服务器上还有几个文件"；② 服务端做完了、回执丢了 → 自己去核对真实状态并按已清空收掉
    await page.locator('input[type=file]').setInputFiles([f1]);
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length >= 1, null, { timeout: 30000 });
    let wipeMode = 'block';
    await page.route('**/api/maintenance/wipe', async (route) => {
      if (wipeMode === 'block') return route.abort('failed');
      await route.fetch(); // 真发到服务端（它会删干净），再把客户端这一掐断
      await route.abort('failed');
    });
    const errsBeforeWipeProbe = errs.length;
    await page.locator('.wipe-open').click();
    await page.locator('.dialog .input').fill(libBefore.wipeConfirm);
    await page.locator('.dialog .btn-danger').click();
    await page.waitForFunction(() => /服务器上还有 1 个文件/.test(document.querySelector('.dialog .dialog-error')?.textContent || ''), null, { timeout: 15000 });
    console.log('[library-smoke] 回执丢失①：', await page.locator('.dialog .dialog-error').innerText());
    wipeMode = 'lost';
    await page.locator('.dialog .btn-danger').click();
    await page.waitForFunction(() => /连接中断，但服务器已确认清空/.test(document.querySelector('.toast')?.textContent || ''), null, { timeout: 10000 });
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 20000 });
    const libLost = await readLib();
    assert.strictEqual(libLost.batches.length, 0, '回执丢失②：弹层自己核对后仍没清干净');
    await page.unroute('**/api/maintenance/wipe');
    await page.waitForTimeout(600); // 掐断产生的 console 错误要等它落地，再按"故意掐的"收走
    // 这两发是台架故意掐的：掐出来的 console 报错逐条核对，别让它替真错误挡枪
    const provoked = errs.splice(errsBeforeWipeProbe);
    // 只放行"连接被掐断"这一种（404/500 之类的真错误不许在这里被吞掉）
    assert.ok(provoked.length > 0 && provoked.every((e) => /net::ERR_FAILED/.test(e)),
      `故意掐断清空请求带出了没预料到的错误：\n${provoked.join('\n')}`);

    assert.deepStrictEqual(errs, [], `浏览器有 console/page 错误:\n${errs.join('\n')}`);
    console.log('[library-smoke] 通过');
    console.log('[library-smoke] 截图:', SHOT('fb-library-desktop.png'), SHOT('fb-library-mobile.png'));
  } catch (err) {
    await page.screenshot({ path: SHOT('fb-library-fail.png'), fullPage: true }).catch(() => {});
    // 失败时把任务行倒出来：卡在"等下载事件"时，真正的交代常常写在这里
    console.error('[library-smoke] 任务行:', JSON.stringify(await page.locator('.task').allInnerTexts().catch(() => [])));
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
