<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useNow } from '@vueuse/core';
import {
  Clock, Download, File, Folder, FolderPlus, HardDrive, Inbox, Info, Link2, ListChecks,
  Package, RotateCcw, Search, Trash2, Upload, X,
} from '@lucide/vue';
import { api } from './lib/api.js';
import { encodeManifest, fetchManifest, invalidateManifest, manifestMap } from './lib/manifest.js';
import { UploadTask, relPath, sortSelected } from './lib/upload.js';
import { clearDownload, downloadFile } from './lib/download.js';
import { createZipRunner, zipPlan } from './lib/zip.js';
import WipeDialog from './components/WipeDialog.vue';
import SettingsSheet from './components/SettingsSheet.vue';
import TopBar from './components/TopBar.vue';
import ColumnBrowser from './components/ColumnBrowser.vue';
import MobileBrowser from './components/MobileBrowser.vue';
import SearchPanel from './components/SearchPanel.vue';
import TaskCenter from './components/TaskCenter.vue';
import ContextMenu from './components/ContextMenu.vue';
import ActionSheet from './components/ActionSheet.vue';
import AppDialog from './components/AppDialog.vue';
import TaskDrawer from './components/TaskDrawer.vue';
import { bindColumnDnd } from './lib/dnd.js';
import { enterSubmits } from './lib/dialog-enter.js';
import { pendingRows } from './lib/pending.mjs';
import { collator, fmtExpiry, fmtSize, ttlLabel } from './lib/format.js';
import { useIsMobile, useKeyboardInset } from './composables/useDevice.js';

const FOLDER_NAME_MAX = 10;
const TTL_FALLBACK = [1, 4, 8, 48, 72, 120, 240, 2160];
const now = useNow({ interval: 15_000 });
const isMobile = useIsMobile();

const data = ref({
  folders: [], batches: [], usage: { used: 0, limit: 1, limitGB: 10 },
  ttlOptions: TTL_FALLBACK, settings: { defaultTtlHours: 1 }, now: Date.now(), libraryReady: true,
});
const currentId = ref(null);
const loading = ref(true);
const filesLoading = ref(false);
const manifestProgress = ref({ done: 0, total: 0 });
const error = ref('');
const manifestError = ref('');
const query = ref('');
const selected = ref([]);
const selectMode = ref(false);
const allFileRows = ref([]);
const manifestState = ref(new Map());
const tasks = ref([]);
const pendingUploads = ref([]);
const resumePending = ref(null);
const settingsTtl = ref(1);
const settingsSaving = ref(false);
const fileInput = ref(null);
const desktopBrowser = ref(null);
const dragTargetKey = ref('');
const toastText = ref('');
const menu = ref(null);
const tasksOpen = ref(true);
const taskDrawer = ref(false);
const shareFileRefs = ref([]);
const sharedFileKeys = ref(new Set());
const sharedFolderIds = ref(new Set());
const shareBanner = ref(false);
const shareMissing = ref(false);
const pulseKeys = ref(new Set());
let pickTarget;
let toastTimer = null;
let pulseTimer = null;
let pollTimer = null;
let taskSeq = 0;
let loadToken = 0;

const dialog = reactive({
  open: false, kind: '', mode: 'confirm', title: '', message: '',
  value: '', error: '', busy: false, destructive: false,
  confirmText: '确定', target: null,
});

const sheet = reactive({ open: false, title: '', subtitle: '', items: [] });

const columnsEl = computed(() => desktopBrowser.value?.columnsEl || null);
const rootLabel = '全部文件';
const folderMap = computed(() => new Map(data.value.folders.map((f) => [f.id, f])));
const ttlOptions = computed(() => (data.value.ttlOptions?.length ? data.value.ttlOptions : TTL_FALLBACK));
const currentFolder = computed(() => (currentId.value ? folderMap.value.get(currentId.value) || null : null));

function pathTo(id) {
  if (!id) return [];
  const out = [];
  const seen = new Set();
  let cur = folderMap.value.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? folderMap.value.get(cur.parentId) : null;
  }
  return out;
}

const path = computed(() => (currentId.value ? pathTo(currentId.value) : []));
const breadcrumb = computed(() => [{ id: null, name: rootLabel }, ...path.value.map((f) => ({ id: f.id, name: f.name }))]);

const uploadTargetId = computed(() => currentId.value || null);
const uploadTargetLabel = computed(() => (
  uploadTargetId.value ? (folderMap.value.get(uploadTargetId.value)?.name || '目录') : rootLabel
));
const uploadTtlText = computed(() => (
  data.value.libraryReady === false ? '自动删除设置暂不可用' : `${ttlLabel(settingsTtl.value)}后自动删除`
));

function sortFolders(list) {
  return list.slice().sort((a, b) => collator.compare(a.name, b.name));
}

function childrenOf(id) {
  return sortFolders(data.value.folders.filter((f) => (
    id === null ? f.parentId === null : f.parentId === id
  )));
}

function filesForFolder(id) {
  const rows = allFileRows.value.filter((r) => r.folderId === id);
  return rows.slice().sort((a, b) => {
    const at = Number.isFinite(a.uploadedAt) ? a.uploadedAt : 0;
    const bt = Number.isFinite(b.uploadedAt) ? b.uploadedAt : 0;
    if (at !== bt) return bt - at;
    return collator.compare(a.name, b.name);
  });
}

const columnIds = computed(() => [null, ...path.value.map((f) => f.id)]);
const columns = computed(() => columnIds.value.map((id) => {
  const folder = id ? folderMap.value.get(id) || null : null;
  return {
    key: id || 'root',
    id,
    folder,
    folders: childrenOf(id),
    // 没有目录的批次就挂在最外层：根那栏同样有文件和影子行
    files: filesForFolder(id),
    pending: pendingRows(tasks.value, id),
  };
}));
// 当前路径上的每一级（含当前这一级自己）：所在栏的那一行要亮成选中态
const pathIds = computed(() => new Set(columnIds.value.slice(1)));
const currentCol = computed(() => columns.value[columns.value.length - 1]);

// ---- 拖拽移动：目录行拖进别的目录 = 换父级；文件行拖进别的目录 = 把这一条拆出批次搬走 ----
const dndOverId = ref(null);
const dndOverCol = ref(null);
function setDndOver(payload) {
  dndOverId.value = payload && payload.folderId ? payload.folderId : null;
  dndOverCol.value = payload ? payload.colKey : null;
}

let dndBusy = false;
let dndDragging = false;
let dndTimer = null;
let dndObserver = null;
let dndObservedEl = null;

function dndRows(col) {
  const rows = [
    ...col.folders.map((f) => ({ kind: 'folder', id: f.id, name: f.name })),
    // 影子行也是这一栏的子元素：库按"值与子元素一一对应"配对，漏掉它们会让后面的行错位
    ...(col.pending || []).map((p) => ({ kind: 'pending', id: p.key })),
    ...col.files.map((r) => ({ kind: 'file', id: r.key, batch: r.batch, enc: r.enc, name: r.name })),
  ];
  // 空栏也渲染了一个占位元素：库按"值与子元素一一对应"配对，条数不一致会在拖放时读到 undefined
  return rows.length ? rows : [{ kind: 'placeholder', id: `${col.key}-empty` }];
}

function bindDnd() {
  if (dndBusy || dndDragging || pointerOnRow) return; // 按住或拖拽在飞时重建绑定，会把这次拖拽掐死在起点
  const el = columnsEl.value;
  if (!el) return;
  // 按 DOM 顺序取容器，与 columns 一一对齐；v-for 里的数组 ref 顺序没有保证，错位会让库把值和子元素配错
  const els = [...el.querySelectorAll('.col-list')];
  const lists = els.map((listEl, i) => ({
    el: listEl,
    colKey: columns.value[i]?.key ?? String(i),
    folderId: columns.value[i]?.id ?? null,
    rows: () => dndRows(columns.value[i] || { folders: [], files: [] }),
  }));
  if (lists.length) bindColumnDnd({
    lists, onMove: onDndMove, onDragState: setDndDragging, onDragOver: setDndOver,
  });
}

function setDndDragging(value) {
  dndDragging = value;
  if (!value) scheduleBind(); // 拖完再对齐一次：重绘产生的新行必须让库重新认识
}

// 库按"值与子元素一一对应"配对：Vue 重绘出的新行它并不认识，hover 到就会读到 undefined 而抛错，
// 所以 DOM 一变就要重新登记。但库是在 pointerdown 时才把 draggable 打开的 ——
// 按下到 dragstart 之间重绑一次，等于把这次拖拽掐死在起点（实测 onDragstart 整条不触发），
// 所以按住期间和拖拽在飞期间都不许重绑。
let pointerOnRow = false;

function scheduleBind() {
  if (dndDragging || dndBusy || pointerOnRow) return;
  clearTimeout(dndTimer);
  dndTimer = setTimeout(bindDnd, 120);
}

