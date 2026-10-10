const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const express = require('express');
const selfsigned = require('selfsigned');

const app = express();
app.use(express.json({ limit: '2mb' })); // init/finish 这类小 JSON 请求体

// ---- 配置（均可通过环境变量覆盖） ----
const PORT = Number(process.env.PORT) || 3000;              // HTTP 端口（完整服务）
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;   // HTTPS 端口（传输层加密 + 原生加密引擎）
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const STORAGE_LIMIT_GB = Number(process.env.STORAGE_LIMIT_GB) || 10; // 存储总量上限
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 90;      // 超过 N 天的目录自动清理
const STORAGE_LIMIT = STORAGE_LIMIT_GB * 1024 * 1024 * 1024;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// 加密清单文件名（前端生成；列表计数时排除）
const MANIFEST = 'manifest.enc';

// ---- 基础目录（不存在会自动创建） ----
function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
ensureUploadDir();

// ---- 自签证书（首次启动自动生成，存入 .certs/，之后复用） ----
async function ensureCert() {
  const dir = path.join(__dirname, '.certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'file-box' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('[证书] 已自动生成自签证书（.certs/），浏览器首次访问需手动信任一次');
  return { key: pems.private, cert: pems.cert };
}

// ---- 工具函数 ----
/** 生成文件夹名：日期+时间，精确到分钟，如 20260923_1430 */
function folderName(now) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_` +
    `${p(now.getHours())}${p(now.getMinutes())}`
  );
}

/** 文件名安全化：去掉路径分隔符，避免目录穿越 */
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[/\\]/g, '_').trim();
  return base === '.' || base === '..' || base === '' ? '' : base;
}

// ---- 存储空间统计与过期清理 ----
/** 递归统计目录占用字节数 */
function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

/** 从目录名解析上传时间戳（仅识别 YYYYMMDD_HHmm 格式） */
function folderTime(name) {
  const m = String(name).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

/** 清理超过保留期的目录（自动运行：启动时、每 6 小时、每次上传前） */
function cleanupExpired() {
  ensureUploadDir();
  const now = Date.now();
  const removed = [];
  for (const d of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const t = folderTime(d.name);
    if (t !== null && now - t > RETENTION_MS) {
      fs.rmSync(path.join(UPLOAD_DIR, d.name), { recursive: true, force: true });
      removed.push(d.name);
    }
  }
  if (removed.length) {
    console.log(`[清理] 已自动删除超过 ${RETENTION_DAYS} 天的目录: ${removed.join(', ')}`);
  }
}
cleanupExpired();
setInterval(cleanupExpired, 6 * 60 * 60 * 1000).unref();

// ---- 上传：分块 + 断点续传 ----
// 分块先落到 uploads 之外的 .uploading/<批次>/，全部块传完再按「完成那一刻」的时间
// 命名并搬进 uploads。所以：列表里永远看不到上传到一半的目录，展示的时间就是传完的时刻。
// 中断后重新发起同一批文件（客户端用批次指纹识别），只补缺失的块即可接着传。
const STAGING_DIR = path.join(__dirname, '.uploading');
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 未完成批次留一天，够断点续传，过期回收
const MAX_CHUNK = 32 * 1024 * 1024;        // 单块上限（客户端约 4MB 一块）
const MAX_FILES = 200;                     // 单批文件数上限

function ensureStagingDir() {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}
ensureStagingDir();

const isUploadId = (id) => /^[a-f0-9]{16,64}$/.test(String(id || ''));
const uploadDirOf = (id) => path.join(STAGING_DIR, String(id));

/** 回收过期未完成批次（进程被杀、客户端再也不回来） */
function sweepStaging(maxAgeMs = UPLOAD_TTL_MS) {
  ensureStagingDir();
  const now = Date.now();
  for (const name of fs.readdirSync(STAGING_DIR)) {
    const p = path.join(STAGING_DIR, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (now - st.mtimeMs > maxAgeMs) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`[上传] 回收过期未完成的批次 ${name}`);
    }
  }
}
sweepStaging(0); // 启动时：上个进程的批次都已随进程中断，直接清干净
setInterval(() => sweepStaging(), 6 * 60 * 60 * 1000).unref();

const readMeta = (id) => {
  try { return JSON.parse(fs.readFileSync(path.join(uploadDirOf(id), 'meta.json'), 'utf8')); } catch { return null; }
};

/** 磁盘上已收到的块（不信内存状态，重启后依然准确） */
function haveParts(id) {
  let names;
  try { names = fs.readdirSync(uploadDirOf(id)); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = n.match(/^part-(\d+)-(\d+)\.bin$/);
    if (m) out.push({ f: Number(m[1]), c: Number(m[2]) });
  }
  return out;
}

/** 这些名字在批次目录里有特殊用途，声明成文件会把账本/分块覆盖掉（例如叫 part-0-1.bin
 *  会让合并时把文件往自己身上追加），一律拒绝 */
const RESERVED_NAME = /^(meta\.json|part-\d+-\d+\.(bin|tmp))$/;

/** 校验分块声明：文件名安全、不重复、不是保留名、块大小在范围内 */
function metaProblem(files) {
  if (!Array.isArray(files) || !files.length) return '没有文件';
  if (files.length > MAX_FILES) return `单次最多 ${MAX_FILES} 个文件`;
  const seen = new Set();
  for (const f of files) {
    if (!f || typeof f.enc !== 'string' || !f.enc || safeName(f.enc) !== f.enc) return '文件名不合法';
    if (RESERVED_NAME.test(f.enc)) return `文件名被占用: ${f.enc}`;
    if (seen.has(f.enc)) return `文件名重复: ${f.enc}`;
    seen.add(f.enc);
    if (!Array.isArray(f.chunks) || !f.chunks.length) return '分块信息不合法';
    for (const c of f.chunks) {
      if (!Number.isInteger(c) || c <= 0 || c > MAX_CHUNK) return '分块大小不合法';
    }
  }
  return null;
}

/** 这批声明要占多少字节 */
const declaredBytes = (files) => files.reduce((s, f) => s + f.chunks.reduce((a, b) => a + b, 0), 0);

/** 把暂存目录搬进 uploads，名字用完成时刻；撞上同分钟的批次就追加序号 */
function commitStaging(stagingDir) {
  const base = folderName(new Date());
  for (let i = 1; i <= 50; i++) {
    const name = i === 1 ? base : `${base}_${i}`;
    const target = path.join(UPLOAD_DIR, name);
    try {
      if (fs.existsSync(target)) continue;
      fs.renameSync(stagingDir, target); // 同盘 rename，一步到位
      return name;
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'EPERM') continue; // 并发抢了同名目录，换下一个
      throw err;
    }
  }
  throw new Error('同一分钟内上传批次过多，请稍后重试');
}

const storageFull = () => dirSize(UPLOAD_DIR) + dirSize(STAGING_DIR) >= STORAGE_LIMIT;
const tooLarge = (res) =>
  res.status(413).json({ error: `存储空间已达上限（${STORAGE_LIMIT_GB}GB），请先删除无用文件` });

// 已用空间带 30 秒缓存：分块写入路径上要频繁判断，不能每块都全盘遍历一遍
let usageCache = { at: 0, bytes: 0 };
function usedBytes() {
  if (Date.now() - usageCache.at > 30 * 1000) {
    usageCache = { at: Date.now(), bytes: dirSize(UPLOAD_DIR) + dirSize(STAGING_DIR) };
  }
  return usageCache.bytes;
}
const forgetUsage = () => { usageCache.at = 0; }; // 提交/删除后立刻失效，别让缓存骗人

// 1) 申请批次：同一指纹（同一批文件）会拿回同一个批次和已传的块，用于断点续传
app.post('/api/upload/init', (req, res) => {
  cleanupExpired();
  const { key, files } = req.body || {};
  if (typeof key !== 'string' || !/^[a-f0-9]{16,64}$/.test(key)) {
    return res.status(400).json({ error: '批次标识不合法' });
  }
  const bad = metaProblem(files);
  if (bad) return res.status(400).json({ error: bad });
  // 上限要连着「这批声明的字节」一起算：只看到当前占用的话，分块是逐个写进来的，没人拦
  const stagedHere = fs.existsSync(uploadDirOf(key)) ? dirSize(uploadDirOf(key)) : 0;
  const declared = declaredBytes(files);
  if (usedBytes() - stagedHere + declared > STORAGE_LIMIT) return tooLarge(res);

  const dir = uploadDirOf(key);
  const old = readMeta(key);
  // 同一指纹但分块布局变了（换了引擎/文件变了）：旧块不可用，整批重来
  const sameLayout = old && JSON.stringify(old.files) === JSON.stringify(files);
  if (old && !sameLayout) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[上传] 批次 ${key.slice(0, 8)} 分块布局变化，重新开始`);
  }
  if (!sameLayout) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ v: 1, key, files }));
  }
  const have = sameLayout ? haveParts(key) : [];
  const total = files.reduce((s, f) => s + f.chunks.length, 0);
  res.json({ ok: true, uploadId: key, have, total, resumed: have.length > 0 });
});

