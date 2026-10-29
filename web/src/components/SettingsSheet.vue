<script setup>
// 「设置」底表：把公共配置（容量、累计下载、全局自动删除、清空）收在同一个入口里。
// 这个入口在两端都在（桌面是居中弹层、窄屏是底部抽屉）；桌面顶部那条配置条同时保留，
// 它是上传前最常改的那一项的快捷入口，不是这个弹层的替代。
import {
  DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
} from 'reka-ui';
import { fmtSize, ttlLabel } from '../lib/format.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  ttl: { type: Number, default: 1 },
  options: { type: Array, default: () => [] },
  hint: { type: String, default: '' },
  used: { type: Number, default: 0 },
  limitGb: { type: Number, default: 0 },
  downloadsTotal: { type: Number, default: 0 },
  notReady: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
});
const emit = defineEmits(['update:open', 'change', 'wipe']);

function onTtl(event) {
  emit('change', Number(event.target.value));
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="dialog sheet">
        <DialogTitle as-child><h3>设置</h3></DialogTitle>
        <DialogDescription as-child><p class="sheet-sub">容量、自动删除与清理</p></DialogDescription>

        <div class="sheet-row">
          <span class="config-label">所有新上传</span>
          <select
            class="ttl ttl-global"
            :value="ttl"
            :disabled="saving || notReady"
            aria-label="所有新上传的自动删除时长"
            @change="onTtl"
          >
            <option v-for="h in options" :key="h" :value="h">{{ ttlLabel(h) }}后自动删除</option>
          </select>
        </div>
        <p class="config-hint sheet-hint">{{ notReady ? '目录索引暂不可用，自动删除设置暂时不能修改。' : hint }}</p>

        <div class="sheet-row sheet-stats">
          <span>已用 {{ fmtSize(used) }} / {{ limitGb }} GB</span>
          <span>累计下载 {{ downloadsTotal }} 次</span>
        </div>

        <div class="dialog-actions sheet-actions">
          <button class="linkbtn danger-text" :disabled="saving || notReady" @click="emit('wipe')">清空所有文件…</button>
          <DialogClose as-child><button class="btn btn-primary">完成</button></DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
