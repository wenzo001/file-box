// 目录索引：NeDB 嵌入式存储。只管理目录树 / 批次归属 / TTL / 清单哈希，
// 物理目录、下载账本和路径闸门仍由 server.js 负责。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Datastore = require('@seald-io/nedb');
const {
  BATCH_NAME_RE,
  FOLDER_ID_RE,
  folderNameProblem,
  nameKeyOf,
  normalizeFolderName,
  TTL_HOURS,
} = require('./schemas');

const MAX_DEPTH = 8;
const MAX_FOLDER_ID_TRIES = 8;
const BACKUP_SUFFIX = '.bak';

class LibraryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status = 400) => {
  throw new LibraryError(code, message, status);
};

const isUniqueError = (err) => Boolean(err) && (
  err.errorType === 'uniqueViolated' ||
  /unique/i.test(String(err.message || ''))
);

const load = (store) => new Promise((resolve, reject) => {
  store.loadDatabase((err) => (err ? reject(err) : resolve()));
});
const insert = (store, doc) => new Promise((resolve, reject) => {
  store.insert(doc, (err, saved) => (err ? reject(err) : resolve(saved)));
});
const find = (store, query) => new Promise((resolve, reject) => {
  store.find(query, (err, docs) => (err ? reject(err) : resolve(docs)));
});
const findOne = (store, query) => new Promise((resolve, reject) => {
  store.findOne(query, (err, doc) => (err ? reject(err) : resolve(doc)));
});
const update = (store, query, upd, options = {}) => new Promise((resolve, reject) => {
  store.update(query, upd, options, (err, numAffected, affectedDocuments, upsert) => (
    err ? reject(err) : resolve({ numAffected, affectedDocuments, upsert })
  ));
});
const remove = (store, query, options = {}) => new Promise((resolve, reject) => {
  store.remove(query, options, (err, numRemoved) => (err ? reject(err) : resolve(numRemoved)));
});
const ensureIndex = (store, options) => new Promise((resolve, reject) => {
  store.ensureIndex(options, (err) => (err ? reject(err) : resolve()));
});
const compact = (store) => new Promise((resolve) => {
  if (typeof store.compactDatafile !== 'function') return resolve();
  store.compactDatafile(() => resolve());
});

function newFolderId() {
  return `f_${crypto.randomBytes(6).toString('hex')}`;
}

function assertFolderId(id) {
  if (!FOLDER_ID_RE.test(String(id || ''))) fail('INVALID_FOLDER', '目录标识不合法', 400);
}

/**
 * @param {object} options
 * @param {string} options.libraryDir
 * @param {number} [options.backupDelayMs]
 * @param {() => number} [options.now]
 * @param {{info?:Function, warn?:Function, error?:Function}} [options.log]
 */
