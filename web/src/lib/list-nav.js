// 列表容器的键盘导航：容器是唯一的 Tab 停靠点，方向键在行之间走焦点。
// 行自己 tabindex="-1"，所以一长串文件不会把 Tab 键拖成马拉松，屏幕阅读器仍然逐行读得出来。
const FOCUSABLE = '.col-row[tabindex="-1"]';

export function moveFocus(list, next) {
  if (!next) return;
  next.focus();
  // 焦点走到可视区外面时只补最小滚动量，不让整栏跳到中间
  next.scrollIntoView({ block: 'nearest' });
}

/** @param event keydown（打在列表容器上） */
export function onListKeydown(event) {
  const list = event.currentTarget;
  const rows = [...list.querySelectorAll(FOCUSABLE)].filter((el) => !el.classList.contains('pending-row'));
  if (!rows.length) return;
  const active = document.activeElement;
  const at = rows.indexOf(active);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(list, rows[Math.min(rows.length - 1, at + 1)] || rows[0]);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    // 焦点还在容器上时按上键，落到最后一行：与 macOS Finder 的直觉一致
    moveFocus(list, at <= 0 ? rows[rows.length - 1] : rows[at - 1]);
  } else if (event.key === 'Home') {
    event.preventDefault();
    moveFocus(list, rows[0]);
  } else if (event.key === 'End') {
    event.preventDefault();
    moveFocus(list, rows[rows.length - 1]);
  } else if (event.key === 'ArrowRight' && at >= 0 && rows[at].classList.contains('folder-row')) {
    event.preventDefault();            // 右 = 进这个目录，交给行的 activate 走同一条业务路径
    rows[at].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
}

/** 容器被 Tab 聚焦时，把焦点交给第一行；已经有行被聚焦则不动 */
export function onListFocus(event) {
  if (event.target !== event.currentTarget) return;
  const first = event.currentTarget.querySelector(FOCUSABLE);
  if (first) first.focus();
}
