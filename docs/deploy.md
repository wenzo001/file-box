# 部署与发布

本文是生产部署的主文档。目录 / TTL / 任务模型的细节见 [`library.md`](library.md)，无痕传输见 [`transfer.md`](transfer.md)。

## 1 架构：一个 Node 进程同时提供 API 和前端

```text
浏览器
  │  /api/*          → Express（server.js 只做接线，按职责分到 lib/）
  │  /、/assets/*    → express.static(dist-web)
  │  /transfer.html  → dist-web/transfer.html（public/ 静态源复制过来）
  ▼
一个 Node 进程
  ├── lib/egress.js      下载 / 归档（Range、归档分帧、并发名额池）
  ├── lib/staging.js     暂存区 → uploads 的搬运（含跨盘 EXDEV 兜底）
  ├── lib/maintenance.js 一键清空的编排（先校验、按轮重扫、清不干净就报错）
  ├── lib/rate-limit.js  文件库侧按 IP 的限速桶
  ├── uploads/     批次密文
  ├── .library/    NeDB 目录索引 + 公共设置（嵌入式，不是独立数据库服务）
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
| 磁盘 | `uploads/` + `.library/` + `.stats/` 在应用目录；默认总量上限 10GB；目录数量上限 `MAX_FOLDERS` 默认 10000（目录层级本身不限） |

**可调参数**（默认值都在 `ecosystem.config.js` 里；改完 `pm2 restart file-box` 生效）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` / `HTTPS_PORT` | 3000 / 3443（pm2 里 4444 / 3443） | 两个端口 |
| `STORAGE_LIMIT_GB` | 10 | 存储总量上限 |
| `UPLOAD_DIR` / `STAGING_DIR` / `LIBRARY_DIR` | `uploads` / `.uploading` / `<uploads 父目录>/.library` | 三个数据目录；暂存区与 uploads 可以跨盘 |
| `DOWNLOADS_FILE` | `<uploads 父目录>/.stats/downloads.json` | 下载账本（含只增不减的 `__total__`） |
| `TTL_SWEEP_MS` / `UPLOAD_TTL_HOURS` | 60000 / 48 | 过期扫描间隔 / 未完成批次保留 |
| `MAX_FOLDERS` | 10000 | 目录数量护栏 |
| `SCAN_CACHE_MS` | 1500 | `/api/library` 扫盘缓冲（走 API 的改动会立刻失效） |
| `MEM_DOWNLOAD_MAX_MB` | 50 | **没有可写 OPFS** 的浏览器单文件下载内存上限（有 OPFS 不受限） |
| `MAX_EGRESS` | 32 | 下载 + 归档共用的并发名额；满了 429 |
| `INIT_PER_WINDOW` / `LIBRARY_PER_WINDOW` / `RATE_WINDOW_MS` | 60 / 240 / 60000 | 文件库侧按 IP 的限速（开始上传 / 刷新列表 / 窗口长度） |
| `TRUST_PROXY` | 空 | 反代后必须设 `1`（或信任的代理串），否则所有客户端共用一个 IP 桶 |
| 传输相关 | — | `XFER_*` / `TURN_*` / `STUN_PORT` 见 [transfer.md](transfer.md) |

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

首次启动会在应用目录生成 `uploads/`、`.library/`、`.uploading/`、`.transfer/`，以及 `server.js` 旁边的 `.certs/`（HTTPS 自签证书，不受 `UPLOAD_DIR` 影响；删了所有客户端都要重新信任）。`.stats/` 要到**第一次下载**时才建（账本 2 秒后落盘）。若 `dist-web/index.html` 缺失，`/` 会返回 503 并提示先构建；这说明包不完整或用了源码目录但没 build。

## 6 数据、备份与恢复

必须一起备份：

| 目录 | 内容 | 丢了会怎样 |
|---|---|---|
| `uploads/` | 批次密文 | 文件丢失（不可恢复） |
| `.library/` | NeDB 目录树 / 批次归属 / TTL / 清单哈希 / 公共设置（`defaultTtlHours`） | 文件还在，目录树、TTL 和全局设置丢失，全部回到「未分档」，新上传回到默认 1 小时 |
| `.stats/` | 下载次数账本（逐文件计数 + 只增不减的 `__total__`；第一次下载后才出现） | 文件还在，下载次数归零（含历史累计） |
| `.uploading/` | 未完成上传的暂存（可不要） | 未传完的批次要重传；已完成的批次不受影响 |
| `.transfer/` | 无痕传输中转的密文（可不要） | 进行中的无痕会话作废 |
| `.certs/` | HTTPS 自签证书（在 `server.js` 旁边，不跟 `UPLOAD_DIR` 走） | 重新生成，**所有客户端都要重新信任一次** |

