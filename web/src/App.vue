<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useNow } from '@vueuse/core';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import {
  ArrowLeft, ArrowUp, ChevronRight, Download, File, Folder, FolderPlus,
  HardDrive, Inbox, ListChecks, Pause, Play, RotateCcw, Search, Trash2, Upload,
} from '@lucide/vue';
import { api } from './lib/api.js';
import { encodeManifest, fetchManifest, invalidateManifest, manifestMap } from './lib/manifest.js';
import { UploadTask, UPLOAD_TTL_OPTIONS, relPath, sortSelected } from './lib/upload.js';
import { clearDownload, downloadFile } from './lib/download.js';
import {
  collator, dlText, expiryClass, fmtExpiry, fmtSize, fmtUploaded, fmtFullTime,
} from './lib/format.js';

const now = useNow({ interval: 30_000 });
const data = ref({
  folders: [], batches: [], usage: { used: 0, limit: 1, limitGB: 10 },
  ttlOptions: UPLOAD_TTL_OPTIONS, now: Date.now(), libraryReady: true,
});
const currentId = ref(null);
const loading = ref(true);
const filesLoading = ref(false);
const error = ref('');
const manifestError = ref('');
const query = ref('');
const sortKey = ref('uploadedAt');
const sortDir = ref('desc');
const selected = ref([]);
const allFileRows = ref([]);
const manifestState = ref(new Map());
const tasks = ref([]);
const pendingUploads = ref([]);
const resumePending = ref(null);
const ttlHours = ref(1);
const fileInput = ref(null);
const dragActive = ref(false);
const toastText = ref('');
let toastTimer = null;
let pollTimer = null;
let taskSeq = 0;

const dialog = reactive({
  open: false, kind: '', mode: 'confirm', title: '', message: '',
  value: '', error: '', busy: false, destructive: false,
  confirmText: '确定', target: null, items: [],
});

const rootLabel = '全部文件';
const folderMap = computed(() => new Map(data.value.folders.map((f) => [f.id, f])));
const currentFolder = computed(() => {
  if (currentId.value === '__unfiled__') {
    return data.value.folders.find((f) => f.id === '__unfiled__') || {
      id: '__unfiled__', name: '未分档', system: true, parentId: null, count: 0, size: 0,
    };
  }
  return currentId.value ? folderMap.value.get(currentId.value) || null : null;
});

const breadcrumb = computed(() => {
  const out = [{ id: null, name: rootLabel }];
  if (!currentId.value) return out;
  const chain = [];
  let cur = currentFolder.value;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? folderMap.value.get(cur.parentId) : null;
  }
  return out.concat(chain);
});

const uploadTargetId = computed(() => (currentId.value && currentId.value !== '__unfiled__' ? currentId.value : null));
const uploadTargetLabel = computed(() => (uploadTargetId.value ? (folderMap.value.get(uploadTargetId.value)?.name || '目录') : '未分档'));

const visibleFolders = computed(() => {
  if (currentId.value === '__unfiled__') return [];
  let list;
  if (currentId.value === null) {
    list = data.value.folders.filter((f) => f.parentId === null);
  } else {
    list = data.value.folders.filter((f) => f.parentId === currentId.value);
  }
  const q = query.value.trim().toLowerCase();
  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
  return list.slice().sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
});

const visibleBatches = computed(() => {
  if (currentId.value === null) return [];
  if (currentId.value === '__unfiled__') return data.value.batches.filter((b) => !b.folderId);
  return data.value.batches.filter((b) => b.folderId === currentId.value);
});

const sortedFiles = computed(() => {
  const q = query.value.trim().toLowerCase();
  let rows = allFileRows.value;
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = a[sortKey.value], bv = b[sortKey.value];
    if (sortKey.value === 'name') return collator.compare(av, bv) * dir;
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av < bv ? -1 : 1) * dir;
  });
});

const displayRows = computed(() => {
  const rows = [];
  for (const f of visibleFolders.value) rows.push({ type: 'folder', key: `folder:${f.id}`, folder: f });
  if (currentId.value === '__unfiled__') {
    for (const b of visibleBatches.value) {
      const files = sortedFiles.value.filter((r) => r.batch === b.name);
      if (!files.length) continue;
      rows.push({ type: 'batch', key: `batch:${b.name}`, batch: b, files });
      for (const f of files) rows.push({ type: 'file', key: f.key, file: f });
    }
  } else {
    for (const f of sortedFiles.value) rows.push({ type: 'file', key: f.key, file: f });
  }
  return rows;
});

