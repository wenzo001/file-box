// 长按 = 手机的多选入口。三条不打架的规矩，都是"手势抢同一件事"换来的：
// ① 手指移动超过阈值（那就是在滚页面）必须取消，否则一边滚一边把行选上；
// ② 抬起 / 取消 / 失焦 / 滚动都要清定时器 —— 留着会在用户已经松手后补一发选中；
// ③ 触发后要吃掉紧随的 click，否则"长按选中"立刻被"点击打开"覆盖成反义。
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 10;

export function createLongPress({
  onLongPress,
  delay = LONG_PRESS_MS,
  slop = LONG_PRESS_SLOP,
} = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };

  return {
    // 长按成过之后，这一次点击序列里的 click 必须作废
    consumeClick() {
      if (!fired) return false;
      fired = false;
      return true;
    },
    onPointerdown(event) {
      // 只认主键 / 单指：右键自己会走 contextmenu，多指是缩放
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.pointerType === 'mouse') return;   // 鼠标长按不做事，桌面用右键菜单
      fired = false;
      startX = event.clientX;
      startY = event.clientY;
      stop();
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        onLongPress?.();
        // 振一下：让用户知道"进了多选"，而不是等界面自己变
        navigator.vibrate?.(8);
      }, delay);
    },
    onPointermove(event) {
      if (!timer) return;
      if (Math.abs(event.clientX - startX) > slop || Math.abs(event.clientY - startY) > slop) stop();
    },
    onPointerup: stop,
    onPointercancel: stop,
    onPointerleave: stop,
  };
}