function watchColumnsDom() {
  const el = columnsEl.value;
  // 视口从桌面切到手机会销毁这块 DOM：观察器必须跟着换主人，否则一直盯着一棵游离的树
  if (dndObserver && dndObservedEl !== el) {
    dndObserver.disconnect();
    dndObserver = null;
    dndObservedEl = null;
  }
  if (!el) return;
  if (!dndObserver) {
    dndObserver = new MutationObserver(scheduleBind);
    dndObserver.observe(el, { childList: true, subtree: true });
    dndObservedEl = el;
  }
  scheduleBind();
}

async function moveFileRowTo(row, toFolderId) {
  const rec = manifestState.value.get(row.batch);
  if (!rec) throw new Error(`「${row.name}」是旧数据，没有加密清单，请用「⋯」里的「移动这批上传到…」`);
  const entry = (rec.data.files || []).find((f) => f.enc === row.enc);
  if (!entry) throw new Error(`清单里找不到「${row.name}」：清单可能已被改动，刷新页面后重试`);
  const keep = (rec.data.files || []).filter((f) => f.enc !== row.enc);
  const [source, target] = await Promise.all([
    encodeManifest({ ...rec.data, files: keep }),
    encodeManifest({ ...rec.data, files: [entry] }),
  ]);
  await api.moveFile(row.batch, {
    file: row.enc,
    to: toFolderId,
    sourceManifest: source.b64,
    targetManifest: target.b64,
    expectedManifestHash: rec.hash,
  });
  forgetBatchManifest(row.batch);
}

async function onDndMove({ dragged, toFolderId }) {
  if (dndBusy) return; // 一次落点只执行一遍，重复触发不能把移动做两次
  const to = toFolderId || null;
  // 落点只带 kind/id（从 DOM 的 data-dnd-* 读），其余字段回数据里取，不在拖拽层复制一份状态
  const rows = (dragged || [])
    .map((r) => (r.kind === 'folder'
      ? { kind: 'folder', id: r.id }
      : { kind: 'file', row: itemByKey.value.get(r.id)?.file }))
    .filter((r) => (r.kind === 'folder' ? Boolean(folderMap.value.get(r.id)) : Boolean(r.row)))
    .filter((r) => !(r.kind === 'folder' && r.id === to));
  if (!rows.length) return;
  dndBusy = true;
  try {
    for (const r of rows) {
      if (r.kind === 'folder') await api.patchFolder(r.id, { parentId: to });
      else await moveFileRowTo(r.row, to);
    }
    const where = to ? folderMap.value.get(to)?.name || '目标目录' : rootLabel;
    toast(`已移动 ${rows.length} 项到「${where}」`);
    // 锁要跨过这次刷新：刷新会重绘分栏，锁先放开就会在回弹里被再触发一次
    await refreshLibrary({ silent: true });
  } catch (err) {
    error.value = `移动失败：${err.message}`;
  } finally {
    dndBusy = false;
  }
}

watch(columns, () => nextTick(watchColumnsDom), { flush: 'post' });
watch(isMobile, () => nextTick(watchColumnsDom));

const folderPathText = (id) => {
  if (!id) return '全部文件';
  const chain = pathTo(id).map((f) => f.name);
  return chain.length ? `${rootLabel} / ${chain.join(' / ')}` : rootLabel;
};
const parentPathText = (folder) => folderPathText(folder.parentId);

const searchTerm = computed(() => query.value.trim());
const searching = computed(() => searchTerm.value.length > 0);
const searchFolders = computed(() => {
  const q = searchTerm.value.toLowerCase();
  if (!q) return [];
  return data.value.folders
    .filter((f) => f.name.toLowerCase().includes(q))
    .slice(0, 120)
    .map((folder) => ({ folder, path: parentPathText(folder) }));
});
const searchFileResults = computed(() => {
  const q = searchTerm.value.toLowerCase();
  if (!q) return [];
  return allFileRows.value
    .filter((row) => row.name.toLowerCase().includes(q))
    .slice(0, 300)
    .map((row) => ({ row, path: folderPathText(row.folderId) }));
});
const selectedFileCount = computed(() => selectedItems.value.filter((x) => x.type === 'file').length);

const itemByKey = computed(() => {
  const map = new Map();
  for (const folder of data.value.folders) {
    map.set(`folder:${folder.id}`, { type: 'folder', folder, key: `folder:${folder.id}` });
  }
  for (const file of allFileRows.value) {
    map.set(file.key, { type: 'file', file, key: file.key });
  }
  return map;
});

const selectedItems = computed(() => selected.value.map((key) => itemByKey.value.get(key)).filter(Boolean));
const selectedSet = computed(() => new Set(selected.value));
const isSelecting = computed(() => selectMode.value || selected.value.length > 0);

const visibleKeys = computed(() => {
  if (searching.value) {
    return [
      ...searchFolders.value.map((x) => `folder:${x.folder.id}`),
      ...searchFileResults.value.map((x) => x.row.key),
    ];
  }
  // 手机上只有当前这一层：全选的含义是"这一屏看得见的"，不是整棵树
  if (isMobile.value) return columnKeys(currentCol.value);
  return columns.value.flatMap((col) => columnKeys(col));
});

const shareRows = computed(() => allFileRows.value.filter((r) => sharedFileKeys.value.has(r.key)));

function columnKeys(col) {
  if (!col) return [];
  return [
    ...col.folders.map((f) => `folder:${f.id}`),
    ...col.files.map((r) => r.key),
  ];
}
const allSelectedNow = computed(() => {
  const keys = visibleKeys.value;
  return keys.length > 0 && keys.every((k) => selectedSet.value.has(k));
});

const expiringKeys = (row) => (
  Number.isFinite(row.expiresAt) && row.expiresAt - now.value < 10 * 60_000
);

function toggleSelect(key) {
  if (selected.value.includes(key)) selected.value = selected.value.filter((k) => k !== key);
  else selected.value = [...selected.value, key];
}

function allSelectedIn(keys) {
  return keys.length > 0 && keys.every((k) => selectedSet.value.has(k));
}

function toggleColumn(col) {
  const keys = columnKeys(col);
  if (!keys.length) return;
  if (allSelectedIn(keys)) selected.value = selected.value.filter((k) => !keys.includes(k));
  else selected.value = [...new Set([...selected.value, ...keys])];
}

function toggleAll() {
  const keys = visibleKeys.value;
  if (!keys.length) return;
  if (keys.every((k) => selectedSet.value.has(k))) {
    selected.value = selected.value.filter((k) => !keys.includes(k));
    if (!selected.value.length) selectMode.value = false;
  } else {
    selected.value = [...new Set([...selected.value, ...keys])];
  }
}

// 手机：长按进多选并把这一项选上；退出多选要清干净，不能留一串看不见的选中项
function enterSelect(key) {
  selectMode.value = true;
  if (key && !selected.value.includes(key)) selected.value = [...selected.value, key];
}
function exitSelect() {
  selectMode.value = false;
  selected.value = [];
}

function toast(message) {
  toastText.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText.value = ''; }, 3200);
}

// URL 只由这一处写：目录 + 分享进来的文件引用。分享横幅还在内存里的时候，
// 刷新页面也得能把它还原出来 —— 两个状态写两份名单必然分叉。
function writeUrl(push) {
  const url = new URL(location.href);
  url.search = '';
  if (currentId.value) url.searchParams.set('f', currentId.value);
  for (const ref of shareFileRefs.value) url.searchParams.append('file', ref);
  const state = { f: currentId.value };
  if (push) history.pushState(state, '', url);
  else history.replaceState(state, '', url);
}
function updateUrl() { writeUrl(true); }
function replaceUrl() { writeUrl(false); }

async function refreshPending() {
  try { pendingUploads.value = (await api.uploads()).uploads; }
  catch { /* 列表不是关键路径 */ }
}

function buildRows(records) {
  const rows = [];
  for (const b of data.value.batches) {
    const rec = records.get(b.name) || null;
    const mmap = manifestMap(rec);
    for (const f of b.files || []) {
      if (f.name === 'manifest.enc') continue;
      const meta = mmap.get(f.name);
      rows.push({
        key: `file:${b.name}/${f.name}`,
        batch: b.name,
        enc: f.name,
        name: meta?.name || f.name,
        plainSize: meta ? meta.size : null,
        size: meta ? meta.size : f.size,
        cipherSize: f.size,
        downloads: f.downloads || 0,
        uploadedAt: b.uploadedAt,
        expiresAt: b.expiresAt,
        ttlHours: b.ttlHours,
        legacy: b.legacy,
        folderId: b.folderId || null,
        hasManifest: Boolean(rec),
        missingMeta: Boolean(rec) && !meta,
      });
    }
  }
  allFileRows.value = rows;
}

