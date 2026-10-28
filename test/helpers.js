// 测试夹具：把 server.js 起在一个独立的临时目录上（不碰仓库的 uploads/ 与 .uploading/），
// 测完连目录一起删。端口按 pid 错开，避免与开发者自己开着的实例撞。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 起服务；extra 传业务相关的环境变量（如 UPLOAD_TTL_HOURS / XFER_TTL_MINUTES） */
async function startServer(extra = {}, dirOverride = null, slot = 0) {
  const dir = dirOverride || fs.mkdtempSync(path.join(os.tmpdir(), 'fbtest-'));
  // 每个测试文件是独立进程，端口按 pid + slot 错开；真撞上就换个再来一次
  for (let attempt = 0; ; attempt++) {
    const PORT = 4600 + (process.pid % 300) + slot * 37 + attempt * 41;
    // fetch（undici）有一份"禁用端口"名单（5002-5157、6665-6669 那几段），命中时**服务端能正常 bind，
    // 客户端却直接抛 bad port** —— 于是同一条腿会因为当时算出来的端口而整轮变红，
    // 看起来完全不像测试的问题（实测 downloadstats 那条"重启后计数还在"就这么红过一次）。
    if (await portIsBlocked(PORT)) {
      if (attempt >= 11) throw new Error(`端口一直撞在 fetch 的禁用名单上（最后试的是 ${PORT}）—— 夹具的取端口方式要改`);
      continue;
    }
    try {
      return await boot(dir, PORT, extra);
    } catch (err) {
      if (attempt >= 3 || !/EADDRINUSE/.test(err.message)) throw err;
    }
  }
}

/** 只问一件事：这个端口 undici 肯不肯拿去做 fetch。绑得住但客户端拒绝的端口必须提前绕开。
 *  用模块加载时取到的原生 fetch —— 台架会把 globalThis.fetch 换成注入器，这里不该被它记账。 */
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);
async function portIsBlocked(p) {
  try { await NATIVE_FETCH(`http://127.0.0.1:${p}/`); return false; }
  catch (err) { return /bad port/.test(String((err && err.cause && err.cause.message) || err)); }
}

async function boot(dir, PORT, extra) {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    HTTPS_PORT: String(PORT + 1),
    UPLOAD_DIR: path.join(dir, 'uploads'),
    STAGING_DIR: path.join(dir, 'uploading'),
    TRANSFER_DIR: path.join(dir, 'transfer'),
    LIBRARY_DIR: path.join(dir, 'library'),
    TTL_SWEEP_MS: '60000',
    STORAGE_LIMIT_GB: '1',
    // 夹具默认关掉 1.5 秒扫描缓存：多数测试是"往盘上写一笔就要立刻看见"，
    // 缓存本身由 library-api 里那条专门的腿按 1500ms 验。
    SCAN_CACHE_MS: '0',
    // 每个测试进程都去抢同一个 UDP 3478 没有意义（也没法并行跑）。默认关掉内置 STUN，
    // 只有 stun / 配置相关的腿自己显式指定端口。
    STUN_PORT: '0',
    NODE_NO_WARNINGS: '1',
  }, extra);
  const child = cp.spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const t0 = Date.now();
  while (!/file-box 已启动/.test(log)) {
    if (/EADDRINUSE/.test(log)) {
      cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      throw new Error('EADDRINUSE 端口被占，换一个');
    }
    if (Date.now() - t0 > 15000) throw new Error('服务没起来: ' + log.slice(-500));
    await new Promise((r) => setTimeout(r, 60));
  }
  let stopped = false;
  return {
    port: PORT,
    base: `http://127.0.0.1:${PORT}`,
    dir,
    log: () => log,
    child,
    async stop(opts = {}) {
      if (!stopped) {
        stopped = true;
        // 先问"还在不在"再动手：进程自己退了的话，taskkill 只会丢一个没头没尾的 128，
        // 把退出码和日志尾巴交出来才知道是被测服务崩了还是夹具在找茬
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise((r) => {
            child.once('exit', r);
            cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            setTimeout(r, 3000);
          });
        } else {
          throw new Error(`被测服务提前退出（code=${child.exitCode} signal=${child.signalCode}）：\n${log.slice(-600)}`);
        }
      }
      // keep:true：重启类测试要留着数据目录再起一次，删了就没现场可验
      if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

const jget = async (url, opt) => {
  const res = await fetch(url, opt);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

/** 走完整的分块上传：密文内容由 cipher(fileIdx,chunkIdx,len) 决定，与真实前端一致。
 *  extra 用于目录 / TTL 等新字段（如 { folderId, ttlHours }）。 */
async function uploadBundle(srv, key, files, extra = {}) {
  const init = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 只声明 {enc, chunks}：夹具里的 data（密文分片）不该跟着进 init 的 JSON，
    // 否则 6MB 的夹具会先撞上 init 的 2MB 请求体上限（413）
    body: JSON.stringify({ key, files: files.map(({ enc, chunks }) => ({ enc, chunks })), ...extra }),
  });
  if (init.status !== 200) throw new Error(`init ${init.status}: ${JSON.stringify(init.body)}`);
  for (let fi = 0; fi < files.length; fi++) {
    for (let ci = 0; ci < files[fi].chunks.length; ci++) {
      const buf = files[fi].data ? files[fi].data[ci] : Buffer.alloc(files[fi].chunks[ci], fi + ci + 1);
      const r = await fetch(`${srv.base}/api/upload/part?u=${key}&f=${fi}&c=${ci}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Crc': crc32(buf).toString(16).padStart(8, '0') },
        body: buf,
      });
      if (r.status !== 200) throw new Error(`part ${fi}/${ci} ${r.status}: ${JSON.stringify(await r.json().catch(() => ({})))}`);
    }
  }
  const fin = await jget(`${srv.base}/api/upload/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: key }),
  });
  if (fin.status !== 200) throw new Error(`finish ${fin.status}: ${JSON.stringify(fin.body)}`);
  return fin.body;
}

const hexKey = (n = 40) => {
  let s = '';
  while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};

module.exports = { startServer, jget, uploadBundle, crc32, hexKey };
