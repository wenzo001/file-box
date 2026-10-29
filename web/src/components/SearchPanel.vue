<script setup>
// 全局搜索结果：文件夹与文件两组，每条都带出所在目录，点文件=跳过去并pulse那一行。
import { File, Folder, Search } from '@lucide/vue';
import { expiryClass, fmtAgo, fmtExpiry, fmtSize } from '../lib/format.js';

defineProps({
  term: { type: String, required: true },
  folders: { type: Array, required: true },   // [{folder,path}]
  files: { type: Array, required: true },      // [{row,path}]
  loading: { type: Boolean, default: false },
  progress: { type: Object, default: () => ({ done: 0, total: 0 }) },
  now: { type: Number, required: true },
});
const emit = defineEmits(['open-folder', 'open-file']);
</script>

<template>
  <section class="search-panel" aria-label="搜索结果">
    <div class="search-head">
      <Search :size="16" aria-hidden="true" />
      <b>搜索「{{ term }}」</b>
      <span class="muted">文件夹名与文件名都会匹配</span>
    </div>

    <div v-if="loading" class="search-loading">正在读取文件名 {{ progress.done }}/{{ progress.total }}…</div>

    <div v-if="folders.length" class="result-group">
      <h3>文件夹 · {{ folders.length }}</h3>
      <button v-for="item in folders" :key="item.folder.id" class="result-row" @click="emit('open-folder', item.folder.id)">
        <Folder :size="17" class="row-icon ft-folder" aria-hidden="true" />
        <span class="result-name">{{ item.folder.name }}</span>
        <span class="result-path">{{ item.path }}</span>
        <span class="result-meta">{{ item.folder.count || 0 }} 个文件</span>
      </button>
    </div>

    <div v-if="files.length" class="result-group">
      <h3>文件 · {{ files.length }}<span v-if="files.length >= 300" class="muted">（只显示前 300 条）</span></h3>
      <button v-for="item in files" :key="item.row.key" class="result-row" @click="emit('open-file', item.row)">
        <File :size="17" class="row-icon ft-other" aria-hidden="true" />
        <span class="result-name">{{ item.row.name }}</span>
        <span class="result-path">{{ item.path }}</span>
        <span class="result-meta">
          {{ fmtSize(item.row.size || 0) }} · {{ fmtAgo(item.row.uploadedAt, now) }} ·
          <span :class="expiryClass(item.row.expiresAt, now)">{{ fmtExpiry(item.row.expiresAt, now) }}</span>
        </span>
      </button>
    </div>

    <div v-if="!loading && !folders.length && !files.length" class="empty">
      <Search :size="28" aria-hidden="true" />
      <p>没有匹配的文件夹或文件</p>
      <p class="muted">换个关键词试试；名字里有的都能搜到</p>
    </div>
  </section>
</template>
