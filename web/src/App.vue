<script setup>
import { ref } from 'vue';
import { FolderPlus } from '@lucide/vue';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from 'reka-ui';

const open = ref(false);
const oldHref = import.meta.env.DEV ? 'http://localhost:3000/' : '../';
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <h1 class="brand">文件盒子</h1>
      <a class="link" :href="oldHref">回到旧版</a>
    </header>

    <section class="card">
      <h2>新文件界面</h2>
      <p>Vue 3 + Vite + Reka UI 脚手架已接通。目录、任务中心与上传下载会在后续提交里逐步接入；当前默认页面仍是旧版。</p>
      <div class="row">
        <DialogRoot v-model:open="open">
          <DialogTrigger as-child>
            <button class="btn btn-primary" type="button">
              <FolderPlus :size="18" aria-hidden="true" />
              新建文件夹
            </button>
          </DialogTrigger>
          <DialogPortal>
            <DialogOverlay class="dialog-overlay" />
            <DialogContent class="dialog">
              <DialogTitle as-child>
                <h3>新建文件夹</h3>
              </DialogTitle>
              <DialogDescription as-child>
                <p>这里是 Reka UI 的无头对话框。输入框与真实建目录会在目录 API 接好后接入。</p>
              </DialogDescription>
              <DialogClose as-child>
                <button class="btn" type="button">知道了</button>
              </DialogClose>
            </DialogContent>
          </DialogPortal>
        </DialogRoot>
      </div>
    </section>
  </main>
</template>
