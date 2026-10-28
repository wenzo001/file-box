<script setup>
// 一键清空：从 App.vue 里独立出来的危险操作。确认词由服务端下发（/api/library 的 wipeConfirm），
// 这里只负责"打对了才放行"和把回执交回去；删什么、留什么写成三行给人看清楚。
import { computed, ref, watch } from 'vue';
import {
  DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
} from 'reka-ui';
import { api } from '../lib/api.js';
import { fmtSize } from '../lib/format.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  confirmWord: { type: String, required: true },
  files: { type: Number, default: 0 },
  bytes: { type: Number, default: 0 },
});
const emit = defineEmits(['update:open', 'done']);

const value = ref('');
const error = ref('');
const busy = ref(false);

watch(() => props.open, (v) => {
  if (!v) return;
  value.value = '';
  error.value = '';
  busy.value = false;
});

const message = computed(() => `会删掉 ${props.files} 个文件（${fmtSize(props.bytes)}）、所有未完成的上传与无痕传输的残留密文，不能撤销。`);

async function submit() {
  if (busy.value) return;
  error.value = '';
  const typed = String(value.value || '').trim();
  if (typed !== props.confirmWord) {
    error.value = `确认词不对：请完整输入「${props.confirmWord}」`;
    return;
  }
  busy.value = true;
  try {
    const receipt = await api.wipeLibrary(typed);
    emit('done', receipt);
    emit('update:open', false);
  } catch (err) {
    error.value = err.message || '清空失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="dialog">
        <DialogTitle as-child><h3>清空服务器上的所有文件？</h3></DialogTitle>
        <DialogDescription as-child><p>{{ message }}</p></DialogDescription>
        <ul class="wipe-keep">
          <li>删掉：所有已上传的文件、未传完的暂存分块、无痕传输的中转密文</li>
          <li>保留：文件夹结构、全局自动删除设置、历史累计下载次数</li>
          <li>不动：别的程序放进 uploads/ 的目录（只删本服务自己建的「日期_时间」批次）</li>
        </ul>
        <input v-model="value" class="input" :maxlength="64" :placeholder="confirmWord" @keyup.enter="submit">
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <div class="dialog-actions">
          <DialogClose as-child><button class="btn">取消</button></DialogClose>
          <button class="btn btn-danger" :disabled="busy" @click="submit">{{ busy ? '处理中…' : '清空所有文件' }}</button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
