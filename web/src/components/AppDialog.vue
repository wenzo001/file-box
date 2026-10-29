<script setup>
// 新建 / 重命名 / 移动 / 确认删除：一个弹层四种模式，两端共用。
// 手机档由 CSS 变成底部抽屉；这里的结构不随断点变，变的只是壳。
import { computed } from 'vue';
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';

const props = defineProps({
  open: { type: Boolean, default: false },
  dialog: { type: Object, required: true },
  moveOptions: { type: Array, default: () => [] },
  limit: { type: Number, required: true },
  nameMax: { type: Number, required: true },
});
const emit = defineEmits(['update:open', 'submit', 'update:value', 'enter']);

const value = computed({
  get: () => props.dialog.value,
  set: (v) => emit('update:value', v),
});
const charCount = computed(() => Array.from(String(props.dialog.value || '')).length);
const placeholder = computed(() =>
  props.dialog.kind === 'rename-file' ? '新文件名' : `名称（最多 ${props.nameMax} 个字）`,
);
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="dialog" :class="{ 'is-destructive': dialog.destructive }" @keydown.enter="emit('enter', $event)">
        <DialogTitle as-child><h3>{{ dialog.title }}</h3></DialogTitle>
        <DialogDescription as-child><p v-if="dialog.message">{{ dialog.message }}</p></DialogDescription>

        <input
          v-if="dialog.mode === 'prompt'"
          v-model="value"
          class="input"
          :maxlength="limit"
          :placeholder="placeholder"
          enterkeyhint="done"
          autocomplete="off"
        >
        <div v-if="dialog.mode === 'prompt' && dialog.kind !== 'rename-file'" class="char-count" :class="{ over: charCount > nameMax }">
          {{ charCount }}/{{ nameMax }}
        </div>

        <select v-if="dialog.mode === 'move'" v-model="value" class="input" aria-label="目标目录">
          <option v-for="opt in moveOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>

        <div v-if="dialog.error" class="dialog-error" role="alert">{{ dialog.error }}</div>

        <div class="dialog-actions">
          <DialogClose as-child><button class="btn">取消</button></DialogClose>
          <button
            class="btn dialog-primary"
            :class="dialog.destructive ? 'btn-danger' : 'btn-primary'"
            :disabled="dialog.busy"
            @click="emit('submit')"
          >{{ dialog.busy ? '处理中…' : dialog.confirmText }}</button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
