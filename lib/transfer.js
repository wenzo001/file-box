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
    LIMIT_BYTES = (Number(process.env.XFER_LIMIT_GB || 2) || 2) * 1024 * 1024 * 1024,
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
    if (s) {
      for (const [, res] of [...s.streams]) { try { res.end(); } catch { /* 客户端已经走了 */ } }
      s.streams.clear();
    }
    sessions.delete(sid);
    try { fs.rmSync(dirOf(sid), { recursive: true, force: true }); } catch { /* 已经没了 */ }
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
  function stopSweeper() { if (sweeper) { clearInterval(sweeper); sweeper = null; } }

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
  const inRanges = (ranges, n) => ranges.some(([a, b]) => n >= a && n <= b);

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
  // 所以每个 kind 只留最近一条（ice 留最近 48 条），新流一开就把属于它那一份补发 —— 这也是刷新
  // 页面后还能重新握手的底气。这里只存字符串、不解释内容，会话对象回收时一起没了。
  const SIG_KINDS = ['offer', 'answer', 'key', 'confirm', 'channel-ready', 'xfer-error'];
  function noteSignal(s, kind, from, body) {
    s.sig = s.sig || {};
    const to = from === 'sender' ? 'receiver' : 'sender';
    if (kind === 'ice') {
      s.sig.ice = s.sig.ice || [];
      s.sig.ice.push({ to, body });
      if (s.sig.ice.length > 48) s.sig.ice.shift();
      return;
    }
    s.sig[kind] = { to, body };
  }
  function replaySignal(s, res, role) {
    if (!s.sig) return;
    const peer = role === 'sender' ? 'receiver' : 'sender';
    const send = (kind, body) => {
      try { res.write(`event: ${kind}\ndata: ${JSON.stringify({ from: peer, body })}\n\n`); }
      catch { /* 这条流已经断了，emit 那边会把它摘掉 */ }
    };
    for (const k of SIG_KINDS) if (s.sig[k] && s.sig[k].to === role) send(k, s.sig[k].body);
    for (const c of (s.sig.ice || [])) if (c.to === role) send('ice', c.body);
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

  function register(app) {
    ensureRoot();
    startSweeper();

    // 客户端能力探测：TURN 配了才发短期凭证，没配就明确没有这一档（客户端据此跳过，不空等超时）
    app.get('/api/xfer/config', (req, res) => {
      res.json({
        stun: STUN_URLS,
        turnConfigured: Boolean(TURN_SECRET || (TURN_URLS.length && TURN_USER && TURN_PASS)),
        relayAvailable: true,
        segMax: MAX_SEG,
        ttlMs: TTL_MS,
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
      if (usedBytes() + totalBytes > LIMIT_BYTES) {
        return res.status(413).json({ error: `无痕传输中转空间不足（上限 ${(LIMIT_BYTES / 1073741824).toFixed(1)}GB）` });
      }
      const t = now();
      const token = crypto.randomBytes(16).toString('hex'); // 只在响应里出现一次，服务器存它的摘要
      // proof 只落哈希：能读中转区目录的人拿不到可重放的配对凭证（文档 §8 的承诺）
      const meta = {
        v: SCHEMA_VERSION, sid, proofHash: sha256hex(proof), senderTokenHash: sha256hex(token), state: 'waiting',
        frames, totalBytes, bytes: 0, createdAt: t, expiresAt: t + TTL_MS,
      };
      fs.mkdirSync(dirOf(sid), { recursive: true });
      writeJson(path.join(dirOf(sid), 'meta.json'), meta);
      sessions.set(sid, { sid, meta, uploaded: new Set(), acked: new Set(), streams: new Map(), createdAt: t, expiresAt: meta.expiresAt });
      noteCreate(ip);
      res.json({ ok: true, sid, token, expiresAt: meta.expiresAt });
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
        s.meta.expiresAt = now() + TTL_MS; // 配对成功重开一轮窗口，避免"刚连上就过期"
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
      if (!TURN_SECRET && !(TURN_URLS.length && TURN_USER && TURN_PASS)) {
        return res.status(503).json({ error: '服务器未配置 TURN' });
      }
      let urls = TURN_URLS, username = TURN_USER, credential = TURN_PASS;
      if (TURN_SECRET) {
        const exp = Math.floor(now() / 1000) + TURN_TTL_SECONDS;
        username = `${exp}:${crypto.randomBytes(8).toString('hex')}`;
        credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      }
      if (!urls.length) return res.status(503).json({ error: 'TURN 地址未配置（TURN_URLS）' });
      res.json({ urls, username, credential, ttlSeconds: TURN_TTL_SECONDS });
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
      if (usedBytes() + buf.length - oldLen > LIMIT_BYTES) return res.status(413).json({ error: '中转空间不足' });
      const dir = dirOf(s.sid);
      const tmp = path.join(dir, `seg-${idx}.tmp`);
      const dst = path.join(dir, `seg-${idx}.bin`);
      const isNew = !s.uploaded.has(idx);
      try {
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, dst);
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
    app.get('/api/xfer/state', (req, res) => {
      const s = isSid(req.query.sid) ? sessions.get(req.query.sid) : null;
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
    app.post('/api/xfer/done', finish('done'));
    app.post('/api/xfer/cancel', finish('cancelled'));

    // 11) 管理视图：只有状态与字节数，没有任何文件名、密钥或凭证
    app.get('/api/xfer/sessions', (req, res) => {
      res.json([...sessions.values()].map((s) => ({
        sid: s.sid, state: s.meta.state, frames: s.meta.frames,
        uploaded: s.uploaded.size, acked: s.acked.size, bytes: s.meta.bytes, expiresAt: s.expiresAt,
      })));
    });
  }

  return {
    register, bootReclaim, sweep, stopSweeper, toRanges, inRanges,
    _internals: { sessions, usedBytes, removeSession, dirOf, rate, creates },
  };
}

module.exports = { createTransferApi, SCHEMA_VERSION, SID, PROOF: HEX64, TOKEN };
