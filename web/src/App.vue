<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useNow } from '@vueuse/core';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import {
  ChevronRight, Clock, Download, File, Folder, FolderPlus, HardDrive, Inbox,
  Link2, ListChecks, Package, Pause, Play, RotateCcw, Search, Trash2, Upload,
} from '@lucide/vue';
import { api } from './lib/api.js';
import { encodeManifest, fetchManifest, invalidateManifest, manifestMap } from './lib/manifest.js';
import { UploadTask, relPath, sortSelected } from './lib/upload.js';
import { clearDownload, downloadFile, saveBlob } from './lib/download.js';
import { createZipJob } from './lib/zip.js';
import {
  collator, dlText, expiryClass, fmtAgo, fmtExpiry, fmtFullTime, fmtSize, fmtUploaded, isHot, ttlLabel,
} from './lib/format.js';

const FOLDER_NAME_MAX = 20;
const TTL_FALLBACK = [1, 4, 8, 48, 72, 120, 240, 2160];
const now = useNow({ interval: 15_000 });

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
const allFileRows = ref([]);
const manifestState = ref(new Map());
const tasks = ref([]);
const pendingUploads = ref([]);
const resumePending = ref(null);
const settingsTtl = ref(1);
const settingsSaving = ref(false);
const fileInput = ref(null);
const columnsEl = ref(null);
const dragTargetKey = ref('');
const toastText = ref('');
const menu = ref(null);
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
  confirmText: '确定', target: null, items: [],
});

const rootLabel = '全部文件';
const folderMap = computed(() => new Map(data.value.folders.map((f) => [f.id, f])));
const ttlOptions = computed(() => (data.value.ttlOptions?.length ? data.value.ttlOptions : TTL_FALLBACK));

const currentFolder = computed(() => {
  if (!currentId.value) return null;
  return folderMap.value.get(currentId.value) || null;
});

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

const breadcrumb = computed(() => {
  const out = [{ id: null, name: rootLabel }];
  if (!currentId.value) return out;
  return out.concat(pathTo(currentId.value).map((f) => ({ id: f.id, name: f.name })));
});

const uploadTargetId = computed(() => (
  currentId.value && currentId.value !== '__unfiled__' ? currentId.value : null
));
const uploadTargetLabel = computed(() => (
  uploadTargetId.value ? (folderMap.value.get(uploadTargetId.value)?.name || '目录') : '未分档'
));
const uploadTtlText = computed(() => (
  data.value.libraryReady === false ? '自动删除设置暂不可用' : `${ttlLabel(settingsTtl.value)}后自动删除`
));

function sortFolders(list) {
  return list.slice().sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

function childrenOf(id) {
  if (id === '__unfiled__') return [];
  return sortFolders(data.value.folders.filter((f) => (
    id === null ? f.parentId === null : f.parentId === id
  )));
}

function filesForFolder(id) {
  const rows = allFileRows.value.filter((r) => (
    id === '__unfiled__' ? !r.folderId : r.folderId === id
  ));
  return rows.slice().sort((a, b) => {
    const at = Number.isFinite(a.uploadedAt) ? a.uploadedAt : 0;
    const bt = Number.isFinite(b.uploadedAt) ? b.uploadedAt : 0;
    if (at !== bt) return bt - at;
    return collator.compare(a.name, b.name);
  });
}

const columnIds = computed(() => [null, ...pathTo(currentId.value).map((f) => f.id)]);
const columns = computed(() => columnIds.value.map((id) => {
  const folder = id ? folderMap.value.get(id) || null : null;
  return {
    key: id || 'root',
    id,
    folder,
    folders: childrenOf(id),
    files: id ? filesForFolder(id) : [],
  };
}));
// 当前路径上的每一级（含当前这一级自己）：所在栏的那一行要亮成选中态
const pathIds = computed(() => new Set(columnIds.value.slice(1)));

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
    .map((row) => ({ row, path: folderPathText(row.folderId || '__unfiled__') }));
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

const visibleKeys = computed(() => {
  if (searching.value) {
    return [
      ...searchFolders.value.map((x) => `folder:${x.folder.id}`),
      ...searchFileResults.value.map((x) => x.row.key),
    ];
  }
  return columns.value.flatMap((col) => columnKeys(col));
});

const shareRows = computed(() => allFileRows.value.filter((r) => sharedFileKeys.value.has(r.key)));

function columnKeys(col) {
  return [
    ...col.folders.map((f) => `folder:${f.id}`),
    ...col.files.map((r) => r.key),
  ];
}

function colLabel(col) {
  if (!col.id) return rootLabel;
  return col.folder?.name || '目录';
}

function colMeta(col) {
  if (!col.id) {
    const folderCount = data.value.folders.filter((f) => !f.system).length;
    return `${folderCount} 个文件夹 · ${fmtSize(data.value.usage.used)}`;
  }
  const folder = col.folder;
  if (!folder) return '';
  const updated = Number.isFinite(folder.lastUpdatedAt) ? `最后更新 ${fmtAgo(folder.lastUpdatedAt, now.value)}` : '还没有文件';
  return `${folder.count || 0} 个文件 · ${updated}`;
}

function folderRowMeta(folder) {
  const updated = Number.isFinite(folder.lastUpdatedAt) ? `最后更新 ${fmtAgo(folder.lastUpdatedAt, now.value)}` : '还没有文件';
  return `${folder.count || 0} 个文件 · ${updated}`;
}

function isSelected(key) { return selected.value.includes(key); }

function toggleSelect(key) {
  if (isSelected(key)) selected.value = selected.value.filter((k) => k !== key);
  else selected.value = [...selected.value, key];
}

function allSelectedIn(keys) {
  return keys.length > 0 && keys.every((k) => isSelected(k));
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
  if (keys.every((k) => isSelected(k))) selected.value = selected.value.filter((k) => !keys.includes(k));
  else selected.value = [...new Set([...selected.value, ...keys])];
}

function toast(message) {
  toastText.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText.value = ''; }, 3200);
}