const hasFiles = computed(() => allFileRows.value.length > 0 || currentId.value === '__unfiled__');
const empty = computed(() => !loading.value && !displayRows.value.length);
const libraryNotReady = computed(() => data.value.libraryReady === false);
const httpsUrl = computed(() => {
  if (!data.value.httpsPort || location.protocol !== 'http:') return '';
  if (window.FBCrypto && window.FBCrypto.native) return '';
  return `https://${location.hostname}:${data.value.httpsPort}${location.pathname}${location.search}`;
});
const legacyNoticeDismissed = ref(false);
const legacyUnfiledCount = computed(() => data.value.batches.filter((b) => b.legacy && !b.folderId).length);
function dismissLegacyNotice() {
  legacyNoticeDismissed.value = true;
  try { localStorage.setItem('fb-legacy-notice', '1'); } catch { /* 隐私模式 */ }
}
const selectedItems = computed(() => {
  const map = new Map();
  for (const row of displayRows.value) {
    if (row.type === 'folder') map.set(row.key, { type: 'folder', folder: row.folder, key: row.key });
    if (row.type === 'file') map.set(row.key, { type: 'file', file: row.file, key: row.key });
  }
  return selected.value.map((k) => map.get(k)).filter(Boolean);
});
const allSelectableKeys = computed(() => displayRows.value
  .filter((r) => r.type === 'folder' || r.type === 'file')
  .map((r) => r.key));

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
  const walk = (pid, depth) => {
    for (const f of children.get(pid) || []) {
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk('__root__', 0);
  return out;
});

const moveOptions = computed(() => {
  const options = [];
  if (dialog.kind === 'move-batch') options.push({ value: '__unfiled__', label: '未分档' });
  options.push({ value: '', label: '全部文件（根）' });
  const excluded = new Set();
  if (dialog.kind === 'move-folder' && dialog.target?.folder) {
    const root = dialog.target.folder.id;
    excluded.add(root);
    let changed = true;
    while (changed) {
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
    options.push({ value: f.id, label: `${'　'.repeat(f.depth)}${f.name}` });
  }
  return options;
});

const uploadTtlLabel = computed(() => ttlLabel(ttlHours.value));

function ttlLabel(h) {
  if (h === 48) return '2 天';
  if (h === 72) return '3 天';
  if (h === 120) return '5 天';
  if (h === 240) return '10 天';
  if (h === 2160) return '90 天';
  return `${h} 小时`;
}

function toast(message) {
  toastText.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText.value = ''; }, 2600);
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
  if (task.kind === 'upload') {
    return `${task.done || 0}/${task.total || 0} 块 · ${fmtSize(task.doneBytes || 0)}`;
  }
  if (task.kind === 'folder-delete') {
    return `已完成 ${task.index || 0}/${task.items?.length || 0} 项`;
  }
  return `${fmtSize(task.received || 0)} / ${fmtSize(task.total || 0)}`;
}

function updateUrl() {
  const url = new URL(location.href);
  url.search = '';
  if (currentId.value) url.searchParams.set('f', currentId.value);
  history.pushState({ f: currentId.value }, '', url);
}

