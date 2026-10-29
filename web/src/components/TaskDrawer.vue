<script setup>
// 手机档的任务中心：底部抽屉。里面装的就是桌面那块面板，只是换了壳 ——
// 两端的任务状态、暂停/继续/取消/重试必须来自同一份实现。
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';

defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['update:open']);
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="dialog sheet task-drawer">
        <span class="grab" aria-hidden="true"></span>
        <DialogTitle as-child><h3>任务中心</h3></DialogTitle>
        <div class="drawer-body">
          <slot />
        </div>
        <div class="dialog-actions">
          <DialogClose as-child><button class="btn btn-primary">完成</button></DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
