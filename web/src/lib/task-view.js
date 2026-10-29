import { fmtSize } from './format.js';
import { tierLabel } from './capability.mjs';

// 任务行的读数：把"状态怎么措辞、进度怎么算、那一行小字说什么"从界面里拿出来，
// 桌面面板与手机抽屉共用一份，也方便单证。

export function stateText(task) {
  // 下载分三段：拉密文（可续）、解密（写本地）、交给浏览器保存——三段都要说清在哪
  if (task.kind === 'download' && task.state === 'running') {
    if (task.phase === 'decrypt') return '解密中';
    if (task.phase === 'save') return '保存中';
    if (task.phase === 'waiting') return '重连中';
  }
  return {
    queued: '排队', running: '进行中', finishing: '正在合并', paused: '已暂停',
    failed: '失败', done: '已完成', canceled: '已取消',
  }[task.state] || task.state;
}

export function taskPct(task) {
  if (task.state === 'done') return 100;
  if (task.kind === 'upload') return task.total ? Math.round((task.done / task.total) * 100) : 0;
  if (task.kind === 'folder-delete') return task.items?.length ? Math.round((task.index / task.items.length) * 100) : 0;
  return task.total ? Math.round((task.received / task.total) * 100) : 0;
}

export function taskMeta(task) {
  if (task.kind === 'download' && task.note) return `${fmtSize(task.received || 0)} / ${fmtSize(task.total || 0)} · ${task.note}`;
  if (task.kind === 'upload') return `${task.done || 0}/${task.total || 0} 块 · ${fmtSize(task.doneBytes || 0)}${task.note ? ` · ${task.note}` : ''}`;
  if (task.kind === 'folder-delete') return `已完成 ${task.index || 0}/${task.items?.length || 0} 项`;
  if (task.kind === 'zip') return `${fmtSize(task.received || 0)} / ${fmtSize(task.total || 0)} · ${task.files || 0} 个文件${task.tier ? ` · ${tierLabel(task.tier)}` : ''}`;
  return `${fmtSize(task.received || 0)} / ${fmtSize(task.total || 0)}`;
}

/** 这一颗键该不该画"暂停"：只有真的在跑才给 */
export function canPause(task) { return task.state === 'running'; }
/** 继续：已暂停与失败都能重试；完成/取消不行 */
export function canResume(task) { return ['paused', 'failed'].includes(task.state); }
export function canCancel(task) { return !['done', 'canceled'].includes(task.state); }
export function isSettled(task) { return ['done', 'canceled'].includes(task.state); }
