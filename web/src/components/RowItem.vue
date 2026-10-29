<script setup>
// 一行的全部呈现。桌面分栏与手机列表共用它，差别只在外面那层容器的排版规则。
// 根元素必须是单个 .col-row：@formkit/drag-and-drop 按"值数组 ↔ 容器子元素"一一对应来配对，
// 多包一层就会配错行，把文件搬到兄弟目录去。
import { computed } from 'vue';
import {
  File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo,
  Folder, FolderOpen, MoreHorizontal,
} from '@lucide/vue';
import { createLongPress } from '../lib/long-press.js';
import { fileIcon } from '../lib/file-icon.js';
import { dlText, expiryClass, fmtAgo, fmtExpiry, fmtFullTime, fmtSize, fmtUploaded, isHot } from '../lib/format.js';

const LUCIDE = {
  File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo,
};

const props = defineProps({
  kind: { type: String, required: true },        // folder | file | pending
  item: { type: Object, required: true },
  now: { type: Number, required: true },
  selected: { type: Boolean, default: false },
  current: { type: Boolean, default: false },     // 当前路径上的那一级目录
  shared: { type: Boolean, default: false },
  pulse: { type: Boolean, default: false },
  expiring: { type: Boolean, default: false },
  selecting: { type: Boolean, default: false },   // 手机：多选态才画勾选框
  dnd: { type: Boolean, default: false },         // 桌面：这一行参与栏内拖拽移动
  dropHere: { type: Boolean, default: false },    // 桌面：拖拽正悬停在这一行（它是移动目标）
  tabIndex: { type: [String, Number], default: -1 },
});

const emit = defineEmits(['open', 'activate', 'select', 'more', 'longpress', 'dblclick', 'contextmenu']);

const key = computed(() => props.item.key);

const iconComp = computed(() => {
  if (props.kind === 'file' || props.kind === 'pending') return LUCIDE[fileIcon(props.item.name).icon];
  if (props.kind === 'folder') return Folder;
  return FolderOpen;
});
const tone = computed(() => (props.kind === 'folder' ? 'folder' : fileIcon(props.item.name || '').tone));

const name = computed(() => props.item.name || props.item.key);

const tags = computed(() => {
  const out = [];
  const it = props.item;
  if (props.kind === 'folder') {

  } else if (props.kind === 'pending') {
    out.push({ text: it.paused ? '已暂停' : '上传中', cls: it.paused ? 'warn' : 'hot' });
  } else {
    if (isHot(it.uploadedAt, props.now)) out.push({ text: '热乎', cls: 'hot' });
    if (props.shared) out.push({ text: '分享', cls: 'share-tag' });
    if (it.legacy) out.push({ text: '旧数据', cls: '' });
    if (it.missingMeta) out.push({ text: '清单缺失', cls: 'warn' });
  }
  return out;
});

const pct = computed(() => (props.kind === 'pending' ? Math.round(Math.min(1, Math.max(0, props.item.progress || 0)) * 100) : 0));

const metaParts = computed(() => {
  const it = props.item;
  if (props.kind === 'folder') {
    const updated = Number.isFinite(it.lastUpdatedAt) ? `最后更新 ${fmtAgo(it.lastUpdatedAt, props.now)}` : '还没有文件';
    return [{ cls: 'm-fold', text: `${it.count || 0} 个文件` }, { cls: 'm-size', text: fmtSize(it.size || 0) }, { cls: 'm-ago', text: updated }];
  }
  if (props.kind === 'pending') {
    return [{ cls: 'm-size', text: fmtSize(it.size || 0) }, { cls: 'm-pct', text: `${pct.value}%` }];
  }
  return [
    { cls: 'm-size', text: fmtSize(it.size || 0), strong: true },
    { cls: 'm-time', text: fmtUploaded(it.uploadedAt) },
    { cls: 'm-ago', text: fmtAgo(it.uploadedAt, props.now) },
    { cls: 'm-dl', text: dlText(it.downloads) },
  ];
});

const expiry = computed(() => {
  const at = props.kind === 'folder' ? props.item.earliestExpiresAt : props.item.expiresAt;
  if (props.kind === 'pending') return null;
  return { text: fmtExpiry(at, props.now), cls: expiryClass(at, props.now) };
});