async function loadFiles({ force = false } = {}) {
  const token = ++loadToken;
  const batches = data.value.batches;
  const names = new Set(batches.map((b) => b.name));
  const records = new Map(manifestState.value);
  for (const key of [...records.keys()]) if (!names.has(key)) records.delete(key);
  // 清单哈希由服务端在改名 / 删除时更新：轮询看到它变了就重拉，别让当前目录停在旧名字
  for (const b of batches) {
    const cached = records.get(b.name);
    if (b.manifestHash && (!cached || cached.hash !== b.manifestHash)) {
      records.delete(b.name);
      invalidateManifest(b.name);
    }
  }
  const missing = batches.filter((b) => force || !records.has(b.name));
  if (!missing.length) {
    buildRows(records);
    filesLoading.value = false;
    return;
  }
  filesLoading.value = true;
  manifestError.value = '';
  manifestProgress.value = { done: 0, total: missing.length };
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= missing.length) return;
      const b = missing[index];
      let rec = null;
      try { rec = await fetchManifest(b.name, { force }); }
      catch (err) {
        manifestError.value = err.message || '清单加载失败：点「重试」或刷新页面';
        // 不缓存失败结果：否则重试按钮永远命中这个 null，再也不去拉清单
        records.delete(b.name);
        manifestProgress.value = { done: manifestProgress.value.done + 1, total: missing.length };
        continue;
      }
      records.set(b.name, rec);
      manifestProgress.value = { done: manifestProgress.value.done + 1, total: missing.length };
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, missing.length) }, worker));
  if (token !== loadToken) return;
  manifestState.value = records;
  buildRows(records);
  filesLoading.value = false;
  applyShare();
}

async function refreshLibrary({ silent = false, force = false } = {}) {
  try {
    const res = await api.library();
    // 当前目录被删了（自己删的、别的标签页删的、从上层把整棵删掉都一样）：
    // 退回它**还活着的最深一级上级**，别一路重置回根 —— 删掉子目录后用户还在同一个项目里。
    // 上级链路取自刷新前的树：刷新后的树里已经没有它了，算不出来。
    const prevFolders = data.value.folders;
    data.value = res;
    if (!settingsSaving.value) settingsTtl.value = res.settings?.defaultTtlHours ?? 1;
    if (currentId.value && !res.folders.some((f) => f.id === currentId.value)) {
      const alive = new Set(res.folders.map((f) => f.id));
      const prevById = new Map(prevFolders.map((f) => [f.id, f]));
      const seen = new Set();
      let fallback = null;
      let cursor = prevById.get(currentId.value)?.parentId ?? null;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        if (alive.has(cursor)) { fallback = cursor; break; }
        cursor = prevById.get(cursor)?.parentId ?? null;
      }
      currentId.value = fallback;
      replaceUrl();
    }
    await loadFiles({ force });
    if (!silent) error.value = '';
    applyShare();
    selected.value = selected.value.filter((key) => itemByKey.value.has(key));
    if (!selected.value.length) selectMode.value = false;
    refreshPending();
  } catch (err) {
    if (!silent) error.value = err.message || '加载失败';
  }
}

function scrollColumnsToEnd() {
  const el = columnsEl.value;
  if (el) el.scrollLeft = el.scrollWidth;
}

async function navigate(id) {
  const next = id || null;
  query.value = '';
  selected.value = [];
  selectMode.value = false;
  closeMenu();
  if (next === currentId.value) {
    await refreshLibrary({ silent: true });
    await nextTick();
    scrollColumnsToEnd();
    return;
  }
  currentId.value = next;
  updateUrl();
  await refreshLibrary({ silent: true });
  await nextTick();
  scrollColumnsToEnd();
  setTimeout(scrollColumnsToEnd, 120);
}

async function goBack() {
  const parent = path.value.length >= 2 ? path.value[path.value.length - 2].id : null;
  await navigate(parent);
}

async function navigateToFile(row) {
  await navigate(row.folderId);
  pulse(row.key);
}

function onPop() {
  const params = new URLSearchParams(location.search);
  currentId.value = params.get('f') || null;
  query.value = '';
  shareFileRefs.value = params.getAll('file');
  if (!shareFileRefs.value.length) {
    sharedFileKeys.value = new Set();
    sharedFolderIds.value = new Set();
    shareBanner.value = false;
    shareMissing.value = false;
  }
  refreshLibrary({ silent: true }).then(() => {
    applyShare();
    if (shareFileRefs.value.length) {
      const hit = allFileRows.value.find((r) => shareFileRefs.value.includes(`${r.batch}/${r.enc}`));
      if (hit) currentId.value = hit.folderId || null;
    }
    nextTick(scrollColumnsToEnd);
  });
}

function pulse(key) {
  pulseKeys.value = new Set([...pulseKeys.value, key]);
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => { pulseKeys.value = new Set(); }, 3200);
}

function applyShare() {
  if (!shareFileRefs.value.length) return;
  const rows = allFileRows.value.filter((r) => shareFileRefs.value.includes(`${r.batch}/${r.enc}`));
  sharedFileKeys.value = new Set(rows.map((r) => r.key));
  sharedFolderIds.value = new Set(rows.map((r) => r.folderId).filter(Boolean));
  shareBanner.value = rows.length > 0;
  shareMissing.value = rows.length === 0;
}

function dismissShare() {
  shareFileRefs.value = [];
  sharedFileKeys.value = new Set();
  sharedFolderIds.value = new Set();
  shareBanner.value = false;
  shareMissing.value = false;
  replaceUrl();
}

function focusShared(row) { navigateToFile(row); }

function chooseUpload(folderId) {
  resumePending.value = null;
  pickTarget = folderId === undefined ? uploadTargetId.value : folderId;
  fileInput.value?.click();
}

function triggerUpload() { chooseUpload(); }

function onFilesPicked(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  const pending = resumePending.value;
  const target = pickTarget;
  resumePending.value = null;
  pickTarget = undefined;
  if (pending) addUpload(files, { folderId: pending.folderId, ttlHours: pending.ttlHours });
  else addUpload(files, { folderId: target === undefined ? uploadTargetId.value : target });
}

function addUpload(files, { folderId = null, ttlHours = null } = {}) {
  if (!window.FBCrypto) { toast('加密模块未加载，请刷新页面'); return; }
  sortSelected(files);
  const target = folderId || null;
  const task = reactive({
    id: `task-${++taskSeq}`,
    kind: 'upload',
    title: files.length === 1 ? relPath(files[0]) : `${relPath(files[0])} 等 ${files.length} 个文件`,
    state: 'queued', done: 0, total: 0, doneBytes: 0, error: '', result: null, note: '',
    targetLabel: target ? (folderMap.value.get(target)?.name || '目录') : rootLabel,
    // 影子行：进行中的文件要立刻出现在目标目录那栏里
    folderId: target,
    names: files.map(relPath),
    sizes: files.map((f) => f.size),
    fileProgress: files.map(() => 0),
    ttlHours,
  });
  const up = new UploadTask(files, {
    folderId: target,
    ttlHours,
    onUpdate: (u) => {
      Object.assign(task, u);
      if (u.state === 'done') {
        const res = u.result || {};
        const resultFolder = res.folderId || null;
        refreshLibrary({ silent: true });
        refreshPending();
        if (res.indexed === false) {
          toast('上传完成，但目录索引不可用：文件在最外层（全部文件），未设置自动删除（稍后刷新；一直这样就看服务日志）');
          navigate(null);
        } else if (res.folderMissing) {
          toast('上传完成，但目标目录已不存在：文件在最外层（全部文件）');
          navigate(resultFolder || null);
        } else {
          const expiry = res.expiresAt ? fmtExpiry(res.expiresAt, Date.now()) : '未设置自动删除';
          toast(`已上传到「${task.targetLabel}」· ${expiry}`);
        }
      } else if (u.state === 'failed') {
        toast(u.error || '上传失败');
      }
    },
  });
  task.uploader = up;
  task.pause = () => up.pause();
  task.resume = () => up.resume();
  task.cancel = () => up.cancel();
  task.remove = () => { tasks.value = tasks.value.filter((t) => t !== task); };
  task.openResult = () => navigate(task.result?.folderId || null);
  // 手机上切到后台时告诉用户一句：持了 Web Lock 但系统仍可能节流
  const onVis = () => {
    if (['running', 'finishing'].includes(task.state)) {
      task.note = document.hidden ? '页面在后台，系统可能把上传暂停' : '';
    }
  };
  document.addEventListener('visibilitychange', onVis);
  tasks.value.unshift(task);
  up.run().finally(() => document.removeEventListener('visibilitychange', onVis));
}

