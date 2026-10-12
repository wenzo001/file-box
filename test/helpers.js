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
    try {
      return await boot(dir, PORT, extra);
    } catch (err) {
      if (attempt >= 3 || !/EADDRINUSE/.test(err.message)) throw err;
    }
  }
}

async function boot(dir, PORT, extra) {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    HTTPS_PORT: String(PORT + 1),
    UPLOAD_DIR: path.join(dir, 'uploads'),
    STAGING_DIR: path.join(dir, 'uploading'),
    TRANSFER_DIR: path.join(dir, 'transfer'),
    STORAGE_LIMIT_GB: '1',
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

/** 走完整的分块上传：密文内容由 cipher(fileIdx,chunkIdx,len) 决定，与真实前端一致 */
async function uploadBundle(srv, key, files) {
  const init = await jget(`${srv.base}/api/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, files }),
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
