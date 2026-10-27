// 目录 / 批次 / 文件操作的请求校验与名称规则。
// 这里只做纯校验，不碰 NeDB 和磁盘，便于服务端和测试共用。
const { z } = require('zod');

const TTL_HOURS = Object.freeze([1, 4, 8, 48, 72, 120, 240, 2160]);
const FOLDER_ID_RE = /^f_[a-f0-9]{12}$/;
const BATCH_NAME_RE = /^\d{8}_\d{4}(_\d+)?$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const NAME_ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const NAME_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const NAME_MAX_CHARS = 20;
const RESERVED_NAMES = new Set(['未分档', '全部文件']);

function normalizeFolderName(name) {
  return String(name).normalize('NFC');
}

function nameKeyOf(name) {
  return normalizeFolderName(name).toLowerCase();
}

/** 能落库返回 null，不能返回给用户看的原因 */
function folderNameProblem(raw) {
  if (typeof raw !== 'string') return '目录名必须是字符串';
  const name = normalizeFolderName(raw);
  if (!name || name !== name.trim()) return '目录名不能为空或首尾带空白';
  if (NAME_ILLEGAL.test(name)) return '目录名含非法字符';
  if (name === '.' || name === '..') return '目录名不能是 . 或 ..';
  if (NAME_DEVICE.test(name)) return '目录名是系统保留名';
  if (Array.from(name).length > NAME_MAX_CHARS) return `目录名最多 ${NAME_MAX_CHARS} 个字`;
  if (RESERVED_NAMES.has(name)) return '目录名是系统保留名';
  return null;
}

const folderId = z.string().regex(FOLDER_ID_RE, '目录标识不合法');
const folderIdOrNull = folderId.nullable();
const folderIdOrUnfiled = z.union([folderId, z.literal('__unfiled__')]).nullable();
const batchName = z.string().regex(BATCH_NAME_RE, '批次名不合法');
const hashHex = z.string().regex(HASH_RE, '清单摘要不合法');

const folderName = z.string().superRefine((value, ctx) => {
  const problem = folderNameProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
}).transform((value) => normalizeFolderName(value));

const ttlHours = z.number().int().refine((value) => TTL_HOURS.includes(value), '自动删除时长不合法');

const schemas = Object.freeze({
  uploadInit: z.object({
    key: z.string().regex(/^[a-f0-9]{16,64}$/, '批次标识不合法'),
    files: z.array(z.unknown()).min(1, '至少要有一个文件'),
    folderId: z.union([folderId, z.literal('__unfiled__')]).nullish(),
    ttlHours: ttlHours.nullish(),
  }).passthrough(),

  folderCreate: z.object({
    name: folderName,
    parentId: folderId.nullish(),
  }),

  folderPatch: z.object({
    name: folderName.optional(),
    parentId: folderIdOrUnfiled.optional(),
  }).refine(
    (value) => (value.name !== undefined) !== (value.parentId !== undefined),
    '一次只能改名称或位置',
  ),

  batchMove: z.object({
    folderId: folderIdOrUnfiled,
  }),

  batchBulkMove: z.object({
    names: z.array(batchName).min(1, '至少要选一个批次').max(500, '一次最多移动 500 个批次'),
    folderId: folderIdOrUnfiled,
  }),

  fileDelete: z.object({
    file: z.string().min(1).max(200),
    manifest: z.string().min(1).max(2_000_000).nullish(),
    expectedManifestHash: hashHex.nullish(),
  }),

  fileRename: z.object({
    file: z.string().min(1).max(200),
    manifest: z.string().min(1).max(2_000_000),
    expectedManifestHash: hashHex,
  }),

  settingsPatch: z.object({
    defaultTtlHours: ttlHours,
  }),
});

module.exports = {
  TTL_HOURS,
  NAME_MAX_CHARS,
  FOLDER_ID_RE,
  BATCH_NAME_RE,
  HASH_RE,
  folderId,
  folderIdOrNull,
  folderIdOrUnfiled,
  batchName,
  hashHex,
  folderName,
  ttlHours,
  schemas,
  normalizeFolderName,
  nameKeyOf,
  folderNameProblem,
};
