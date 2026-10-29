// 拖拽移动：手势、拖影与顺序动画交给 @formkit/drag-and-drop，本模块只把落点翻译成
// 「这些行 → 这个目标目录」，真正的改动仍走服务端 API（数据以服务端为准）。
//
// 四条实测换来的规矩：
// ① **提交在 drop，不在 setValues**。库在 pointerover 到另一栏的节点上时就调 transfer → setValues
//    （见其 handleNodePointerover2），那发生在**松手之前**：照它提交，等于"鼠标还没抬起文件就搬走了"。
//    所以 setValues 只当"库接受了这次拖放"的信号，一个动作都不做；真正的提交挂在 drop 捕获上。
// ② "拖起了哪几行"要问库自己（onDragstart）：它按 pointerdown 才把 draggable 打开，
//    我们自己在容器上挂的 capture 监听在这一版里抓不到 dragstart（实测提交因此整条断掉）。
// ③ 落点从 DOM 的 data-dnd-* 读，不按"值数组与子元素的序号"配对 —— 分栏随刷新重绘，
//    序号一错库就会读到 undefined 而抛 pageerror，我们也会把文件搬到兄弟目录。
// ④ 悬停要能看见"放这里"：rememberOver 顺手把落点报给界面，松开之前只有高亮，没有任何改动。
import { dragAndDrop } from '@formkit/drag-and-drop';

const bindings = new WeakMap(); // 容器元素 → 最近一次绑定的信息
const hooked = new WeakSet();   // 已经挂过 dragover 的容器
const valueOf = (record) => record && record.data && record.data.value;

let dragging = [];       // 本次拖起的行
let overEl = null;       // 指针最后停在哪个容器上
let overFolderId = null; // 停在某个目录行上时，那个目录
let dragStateRef = () => {};
let moveRef = () => {};
let overRef = () => {};
let dropHooked = false;

/**
 * @param lists  每栏的绑定信息：{ el 容器元素, colKey 这一栏的身份, folderId 这一栏代表的目录（顶级栏是 null）, rows() 当前行描述 }
 * @param onMove ({ dragged: 行描述[], toFolderId: string|null }) => void
 * @param onDragState (active: boolean) => void
 * @param onDragOver ({ colKey, folderId } | null) => void  —— 只用于界面高亮
 */
export function bindColumnDnd({ lists, onMove, onDragState = () => {}, onDragOver = () => {} }) {
  dragStateRef = onDragState;
  moveRef = onMove;
  overRef = onDragOver;
  if (!dropHooked) {
    dropHooked = true;
    // capture：必须早于库自己的 drop 处理（库会在 drop 里再调 setValues，我们那时已经不靠它了）
    document.addEventListener('drop', onDropCapture, true);
  }
  for (const item of lists) {
    bindings.set(item.el, { item });
    if (!hooked.has(item.el)) {
      hooked.add(item.el);
      item.el.addEventListener('dragover', (event) => rememberOver(event.target, item), true);
    }
    dragAndDrop({
      parent: item.el,
      getValues: () => item.rows(),
      setValues: () => {}, // 库的"已接受"信号：不在这里动手，见文件头 ①
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
          overRef(null);
        },
      },
    });
  }
}

function rememberOver(target, item) {
  if (!dragging.length) return;
  const row = target && target.closest ? target.closest('[data-dnd-kind]') : null;
  overEl = item.el;
  overFolderId = folderIdOf(row);
  overRef({ colKey: item.colKey, folderId: overFolderId });
}

// 落点要的是能直接发给 /api 的目录 id（data-dnd-folder），不是行身份 data-dnd-id（folder:<id>）：
// 拿后者去移动，服务端只会回「目标目录不存在」。
function folderIdOf(row) {
  return row && row.dataset.dndKind === 'folder' ? row.dataset.dndFolder : null;
}

function onDropCapture(event) {
  if (!dragging.length) return;
  const el = event.target && event.target.closest ? event.target.closest('.col-list') : null;
  const item = el && (bindings.get(el) || {}).item;
  if (!item) return; // 丢在栏外：什么都不做
  const row = event.target.closest('[data-dnd-kind]');
  const toFolderId = folderIdOf(row) || item.folderId;
  const moved = dragging.slice();
  dragging = [];
  overEl = null;
  overFolderId = null;
  overRef(null);
  moveRef({ dragged: moved, toFolderId });
}