// 2) 传一块：大小必须与声明一致，先写 .tmp 再改名，断连不会留下"看起来完整"的半块
app.put('/api/upload/part', express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK }), (req, res) => {
  const { u, f, c } = req.query;
  const meta = isUploadId(u) ? readMeta(u) : null;
  if (!meta) return res.status(404).json({ error: '上传已过期，请重新开始' });
  const fi = Number(f);
  const ci = Number(c);
  const file = meta.files[fi];
  if (!file || !Number.isInteger(ci) || ci < 0 || ci >= file.chunks.length) {
    return res.status(400).json({ error: '分块序号不合法' });
  }
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length !== file.chunks[ci]) {
    return res.status(400).json({ error: '分块大小与声明不一致' });
  }
  // 预检：这次要写进来的字节会不会把上限撑破（缓存按块累加，数字是准的）
  if (usedBytes() + buf.length > STORAGE_LIMIT) return tooLarge(res);
  const dir = uploadDirOf(u);
  const tmp = path.join(dir, `part-${fi}-${ci}.tmp`);
  const dst = path.join(dir, `part-${fi}-${ci}.bin`);
  const existed = fs.existsSync(dst);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dst);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return res.status(500).json({ error: '写入分块失败' });
  }
  if (!existed) usageCache.bytes += buf.length; // 只加新增的，重传同一块不重复计
  res.json({ ok: true, size: buf.length });
});

