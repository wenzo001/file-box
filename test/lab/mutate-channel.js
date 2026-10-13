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
  for (const p of parts) {
    if (!s.includes(p.from)) { console.error(`刀 ${knife} 的锚文本没找到：${p.from.trim()}（产品代码变了？）`); process.exit(9); }
    s = s.replace(p.from, p.to);
  }
  fs.writeFileSync(BAK, fs.readFileSync(FILE));
  fs.writeFileSync(FILE, s);
  console.log(`变异 ${knife} 已落地（${parts.length} 处），pristine 在 ${BAK}`);
} else console.error('用法: apply <grace|turn> | revert');
