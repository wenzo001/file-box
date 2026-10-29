<script setup>
// 任务中心：桌面是列表下方一块可收起的面板，手机是底部抽屉。两种壳、一份行。
import { Download, ListChecks, Package, Pause, Play, RotateCcw, Trash2, Upload, X } from '@lucide/vue';
import { fmtSize } from '../lib/format.js';
import { canCancel, canPause, canResume, isSettled, stateText, taskMeta, taskPct } from '../lib/task-view.js';

const props = defineProps({
  tasks: { type: Array, required: true },
  pendingUploads: { type: Array, default: () => [] },
  expanded: { type: Boolean, default: true },
  // 抽屉形态不需要自己那块标题（抽屉标题已经在外面）
  showHeader: { type: Boolean, default: true },
});
const emit = defineEmits(['toggle', 'resume-pending', 'cancel-pending', 'clear-done']);

const KIND_ICON = { upload: Upload, 'folder-delete': Trash2, zip: Package, download: Download };
const activeCount = () => props.tasks.filter((t) => !isSettled(t)).length;
</script>

<template>
  <section class="tasks" :class="{ collapsed: !expanded }" aria-label="任务中心">
    <div v-if="showHeader" class="tasks-head">
      <button class="linkbtn tasks-toggle" :aria-expanded="String(expanded)" @click="emit('toggle')">
        <ListChecks :size="16" aria-hidden="true" />
        <b>任务</b>
        <span v-if="tasks.length" class="tasks-badge">{{ activeCount() || tasks.length }}</span>
      </button>
      <button v-if="tasks.length" class="linkbtn" @click="emit('clear-done')">清理已完成</button>
    </div>

    <div class="tasks-body" :hidden="!expanded">
      <div v-for="p in pendingUploads" :key="p.uploadId" class="task pending">
        <div class="task-main">
          <div class="task-title">
            <RotateCcw :size="15" aria-hidden="true" />
            <span class="ellipsis">未完成上传 · {{ p.fileCount }} 个文件</span>
          </div>
          <div class="task-sub">已收 {{ p.receivedChunks }}/{{ p.totalChunks }} 块 · {{ fmtSize(p.bytes) }}</div>
        </div>
        <div class="task-actions">
          <button class="linkbtn" @click="emit('resume-pending', p)">继续</button>
          <button class="linkbtn danger-text" @click="emit('cancel-pending', p)">删除</button>
        </div>
      </div>

      <div v-for="task in tasks" :key="task.id" class="task" :class="task.state">
        <div class="task-main">
          <div class="task-title">
            <component :is="KIND_ICON[task.kind] || ListChecks" :size="15" aria-hidden="true" />
            <span class="ellipsis">{{ task.title }}</span>
            <span class="task-state">{{ stateText(task) }}</span>
          </div>
          <div
            class="bar"
            role="progressbar"
            :aria-label="task.title"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="taskPct(task)"
          ><span :style="{ width: `${taskPct(task)}%` }"></span></div>
          <div class="task-sub">
            {{ taskMeta(task) }}<span v-if="task.error" class="danger-text"> · {{ task.error }}</span>
          </div>
        </div>
        <div class="task-actions">
          <button v-if="canPause(task)" class="icon-btn" title="暂停" aria-label="暂停" @click="task.pause()"><Pause :size="15" /></button>
          <button v-else-if="canResume(task)" class="icon-btn" :title="task.state === 'failed' ? '重试' : '继续'" :aria-label="task.state === 'failed' ? '重试' : '继续'" @click="task.resume()">
            <Play :size="15" />
          </button>
          <button v-if="canCancel(task)" class="icon-btn danger-text" title="取消" aria-label="取消" @click="task.cancel()"><X :size="15" /></button>
          <button v-if="task.kind === 'upload' && task.state === 'done'" class="linkbtn" @click="task.openResult()">打开所在目录</button>
          <button v-if="isSettled(task)" class="linkbtn" @click="task.remove()">移除</button>
        </div>
      </div>

      <p v-if="!tasks.length && !pendingUploads.length" class="muted tasks-empty">没有进行中的任务</p>
    </div>
  </section>
</template>
