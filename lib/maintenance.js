// 一键清空：只做编排，不碰磁盘也不认识 NeDB。
// 删除动作全部复用 server.js 里已有的那条路径（名字闸门、逐批清下载账本、失效占用缓存），
// 这里负责三件事：先校验确认词再动手、按轮次重扫以吃掉"收尾正好落地"的竞态、清不干净就报错而不是说"已清空"。
const WIPE_CONFIRM = '清空全部文件';

function wipeError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * @param {object} deps
 * @param {() => Promise<Array<{name:string,count:number,size:number}>>} deps.listBatches 扫盘列出批次
 * @param {(name:string) => Promise<void>} deps.dropBatch 删一个批次（含索引与账本）
 * @param {() => Promise<{batches:number,bytes:number}>} deps.clearStaging 取消并清空未完成上传
 * @param {() => Promise<{sessions:number,bytes:number}>} deps.purgeTransfer 清空无痕传输入口中转区
 * @param {() => number} deps.downloadTotal 历史累计下载数（只增不减）
 * @param {number} [deps.passes] 最多重扫几轮
 */
function createMaintenance(deps = {}) {
  const {
    listBatches, dropBatch, clearStaging, purgeTransfer, downloadTotal,
    passes = 3,
  } = deps;
  for (const [name, fn] of Object.entries({ listBatches, dropBatch, clearStaging, purgeTransfer })) {
    if (typeof fn !== 'function') throw new Error(`createMaintenance 缺少依赖：${name}`);
  }

  async function wipe(input = {}) {
    // 先校验再动手：确认词不对时一个回调都不许被调用
    if ((input || {}).confirm !== WIPE_CONFIRM) {
      throw wipeError(400, 'WIPE_CONFIRM', `确认词不对：请输入「${WIPE_CONFIRM}」`);
    }
    // 暂存先清：那里可能有正在合并的上传，收尾一旦在扫描之后落地就会漏
    const staging = await clearStaging();

    let batches = 0;
    let files = 0;
    let bytes = 0;
    let rounds = 0;
    let left = await listBatches();
    for (; rounds < passes && left.length; rounds++) {
      for (const b of left) {
        await dropBatch(b.name);
        batches += 1;
        files += Number(b.count) || 0;
        bytes += Number(b.size) || 0;
      }
      left = await listBatches();
    }

    const transfer = await purgeTransfer();

    if (left.length) {
      throw wipeError(409, 'WIPE_INCOMPLETE',
        `清空后仍有 ${left.length} 个批次冒出来：${left.slice(0, 5).map((b) => b.name).join(', ')}`,
        { remaining: left.map((b) => b.name) });
    }

    return {
      removed: { batches, files, bytes, staging, transfer, rounds },
      kept: { downloadTotal: typeof downloadTotal === 'function' ? downloadTotal() : 0 },
      verified: { uploadsEmpty: true },
    };
  }

  return { wipe };
}

module.exports = { createMaintenance, WIPE_CONFIRM };
