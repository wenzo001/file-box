const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const express = require('express');
const selfsigned = require('selfsigned');
const { createLibrary, LibraryError, TTL_HOURS } = require('./lib/library');
const { folderIdOrUnfiled, ttlHours, schemas } = require('./lib/schemas');

const app = express();
// 反代部署时设 TRUST_PROXY=1（或 express 支持的 trust proxy 配置串），
// req.ip 才是真实客户端地址 —— 限流按 IP 记账，不设的话反代后所有用户共享一个桶
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
// JSON 请求体一律在各自路由上解析，不要在这里挂全局 express.json：
// 全局那层会先把 body 解析掉并置 req._body，各路由再挂 express.json({limit}) 就会被跳过，
// 于是无痕传输声明的 64KB/256KB 限额全是死代码（审计实测 192KB 照样进业务逻辑）。

// ---- 配置（均可通过环境变量覆盖） ----
const PORT = Number(process.env.PORT) || 3000;              // HTTP 端口（完整服务）
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;   // HTTPS 端口（传输层加密 + 原生加密引擎）
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
const STORAGE_LIMIT_GB = Number(process.env.STORAGE_LIMIT_GB) || 10; // 存储总量上限
const STORAGE_LIMIT = STORAGE_LIMIT_GB * 1024 * 1024 * 1024;
const LIBRARY_DIR = process.env.LIBRARY_DIR
  ? path.resolve(process.env.LIBRARY_DIR)
  : path.join(path.dirname(UPLOAD_DIR), '.library');
const TTL_SWEEP_MS = Number(process.env.TTL_SWEEP_MS) || 60 * 1000;
const library = createLibrary({ libraryDir: LIBRARY_DIR, log: console });
let libraryReady = false;

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireLibrary = (req, res, next) => {
  if (!libraryReady) return res.status(503).json({ error: '目录索引暂时不可用，请稍后重试' });
  next();
};
function parseBody(res, schema, body) {
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || '请求不合法' });
    return null;
  }
  return parsed.data;
}

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

// ---- 目录闸门 ----
// 本服务在 uploads 下只创建一种目录：commitStaging() 生成的「YYYYMMDD_HHmm」
// （同一分钟挤第二个及以后是「YYYYMMDD_HHmm_序号」）。名字是这里唯一的身份来源，
// 列表 / 下载 / 归档 / 删除四个地方都按它认人，别处不许再造第二套。
const FOLDER_NAME = /^\d{8}_\d{4}(_\d+)?$/;
const isFolderName = (name) => FOLDER_NAME.test(String(name || ''));
const realpathOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const isWithin = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * 把用户给的目录名解析成 uploads 内**真实**目录路径；不合法就返回 null。
 * 三道都要过：名字是本服务创建的形状 → lstat 看它是真目录（不是软链接/junction）
 * → realpath 仍在 uploads 真实路径之内。
 * 为什么不能只做字符串前缀比较：resolve/join 只看字面，一个指向界外的链接就能让
 * "看起来在界内"的名字把界外的内容列出来、打包走（实测 download/archive 都跟得出去）。
 */
function resolveFolder(name) {
  if (!isFolderName(name)) return null;
  const root = realpathOrNull(UPLOAD_DIR);
  if (!root) return null;
  const p = path.join(root, name);
  try {
    if (!fs.lstatSync(p).isDirectory()) return null;
  } catch { return null; }
  const real = realpathOrNull(p);
  return real && isWithin(root, real) ? real : null;
}

/** 目录内的真实文件路径：同样拒链接——链接目录里放一个指出去的软链接也是读界外的口子 */
function resolveFile(folderReal, name) {
  const safe = safeName(name);
  if (!folderReal || !safe) return null;
  const p = path.join(folderReal, safe);
  try {
    if (!fs.lstatSync(p).isFile()) return null;
  } catch { return null; }
  const real = realpathOrNull(p);
  return real && isWithin(folderReal, real) ? real : null;
}

/** 启动时把 uploads 里"看得见但服务不认"的条目说一声：闸门收紧后它们不再出现在列表里，
 *  不吭声会被当成文件丢了 */
function warnIgnored() {
  let ignored = [];
  try {
    ignored = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !isFolderName(d.name))
      .map((d) => d.name);
  } catch { return; }
  if (ignored.length) {
    console.log(`[提示] ${UPLOAD_DIR} 下有 ${ignored.length} 个目录不是本服务创建的，已忽略（不列表、不下载、不删除）：${ignored.slice(0, 5).join(', ')}${ignored.length > 5 ? ' …' : ''}`);
    console.log('[提示] 需要它们的内容请自己把它们移到别处；服务只会动自己按「日期_时间」命名建出来的目录');
  }
}

