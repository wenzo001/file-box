// 界面冒烟（不属于 npm test）：真 Chromium、真服务器、两个页面上下文。
// 判据刻意打在**渲染结果**上，不打在代码里：
//   1) 接收端进度条 #r-blocks 的格子必须有真实尺寸与配色（以前这条长条一条样式都没有）；
//   2) 传输过程中格子要真的在变（帧数增长 → done 格子数增长），而不是停在 0；
//   3) 校验期间保存键必须 disabled 且带文案，校验完成后才可用；
//   4) 全程不许有未捕获异常 / console.error（paint 抛错会把传输一起弄死）。
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
const { startServer } = require('../helpers');

const MB = Number(process.env.SMOKE_MB || 6);
const EXE = 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe';

(async () => {
  const srv = await startServer({ XFER_CREATE_LIMIT: '100' });
  const tmp = path.join(require('os').tmpdir(), `smoke-${MB}mb.bin`);
  fs.writeFileSync(tmp, Buffer.alloc(MB * 1024 * 1024, 7));

  const browser = await chromium.launch({ executablePath: EXE });
  const errs = [];
  const mk = async () => {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
    return p;
  };
  const send = await mk();
  const recv = await mk();
  try {
    await send.goto(`${srv.base}/transfer.html#send`);
    await send.setInputFiles('#pick-in', tmp);
    await send.click('#start');

    // 码出来（指纹后台算，不该等它）
    const t0 = Date.now();
    let code = '';
    while (Date.now() - t0 < 15000 && !code) {
      code = await send.evaluate(() => (document.querySelector('#send-code') || {}).textContent || '');
      if (!code || code.length < 30) { code = ''; await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!code) throw new Error(`传输码没出来（用了 ${Date.now() - t0}ms）`);
    console.log(`[冒烟] 码已出（${Date.now() - t0}ms）：${code.slice(0, 12)}…`);

    await recv.goto(`${srv.base}/transfer.html#recv`);
    await recv.fill('#recv-in', code);
    // 在页面里就地记相位轨迹：跨进程 page.evaluate 一个来回就要十几毫秒，
    // 校验窗口若只有几十毫秒就会被整段跳过 —— 那会得出"界面没提示"的错误结论。
    // 顺带把保存键的 disabled/文案一起记下来，判据仍然打在渲染结果上。
    await recv.evaluate(() => {
      window.__phases = [];
      window.__saves = [];
      const tick = () => {
        const s = document.querySelector('#recv-status');
        const t = s ? s.textContent.split('\n')[0] : '';
        if (!window.__phases.length || window.__phases[window.__phases.length - 1] !== t) window.__phases.push(t);
        const b = document.querySelector('#recv-save');
        if (b) {
          const k = `${b.textContent}|${b.disabled}`;
          if (!window.__saves.includes(k)) window.__saves.push(k);
        }
      };
      window.__tick = setInterval(tick, 5);
      tick();
    });
    await recv.click('#recv-go');

    const snap = () => recv.evaluate(() => {
      const box = document.querySelector('#r-blocks');
      const cells = box ? [...box.children] : [];
      const done = cells.filter((c) => c.className.includes('done')).length;
      const c0 = cells[0];
      const st = c0 ? getComputedStyle(c0) : null;
      // 已完成的格子和未完成的格子必须是**不同**的颜色，否则"进度"这个词就没有意义
      const dEl = cells.find((c) => /\bdone\b/.test(c.className));
      const pEl = cells.find((c) => c.className === 'blk');
      const save = document.querySelector('#recv-save');
      return {
        visible: !!(box && !box.hidden),
        n: cells.length,
        done,
        w: st ? parseFloat(st.width) : 0,
        h: st ? parseFloat(st.height) : 0,
        bg: st ? st.backgroundColor : '',
        doneBg: dEl ? getComputedStyle(dEl).backgroundColor : '',
        plainBg: pEl ? getComputedStyle(pEl).backgroundColor : '',
        disp: box ? getComputedStyle(box).display : '',
        status: (document.querySelector('#recv-status') || {}).textContent || '',
        saveDisabled: save ? save.disabled : null,
        saveText: save ? save.textContent : '',
        doneWrap: !!(document.querySelector('#recv-done-wrap') || {}).checked,
        modeChips: [...document.querySelectorAll('#recv-mode .chip')].map((e) => e.textContent),
      };
    });

    // 等进度条出格子
    let s = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 30000) {
      s = await snap();
      if (s.visible && s.n > 0 && s.w > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log('[冒烟] 接收端长条：', JSON.stringify({ n: s.n, w: s.w, h: s.h, disp: s.disp, bg: s.bg }));
    if (!(s.n > 0)) throw new Error('接收端进度条没有格子');
    if (!(s.w >= 1 && s.h >= 1)) throw new Error(`接收端格子是零尺寸（${s.w}×${s.h}）—— 长条看不见，这就是"进度条不动"`);
    if (!/rgb/.test(s.bg)) throw new Error(`接收端格子没有配色：${s.bg}`);

    // 传输中 done 格子必须增长两次（真的在动），并且和未完成的格子不同色
    const seen = new Set();
    let colorSeen = null;
    const t2 = Date.now();
    while (Date.now() - t2 < 60000) {
      const x = await snap();
      seen.add(x.done);
      if (x.doneBg && x.plainBg && x.doneBg !== x.plainBg) colorSeen = `${x.doneBg} ≠ ${x.plainBg}`;
      if (x.done >= x.n && x.n > 0) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    const seq = [...seen].sort((a, b) => a - b);
    console.log('[冒烟] done 格子轨迹：', seq.join(' → '));
    if (seq.length < 2) throw new Error(`done 格子只出现过 ${seq.length} 个值：进度条没动`);
    if (!colorSeen) throw new Error('已完成/未完成的格子颜色相同：进度看不出来');
    console.log('[冒烟] 格子配色：', colorSeen);

    // 等校验完成。判据取的是页面里就地采的轨迹（5ms 一次），不是跨进程轮询：
    // 校验窗口可能只有几十毫秒，evaluate 一个来回就跳过去了。
    const t3 = Date.now();
    while (Date.now() - t3 < 120000) {
      const x = await snap();
      if (x.saveDisabled === false && /保存到这设备/.test(x.saveText)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const trail = await recv.evaluate(() => ({ phases: window.__phases, saves: window.__saves, stop: clearInterval(window.__tick) }));
    console.log('[冒烟] 相位轨迹：', trail.phases.join(' → '));
    console.log('[冒烟] 保存键轨迹：', trail.saves.join(' ｜ '));
    const lockedSeen = (trail.saves || []).find((k) => /\|true$/.test(k) && /校验中|正在写盘/.test(k));
    const fin = await snap();
    console.log('[冒烟] 结束态：', JSON.stringify({ save: fin.saveText, disabled: fin.saveDisabled, chips: fin.modeChips }));
    if (fin.saveDisabled !== false) throw new Error('校验完成后保存键仍然不可用');
    if (!lockedSeen) throw new Error('校验/写盘期间没有出现过"按不动 + 有文案"的状态');
    console.log(`[冒烟] 校验期间保存键：${lockedSeen}`);

    if (errs.length) throw new Error(`页面报了 ${errs.length} 条错：\n` + errs.map((e) => JSON.stringify(e)).slice(0, 8).join('\n'));
    console.log('SMOKE PASS');
  } finally {
    await browser.close().catch(() => {});
    await srv.stop().catch(() => {});
    fs.rmSync(tmp, { force: true });
  }
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
