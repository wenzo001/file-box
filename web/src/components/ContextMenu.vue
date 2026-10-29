<script setup>
// 桌面右键菜单与 "⋯" 菜单共用一份条目：两条入口的业务能力必须一致。
// 位置在渲染后按真实尺寸夹紧 —— 之前用估宽 236/估高 32 硬算，长标签会把菜单顶出屏幕右边。
import { nextTick, ref, watch } from 'vue';

const props = defineProps({
  pos: { type: Object, required: true },   // { x, y }
  items: { type: Array, required: true },
});
const emit = defineEmits(['run']);

const el = ref(null);
const placed = ref({ left: props.pos.x, top: props.pos.y });

async function clamp() {
  await nextTick();
  const box = el.value?.getBoundingClientRect();
  if (!box) return;
  const pad = 8;
  const left = Math.max(pad, Math.min(props.pos.x, window.innerWidth - box.width - pad));
  let top = Math.max(pad, Math.min(props.pos.y, window.innerHeight - box.height - pad));
  // 上方空间不够且整块装得下时，翻到触发点上面
  if (top + box.height > window.innerHeight - pad && props.pos.y - box.height > pad) {
    top = props.pos.y - box.height;
  }
  placed.value = { left, top };
  // 焦点给第一条可用项：菜单是键盘用户唯一的操作入口
  el.value?.querySelector('.menu-item:not(:disabled)')?.focus();
}

watch(() => [props.pos.x, props.pos.y, props.items], clamp, { immediate: true, flush: 'post' });
</script>

<template>
  <div ref="el" class="context-menu" role="menu" :style="{ left: `${placed.left}px`, top: `${placed.top}px` }" @click.stop>
    <template v-for="(item, i) in items" :key="i">
      <div v-if="item.sep" class="menu-sep" role="separator"></div>
      <button
        v-else
        class="menu-item"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        role="menuitem"
        @click.stop="emit('run', item)"
      >
        <component :is="item.icon" v-if="item.icon" :size="15" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </template>
  </div>
</template>