function stateText(task) {
  return {
    queued: '排队', running: '进行中', finishing: '正在合并', paused: '已暂停',
    failed: '失败', done: '已完成', canceled: '已取消',
  }[task.state] || task.state;
}

function taskPct(task) {
  if (task.state === 'done') return 100;
  if (task.kind === 'upload') return task.total ? Math.round((task.done / task.total) * 100) : 0;
  if (task.kind === 'folder-delete') return task.items?.length ? Math.round((task.index / task.items.length) * 100) : 0;
  return task.total ? Math.round((task.received / task.total) * 100) : 0;
}

function taskMeta(task) {
  if (task.kind === 'upload') return `${task.done || 0}/${task.total || 0} 块 · ${fmtSize(task.doneBytes || 0)}`;
  if (task.kind === 'folder-delete') return `已完成 ${task.index || 0}/${task.items?.length || 0} 项`;
  if (task.kind === 'zip') return `${fmtSize(task.received || 0)} / ${fmtSize(task.total || 0)} · ${task.files || 0} 个文件`;
  return `${fmtSize(task.received || 0)} / ${fmtSize(task.total || 0)}`;
}

function updateUrl() {
  const url = new URL(location.href);
  url.search = '';
  if (currentId.value) url.searchParams.set('f', currentId.value);
  history.pushState({ f: currentId.value }, '', url);
}

function replaceUrl() {
  const url = new URL(location.href);
  url.search = '';
  if (currentId.value) url.searchParams.set('f', currentId.value);
  history.replaceState({ f: currentId.value }, '', url);
}

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
        manifestError.value = err.message || '清单加载失败';
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
    data.value = res;
    if (!settingsSaving.value) settingsTtl.value = res.settings?.defaultTtlHours ?? 1;
    if (currentId.value && currentId.value !== '__unfiled__' && !res.folders.some((f) => f.id === currentId.value)) {
      currentId.value = null;
      replaceUrl();
    }
    await loadFiles({ force });
    if (!silent) error.value = '';
    applyShare();
    selected.value = selected.value.filter((key) => itemByKey.value.has(key));
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