```bash
cd /opt/file-box
tar -czf /tmp/file-box-data-$(date +%F).tar.gz uploads $(ls -d .stats .library 2>/dev/null)
```

恢复：先停服务，再解压覆盖数据目录；`.library` 缺失时文件仍会出现在未分档，不会丢文件。

- **一键清空**（页面上「清空所有文件…」）会删掉 `uploads/` 里本服务建的批次、`.uploading/` 与 `.transfer/`，
  但**保留** `.library/folders.db`（目录树）、`.library/settings.db`（全局 TTL）与账本里的 `__total__`（历史累计下载）。`.certs/` 不动。

- 未完成上传的暂存区默认是部署目录里的 `.uploading/`（可用 `STAGING_DIR` 指走）。收尾时是把整个暂存目录搬进 `uploads/`，
  所以**两个目录跨盘也能用**：同一个盘走 rename；跨盘会自动退化为"复制 + 删源"（收尾那一刻会短暂占两份空间）。
  复制后如果源删不掉，服务会撤掉目标目录并按失败返回——宁可这次收尾失败让客户端重试，也不留下两份内容相同的批次。

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
- **本版本没有数据结构变更，不需要迁移**：账本里新增的 `__total__` 在启动时按现有逐文件计数之和自动回填；`.library` 三个库文件形状没变；
  `.uploading/` 里未完成的分块跨版本仍能续（`meta.json` 的 `v: 2` 没变）。升级 = 覆盖 + `pm2 restart`。
- 新版本新增了限速与并发上限；反代没设 `TRUST_PROXY` 的话所有人会共用一个桶 —— 升级时一起补上。

## 8 反向代理 / HTTPS / 认证

- **子路径挂载可用**：前端 API 使用相对路径，`https://host/box/` 这类挂载只要代理透传前缀即可；`/next` 旧书签会相对跳回根。
- **SSE**：无痕传输事件流需要关闭代理缓冲（nginx `proxy_buffering off` 或透传 `X-Accel-Buffering: no`）。
- **真实 IP**：反代后设 `TRUST_PROXY=1`，否则无痕传输**和文件库**的限流都会按代理 IP 记账（所有人共用一个桶）。
- **429 是保护，不是故障**：文件库侧按 IP 限速（`INIT_PER_WINDOW` / `LIBRARY_PER_WINDOW`），下载/归档有并发上限（`MAX_EGRESS`）；
  响应带 `Retry-After`，客户端自己退避。别在反代层把 429 改成 500。
- **长连接**：下载、归档、SSE 都是一直占着连接的；nginx 默认 `proxy_read_timeout 60s` 会把大文件掐断 —— 调到 `300s` 以上。
- **Range 必须透传**：断点续传靠 `Range` 与 `206` / `Content-Range`；反代别剥这两个头。
- **别缓冲整包**：归档是按 `Content-Length` 流式吐的，代理开"缓冲整个响应"会先把几百 MB 收进内存。
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
| 目录树突然全变未分档 | `.library` 丢失/损坏；文件仍在。用 `.bak` 恢复，或接受重新建目录（全局自动删除设置会回到默认 1 小时） |
| 目录索引启动报损坏 | 会优先读 `.bak`；两个都坏会改名 `*.corrupt-*` 并从空库启动，不会删文件 |
| 多实例/多进程 | NeDB 索引不是多进程安全；只跑一个 `file-box` 进程 |
| 页面还是旧版 | 浏览器缓存；刷新一次。旧 `public/index.html` 已删除，旧 `/next` 会跳回根 |
| 页面报「刷新列表太频繁」/ 接口 429 | 触发了文件库侧限速（默认 60 次开始上传 / 240 次刷新列表每分钟，按 IP）；等一个窗口，或调大 `INIT_PER_WINDOW` / `LIBRARY_PER_WINDOW`；反代下确认设了 `TRUST_PROXY` |
| 下载慢又像"从头开始" | 先看任务行阶段：拉密文 / 解密中 / 保存中。弱网会自己重连（写「网络中断，N 秒后从 X 继续」）；若一开始就提示「不支持断点续存（OPFS）」，是那台浏览器没有可写 OPFS，超过 `MEM_DOWNLOAD_MAX_MB` 传不完 |
| 手机上切后台后上传停了 | 上传期间持了 Web Lock（Chrome 下不会被冻结），系统仍可能节流；任务行会写「页面在后台」，回前台会继续，48 小时内可续 |
| 打包变成"逐个文件" | 这台设备没有可写 OPFS 且压缩包超过 `MEM_DOWNLOAD_MAX_MB`；降级是预期行为，要整包就换设备或调大上限 |
| 清空后目录还在、文件没了 | 预期：一键清空保留目录树、全局设置与历史累计下载，只删本服务按「日期_时间」建的批次 |

