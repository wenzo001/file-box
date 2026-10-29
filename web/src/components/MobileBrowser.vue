<script setup>
// 手机档：单层列表 + 返回。点目录=进目录，点文件=开操作表，长按=进多选。
// 三种手势各管一件事，不会出现"同一个点击既像选中又像打开"。
import { computed } from 'vue';
import { ChevronLeft, FolderPlus, ListChecks, Package, Upload } from '@lucide/vue';
import RowItem from './RowItem.vue';
import { onListKeydown, onListFocus } from '../lib/list-nav.js';
import { fmtAgo, fmtSize } from '../lib/format.js';

const props = defineProps({
  col: { type: Object, required: true },
  path: { type: Array, required: true },        // [{id,name}] 从根到当前
  now: { type: Number, required: true },
  rootLabel: { type: String, required: true },
  selectedKeys: { type: Object, required: true },
  sharedFolderIds: { type: Object, required: true },
  sharedFileKeys: { type: Object, required: true },
  pulseKeys: { type: Object, required: true },
  expiringKeys: { type: Function, required: true },
  selecting: { type: Boolean, default: false },
  allSelected: { type: Boolean, default: false },
});

const emit = defineEmits([
  'back', 'navigate', 'select', 'longpress', 'sheet-folder', 'sheet-file',
  'new-folder', 'upload', 'zip', 'toggle-all',
]);

// 手机上操作表的位置由抽屉本身决定，不需要触发点坐标，所以只往外传"哪一项"。
// （RowItem 的 activate 带的是 key，不是事件 —— 拿它当 event 用会当场抛错。）
const sheetFolder = (folder) => emit('sheet-folder', folder);
const sheetFile = (row) => emit('sheet-file', row);

const parent = computed(() => (props.path.length >= 2 ? props.path[props.path.length - 2] : null));
const title = computed(() => (props.col.id ? (props.col.folder?.name || '目录') : props.rootLabel));
const meta = computed(() => {
  const f = props.col.folder;
  if (f) {
    const updated = Number.isFinite(f.lastUpdatedAt) ? `最后更新 ${fmtAgo(f.lastUpdatedAt, props.now)}` : '还没有文件';
    const uploading = (props.col.pending || []).length ? ` · ${props.col.pending.length} 个上传中` : '';
    return `${f.count || 0} 个文件 · ${fmtSize(f.size || 0)} · ${updated}${uploading}`;
  }
  return `${props.col.folders.length} 个文件夹 · ${props.col.files.length} 个文件`;
});
</script>

<template>
  <div class="mobile-browser">
    <div class="mb-head">
      <button v-if="parent" class="mb-back" @click="emit('back')">
        <ChevronLeft :size="18" aria-hidden="true" />
        <span class="ellipsis">{{ parent.name }}</span>
      </button>
      <div class="mb-title">
        <b>{{ title }}</b>
        <span class="col-sub">{{ meta }}</span>
      </div>
      <div class="mb-actions">
        <!-- 这颗的动作是"没全选就全选、全选了才退出"，所以标签要跟着 allSelected 而不是 selecting：
             部分选中时它写着「退出多选」按下去却是补全选 —— 标签和动作不是同一件事 -->
        <button class="icon-btn" :class="{ 'is-active': selecting }" :aria-pressed="String(selecting)" :aria-label="allSelected ? '退出多选' : '多选'" :title="allSelected ? '退出多选' : '多选'" @click="emit('toggle-all')">
          <ListChecks :size="18" aria-hidden="true" />
        </button>
        <button v-if="col.folder" class="icon-btn" title="打包下载这个文件夹" aria-label="打包下载这个文件夹" @click="emit('zip', col.folder)">
          <Package :size="18" aria-hidden="true" />
        </button>
        <button class="icon-btn" title="在此新建文件夹" aria-label="在此新建文件夹" @click="emit('new-folder', col.id)">
          <FolderPlus :size="18" aria-hidden="true" />
        </button>
        <button class="icon-btn" title="上传文件" aria-label="上传文件" @click="emit('upload')">
          <Upload :size="18" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- 深目录时给一条能横向翻的路径，不用一次次点返回 -->
    <nav v-if="path.length > 2" class="mb-path" aria-label="上级路径">
      <button
        v-for="p in path.slice(0, -1)"
        :key="p.id || 'root'"
        class="mb-path-chip"
        @click="emit('navigate', p.id)"
      >{{ p.name }}</button>
    </nav>

    <div
      class="mb-list"
      :class="{ 'is-selecting': selecting }"
      tabindex="0"
      role="listbox"
      :aria-label="`${title} 的内容`"
      @keydown="onListKeydown"
      @focus="onListFocus"
    >
      <p v-if="col.folders.length && col.files.length" class="mb-group">文件夹</p>
      <RowItem
        v-for="folder in col.folders"
        :key="folder.id"
        kind="folder"
        :item="{ ...folder, key: `folder:${folder.id}` }"
        :now="now"
        :selecting="selecting"
        :selected="selectedKeys.has(`folder:${folder.id}`)"
        :shared="sharedFolderIds.has(folder.id)"
        @open="emit('navigate', folder.id)"
        @select="emit('select', $event)"
        @longpress="emit('longpress', `folder:${folder.id}`)"
        @more="sheetFolder(folder)"
      />

      <RowItem
        v-for="p in col.pending"
        :key="p.key"
        kind="pending"
        :item="p"
        :now="now"
      />

      <p v-if="col.folders.length && (col.files.length || col.pending.length)" class="mb-group">文件</p>
      <RowItem
        v-for="row in col.files"
        :key="row.key"
        kind="file"
        :item="row"
        :now="now"
        :selecting="selecting"
        :selected="selectedKeys.has(row.key)"
        :shared="sharedFileKeys.has(row.key)"
        :pulse="pulseKeys.has(row.key)"
        :expiring="expiringKeys(row)"
        @activate="sheetFile(row)"
        @select="emit('select', $event)"
        @longpress="emit('longpress', row.key)"
        @more="sheetFile(row)"
      />

      <div v-if="!col.folders.length && !col.pending.length && !col.files.length" class="col-empty">
        <p>这个文件夹还是空的</p>
        <div class="empty-actions">
          <button class="btn" @click="emit('new-folder', col.id)">新建文件夹</button>
          <button class="btn btn-primary" @click="emit('upload')">上传文件</button>
        </div>
      </div>
    </div>
  </div>
</template>