// 粘贴上传：剪贴板里带文件（截图 / 从资源管理器复制）就传到当前目录；文本粘贴和输入框里的粘贴一律不碰
function onPaste(event) {
  const el = event.target;
  if (el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
  if (document.querySelector('.dialog')) return; // 弹层开着时不做后台动作
  const dt = event.clipboardData;
  if (!dt) return;
  const files = Array.from(dt.files || []);
  if (!files.length) {
    for (const item of Array.from(dt.items || [])) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return; // 纯文本粘贴：交回浏览器
  event.preventDefault();
  addUpload(files, { folderId: uploadTargetId.value });
}

function onColumnDragOver(event, col) {
  // 只认领「从系统里拖文件进来」这一类；栏内拖拽移动交给 dnd 库，这里不许抢 dropEffect
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  // 库把 dragover/drop 处理器挂在同一个 .col-list 上，stopPropagation 拦不住同元素的其他监听
  event.stopImmediatePropagation();
  dragTargetKey.value = col.key;
  event.dataTransfer.dropEffect = 'copy';
}

function onColumnDragLeave(event, col) {
  if (dragTargetKey.value === col.key) dragTargetKey.value = '';
}

function onColumnDrop(event, col) {
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return; // 栏内拖拽移动的落点交给 dnd 库（它的 drop 就挂在同一个元素上）
  event.preventDefault();
  event.stopImmediatePropagation();
  dragTargetKey.value = '';
  const folderId = col.id || null;
  addUpload(files, { folderId });
}

function showMenu(x, y, items) {
  if (!items?.length) return;
  menu.value = { x, y, items };
}

function showMenuFor(event, items) {
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, items);
}

function closeMenu() { menu.value = null; }

function runMenu(item) {
  if (!item || item.disabled) return;
  closeMenu();
  item.run?.();
}

function openFolderMenu(event, folder) {
  event.preventDefault();
  event.stopPropagation();
  showMenu(event.clientX, event.clientY, folderMenuItems(folder));
}

function openFileMenu(event, row) {
  event.preventDefault();
  event.stopPropagation();
  showMenu(event.clientX, event.clientY, fileMenuItems(row));
}

function openColumnMenu(event, col) {
  event.preventDefault();
  event.stopPropagation();
  showMenu(event.clientX, event.clientY, columnMenuItems(col));
}

// 手机：同一个业务清单换成底部操作表；条目与桌面右键菜单出自同一批构造函数。
// 抽屉不需要触发点坐标，所以这两个入口只收"哪一项"。
function openFolderSheet(folder) {
  sheet.title = folder.name;
  sheet.subtitle = '文件夹操作';
  sheet.items = folderMenuItems(folder);
  sheet.open = true;
}

function openFileSheet(row) {
  sheet.title = row.name;
  sheet.subtitle = '文件操作';
  sheet.items = fileMenuItems(row);
  sheet.open = true;
}

function folderMenuItems(folder) {
  return [
    { label: '打开', icon: Folder, run: () => navigate(folder.id) },
    { label: '重命名', icon: File, run: () => openRenameFolder(folder) },
    { label: '移动到…', icon: Folder, run: () => openMoveFolder(folder) },
    { label: '在此新建子文件夹', icon: FolderPlus, run: () => openNewFolder(folder.id) },
    { label: '复制文件夹链接', icon: Link2, run: () => copyFolderLink(folder.id) },
    { label: '打包下载', icon: Package, run: () => downloadFolderZip(folder) },
    { sep: true },
    { label: '删除文件夹', icon: Trash2, danger: true, run: () => openDeleteFolder(folder) },
  ];
}

function fileMenuItems(row) {
  return [
    { label: '下载', icon: Download, run: () => addDownload(row) },
    { label: '重命名', icon: File, disabled: !row.hasManifest, run: () => openRenameFile(row) },
    { label: '移动这批上传到…', icon: Folder, run: () => openMoveBatch(row) },
    { label: '复制文件分享链接', icon: Link2, run: () => copyFileLink([row]) },
    { sep: true },
    { label: '删除文件', icon: Trash2, danger: true, run: () => openDeleteFile(row) },
  ];
}

function columnMenuItems(col) {
  const items = [
    { label: col.id ? '在此新建子文件夹' : '新建文件夹', icon: FolderPlus, run: () => openNewFolder(col.id) },
    { label: '上传文件到此处', icon: Upload, run: () => chooseUpload(col.id || null) },
  ];
  if (col.folder) {
    items.push(
      { label: '复制文件夹链接', icon: Link2, run: () => copyFolderLink(col.folder.id) },
      { label: '打包下载', icon: Package, run: () => downloadFolderZip(col.folder) },
    );
  }
  if (col.folder) {
    items.push({ sep: true }, { label: '删除文件夹', icon: Trash2, danger: true, run: () => openDeleteFolder(col.folder) });
  }
  return items;
}

async function addDownload(row) {
  const task = reactive({
    id: `task-${++taskSeq}`, kind: 'download', title: row.name, state: 'running',
    received: 0, total: row.cipherSize || 0, error: '', row, phase: 'download', note: '',
  });
  let controller = new AbortController();
  let canceled = false;
  const run = async () => {
    task.state = 'running';
    task.error = '';
    controller = new AbortController();
    try {
      await downloadFile(
        { batch: row.batch, enc: row.enc, name: row.name, size: row.cipherSize, plainSize: row.plainSize },
        {
          signal: controller.signal,
          memCapBytes: data.value.memDownloadMaxBytes,
          onUpdate: (p) => {
            if (p.phase) task.phase = p.phase;
            if (Number.isFinite(p.received)) task.received = p.received;
            if (p.total) task.total = p.total;
            if (p.phase === 'waiting') {
              task.note = `网络中断，${Math.max(1, Math.round((p.retryInMs || 1000) / 1000))} 秒后从 ${fmtSize(p.received || 0)} 继续（第 ${p.attempt} 次）`;
            } else if (p.phase === 'decrypt') task.note = '正在解密并写入本地';
            else if (p.phase === 'save') task.note = '正在交给浏览器保存';
            else if (p.phase === 'download') task.note = '';
          },
        },
      );
      task.state = 'done';
      task.phase = 'done';
      task.note = '';
      toast('已下载');
      refreshLibrary({ silent: true });
    } catch (err) {
      task.note = '';
      task.phase = 'idle';
      if (canceled) task.state = 'canceled';
      else if (err.name === 'AbortError') task.state = 'paused';
      else { task.state = 'failed'; task.error = err.message || '下载失败'; toast(task.error); }
    }
  };
  task.pause = () => { if (task.state !== 'running') return; task.state = 'paused'; controller.abort(); };
  task.resume = () => { if (task.state === 'canceled' || task.state === 'done') return; run(); };
  task.cancel = async () => {
    canceled = true;
    controller.abort();
    await clearDownload(row.batch, row.enc);
    task.state = 'canceled';
  };
  task.remove = () => { tasks.value = tasks.value.filter((t) => t !== task); };
  tasks.value.unshift(task);
  run();
}

function startZipTask(title, items, filename) {
  const list = items.filter(Boolean);
  const task = reactive({
    id: `task-${++taskSeq}`, kind: 'zip', title, state: 'running',
    received: 0, total: 0, error: '', files: list.filter((it) => !it.dir).length, note: '', tier: '',
  });
  let controller = null;
  let paused = false;
  let canceled = false;
  let runner = null;
  let plan = null;

  // 先按能力选档：磁盘流式 / 内存 / 逐个文件（降级）
  const ensure = async () => {
    if (!plan) plan = await zipPlan(list, data.value.memZipMaxBytes || data.value.memDownloadMaxBytes || 0);
    if (plan.tier === 'per-file') return null;
    if (!runner) {
      runner = createZipRunner({
        items: list, tier: plan.tier, filename,
        onProgress: (p) => { task.received = p.received; task.total = p.total || task.total; },
      });
      task.total = runner.total;
      task.tier = runner.tier;
      task.note = plan.reason;
    }
    return runner;
  };

  const run = async () => {
    task.state = 'running';
    task.error = '';
    paused = false;
    controller = new AbortController();
    try {
      const r = await ensure();
      if (!r) {
        // 降级档：这台设备打不了大包，改成逐个文件下载（每个文件再走它自己的阶梯）
        const files = list.filter((it) => !it.dir);
        for (const it of files) {
          if (canceled) break;
          addDownload({
            batch: it.batch, enc: it.enc,
            name: String(it.path || it.enc).split('/').pop(),
            cipherSize: it.cipherSize, plainSize: it.plainSize,
          });
        }
        task.received = task.total = 1;
        task.tier = 'per-file';
        task.state = 'done';
        task.note = plan.reason;
        toast(`这台设备不支持大包，已改为逐个下载 ${files.length} 个文件`);
        return;
      }
      await r.run({ signal: controller.signal });
      if (canceled) { task.state = 'canceled'; return; }
      if (paused) { task.state = 'paused'; return; }
      task.received = task.total;
      task.state = 'done';
      toast('打包完成，浏览器已开始保存');
    } catch (err) {
      if (canceled) task.state = 'canceled';
      else if (paused || err.name === 'AbortError') task.state = 'paused';
      else { task.state = 'failed'; task.error = err.message || '打包失败'; toast(task.error); }
    }
  };
  task.pause = () => {
    if (task.state !== 'running') return;
    paused = true;
    controller?.abort();
    task.state = 'paused';
    // zip 是顺序写入的流：半截压缩包不能续，下一轮从头打包（密文 partial 还在，不会重下）
    const old = runner;
    runner = null;
    if (old) old.dispose().catch(() => {});
    task.note = '继续会从头重新打包（不会重新下载）';
  };
  task.resume = () => {
    if (task.state === 'done' || task.state === 'canceled') return;
    paused = false;
    task.state = 'running';
    run();
  };
  task.cancel = () => {
    canceled = true;
    paused = false;
    controller?.abort();
    const old = runner;
    runner = null;
    if (old) old.dispose().catch(() => {});
    task.state = 'canceled';
  };
  task.remove = () => { tasks.value = tasks.value.filter((t) => t !== task); };
  tasks.value.unshift(task);
  run();
}

function buildFolderZipItems(root) {
  const items = [];
  const stack = [{ fid: root.id, prefix: root.name }];
  while (stack.length) {
    const { fid, prefix } = stack.pop();
    const children = childrenOf(fid);
    const files = allFileRows.value.filter((r) => r.folderId === fid);
    if (!children.length && !files.length) items.push({ path: prefix, dir: true });
    for (const child of children) stack.push({ fid: child.id, prefix: `${prefix}/${child.name}` });
    for (const row of files) {
      items.push({
        path: `${prefix}/${row.name}`, batch: row.batch, enc: row.enc,
        plainSize: row.plainSize, cipherSize: row.cipherSize,
      });
    }
  }
  return items;
}

async function downloadFolderZip(folder) {
  if (!folder) return;
  await loadFiles();
  const items = buildFolderZipItems(folder);
  if (!items.some((it) => !it.dir)) { toast('这个目录还没有文件：先上传，或换一个有内容的目录'); return; }
  startZipTask(`打包下载「${folder.name}」`, items, `${folder.name}.zip`);
}

async function downloadSelectedZip() {
  if (!selectedItems.value.length) return;
  await loadFiles();
  const items = [];
  for (const item of selectedItems.value) {
    if (item.type === 'folder') items.push(...buildFolderZipItems(item.folder));
    else {
      items.push({
        path: item.file.name, batch: item.file.batch, enc: item.file.enc,
        plainSize: item.file.plainSize, cipherSize: item.file.cipherSize,
      });
    }
  }
  if (!items.some((it) => !it.dir)) { toast('选中的内容里没有文件（只有空目录）：换一批再试'); return; }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  startZipTask('打包选中内容', items, `文件盒子-${stamp}.zip`);
}

function clearDone() {
  tasks.value = tasks.value.filter((t) => !['done', 'canceled'].includes(t.state));
}

function openPrompt(kind, title, value = '', target = null, message = '') {
  Object.assign(dialog, {
    open: true, kind, mode: 'prompt', title, message, value, error: '',
    busy: false, destructive: false, confirmText: '确定', target,
  });
}

function openConfirm(kind, title, message, target = null) {
  Object.assign(dialog, {
    open: true, kind, mode: 'confirm', title, message, value: '', error: '',
    busy: false, destructive: true, confirmText: '删除', target,
  });
}

function openMoveFolder(folder) {
  Object.assign(dialog, {
    open: true, kind: 'move-folder', mode: 'move', title: '移动到…', message: '',
    value: folder.parentId || '', error: '', busy: false, destructive: false,
    confirmText: '移动', target: { folder },
  });
}

function openMoveBatch(row) {
  Object.assign(dialog, {
    open: true, kind: 'move-batch', mode: 'move', title: '移动这批上传到…', message: '',
    value: row.folderId || '', error: '', busy: false, destructive: false,
    confirmText: '移动', target: { row },
  });
}

function openNewFolder(parentId = undefined) {
  const pid = parentId === undefined ? (currentId.value || null) : (parentId || null);
  openPrompt('new-folder', '新建文件夹', '', { parentId: pid }, `最多 ${FOLDER_NAME_MAX} 个字；分享链接由目录 ID 固定，改名不会变。`);
}

function forgetBatchManifest(batch) {
  invalidateManifest(batch);
  const next = new Map(manifestState.value);
  next.delete(batch);
  manifestState.value = next;
}

async function removeFileRow(row) {
  const rec = manifestState.value.get(row.batch);
  if (rec) {
    const files = (rec.data.files || []).filter((f) => f.enc !== row.enc);
    const next = await encodeManifest({ ...rec.data, files });
    await api.deleteFile(row.batch, {
      file: row.enc,
      manifest: next.b64,
      expectedManifestHash: rec.hash,
    });
  } else {
    await api.deleteFile(row.batch, { file: row.enc });
  }
  forgetBatchManifest(row.batch);
}

async function renameFileRow(row, newName) {
  const rec = manifestState.value.get(row.batch);
  if (!rec) throw new Error('旧数据没有加密清单，不能重命名：需要改名的话重新上传一份');
  const files = (rec.data.files || []).map((f) => (f.enc === row.enc ? { ...f, name: newName } : f));
  const next = await encodeManifest({ ...rec.data, files });
  await api.renameFile(row.batch, {
    file: row.enc,
    manifest: next.b64,
    expectedManifestHash: rec.hash,
  });
  forgetBatchManifest(row.batch);
}

function openRenameFolder(folder) {
  openPrompt('rename-folder', '重命名文件夹', folder.name, { folder }, `最多 ${FOLDER_NAME_MAX} 个字；分享链接由目录 ID 固定，改名不会变。`);
}

function openRenameFile(row) {
  openPrompt('rename-file', '重命名文件', row.name, { row });
}

function collectFolderTree(rootId) {
  const folderIds = new Set([rootId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of data.value.folders) {
      if (f.parentId && folderIds.has(f.parentId) && !folderIds.has(f.id)) {
        folderIds.add(f.id);
        changed = true;
      }
    }
  }
  const depth = (id) => {
    let d = 0;
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      d++;
      cur = folderMap.value.get(cur)?.parentId || null;
    }
    return d;
  };
  const folders = [...folderIds].sort((a, b) => depth(b) - depth(a));
  const batches = data.value.batches.filter((b) => b.folderId && folderIds.has(b.folderId));
  return { folders, batches };
}

