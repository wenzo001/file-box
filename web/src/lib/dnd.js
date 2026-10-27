// 拖拽移动：手势、拖影与顺序动画交给 @formkit/drag-and-drop，本模块只把落点翻译成
// 「这些行 → 这个目标目录」，真正的改动仍走服务端 API（数据以服务端为准）。
//
// 三条实测换来的规矩：
// ① 提交点在 setValues，不在 onSort/onTransfer —— 库把"应用新顺序"当作这次拖放被接受的确认，
//    不认领它就会弹回原位；而 setValues 又先于 transfer 事件到达，事件里的目标还没写进来。
// ② "拖起了哪几行"要问库自己（onDragstart）：它按 pointerdown 才把 draggable 打开，
//    我们自己在容器上挂的 capture 监听在这一版里抓不到 dragstart（实测提交因此整条断掉）。
// ③ 落点从 DOM 的 data-dnd-* 读，不按"值数组与子元素的序号"配对 —— 分栏随刷新重绘，
//    序号一错库就会读到 undefined 而抛 pageerror，我们也会把文件搬到兄弟目录。
import { dragAndDrop } from '@formkit/drag-and-drop';

const bindings = new WeakMap(); // 容器元素 → 最近一次绑定的信息
const hooked = new WeakSet();   // 已经挂过 dragover 的容器
const valueOf = (record) => record && record.data && record.data.value;

let dragging = [];       // 本次拖起的行
let overEl = null;       // 指针最后停在哪个容器上
let overFolderId = null; // 停在某个目录行上时，那个目录
let dragStateRef = () => {};
let onMoveRef = () => {};

/**
 * @param lists  每栏的绑定信息：{ el 容器元素, folderId 这一栏代表的目录（顶级栏是 null）, rows() 当前行描述 }
 * @param onMove ({ dragged: 行描述[], toFolderId: string|null }) => void
 */
export function bindColumnDnd({ lists, onMove, onDragState = () => {} }) {
  dragStateRef = onDragState;
  onMoveRef = onMove;
  for (const item of lists) {
    bindings.set(item.el, { item });
    if (!hooked.has(item.el)) {
      hooked.add(item.el);
      item.el.addEventListener('dragover', (event) => rememberOver(event.target, item.el), true);
    }
    dragAndDrop({
      parent: item.el,
      getValues: () => item.rows(),
      setValues: (values, parent) => commit(parent, item),
      config: {
        group: 'filebox',
        animation: false,
        onDragstart: (event) => {
          dragging = (event.draggedNodes || []).map(valueOf).filter(Boolean);
          overEl = null;
          overFolderId = null;
          if (dragging.length) dragStateRef(true);
        },
        onDragend: () => {
          dragging = [];
          overEl = null;
          overFolderId = null;
          dragStateRef(false);
        },
      },
    });
  }
}

function rememberOver(target, el) {
  if (!dragging.length) return;
  const row = target && target.closest ? target.closest('[data-dnd-kind]') : null;
  overEl = el;
  overFolderId = row && row.dataset.dndKind === 'folder' ? row.dataset.dndId : null;
}

function commit(parent, item) {
  if (!dragging.length) return;
  const owner = (bindings.get(parent) || {}).item || item;
  if (overEl && overEl !== owner.el) return; // 只有指针最后停下的那一栏算落点
  const moved = dragging.slice();
  const toFolderId = overFolderId && overEl === owner.el ? overFolderId : owner.folderId;
  dragging = [];
  overEl = null;
  overFolderId = null;
  onMoveRef({ dragged: moved, toFolderId });
}