// 3) 收尾：校验块齐了 → 按序拼成文件 → 迁入 uploads（此时才出现在列表里）
app.post('/api/upload/finish', (req, res) => {
  const { uploadId } = req.body || {};
  const meta = isUploadId(uploadId) ? readMeta(uploadId) : null;
  if (!meta) return res.status(404).json({ error: '上传已过期，请重新开始' });
  const dir = uploadDirOf(uploadId);
  const have = new Set(haveParts(uploadId).map((p) => `${p.f}-${p.c}`));
  const total = meta.files.reduce((s, f) => s + f.chunks.length, 0);
  if (have.size !== total) {
    return res.status(409).json({ error: `还有 ${total - have.size} 块没传完`, have: [...have] });
  }
  (async () => {
    try {
      if (usedBytes() >= STORAGE_LIMIT) return tooLarge(res); // 落盘前再确认一次，别把上限撑破
      for (let fi = 0; fi < meta.files.length; fi++) {
        const f = meta.files[fi];
        const out = path.join(dir, f.enc);
        for (let ci = 0; ci < f.chunks.length; ci++) {
          const part = path.join(dir, `part-${fi}-${ci}.bin`);
          await pipeline(fs.createReadStream(part), fs.createWriteStream(out, { flags: 'a' }));
          fs.rmSync(part, { force: true }); // 拼一块删一块，峰值不翻倍
        }
      }
      // 拼完就把批次账本与残余分块清掉，别让它们跟着 rename 进 uploads
      fs.rmSync(path.join(dir, 'meta.json'), { force: true });
      for (const leftover of fs.readdirSync(dir)) {
        if (/^part-\d+-\d+\.(bin|tmp)$/.test(leftover)) fs.rmSync(path.join(dir, leftover), { force: true });
      }
      const folder = commitStaging(dir); // 名字 = 完成时刻
      forgetUsage(); // 刚搬进 uploads，缓存里的占用已经不准了
      res.json({ ok: true, folder, count: meta.files.filter((f) => f.enc !== MANIFEST).length });
    } catch (err) {
      console.error('[上传] 合并分块失败', err);
      try {
        if (!res.headersSent) res.status(500).json({ error: `合并分块失败：${err.message}` });
      } catch { /* 连接已经断了，没什么可做的 */ }
    }
  })().catch((err) => console.error('[上传] 收尾流程异常', err));
});

// ---- 文件列表（按时间倒序：新的在前） ----
// 文件名/大小来自磁盘（密文名）；真实文件名在前端解密 manifest.enc 后还原
app.get('/api/list', (req, res) => {
  ensureUploadDir();
  const folders = fs
    .readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(UPLOAD_DIR, d.name);
      const files = fs
        .readdirSync(dir)
        .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        name: d.name,
        count: files.filter((f) => f.name !== MANIFEST).length,
        size: files.reduce((s, f) => s + f.size, 0),
        files,
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  const used = folders.reduce((s, f) => s + f.size, 0);
  res.json({
    folders,
    usage: { used, limit: STORAGE_LIMIT, limitGB: STORAGE_LIMIT_GB, retentionDays: RETENTION_DAYS },
    httpsPort: HTTPS_PORT,
  });
});