const rowClass = computed(() => ({
  'col-row': true,
  'folder-row': props.kind === 'folder',
  'file-row': props.kind === 'file',
  'pending-row': props.kind === 'pending',
  selected: props.selected,
  current: props.current,
  shared: props.shared,
  pulse: props.pulse,
  expiring: props.expiring,
  'drop-here': props.dropHere,
}));

// aria：pending 行是"播报"不是"控件"，其余按可激活的行暴露
const role = computed(() => (props.kind === 'pending' ? 'listitem' : 'option'));
const ariaLabel = computed(() => {
  const it = props.item;
  if (props.kind === 'pending') return `${it.name} 上传中 ${pct.value}%`;
  const kindText = props.kind === 'folder' ? '文件夹' : '文件';
  const extra = expiry.value ? `，${expiry.value.text}` : '';
  return `${kindText} ${it.name}${extra}`;
});

const lp = createLongPress({ onLongPress: () => emit('longpress') });

function onClick(event) {
  // 长按已经把这一下手势吃掉了，紧随的 click 必须作废，否则"长按选中"会被"点击打开"翻掉
  if (lp.consumeClick()) { event.stopPropagation(); event.preventDefault(); return; }
  if (props.kind === 'folder') emit('open', key.value);
  else if (props.kind === 'file') emit('activate', key.value);
}
function onKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  onClick(event);
}
</script>

<template>
  <!-- 目录行多带一颗裸 id：data-dnd-id 是"这一行的身份"（folder:<id>，与选中键同命名空间），
       而拖拽落点要的是能直接发给 /api 的目录 id —— 混用会把 folder:f_xxx 当目录去查，服务端回「目标目录不存在」 -->
  <div
    :class="rowClass"
    :data-dnd-kind="dnd && kind !== 'pending' ? kind : undefined"
    :data-dnd-id="dnd && kind !== 'pending' ? key : undefined"
    :data-dnd-folder="dnd && kind === 'folder' ? item.id : undefined"
    :aria-busy="kind === 'pending' ? 'true' : undefined"
    :aria-label="ariaLabel"
    :aria-selected="kind === 'pending' ? undefined : String(selected)"
    :role="role"
    :tabindex="kind === 'pending' ? -1 : tabIndex"
    @pointerdown="lp.onPointerdown"
    @pointermove="lp.onPointermove"
    @pointerup="lp.onPointerup"
    @pointercancel="lp.onPointercancel"
    @pointerleave="lp.onPointerleave"
    @click="onClick"
    @dblclick="kind === 'file' ? emit('dblclick', key) : undefined"
    @contextmenu="emit('contextmenu', $event)"
    @keydown="onKeydown"
  >
    <label class="check-hit" :aria-hidden="!selecting && kind !== 'folder' ? 'true' : undefined" @click.stop>
      <input
        v-if="kind !== 'pending'"
        type="checkbox"
        class="col-check"
        :checked="selected"
        :aria-label="`选择 ${item.name || key}`"
        :tabindex="-1"
        @change="emit('select', key)"
      >
    </label>

    <component :is="iconComp" :size="18" class="row-icon" :class="`ft-${tone}`" aria-hidden="true" />

    <span class="col-name" :title="name">
      <span class="name-text">{{ name }}</span>
      <span v-for="t in tags" :key="t.text" class="tag" :class="t.cls">{{ t.text }}</span>
    </span>

    <span class="col-meta" :title="kind === 'file' ? fmtFullTime(item.uploadedAt) : undefined">
      <template v-for="(part, i) in metaParts" :key="i">
        <span v-if="i" aria-hidden="true">·</span>
        <b v-if="part.strong" class="col-size">{{ part.text }}</b>
        <span v-else :class="part.cls">{{ part.text }}</span>
      </template>
      <span v-if="expiry" class="col-expiry" :class="expiry.cls">{{ expiry.text }}</span>
    </span>

    <span
      v-if="kind === 'pending'"
      class="pending-track"
      role="progressbar"
      aria-label="上传进度"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="pct"
    >
      <span class="pending-fill" :style="{ width: `${pct}%` }"></span>
    </span>

    <button
      v-if="kind !== 'pending'"
      class="icon-btn col-more"
      title="更多操作"
      aria-label="更多操作"
      :tabindex="-1"
      @click.stop="emit('more', $event)"
    ><MoreHorizontal :size="16" aria-hidden="true" /></button>
  </div>
</template>
