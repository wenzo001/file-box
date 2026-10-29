// 文件类型 → 图标与配色档。按扩展名派生，未知类型退回通用 File。
// shortcut: 只看扩展名，不看 MIME/文件头；出现"必须按真实内容分类"的需求时换成 lib/magic 探测。
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts']);
const AUDIO = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'aiff', 'opus']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'tiff', 'svg', 'ico', 'avif']);
const TEXT = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'rtf', 'ini', 'conf', 'env', 'json', 'yaml', 'yml', 'xml']);
const DOC = new Set(['doc', 'docx', 'pdf', 'ppt', 'pptx', 'key', 'pages', 'epub']);
const SHEET = new Set(['xls', 'xlsx', 'numbers', 'ods']);
const CODE = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'rb', 'php', 'sh', 'bash', 'sql', 'html', 'css', 'scss', 'less']);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso']);

export function extOf(name) {
  const base = String(name || '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  // 隐藏文件（.env）与无扩展名（Makefile）都按整名判
  const ext = dot > 0 ? base.slice(dot + 1) : base;
  return ext.toLowerCase();
}

/** @returns {{ icon: string, tone: string }} icon 是 @lucide/vue 的导出名，tone 是 .ft-<tone> 配色类 */
export function fileIcon(name) {
  const ext = extOf(name);
  if (VIDEO.has(ext)) return { icon: 'FileVideo', tone: 'video' };
  if (AUDIO.has(ext)) return { icon: 'FileAudio', tone: 'audio' };
  if (IMAGE.has(ext)) return { icon: 'FileImage', tone: 'image' };
  if (ARCHIVE.has(ext)) return { icon: 'FileArchive', tone: 'archive' };
  if (SHEET.has(ext)) return { icon: 'FileSpreadsheet', tone: 'sheet' };
  if (DOC.has(ext)) return { icon: 'FileText', tone: 'doc' };
  if (CODE.has(ext)) return { icon: 'FileCode', tone: 'code' };
  if (TEXT.has(ext)) return { icon: 'FileText', tone: 'text' };
  return { icon: 'File', tone: 'other' };
}
