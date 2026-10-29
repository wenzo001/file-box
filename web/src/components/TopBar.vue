<script setup>
// 顶栏：品牌 + 面包屑（桌面主力路径导航）+ 搜索 + 动作。
// 手机档由 CSS 换成两行，面包屑交给列表头的返回键，这里只留品牌/搜索/动作。
import { CheckSquare, ChevronRight, HardDrive, Search, Settings, Upload } from '@lucide/vue';

const props = defineProps({
  breadcrumb: { type: Array, required: true },
  query: { type: String, required: true },
  usage: { type: Object, required: true },      // { used, limitGB }
  downloadsTotal: { type: Number, default: 0 },
  uploadLabel: { type: String, required: true },
  taskBadge: { type: Number, default: 0 },
  showTasks: { type: Boolean, default: false },
  isMobile: { type: Boolean, default: false },
});
const emit = defineEmits(['navigate', 'update:query', 'upload', 'open-tasks', 'open-settings']);

const pctUsed = () => {
  const limit = (props.usage.limitGB || 1) * 1073741824;
  return Math.min(100, Math.round(((props.usage.used || 0) / limit) * 100));
};
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><HardDrive :size="16" /></span>
      <span class="brand-name">文件盒子</span>
    </div>

    <nav class="crumb" aria-label="路径">
      <template v-for="(c, i) in breadcrumb" :key="c.id || 'root'">
        <ChevronRight v-if="i" :size="13" class="crumb-sep" aria-hidden="true" />
        <button
          class="crumb-btn"
          :class="{ current: i === breadcrumb.length - 1 }"
          :aria-current="i === breadcrumb.length - 1 ? 'page' : undefined"
          @click="emit('navigate', c.id)"
        >{{ c.name }}</button>
      </template>
    </nav>

    <label class="search">
      <Search :size="16" aria-hidden="true" />
      <input
        :value="query"
        type="search"
        placeholder="搜索文件夹和文件"
        aria-label="全局搜索文件夹和文件"
        enterkeyhint="search"
        @input="emit('update:query', $event.target.value)"
      >
    </label>

    <div class="toolbar-actions">
      <span
        v-if="!isMobile"
        class="usage-chip"
        :title="`已用 ${usage.used} 字节 / 上限 ${usage.limitGB} GB；累计下载 ${downloadsTotal} 次`"
      >
        <span class="usage-meter" :class="{ 'is-high': pctUsed() >= 80, 'is-full': pctUsed() >= 95 }" aria-hidden="true">
          <span :style="{ width: `${pctUsed()}%` }"></span>
        </span>
        {{ usage.limitGB }} GB · 下载 {{ downloadsTotal }} 次
      </span>
      <button v-if="isMobile && showTasks" class="icon-btn" aria-label="任务中心" title="任务中心" @click="emit('open-tasks')">
        <CheckSquare :size="18" aria-hidden="true" />
        <span v-if="taskBadge" class="tasks-badge badge-pin">{{ taskBadge }}</span>
      </button>
      <button class="btn btn-primary" :title="`上传到「${uploadLabel}」`" @click="emit('upload')">
        <Upload :size="17" aria-hidden="true" />
        <span class="lbl-full">上传到「{{ uploadLabel }}」</span>
        <span class="lbl-short">上传</span>
      </button>
      <a class="btn" href="../transfer.html">
        <span class="lbl-full">无痕传输</span>
        <span class="lbl-short">传输</span>
      </a>
      <button class="btn settings-entry" aria-label="设置" title="容量 / 自动删除 / 清理" @click="emit('open-settings')">
        <Settings :size="17" aria-hidden="true" />
      </button>
    </div>
  </header>
</template>