function startDeleteTask(title, items) {
  const task = reactive({
    id: `task-${++taskSeq}`, kind: 'folder-delete', title, state: 'running',
    items, index: 0, error: '',
  });
  let paused = false;
  let canceled = false;
  const run = async () => {
    task.state = 'running';
    task.error = '';
    try {
      while (task.index < task.items.length) {
        if (canceled) { task.state = 'canceled'; return; }
        if (paused) { task.state = 'paused'; return; }
        const item = task.items[task.index];
        try {
          if (item.kind === 'batch') await api.deleteBatch(item.batch.name, item.batch.folderId);
          else if (item.kind === 'folder') await api.deleteFolder(item.id, 'empty');
          else if (item.kind === 'file') await removeFileRow(item.row);
        } catch (err) {
          if (err.status === 404) {
            // 已被别人删掉，视为完成
          } else if (err.status === 409 && item.kind === 'batch') {
            // 快照之后被移走：不误删，继续删剩下的
          } else {
            throw err;
          }
        }
        task.index++;
      }
      task.state = 'done';
      toast('删除完成');
      await refreshLibrary();
      refreshPending();
    } catch (err) {
      task.state = 'failed';
      task.error = err.message || '删除失败';
      toast(task.error);
    }
  };
  task.pause = () => { if (task.state !== 'running') return; paused = true; task.state = 'paused'; };
  task.resume = () => {
    if (task.state === 'done' || task.state === 'canceled') return;
    paused = false;
    task.state = 'running';
    run();
  };
  task.cancel = () => { canceled = true; paused = false; task.state = 'canceled'; };
  task.remove = () => { tasks.value = tasks.value.filter((t) => t !== task); };
  tasks.value.unshift(task);
  run();
}

function startFolderDelete(folder) {
  const { folders, batches } = collectFolderTree(folder.id);
  const items = [
    ...batches.map((batch) => ({ kind: 'batch', batch })),
    ...folders.map((id) => ({ kind: 'folder', id })),
  ];
  startDeleteTask(`删除「${folder.name}」`, items);
}

function openDeleteFolder(folder) {
  openConfirm(
    'delete-folder',
    '删除文件夹？',
    `“${folder.name}”及其中 ${folder.count || 0} 个文件、${fmtSize(folder.size || 0)} 将被永久删除。`,
    { folder },
  );
}

function openDeleteFile(row) {
  openConfirm('delete-file', '删除文件？', `“${row.name}”将被永久删除。`, { row });
}

function openDeleteSelected() {
  if (!selectedItems.value.length) return;
  openConfirm('delete-selected', '删除选中的内容？', `将永久删除选中的 ${selectedItems.value.length} 项，不能撤销。`);
}