// ---- 删除整个目录（谨慎操作：前端有确认弹层） ----
app.delete('/api/folder/:folder', (req, res) => {
  const folder = safeName(req.params.folder);
  if (!folder) return res.status(400).json({ error: '目录名无效' });
  const dir = path.join(UPLOAD_DIR, folder);
  if (dir.indexOf(UPLOAD_DIR + path.sep) !== 0) {
    return res.status(400).json({ error: '目录名无效' });
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(404).json({ error: '目录不存在' });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  forgetUsage(); // 腾出的空间要立刻反映到上限判断上
  res.json({ ok: true });
});

// ---- 下载单个文件（密文，前端收到后自动解密） ----
app.get('/api/download/:folder/:file', (req, res) => {
  const folder = safeName(req.params.folder);
  const file = safeName(req.params.file);
  if (!folder || !file) return res.status(400).json({ error: '文件名无效' });
  const fp = path.join(UPLOAD_DIR, folder, file);
  if (fp.indexOf(path.join(UPLOAD_DIR, folder) + path.sep) !== 0) {
    return res.status(400).json({ error: '文件名无效' });
  }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  res.download(fp, file);
});

// ---- 归档下载：把整个目录的密文拼成一条流（纯聚合，不压缩） ----
// 帧格式：[2B 名长][文件名 UTF-8][8B 数据长(大端)][数据]
// manifest.enc 放在最前，客户端先解出真实文件名，再按序还原其余文件
app.get('/api/archive/:folder', async (req, res) => {
  const folder = safeName(req.params.folder);
  const dir = path.join(UPLOAD_DIR, folder);
  if (!folder || dir.indexOf(UPLOAD_DIR + path.sep) !== 0) {
    return res.status(400).json({ error: '目录名无效' });
  }
  let parts;
  try {
    parts = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size }));
  } catch {
    return res.status(404).json({ error: '目录不存在' });
  }
  if (!parts.length) return res.status(404).json({ error: '目录为空' });
  parts.sort((a, b) =>
    a.name === MANIFEST ? -1 : b.name === MANIFEST ? 1 : a.name.localeCompare(b.name));

  const total = parts.reduce((s, p) => s + 10 + Buffer.byteLength(p.name) + p.size, 0);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(total));
  res.setHeader('Cache-Control', 'no-store');

  let body = null; // 当前正在读的文件流，客户端断开时要关掉
  res.on('close', () => body && body.destroy());
  const write = (b) =>
    res.write(b) ? Promise.resolve(true) : new Promise((r) => res.once('drain', () => r(!res.writableEnded)));

  try {
    for (const p of parts) {
      const nameB = Buffer.from(p.name, 'utf8');
      const head = Buffer.alloc(10 + nameB.length);
      head.writeUInt16BE(nameB.length, 0);
      head.writeBigUInt64BE(BigInt(p.size), 2);
      nameB.copy(head, 10);
      if (!(await write(head))) return;
      body = fs.createReadStream(path.join(dir, p.name), { highWaterMark: 1024 * 1024 });
      for await (const chunk of body) if (!(await write(chunk))) break;
      body.destroy();
      body = null;
      if (res.writableEnded) return;
    }
    res.end();
  } catch {
    if (body) body.destroy();
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
    else res.destroy();
  }
});

// ---- 前端静态页 ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- 统一错误处理 ----
app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  const msg =
    err.type === 'entity.too.large' ? '请求体过大（单个分块超过上限）' :
    err.message || '请求处理失败';
  res.status(err.status || 400).json({ error: msg });
});

// ---- 双端口启动：HTTP 可直接用；HTTPS 更优（传输层加密 + 原生加密引擎） ----
(async () => {
  const cert = await ensureCert();
  https.createServer(cert, app).listen(HTTPS_PORT, () => {
    console.log(`file-box 已启动`);
    console.log(`  HTTP : http://localhost:${PORT}`);
    console.log(`  HTTPS: https://localhost:${HTTPS_PORT}（推荐，首次访问需信任自签证书一次）`);
    console.log(`上传目录: ${UPLOAD_DIR}（存储上限 ${STORAGE_LIMIT_GB}GB，超过 ${RETENTION_DAYS} 天自动清理）`);
    console.log('文件在浏览器内端到端加密后上传，服务器磁盘只保存密文');
  });
  http.createServer(app).listen(PORT);
})();
