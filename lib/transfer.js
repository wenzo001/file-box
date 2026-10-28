// 无痕传输（Ephemeral Transfer）服务端：一次性会话、配对信令、密文中转与清理生命周期。
//
// 数据边界（重要，别过度承诺）：
//   * 服务器只见密文分段与最少元数据（sid、分段序号、字节数、时间戳、proof/token 摘要），
//     拿不到明文、拿不到文件名、拿不到能解密的材料；解密密钥从不上传。
//   * sid 是公开的会话地址，只够定位；单独拿到 sid 的人既进不了会话也取不到分段。
//   * proof = HMAC(codeSecret, "proof"||sid) 由接收方在配对时提交；token 只在 create 时下发一次。
//     两者都是**单向摘要**派生用的秘密，走请求头不走 URL —— 查询参数会被反向代理的访问日志记下来。
//   * 磁盘上落的是密文，rm 能证明"不再有可读路径"，但不等于 SSD/快照/备份里物理消失。
//
// 与正式文件库物理隔离：数据放 TRANSFER_DIR（默认 .transfer），绝不进 uploads/，
// 也绝不被 /api/list、/api/download、/api/archive 看到。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const SID = /^[a-z1-9]{8}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;

function createTransferApi(config = {}) {
  const {
    express,
    HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443,
    TRANSFER_DIR = path.join(process.cwd(), '.transfer'),
    // 会话默认活 30 分钟：双方都得在线，短暂断网留够重连窗口，又不让密文长期躺在盘上
    TTL_MS = Number(process.env.XFER_TTL_MINUTES || 30) * 60 * 1000,
    // 页面开着/在后台挂着时可以续期，但整单有硬上限：无痕的前提是密文不能无限期躺着。
    // 2 小时只够"暂离/冻结后回来接着传"，不够把它当网盘用。
    MAX_LIFE_MS = Number(process.env.XFER_MAX_LIFE_MINUTES || 120) * 60 * 1000,
    // 中转区配额。以前默认 2GB —— 那比"一个 2GB 的文件"还小：只要这一单最后是走中转的，
    // 传到 2GB 处必定 413，界面上就是"跑到一半断了"。默认给到 8GB，并且下面把 413 的文案
    // 换成"谁占的、占了多少、怎么办"，不再只说一句"空间不足"。
    LIMIT_BYTES = (Number(process.env.XFER_LIMIT_GB || 8) || 8) * 1024 * 1024 * 1024,
    MAX_SESSIONS = Number(process.env.XFER_MAX_SESSIONS || 20) || 20,
    MAX_INFLIGHT = Number(process.env.XFER_MAX_INFLIGHT || 8) || 8,
    MAX_SEG = Number(process.env.XFER_MAX_SEG || 8 * 1024 * 1024) || 8 * 1024 * 1024,
    MAX_FRAMES = Number(process.env.XFER_MAX_FRAMES || 200000) || 200000,
    JOIN_FAIL_LIMIT = Number(process.env.XFER_JOIN_FAIL_LIMIT || 30) || 30, // 在线猜码的代价：10 分钟内失败这么多就冻 IP
    JOIN_WINDOW_MS = 10 * 60 * 1000,
    CREATE_LIMIT = Number(process.env.XFER_CREATE_LIMIT || 10) || 10, // 无凭证 create 的限速：10 分钟内成功建这么多就拒
    END_KEEP_MS = Number(process.env.XFER_END_KEEP_MS || 60 * 1000) || 60 * 1000,
    // TURN 短期凭证（turn-rest 风格：username = 过期时间:随机串，credential = base64(HMAC-SHA1(secret, username))）
    TURN_SECRET = process.env.TURN_SECRET || '',
    TURN_URLS = process.env.TURN_URLS ? String(process.env.TURN_URLS).split(',').map((s) => s.trim()).filter(Boolean) : [],
    TURN_USER = process.env.TURN_USER || '',
    TURN_PASS = process.env.TURN_PASS || '',
    TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 3600) || 3600,
    STUN_URLS = process.env.STUN_URLS ? String(process.env.STUN_URLS).split(',').map((s) => s.trim()).filter(Boolean) : [],
    // 内置 STUN 的自述地址（server.js 把已绑定的端口交进来）。为空就是不广告。
    stunSelf = null,
    now = () => Date.now(),
  } = config;

  const log = (msg) => console.log(msg); // 只打不带敏感信息的事件，绝不打 sid 之外的凭证
  const dirOf = (sid) => path.join(TRANSFER_DIR, sid);
  const ensureRoot = () => fs.mkdirSync(TRANSFER_DIR, { recursive: true });
  const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

  // ---- 内存状态（磁盘上的 seg-*.bin 才是"这段到底传没传上来"的最终依据） ----
  const sessions = new Map(); // sid -> session
  const rate = new Map(); // ip -> {fails, until}
  const creates = new Map(); // ip -> {count, until}：create 成功计数桶

  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  function writeJson(file, obj) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file); // 写完才改名：崩溃不会留下"看起来完整"的半个账本
  }
  function persist(sid, s) {
    if (!s) return;
    s.dirty = true;
    if (s.saving) return;
    s.saving = true;
    setImmediate(() => {
      s.saving = false;
      if (!s.dirty) return;
      s.dirty = false;
      const dir = dirOf(sid);
      try {
        writeJson(path.join(dir, 'meta.json'), s.meta);
        writeJson(path.join(dir, 'ack.json'), { acked: [...s.acked].sort((a, b) => a - b) });
      } catch { log('[无痕] 会话账本落盘失败'); }
      if (s.dirty) persist(sid, s);
    });
  }

  function listSegs(sid) {
    const out = new Set();
    try {
      for (const n of fs.readdirSync(dirOf(sid))) {
        const m = n.match(/^seg-(\d+)\.bin$/);
        if (m) out.add(Number(m[1]));
      }
    } catch { /* 目录已经没了 */ }
    return out;
  }

  function removeSession(sid) {
    const s = sessions.get(sid);
    let segments = 0;
    let bytes = 0;
    if (s) {
      // 先立"正在销毁"的旗：已经在写的那一发 PUT 落完 rename 之后要看见它，
      // 否则 rm 之后又被写回一个 seg 文件 —— 那就是"服务器说清空了、盘上还有"。
      s.purged = true;
      segments = s.uploaded.size;
      bytes = s.meta && Number(s.meta.bytes) || 0;
      for (const [, res] of [...s.streams]) { try { res.end(); } catch { /* 客户端已经走了 */ } }
      s.streams.clear();
    }
    sessions.delete(sid);
    // 删完再自检：万一有在飞的写入把目录重建了，最多再删两轮；仍不干净就把 gone=false 报上去，
    // 不能对着用户说"已清空"而盘上还有（sweep 的孤儿回收是第二道，不是这句承诺的替代品）
    const dir = dirOf(sid);
    let gone = false;
    for (let i = 0; i < 3 && !gone; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 已经没了 */ }
      gone = !fs.existsSync(dir);
    }
    if (!gone) log(`[无痕] 会话 ${sid} 的目录没删干净`);
    return { segments, bytes, gone };
  }

  /** 启动回收：清写一半的 .tmp 与已过期/已完成会话，未过期的原样留着（重启不能把续传作废） */
  function bootReclaim() {
    ensureRoot();
    let tmp = 0;
    for (const name of fs.readdirSync(TRANSFER_DIR)) {
      const p = path.join(TRANSFER_DIR, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!SID.test(name) || !st.isDirectory()) { fs.rmSync(p, { recursive: true, force: true }); continue; }
      for (const f of fs.readdirSync(p)) {
        if (f.endsWith('.tmp')) { fs.rmSync(path.join(p, f), { force: true }); tmp++; }
      }
      const meta = readJson(path.join(p, 'meta.json'));
      if (!meta || now() > meta.expiresAt || meta.state === 'done' || meta.state === 'cancelled') { removeSession(name); continue; }
      const ack = readJson(path.join(p, 'ack.json'));
      // bytes 以磁盘实况为准：老账本可能记的是覆写前的旧尺寸（补丁前的会话）
      const segs = [...listSegs(name)].reduce((sum, i) => sum + segSizeOf(name, i), 0);
      const session = {
        sid: name, meta, uploaded: listSegs(name), acked: new Set(ack && Array.isArray(ack.acked) ? ack.acked : []),
        streams: new Map(), createdAt: meta.createdAt, expiresAt: meta.expiresAt,
      };
      if (segs !== meta.bytes) { meta.bytes = segs; writeJson(path.join(p, 'meta.json'), meta); }
      sessions.set(name, session);
    }
    if (tmp) log(`[无痕] 清掉 ${tmp} 个写了一半的分段`);
    if (sessions.size) log(`[无痕] 保留 ${sessions.size} 个未过期会话（还在续传窗口内）`);
  }

  /** 过期/完成/取消都要落-clean；只按数量卡的话，一直新建 sid 就能堆满盘 */
  function sweep() {
    const t = now();
    for (const [sid, s] of [...sessions]) {
      if (t > s.expiresAt) { removeSession(sid); log('[无痕] 回收过期会话'); }
      else if (s.meta.state === 'done' || s.meta.state === 'cancelled') { removeSession(sid); log(`[无痕] 回收${s.meta.state === 'done' ? '已完成' : '已取消'}会话`); }
    }
    // 孤儿目录：内存里没有这个会话、盘上却还留着 SID 目录 —— 来源只有"创建到一半"与"删除时被在飞写入重建"，
    // 两种都不该留下密文。启动时的 bootReclaim 管不到运行期，所以每次 sweep 都扫一遍（删掉后再自检一次）。
    try {
      for (const name of fs.readdirSync(TRANSFER_DIR)) {
        if (!SID.test(name) || sessions.has(name)) continue;
        removeSession(name);
        log(`[无痕] 回收孤儿密文目录 ${name}`);
      }
    } catch { /* 根目录不在就没什么可扫的 */ }
    const live = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
    // 超上限先挤 waiting 的（还没人配对，挤掉损失最小），再挤最老的 —— 挨打也要按损失从小到大
    while (live.length >= MAX_SESSIONS) {
      const wi = live.findIndex((s) => s.meta.state === 'waiting');
      const victim = live.splice(wi === -1 ? 0 : wi, 1)[0];
      removeSession(victim.sid);
      log(`[无痕] 会话数超过 ${MAX_SESSIONS}，挤掉${victim.meta.state === 'waiting' ? '未配对的' : '最早的'} ${victim.sid}`);
    }
  }
  let sweeper = null;
  function startSweeper() { if (!sweeper) { sweeper = setInterval(sweep, 60 * 1000); if (sweeper.unref) sweeper.unref(); } }

  /** 一次清空全部分会话：给"清空服务器文件"用，逐会话走 removeSession（它自带删完自检），
   *  再扫一遍孤儿目录，最后把"还剩几个 SID 目录"如实报出来 */
  function purgeAll() {
    let removed = 0;
    let bytes = 0;
    for (const [sid, s] of [...sessions]) {
      bytes += Number(s.meta && s.meta.bytes) || 0;
      removeSession(sid);
      removed++;
    }
    sweep();
    const leftovers = fs.existsSync(TRANSFER_DIR)
      ? fs.readdirSync(TRANSFER_DIR).filter((n) => SID.test(n))
      : [];
    return { sessions: removed, bytes, leftovers: leftovers.length };
  }

  const usedBytes = () => [...sessions.values()].reduce((sum, s) => sum + s.meta.bytes, 0);

  /** 单个分段当前在盘上的真实大小（覆写配额补账要用，读不到按 0 算） */
  function segSizeOf(sid, idx) {
    try { return fs.statSync(path.join(dirOf(sid), `seg-${idx}.bin`)).size; } catch { return 0; }
  }

  /** 连续序号压成区间，别让 20 万个数字变成 1MB 的 JSON */
  function toRanges(setOf) {
    const arr = [...setOf].sort((a, b) => a - b);
    const out = [];
    for (const n of arr) {
      const last = out[out.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else out.push([n, n]);
    }
    return out;
  }

  // ---- SSE：事件走服务器，数据不走（P2P 建立之后服务器只看到信令文本） ----
  function sseOpen(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 一类反代默认缓冲 SSE，事件到不了就"永远在等待对方"
    });
    res.write(': open\n\n');
    const beat = setInterval(() => { try { res.write(': p\n\n'); } catch { /* 下面负责清 */ } }, 20000);
    if (beat.unref) beat.unref();
    const close = () => clearInterval(beat);
    req.on('close', close);
    res.on('close', close);
  }
  function emit(sid, ev, payload, onlyRole) {
    const s = sessions.get(sid);
    if (!s) return;
    const body = `event: ${ev}\ndata: ${JSON.stringify(payload || {})}\n\n`;
    for (const [role, res] of [...s.streams]) {
      if (onlyRole && role !== onlyRole) continue;
      try { res.write(body); } catch { s.streams.delete(role); } // 写失败的连接按角色摘掉，不然 Map 里全是死流
    }
  }

  // 信令会丢：一方"先发后听"时，另一方的事件流还没建起来，emit 就扑空了（key/offer 最容易撞上）。
  // 所以每个 kind **按发方各留最近一条**（ice 每方各留最近 48 条），新流一开就把属于它那一份补发
  // —— 这也是刷新页面后还能重新握手的底气。这里只存字符串、不解释内容，会话对象回收时一起没了。
  // 分槽必须带发方：key 与 confirm 是**两边都会发**的同名信令，只按 kind 留一槽的话，
  // 后发的那条会把先发的那条顶掉（槽连"给谁"一起被改写），于是先发的这一方永远补不到对方公钥 ——
  // 界面上就是"码输进去了，一直停在还没拿到对方公钥"。
  const SIG_KINDS = ['offer', 'answer', 'key', 'confirm', 'channel-ready', 'xfer-error'];
  const SIG_ICE_KEEP = 48;
  function noteSignal(s, kind, from, body) {
    s.sig = s.sig || {};
    const to = from === 'sender' ? 'receiver' : 'sender';
    if (kind === 'ice') {
      s.sig.ice = s.sig.ice || {};
      const list = (s.sig.ice[from] = s.sig.ice[from] || []);
      list.push({ to, body });
      if (list.length > SIG_ICE_KEEP) list.shift();
      return;
    }
    s.sig[kind] = Object.assign({}, s.sig[kind], { [from]: body });
  }
  function replaySignal(s, res, role) {
    if (!s.sig) return;
    const peer = role === 'sender' ? 'receiver' : 'sender';
    const send = (kind, body) => {
      try { res.write(`event: ${kind}\ndata: ${JSON.stringify({ from: peer, body })}\n\n`); }
      catch { /* 这条流已经断了，emit 那边会把它摘掉 */ }
    };
    for (const k of SIG_KINDS) { const slot = s.sig[k]; if (slot && slot[peer] != null) send(k, slot[peer]); }
    for (const c of ((s.sig.ice && s.sig.ice[peer]) || [])) send('ice', c.body);
  }

  // ---- 分段写入的内存上界：express.raw 是把整段读进内存再落盘的，没有上界就是 N×MAX_SEG ----
  let inflight = 0;
  function gateInflight(req, res, next) {
    if (inflight >= MAX_INFLIGHT) return res.status(429).json({ error: '中转正忙，这块稍后重试' });
    inflight++;
    let released = false;
    const release = () => { if (!released) { released = true; inflight--; } };
    res.on('finish', release);
    res.on('close', release); // 客户端断开时 finish 不一定触发：漏放一次就永久少一个名额，攒久了中转全堵死
    next();
  }

  const badRequest = (res, msg) => res.status(400).json({ error: msg });
  const isSid = (sid) => SID.test(String(sid || ''));

  /** 角色判定：接收方凭 proof 摘要，发送方凭 create 时拿到的 token。两者都不进 URL */
  function roleOf(req, s) {
    const token = req.get('X-Xfer-Sender');
    if (token && TOKEN.test(String(token)) && s.meta.senderTokenHash === sha256hex(token)) return 'sender';
    const proof = req.get('X-Xfer-Proof') || (req.body && req.body.proof);
    if (proof && HEX64.test(String(proof)) && s.meta.proofHash === sha256hex(String(proof))) return 'receiver';
    return null;
  }

  function tooManyFails(ip) {
    const rec = rate.get(ip);
    if (!rec) return false;
    if (now() > rec.until) { rate.delete(ip); return false; }
    return rec.fails >= JOIN_FAIL_LIMIT;
  }
  function noteFail(ip) {
    const rec = rate.get(ip) || { fails: 0, until: now() + JOIN_WINDOW_MS };
    rec.fails++;
    rate.set(ip, rec);
  }

  // create 是无凭证端点：限的是「成功建会话」的频率而不是失败次数，单独一个桶。
  // 没有它，任何人刷 create 就能把别人的活跃会话一个个挤掉（挤掉这个动作本身不可逆）。
  function tooManyCreates(ip) {
    const rec = creates.get(ip);
    if (!rec) return false;
    if (now() > rec.until) { creates.delete(ip); return false; }
    return rec.count >= CREATE_LIMIT;
  }
  function noteCreate(ip) {
    const rec = creates.get(ip);
    if (rec && now() <= rec.until) rec.count++;
    else creates.set(ip, { count: 1, until: now() + JOIN_WINDOW_MS });
  }

  // 残留查询是**无凭证**的只读端点（见下方 /residue 的说明），所以单独一个桶限速：
  // 它不是用来防"有人读内容"（读不到），而是防有人拿它当 sid 存在性探针刷库。
  const PROBE_LIMIT = Number(process.env.XFER_PROBE_LIMIT || 120) || 120;
  const probes = new Map();
  function tooManyProbes(ip) {
    const rec = probes.get(ip);
    if (!rec) return false;
    if (now() > rec.until) { probes.delete(ip); return false; }
    return rec.count >= PROBE_LIMIT;
  }
  function noteProbe(ip) {
    const rec = probes.get(ip);
    if (rec && now() <= rec.until) rec.count++;
    else probes.set(ip, { count: 1, until: now() + JOIN_WINDOW_MS });
  }

  function register(app) {
    ensureRoot();
    startSweeper();
    if ((TURN_USER || TURN_PASS) && !TURN_SECRET) {
      log('[无痕] 配了静态 TURN 账号（TURN_USER/TURN_PASS）但没有 TURN_SECRET：静态口令不再下发（/api/xfer/create 是无凭证端点，任何人都能自己建会话自己配对把它领走）。请给 coturn 配 static-auth-secret 并设 TURN_SECRET。');
    }

    // 客户端能力探测：TURN 配了才发短期凭证，没配就明确没有这一档（客户端据此跳过，不空等超时）
    app.get('/api/xfer/config', (req, res) => {
      // 内置 STUN 的地址用**同一个 Host** 拼：两端都是访问这台服务器才打开页面的，
      // 那么这台服务器的内网地址它们一定够得着。换成写死某个 IP 反而会在多网卡/多网段时指错。
      const self = typeof stunSelf === 'function' ? stunSelf(req.headers.host || '') : '';
      const stun = [...new Set([self, ...STUN_URLS].filter(Boolean))];
      res.json({
        stun,
        // 有没有"我们自己的 STUN"：界面据此把"局域网为什么还要中转"翻译成一句人话
        stunSelf: Boolean(self),
        turnConfigured: Boolean(TURN_SECRET && TURN_URLS.length), // 领不到凭证就不能说可用：客户端会白等一轮 ICE 超时
        relayAvailable: true,
        segMax: MAX_SEG,
        ttlMs: TTL_MS,
        maxLifeMs: MAX_LIFE_MS,
        limitBytes: LIMIT_BYTES,
        httpsPort: HTTPS_PORT, // 降级提示要用真实端口，别写死 3443
      });
    });

    // 1) 建会话：sid 与 codeSecret 都在发送端生成；服务器只收 sid + proof + 最少元数据
    //    无凭证端点：限「成功建会话」的频率，不给刷会话挤别人的机会
    app.post('/api/xfer/create', express.json({ limit: '64kb' }), (req, res) => {
      const ip = req.ip || '?';
      if (tooManyCreates(ip)) return res.status(429).json({ error: '创建过于频繁，请 10 分钟后再试' });
      sweep();
      const { sid, proof, frames, totalBytes } = req.body || {};
      if (!isSid(sid)) return badRequest(res, '会话标识不合法');
      if (!HEX64.test(String(proof || ''))) return badRequest(res, '配对校验值不合法');
      if (!Number.isInteger(frames) || frames <= 0 || frames > MAX_FRAMES) return badRequest(res, '分块总数不合法');
      if (!Number.isInteger(totalBytes) || totalBytes <= 0) return badRequest(res, '总字节数不合法');
      if (sessions.has(sid)) return res.status(409).json({ error: '会话标识已被占用，请重试' });
      // 不按"明文总量"预扣中转配额：直连是默认路径，多数会话服务器一个字节都不存，
      // 预扣会把大于 XFER_LIMIT_GB 的正常传输在建会话这一步就拒掉（界面上就是"生成不了码"）。
      // 配额改由 putSeg 按真正落盘的字节记账——走中转时该挡的照样挡得住（见 /seg 写入处）。
      const t = now();
      const token = crypto.randomBytes(16).toString('hex'); // 只在响应里出现一次，服务器存它的摘要
      // proof 只落哈希：能读中转区目录的人拿不到可重放的配对凭证（文档 §8 的承诺）
      const meta = {
        v: SCHEMA_VERSION, sid, proofHash: sha256hex(proof), senderTokenHash: sha256hex(token), state: 'waiting',
        frames, totalBytes, bytes: 0, createdAt: t, expiresAt: t + Math.min(TTL_MS, MAX_LIFE_MS),
      };
      fs.mkdirSync(dirOf(sid), { recursive: true });
      writeJson(path.join(dirOf(sid), 'meta.json'), meta);
      sessions.set(sid, { sid, meta, uploaded: new Set(), acked: new Set(), streams: new Map(), createdAt: t, expiresAt: meta.expiresAt });
      noteCreate(ip);
      // 把预算如实告诉客户端：直连不占中转区，所以"超预算"不是拒绝，而是一句预警 ——
      // 一旦这一单最后只能走中转，到 LIMIT_BYTES 处就会停（以前这里什么都不说，用户只看到"跑到一半断了"）
      res.json({ ok: true, sid, token, expiresAt: meta.expiresAt, limitBytes: LIMIT_BYTES, overBudget: totalBytes > LIMIT_BYTES });
    });

    // 2) 接收方配对：proof 摘要对不上就当没有这个会话，并计入限流
    app.post('/api/xfer/join', express.json({ limit: '64kb' }), (req, res) => {
      const { sid, proof } = req.body || {};
      const ip = req.ip || '?';
      if (tooManyFails(ip)) return res.status(429).json({ error: '配对失败次数过多，请 10 分钟后再试' });
      const s = isSid(sid) ? sessions.get(sid) : null;
      if (!s || !s.meta.proofHash || !HEX64.test(String(proof || '')) || sha256hex(String(proof)) !== s.meta.proofHash) {
        noteFail(ip);
        return res.status(404).json({ error: '传输码无效或会话已结束' }); // 不区分"码错"和"会话不存在"，别给探测者反馈
      }
      if (s.meta.state === 'done' || s.meta.state === 'cancelled') {
        return res.status(410).json({ error: '这个传输码已经用完，不能重开' });
      }
      if (now() > s.expiresAt) { removeSession(sid); return res.status(410).json({ error: '会话已过期' }); }
      if (s.meta.state === 'waiting') {
        s.meta.state = 'paired';
        s.meta.expiresAt = now() + Math.min(TTL_MS, MAX_LIFE_MS); // 配对成功重开一轮窗口，避免"刚连上就过期"
        s.expiresAt = s.meta.expiresAt;
        persist(sid, s);
      }
      res.json({ ok: true, state: s.meta.state, frames: s.meta.frames, totalBytes: s.meta.totalBytes, expiresAt: s.expiresAt });
      emit(sid, 'joined', {}, 'sender');
    });

    // 3) 事件流：发送方带 token、接收方带 proof，只凭 sid 开不了流
    app.get('/api/xfer/events', (req, res) => {
      const { sid, role } = req.query;
      const s = isSid(sid) ? sessions.get(sid) : null;
      if (!s) return res.status(404).json({ error: '会话不存在' });
      if (role !== 'sender' && role !== 'receiver') return badRequest(res, '角色不合法');
      const who = roleOf(req, s);
      if (who !== role) return res.status(403).json({ error: '凭证不匹配' });
      sseOpen(req, res);
      s.streams.set(role, res);
      replaySignal(s, res, role); // 这条流迟到之前攒下的握手消息，补发一遍再收live
      res.on('close', () => { if (s.streams.get(role) === res) s.streams.delete(role); });
      emit(sid, 'hello', { state: s.meta.state, peers: [...s.streams.keys()] }, role === 'sender' ? 'receiver' : 'sender');
    });

    // 4) 信令转发（SDP / ICE）：只搬字符串，不解释内容，也不落盘
    app.post('/api/xfer/signal', express.json({ limit: '256kb' }), (req, res) => {
      const { sid, kind, body } = req.body || {};
      const s = isSid(sid) ? sessions.get(sid) : null;
      if (!s) return res.status(404).json({ error: '会话不存在' });
      const who = roleOf(req, s);
      if (!who) return res.status(403).json({ error: '凭证不匹配' });
      if (!['offer', 'answer', 'ice', 'key', 'confirm', 'channel-ready', 'xfer-error'].includes(kind)) return badRequest(res, '信令类型不合法');
      if (kind === 'offer' && who !== 'sender') return badRequest(res, '信令方向不对');
      if (kind !== 'offer' && who === 'sender' && kind === 'answer') return badRequest(res, '信令方向不对');
      if (typeof body !== 'string' || body.length > 128 * 1024) return badRequest(res, '信令内容不合法');
      emit(sid, kind, { from: who, body }, who === 'sender' ? 'receiver' : 'sender');
      noteSignal(s, kind, who, body);
      res.json({ ok: true });
    });

    // 5) TURN 短期凭证：只有已配对的会话能领，凭证本身按 TURN_TTL_SECONDS 到期
    app.get('/api/xfer/turn', (req, res) => {
      const s = isSid(req.query.sid) ? sessions.get(req.query.sid) : null;
      if (!s) return res.status(404).json({ error: '会话不存在' });
      if (!roleOf(req, s)) return res.status(403).json({ error: '凭证不匹配' });
      if (s.meta.state === 'waiting') return res.status(409).json({ error: '还没有接收方加入' });
      if (!TURN_SECRET) {
        return res.status(503).json({
          error: (TURN_USER || TURN_PASS)
            ? '服务器只配了静态 TURN 账号，已不再下发（长期口令会被任意对端领走）：请改配 TURN_SECRET'
            : '服务器未配置 TURN',
        });
      }
      if (!TURN_URLS.length) return res.status(503).json({ error: 'TURN 地址未配置（TURN_URLS）' });
      const exp = Math.floor(now() / 1000) + TURN_TTL_SECONDS;
      const username = `${exp}:${crypto.randomBytes(8).toString('hex')}`;
      const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      res.json({ urls: TURN_URLS, username, credential, ttlSeconds: TURN_TTL_SECONDS });
    });

    // 6) 上传一个密文分段（发送方 → 中转区）。只有发送方的 token 能写
    app.put('/api/xfer/seg', gateInflight, express.raw({ type: 'application/octet-stream', limit: MAX_SEG }), (req, res) => {
      const s = isSid(req.query.sid) ? sessions.get(req.query.sid) : null;
      if (!s) return res.status(404).json({ error: '会话不存在或已过期' });
      if (roleOf(req, s) !== 'sender') return res.status(403).json({ error: '凭证不匹配' });
      const idx = Number(req.query.i);
      if (!Number.isInteger(idx) || idx < 0 || idx >= s.meta.frames) return badRequest(res, '分块序号不合法');
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_SEG) return badRequest(res, '分段大小不合法');
      const crc = String(req.get('X-Seg-Crc') || '').toLowerCase();
      if (crc && !/^[a-f0-9]{8}$/.test(crc)) return badRequest(res, '非法的分段校验值');
      // 覆写已存在的段也要按「新尺寸-旧尺寸」补账：只算增量的话，先传小的再覆写成大的，
      // 实际落盘能远超配额而账本不动（审计探针实测 24576B 实占 / 300B 账面）
      const oldLen = s.uploaded.has(idx) ? segSizeOf(s.sid, idx) : 0;
      if (usedBytes() + buf.length - oldLen > LIMIT_BYTES) {
        const gb = (n) => `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
        return res.status(413).json({
          error: `中转区装不下了（上限 ${gb(LIMIT_BYTES)}，这一单已占 ${gb(s.meta.bytes)}，全服已用 ${gb(usedBytes())}）`
            + '。两条路：让两端走局域网直连（直连一个字节都不进中转区），或把 XFER_LIMIT_GB 调大后重试',
        });
      }
      const dir = dirOf(s.sid);
      const tmp = path.join(dir, `seg-${idx}.tmp`);
      const dst = path.join(dir, `seg-${idx}.bin`);
      const isNew = !s.uploaded.has(idx);
      try {
        fs.writeFileSync(tmp, buf);
        // 删除旗已经立起来时，这一发是"删除前就进来的"：连 tmp 带目标一起收掉再报 404，
        // 不然 rename 会把刚删掉的目录又重建出来
        if (s.purged) { fs.rmSync(tmp, { force: true }); return res.status(404).json({ error: '会话已销毁' }); }
        fs.renameSync(tmp, dst);
        if (s.purged) { fs.rmSync(dst, { force: true }); return res.status(404).json({ error: '会话已销毁' }); }
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        if (err && err.code === 'ENOSPC') return res.status(507).json({ error: '服务器磁盘空间不足' });
        return res.status(500).json({ error: '写入分段失败' });
      }
      if (isNew) { s.uploaded.add(idx); s.meta.bytes += buf.length; }
      else s.meta.bytes += buf.length - oldLen; // 覆写按差值补账
      persist(s.sid, s);
      res.json({ ok: true, i: idx, size: buf.length, uploaded: s.uploaded.size, total: s.meta.frames });
      if (crc) emit(s.sid, 'seg', { i: idx }, 'receiver');
    });

    // 7) 拉取一个密文分段（接收方 ← 中转区）。流式读，不整文件进内存
    app.get('/api/xfer/seg', (req, res) => {
      const s = isSid(req.query.sid) ? sessions.get(req.query.sid) : null;
      if (!s) return res.status(404).json({ error: '会话不存在或已过期' });
      const who = roleOf(req, s);
      if (who !== 'receiver' && who !== 'sender') return res.status(403).json({ error: '凭证不匹配' });
      const idx = Number(req.query.i);
      if (!Number.isInteger(idx) || idx < 0 || idx >= s.meta.frames) return badRequest(res, '分块序号不合法');
      if (!s.uploaded.has(idx)) return res.status(404).json({ error: '这一段还没传上来' });
      const fp = path.join(dirOf(s.sid), `seg-${idx}.bin`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/octet-stream');
      const stream = fs.createReadStream(fp, { highWaterMark: 1024 * 1024 });
      stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: '读取分段失败' }); else res.destroy(); });
      stream.pipe(res);
    });

    // 8) 状态：双方各自看"上传到哪、对方落盘到哪"
    app.get('/api/xfer/state', (req, res) => {      const s = isSid(req.query.sid) ? sessions.get(req.query.sid) : null;
      if (!s) return res.status(404).json({ error: '会话不存在或已过期' });
      if (!roleOf(req, s)) return res.status(403).json({ error: '凭证不匹配' });
      res.json({
        state: s.meta.state,
        frames: s.meta.frames,
        totalBytes: s.meta.totalBytes,
        bytes: s.meta.bytes,
        uploaded: toRanges(s.uploaded),
        acked: toRanges(s.acked),
        expiresAt: s.expiresAt,
      });
    });

    // 页面开着（含在后台被节流）时给会话续期：一单 2GB 不该因为"30 分钟没动"就作废。
    // 但整单有硬上限 XFER_MAX_LIFE_MINUTES（默认 120）：到点照样清，无痕不是长期存储。
    app.post('/api/xfer/keep', express.json({ limit: '16kb' }), (req, res) => {
      const { sid } = req.body || {};
      const s = isSid(sid) ? sessions.get(sid) : null;
      if (!s) return res.status(404).json({ error: '会话已结束' });
      if (!roleOf(req, s)) return res.status(403).json({ error: '凭证不匹配' });
      if (s.meta.state === 'done' || s.meta.state === 'cancelled') return res.status(410).json({ error: '会话已结束' });
      if (now() > s.expiresAt) { removeSession(sid); return res.status(410).json({ error: '会话已过期' }); }
      const cap = s.createdAt + MAX_LIFE_MS;
      const next = Math.min(now() + TTL_MS, cap);
      s.expiresAt = next;
      s.meta.expiresAt = next;
      persist(sid, s);
      res.json({ ok: true, expiresAt: next, capAt: cap });
    });

    // 9) 接收方确认"这一块已经在本地持久化"。服务端记下它，进度才允许叫"接收完成"。
    //    语义是**信任声明**而不是可验证事实：P2P 直连时数据帧根本不过服务器，服务器无法
    //    验证"本地落盘"；校验 uploaded.has(n) 会把合法直连全部误杀（ack 收到 400）。
    //    它能约束的只有协议帧号空间 —— 伪造 ack 的实际攻击面与直接 cancel 相同，不新增风险。
    app.post('/api/xfer/ack', express.json({ limit: '256kb' }), (req, res) => {
      const { sid, idx } = req.body || {};
      const s = isSid(sid) ? sessions.get(sid) : null;
      if (!s) return res.status(404).json({ error: '会话不存在或已过期' });
      if (roleOf(req, s) !== 'receiver') return res.status(403).json({ error: '凭证不匹配' });
      if (s.meta.state === 'waiting') return res.status(409).json({ error: '还没配对完成，先别确认落盘' });
      const list = Array.isArray(idx) ? idx : [idx];
      for (const n of list) {
        if (!Number.isInteger(n) || n < 0 || n >= s.meta.frames) return badRequest(res, '分块序号不合法');
        s.acked.add(n); // 幂等：重复确认不重复计
      }
      persist(sid, s);
      emit(sid, 'ack', { count: list.length }, 'sender');
      res.json({ ok: true, acked: s.acked.size, total: s.meta.frames });
    });

    // 10) 收尾：done 之前必须每块都被接收端确认落盘；done/cancel 之后密文只留 END_KEEP_MS 就清掉
    const finish = (state) => (req, res) => {
      const { sid } = req.body || {};
      const s = isSid(sid) ? sessions.get(sid) : null;
      if (!s) return res.json({ ok: true, already: true }); // 已经清掉了，就是"结束成功"，别把竞态报成错误
      if (!roleOf(req, s)) return res.status(403).json({ error: '凭证不匹配' });
      if (state === 'done' && s.acked.size !== s.meta.frames) {
        return res.status(409).json({ error: `还有 ${s.meta.frames - s.acked.size} 块没被接收端确认落盘` });
      }
      s.meta.state = state;
      s.expiresAt = now() + END_KEEP_MS; // 留一点点时间给迟到的对端读最终状态，然后清
      s.meta.expiresAt = s.expiresAt;
      persist(sid, s);
      emit(sid, state, {}, null);
      setTimeout(() => { if (sessions.get(sid) === s) removeSession(sid); }, END_KEEP_MS).unref?.();
      res.json({ ok: true, state });
    };
    app.post('/api/xfer/done', express.json({ limit: '64kb' }), finish('done'));
    app.post('/api/xfer/cancel', express.json({ limit: '64kb' }), finish('cancelled'));

    // 11) 立即销毁并自证：用户点"忘记"或"取消并销毁"时要的是一句**可以核对**的话，
    //     不是"60 秒后大概会清"。权限与 finish 一致（发送方 token / 接收方 proof），幂等：
    //     会话已经不在也回 gone=true，客户端据此才允许删掉本地记录。
    app.post('/api/xfer/purge', express.json({ limit: '64kb' }), (req, res) => {
      const { sid } = req.body || {};
      if (!isSid(sid)) return badRequest(res, '会话标识不合法');
      const s = sessions.get(sid);
      let removed = { segments: 0, bytes: 0 };
      if (s) {
        if (!roleOf(req, s)) return res.status(403).json({ error: '凭证不匹配' });
        const r = removeSession(sid);
        removed = { segments: r.segments, bytes: r.bytes };
      }
      // 会话已经不在时也要再扫一次目录：崩溃/被打断留下的孤儿密文不能靠"没有会话"当已清空
      let gone = !fs.existsSync(dirOf(sid));
      if (!gone) {
        try { fs.rmSync(dirOf(sid), { recursive: true, force: true }); } catch { /* 再试一次即可 */ }
        gone = !fs.existsSync(dirOf(sid));
      }
      res.json({ ok: true, gone, removed, sid });
    });

    // 12) 残留核验：**不需要任何凭证**，只回答"服务器上这一单还剩什么"。
    //
    //     为什么必须无凭证：用户真正想要的是"我能不能确认那 2GB 密文滚了"。而唯一能销毁它的
    //     凭据（sender token / receiver proof）恰恰存在**浏览器本地**——隐私模式、清站点数据、
    //     换台机器、误点"清除浏览数据"都会让它消失。本地记录一没，用户就再也没法证明服务器
    //     清干净了，只能相信一句"30 分钟后会清"。这个端点给的就是那句可核对的话。
    //
    //     泄露面（如实记账）：知道 sid 的人能学到"有没有、几段、多少字节、何时到期"。
    //     sid 是 40bit 随机、且本来就出现在 URL 与反代日志里；这里读不到内容、删不掉东西。
    //     有独立限速桶（XFER_PROBE_LIMIT），避免被当成存在性探针刷库。
    app.get('/api/xfer/residue', (req, res) => {
      const ip = req.ip || '?';
      if (tooManyProbes(ip)) return res.status(429).json({ error: '查询过于频繁，请 10 分钟后再试' });
      noteProbe(ip);
      const sid = String(req.query.sid || '');
      if (!isSid(sid)) return badRequest(res, '会话标识不合法');
      const s = sessions.get(sid);
      let segments = 0;
      let bytes = 0;
      let state = '';
      let expiresAt = 0;
      if (s) {
        segments = s.uploaded.size;
        bytes = s.meta.bytes;
        state = s.meta.state;
        expiresAt = s.expiresAt;
      } else {
        // 内存里没有也不等于干净：崩溃/被掐断可能留下孤儿密文目录，这里按磁盘实况回答
        const segs = listSegs(sid);
        segments = segs.size;
        for (const i of segs) bytes += segSizeOf(sid, i);
      }
      // exists 指的是"盘上还有这个会话目录"，比 segments 更严：只有账本没有密文也算还有东西
      const exists = fs.existsSync(dirOf(sid));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ sid, exists, segments, bytes, state, expiresAt });
    });

    // 13) 管理视图：只有状态与字节数，没有任何文件名、密钥或凭证
    app.get('/api/xfer/sessions', (req, res) => {
      res.json([...sessions.values()].map((s) => ({
        sid: s.sid, state: s.meta.state, frames: s.meta.frames,
        uploaded: s.uploaded.size, acked: s.acked.size, bytes: s.meta.bytes, expiresAt: s.expiresAt,
      })));
    });
  }

  return {
    register, bootReclaim, sweep, purgeAll, toRanges,
    _internals: { sessions, usedBytes, removeSession, dirOf, rate, creates, probes },
  };
}

module.exports = { createTransferApi, SCHEMA_VERSION, SID, PROOF: HEX64, TOKEN };