## 10 安全边界（部署前必读）

- 没有登录；目录名与目录结构对服务器明文可见；文件内容与真实文件名在服务器上只有密文。匿名用户可以建目录、移动批次、取消未完成上传、删除文件/目录、一键清空。
- **文件库的加密是「部署内置密钥」**（密钥随页面下发）：防的是磁盘 / 备份被单独拿走，**不防**能打开页面的人 —— 他拿得到密钥。无痕传输（独立入口）才是真正的端到端：密钥由一次性码经 ECDH 派生，服务器只有密文帧。要「连管理员也读不到」，当前版本做不到，见 `docs/library.md` §9。
- 目录数量有 `MAX_FOLDERS` 上限（默认 10000），防止无认证环境无限建目录；这只是一道元数据护栏，不是权限隔离。
- 删除不可恢复（无回收站）；文件夹删除会逐项执行，共享盘多人使用时请约定目录归属。
- **一键清空不需要口令**：确认词（`清空全部文件`）写在页面里，能打开页面的人就抄得到。它防的是误触和脚本手滑，**不防**「本来就能逐个删目录的人」——没有登录就没有「只有管理员能清空」这回事。端口会被更多网段看到时，请把认证放在反代上。
- `.library` / `.stats` / `uploads` 都是数据，不要提交进 git，不要放进发布的静态目录。
- 生产只跑一个 Node 进程；需要多实例时，目录索引必须先改成支持多进程的存储（当前不支持）。
- **限速与并发上限只是"别被一个人拖死"**：按 IP 的窗口计数 + 下载/归档名额池都活在进程内存里（重启清零），换 IP 就能绕开；
  真正的访问控制只能放在反代（认证 / 网段）。
- **缺安全头**：没有 `X-Content-Type-Options: nosniff`，也没有 CSP / `frame-ancestors`。上传的 `.html` 目前不会被当页面执行
  （下载带 `Content-Disposition: attachment`、归档与无痕分段是 `application/octet-stream`、SSE 是 `text/event-stream`），
  这三条由静态门与行为判据守着；要不要再加安全头由部署方决定。

## 11 验证命令

```bash
npm run setup
npm run release
npm test
node test/lab/library-smoke.js       # 真浏览器：多栏目录 / 全局 TTL / 分享高亮 / zip / 搜索 / 窄屏
node test/lab/mobile-smoke.js        # 真浏览器触摸档：390/360/320 的 44pt 命中区、iOS 缩放、裁切、浏览区高度、对比度
node test/lab/feature-sweep.js       # 真浏览器主路径扫查：文件重命名 / 文件删除 / 移动到… / 下载暂停继续
node test/lab/folder-delete-nav.js   # 真浏览器：删掉当前目录后停在上一级
node test/lab/download-resume.js     # 真浏览器：第一次只回 40% 就断，第二发带 Range 续传
node test/lab/zip-fallback.js        # 真浏览器：无 OPFS + 超上限时打包降级成逐个文件
node test/lab/upload-lock.js         # 真浏览器：上传期间持 Web Lock、结束释放
SMOKE_MB=2 node test/lab/ui-smoke.js # 真浏览器：无痕传输
```

全量测试必须串行；`npm test` 已带 `--test-concurrency=1` 并在 `pretest` 先 build。单遍绿灯不等于交付证据，至少连跑两遍并记录实际通过数。
