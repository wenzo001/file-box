#!/usr/bin/env node
// 一条命令准备前后端：Node 版本检查 → 安装根目录依赖 → 构建 dist-web。
// --pack 继续生成自包含发布包。目标机不需要本脚本：发布包已包含 dist-web 与生产依赖。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const packAfter = args.has('--pack');

function run(cmd, cmdArgs, opts = {}) {
  console.log(`[setup] $ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', env: process.env, ...opts });
  if (r.error) {
    console.error('[setup] 启动命令失败:', r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[setup] 命令失败（退出码 ${r.status}）`);
    process.exit(r.status || 1);
  }
}

function npm(cmdArgs) {
  // 通过 npm run 进入时，npm_execpath 指向 npm-cli.js，用当前 node 跑最稳；
  // 直接 node scripts/setup.js 时回退到系统 npm。
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...cmdArgs]);
  const isWin = process.platform === 'win32';
  return run(isWin ? 'npm.cmd' : 'npm', cmdArgs, { shell: isWin });
}

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(major) || major < 18) {
  console.error(`[setup] 需要 Node.js ≥ 18，当前 ${process.version}`);
  process.exit(1);
}
console.log(`[setup] Node ${process.version}，目录 ${ROOT}`);

const hasLock = fs.existsSync(path.join(ROOT, 'package-lock.json'));
npm([hasLock ? 'ci' : 'install', '--no-audit', '--no-fund']);
npm(['run', 'build']);

if (packAfter) {
  run(process.execPath, [path.join('scripts', 'pack.js')]);
}

console.log('[setup] 完成。');
console.log('[setup] 启动：npm start            （Express 同时托管 /api 与 dist-web）');
console.log('[setup] 开发：npm run dev:server   （另开终端 npm run dev）');
if (packAfter) console.log('[setup] 发布包在 dist/ 下，目标机解压即可运行，不需要 npm install / build。');