async function navigateToFile(row) {
  await navigate(row.folderId || '__unfiled__');
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
      if (hit) currentId.value = hit.folderId || '__unfiled__';
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
  sharedFolderIds.value = new Set(rows.map((r) => r.folderId || '__unfiled__'));
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

function isExpiring(row) {
  return Number.isFinite(row.expiresAt) && row.expiresAt - now.value < 10 * 60_000;
}

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
  const target = folderId && folderId !== '__unfiled__' ? folderId : null;
  const task = reactive({
    id: `task-${++taskSeq}`,
    kind: 'upload',
    title: files.length === 1 ? relPath(files[0]) : `${relPath(files[0])} 等 ${files.length} 个文件`,
    state: 'queued', done: 0, total: 0, doneBytes: 0, error: '', result: null,
    targetLabel: target ? (folderMap.value.get(target)?.name || '目录') : '未分档',
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
          toast('上传完成，但目录索引不可用：文件在未分档，未设置自动删除');
          navigate('__unfiled__');
        } else if (res.folderMissing) {
          toast('上传完成，但目标目录已不存在：文件在未分档');
          navigate(resultFolder || '__unfiled__');
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
  task.openResult = () => navigate(task.result?.folderId || '__unfiled__');
  tasks.value.unshift(task);
  up.run();
}

function onColumnDragOver(event, col) {
  event.preventDefault();
  event.stopPropagation();
  dragTargetKey.value = col.key;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onColumnDragLeave(event, col) {
  if (dragTargetKey.value === col.key) dragTargetKey.value = '';
}

function onColumnDrop(event, col) {
  event.preventDefault();
  event.stopPropagation();
  dragTargetKey.value = '';
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  const folderId = !col.id || col.id === '__unfiled__' ? null : col.id;
  addUpload(files, { folderId });
}

function menuItemsHeight(items) {
  return items.reduce((n, item) => n + (item.sep ? 9 : 32), 0);
}

function showMenu(x, y, items) {
  if (!items?.length) return;
  const height = Math.min(menuItemsHeight(items), 380);
  menu.value = {
    x: Math.max(8, Math.min(x, window.innerWidth - 236)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    items,
  };
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

function folderMenuItems(folder) {
  const items = [{ label: '打开', run: () => navigate(folder.id) }];
  if (!folder.system) {
    items.push(
      { label: '重命名', run: () => openRenameFolder(folder) },
      { label: '移动到…', run: () => openMoveFolder(folder) },
      { label: '在此新建子文件夹', run: () => openNewFolder(folder.id) },
    );
  }
  items.push(
    { label: '复制文件夹链接', run: () => copyFolderLink(folder.id) },
    { label: '打包下载', run: () => downloadFolderZip(folder) },
  );
  if (folder.system) {
    items.push({ sep: true }, { label: '系统目录，不能删除', disabled: true });
  } else {
    items.push({ sep: true }, { label: '删除文件夹', danger: true, run: () => openDeleteFolder(folder) });
  }
  return items;
}

function fileMenuItems(row) {
  return [
    { label: '下载', run: () => addDownload(row) },
    { label: '重命名', disabled: !row.hasManifest, run: () => openRenameFile(row) },
    { label: '移动这批上传到…', run: () => openMoveBatch(row) },
    { label: '复制文件分享链接', run: () => copyFileLink([row]) },
    { sep: true },
    { label: '删除文件', danger: true, run: () => openDeleteFile(row) },
  ];
}

function columnMenuItems(col) {
  const items = [];
  if (col.id !== '__unfiled__') {
    items.push({ label: col.id ? '在此新建子文件夹' : '新建文件夹', run: () => openNewFolder(col.id) });
  }
  items.push({
    label: '上传文件到此处',
    run: () => chooseUpload(col.id && col.id !== '__unfiled__' ? col.id : null),
  });
  if (col.folder) {
    items.push(
      { label: '复制文件夹链接', run: () => copyFolderLink(col.folder.id) },
      { label: '打包下载', run: () => downloadFolderZip(col.folder) },
    );
  }
  if (col.id === '__unfiled__') items.push({ sep: true }, { label: '系统目录，不能删除', disabled: true });
  else if (col.folder && !col.folder.system) {
    items.push({ sep: true }, { label: '删除文件夹', danger: true, run: () => openDeleteFolder(col.folder) });
  }
  return items;
}

async function addDownload(row) {
  const task = reactive({
    id: `task-${++taskSeq}`, kind: 'download', title: row.name, state: 'running',
    received: 0, total: row.cipherSize || 0, error: '', row,
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
        { signal: controller.signal, onUpdate: (p) => { task.received = p.received; task.total = p.total || task.total; } },
      );
      task.state = 'done';
      toast('已下载');
      refreshLibrary({ silent: true });
    } catch (err) {
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
    received: 0, total: 0, error: '', files: list.filter((it) => !it.dir).length,
  });
  const job = createZipJob(list, {
    onProgress: (p) => { task.received = p.received; task.total = p.total || task.total; },
  });
  task.total = job.total;
  let controller = null;
  let paused = false;
  let canceled = false;
  const run = async () => {
    task.state = 'running';
    task.error = '';
    paused = false;
    controller = new AbortController();
    try {
      const { blob } = await job.run({ signal: controller.signal });
      if (canceled) { task.state = 'canceled'; return; }
      if (paused) { task.state = 'paused'; return; }
      saveBlob(blob, filename);
      task.received = task.total;
      task.state = 'done';
      toast('打包完成，浏览器已开始保存');
    } catch (err) {
      if (canceled) task.state = 'canceled';
      else if (paused || err.name === 'AbortError') task.state = 'paused';
      else { task.state = 'failed'; task.error = err.message || '打包失败'; toast(task.error); }
    }
  };
  task.pause = () => { if (task.state !== 'running') return; paused = true; controller?.abort(); task.state = 'paused'; };
  task.resume = () => {
    if (task.state === 'done' || task.state === 'canceled') return;
    paused = false;
    task.state = 'running';
    run();
  };
  task.cancel = () => { canceled = true; paused = false; controller?.abort(); task.state = 'canceled'; };
  task.remove = () => { tasks.value = tasks.value.filter((t) => t !== task); };
  tasks.value.unshift(task);
  run();
}

function buildFolderZipItems(root) {
  const items = [];
  const stack = [{ fid: root.id, prefix: root.name }];
  while (stack.length) {
    const { fid, prefix } = stack.pop();
    const children = fid === '__unfiled__' ? [] : childrenOf(fid);
    const files = allFileRows.value.filter((r) => (fid === '__unfiled__' ? !r.folderId : r.folderId === fid));
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
  if (!items.some((it) => !it.dir)) { toast('这个目录还没有文件'); return; }
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
  if (!items.some((it) => !it.dir)) { toast('选中的内容里还没有文件'); return; }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  startZipTask('打包选中内容', items, `文件盒子-${stamp}.zip`);
}

function clearDone() {
  tasks.value = tasks.value.filter((t) => !['done', 'canceled'].includes(t.state));
}

function openPrompt(kind, title, value = '', target = null, message = '') {
  Object.assign(dialog, {
    open: true, kind, mode: 'prompt', title, message, value, error: '',
    busy: false, destructive: false, confirmText: '确定', target, items: [],
  });
}

function openConfirm(kind, title, message, target = null, items = []) {
  Object.assign(dialog, {
    open: true, kind, mode: 'confirm', title, message, value: '', error: '',
    busy: false, destructive: true, confirmText: '删除', target, items,
  });
}

function openMoveFolder(folder) {
  if (folder.system) return;
  Object.assign(dialog, {
    open: true, kind: 'move-folder', mode: 'move', title: '移动到…', message: '',
    value: folder.parentId || '', error: '', busy: false, destructive: false,
    confirmText: '移动', target: { folder }, items: [],
  });
}

function openMoveBatch(row) {
  Object.assign(dialog, {
    open: true, kind: 'move-batch', mode: 'move', title: '移动这批上传到…', message: '',
    value: row.folderId || '__unfiled__', error: '', busy: false, destructive: false,
    confirmText: '移动', target: { row }, items: [],
  });
}

function openNewFolder(parentId = undefined) {
  let pid;
  if (parentId === undefined) {
    pid = currentId.value && currentId.value !== '__unfiled__' ? currentId.value
      : currentId.value === '__unfiled__' ? '__unfiled__' : null;
  } else pid = parentId;
  if (pid === '__unfiled__') { toast('未分档是系统目录，不能新建子目录'); return; }
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
  if (!rec) throw new Error('旧数据没有加密清单，不能重命名');
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
  if (folder.system) return;
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
  if (folder.system) { toast('未分档是系统目录，不能删除'); return; }
  const { folders, batches } = collectFolderTree(folder.id);
  const items = [
    ...batches.map((batch) => ({ kind: 'batch', batch })),
    ...folders.map((id) => ({ kind: 'folder', id })),
  ];
  startDeleteTask(`删除「${folder.name}」`, items);
}

function openDeleteFolder(folder) {
  if (folder.system) { toast('未分档是系统目录，不能删除'); return; }
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
  if (!selectedItems.value.some((x) => x.type !== 'folder' || !x.folder.system)) {
    toast('未分档是系统目录，不能删除');
    return;
  }
  openConfirm('delete-selected', '删除选中的内容？', `将永久删除选中的 ${selectedItems.value.length} 项，不能撤销。`, null, selectedItems.value);
}

function selectedDeleteItems() {
  const items = [];
  const seenBatches = new Set();
  const seenFolders = new Set();
  const folderIds = [];
  for (const item of selectedItems.value) {
    if (item.type !== 'folder' || item.folder.system) continue;
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
  url.searchParams.set('f', rows[0].folderId || '__unfiled__');
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
  if (dialog.kind === 'move-batch') options.push({ value: '__unfiled__', label: '未分档' });
  options.push({ value: '', label: '全部文件（根）' });
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
    if (f.id === '__unfiled__') continue;
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
const dialogCharCount = computed(() => Array.from(String(dialog.value || '')).length);

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
    toast(err.message || '自动删除设置保存失败');
  } finally {
    settingsSaving.value = false;
  }
}

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
      currentId.value = b ? (b.folderId || '__unfiled__') : null;
    }
    shareFileRefs.value = params.getAll('file');
    if (currentId.value && currentId.value !== '__unfiled__' && !res.folders.some((f) => f.id === currentId.value)) {
      currentId.value = null;
    }
    try { legacyNoticeDismissed.value = localStorage.getItem('fb-legacy-notice') === '1'; } catch { /* 隐私模式 */ }
    await loadFiles();
    if (shareFileRefs.value.length) {
      const hit = allFileRows.value.find((r) => shareFileRefs.value.includes(`${r.batch}/${r.enc}`));
      if (hit) currentId.value = hit.folderId || '__unfiled__';
    }
    applyShare();
    await refreshPending();
    await nextTick();
    scrollColumnsToEnd();
    setTimeout(scrollColumnsToEnd, 120);
  } catch (err) {
    error.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
  pollTimer = setInterval(() => { if (!document.hidden) refreshLibrary({ silent: true }); }, 10_000);
}

function onKeydown(event) {
  if (event.key === 'Escape') closeMenu();
}

function onResize() {
  // 视口变化后列宽要等布局落定才准；一帧不够，连续两帧再滚到当前列
  requestAnimationFrame(() => requestAnimationFrame(scrollColumnsToEnd));
  setTimeout(scrollColumnsToEnd, 120);
}

watch(searchTerm, (q) => {
  if (q && manifestState.value.size < data.value.batches.length) loadFiles();
});

onMounted(() => {
  init();
  window.addEventListener('popstate', onPop);
  window.addEventListener('click', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  clearInterval(pollTimer);
  clearTimeout(toastTimer);
  clearTimeout(pulseTimer);
  window.removeEventListener('popstate', onPop);
  window.removeEventListener('click', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand"><HardDrive :size="22" aria-hidden="true" /> 文件盒子</div>
      <div class="crumb">
        <template v-for="(c, i) in breadcrumb" :key="c.id || 'root'">
          <ChevronRight v-if="i" :size="14" class="crumb-sep" aria-hidden="true" />
          <button class="crumb-btn" :class="{ current: i === breadcrumb.length - 1 }" @click="navigate(c.id)">{{ c.name }}</button>
        </template>
      </div>
      <label class="search">
        <Search :size="16" aria-hidden="true" />
        <input v-model="query" type="search" placeholder="搜索全部文件夹和文件" aria-label="全局搜索文件夹和文件">
      </label>
      <div class="toolbar-actions">
        <span class="topbar-usage" :title="`已用 ${fmtSize(data.usage.used)} / 上限 ${data.usage.limitGB} GB`">{{ fmtSize(data.usage.used) }} / {{ data.usage.limitGB }} GB</span>
        <button class="btn btn-primary" @click="triggerUpload"><Upload :size="18" /> 上传到「{{ uploadTargetLabel }}」</button>
        <a class="btn" href="../transfer.html">无痕传输</a>
      </div>
    </header>

    <div class="config-strip">
      <Clock :size="16" class="config-icon" aria-hidden="true" />
      <span class="config-label">所有新上传：</span>
      <select
        id="ttl-select"
        v-model.number="settingsTtl"
        class="ttl ttl-global"
        aria-label="所有新上传的自动删除时长"
        :disabled="settingsSaving || libraryNotReady"
        @change="onTtlChange"
      >
        <option v-for="h in ttlOptions" :key="h" :value="h">{{ ttlLabel(h) }}后自动删除</option>
      </select>
      <span class="config-hint" v-if="!libraryNotReady">当前：新上传的文件会在「{{ ttlLabel(settingsTtl) }}」后自动删除，到期永久删除；文件夹不自动删除。已上传文件按各自上传时的设置，设置对所有使用者生效。</span>
      <span class="config-hint" v-else>目录索引暂不可用，自动删除设置暂时不能修改。</span>
    </div>

    <div class="layout">
      <main class="main">
        <div v-if="libraryNotReady" class="banner">目录索引暂不可用，当前按未分档展示；上传与下载仍可用。</div>
        <div v-if="httpsUrl" class="banner">
          当前是 HTTP 兼容模式，加解密会慢一个数量级。改用 <a :href="httpsUrl">HTTPS 地址</a> 可大幅提速（首次需信任自签证书）。
        </div>
        <div v-if="currentId === null && legacyUnfiledCount && !legacyNoticeDismissed" class="banner">
          旧上传已归到「未分档」，原链接和下载次数不变。
          <button class="linkbtn" @click="navigate('__unfiled__')">去整理</button>
          <button class="linkbtn" @click="dismissLegacyNotice">知道了</button>
        </div>
        <div v-if="error" class="banner danger">{{ error }} <button class="linkbtn" @click="refreshLibrary()">重试</button></div>
        <div v-if="manifestError" class="banner danger">部分文件名读取失败：{{ manifestError }} <button class="linkbtn" @click="loadFiles()">重试</button></div>
        <div v-if="shareBanner || shareMissing" class="banner share">
          <Link2 :size="16" aria-hidden="true" />
          <template v-if="shareRows.length">
            分享链接里有 {{ shareRows.length }} 个文件，所在文件夹已高亮：
            <button v-for="row in shareRows.slice(0, 6)" :key="row.key" class="linkbtn share-file" @click="focusShared(row)">{{ row.name }}</button>
            <span v-if="shareRows.length > 6" class="muted">等 {{ shareRows.length }} 个</span>
          </template>
          <template v-else>分享链接里的文件已经不存在。</template>
          <button class="linkbtn" @click="dismissShare">关闭</button>
        </div>

        <div class="upload-line">
          上传到 <b>{{ uploadTargetLabel }}</b> · <span class="muted">{{ uploadTtlText }}</span>
          <span v-if="filesLoading" class="muted"> · 正在读取文件名 {{ manifestProgress.done }}/{{ manifestProgress.total }}</span>
        </div>

        <div v-if="selected.length" class="selection-bar">
          <span>已选 {{ selected.length }} 项</span>
          <button class="linkbtn" @click="toggleAll">全选当前可见</button>
          <button class="linkbtn" :disabled="!selectedFileCount" @click="copySelectedShare">复制分享链接</button>
          <button class="linkbtn" @click="downloadSelectedZip"><Package :size="15" /> 打包下载</button>
          <button class="linkbtn danger-text" @click="openDeleteSelected">删除</button>
          <button class="linkbtn" @click="selected = []">取消</button>
        </div>

        <section v-if="searching" class="search-panel">
          <div class="search-head">
            <Search :size="18" aria-hidden="true" />
            <b>全局搜索「{{ searchTerm }}」</b>
            <span class="muted">文件夹名与文件名都会匹配；结果带出所在目录。</span>
          </div>
          <div v-if="filesLoading" class="search-loading">正在读取文件名 {{ manifestProgress.done }}/{{ manifestProgress.total }}…</div>

          <div v-if="searchFolders.length" class="result-group">
            <h3>文件夹 · {{ searchFolders.length }}</h3>
            <button v-for="item in searchFolders" :key="item.folder.id" class="result-row" @click="navigate(item.folder.id)">
              <Folder :size="18" class="row-icon folder-icon" />
              <span class="result-name">{{ item.folder.name }}</span>
              <span class="result-path">{{ item.path }}</span>
              <span class="result-meta">{{ folderRowMeta(item.folder) }}</span>
            </button>
          </div>

          <div v-if="searchFileResults.length" class="result-group">
            <h3>文件 · {{ searchFileResults.length }}<span v-if="searchFileResults.length >= 300" class="muted">（只显示前 300 条）</span></h3>
            <button v-for="item in searchFileResults" :key="item.row.key" class="result-row" @click="navigateToFile(item.row)">
              <File :size="18" class="row-icon file-icon" />
              <span class="result-name">{{ item.row.name }}</span>
              <span class="result-path">{{ item.path }}</span>
              <span class="result-meta">
                {{ fmtAgo(item.row.uploadedAt, now) }} ·
                <span :class="expiryClass(item.row.expiresAt, now)">{{ fmtExpiry(item.row.expiresAt, now) }}</span>
              </span>
            </button>
          </div>

          <div v-if="!filesLoading && !searchFolders.length && !searchFileResults.length" class="empty">
            <Search :size="32" />
            <p>没有匹配的文件夹或文件</p>
          </div>
        </section>

        <section v-else class="browser" :class="{ loading }">
          <div v-if="loading" class="empty">加载中…</div>
          <div v-else ref="columnsEl" class="columns">
            <section
              v-for="col in columns"
              :key="col.key"
              class="column"
              :class="{ 'drop-target': dragTargetKey === col.key }"
            >
              <header class="col-head">
                <div class="col-title">
                  <Inbox v-if="col.id === '__unfiled__'" :size="18" class="folder-icon" />
                  <Folder v-else :size="18" class="folder-icon" />
                  <div class="col-title-text">
                    <b class="ellipsis">{{ colLabel(col) }}</b>
                    <span class="col-sub">{{ colMeta(col) }}</span>
                  </div>
                </div>
                <div class="col-tools">
                  <input
                    v-if="col.folders.length || col.files.length"
                    type="checkbox"
                    class="col-check"
                    :checked="allSelectedIn(columnKeys(col))"
                    :aria-label="`全选 ${colLabel(col)}`"
                    @change="toggleColumn(col)"
                  >
                  <button
                    v-if="col.folder"
                    class="icon-btn col-icon"
                    title="打包下载这个文件夹"
                    aria-label="打包下载这个文件夹"
                    @click="downloadFolderZip(col.folder)"
                  ><Package :size="16" /></button>
                  <button
                    v-if="col.id !== '__unfiled__'"
                    class="icon-btn col-icon"
                    title="新建文件夹"
                    aria-label="新建文件夹"
                    @click="openNewFolder(col.id)"
                  ><FolderPlus :size="16" /></button>
                  <button
                    class="icon-btn col-icon"
                    title="更多操作"
                    aria-label="更多操作"
                    @click.stop="showMenuFor($event, col.folder ? folderMenuItems(col.folder) : columnMenuItems(col))"
                  >⋯</button>
                </div>
              </header>

              <div
                class="col-list"
                @contextmenu.prevent="openColumnMenu($event, col)"
                @dragover="onColumnDragOver($event, col)"
                @dragleave="onColumnDragLeave($event, col)"
                @drop="onColumnDrop($event, col)"
              >
                <div
                  v-for="folder in col.folders"
                  :key="folder.id"
                  class="col-row folder-row"
                  :class="{
                    selected: isSelected(`folder:${folder.id}`),
                    current: pathIds.has(folder.id),
                    shared: sharedFolderIds.has(folder.id),
                  }"
                  @click="navigate(folder.id)"
                  @contextmenu.prevent.stop="openFolderMenu($event, folder)"
                >
                  <input
                    type="checkbox"
                    class="col-check"
                    :checked="isSelected(`folder:${folder.id}`)"
                    :aria-label="`选择 ${folder.name}`"
                    @click.stop
                    @change="toggleSelect(`folder:${folder.id}`)"
                  >
                  <Folder :size="20" class="row-icon folder-icon" />
                  <span class="col-name" :title="folder.name">{{ folder.name }}
                    <span v-if="folder.system" class="tag">系统</span>
                    <span v-if="isHot(folder.lastUpdatedAt, now)" class="tag hot">热乎</span>
                  </span>
                  <span class="col-meta">{{ folderRowMeta(folder) }}</span>
                  <span v-if="folder.earliestExpiresAt" :class="expiryClass(folder.earliestExpiresAt, now)" class="col-expiry">
                    {{ fmtExpiry(folder.earliestExpiresAt, now) }}
                  </span>
                  <button class="icon-btn col-more" title="更多操作" aria-label="更多操作" @click.stop="showMenuFor($event, folderMenuItems(folder))">⋯</button>
                </div>

                <div
                  v-for="row in col.files"
                  :key="row.key"
                  class="col-row file-row"
                  :class="{
                    selected: isSelected(row.key),
                    shared: sharedFileKeys.has(row.key),
                    pulse: pulseKeys.has(row.key),
                    expiring: isExpiring(row),
                  }"
                  @click="toggleSelect(row.key)"
                  @dblclick="addDownload(row)"
                  @contextmenu.prevent.stop="openFileMenu($event, row)"
                >
                  <input
                    type="checkbox"
                    class="col-check"
                    :checked="isSelected(row.key)"
                    :aria-label="`选择 ${row.name}`"
                    @click.stop
                    @change="toggleSelect(row.key)"
                  >
                  <File :size="20" class="row-icon file-icon" />
                  <span class="col-name" :title="row.name">{{ row.name }}
                    <span v-if="isHot(row.uploadedAt, now)" class="tag hot">热乎</span>
                    <span v-if="sharedFileKeys.has(row.key)" class="tag share-tag">分享</span>
                    <span v-if="row.legacy" class="tag">旧数据</span>
                    <span v-if="row.missingMeta" class="tag warn">清单缺失</span>
                  </span>
                  <span class="col-meta" :title="fmtFullTime(row.uploadedAt)">{{ fmtUploaded(row.uploadedAt) }} · {{ fmtAgo(row.uploadedAt, now) }} · {{ dlText(row.downloads) }}</span>
                  <span :class="expiryClass(row.expiresAt, now)" class="col-expiry">{{ fmtExpiry(row.expiresAt, now) }}</span>
                  <button class="icon-btn col-more" title="更多操作" aria-label="更多操作" @click.stop="showMenuFor($event, fileMenuItems(row))">⋯</button>
                </div>

                <div v-if="!col.folders.length && !col.files.length" class="col-empty">
                  <Folder :size="28" />
                  <p>{{ col.id === '__unfiled__' ? '未分档还没有文件' : '空文件夹' }}</p>
                  <p class="muted">右键可新建文件夹，或把文件拖到这里上传</p>
                </div>
              </div>

              <div v-if="dragTargetKey === col.key" class="col-drop">松手上传到「{{ colLabel(col) === '全部文件' ? '未分档' : colLabel(col) }}」</div>
            </section>
          </div>
        </section>

        <section v-if="tasks.length || pendingUploads.length" class="tasks">
          <div class="tasks-head">
            <h2><ListChecks :size="18" /> 任务</h2>
            <button v-if="tasks.length" class="linkbtn" @click="clearDone">清理已完成</button>
          </div>

          <div v-for="p in pendingUploads" :key="p.uploadId" class="task pending">
            <div class="task-main">
              <div class="task-title">未完成上传 · {{ p.fileCount }} 个文件</div>
              <div class="task-sub">已收 {{ p.receivedChunks }}/{{ p.totalChunks }} 块 · {{ fmtSize(p.bytes) }}</div>
            </div>
            <div class="task-actions">
              <button class="linkbtn" @click="resumeUpload(p)">重新选择同一批文件继续</button>
              <button class="linkbtn danger-text" @click="cancelPending(p)">删除</button>
            </div>
          </div>

          <div v-for="task in tasks" :key="task.id" class="task" :class="task.state">
            <div class="task-main">
              <div class="task-title">
                <component :is="task.kind === 'upload' ? Upload : task.kind === 'folder-delete' ? Trash2 : task.kind === 'zip' ? Package : Download" :size="16" />
                <span class="ellipsis">{{ task.title }}</span>
                <span class="task-state">{{ stateText(task) }}</span>
              </div>
              <div class="bar"><span :style="{ width: `${taskPct(task)}%` }"></span></div>
              <div class="task-sub">{{ taskMeta(task) }}<span v-if="task.error" class="danger-text"> · {{ task.error }}</span></div>
            </div>
            <div class="task-actions">
              <template v-if="task.kind === 'upload'">
                <button v-if="task.state === 'running'" class="icon-btn" title="暂停" @click="task.pause()"><Pause :size="16" /></button>
                <button v-else-if="['paused','failed'].includes(task.state)" class="icon-btn" title="继续" @click="task.resume()"><Play :size="16" /></button>
                <button v-if="!['done','canceled'].includes(task.state)" class="linkbtn danger-text" @click="task.cancel()">取消</button>
                <button v-if="task.state === 'done'" class="linkbtn" @click="task.openResult()">打开所在目录</button>
              </template>
              <template v-else-if="task.kind === 'download' || task.kind === 'zip'">
                <button v-if="task.state === 'running'" class="icon-btn" title="暂停" @click="task.pause()"><Pause :size="16" /></button>
                <button v-else-if="['paused','failed'].includes(task.state)" class="icon-btn" title="继续" @click="task.resume()"><Play :size="16" /></button>
                <button v-if="!['done','canceled'].includes(task.state)" class="linkbtn danger-text" @click="task.cancel()">取消</button>
              </template>
              <template v-else>
                <button v-if="task.state === 'running'" class="icon-btn" title="暂停" @click="task.pause()"><Pause :size="16" /></button>
                <button v-else-if="['paused','failed'].includes(task.state)" class="icon-btn" title="继续" @click="task.resume()"><Play :size="16" /></button>
                <button v-if="!['done','canceled'].includes(task.state)" class="linkbtn danger-text" @click="task.cancel()">取消</button>
              </template>
              <button v-if="['done','canceled'].includes(task.state)" class="linkbtn" @click="task.remove()">移除</button>
            </div>
          </div>
        </section>
      </main>
    </div>

    <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked">

    <div v-if="toastText" class="toast">{{ toastText }}</div>

    <div v-if="menu" class="context-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
      <template v-for="(item, i) in menu.items" :key="i">
        <div v-if="item.sep" class="menu-sep"></div>
        <button
          v-else
          class="menu-item"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          @click.stop="runMenu(item)"
        >{{ item.label }}</button>
      </template>
    </div>

    <DialogRoot :open="dialog.open" @update:open="dialog.open = $event">
      <DialogPortal>
        <DialogOverlay class="dialog-overlay" />
        <DialogContent class="dialog">
          <DialogTitle as-child><h3>{{ dialog.title }}</h3></DialogTitle>
          <DialogDescription as-child><p v-if="dialog.message">{{ dialog.message }}</p></DialogDescription>
          <input
            v-if="dialog.mode === 'prompt'"
            v-model="dialog.value"
            class="input"
            :maxlength="dialogLimit"
            :placeholder="dialog.kind === 'rename-file' ? '新文件名' : `名称（最多 ${FOLDER_NAME_MAX} 个字）`"
            @keyup.enter="submitDialog"
          >
          <div v-if="dialog.mode === 'prompt' && dialog.kind !== 'rename-file'" class="char-count" :class="{ over: dialogCharCount > FOLDER_NAME_MAX }">
            {{ dialogCharCount }}/{{ FOLDER_NAME_MAX }}
          </div>
          <select v-if="dialog.mode === 'move'" v-model="dialog.value" class="input">
            <option v-for="opt in moveOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <div v-if="dialog.error" class="dialog-error">{{ dialog.error }}</div>
          <div class="dialog-actions">
            <DialogClose as-child><button class="btn">取消</button></DialogClose>
            <button class="btn" :class="dialog.destructive ? 'btn-danger' : 'btn-primary'" :disabled="dialog.busy" @click="submitDialog">
              {{ dialog.busy ? '处理中…' : dialog.confirmText }}
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