// 一键清空：确认词由服务端下发（/api/library 的 wipeConfirm），弹层在 components/WipeDialog.vue
const wipeOpen = ref(false);
const settingsOpen = ref(false);
// 这段解释两处共用（顶部配置条 + 手机档设置底表）：改一处就够
const ttlHint = computed(() => `当前：新上传的文件会在「${ttlLabel(settingsTtl.value)}」后自动删除，到期永久删除；文件夹不自动删除。已上传文件按各自上传时的设置，设置对所有使用者生效。`);
function onSettingsChange(hours) {
  settingsTtl.value = hours;
  onTtlChange();
}
const wipeConfirm = computed(() => data.value.wipeConfirm || '清空全部文件');
const wipeStats = computed(() => ({
  files: data.value.folders.reduce((s, f) => s + (f.count || 0), 0),
  bytes: data.value.folders.reduce((s, f) => s + (f.size || 0), 0),
}));
async function onWiped(receipt) {
  tasks.value = []; // 任务列表里每一项都指向刚被删掉的批次，留着只会显示一堆失败
  // 回执丢了但服务器已清空（连接中断 / 服务重启）：只报确认到的事实，不编批次数
  if (receipt.recovered) toast(`连接中断，但服务器已确认清空；历史累计下载保留（${receipt.kept.downloadTotal} 次）`);
  else toast(`已清空：${receipt.removed.batches} 个批次 · ${fmtSize(receipt.removed.bytes)}；历史累计下载 ${receipt.kept.downloadTotal} 次`);
  await refreshLibrary();
}

function selectedDeleteItems() {
  const items = [];
  const seenBatches = new Set();
  const seenFolders = new Set();
  const folderIds = [];
  for (const item of selectedItems.value) {
    if (item.type !== 'folder') continue;
    const tree = collectFolderTree(item.folder.id);
    for (const batch of tree.batches) {
      if (seenBatches.has(batch.name)) continue;
      seenBatches.add(batch.name);
      items.push({ kind: 'batch', batch });
    }
    for (const id of tree.folders) if (!seenFolders.has(id)) { seenFolders.add(id); folderIds.push(id); }
  }
  for (const item of selectedItems.value) {
    if (item.type === 'file') items.push({ kind: 'file', row: item.file });
  }
  for (const id of folderIds) items.push({ kind: 'folder', id });
  return items;
}

// 弹层里回车 = 按那颗主键（规则见 lib/dialog-enter.js）
const onDialogEnter = enterSubmits(submitDialog);

// 打开弹层时把焦点放在"该敲回车的地方"：有输入框放框里，纯确认框放主键上。
// 库默认停在第一颗可聚焦元素 =「取消」，那样回车就成了取消，与用户预期相反。
watch(() => dialog.open, async (v) => {
  if (!v) return;
  await nextTick();
  const box = document.querySelector('.dialog');
  if (!box) return;
  const target = box.querySelector('input, select') || box.querySelector('.dialog-primary');
  target?.focus();
});

async function submitDialog() {
  if (dialog.busy) return;
  dialog.busy = true;
  dialog.error = '';
  try {
    const value = String(dialog.value || '').trim();
    if (dialog.kind === 'new-folder') {
      if (!value) throw new Error('请输入文件夹名');
      if (Array.from(value).length > FOLDER_NAME_MAX) throw new Error(`文件夹名最多 ${FOLDER_NAME_MAX} 个字`);
      await api.createFolder(value, dialog.target?.parentId ?? null);
      toast('已新建文件夹');
    } else if (dialog.kind === 'rename-folder') {
      if (!value) throw new Error('请输入文件夹名');
      if (Array.from(value).length > FOLDER_NAME_MAX) throw new Error(`文件夹名最多 ${FOLDER_NAME_MAX} 个字`);
      await api.patchFolder(dialog.target.folder.id, { name: value });
      toast('已重命名（分享链接保持不变）');
    } else if (dialog.kind === 'rename-file') {
      if (!value) throw new Error('请输入文件名');
      if (/[\\/]/.test(value)) throw new Error('文件名不能含路径分隔符');
      await renameFileRow(dialog.target.row, value);
      toast('已重命名');
    } else if (dialog.kind === 'move-folder') {
      await api.patchFolder(dialog.target.folder.id, { parentId: value || null });
      toast('已移动');
    } else if (dialog.kind === 'move-batch') {
      await api.moveBatch(dialog.target.row.batch, value || null);
      toast('已移动这批上传');
    } else if (dialog.kind === 'delete-folder') {
      startFolderDelete(dialog.target.folder);
      toast('已开始删除，进度在任务中心');
    } else if (dialog.kind === 'delete-file') {
      await removeFileRow(dialog.target.row);
      toast('已删除文件');
    } else if (dialog.kind === 'delete-selected') {
      const items = selectedDeleteItems();
      if (!items.length) throw new Error('没有可删除的内容');
      startDeleteTask(`删除选中的 ${items.filter((x) => x.kind === 'folder').length || selectedItems.value.length} 项`, items);
      toast('已开始删除，进度在任务中心');
    }
    dialog.open = false;
    selected.value = [];
    selectMode.value = false;
    await refreshLibrary();
  } catch (err) {
    dialog.error = err.message || '操作失败';
  } finally {
    dialog.busy = false;
  }
}

async function resumeUpload(item) {
  resumePending.value = item;
  pickTarget = item.folderId ?? null;
  fileInput.value?.click();
}

async function cancelPending(item) {
  try {
    await api.cancelUpload(item.uploadId);
    toast('已清理未完成上传');
    refreshPending();
  } catch (err) {
    toast(err.message || '清理失败');
  }
}

function folderUrl(id) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (id) url.searchParams.set('f', id);
  return url;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* HTTP 非安全上下文会拒绝 Clipboard API */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return true;
  } catch { /* 继续走 prompt */ }
  window.prompt('复制链接（Ctrl+C）', text);
  return false;
}

async function copyFolderLink(id) {
  const url = folderUrl(id);
  const ok = await copyText(url.href);
  toast(ok ? '文件夹链接已复制（改名后链接不变）' : '已打开复制框，请手动复制链接');
}

async function copyFileLink(rows) {
  if (!rows.length) return;
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (rows[0].folderId) url.searchParams.set('f', rows[0].folderId);
  for (const row of rows) url.searchParams.append('file', `${row.batch}/${row.enc}`);
  const ok = await copyText(url.href);
  toast(ok
    ? (rows.length > 1 ? `已复制 ${rows.length} 个文件的分享链接` : '文件分享链接已复制')
    : '已打开复制框，请手动复制链接');
}

function copySelectedShare() {
  const rows = selectedItems.value.filter((x) => x.type === 'file').map((x) => x.file);
  if (!rows.length) { toast('先选择文件；文件夹请用行尾菜单的「复制文件夹链接」'); return; }
  copyFileLink(rows);
}

const legacyNoticeDismissed = ref(false);
const legacyUnfiledCount = computed(() => data.value.batches.filter((b) => b.legacy && !b.folderId).length);
function dismissLegacyNotice() {
  legacyNoticeDismissed.value = true;
  try { localStorage.setItem('fb-legacy-notice', '1'); } catch { /* 隐私模式 */ }
}

const libraryNotReady = computed(() => data.value.libraryReady === false);
const httpsUrl = computed(() => {
  if (!data.value.httpsPort || location.protocol !== 'http:') return '';
  if (window.FBCrypto && window.FBCrypto.native) return '';
  return `https://${location.hostname}:${data.value.httpsPort}${location.pathname}${location.search}`;
});

const moveOptions = computed(() => {
  const options = [];
  options.push({ value: '', label: rootLabel });
  const excluded = new Set();
  if (dialog.kind === 'move-folder' && dialog.target?.folder) {
    excluded.add(dialog.target.folder.id);
    for (let changed = true; changed;) {
      changed = false;
      for (const f of data.value.folders) {
        if (f.parentId && excluded.has(f.parentId) && !excluded.has(f.id)) {
          excluded.add(f.id);
          changed = true;
        }
      }
    }
  }
  for (const f of treeRows.value) {
    if (excluded.has(f.id)) continue;
    options.push({ value: f.id, label: `${'　'.repeat(Math.min(f.depth, 8))}${f.name}` });
  }
  return options;
});

const treeRows = computed(() => {
  const children = new Map();
  for (const f of data.value.folders) {
    const pid = f.parentId || '__root__';
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(f);
  }
  for (const list of children.values()) list.sort((a, b) => collator.compare(a.name, b.name));
  const out = [];
  const stack = (children.get('__root__') || []).slice().reverse().map((f) => ({ folder: f, depth: 0 }));
  while (stack.length) {
    const { folder, depth } = stack.pop();
    out.push({ ...folder, depth });
    const kids = children.get(folder.id) || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ folder: kids[i], depth: depth + 1 });
  }
  return out;
});

const dialogLimit = computed(() => (dialog.kind === 'rename-file' ? 120 : FOLDER_NAME_MAX));

