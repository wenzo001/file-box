// 通道判据的变异台：每把刀只动一个表达式，apply 之后跑指定用例，必须变红。
// 用法：node test/lab/mutate-channel.js apply <刀名> | revert
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const FILE = path.join(__dirname, '..', '..', 'public', 'xfer-engine.js');
const BAK = path.join(os.tmpdir(), 'xfer-engine.channel.pristine.js');

const KNIVES = {
  // 刀一：降级前不再复查"通道是不是自己回来了" —— 「抖动不许掐掉直连」那条必须红
  'no-recheck': {
    from: '              if (!rtc || rtc.open) return;',
    to: '              if (!rtc) return;',
  },
  // 刀二：宽限期归零，抖一下立刻降级 —— 「宽限期内不许降级」那条必须红
  'grace-zero': {
    from: '            }, cfg.dcRegraceMs);',
    to: '            }, 0);',
  },
  // 刀三：配对之后不补 TURN 凭证 —— 「joined 后必须补进 ICE」那条必须红
  turn: {
    from: "if (name === 'joined') { patch({ phase: 'pairing' }); upgradeIceWithTurn().catch(() => {}); }",
    to: "if (name === 'joined') patch({ phase: 'pairing' });",
  },
  // 刀四：把兜住"抖动"的两层一起拆掉（onState 里的 open 短路 + 计时器里的复查）。
  //       只拆一层另一层还会兜住 —— 这条用来说清：抖动那条腿是纵深，不是单点。
  'open-blind': {
    parts: [
      { from: '          if (open) {', to: '          if (false && open) {' },
      { from: '              if (!rtc || rtc.open) return;', to: '              if (!rtc) return;' },
    ],
  },
  // 刀五：降级之后不再对迟到的信令免疫 —— 「迟到信令不许变成报错」那条必须红
  'late-blind': {
    from: '            if (!rtc) return;',
    to: '            if (false) return;',
  },
  // 刀六：直连超时只叫发送方改标，接收端一路停在"正在尝试直连" —— 接收端那条腿必须红
  'recv-timeout': {
    from: '      if (rtc) timers.push(setTimeout(() => {',
    to: "      if (rtc && role === 'sender') timers.push(setTimeout(() => {",
  },
  // 刀七：把"先落状态再关 rtc"的次序还回去。rtc.close() 的回调看的是 st.channel，
  //       次序一错就会再降一遍级 —— 但光错这一处，下面那道 sess 检查会兜住，所以
  //       单下这一刀未必有腿变红；要看"两处一起错"才有现场，见 degrade-reentrancy。
  'switch-order': {
    parts: [
      { from: '      patch({ channel: to, note: why || st.note });\n      if (to === \'server_relay\' && rtc) { try { rtc.close(); } catch { /* noop */ } rtc = null; }',
        to: '      if (to === \'server_relay\' && rtc) { try { rtc.close(); } catch { /* noop */ } rtc = null; }\n      patch({ channel: to, note: why || st.note });' },
    ],
  },
  // 刀八：afterHandshake 不看密钥是否已经派生就补验 confirm —— sess 还是 null 时读 kMeta 就炸。
  //       单独一刀没有腿会变红（上面那个次序已经不会再提前叫 afterHandshake），是纵深。
  'no-sess-guard': {
    from: '      if (pendingConfirm && sess) {',
    to: '      if (pendingConfirm) {',
  },
  // 刀九：次序 + sess 复查两道一起拆 —— 这才是当初真炸出来的那个现场（接收端卡 retrying，
  //       报一句 Cannot read properties of null (reading 'kMeta')）。单独拆任何一道都有另一道兜住，
  //       两道一起拆之后这 10 条腿仍然全绿 —— 台架里 confirm 从来没早于密钥到过。
  //       登记在此是为了别把"中途降级"那条腿当成已经钉住了那个现场（见测试文件里的诚实边界）。
  'degrade-reentrancy': {
    parts: [
      { from: '      patch({ channel: to, note: why || st.note });\n      if (to === \'server_relay\' && rtc) { try { rtc.close(); } catch { /* noop */ } rtc = null; }',
        to: '      if (to === \'server_relay\' && rtc) { try { rtc.close(); } catch { /* noop */ } rtc = null; }\n      patch({ channel: to, note: why || st.note });' },
      { from: '      if (pendingConfirm && sess) {', to: '      if (pendingConfirm) {' },
    ],
  },
  // 刀十：把"服务器已经有了就别再发"这道筛子拆掉（只拆尾巴那半）——
  //       「慢确认不许变成第二次 PUT」那条腿必须红。
  'no-dedup': {
    from: '            now - (sentAt.get(n) || 0) >= cfg.retryGapMs && !onServer(n));',
    to: '            now - (sentAt.get(n) || 0) >= cfg.retryGapMs);',
  },
  // 刀十一：主循环里那道同样的筛子（续传路径靠它）。这条单独下没有腿会变红
  //         （台架里主循环每次都从 cursor 前进，不会重撞到已上传的帧），
  //         它守的是"发送端刷新后接着传"那条路 —— 那条的证据在浏览器实验室的 refresh 场景里。
  'no-dedup-main': {
    from: '            if (acked.has(s) || onServer(s)) continue;',
    to: '            if (acked.has(s)) continue;',
  },
};

const mode = process.argv[2];
const knife = process.argv[3];
if (mode === 'revert') {
  if (!fs.existsSync(BAK)) { console.error('没有 pristine 备份'); process.exit(9); }
  fs.copyFileSync(BAK, FILE);
  console.log('已还原 pristine');
} else if (mode === 'apply') {
  const k = KNIVES[knife];
  if (!k) { console.error('未知刀名，可选：' + Object.keys(KNIVES).join(', ')); process.exit(9); }
  const parts = k.parts || [k];
  let s = fs.readFileSync(FILE, 'utf8');
  // 产品文件是 CRLF，刀文里写的是 \n —— 不统一换行就会"锚文本没找到"，报成代码变了
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  const eol = (t) => t.split('\n').join(nl);
  for (const p of parts) {
    const from = eol(p.from); const to = eol(p.to);
    if (!s.includes(from)) { console.error(`刀 ${knife} 的锚文本没找到：${p.from.trim()}（产品代码变了？）`); process.exit(9); }
    s = s.replace(from, to);
  }
  fs.writeFileSync(BAK, fs.readFileSync(FILE));
  fs.writeFileSync(FILE, s);
  console.log(`变异 ${knife} 已落地（${parts.length} 处），pristine 在 ${BAK}`);
} else console.error('用法: apply <grace|turn> | revert');
