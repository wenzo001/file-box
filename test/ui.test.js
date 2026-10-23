// 界面接线（静态资源级）。这一组不打在"看起来对不对"上，只钉几件**曾经真的坏掉过、
// 而且坏了界面就完全看不出问题**的结构事实：
//   ① 接收端进度条 #r-blocks 一条样式都没有 → 接收时那块长条从第一帧起就没画出来过；
//   ② TURN 中继和服务器中转共用同一个圆点颜色 → 用户分不清走了哪条路；
//   ③ 校验/写盘几分钟里保存键的状态没人管 → "卡了很久才弹出按钮"；
//   ④ 每个进度包都整页重画 → 千兆直连下主线程被自己的 UI 占满，进度条反而不动。
// 这些用真浏览器验更贵，而且本机 Chromium 产不出 ICE 候选（见 test/lab/engine-harness.js 顶部），
// 所以把"样式/接线是否存在"和"行为是否正确"分开证：行为在引擎腿里，接线在这里。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUB, 'progress-strip.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'transfer.html'), 'utf8');

test('进度长条必须同时覆盖发送端(#blocks)与接收端(#r-blocks)', () => {
  // 少一个选择器 = 那个方向的格子是零尺寸空盒子，界面上什么都没有
  for (const sel of ['#blocks, #r-blocks', '#blocks .blk, #r-blocks .blk', '#r-blocks .blk.done', '#r-blocks .blk.active']) {
    assert.ok(css.includes(sel), `progress-strip.css 缺少选择器：${sel}`);
  }
});

test('校验阶段的"第二遍扫描"要有独立配色，不能停在 100% 一动不动', () => {
  assert.match(css, /#r-blocks \.blk\.vfy/, 'CSS 里没有 .blk.vfy：校验期间长条会停在满格，看起来跟卡死一样');
  assert.ok(html.includes("'blk vfy'"), 'paintStrip 没有把校验进度画成第二遍扫描');
});

test('五种通道状态各自有样子：直连 / 服务器中转 / TURN / 正在建 / 未连接', () => {
  for (const k of ['p2p', 'server_relay', 'turn_relay', 'p2p_connecting', 'none']) {
    assert.ok(new RegExp(`${k}: \\['`).test(html), `CHAN / CHIP 里没有 ${k} 这一档`);
  }
  // 以前 TURN 与服务器中转都是 'relay'：同色同字，用户没法判断自己有没有在走第三方中继
  assert.ok(html.includes("turn_relay: ['TURN 中继（不是直连）', 'turn']"), 'TURN 中继必须有自己的颜色');
  // 通道圆点与 chip 的配色都在 transfer.html 的内联 <style> 里（progress-strip.css 只管格子）
  assert.match(html, /\.chan\.turn \.dot/, 'CSS 里没有 TURN 的圆点颜色');
  assert.match(html, /\.modes \.chip\.turn/, 'CSS 里没有 TURN 的 chip 配色');
});

test('接收端保存键在"校验中 / 写盘中"必须按不动，并且写明在干什么', () => {
  assert.ok(html.includes('sv.disabled = !ok || busy'), '保存键没有按相位上锁');
  assert.ok(html.includes('校验中，还不能保存') && html.includes('正在写盘…'), '保存键没有对应文案');
  assert.ok(html.includes('id="recv-done-sec"'), '缺少"正在校验 / 正在写盘"的标题位');
  // 校验/写盘期间暂停、重连都是假动作，必须一起置灰并给理由
  assert.match(html, /ps\.disabled = prep \|\| frozen \|\| busy/, '暂停键没有在校验/写盘期间置灰');
});

test('状态更新必须合并到一帧一次（否则主线程被自己重画占满，进度条不动）', () => {
  assert.ok(html.includes('requestAnimationFrame || ((fn) => setTimeout(fn, 16))'),
    'mount() 没有把 emit 合并到 rAF：每落盘一块就整页重画一次');
  assert.ok(html.includes('if (el.dataset.sig === sig) return;'), '模式区每帧重建一次 innerHTML');
  assert.ok(html.includes('if (el.textContent !== text) el.textContent = text;'), '状态行每帧重写一次文本');
});

test('发送端进度取"已发出"与"已进中转区"的较大者（切通道/刷新续传不许倒退）', () => {
  assert.ok(html.includes('Math.max(st.sentFrames || 0, st.uploaded || 0)'),
    '发送端进度会在直连↔中转切换时往回跳');
});