async function onTtlChange() {
  const next = Number(settingsTtl.value);
  settingsSaving.value = true;
  try {
    const res = await api.saveSettings({ defaultTtlHours: next });
    data.value = { ...data.value, settings: res.settings };
    settingsTtl.value = res.settings.defaultTtlHours;
    toast(`之后的每批上传都会在「${ttlLabel(res.settings.defaultTtlHours)}」后自动删除`);
  } catch (err) {
    settingsTtl.value = data.value.settings?.defaultTtlHours ?? 1;
    toast(err.message || '自动删除设置保存失败：稍后再试一次');
  } finally {
    settingsSaving.value = false;
  }
}

// 最外层「全部文件」那一栏的读数：它现在同时装根目录和没有目录的批次
const rootSummary = computed(() => {
  const folders = childrenOf(null);
  const files = filesForFolder(null);
  const stamps = [
    ...folders.map((f) => (Number.isFinite(f.lastUpdatedAt) ? f.lastUpdatedAt : 0)),
    ...files.map((r) => (Number.isFinite(r.uploadedAt) ? r.uploadedAt : 0)),
  ];
  const updated = Math.max(0, ...stamps);
  return {
    folders: folders.length,
    files: files.length,
    size: folders.reduce((n, f) => n + (f.size || 0), 0) + files.reduce((n, r) => n + (r.size || 0), 0),
    lastUpdatedAt: updated || null,
  };
});
const taskBadge = computed(() => tasks.value.filter((t) => !['done', 'canceled'].includes(t.state)).length
  + pendingUploads.value.length);
const showTaskPanel = computed(() => tasks.value.length > 0 || pendingUploads.value.length > 0);

async function init() {
  loading.value = true;
  try {
    const res = await api.library();
    data.value = res;
    settingsTtl.value = res.settings?.defaultTtlHours ?? 1;
    const params = new URLSearchParams(location.search);
    if (params.get('f')) currentId.value = params.get('f');
    else if (params.get('folder')) {
      const b = res.batches.find((x) => x.name === params.get('folder'));
      currentId.value = b ? (b.folderId || null) : null;
    }
    shareFileRefs.value = params.getAll('file');
    if (currentId.value && !res.folders.some((f) => f.id === currentId.value)) {
      currentId.value = null;
    }
    try { legacyNoticeDismissed.value = localStorage.getItem('fb-legacy-notice') === '1'; } catch { /* 隐私模式 */ }
    await loadFiles();
    if (shareFileRefs.value.length) {
      const hit = allFileRows.value.find((r) => shareFileRefs.value.includes(`${r.batch}/${r.enc}`));
      if (hit) currentId.value = hit.folderId || null;
    }
    applyShare();
    await refreshPending();
    await nextTick();
    scrollColumnsToEnd();
    setTimeout(scrollColumnsToEnd, 120);
    watchColumnsDom();
  } catch (err) {
    error.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
  pollTimer = setInterval(() => { if (!document.hidden) refreshLibrary({ silent: true }); }, 10_000);
}

// 键盘：Escape 分三层收（菜单 → 多选 → 搜索），Ctrl/Cmd+A 全选，Delete 删选中，/ 聚焦搜索。
// 输入框里、中文输入法组合中、弹层开着时一律不抢，避免把编辑和浏览器快捷键做坏。
function inTextField(el) {
  return Boolean(el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'));
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    if (menu.value) { closeMenu(); return; }
    if (sheet.open) return;              // 抽屉自己会关
    if (dialog.open) return;             // 弹层自己会关
    if (isSelecting.value) { exitSelect(); event.preventDefault(); return; }
    if (searching.value) { query.value = ''; return; }
    return;
  }
  if (event.isComposing || event.keyCode === 229) return;
  if (inTextField(event.target)) return;
  if (dialog.open || sheet.open) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    toggleAll();
    return;
  }
  if (event.key === '/' ) {
    event.preventDefault();
    document.querySelector('.search input')?.focus();
    return;
  }
  if ((event.key === 'Delete' || ((event.ctrlKey || event.metaKey) && event.key === 'Backspace')) && selected.value.length) {
    event.preventDefault();
    openDeleteSelected();
  }
}

function onResize() {
  // 视口变化后列宽要等布局落定才准；一帧不够，连续两帧再滚到当前列
  requestAnimationFrame(() => requestAnimationFrame(scrollColumnsToEnd));
  setTimeout(scrollColumnsToEnd, 120);
}

watch(searchTerm, (q) => {
  if (q && manifestState.value.size < data.value.batches.length) loadFiles();
});

// 手机上任务中心是抽屉：离开窄屏时把抽屉状态收掉，别留一个打不开的遮罩
watch(isMobile, (mobile) => { if (!mobile) taskDrawer.value = false; });

let stopKeyboardInset = null;
let rowPointerDown = null;