function createLibrary(options = {}) {
  const libraryDir = path.resolve(options.libraryDir || path.join(process.cwd(), '.library'));
  const backupDelayMs = Number.isFinite(options.backupDelayMs) ? options.backupDelayMs : 2000;
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const log = options.log || console;

  const foldersPath = path.join(libraryDir, 'folders.db');
  const batchesPath = path.join(libraryDir, 'batches.db');

  let folders = null;
  let batches = null;
  let backupTimer = null;
  let closed = false;
  let tail = Promise.resolve();

  const mutate = (fn) => {
    const run = tail.then(() => fn());
    tail = run.then(() => {}, () => {});
    return run;
  };

  const copyBackup = () => {
    for (const file of [foldersPath, batchesPath]) {
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, file + BACKUP_SUFFIX);
      } catch (err) {
        log.warn?.(`[目录索引] 备份失败 ${path.basename(file)}: ${err.message}`);
      }
    }
  };

  const scheduleBackup = () => {
    if (backupTimer || closed) return;
    backupTimer = setTimeout(() => {
      backupTimer = null;
      mutate(copyBackup).catch((err) => log.warn?.(`[目录索引] 备份失败: ${err.message}`));
    }, backupDelayMs);
    if (backupTimer.unref) backupTimer.unref();
  };

  const flushBackup = async () => {
    if (backupTimer) {
      clearTimeout(backupTimer);
      backupTimer = null;
    }
    await mutate(copyBackup);
  };

  const moveCorrupt = (file) => {
    const dst = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, dst);
      log.error?.(`[目录索引] ${path.basename(file)} 无法读取，已改名为 ${path.basename(dst)}`);
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* 让下面的空库启动兜底 */ }
    }
  };

  async function openStore(name) {
    fs.mkdirSync(libraryDir, { recursive: true });
    const file = path.join(libraryDir, `${name}.db`);
    const bak = file + BACKUP_SUFFIX;
    const tryOpen = async () => {
      const store = new Datastore({ filename: file, autoload: false });
      await load(store);
      return store;
    };

    if (fs.existsSync(file)) {
      try {
        return await tryOpen();
      } catch (err) {
        log.error?.(`[目录索引] ${name}.db 读取失败: ${err.message}`);
        moveCorrupt(file);
      }
    }
    if (fs.existsSync(bak)) {
      try {
        fs.copyFileSync(bak, file);
        log.warn?.(`[目录索引] 已从 ${name}.db.bak 恢复`);
        return await tryOpen();
      } catch (err) {
        log.error?.(`[目录索引] ${name}.db.bak 恢复失败: ${err.message}`);
        moveCorrupt(file);
      }
    }
    // 主文件和备份都不可用：从空库启动，文件仍在未分档
    return tryOpen();
  }

  async function ensureIndexes() {
    await ensureIndex(folders, { fieldName: 'parentId' });
    await ensureIndex(folders, { fieldName: 'nameKey' });
    try {
      await ensureIndex(folders, { fieldName: 'parentKey', unique: true });
    } catch (err) {
      // 历史数据若已有重名，不让启动失败；应用层仍在互斥队列里做同名检查
      log.warn?.(`[目录索引] parentKey 唯一索引未建立: ${err.message}`);
    }
    await ensureIndex(batches, { fieldName: 'folderId' });
    await ensureIndex(batches, { fieldName: 'expiresAt' });
  }

  async function allFolders() {
    return find(folders, {});
  }

  async function allBatches() {
    return find(batches, {});
  }

  function folderMap(list) {
    return new Map(list.map((f) => [f._id, f]));
  }

  async function getFolder(id) {
    if (!FOLDER_ID_RE.test(String(id || ''))) return null;
    return findOne(folders, { _id: id });
  }

  async function getBatch(name) {
    if (!BATCH_NAME_RE.test(String(name || ''))) return null;
    return findOne(batches, { _id: name });
  }

  async function requireFolder(id) {
    const doc = await getFolder(id);
    if (!doc) fail('FOLDER_NOT_FOUND', '目录不存在', 404);
    return doc;
  }

  async function depthOf(id, map = null) {
    const all = map || folderMap(await allFolders());
    let depth = 0;
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      const doc = all.get(cur);
      if (!doc) break;
      seen.add(cur);
      depth++;
      cur = doc.parentId || null;
    }
    return depth;
  }

  async function subtreeHeight(id, map = null) {
    const all = map || folderMap(await allFolders());
    let max = 0;
    const walk = (fid, level) => {
      max = Math.max(max, level);
      for (const f of all.values()) {
        if (f.parentId === fid) walk(f._id, level + 1);
      }
    };
    walk(id, 1);
    return max;
  }

  async function isDescendant(candidateId, ancestorId, map = null) {
    if (!candidateId) return false;
    if (candidateId === ancestorId) return true;
    const all = map || folderMap(await allFolders());
    let cur = candidateId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (cur === ancestorId) return true;
      const doc = all.get(cur);
      cur = doc ? (doc.parentId || null) : null;
    }
    return false;
  }

  async function parentForCreate(parentId) {
    if (parentId === '__unfiled__') fail('UNFILED_IMMUTABLE', '未分档不能新建子目录', 400);
    const pid = parentId === undefined || parentId === null || parentId === '' ? null : parentId;
    if (pid === null) return null;
    assertFolderId(pid);
    const parent = await getFolder(pid);
    if (!parent) fail('FOLDER_NOT_FOUND', '目录不存在', 404);
    return pid;
  }

  async function folderForBatch(folderId) {
    if (folderId === undefined || folderId === null || folderId === '' || folderId === '__unfiled__') return null;
    assertFolderId(folderId);
    const doc = await getFolder(folderId);
    if (!doc) fail('FOLDER_NOT_FOUND', '目录不存在', 404);
    return folderId;
  }

  async function repair() {
    const list = await allFolders();
    const map = folderMap(list);
    let changed = false;

    for (const doc of list) {
      if (!doc.parentId) continue;
      let missing = !map.has(doc.parentId);
      let cycle = false;
      if (!missing) {
        const seen = new Set([doc._id]);
        let cur = doc.parentId;
        while (cur) {
          if (seen.has(cur)) { cycle = true; break; }
          seen.add(cur);
          const parent = map.get(cur);
          if (!parent) { missing = true; break; }
          cur = parent.parentId || null;
        }
      }
      if (missing || cycle) {
        await update(folders, { _id: doc._id }, { $set: { parentId: null, parentKey: `\n${doc.nameKey || nameKeyOf(doc.name)}`, updatedAt: nowFn() } });
        log.warn?.(`[目录索引] 目录 ${doc.name} 的父级无效，已挂回根`);
        changed = true;
      }
    }

    const batchList = await allBatches();
    const validFolders = folderMap(await allFolders());
    for (const doc of batchList) {
      if (doc.folderId && !validFolders.has(doc.folderId)) {
        await update(batches, { _id: doc._id }, { $set: { folderId: null, legacy: true } });
        log.warn?.(`[目录索引] 批次 ${doc._id} 的目录已不存在，已归入未分档`);
        changed = true;
      }
    }
    if (changed) scheduleBackup();
  }

  async function init() {
    folders = await openStore('folders');
    batches = await openStore('batches');
    await ensureIndexes();
    await repair();
    return api;
  }

  async function createFolder(input = {}) {
    return mutate(async () => {
      const problem = folderNameProblem(input.name);
      if (problem) fail('INVALID_NAME', problem, 400);
      const name = normalizeFolderName(input.name);
      const parentId = await parentForCreate(input.parentId);
      if (parentId) {
        const depth = await depthOf(parentId);
        if (depth + 1 > MAX_DEPTH) fail('DEPTH_LIMIT', `目录层级最多 ${MAX_DEPTH} 层`, 400);
      }
      const nameKey = nameKeyOf(name);
      const parentKey = `${parentId || ''}\n${nameKey}`;
      if (await findOne(folders, { parentKey })) fail('DUPLICATE_NAME', '同一目录下已有同名文件夹', 409);

      let id = null;
      for (let i = 0; i < MAX_FOLDER_ID_TRIES; i++) {
        const candidate = newFolderId();
        if (!(await findOne(folders, { _id: candidate }))) { id = candidate; break; }
      }
      if (!id) fail('FOLDER_ID_EXHAUSTED', '目录标识生成失败，请重试', 500);

      const now = nowFn();
      const doc = { _id: id, parentId, name, nameKey, parentKey, createdAt: now, updatedAt: now };
      try {
        await insert(folders, doc);
      } catch (err) {
        if (isUniqueError(err)) fail('DUPLICATE_NAME', '同一目录下已有同名文件夹', 409);
        throw err;
      }
      scheduleBackup();
      return doc;
    });
  }

  async function renameFolder(id, input = {}) {
    return mutate(async () => {
      const doc = await requireFolder(id);
      const problem = folderNameProblem(input.name);
      if (problem) fail('INVALID_NAME', problem, 400);
      const name = normalizeFolderName(input.name);
      const nameKey = nameKeyOf(name);
      const parentKey = `${doc.parentId || ''}\n${nameKey}`;
      const dup = await findOne(folders, { parentKey, _id: { $ne: id } });
      if (dup) fail('DUPLICATE_NAME', '同一目录下已有同名文件夹', 409);
      const change = { name, nameKey, parentKey, updatedAt: nowFn() };
      try {
        await update(folders, { _id: id }, { $set: change });
      } catch (err) {
        if (isUniqueError(err)) fail('DUPLICATE_NAME', '同一目录下已有同名文件夹', 409);
        throw err;
      }
      scheduleBackup();
      return { ...doc, ...change };
    });
  }

  async function moveFolder(id, input = {}) {
    return mutate(async () => {
      const doc = await requireFolder(id);
      if (input.parentId === '__unfiled__') fail('UNFILED_IMMUTABLE', '不能把目录移入未分档', 400);
      const parentId = input.parentId === undefined ? doc.parentId || null : (input.parentId || null);
      const map = folderMap(await allFolders());

      if (parentId === id) fail('CYCLE', '不能把目录移动到自身', 400);
      if (parentId && await isDescendant(parentId, id, map)) {
        fail('CYCLE', '不能把目录移动到自己的子目录', 400);
      }

      const parentDepth = parentId ? await depthOf(parentId, map) : 0;
      const height = await subtreeHeight(id, map);
      if (parentDepth + height > MAX_DEPTH) {
        fail('DEPTH_LIMIT', `目录层级最多 ${MAX_DEPTH} 层`, 400);
      }

      const nameKey = doc.nameKey || nameKeyOf(doc.name);
      const parentKey = `${parentId || ''}\n${nameKey}`;
      const dup = await findOne(folders, { parentKey, _id: { $ne: id } });
      if (dup) fail('DUPLICATE_NAME', '目标目录下已有同名文件夹', 409);

      const change = { parentId, parentKey, updatedAt: nowFn() };
      try {
        await update(folders, { _id: id }, { $set: change });
      } catch (err) {
        if (isUniqueError(err)) fail('DUPLICATE_NAME', '目标目录下已有同名文件夹', 409);
        throw err;
      }
      scheduleBackup();
      return { ...doc, ...change };
    });
  }

  async function folderPath(id) {
    const map = folderMap(await allFolders());
    const out = [];
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const doc = map.get(cur);
      if (!doc) break;
      out.unshift(doc);
      cur = doc.parentId || null;
    }
    return out;
  }

  async function folderSubtree(id) {
    await requireFolder(id);
    const map = folderMap(await allFolders());
    const folderIds = [];
    const stack = [id];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      folderIds.push(cur);
      for (const f of map.values()) {
        if (f.parentId === cur) stack.push(f._id);
      }
    }
    const batchDocs = await find(batches, { folderId: { $in: folderIds } });
    return { folderIds, batches: batchDocs.map((b) => b._id) };
  }

  async function deleteEmptyFolder(id) {
    return mutate(async () => {
      await requireFolder(id);
      if (await findOne(folders, { parentId: id })) fail('FOLDER_NOT_EMPTY', '目录里还有子目录', 409);
      if (await findOne(batches, { folderId: id })) fail('FOLDER_NOT_EMPTY', '目录里还有文件', 409);
      await remove(folders, { _id: id });
      scheduleBackup();
      return { ok: true };
    });
  }

  async function deleteFolders(ids) {
    const list = [...new Set((ids || []).filter((id) => FOLDER_ID_RE.test(String(id || ''))))];
    if (!list.length) return { deleted: 0 };
    return mutate(async () => {
      const deleted = await remove(folders, { _id: { $in: list } });
      scheduleBackup();
      return { deleted };
    });
  }

  async function setBatch(name, fields = {}) {
    if (!BATCH_NAME_RE.test(String(name || ''))) fail('INVALID_BATCH', '批次名不合法', 400);
    return mutate(async () => {
      const folderId = await folderForBatch(fields.folderId);
      const now = nowFn();
      const set = {
        folderId,
        uploadedAt: Number.isFinite(fields.uploadedAt) ? fields.uploadedAt : now,
        ttlHours: Number.isFinite(fields.ttlHours) ? fields.ttlHours : null,
        legacy: Boolean(fields.legacy),
      };
      if (fields.manifestHash) set.manifestHash = fields.manifestHash;
      const hasExpiry = Number.isFinite(fields.expiresAt);
      if (hasExpiry) set.expiresAt = fields.expiresAt;
      const existing = await findOne(batches, { _id: name });
      if (existing) {
        const upd = { $set: set };
        if (!hasExpiry) upd.$unset = { expiresAt: true };
        await update(batches, { _id: name }, upd);
      } else {
        await insert(batches, { _id: name, ...set });
      }
      scheduleBackup();
      return findOne(batches, { _id: name });
    });
  }

  async function setBatchHash(name, hash) {
    if (!BATCH_NAME_RE.test(String(name || ''))) fail('INVALID_BATCH', '批次名不合法', 400);
    return mutate(async () => {
      const existing = await findOne(batches, { _id: name });
      if (existing) {
        await update(batches, { _id: name }, { $set: { manifestHash: hash } });
      } else {
        await insert(batches, {
          _id: name, folderId: null, uploadedAt: null, ttlHours: null, legacy: true, manifestHash: hash,
        });
      }
      scheduleBackup();
    });
  }

  async function moveBatches(names, folderIdInput, metaByName = {}) {
    const list = [...new Set((names || []).filter((n) => BATCH_NAME_RE.test(String(n || ''))))];
    if (!list.length) fail('INVALID_BATCH', '至少要选一个批次', 400);
    return mutate(async () => {
      const folderId = await folderForBatch(folderIdInput);
      for (const name of list) {
        const existing = await findOne(batches, { _id: name });
        if (existing) {
          await update(batches, { _id: name }, { $set: { folderId } });
        } else {
          const meta = metaByName[name] || {};
          await insert(batches, {
            _id: name,
            folderId,
            uploadedAt: Number.isFinite(meta.uploadedAt) ? meta.uploadedAt : null,
            ttlHours: null,
            legacy: true,
          });
        }
      }
      scheduleBackup();
      return { moved: list.length, folderId };
    });
  }

  async function removeBatch(name) {
    if (!BATCH_NAME_RE.test(String(name || ''))) return false;
    return mutate(async () => {
      const n = await remove(batches, { _id: name });
      scheduleBackup();
      return n > 0;
    });
  }

  async function listExpired(now = nowFn()) {
    return find(batches, { expiresAt: { $lte: now } });
  }

  async function sweepExpired({ deleteBatch, onDeleted, now = nowFn() } = {}) {
    if (typeof deleteBatch !== 'function') throw new Error('sweepExpired 需要 deleteBatch 回调');
    const expired = await listExpired(now);
    const removed = [];
    for (const doc of expired) {
      try {
        await deleteBatch(doc._id);
        await removeBatch(doc._id);
        removed.push(doc._id);
        onDeleted?.(doc._id);
      } catch (err) {
        log.warn?.(`[目录索引] 到期批次 ${doc._id} 清理失败: ${err.message}`);
      }
    }
    return removed;
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (backupTimer) {
      clearTimeout(backupTimer);
      backupTimer = null;
    }
    await mutate(async () => {
      try { await compact(folders); } catch { /* 压缩失败不影响退出 */ }
      try { await compact(batches); } catch { /* 同上 */ }
      copyBackup();
    });
  }

  const api = {
    init,
    close,
    flushBackup,
    foldersPath,
    batchesPath,
    allFolders,
    allBatches,
    getFolder,
    getBatch,
    requireFolder,
    folderPath,
    folderSubtree,
    depthOf,
    subtreeHeight,
    isDescendant,
    createFolder,
    renameFolder,
    moveFolder,
    deleteEmptyFolder,
    deleteFolders,
    setBatch,
    setBatchHash,
    moveBatches,
    removeBatch,
    listExpired,
    sweepExpired,
    maxDepth: MAX_DEPTH,
    ttlHours: TTL_HOURS,
  };
  return api;
}

module.exports = {
  createLibrary,
  LibraryError,
  MAX_DEPTH,
  TTL_HOURS,
};
