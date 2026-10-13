const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const express = require('express');
const selfsigned = require('selfsigned');

const app = express();
// 反代部署时设 TRUST_PROXY=1（或 express 支持的 trust proxy 配置串），
// req.ip 才是真实客户端地址 —— 限流按 IP 记账，不设的话反代后所有用户共享一个桶
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.json({ limit: '2mb' })); // init/finish 这类小 JSON 请求体

// ---- 配置（均可通过环境变量覆盖） ----
const PORT = Number(process.env.PORT) || 3000;              // HTTP 端口（完整服务）
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;   // HTTPS 端口（传输层加密 + 原生加密引擎）
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
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

// ---- 目录闸门 ----
// 本服务在 uploads 下只创建一种目录：commitStaging() 生成的「YYYYMMDD_HHmm」
// （同一分钟挤第二个及以后是「YYYYMMDD_HHmm_序号」）。名字是这里唯一的身份来源，
// 列表 / 下载 / 归档 / 删除 / 到期清理五个地方都按它认人，别处不许再造第二套。
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
    if (!d.isDirectory() || !isFolderName(d.name)) continue; // 链接与外来目录一律不动
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
warnIgnored();
setInterval(cleanupExpired, 6 * 60 * 60 * 1000).unref();

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

app.post('/api/upload/finish', (req, res) => {
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
      done();
      res.json({ ok: true, folder, count: meta.files.filter((f) => f.enc !== MANIFEST).length });
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

// ---- 文件列表（按时间倒序：新的在前） ----
// 文件名/大小来自磁盘（密文名）；真实文件名在前端解密 manifest.enc 后还原
app.get('/api/list', (req, res) => {
  ensureUploadDir();
  const folders = fs
    .readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isFolderName(d.name)) // 链接目录与外来目录一律不列（看得见却动不了的界面最容易骗人）
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
// 只删"本服务自己按日期_时间建出来的真实目录"：名字形状 + lstat 真目录 + realpath 仍在 uploads 内，
// 三道一起过。少任何一道都会留下口子（字符串前缀比较挡不住指向界外的链接）。
app.delete('/api/folder/:folder', (req, res) => {
  if (!isFolderName(req.params.folder)) return res.status(400).json({ error: '目录名无效' });
  const dir = resolveFolder(req.params.folder);
  // 名字形状对但"不是本服务建的真目录"（链接、界外、已被清理、压根没有）统一按不存在回，
  // 不给探测者区分"这里有链接"的反馈
  if (!dir) return res.status(404).json({ error: '目录不存在' });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('[删除] 失败', err.code, req.params.folder);
    return res.status(500).json({ error: '删除失败' });
  }
  forgetUsage(); // 腾出的空间要立刻反映到上限判断上
  res.json({ ok: true });
});

// ---- 下载单个文件（密文，前端收到后自动解密） ----
app.get('/api/download/:folder/:file', (req, res) => {
  const folderReal = resolveFolder(req.params.folder);
  const fp = resolveFile(folderReal, req.params.file);
  if (!fp) return res.status(404).json({ error: '文件不存在' }); // 不区分"名字不合法/不在界内/不存在"，不给探测者反馈
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
const transferApi = createTransferApi({
  express,
  HTTPS_PORT,
  TRANSFER_DIR: process.env.TRANSFER_DIR ? path.resolve(process.env.TRANSFER_DIR) : path.join(__dirname, '.transfer'),
});
transferApi.register(app);
transferApi.bootReclaim();

// ---- 前端静态页 ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- 统一错误处理 ----
app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  // err.expose 是 express / body-parser 给"可以说给客户端的那类错"打的标（400 那一族）。
  // 没这个标的（fs 抛的、我们自己 throw 的）一律换成固定话术：绝对路径与底层错误码不外说。
  const tellable = err.expose ? (err.message || '请求处理失败') : null;
  const msg =
    err.type === 'entity.too.large' ? '请求体过大（单个分块超过上限）' :
    tellable || '请求处理失败';
  res.status(err.expose ? (err.status || 400) : 500).json({ error: msg });
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
