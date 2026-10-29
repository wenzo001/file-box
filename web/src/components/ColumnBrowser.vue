<script setup>
// 桌面端：Finder 式多栏。保留"每一栏是路径上的一级"这个模型，
// 栏内拖拽移动与系统文件拖入上传的落点都在这一层，业务动作仍由 App 发请求。
import { ref } from 'vue';
import { ChevronRight, FolderPlus, Inbox, Package } from '@lucide/vue';
import RowItem from './RowItem.vue';
import { fmtAgo, fmtSize } from '../lib/format.js';
import { onListKeydown, onListFocus } from '../lib/list-nav.js';

const props = defineProps({
  columns: { type: Array, required: true },
  now: { type: Number, required: true },
  rootLabel: { type: String, required: true },
  rootSummary: { type: Object, required: true },    // { folders, files, size, lastUpdatedAt }
  pathIds: { type: Object, required: true },       // Set
  selectedKeys: { type: Object, required: true },  // Set
  columnKeys: { type: Function, required: true },  // col => key[]
  sharedFolderIds: { type: Object, required: true },
  sharedFileKeys: { type: Object, required: true },
  pulseKeys: { type: Object, required: true },
  expiringKeys: { type: Function, required: true },// row => bool
  dndOverId: { type: String, default: '' },
  dndOverCol: { type: String, default: '' },
  dragTargetKey: { type: String, default: '' },
});

const emit = defineEmits([
  'navigate', 'select', 'toggle-column', 'more-folder', 'more-file', 'more-column',
  'column-contextmenu', 'folder-contextmenu', 'file-contextmenu', 'download-file',
  'dragover', 'dragleave', 'drop', 'new-folder', 'zip-folder',
]);

const columnsEl = ref(null);
defineExpose({ columnsEl });

function colLabel(col) { return col.id ? (col.folder?.name || '目录') : props.rootLabel; }

function colMeta(col) {
  // 根那栏现在也装文件（没有目录的批次），读数与下面每一栏用同一套口径
  if (!col.id) {
    const s = props.rootSummary;
    const updated = Number.isFinite(s.lastUpdatedAt) ? ` · 最后更新 ${fmtAgo(s.lastUpdatedAt, props.now)}` : '';
    const uploading = (col.pending || []).length ? ` · ${col.pending.length} 个上传中` : '';
    return `${s.folders} 个文件夹 · ${s.files} 个文件 · ${fmtSize(s.size)}${updated}${uploading}`;
  }
  const folder = col.folder;
  if (!folder) return '';
  const updated = Number.isFinite(folder.lastUpdatedAt) ? `最后更新 ${fmtAgo(folder.lastUpdatedAt, props.now)}` : '还没有文件';
  // 影子行不计入"N 个文件"（还没提交），单独说一句，免得表头写着"还没有文件"下面却有一行
  const uploading = (col.pending || []).length ? ` · ${col.pending.length} 个上传中` : '';
  return `${folder.count || 0} 个文件 · ${updated}${uploading}`;
}

function allSelected(col) {
  const keys = props.columnKeys(col);
  return keys.length > 0 && keys.every((k) => props.selectedKeys.has(k));
}
</script>

<template>
  <div ref="columnsEl" class="columns" role="navigation" aria-label="目录分栏">
    <section
      v-for="col in columns"
      :key="col.key"
      class="column"
      :class="{ 'is-active': col === columns[columns.length - 1], 'drop-target': dragTargetKey === col.key, 'drop-here': dndOverCol === col.key }"
    >
      <header class="col-head">
        <div class="col-title">
          <Inbox v-if="!col.id" :size="17" aria-hidden="true" />
          <ChevronRight v-else :size="17" aria-hidden="true" />
          <div class="col-title-text">
            <b class="ellipsis">{{ colLabel(col) }}</b>
            <span class="col-sub">{{ colMeta(col) }}</span>
          </div>
        </div>
        <div class="col-tools">
          <label v-if="col.folders.length || col.files.length" class="check-hit">
            <input
              type="checkbox"
              class="col-check"
              :checked="allSelected(col)"
              :aria-label="`全选 ${colLabel(col)}`"
              @change="emit('toggle-column', col)"
            >
          </label>
          <button v-if="col.folder" class="icon-btn col-icon" title="打包下载这个文件夹" aria-label="打包下载这个文件夹" @click="emit('zip-folder', col.folder)">
            <Package :size="16" aria-hidden="true" />
          </button>
          <button class="icon-btn col-icon" title="在此新建文件夹" aria-label="在此新建文件夹" @click="emit('new-folder', col.id)">
            <FolderPlus :size="16" aria-hidden="true" />
          </button>
          <button class="icon-btn col-icon" title="更多操作" aria-label="更多操作" @click.stop="emit('more-column', $event, col)">
            ⋯
          </button>
        </div>
      </header>

      <div
        class="col-list"
        tabindex="0"
        role="listbox"
        :aria-label="`${colLabel(col)} 的内容`"
        @keydown="onListKeydown"
        @focus="onListFocus"
        @contextmenu.prevent="emit('column-contextmenu', $event, col)"
        @dragover="emit('dragover', $event, col)"
        @dragleave="emit('dragleave', $event, col)"
        @drop="emit('drop', $event, col)"
      >
        <!-- dndOverId 是 lib/dnd.js 从落点行的 data-dnd-folder 读出的裸目录 id（不是行身份 folder:<id>） -->
        <RowItem
          v-for="folder in col.folders"
          :key="folder.id"
          kind="folder"
          :item="{ ...folder, key: `folder:${folder.id}` }"
          :now="now"
          dnd
          :selected="selectedKeys.has(`folder:${folder.id}`)"
          :current="pathIds.has(folder.id)"
          :shared="sharedFolderIds.has(folder.id)"
          :drop-here="dndOverId === folder.id"
          @open="emit('navigate', folder.id)"
          @select="emit('select', $event)"
          @more="emit('more-folder', $event, folder)"
          @contextmenu="emit('folder-contextmenu', $event, folder)"
        />

        <RowItem
          v-for="p in col.pending"
          :key="p.key"
          kind="pending"
          :item="p"
          :now="now"
        />

        <RowItem
          v-for="row in col.files"
          :key="row.key"
          kind="file"
          :item="row"
          :now="now"
          dnd
          :selected="selectedKeys.has(row.key)"
          :shared="sharedFileKeys.has(row.key)"
          :pulse="pulseKeys.has(row.key)"
          :expiring="expiringKeys(row)"
          @activate="emit('select', $event)"
          @select="emit('select', $event)"
          @more="emit('more-file', $event, row)"
          @contextmenu="emit('file-contextmenu', $event, row)"
          @dblclick="emit('download-file', row)"
        />

        <div v-if="!col.folders.length && !col.pending.length && !col.files.length" class="col-empty">
          <Inbox :size="26" aria-hidden="true" />
          <p>{{ col.id ? '空文件夹' : '还没有文件' }}</p>
          <p class="muted">右键可新建文件夹，或把文件拖到这里上传</p>
        </div>
      </div>

      <div v-if="dragTargetKey === col.key" class="col-drop">
        松手上传到「{{ colLabel(col) }}」
      </div>
    </section>
  </div>
</template>