onMounted(() => {
  stopKeyboardInset = useKeyboardInset();
  init();
  window.addEventListener('popstate', onPop);
  window.addEventListener('click', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
  document.addEventListener('paste', onPaste);
  // 长按与"按住期间不许重绑 dnd"共用这一个捕获点：只在桌面分栏的行上生效
  rowPointerDown = (e) => { pointerOnRow = Boolean(e.target?.closest?.('.col-row')); };
  document.addEventListener('pointerdown', rowPointerDown, true);
  document.addEventListener('pointerup', () => { pointerOnRow = false; scheduleBind(); }, true);
  document.addEventListener('pointercancel', () => { pointerOnRow = false; }, true);
});
onBeforeUnmount(() => {
  stopKeyboardInset?.();
  clearInterval(pollTimer);
  clearTimeout(toastTimer);
  clearTimeout(pulseTimer);
  clearTimeout(dndTimer);
  if (dndObserver) dndObserver.disconnect();
  window.removeEventListener('popstate', onPop);
  window.removeEventListener('click', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('paste', onPaste);
  if (rowPointerDown) document.removeEventListener('pointerdown', rowPointerDown, true);
});
</script>

<template>
  <div class="app">
    <TopBar
      :breadcrumb="breadcrumb"
      :query="query"
      :usage="data.usage"
      :downloads-total="data.downloadsTotal || 0"
      :upload-label="uploadTargetLabel"
      :task-badge="taskBadge"
      :show-tasks="showTaskPanel"
      :is-mobile="isMobile"
      @navigate="navigate"
      @update:query="query = $event"
      @upload="triggerUpload"
      @open-tasks="taskDrawer = true"
      @open-settings="settingsOpen = true"
    />

    <div class="config-strip">
      <Clock :size="15" class="config-icon" aria-hidden="true" />
      <span class="config-label">所有新上传</span>
      <select
        id="ttl-select"
        v-model.number="settingsTtl"
        class="input ttl-global"
        aria-label="所有新上传的自动删除时长"
        :disabled="settingsSaving || libraryNotReady"
        @change="onTtlChange"
      >
        <option v-for="h in ttlOptions" :key="h" :value="h">{{ ttlLabel(h) }}后自动删除</option>
      </select>
      <span class="config-hint" v-if="!libraryNotReady">{{ ttlHint }}</span>
      <span class="config-hint" v-else>目录索引暂不可用，自动删除设置暂时不能修改。</span>
      <button class="linkbtn danger-text wipe-open" title="清空服务器上的所有文件（保留文件夹、全局设置与历史下载次数）" aria-label="清空所有文件" @click="wipeOpen = true">
        <Trash2 :size="14" aria-hidden="true" /><span>清空所有文件</span>
      </button>
    </div>

    <div class="layout">
      <main class="main">
        <div v-if="libraryNotReady" class="banner info">
          <Info :size="15" aria-hidden="true" />
          目录索引暂不可用，当前所有文件都在最外层展示；上传与下载仍可用。要恢复目录树请让管理员看服务日志里的「目录索引」那条。
        </div>
        <div v-if="httpsUrl" class="banner info">
          <Info :size="15" aria-hidden="true" />
          当前是 HTTP 兼容模式：加解密慢一个数量级，而且浏览器不给本地存储 —— 大文件下载只能整份经内存（超过上限就下不了），也不支持断点续传。改用 <a :href="httpsUrl">HTTPS 地址</a> 这些才有（首次需信任自签证书）。
        </div>
        <div v-if="currentId === null && legacyUnfiledCount && !legacyNoticeDismissed" class="banner info">
          <Info :size="15" aria-hidden="true" />
          旧上传就排在「全部文件」里（没有归属目录），原链接和下载次数不变。
          <button class="linkbtn" @click="dismissLegacyNotice">知道了</button>
        </div>
        <div v-if="error" class="banner danger" role="alert">
          {{ error }} <button class="linkbtn" @click="refreshLibrary()">重试</button>
        </div>
        <div v-if="manifestError" class="banner danger" role="alert">
          部分文件名读取失败：{{ manifestError }} <button class="linkbtn" @click="loadFiles()">重试</button>
        </div>
        <div v-if="shareBanner || shareMissing" class="banner share">
          <Link2 :size="15" aria-hidden="true" />
          <template v-if="shareRows.length">
            分享链接里有 {{ shareRows.length }} 个文件，所在文件夹已高亮：
            <button v-for="row in shareRows.slice(0, 6)" :key="row.key" class="linkbtn share-file" @click="focusShared(row)">{{ row.name }}</button>
            <span v-if="shareRows.length > 6" class="muted">等 {{ shareRows.length }} 个</span>
          </template>
          <template v-else>分享链接里的文件已经不存在。</template>
          <button class="linkbtn" @click="dismissShare">关闭</button>
        </div>

        <!-- 读屏播报位：只报"文件名读到第几份"。整块列表每 10 秒轮询、相对时间每 15 秒重算，
             把 aria-live 挂在列表上会让读屏周期性地把整栏重念一遍。 -->
        <span class="sr-only" role="status">{{ filesLoading ? `正在读取文件名 ${manifestProgress.done}/${manifestProgress.total}` : '' }}</span>

        <div class="tool-row">
          <span class="tool-status">上传到 <b>{{ uploadTargetLabel }}</b> · {{ uploadTtlText }}<span v-if="filesLoading"> · 正在读取文件名 {{ manifestProgress.done }}/{{ manifestProgress.total }}</span></span>
          <span class="tool-count" :class="{ on: selected.length }">{{ selected.length ? `已选 ${selected.length} 项` : '未选择' }}</span>
          <div class="tool-actions">
            <button class="linkbtn tool-btn" :aria-pressed="String(allSelectedNow)" title="全选当前可见" aria-label="全选当前可见" @click="toggleAll">
              <ListChecks :size="16" aria-hidden="true" /><span class="tool-label">全选</span>
            </button>
            <button class="linkbtn tool-btn" :disabled="!selectedFileCount" title="复制分享链接" aria-label="复制分享链接" @click="copySelectedShare">
              <Link2 :size="16" aria-hidden="true" /><span class="tool-label">复制分享链接</span>
            </button>
            <button class="linkbtn tool-btn" :disabled="!selected.length" title="打包下载" aria-label="打包下载" @click="downloadSelectedZip">
              <Package :size="16" aria-hidden="true" /><span class="tool-label">打包下载</span>
            </button>
            <button class="linkbtn tool-btn danger-text" :disabled="!selected.length" title="删除" aria-label="删除" @click="openDeleteSelected">
              <Trash2 :size="16" aria-hidden="true" /><span class="tool-label">删除</span>
            </button>
            <button class="linkbtn tool-btn" :disabled="!selected.length" title="取消选择" aria-label="取消选择" @click="exitSelect">
              <X :size="16" aria-hidden="true" /><span class="tool-label">取消</span>
            </button>
          </div>
        </div>

        <SearchPanel
          v-if="searching"
          :term="searchTerm"
          :folders="searchFolders"
          :files="searchFileResults"
          :loading="filesLoading"
          :progress="manifestProgress"
          :now="now"
          @open-folder="navigate"
          @open-file="navigateToFile"
        />

        <section v-else class="browser" :class="{ loading }">
          <div v-if="loading" class="empty">
            <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>
          </div>
          <ColumnBrowser
            v-else-if="!isMobile"
            ref="desktopBrowser"
            :columns="columns"
            :now="now"
            :root-label="rootLabel"
            :root-summary="rootSummary"
            :path-ids="pathIds"
            :selected-keys="selectedSet"
            :column-keys="columnKeys"
            :shared-folder-ids="sharedFolderIds"
            :shared-file-keys="sharedFileKeys"
            :pulse-keys="pulseKeys"
            :expiring-keys="expiringKeys"
            :dnd-over-id="dndOverId || ''"
            :dnd-over-col="dndOverCol || ''"
            :drag-target-key="dragTargetKey"
            @navigate="navigate"
            @select="toggleSelect"
            @toggle-column="toggleColumn"
            @more-folder="(e, f) => openFolderMenu(e, f)"
            @more-file="(e, r) => openFileMenu(e, r)"
            @more-column="(e, c) => openColumnMenu(e, c)"
            @column-contextmenu="(e, c) => openColumnMenu(e, c)"
            @folder-contextmenu="(e, f) => openFolderMenu(e, f)"
            @file-contextmenu="(e, r) => openFileMenu(e, r)"
            @download-file="addDownload"
            @dragover="onColumnDragOver"
            @dragleave="onColumnDragLeave"
            @drop="onColumnDrop"
            @new-folder="openNewFolder"
            @zip-folder="downloadFolderZip"
          />
          <MobileBrowser
            v-else
            :col="currentCol"
            :path="breadcrumb"
            :now="now"
            :root-label="rootLabel"
            :selected-keys="selectedSet"
            :shared-folder-ids="sharedFolderIds"
            :shared-file-keys="sharedFileKeys"
            :pulse-keys="pulseKeys"
            :expiring-keys="expiringKeys"
            :selecting="isSelecting"
            :all-selected="allSelectedNow"
            @back="goBack"
            @navigate="navigate"
            @select="toggleSelect"
            @longpress="enterSelect"
            @sheet-folder="openFolderSheet"
            @sheet-file="openFileSheet"
            @new-folder="openNewFolder"
            @upload="triggerUpload"
            @zip="downloadFolderZip"
            @toggle-all="allSelectedNow ? exitSelect() : toggleAll()"
          />
        </section>

        <TaskCenter
          v-if="showTaskPanel && !isMobile"
          :tasks="tasks"
          :pending-uploads="pendingUploads"
          :expanded="tasksOpen"
          @toggle="tasksOpen = !tasksOpen"
          @clear-done="clearDone"
          @resume-pending="resumeUpload"
          @cancel-pending="cancelPending"
        />
      </main>
    </div>

    <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked">

    <div v-if="toastText" class="toast" role="status">{{ toastText }}</div>

    <ContextMenu v-if="menu" :pos="{ x: menu.x, y: menu.y }" :items="menu.items" @run="runMenu" />

    <ActionSheet
      v-model:open="sheet.open"
      :title="sheet.title"
      :subtitle="sheet.subtitle"
      :items="sheet.items"
      @run="runMenu"
    />

    <AppDialog
      v-model:open="dialog.open"
      :dialog="dialog"
      :move-options="moveOptions"
      :limit="dialogLimit"
      :name-max="FOLDER_NAME_MAX"
      @update:value="dialog.value = $event"
      @submit="submitDialog"
      @enter="onDialogEnter"
    />

    <div v-if="isMobile && isSelecting" class="action-bar">
      <span class="action-count" :class="{ on: selected.length }">
        {{ selected.length ? `已选 ${selected.length} 项` : '长按文件进入多选' }}
      </span>
      <div class="action-items">
        <button class="linkbtn tool-btn" :aria-pressed="String(allSelectedNow)" title="全选当前可见" aria-label="全选当前可见" @click="toggleAll">
          <ListChecks :size="18" aria-hidden="true" />
        </button>
        <button class="linkbtn tool-btn" :disabled="!selectedFileCount" title="复制分享链接" aria-label="复制分享链接" @click="copySelectedShare">
          <Link2 :size="18" aria-hidden="true" />
        </button>
        <button class="linkbtn tool-btn" :disabled="!selected.length" title="打包下载" aria-label="打包下载" @click="downloadSelectedZip">
          <Package :size="18" aria-hidden="true" />
        </button>
        <button class="linkbtn tool-btn danger-text" :disabled="!selected.length" title="删除" aria-label="删除" @click="openDeleteSelected">
          <Trash2 :size="18" aria-hidden="true" />
        </button>
        <button class="linkbtn tool-btn" title="取消选择" aria-label="取消选择" @click="exitSelect">
          <X :size="18" aria-hidden="true" />
        </button>
      </div>
    </div>

    <SettingsSheet
      v-model:open="settingsOpen"
      :ttl="settingsTtl"
      :options="data.ttlOptions || []"
      :hint="ttlHint"
      :used="data.usage.used"
      :limit-gb="data.usage.limitGB"
      :downloads-total="data.downloadsTotal || 0"
      :not-ready="libraryNotReady"
      :saving="settingsSaving"
      @change="onSettingsChange"
      @wipe="settingsOpen = false; wipeOpen = true"
    />

    <WipeDialog
      v-model:open="wipeOpen"
      :confirm-word="wipeConfirm"
      :files="wipeStats.files"
      :bytes="wipeStats.bytes"
      @done="onWiped"
    />

    <TaskDrawer v-if="isMobile" v-model:open="taskDrawer">
      <TaskCenter
        :tasks="tasks"
        :pending-uploads="pendingUploads"
        :expanded="true"
        :show-header="false"
        @clear-done="clearDone"
        @resume-pending="resumeUpload"
        @cancel-pending="cancelPending"
      />
    </TaskDrawer>
  </div>
</template>
