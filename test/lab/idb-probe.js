// 单独一个页面，不跑传输：只回答一个问题 ——
// Chromium 在"临时上下文（Playwright 的 context 就是隐身式）"里，逐帧存 600MB 的
// 128KiB 记录，事后还能不能都读回来？读不回来时 estimate/persisted 说了什么？
//
// 这是为了分清两种可能：
//   甲：浏览器把早期的 IndexedDB 记录驱逐了（best-effort 存储，可被回收）
//   乙：引擎自己把"没写成功"的块当成了已落盘
'use strict';
const fs = require('fs');
const path = require('path');

const MB = Number(process.argv.find((s) => s.startsWith('--mb=')) ? process.argv.find((s) => s.startsWith('--mb=')).split('=')[1] : 600);
const EXES = [process.env.XFER_LAB_CHROME, 'C:/Users/lhcz-fu/AppData/Local/Chromium/Application/chrome.exe'].filter(Boolean);
function findChromium() {
  for (const p of EXES) if (p && fs.existsSync(p)) return p;
  const root = 'C:/Users/lhcz-fu/AppData/Local/ms-playwright';
  try {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const p = path.join(root, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 没装 */ }
  return null;
}

const { startServer } = require('../helpers');

async function main() {
  const exe = findChromium();
  if (!exe) throw new Error('找不到 chromium');
  const { chromium } = require('C:/Users/lhcz-fu/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core');
  // 得有真 origin 才谈得上 IndexedDB：data: / file: 都是不透明源，量不到浏览器的配额行为
  const srv = await startServer({}, null, 91);
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${srv.base}/transfer.html`, { waitUntil: 'load' });
  const out = await page.evaluate(async ({ mb }) => {
    const BLOCK = 131072;
    const n = Math.round((mb * 1048576) / BLOCK);
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open('probe', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('frames');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const snap = async () => {
      const e = await navigator.storage.estimate();
      const p = await navigator.storage.persisted();
      return { usageMB: Math.round((e.usage || 0) / 1048576), quotaMB: Math.round((e.quota || 0) / 1048576), persisted: p };
    };
    const log = { before: await snap(), n, writeErrors: [], lostReads: [], sampledAfter: null };
    // 分批写：一次 100 条事务，避免一个巨型事务把内存吃掉
    for (let b = 0; b < n; b += 100) {
      const part = Math.min(100, n - b);
      try {
        await new Promise((res, rej) => {
          const tx = db.transaction('frames', 'readwrite');
          for (let k = 0; k < part; k++) {
            const u8 = new Uint8Array(BLOCK);
            u8[0] = (b + k) & 255; u8[1] = ((b + k) >> 8) & 255;
            tx.objectStore('frames').put(u8, `${b + k}`);
          }
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error || new Error('abort'));
        });
      } catch (e) { log.writeErrors.push(`${b}: ${e && e.message}`); }
      if (b % 1200 === 0) log.afterB = await snap();
    }
    log.afterWrite = await snap();
    const getIdb = (store, key) => new Promise((res) => {
      const rq = db.transaction(store).objectStore(store).get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res('ERR');
    });
    log.storedCount = await new Promise((res) => {
      const rq = db.transaction('frames').objectStore('frames').count();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(-1);
    });
    for (const i of [0, 1, 12, 900, 1799, 1800, 3000, 4200, n - 1]) {
      if (!(await getIdb('frames', `${i}`))) log.lostReads.push(i);
    }
    // 再静置一会儿读一次：驱逐可能发生在写入压力之后
    await new Promise((r) => setTimeout(r, 8000));
    log.sampledAfter = await snap();
    const again = [];
    for (const i of [0, 12, 1799, n - 1]) if (!(await getIdb('frames', `${i}`))) again.push(i);
    log.lostReadsAfterIdle = again;
    return log;
  }, { mb: MB });
  console.log(JSON.stringify(out, null, 1));
  console.log(out.lostReads.length || out.lostReadsAfterIdle.length
    ? `PROBE：早期记录确实读不回来（丢了 ${out.lostReads.length}+${out.lostReadsAfterIdle.length} 个采样点）→ 甲（浏览器驱逐）成立`
    : `PROBE：${MB}MB / ${out.n} 条全数读回，写入错 ${out.writeErrors.length} 条 → 乙（引擎记账）要另查`);
  await browser.close().catch(() => {});
  try { await srv.stop(); } catch { /* 已经停了 */ }
  process.exit(0);
}
main().catch((e) => { console.error('PROBE ERROR', e); process.exitCode = 2; process.exit(2); });

// 跑法：node test/lab/idb-probe.js --mb=600
