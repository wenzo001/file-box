<script setup>
// 手机的操作表：替代桌面右键菜单，承载同一批业务动作。
// 用 DialogRoot 而不是自绘，焦点陷阱 / Escape / 遮罩关闭都白拿。
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';

defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  items: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:open', 'run']);
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="dialog sheet" aria-label="操作">
        <span class="grab" aria-hidden="true"></span>
        <DialogTitle as-child><h3>{{ title }}</h3></DialogTitle>
        <DialogDescription as-child><p v-if="subtitle" class="sheet-legend">{{ subtitle }}</p></DialogDescription>
        <div class="sheet-list" role="menu">
          <button
            v-for="(item, i) in items"
            :key="i"
            class="sheet-item"
            :class="{ danger: item.danger }"
            :disabled="item.disabled"
            role="menuitem"
            @click="emit('run', item); emit('update:open', false)"
          >
            <component :is="item.icon" v-if="item.icon" :size="18" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </button>
        </div>
        <div class="dialog-actions">
          <DialogClose as-child><button class="btn">取消</button></DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
