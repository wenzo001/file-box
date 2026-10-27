# 部署与发布

本文是生产部署的主文档。目录 / TTL / 任务模型的细节见 [`library.md`](library.md)，无痕传输见 [`transfer.md`](transfer.md)。

## 1 架构：一个 Node 进程同时提供 API 和前端

```text
浏览器
  │  /api/*          → Express（server.js）
  │  /、/assets/*    → express.static(dist-web)
  │  /transfer.html  → dist-web/transfer.html（public/ 静态源复制过来）
  ▼
一个 Node 进程
  ├── uploads/     批次密文
  ├── .library/    NeDB 目录索引（嵌入式，不是独立数据库服务）
  ├── .stats/      下载次数账本
  ├── .uploading/  未完成分块暂存
  └── .transfer/   无痕传输中转
```

- 前端不是单独的 Node/pnpm 项目：没有 `web/package.json`，也没有单独的安装命令。
- 根目录一次 `npm ci` 同时安装后端运行时依赖和前端构建依赖（devDependencies）。
- `npm run build` 生成 `dist-web/`；`npm start` 由 Express 直接托管，不需要另起静态服务器。
- 目标机**不需要** Node 构建工具（Vite）、不需要 `npm install`、不需要数据库服务；发布包已带 `dist-web` 与生产依赖。

## 2 环境要求

| 机器 | 要求 |
|---|---|
| 构建 / 打包机 | Node.js ≥ 18、npm、git（或直接拿源码目录）；需要安装 devDependencies |
| 运行机 | Node.js ≥ 18；可选 pm2；只需要 `dist-web`、`server.js`、`lib/`、生产 `node_modules/` |
| 端口 | 默认 HTTP 3000 / HTTPS 3443；pm2 配置里默认 HTTP 4444 / HTTPS 3443 |
| 磁盘 | `uploads/` + `.library/` + `.stats/` 在应用目录；默认总量上限 10GB；目录数量上限 `MAX_FOLDERS` 默认 10000 |

## 3 一套脚本：安装、构建、发布

```bash
npm run setup      # Node 检查 + npm ci（无锁文件则 npm install）+ npm run build
npm start          # Express 托管 /api + dist-web
npm run release    # setup 的安装/构建 + 生成 dist/file-box-<version>.tar.gz
```

| 命令 | 做什么 |
|---|---|
| `npm run setup` | 一次装好前后端依赖并构建 `dist-web/`；首次部署/依赖变化后用 |
| `npm start` | 单进程启动 API + 前端；需要先 setup/build |
| `npm run build` | 只重新构建 `dist-web/`（依赖已装好） |
| `npm run pack` | `build` + 出发布包（依赖已装好） |
| `npm run release` | `npm ci` + `build` + 出发布包；一条命令完成发布 |
| `npm run dev:server` | 只启动 API（开发时配合 Vite） |
| `npm run dev` | Vite 开发服务器（5173，`/api` 与静态源代理到 3000） |
| `npm test` | 先 build，再串行跑全量测试（`--test-concurrency=1`） |

> 只有构建/打包机需要 `npm ci` 和 devDependencies。**运行机不要执行 `npm install` / `npm run build`**：发布包里已经有 `dist-web` 和生产依赖。

## 4 构建/打包机

```bash
git clone <repo> /opt/file-box-src
cd /opt/file-box-src
npm run release
```

产物：

```text
dist/file-box-<version>.tar.gz    # 自包含发布包
dist/file-box/                    # 同内容的目录，可直接跑
```

包里包含：

- `server.js`、`lib/`、`docs/`、`README.md`、`package.json`、`package-lock.json`、`ecosystem.config.js`
- `dist-web/`：Vue 构建产物 + 从 `public/` 复制来的 `crypto.js` / `dec-worker.js` / `transfer.html` / `xfer-*.js`
- 生产 `node_modules/`：按锁文件生产闭包收集（当前为纯 JS 依赖）

刻意不进包：`uploads/`、`.library/`、`.stats/`、`.uploading/`、`.transfer/`、`.certs/`、`.env`、`*.log`、`web/`、`public/`、`vite.config.mjs`、`scripts/`、devDependencies。打包脚本会逐条自检，违反直接失败。

## 5 运行机部署（推荐：自包含包）

```bash
# 1. 拷包到服务器
scp dist/file-box-<version>.tar.gz user@server:/tmp/

# 2. 解压到部署目录（不要删目录重解压，数据在应用目录里）
mkdir -p /opt/file-box
tar -xf /tmp/file-box-<version>.tar.gz -C /opt/file-box --strip-components=1

# 3. 启动
cd /opt/file-box
pm2 start ecosystem.config.js
pm2 save

# 4. 验证（端口以 ecosystem.config.js 的 env.PORT 为准）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4444/
curl -s http://127.0.0.1:4444/api/library | head -c 120
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4444/transfer.html
```

不用 pm2 也可以：

```bash
cd /opt/file-box
npm start            # 默认 3000/3443；不需要 npm install
```

首次启动会在应用目录生成 `.certs/`（HTTPS 自签证书）、`uploads/`、`.library/`、`.stats/`。若 `dist-web/index.html` 缺失，`/` 会返回 503 并提示先构建；这说明包不完整或用了源码目录但没 build。

## 6 数据、备份与恢复

