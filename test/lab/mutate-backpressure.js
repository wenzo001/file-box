// 变异台：把"背压等待"的触发条件钉成永假（等价于改前：缓冲满了也直接掉去走中转）。
// 只动一个布尔，还原就是字符串换回来 —— 删整块容易锚错。
// 用法：node test/lab/mutate-backpressure.js apply | revert
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', '..', 'public', 'xfer-engine.js');
const LIVE = 'if (rtc && rtc.open && rtc.buffered > cfg.dcBufferHigh) {';
const MUT = 'if (false && rtc && rtc.open && rtc.buffered > cfg.dcBufferHigh) {';

const mode = process.argv[2];
const s = fs.readFileSync(FILE, 'utf8');
if (mode === 'apply') {
  if (!s.includes(LIVE)) { console.error('锚文本没找到（产品代码变了？）'); process.exit(9); }
  fs.writeFileSync(FILE, s.replace(LIVE, MUT));
  console.log('变异已落地：背压等待永不触发');
} else if (mode === 'revert') {
  if (!s.includes(MUT)) { console.error('没有变异痕迹（也许已经还原了）'); process.exit(9); }
  fs.writeFileSync(FILE, s.replace(MUT, LIVE));
  console.log('已还原');
} else console.error('用法: apply | revert');