// ---- 下载次数 ----
// 账本刻意放在 uploads **之外**（默认取 uploads 的父目录下的 .stats/downloads.json）：
// 放进去它就会被 /api/archive 当文件打包出去、被 /api/download 当文件吐出去、被 dirSize 算进用量，
// 三处都得再排除一次；分家之后一处都不碰。
const STATS_FILE = process.env.DOWNLOADS_FILE
  ? path.resolve(process.env.DOWNLOADS_FILE)
  : path.join(path.dirname(UPLOAD_DIR), '.stats', 'downloads.json');
const STATS_FLUSH_MS = 2000;
let flushTimer = null;

/** 账本结构：{ "20260923_1430": { "f_xxx.enc": 3 } }。读不回来就当没有过（一次都没下载） */
function loadDownloads() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
const downloads = loadDownloads();

function flushDownloads() {
  flushTimer = null;
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    const tmp = `${STATS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(downloads));
    fs.renameSync(tmp, STATS_FILE); // 写完才改名：崩了也不会留下半个账本
  } catch (err) {
    console.error('[统计] 下载次数落盘失败', err.code); // 记不上数不该影响下载本身
  }
}
const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(flushDownloads, STATS_FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
};

/** 记一次"真的开始往外吐字节"的下载。失败/被闸门挡下的调用方自己就不会走到这里 */
function countDownload(folder, file) {
  if (file === MANIFEST) return; // 前端每次展开目录都自动拉清单：计了就不是"被下载"而是"被点开"
  const rec = downloads[folder] && typeof downloads[folder] === 'object' ? downloads[folder] : {};
  rec[file] = (rec[file] || 0) + 1;
  downloads[folder] = rec;
  scheduleFlush();
}
/** 目录被删（手动）后账本条目要跟着走：否则它一直占着一格，还可能被以后同名的目录继承 */
function forgetDownloads(folder) {
  if (!(folder in downloads)) return;
  delete downloads[folder];
  scheduleFlush();
}

// ---- 存储空间统计与过期清理 ----
/** 递归统计目录占用字节数。用 lstat：软链接既不该计入用量，更不该跟着递归
 *  （一个指回上层的软链接就能让同步递归绕不完）。单个条目读不到也跳过：Windows 上
 *  杀软/索引器会临时锁文件，不该因此让一次列表或上传请求整个报错 */
function dirSize(dir) {
  let total = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isDirectory()) total += dirSize(p);
      else if (st.isFile()) total += st.size;
    } catch { continue; }
  }
  return total;
}

warnIgnored();

// ---- 上传：分块 + 断点续传 ----
// 分块先落到 uploads 之外的 .uploading/<批次>/，全部块传完再按「完成那一刻」的时间
// 命名并搬进 uploads。所以：列表里永远看不到上传到一半的目录，展示的时间就是传完的时刻。
// 中断后重新发起同一批文件（客户端用批次指纹识别），只补缺失的块即可接着传。
const STAGING_DIR = process.env.STAGING_DIR ? path.resolve(process.env.STAGING_DIR) : path.join(__dirname, '.uploading');
const UPLOAD_TTL_MS = Number(process.env.UPLOAD_TTL_HOURS || 48) * 60 * 60 * 1000; // 未完成批次留 2 天：过期回收，下次上传从头再来
const MAX_CHUNK = 32 * 1024 * 1024;        // 单块上限（客户端约 4MB 一块）
const MAX_FILES = 200;                     // 单批文件数上限
const MAX_STAGING_BATCHES = 20;            // 最多同时留多少个未完成批次：只按字节卡上限的话，刷 init 堆空目录没人管
const MAX_INFLIGHT_PARTS = 8;              // 同时缓冲中的分块数：Node 是把整块读进内存再落盘的，没有上界就能被撑爆内存

/** 标准 CRC32（内置查表实现：zlib.crc32 要 Node 20.15+，而本服务声明支持 Node ≥ 18） */
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

function ensureStagingDir() {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}
ensureStagingDir();

const isUploadId = (id) => /^[a-f0-9]{16,64}$/.test(String(id || ''));
const uploadDirOf = (id) => path.join(STAGING_DIR, String(id));

/** 回收过期未完成批次（进程被杀、客户端再也不回来），并给批次数量一个上界 */
function sweepStaging(maxAgeMs = UPLOAD_TTL_MS) {
  ensureStagingDir();
  const now = Date.now();
  let removed = 0;
  const dirs = [];
  for (const name of fs.readdirSync(STAGING_DIR)) {
    const p = path.join(STAGING_DIR, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) { try { fs.rmSync(p, { force: true }); removed++; } catch { /* 正被人占用就算了 */ } continue; }
    dirs.push({ name, mtime: st.mtimeMs });
  }
  // 目录 mtime = 最后一次动它的时刻：客户端中途放弃、再也不回来，也从这里回收
  for (const d of dirs.filter((x) => now - x.mtime > maxAgeMs)) {
    fs.rmSync(path.join(STAGING_DIR, d.name), { recursive: true, force: true });
    console.log(`[上传] 回收 ${Math.round((now - d.mtime) / 3600000)} 小时没动过的批次 ${d.name.slice(0, 8)}`);
    removed++;
  }
  // 数量上界：只按字节卡上限的话，一直换指纹新建批次就能堆出成千上万个小目录，
  // 而每次判断占用都要遍历一遍 —— 越用越慢，等于另一种"泄漏"
  const live = dirs.filter((x) => now - x.mtime <= maxAgeMs).sort((a, b) => a.mtime - b.mtime);
  while (live.length >= MAX_STAGING_BATCHES) {
    const victim = live.shift();
    fs.rmSync(path.join(STAGING_DIR, victim.name), { recursive: true, force: true });
    console.log(`[上传] 未完成批次超过 ${MAX_STAGING_BATCHES} 个，挤掉最早的 ${victim.name.slice(0, 8)}`);
    removed++;
  }
  if (removed) forgetUsage(); // 腾出的空间立刻反映到上限判断，别让 30 秒缓存报高
  return removed;
}

/** 启动时：上个进程留下的 .tmp 是写一半的（.bin 都是写完才改名的），只清这些，
 *  已完成的块留着 —— 否则服务一重启（发版、改配置）2 天续传就白设计了 */
function reclaimStagingOnBoot() {
  ensureStagingDir();
  let n = 0;
  for (const name of fs.readdirSync(STAGING_DIR)) {
    const p = path.join(STAGING_DIR, name);
    try {
      if (!fs.statSync(p).isDirectory()) continue;
      for (const f of fs.readdirSync(p)) {
        if (/^part-\d+-\d+\.tmp$/.test(f)) { fs.rmSync(path.join(p, f), { force: true }); n++; }
      }
    } catch { /* 目录已经没了就算了 */ }
  }
  if (n) console.log(`[上传] 清掉 ${n} 个写了一半的分块`);
  sweepStaging();
}
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
 *  会让合并时把文件往自己身上追加；叫 x.enc.assembling 会占用另一个文件拼接时的临时名），一律拒绝 */
const RESERVED_NAME = /^(meta\.json|part-\d+-\d+\.(bin|tmp)|.*\.assembling)$/;

/** 校验分块声明：文件名安全、不重复、不是保留名、块大小在范围内 */
function metaProblem(files) {
  if (!Array.isArray(files) || !files.length) return '没有文件';
  if (files.length > MAX_FILES) return `单次最多 ${MAX_FILES} 个文件`;
  const seen = new Set();
  for (const f of files) {
    if (!f || typeof f.enc !== 'string' || !f.enc || safeName(f.enc) !== f.enc) return '文件名不合法';
    const np = nameProblem(f.enc);
    if (np) return `文件名不合法：${np}`;
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

// ---- 文件名字符集 ----
// 服务器跑在 Windows 还是 Linux 上，落盘的是同一个名字，所以只能收"两边都能安全落"的最严交集：
// 这些形状在 init 放过，就会在 finish 的 rename/writeFile 上炸（炸的时候还带绝对路径出去），
// 或者悄悄落到别处去（Windows 会把尾点、尾空格归一化掉）。
const NAME_ILLEGAL = /[<>:"|?*\u0000-\u001f]/;            // 两侧保留字符与控制字符（分隔符由 safeName 先拒）
const NAME_TAIL = /[. ]$/;                                 // Windows 归一化掉尾点/尾空格 → 校验的名字≠落盘的名字
const NAME_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i; // Windows 设备名，带扩展名也算
const NAME_MAX_BYTES = 200;                                // 单个路径分量留够余量（MAX_PATH 260）
/** 这个名字能不能落盘？能返回 null，不能返回给用户看的原因 */
function nameProblem(name) {
  if (typeof name !== 'string' || !name || name !== name.trim()) return '文件名不能为空或首尾带空白';
  if (NAME_ILLEGAL.test(name)) return '文件名含非法字符';
  if (NAME_TAIL.test(name)) return '文件名不能以点或空格结尾';
  if (NAME_DEVICE.test(name)) return '文件名是系统保留名';
  if (Buffer.byteLength(name, 'utf8') > NAME_MAX_BYTES) return '文件名过长';
  return null;
}

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

// 启动回收放在占用统计可用之后（sweepStaging 要调 forgetUsage，提前调会踩到未初始化的缓存）
reclaimStagingOnBoot();

// ---- 文件库目录索引：磁盘事实 + NeDB 目录树 ----
const BATCH_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const FOLDER_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** 只扫本服务创建的日期批次；文件名/大小来自磁盘，下载次数来自 .stats */
function scanUploadBatches() {
  ensureUploadDir();
  return fs
    .readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isFolderName(d.name))
    .map((d) => {
      const dir = path.join(UPLOAD_DIR, d.name);
      const rec = downloads[d.name] || {};
      const files = fs
        .readdirSync(dir)
        .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, downloads: rec[f] || 0 }))
        .sort((a, b) => BATCH_COLLATOR.compare(a.name, b.name));
      return {
        name: d.name,
        count: files.filter((f) => f.name !== MANIFEST).length,
        size: files.reduce((s, f) => s + f.size, 0),
        downloads: files.reduce((s, f) => s + f.downloads, 0),
        files,
      };
    })
    .sort((a, b) => BATCH_COLLATOR.compare(b.name, a.name));
}

/** 旧批次的展示时间：只用于 uploadedAt 兜底，不参与清理 */
function batchTime(name) {
  const m = String(name).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

/** 物理删除一个批次 + 清下载账本；目录不存在也视为成功（可重试） */
function deleteBatchPhysical(name) {
  const dir = resolveFolder(name);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  forgetDownloads(name);
  forgetUsage();
}

async function sweepExpired() {
  if (!libraryReady) return [];
  return library.sweepExpired({ deleteBatch: async (name) => deleteBatchPhysical(name) });
}

async function reconcileLibrary() {
  if (!libraryReady) return;
  const docs = await library.allBatches();
  for (const doc of docs) {
    if (!resolveFolder(doc._id)) await library.removeBatch(doc._id);
  }
}

async function buildLibraryPayload() {
  const disk = scanUploadBatches();
  const folderDocs = libraryReady ? await library.allFolders() : [];
  const batchDocs = libraryReady ? await library.allBatches() : [];
  const folderMap = new Map(folderDocs.map((f) => [f._id, f]));
  const metaMap = new Map(batchDocs.map((b) => [b._id, b]));

  const emptySummary = () => ({ count: 0, size: 0, downloads: 0, earliestExpiresAt: null });
  const summary = new Map([['__unfiled__', emptySummary()]]);
  for (const f of folderDocs) summary.set(f._id, emptySummary());

  const batches = disk.map((b) => {
    const meta = metaMap.get(b.name) || null;
    let folderId = meta?.folderId || null;
    if (folderId && !folderMap.has(folderId)) folderId = null;
    const uploadedAt = Number.isFinite(meta?.uploadedAt) ? meta.uploadedAt : batchTime(b.name);
    const expiresAt = Number.isFinite(meta?.expiresAt) ? meta.expiresAt : null;
    const ttl = Number.isFinite(meta?.ttlHours) ? meta.ttlHours : null;
    return {
      ...b,
      folderId,
      uploadedAt,
      expiresAt,
      ttlHours: ttl,
      legacy: !meta || meta.legacy === true,
    };
  });

  for (const b of batches) {
    const add = (id) => {
      const s = summary.get(id);
      if (!s) return;
      s.count += b.count;
      s.size += b.size;
      s.downloads += b.downloads;
      if (b.expiresAt !== null && (s.earliestExpiresAt === null || b.expiresAt < s.earliestExpiresAt)) {
        s.earliestExpiresAt = b.expiresAt;
      }
    };
    add(b.folderId || '__unfiled__');
    let parent = b.folderId ? (folderMap.get(b.folderId)?.parentId || null) : null;
    const seen = new Set();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      add(parent);
      parent = folderMap.get(parent)?.parentId || null;
    }
  }

  const folders = [
    {
      id: '__unfiled__', parentId: null, name: '未分档', system: true,
      createdAt: null, updatedAt: null, ...summary.get('__unfiled__'),
    },
    ...folderDocs.map((f) => ({
      id: f._id, parentId: f.parentId, name: f.name, system: false,
      createdAt: f.createdAt, updatedAt: f.updatedAt, ...summary.get(f._id),
    })),
  ];
  folders.sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return FOLDER_COLLATOR.compare(a.name, b.name);
  });

  return {
    now: Date.now(),
    libraryReady,
    usage: { used: disk.reduce((s, b) => s + b.size, 0), limit: STORAGE_LIMIT, limitGB: STORAGE_LIMIT_GB },
    httpsPort: HTTPS_PORT,
    ttlOptions: TTL_HOURS,
    folders,
    batches,
  };
}

// 1) 申请批次：同一指纹（同一批文件）会拿回同一个批次和已传的块，用于断点续传
app.post('/api/upload/init', express.json({ limit: '2mb' }), asyncHandler(async (req, res) => {
  const { key, files } = req.body || {};
  if (typeof key !== 'string' || !/^[a-f0-9]{16,64}$/.test(key)) {
    return res.status(400).json({ error: '批次标识不合法' });
  }
  const bad = metaProblem(files);
  if (bad) return res.status(400).json({ error: bad });

  let folderId = null;
  const requestedFolder = req.body.folderId && req.body.folderId !== '__unfiled__';
  if (req.body.folderId !== undefined && req.body.folderId !== null) {
    const parsed = folderIdOrUnfiled.safeParse(req.body.folderId);
    if (!parsed.success) return res.status(400).json({ error: '目录标识不合法' });
    if (parsed.data && parsed.data !== '__unfiled__' && libraryReady) {
      if (!(await library.getFolder(parsed.data))) return res.status(404).json({ error: '目录不存在' });
      folderId = parsed.data;
    }
  }

  let ttl = null;
  if (req.body.ttlHours !== undefined && req.body.ttlHours !== null) {
    const parsed = ttlHours.safeParse(req.body.ttlHours);
    if (!parsed.success) return res.status(400).json({ error: '自动删除时长不合法' });
    ttl = parsed.data;
  }

  // 每次开始上传前顺手回收到期批次；失败不会影响本次上传
  if (libraryReady) await sweepExpired();

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
  const meta = { v: 2, key, files, folderId, ttlHours: ttl };
  if (!sameLayout) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  } else if (old.v !== 2 || old.folderId !== folderId || old.ttlHours !== ttl) {
    // 目标目录 / TTL 改了但分块布局没变：块继续可用，只更新账本
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  }
  const have = sameLayout ? haveParts(key) : [];
  const total = files.reduce((s, f) => s + f.chunks.length, 0);
  res.json({
    ok: true,
    uploadId: key,
    have,
    total,
    resumed: have.length > 0,
    folderId,
    ttlHours: ttl,
    folderMissing: Boolean(requestedFolder && !folderId),
  });
}));

// 内存上界：express.raw 是把整块读进内存才交给处理函数的，并发一多就是 N×32MB。
// 超过上界先挡回去 —— 429 在客户端属于"可重试"，它会退避重传同一块，进度不丢。
let partsInFlight = 0;
function gateParts(req, res, next) {
  if (partsInFlight >= MAX_INFLIGHT_PARTS) {
    return res.status(429).json({ error: '服务器写入正忙，这块稍后重试' });
  }
  partsInFlight++;
  let released = false;
  const release = () => { if (!released) { released = true; partsInFlight--; } };
  // 客户端中途断开时 'finish' 不一定触发，两个都挂上：漏放一次就少一个名额，攒久了上传就全堵死
  res.on('finish', release);
  res.on('close', release);
  next();
}

// 2) 传一块：长度与摘要都要对得上（传输中损坏就地发现、让客户端重传），
//    先写 .tmp 再改名，断连不会留下"看起来完整"的半块
app.put('/api/upload/part', gateParts, express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK }), (req, res) => {
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
  // 完整性：客户端在 X-Chunk-Crc 里声明这块密文的 CRC32，对不上就是路上坏了，
  // 直接让客户端重传这一块 —— 别等用户下载时才发现内容坏了，那时原文已经不在。
  // 这里只用于发现"传输损坏"，防伪由端到端加密的 GCM 校验负责，所以用便宜的 CRC32
  // （手机纯 JS 引擎上算 sha256 每 4MiB 要 200-400ms，会把上传拖慢一倍）
  const declared = String(req.get('X-Chunk-Crc') || '').toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(declared)) {
    return res.status(400).json({ error: '缺少或非法的分块校验值' });
  }
  const got = (crc32(buf) >>> 0).toString(16).padStart(8, '0');
  if (got !== declared) {
    return res.status(400).json({ error: '分块校验不通过（传输中损坏），请重传该块', resend: true });
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
// 正在拼装中的批次：finish 是逐块删除式的，两次并发 finish 会互相拼坏文件再互相 500，
// 第二个请求要么等待要么直接拒绝 —— 这里选"在拼的直接 409"，客户端重试会拿到 404/结果
const assembling = new Set();

app.post('/api/upload/finish', express.json({ limit: '64kb' }), (req, res) => {
  const { uploadId } = req.body || {};
  const meta = isUploadId(uploadId) ? readMeta(uploadId) : null;
  if (!meta) return res.status(404).json({ error: '上传已过期，请重新开始' });
  if (assembling.has(uploadId)) return res.status(409).json({ error: '该批次正在合并中，请勿重复提交' });
  assembling.add(uploadId);
  const done = () => assembling.delete(uploadId);
  const dir = uploadDirOf(uploadId);
  const have = new Set(haveParts(uploadId).map((p) => `${p.f}-${p.c}`));
  const total = meta.files.reduce((s, f) => s + f.chunks.length, 0);
  if (have.size !== total) {
    done();
    return res.status(409).json({ error: `还有 ${total - have.size} 块没传完`, have: [...have] });
  }
  (async () => {
    try {
      if (usedBytes() >= STORAGE_LIMIT) { done(); return tooLarge(res); } // 落盘前再确认一次，别把上限撑破
      for (let fi = 0; fi < meta.files.length; fi++) {
        const f = meta.files[fi];
        const out = path.join(dir, `${f.enc}.assembling`);
        fs.rmSync(out, { force: true }); // 上次拼一半的残骸不能拿来追加
        for (let ci = 0; ci < f.chunks.length; ci++) {
          const part = path.join(dir, `part-${fi}-${ci}.bin`);
          await pipeline(fs.createReadStream(part), fs.createWriteStream(out, { flags: 'a' }));
          fs.rmSync(part, { force: true }); // 拼一块删一块，峰值不翻倍
        }
        // 拼完一个文件才改成正名：中途出错绝不会留下"看起来是完整文件"的半成品
        fs.renameSync(out, path.join(dir, f.enc));
      }
      // 拼完就把批次账本与残余分块清掉，别让它们跟着 rename 进 uploads
      fs.rmSync(path.join(dir, 'meta.json'), { force: true });
      for (const leftover of fs.readdirSync(dir)) {
        if (/^part-\d+-\d+\.(bin|tmp)$/.test(leftover)) fs.rmSync(path.join(dir, leftover), { force: true });
      }
      const folder = commitStaging(dir); // 名字 = 完成时刻
      forgetUsage(); // 刚搬进 uploads，缓存里的占用已经不准了

      const uploadedAt = Date.now();
      const ttl = Number.isFinite(meta.ttlHours) ? meta.ttlHours : null;
      let targetFolderId = meta.folderId || null;
      let folderMissing = false;
      let indexed = false;
      if (libraryReady) {
        if (targetFolderId && !(await library.getFolder(targetFolderId))) {
          targetFolderId = null;
          folderMissing = true;
        }
        let manifestHash = null;
        try {
          const manifestPath = path.join(UPLOAD_DIR, folder, MANIFEST);
          if (fs.existsSync(manifestPath)) {
            manifestHash = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
          }
        } catch (err) {
          console.warn('[目录索引] 清单摘要计算失败', err.code || err.message);
        }
        try {
          await library.setBatch(folder, {
            folderId: targetFolderId,
            uploadedAt,
            ttlHours: ttl,
            expiresAt: ttl ? uploadedAt + ttl * 3600_000 : null,
            manifestHash,
          });
          indexed = true;
        } catch (err) {
          console.error('[目录索引] 批次写入失败', err.code || err.message);
          targetFolderId = null;
        }
      } else if (meta.folderId) {
        // 索引不可用时不能假装已经归档；文件仍在磁盘，按未分档展示
        targetFolderId = null;
        folderMissing = true;
      }

      done();
      res.json({
        ok: true,
        folder,
        count: meta.files.filter((f) => f.enc !== MANIFEST).length,
        folderId: targetFolderId,
        expiresAt: indexed && ttl ? uploadedAt + ttl * 3600_000 : null,
        folderMissing,
        indexed,
      });
    } catch (err) {
      console.error('[上传] 合并分块失败', err);
      // 块已经边拼边删了，这个批次不可能再"续"：整批丢掉，让下次从头来。
      // 留着只会留下拼一半的文件，下次追加拼接就成了坏文件
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉也得先回复客户端 */ }
      forgetUsage();
      done();
      try {
        // 详情（含绝对路径的 err.message）只进日志：这条响应是给浏览器看的，
        // 匿名请求不该知道服务装在哪个目录（审计里 enc="a.enc:" 就把它骗出来过）
        if (!res.headersSent) res.status(500).json({ error: '合并分块失败，请重新上传这一批' });
      } catch { /* 连接已经断了，没什么可做的 */ }
    }
  })().catch((err) => console.error('[上传] 收尾流程异常', err));
});

// ---- 文件列表（旧页面 / 旧缓存兼容：按时间倒序） ----
app.get('/api/list', (req, res) => {
  const folders = scanUploadBatches();
  const used = folders.reduce((s, f) => s + f.size, 0);
  res.json({
    folders,
    usage: { used, limit: STORAGE_LIMIT, limitGB: STORAGE_LIMIT_GB },
    httpsPort: HTTPS_PORT,
  });
});

// ---- 新界面的目录树 + 批次视图 ----
app.get('/api/library', asyncHandler(async (req, res) => {
  res.json(await buildLibraryPayload());
}));

// ---- 目录 CRUD ----
app.post('/api/folders', requireLibrary, express.json({ limit: '64kb' }), asyncHandler(async (req, res) => {
  const data = parseBody(res, schemas.folderCreate, req.body);
  if (!data) return;
  const folder = await library.createFolder(data);
  res.json({ ok: true, folder });
}));

app.patch('/api/folders/:id', requireLibrary, express.json({ limit: '64kb' }), asyncHandler(async (req, res) => {
  const data = parseBody(res, schemas.folderPatch, req.body);
  if (!data) return;
  const folder = data.name !== undefined
    ? await library.renameFolder(req.params.id, data)
    : await library.moveFolder(req.params.id, data);
  res.json({ ok: true, folder });
}));

app.delete('/api/folders/:id', requireLibrary, asyncHandler(async (req, res) => {
  if (req.params.id === '__unfiled__') return res.status(400).json({ error: '未分档不能删除' });

  if (req.query.mode === 'empty') {
    await library.deleteEmptyFolder(req.params.id);
    return res.json({ ok: true, folders: 1, batches: 0 });
  }

  const subtree = await library.folderSubtree(req.params.id);
  const metaByName = new Map((await library.allBatches()).map((b) => [b._id, b]));
  const failed = [];
  for (const name of subtree.batches) {
    const meta = metaByName.get(name);
    // 快照之后被移到别处的批次不跟着删，避免误删别人刚整理好的文件
    if (meta && meta.folderId && !subtree.folderIds.includes(meta.folderId)) {
      failed.push({ name, error: '批次已经移动到别的目录' });
      continue;
    }
    try {
      deleteBatchPhysical(name);
      await library.removeBatch(name);
    } catch (err) {
      failed.push({ name, error: err.code || '删除失败' });
    }
  }
  if (failed.length) {
    return res.status(500).json({ error: `有 ${failed.length} 个批次删除失败`, failed });
  }
  const deleted = await library.deleteFolders(subtree.folderIds);
  forgetUsage();
  res.json({ ok: true, folders: deleted.deleted, batches: subtree.batches.length });
}));

// ---- 批次整体移动（单条 / 批量） ----
app.patch('/api/batches', requireLibrary, express.json({ limit: '256kb' }), asyncHandler(async (req, res) => {
  const data = parseBody(res, schemas.batchBulkMove, req.body);
  if (!data) return;
  const missing = data.names.filter((name) => !resolveFolder(name));
  if (missing.length) return res.status(404).json({ error: `有 ${missing.length} 个批次不存在`, missing });
  const out = await library.moveBatches(data.names, data.folderId);
  res.json({ ok: true, ...out });
}));

app.patch('/api/batches/:batch', requireLibrary, express.json({ limit: '64kb' }), asyncHandler(async (req, res) => {
  const name = req.params.batch;
  if (!isFolderName(name)) return res.status(400).json({ error: '批次名不合法' });
  if (!resolveFolder(name)) return res.status(404).json({ error: '批次不存在' });
  const data = parseBody(res, schemas.batchMove, req.body);
  if (!data) return;
  const out = await library.moveBatches([name], data.folderId);
  res.json({ ok: true, ...out });
}));

// ---- 删除整个批次（谨慎操作：前端有确认弹层） ----
// 只删"本服务自己按日期_时间建出来的真实目录"：名字形状 + lstat 真目录 + realpath 仍在 uploads 内，
// 三道一起过。少任何一道都会留下口子（字符串前缀比较挡不住指向界外的链接）。
app.delete('/api/folder/:folder', asyncHandler(async (req, res) => {
  const name = req.params.folder;
  if (!isFolderName(name)) return res.status(400).json({ error: '目录名无效' });

  const rawExpect = req.query.expectFolder;
  let expected;
  if (rawExpect !== undefined) {
    if (rawExpect === '__unfiled__' || rawExpect === '') expected = null;
    else {
      const parsed = folderIdOrUnfiled.safeParse(rawExpect);
      if (!parsed.success) return res.status(400).json({ error: '目录标识不合法' });
      expected = parsed.data;
    }
    if (!libraryReady) return res.status(503).json({ error: '目录索引暂时不可用，无法校验批次归属' });
    const meta = await library.getBatch(name);
    const actual = meta?.folderId || null;
    if (actual !== expected) return res.status(409).json({ error: '批次已经移动到别的目录' });
  }

  const dir = resolveFolder(name);
  // 名字形状对但"不是本服务建的真目录"（链接、界外、已被清理、压根没有）统一按不存在回，
  // 不给探测者区分"这里有链接"的反馈
  if (!dir) {
    if (libraryReady) {
      try { await library.removeBatch(name); } catch (err) { console.error('[目录索引] 清理失败', err.code || err.message); }
    }
    forgetDownloads(name);
    forgetUsage();
    return res.status(404).json({ error: '目录不存在' });
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('[删除] 失败', err.code, name);
    return res.status(500).json({ error: '删除失败' });
  }
  forgetUsage(); // 腾出的空间要立刻反映到上限判断上
  forgetDownloads(name);
  if (libraryReady) {
    try { await library.removeBatch(name); } catch (err) { console.error('[目录索引] 清理失败', err.code || err.message); }
  }
  res.json({ ok: true });
}));

// ---- 下载单个文件（密文，前端收到后自动解密） ----
app.get('/api/download/:folder/:file', (req, res) => {
  const folderReal = resolveFolder(req.params.folder);
  const fp = resolveFile(folderReal, req.params.file);
  if (!fp) return res.status(404).json({ error: '文件不存在' }); // 不区分"名字不合法/不在界内/不存在"，不给探测者反馈
  countDownload(path.basename(folderReal), path.basename(fp)); // 走到这里才算是"开始吐字节"
  res.download(fp, path.basename(fp));
});

// ---- 归档下载：把整个目录的密文拼成一条流（纯聚合，不压缩） ----
// 帧格式：[2B 名长][文件名 UTF-8][8B 数据长(大端)][数据]
// manifest.enc 放在最前，客户端先解出真实文件名，再按序还原其余文件
app.get('/api/archive/:folder', async (req, res) => {
  const dir = resolveFolder(req.params.folder);
  if (!dir) return res.status(404).json({ error: '目录不存在' });
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
  // 归档 = 整包被取走一次：每个文件各记一次（清单文件仍不记），目录级汇总就是它们的和
  parts.forEach((p) => countDownload(path.basename(dir), p.name));
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

// ---- 无痕传输：一次性会话 + 密文中转（独立模块，与上面的文件库完全分开） ----
const { createTransferApi } = require('./lib/transfer');
const { createStunServer } = require('./lib/stun');
// 内置 STUN：局域网直连的钥匙。原因是 Chrome 把 host 候选写成 mDNS 名（xxxx.local），
// 跨机器解析不了就只能退到服务器中转（实测 4MB/s）。两端向这台服务器问一次自己的源地址，
// 拿到的就是各自的内网 IP，可以直接互拨。STUN_PORT=0 可关掉（那就自己配 STUN_URLS）。
const STUN_PORT = process.env.STUN_PORT === undefined || process.env.STUN_PORT === ''
  ? 3478
  : (Number(process.env.STUN_PORT) || 0);
const stun = createStunServer({ port: STUN_PORT, log: (m) => console.log(m) });
stun.start();

const transferApi = createTransferApi({
  express,
  HTTPS_PORT,
  TRANSFER_DIR: process.env.TRANSFER_DIR ? path.resolve(process.env.TRANSFER_DIR) : path.join(__dirname, '.transfer'),
  // 用每个请求自己的 Host 拼地址：两端都是经这台服务器打开页面的，这个地址它们一定够得着。
  // 写死某个 IP 会在多网卡 / 多网段 / 反代后指错地方。
  stunSelf: (host) => stun.urlFor(host),
});
transferApi.register(app);
transferApi.bootReclaim();

// ---- 前端静态页 ----
// 新界面先挂在 /next/，默认页面仍是 public/index.html；切换根页面之前互不影响
app.use('/next', express.static(path.join(__dirname, 'dist-web', 'next')));
app.get('/next', (req, res) => {
  if (fs.existsSync(path.join(__dirname, 'dist-web', 'next', 'index.html'))) return res.redirect('next/');
  res.status(503).type('text').send('新界面尚未构建：先 npm run build');
});
app.use(express.static(path.join(__dirname, 'public')));

// ---- 统一错误处理 ----
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err instanceof LibraryError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  console.error(err);
  // err.expose 是 express / body-parser 给"可以说给客户端的那类错"打的标（400 那一族）。
  // 没这个标的（fs 抛的、我们自己 throw 的）一律换成固定话术：绝对路径与底层错误码不外说。
  const tellable = err.expose ? (err.message || '请求处理失败') : null;
  // 超限文案分两类：分块走 octet-stream（上限是"单块多大"），其余是 JSON 请求体（各自路由的上限）
  const msg = err.type === 'entity.too.large'
    ? (req && req.is('application/octet-stream') ? `分块超过上限（单块最大 ${MAX_CHUNK / 1048576}MB）` : '请求体过大')
    : tellable || '请求处理失败';
  res.status(err.expose ? (err.status || 400) : 500).json({ error: msg });
});

// ---- 双端口启动：HTTP 可直接用；HTTPS 更优（传输层加密 + 原生加密引擎） ----
(async () => {
  try {
    await library.init();
    libraryReady = true;
  } catch (err) {
    libraryReady = false;
    console.error('[目录索引] 初始化失败，按未分档模式运行', err.code || err.message);
  }
  if (libraryReady) {
    try { await reconcileLibrary(); } catch (err) { console.error('[目录索引] 启动对账失败', err.code || err.message); }
    try { await sweepExpired(); } catch (err) { console.error('[目录索引] 启动 TTL 扫描失败', err.code || err.message); }
    setInterval(() => {
      sweepExpired().catch((err) => console.error('[目录索引] TTL 扫描失败', err.code || err.message));
    }, TTL_SWEEP_MS).unref();
  }

  const cert = await ensureCert();
  https.createServer(cert, app).listen(HTTPS_PORT, () => {
    console.log(`file-box 已启动`);
    console.log(`  HTTP : http://localhost:${PORT}`);
    console.log(`  HTTPS: https://localhost:${HTTPS_PORT}（推荐，首次访问需信任自签证书一次）`);
    console.log(`上传目录: ${UPLOAD_DIR}（存储上限 ${STORAGE_LIMIT_GB}GB；没有全局自动清理，文件保留到手动删除）`);
    console.log(`目录索引: ${LIBRARY_DIR}${libraryReady ? '' : '（不可用，按未分档运行）'}`);
    console.log('文件在浏览器内端到端加密后上传，服务器磁盘只保存密文');
  });
  http.createServer(app).listen(PORT);
})();