必须一起备份：

| 目录 | 内容 | 丢了会怎样 |
|---|---|---|
| `uploads/` | 批次密文 | 文件丢失（不可恢复） |
| `.library/` | NeDB 目录树 / 批次归属 / TTL / 清单哈希 | 文件还在，目录树和 TTL 丢失，全部回到「未分档」 |
| `.stats/` | 下载次数账本 | 文件还在，下载次数归零 |

```bash
cd /opt/file-box
tar -czf /tmp/file-box-data-$(date +%F).tar.gz uploads $(ls -d .stats .library 2>/dev/null)
```

恢复：先停服务，再解压覆盖数据目录；`.library` 缺失时文件仍会出现在未分档，不会丢文件。

## 7 升级与回滚

```bash
# 升级：备份数据 → 解压新包覆盖 → 重启；运行机不需要 build/install
cd /opt/file-box
tar -czf /tmp/file-box-data-$(date +%F).tar.gz uploads $(ls -d .stats .library 2>/dev/null)
tar -xf /tmp/file-box-<新版本>.tar.gz -C /opt/file-box --strip-components=1
pm2 restart file-box

# 回滚：旧包再覆盖一次；数据目录不动
tar -xf /tmp/file-box-<旧版本>.tar.gz -C /opt/file-box --strip-components=1
pm2 restart file-box
```

注意：

- 回滚到**本版本之前**的旧包会带回旧的 90 天全局清理（旧代码默认值就是 90）；新版本自身没有全局清理。回滚前先备份并确认能接受。
- 旧代码不认识 `.library`，文件仍在；但目录树/TTL 不会生效，新的 TTL 也不会执行（文件转为手动删除）。
- 不要用「删除整个部署目录再解压」的方式升级；`tar -xf` 覆盖即可，数据目录不会被删。

## 8 反向代理 / HTTPS / 认证

- **子路径挂载可用**：前端 API 使用相对路径，`https://host/box/` 这类挂载只要代理透传前缀即可；`/next` 旧书签会相对跳回根。
- **SSE**：无痕传输事件流需要关闭代理缓冲（nginx `proxy_buffering off` 或透传 `X-Accel-Buffering: no`）。
- **真实 IP**：反代后设 `TRUST_PROXY=1`，否则无痕传输限流按代理 IP 记账。
- **请求体上限**：分块上传单块 32MB，nginx `client_max_body_size 64m`。
- **HTTPS**：可以直接用内置 3443 自签证书（首次信任一次），也可以在反代层用 Let's Encrypt。浏览器只在安全上下文开放原生 WebCrypto；HTTP 内网 IP 会退回纯 JS，页面顶部会提示 HTTPS 地址。
- **没有登录**：能访问端口的人拥有全部权限；上公网前必须在反向代理层加认证（例如 nginx basic auth），并确认 3000/3443 没有被端口转发到公网。

## 9 排障

| 现象 | 先查 |
|---|---|
| `/` 返回 503“前端尚未构建” | 发布包缺 `dist-web/index.html`，或源码目录没执行 `npm run setup` / `npm run build` |
| `npm start` 根页面 404 | 同上；运行机不需要 build，但包必须完整 |
| `npm ci` 失败 | 锁文件与 `package.json` 不一致；在构建机重新 `npm install` 生成锁并提交 |
| 端口被占 | `pm2` 配置默认 4444/3443；`npm start` 默认 3000/3443；改 `PORT`/`HTTPS_PORT` |
| 上传 413 | 反代 `client_max_body_size` 太小，或单块超过 32MB |
| 目录树突然全变未分档 | `.library` 丢失/损坏；文件仍在。用 `.bak` 恢复，或接受重新建目录 |
| 目录索引启动报损坏 | 会优先读 `.bak`；两个都坏会改名 `*.corrupt-*` 并从空库启动，不会删文件 |
| 多实例/多进程 | NeDB 索引不是多进程安全；只跑一个 `file-box` 进程 |
| 页面还是旧版 | 浏览器缓存；刷新一次。旧 `public/index.html` 已删除，旧 `/next` 会跳回根 |

## 10 安全边界（部署前必读）

- 没有登录；目录名与目录结构对服务器明文可见；文件内容与真实文件名仍端到端加密。匿名用户可以建目录、移动批次、取消未完成上传、删除文件/目录。
- 目录数量有 `MAX_FOLDERS` 上限（默认 10000），防止无认证环境无限建目录；这只是一道元数据护栏，不是权限隔离。
- 删除不可恢复（无回收站）；文件夹删除会逐项执行，共享盘多人使用时请约定目录归属。
- `.library` / `.stats` / `uploads` 都是数据，不要提交进 git，不要放进发布的静态目录。
- 生产只跑一个 Node 进程；需要多实例时，目录索引必须先改成支持多进程的存储（当前不支持）。

## 11 验证命令

```bash
npm run setup
npm run release
npm test
node test/lab/library-smoke.js       # 真浏览器：目录 / 上传 / 下载 / 重命名 / 搜索 / 移动端
SMOKE_MB=2 node test/lab/ui-smoke.js # 真浏览器：无痕传输
```

全量测试必须串行；`npm test` 已带 `--test-concurrency=1` 并在 `pretest` 先 build。单遍绿灯不等于交付证据，至少连跑两遍并记录实际通过数。
