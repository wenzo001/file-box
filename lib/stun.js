// 极简 STUN 服务（RFC 5389 Binding）：只做一件事 —— 把请求方的**真实源地址**回给它。
//
// 为什么这个项目必须自带它：Chrome 默认把 WebRTC 的 host 候选混淆成 mDNS 名（xxxx.local），
// 跨机器解析要看局域网脸色（防火墙挡组播、AP 隔离、跨 VLAN、访客 Wi-Fi 都会破）。解析不了，
// ICE 就只能失败并降级到服务器中转 —— 两端明明在同一个局域网，却是 4MB/s 而不是千兆。
// 让两端都向**这台服务器**发一次 Binding，拿到的 srflx 候选就是它们各自的局域网 IP:port，
// 彼此可以直接拨号。服务器在这里只回一个地址，不参与任何数据传输，也不记录请求内容。
//
// 边界（别夸大）：只做 Binding，不实现 TURN（那是转发，另一回事）；只开 IPv4
// （udp4），纯 IPv6 局域网用不上 —— 那种环境走 host 候选或 mDNS 即可。
const dgram = require('dgram');

const MAGIC = 0x2112a442;
const BIND_REQUEST = 0x0001;
const BIND_RESPONSE = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_SOFTWARE = 0x8022;
const SOFTWARE = Buffer.from('file-box-stun', 'utf8');

const LOG_LIMIT = 5000; // 每个进程记这么多条就不再记，防止被刷日志

/** 属性编码：type(2) + len(2) + value + 4 字节对齐填充 */
function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const out = Buffer.alloc(4 + value.length + pad);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(value.length, 2);
  value.copy(out, 4);
  return out;
}

/** 点分十进制 → 4 字节。只处理 IPv4：udp4 socket 上收到的源地址一定是 v4。 */
function ipv4Bytes(addr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(addr || ''));
  if (!m) return null;
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1]);
    if (n > 255) return null;
    b[i] = n;
  }
  return b;
}

/** XOR-MAPPED-ADDRESS 的 value 段：保留(1) + family(1) + 端口(2) + 地址(4/16) */
function xorMappedValue(rinfo) {
  const addr = ipv4Bytes(rinfo.address);
  if (!addr) return null;
  const xport = Buffer.alloc(2);
  xport.writeUInt16BE((rinfo.port ^ (MAGIC >>> 16)) & 0xffff, 0);
  const xaddr = Buffer.from(addr);
  for (let i = 0; i < 4; i++) xaddr[i] ^= (MAGIC >>> (24 - i * 8)) & 0xff;
  return Buffer.concat([Buffer.from([0x00, 0x01]), xport, xaddr]);
}

function isStun(msg) {
  if (!Buffer.isBuffer(msg) || msg.length < 20) return false;
  if ((msg[0] & 0xc0) !== 0) return false;          // 头两位必须为 0
  if (msg.readUInt32BE(4) !== MAGIC) return false;  // 没有 magic cookie 的就不是 STUN
  const len = msg.readUInt16BE(2);
  return len % 4 === 0 && len + 20 <= msg.length;
}

/** 一个 Binding 请求 → 一个 Binding 成功响应；不是请求就返回 null（静默丢弃） */
function respond(msg, rinfo) {
  if (!isStun(msg)) return null;
  if (msg.readUInt16BE(0) !== BIND_REQUEST) return null; // 只认 Binding，别的一律不理
  const mapped = xorMappedValue(rinfo);
  if (!mapped) return null;
  const body = Buffer.concat([attr(ATTR_XOR_MAPPED_ADDRESS, mapped), attr(ATTR_SOFTWARE, SOFTWARE)]);
  const out = Buffer.alloc(20 + body.length);
  out.writeUInt16BE(BIND_RESPONSE, 0);
  out.writeUInt16BE(body.length, 2);
  out.writeUInt32BE(MAGIC, 4);
  msg.copy(out, 8, 8, 20); // transaction id 原样带回
  body.copy(out, 20);
  return out;
}

/**
 * @param {{port?: number, log?: (s: string) => void}} opts
 *   port = 0 表示不启动（部署时想用自己的 STUN，设 STUN_PORT=0 并配 STUN_URLS）。
 * @returns {{start(): void, stop(): void, ready: boolean, port: number, hits: number}}
 */
function createStunServer(opts = {}) {
  const port = Number(opts.port) || 0;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const api = {
    ready: false,
    port,
    hits: 0,
    _sock: null,
    start() {
      if (api._sock || !port) return;
      const sock = dgram.createSocket('udp4');
      api._sock = sock;
      sock.on('error', (err) => {
        // 端口被占/没权限：局域网直连退回到 mDNS + TURN 那条老路，功能不残，但要让人知道
        log(`[直连] UDP ${port} 起不来（${err.code || err.message}）：STUN 不可用。`
          + `要在局域网直连，请在防火墙放行 UDP ${port}，或换 STUN_PORT，或自己配 STUN_URLS`);
        try { sock.close(); } catch { /* 已经没了 */ }
        if (api._sock === sock) { api._sock = null; api.ready = false; }
      });
      sock.on('message', (msg, rinfo) => {
        const res = respond(msg, rinfo);
        if (!res) return;
        api.hits++;
        if (api.hits === 1) log(`[直连] STUN 收到第一个请求（来自 ${rinfo.address}），说明局域网直连这条路能走`);
        if (api.hits > LOG_LIMIT) return; // 只到计数为止，不刷屏
        try { sock.send(res, rinfo.port, rinfo.address, () => {}); } catch { /* 对端已经不听了 */ }
      });
      sock.on('listening', () => {
        api.ready = true;
        log(`[直连] 内置 STUN 已在 udp:${port} 监听（局域网两端据此拿到真实内网地址，避免退化到服务器中转）`);
      });
      try { sock.bind(port, '0.0.0.0'); }
      catch (err) { log(`[直连] STUN 绑定失败：${err.message}`); api._sock = null; }
    },
    stop() {
      api.ready = false;
      const s = api._sock;
      api._sock = null;
      if (s) { try { s.close(); } catch { /* 已经关了 */ } }
    },
    /** 给前端用的自述地址：host 由调用方按请求的 Host 头填（两端都用它访问服务器，就一定够得着）。
     *  只跳过 localhost / ::1：那种写法下这条地址帮不到对端，留着只是噪音。
     *  127.x 照发 —— 本机自测（改完代码先自己传一个文件）就是走这条。 */
    urlFor(host) {
      // Host 头可能带端口（127.0.0.1:4444）或 IPv6 方括号（[::1]:3443），先把主机名摘出来
      const raw = String(host || '');
      const h = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']') === -1 ? undefined : raw.indexOf(']'))
        : raw.replace(/:\d+$/, '');
      if (!api.ready || !h || /^localhost$/i.test(h) || h === '::1') return '';
      return `stun:${h.includes(':') ? `[${h}]` : h}:${port}`;
    },
  };
  return api;
}

module.exports = { createStunServer, respond, isStun, xorMappedValue };
