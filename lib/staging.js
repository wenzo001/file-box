// 收尾搬运：把暂存目录搬进 uploads。
// 同一个盘上 rename 一步到位；暂存区与 uploads 被配到两个盘时 rename 会抛 EXDEV
// （系统盘小、把 UPLOAD_DIR 指到大盘是最常见的部署方式），退化为 复制 + 删源。
const fs = require('fs');

function moveDirAcrossDevices(from, to, fsx = fs) {
  fsx.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  try {
    fsx.rmSync(from, { recursive: true, force: true });
  } catch (err) {
    // 源还在就可能被同一个批次再收尾一次（留下两个内容相同的批次目录）：撤掉目标，让这次按失败处理
    try { fsx.rmSync(to, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    throw err;
  }
}

/**
 * @param {string} stagingDir 暂存目录（.uploading/<id>）
 * @param {{nextBatchDir: () => {name: string, target: string}, fsx?: object, attempts?: number}} opts
 * @returns {string} 批次名
 */
function commitStaging(stagingDir, opts = {}) {
  const { nextBatchDir, fsx = fs, attempts = 5 } = opts;
  if (typeof nextBatchDir !== 'function') throw new Error('commitStaging 需要 nextBatchDir');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { name, target } = nextBatchDir();
    try {
      fsx.renameSync(stagingDir, target);
      return name;
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'EPERM') continue; // 并发抢了同名目录 / 被占用：换下一个
      if (err.code === 'EXDEV') {
        // cpSync 对已存在的目录是"合并"而不是报错（errorOnExist 只管文件），
        // 撞名时必须自己挡：否则两批的文件会混进同一个批次目录
        if (fsx.existsSync(target)) continue;
        try {
          moveDirAcrossDevices(stagingDir, target, fsx);
          return name;
        } catch (e) {
          if (e.code === 'EEXIST') continue;
          throw e;
        }
      }
      throw err;
    }
  }
  throw new Error('同一分钟内上传批次过多，请稍后重试');
}

module.exports = { commitStaging, moveDirAcrossDevices };