async function loadFiles() {
  const batches = visibleBatches.value;
  if (!batches.length) { allFileRows.value = []; return; }
  filesLoading.value = true;
  manifestError.value = '';
  try {
    const records = new Map(manifestState.value);
    await Promise.all(batches.map(async (b) => {
      if (records.has(b.name)) return;
      try {
        const rec = await fetchManifest(b.name);
        records.set(b.name, rec);
      } catch (err) {
        records.set(b.name, null);
        manifestError.value = err.message || '清单加载失败';
      }
    }));
    manifestState.value = records;
    const rows = [];
    for (const b of batches) {
      const rec = records.get(b.name);
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
  } finally {
    filesLoading.value = false;
  }
}

async function refreshLibrary({ silent = false } = {}) {
  try {
    const res = await api.library();
    data.value = res;
    if (currentId.value && currentId.value !== '__unfiled__' && !res.folders.some((f) => f.id === currentId.value)) {
      currentId.value = null;
      replaceUrl();
    }
    await loadFiles();
    if (!silent) error.value = '';
    refreshPending();
  } catch (err) {
    if (!silent) error.value = err.message || '加载失败';
  }
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

function navigate(id) {
  const next = id || null;
  if (next === currentId.value) return;
  currentId.value = next;
  selected.value = [];
  query.value = '';
  updateUrl();
  loadFiles();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goUp() {
  if (!currentFolder.value) return;
  navigate(currentFolder.value.parentId || null);
}

function onPop() {
  const params = new URLSearchParams(location.search);
  const f = params.get('f');
  currentId.value = f || null;
  loadFiles();
}

function isSelected(key) { return selected.value.includes(key); }

function toggleSelect(key) {
  if (isSelected(key)) selected.value = selected.value.filter((k) => k !== key);
  else selected.value = [...selected.value, key];
}

function toggleAll() {
  selected.value = selected.value.length === allSelectableKeys.value.length ? [] : allSelectableKeys.value.slice();
}

function sortBy(key) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  else { sortKey.value = key; sortDir.value = key === 'name' ? 'asc' : 'desc'; }
}

function sortMark(key) {
  return sortKey.value === key ? (sortDir.value === 'asc' ? ' ↑' : ' ↓') : '';
}

function triggerUpload() {
  resumePending.value = null;
  fileInput.value?.click();
}

function onFilesPicked(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  const pending = resumePending.value;
  resumePending.value = null;
  if (pending) addUpload(files, { folderId: pending.folderId, ttlHours: pending.ttlHours });
  else addUpload(files, { folderId: uploadTargetId.value, ttlHours: ttlHours.value });
}

function onDrop(event) {
  dragActive.value = false;
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) addUpload(files, { folderId: uploadTargetId.value, ttlHours: ttlHours.value });
}

function addUpload(files, { folderId = null, ttlHours: ttl = 1 } = {}) {
  if (!window.FBCrypto) { toast('加密模块未加载，请刷新页面'); return; }
  sortSelected(files);
  const target = folderId || null;
  const task = reactive({
    id: `task-${++taskSeq}`,
    kind: 'upload',
    title: files.length === 1 ? relPath(files[0]) : `${relPath(files[0])} 等 ${files.length} 个文件`,
    state: 'queued', done: 0, total: 0, doneBytes: 0, error: '', result: null,
    targetLabel: target ? (folderMap.value.get(target)?.name || '目录') : '未分档',
    ttlHours: ttl,
  });
  const up = new UploadTask(files, {
    folderId: target,
    ttlHours: ttl,
    onUpdate: (u) => {
      Object.assign(task, u);
      if (u.state === 'done') {
        const res = u.result || {};
        const folderId = res.folderId || null;
        refreshLibrary({ silent: true });
        refreshPending();
        if (res.indexed === false) {
          toast('上传完成，但目录索引不可用：文件在未分档，未设置自动删除');
          navigate('__unfiled__');
        } else if (res.folderMissing) {
          toast('上传完成，但目标目录已不存在：文件在未分档');
          navigate(folderId || '__unfiled__');
        } else {
          const expiry = res.expiresAt ? fmtExpiry(res.expiresAt, Date.now()) : '手动删除';
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
  if (!folderId || folderId === uploadTargetId.value) ttlHours.value = 1;
  up.run();
}

async function addDownload(row) {
  const task = reactive({
    id: `task-${++taskSeq}`,
    kind: 'download',
    title: row.name,
    state: 'running',
    received: 0,
    total: row.cipherSize || 0,
    error: '',
    row,
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
          onUpdate: (p) => { task.received = p.received; task.total = p.total || task.total; },
        },
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

function clearDone() {
  tasks.value = tasks.value.filter((t) => !['done', 'canceled'].includes(t.state));
}

function openPrompt(kind, title, value = '', target = null) {
  Object.assign(dialog, {
    open: true, kind, mode: 'prompt', title, message: '', value, error: '',
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

function openMoveBatch(batch) {
  Object.assign(dialog, {
    open: true, kind: 'move-batch', mode: 'move', title: '移动这批文件到…', message: '',
    value: batch.folderId || '__unfiled__', error: '', busy: false, destructive: false,
    confirmText: '移动', target: { batch }, items: [],
  });
}

function openNewFolder() {
  if (currentId.value === '__unfiled__') { toast('未分档不能新建子目录'); return; }
  openPrompt('new-folder', '新建文件夹');
}

function forgetBatchManifest(batch) {
  invalidateManifest(batch);
  // 必须删键而不是写 null：null 在 loadFiles 里代表“旧数据没有清单”，会跳过重新拉取
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
  openPrompt('rename-folder', '重命名文件夹', folder.name, { folder });
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

function startFolderDelete(folder) {
  const { folders, batches } = collectFolderTree(folder.id);
  const items = [
    ...batches.map((batch) => ({ kind: 'batch', batch })),
    ...folders.map((id) => ({ kind: 'folder', id })),
  ];
  const task = reactive({
    id: `task-${++taskSeq}`,
    kind: 'folder-delete',
    title: `删除 ${folder.name}`,
    state: 'running',
    items,
    index: 0,
    error: '',
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
          else await api.deleteFolder(item.id, 'empty');
        } catch (err) {
          if (err.status === 404) {
            // 已被别人删掉，视为完成
          } else if (err.status === 409 && item.kind === 'batch') {
            // 快照之后被移走：不误删，继续删剩下的目录
          } else {
            throw err;
          }
        }
        task.index++;
      }
      task.state = 'done';
      toast('文件夹已删除');
      await refreshLibrary();
      refreshPending();
    } catch (err) {
      task.state = 'failed';
      task.error = err.message || '删除失败';
      toast(task.error);
    }
  };
  task.pause = () => { if (task.state !== 'running') return; paused = true; task.state = 'paused'; };
  task.resume = () => { if (task.state === 'done' || task.state === 'canceled') return; paused = false; run(); };
  task.cancel = () => { canceled = true; paused = false; task.state = 'canceled'; };
  task.remove = () => { tasks.value = tasks.value.filter((t) => t !== task); };
  tasks.value.unshift(task);
  run();
}

function openDeleteFolder(folder) {
  if (folder.system) { toast('未分档不能删除'); return; }
  openConfirm(
    'delete-folder',
    '删除文件夹？',
    `“${folder.name}”及其中 ${folder.count || 0} 个文件、${fmtSize(folder.size || 0)} 将被永久删除。`,
    { folder },
  );
}

function openDeleteBatch(batch) {
  openConfirm(
    'delete-batch',
    '删除这批上传？',
    `这会删除该批次的 ${batch.count || 0} 个文件（${fmtSize(batch.size || 0)}），文件夹本身保留。`,
    { batch },
  );
}

function openDeleteFile(row) {
  openConfirm('delete-file', '删除文件？', `“${row.name}”将被永久删除。`, { row });
}

function openDeleteSelected() {
  if (!selectedItems.value.length) return;
  openConfirm('delete-selected', '删除选中的内容？', `将永久删除选中的 ${selectedItems.value.length} 项，不能撤销。`, null, selectedItems.value);
}

async function submitDialog() {
  if (dialog.busy) return;
  dialog.busy = true;
  dialog.error = '';
  try {
    const value = String(dialog.value || '').trim();
    if (dialog.kind === 'new-folder') {
      if (!value) throw new Error('请输入文件夹名');
      await api.createFolder(value, currentId.value && currentId.value !== '__unfiled__' ? currentId.value : null);
      toast('已新建文件夹');
    } else if (dialog.kind === 'rename-folder') {
      if (!value) throw new Error('请输入文件夹名');
      await api.patchFolder(dialog.target.folder.id, { name: value });
      toast('已重命名');
    } else if (dialog.kind === 'rename-file') {
      if (!value) throw new Error('请输入文件名');
      if (/[\\/]/.test(value)) throw new Error('文件名不能含路径分隔符');
      await renameFileRow(dialog.target.row, value);
      toast('已重命名');
    } else if (dialog.kind === 'move-folder') {
      await api.patchFolder(dialog.target.folder.id, { parentId: value || null });
      toast('已移动');
    } else if (dialog.kind === 'move-batch') {
      await api.moveBatch(dialog.target.batch.name, value || null);
      toast('已移动');
    } else if (dialog.kind === 'delete-folder') {
      startFolderDelete(dialog.target.folder);
      toast('已开始删除，进度在任务中心');
    } else if (dialog.kind === 'delete-batch') {
      await api.deleteBatch(dialog.target.batch.name, dialog.target.batch.folderId || null);
      toast('已删除这批上传');
    } else if (dialog.kind === 'delete-file') {
      await removeFileRow(dialog.target.row);
      toast('已删除文件');
    } else if (dialog.kind === 'delete-selected') {
      for (const item of dialog.items) {
        if (item.type === 'folder') await api.deleteFolder(item.folder.id);
        else await removeFileRow(item.file);
      }
      toast('已删除选中内容');
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

async function copyFolderLink(id) {
  const url = new URL(location.href);
  url.search = '';
  if (id) url.searchParams.set('f', id);
  try {
    await navigator.clipboard.writeText(url.href);
    toast('链接已复制');
  } catch {
    toast('复制失败，请手动复制地址栏');
  }
}

async function init() {
  loading.value = true;
  try {
    const res = await api.library();
    data.value = res;
    const params = new URLSearchParams(location.search);
    if (params.get('f')) currentId.value = params.get('f');
    else if (params.get('folder')) {
      const b = res.batches.find((x) => x.name === params.get('folder'));
      currentId.value = b ? (b.folderId || '__unfiled__') : null;
    }
    if (currentId.value && currentId.value !== '__unfiled__' && !res.folders.some((f) => f.id === currentId.value)) {
      currentId.value = null;
    }
    try { legacyNoticeDismissed.value = localStorage.getItem('fb-legacy-notice') === '1'; } catch { /* 隐私模式 */ }
    await loadFiles();
    await refreshPending();
  } catch (err) {
    error.value = err.message || '加载失败';
  } finally {
    loading.value = false;
  }
  pollTimer = setInterval(() => { if (!document.hidden) refreshLibrary({ silent: true }); }, 10_000);
  window.addEventListener('popstate', onPop);
}

onMounted(init);
onBeforeUnmount(() => {
  clearInterval(pollTimer);
  clearTimeout(toastTimer);
  window.removeEventListener('popstate', onPop);
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand"><HardDrive :size="22" aria-hidden="true" /> 文件盒子</div>
      <div class="nav">
        <button class="icon-btn" title="返回上级" aria-label="返回上级" @click="goUp"><ArrowUp :size="18" /></button>
        <button class="icon-btn" title="全部文件" aria-label="全部文件" @click="navigate(null)"><ArrowLeft :size="18" /></button>
      </div>
      <div class="crumb">
        <template v-for="(c, i) in breadcrumb" :key="c.id || 'root'">
          <ChevronRight v-if="i" :size="14" class="crumb-sep" aria-hidden="true" />
          <button class="crumb-btn" :class="{ current: i === breadcrumb.length - 1 }" @click="navigate(c.id)">{{ c.name }}</button>
        </template>
      </div>
      <label class="search">
        <Search :size="16" aria-hidden="true" />
        <input v-model="query" type="search" placeholder="搜索当前文件夹" aria-label="搜索当前文件夹">
      </label>
      <div class="toolbar-actions">
        <button class="btn" :disabled="currentId === '__unfiled__'" @click="openNewFolder"><FolderPlus :size="18" /> 新建文件夹</button>
        <div class="upload-group">
          <button class="btn btn-primary" @click="triggerUpload"><Upload :size="18" /> 上传</button>
          <select v-model.number="ttlHours" class="ttl" aria-label="上传后自动删除时长">
            <option v-for="h in UPLOAD_TTL_OPTIONS" :key="h" :value="h">{{ ttlLabel(h) }}</option>
          </select>
        </div>
        <button class="icon-btn" title="复制当前目录链接" aria-label="复制当前目录链接" @click="copyFolderLink(currentId)">链</button>
        <a class="btn" href="../transfer.html">无痕传输</a>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <button class="side-item" :class="{ active: currentId === null }" @click="navigate(null)">
          <Folder :size="18" /> 全部文件
        </button>
        <button class="side-item" :class="{ active: currentId === '__unfiled__' }" @click="navigate('__unfiled__')">
          <Inbox :size="18" /> 未分档
          <span class="badge">{{ data.folders.find((f) => f.id === '__unfiled__')?.count || 0 }}</span>
        </button>
        <div class="side-sep"></div>
        <button
          v-for="f in treeRows"
          :key="f.id"
          class="side-item tree"
          :class="{ active: currentId === f.id }"
          :style="{ paddingLeft: `${12 + f.depth * 16}px` }"
          @click="navigate(f.id)"
        >
          <Folder :size="16" /> <span class="ellipsis">{{ f.name }}</span>
        </button>
        <div class="usage">
          <div class="usage-bar"><span :style="{ width: `${Math.min(100, (data.usage.used / data.usage.limit) * 100)}%` }"></span></div>
          <div class="usage-text">{{ fmtSize(data.usage.used) }} / {{ data.usage.limitGB }} GB</div>
        </div>
      </aside>

      <main
        class="main"
        @dragover.prevent="dragActive = true"
        @dragleave="dragActive = false"
        @drop.prevent="onDrop"
      >
        <div v-if="dragActive" class="drop-overlay">松手上传到「{{ uploadTargetLabel }}」</div>
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

        <div class="upload-line">
          上传到 <b>{{ uploadTargetLabel }}</b> · <span class="muted">{{ uploadTtlLabel }}后自动删除</span>
        </div>

        <div v-if="selected.length" class="selection-bar">
          <span>已选 {{ selected.length }} 项</span>
          <button class="linkbtn" @click="toggleAll">全选</button>
          <button class="linkbtn danger-text" @click="openDeleteSelected">删除</button>
          <button class="linkbtn" @click="selected = []">取消</button>
        </div>

        <div class="panel">
          <div v-if="loading" class="empty">加载中…</div>
          <template v-else>
            <div v-if="hasFiles" class="table-head">
              <span class="check-cell">
                <input type="checkbox" :checked="selected.length && selected.length === allSelectableKeys.length" aria-label="全选" @change="toggleAll">
              </span>
              <button class="th name" @click="sortBy('name')">名称{{ sortMark('name') }}</button>
              <button class="th" @click="sortBy('size')">大小{{ sortMark('size') }}</button>
              <button class="th" @click="sortBy('uploadedAt')">上传时间{{ sortMark('uploadedAt') }}</button>
              <button class="th" @click="sortBy('expiresAt')">到期{{ sortMark('expiresAt') }}</button>
              <button class="th" @click="sortBy('downloads')">下载{{ sortMark('downloads') }}</button>
              <span class="th actions">操作</span>
            </div>

            <template v-for="row in displayRows" :key="row.key">
              <div v-if="row.type === 'folder'" class="row folder-row" :class="{ selected: isSelected(row.key) }">
                <span class="check-cell"><input type="checkbox" :checked="isSelected(row.key)" :aria-label="`选择 ${row.folder.name}`" @change="toggleSelect(row.key)"></span>
                <button class="row-main folder-main" @click="navigate(row.folder.id)" @dblclick="navigate(row.folder.id)">
                  <Folder :size="20" class="row-icon folder-icon" />
                  <span class="name ellipsis">{{ row.folder.name }}</span>
                  <span class="meta">
                    {{ row.folder.count || 0 }} 个文件 · {{ fmtSize(row.folder.size || 0) }} · {{ dlText(row.folder.downloads || 0) }}
                    <span v-if="row.folder.earliestExpiresAt" :class="expiryClass(row.folder.earliestExpiresAt, now)">· {{ fmtExpiry(row.folder.earliestExpiresAt, now) }}</span>
                    <span v-else class="muted">· 手动删除</span>
                  </span>
                </button>
                <span class="actions">
                  <DropdownMenuRoot>
                    <DropdownMenuTrigger as-child>
                      <button class="icon-btn" aria-label="更多操作">⋯</button>
                    </DropdownMenuTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuContent class="menu" :side-offset="6">
                        <DropdownMenuItem class="menu-item" @select="navigate(row.folder.id)">打开</DropdownMenuItem>
                        <template v-if="!row.folder.system">
                          <DropdownMenuItem class="menu-item" @select="openRenameFolder(row.folder)">重命名</DropdownMenuItem>
                          <DropdownMenuItem class="menu-item" @select="openMoveFolder(row.folder)">移动到…</DropdownMenuItem>
                        </template>
                        <DropdownMenuItem class="menu-item" @select="copyFolderLink(row.folder.id)">复制链接</DropdownMenuItem>
                        <template v-if="!row.folder.system">
                          <DropdownMenuSeparator class="menu-sep" />
                          <DropdownMenuItem class="menu-item danger" @select="openDeleteFolder(row.folder)">删除</DropdownMenuItem>
                        </template>
                      </DropdownMenuContent>
                    </DropdownMenuPortal>
                  </DropdownMenuRoot>
                </span>
              </div>

              <div v-else-if="row.type === 'batch'" class="batch-head">
                <span class="batch-title">上传于 {{ fmtFullTime(row.batch.uploadedAt) }} · {{ row.files.length }} 个文件</span>
                <span class="batch-actions">
                  <button class="linkbtn" @click="openMoveBatch(row.batch)">移动到…</button>
                  <button class="linkbtn danger-text" @click="openDeleteBatch(row.batch)">删除整批</button>
                </span>
              </div>

              <div v-else class="row file-row" :class="{ selected: isSelected(row.key) }">
                <span class="check-cell"><input type="checkbox" :checked="isSelected(row.key)" :aria-label="`选择 ${row.file.name}`" @change="toggleSelect(row.key)"></span>
                <button class="row-main file-main" @click="toggleSelect(row.key)" @dblclick="addDownload(row.file)">
                  <File :size="20" class="row-icon file-icon" />
                  <span class="name ellipsis" :title="row.file.name">{{ row.file.name }}
                    <span v-if="row.file.missingMeta" class="tag warn">清单缺失</span>
                  </span>
                  <span class="meta">
                    {{ fmtUploaded(row.file.uploadedAt) }}
                    <span v-if="row.file.legacy" class="tag">旧数据</span>
                    <span :class="expiryClass(row.file.expiresAt, now)"> · {{ fmtExpiry(row.file.expiresAt, now) }}</span>
                  </span>
                </button>
                <span class="size">{{ fmtSize(row.file.size) }}</span>
                <span class="uploaded">{{ fmtUploaded(row.file.uploadedAt) }}</span>
                <span :class="expiryClass(row.file.expiresAt, now)">{{ fmtExpiry(row.file.expiresAt, now) }}</span>
                <span class="downloads">{{ dlText(row.file.downloads) }}</span>
                <span class="actions">
                  <button class="linkbtn" @click="addDownload(row.file)"><Download :size="15" /> 下载</button>
                  <DropdownMenuRoot>
                    <DropdownMenuTrigger as-child>
                      <button class="icon-btn" aria-label="更多操作">⋯</button>
                    </DropdownMenuTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuContent class="menu" :side-offset="6">
                        <DropdownMenuItem class="menu-item" @select="addDownload(row.file)">下载</DropdownMenuItem>
                        <DropdownMenuItem class="menu-item" :disabled="!row.file.hasManifest" @select="openRenameFile(row.file)">重命名</DropdownMenuItem>
                        <DropdownMenuSeparator class="menu-sep" />
                        <DropdownMenuItem class="menu-item danger" @select="openDeleteFile(row.file)">删除</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenuPortal>
                  </DropdownMenuRoot>
                </span>
              </div>
            </template>

            <div v-if="empty" class="empty">
              <Folder :size="32" />
              <p>{{ query ? '没有匹配的内容' : (currentId === '__unfiled__' ? '未分档还没有文件' : '这个文件夹还是空的') }}</p>
              <div class="empty-actions">
                <button class="btn btn-primary" @click="triggerUpload"><Upload :size="18" /> 上传文件</button>
                <button v-if="currentId !== '__unfiled__'" class="btn" @click="openNewFolder"><FolderPlus :size="18" /> 新建文件夹</button>
              </div>
            </div>
          </template>
        </div>

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
                <component :is="task.kind === 'upload' ? Upload : task.kind === 'download' ? Download : Trash2" :size="16" />
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
              <template v-else-if="task.kind === 'download'">
                <button v-if="task.state === 'running'" class="icon-btn" title="暂停" @click="task.pause()"><Pause :size="16" /></button>
                <button v-else-if="['paused','failed'].includes(task.state)" class="icon-btn" title="继续" @click="task.resume()"><Play :size="16" /></button>
                <button v-if="['paused','failed'].includes(task.state)" class="icon-btn" title="重试" @click="task.resume()"><RotateCcw :size="16" /></button>
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
            :placeholder="dialog.kind === 'rename-file' ? '新文件名' : '名称'"
            @keyup.enter="submitDialog"
          >
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
