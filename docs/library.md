# 文件库目录 / TTL / 任务中心

本文只讲文件库（目录、上传、下载、删除、TTL、索引）。无痕传输见 [`transfer.md`](transfer.md)。

## 1 模型：字节与组织方式分开

一次上传仍然是一个**不可变的物理批次**：

```text
uploads/20261027_1431/          ← 批次目录（日期名，路径闸门仍按它认人）
  f_<批次指纹前12位><序号>.enc  ← 密文文件
  manifest.enc                  ← 加密清单（真实文件名只在客户端解密）
```

目录树、批次归属和 TTL 放在 `uploads` 之外的 NeDB 索引：

```text
<uploads 父目录>/.library/
  folders.db      ← 目录：_id / parentId / name / nameKey / parentKey
  batches.db      ← 批次：_id=批次名 / folderId / uploadedAt / expiresAt / ttlHours / manifestHash
  settings.db     ← 公共设置：_id=global / defaultTtlHours
  folders.db.bak
  batches.db.bak
  settings.db.bak
```

- 物理批次永远不因为“改名/移动目录”而移动；目录操作只改索引。
- 没有 `batches.db` 条目的旧批次 = **未分档**。
- 索引丢失时：文件仍在 `uploads/`，目录树与 TTL 丢失，所有批次回到未分档；TTL 丢失只会让文件转为手动删除。
- 一个批次只属于一个目录；批次整体移动支持，单文件跨目录移动不在当前版本。
- 目录汇总 `count / size / downloads / earliestExpiresAt / lastUpdatedAt` 在 `/api/library` 里直接给出；`lastUpdatedAt` 取该目录子树内最近一次上传完成时间（空目录为 `null`），用于目录行直接显示「几个文件 · 最后更新几分钟前」。

## 2 目录规则

- `id`：`f_` + 12 位小写 hex；改名/移动不变，分享链接始终用 `?f=<id>`，**不会跟着名字变**。
- `parentId: null` 表示顶级；层级**不设上限**（Finder 式多级分栏，横向滚动），只保留环检测。
- `name`：NFC 规范化、1–20 个 Unicode 字符；拒绝 `/ \ : * ? " < > |`、控制字符、首尾空白/点、`.`/`..`、Windows 设备名；同一父目录下大小写不敏感去重。改名同样按 20 字校验。
- 保留名：`未分档`、`全部文件`。
- 目录数量上限默认 10000（`MAX_FOLDERS`）；无认证环境下防止无限建目录，超过返回 507。层级无限 ≠ 数量无限。
- `未分档` 是虚拟系统目录（`__unfiled__`），不写索引；**不能新建子目录、不能改名/移动/删除自身**，只能把批次移入；界面上的删除入口对系统目录一律不出现。
- 目录名与目录结构对服务器明文可见；真实文件名仍只在加密清单里。


## 3 自动删除时长（全局设置 + 批次快照）

- 白名单：`1, 4, 8, 48, 72, 120, 240, 2160`（1h / 4h / 8h / 2d / 3d / 5d / 10d / 90d）。
- **全局设置**：`settings.db` 里的 `defaultTtlHours` 默认 **1 小时**；界面顶部公共配置区直接改，调用 `PUT /api/settings`。该设置对所有使用者生效，只影响**之后发起**的上传。
- 上传 `init` 不带 `ttlHours` 时，服务端读取当前全局值并写进这一批的 `meta.json`；同一批传到一半时改设置，不会改这一批的时长。`init` 仍接受显式 `ttlHours`，供旧客户端/脚本覆盖（白名单校验）。
- 传完时写 `uploadedAt = finish 时刻`、`expiresAt = uploadedAt + ttlHours`；批次级到期，同一次上传的文件一起消失。
- 文件夹没有 TTL，永不自动删除；批次到期后文件消失，空文件夹保留。
- 没有全局保留期：没有“超过 N 天清理所有目录”的兜底；旧批次没有 `expiresAt`，只能手动删。
- 清理：启动、每 `TTL_SWEEP_MS`（默认 60 秒）、每次上传 init 前扫描 `expiresAt <= now`；**物理删除成功才移除索引条目**，失败保留以便重试。
- 界面：文件/目录行显示「几分钟前 / 几小时后删除」；剩余 **<10 分钟**行标红并写「即将删除」，不弹 toast。上传完成 toast 与上传条都会重复说明「X 后自动删除」。


## 4 文件操作

- 文件身份 = `批次名 + 密文名`；真实文件名只在加密清单里。
- 单文件删除：客户端解密清单 → 删条目 → 重新加密 → 服务端原子替换清单 → 删密文。若只剩清单，整批回收。
- 单文件重命名：只改加密清单里的 `name`，密文名/下载次数不变。
- 并发：清单替换带 `expectedManifestHash`（SHA-256）；已有清单却缺哈希 → 400，旧哈希 → 409，客户端重新拉清单后重试。
- 旧数据没有 `manifest.enc`：允许直接删密文，不能重命名。
- 下载：`GET /api/download/:batch/:file` 支持 `Range`；起点 > 0 的续传不重复计下载次数。客户端用 OPFS 存 partial，完成后再流式解密并按清单明文大小裁剪。

## 5 API

| 方法与路径 | 作用 |
|---|---|
| `GET /api/library` | 目录树 + 批次归属 + TTL + 目录汇总（含 `lastUpdatedAt`）+ 用量 + `ttlOptions` + `settings` + `now` |
| `GET /api/settings` | 读取公共设置（`defaultTtlHours`） |
| `PUT /api/settings` | 修改公共设置 `{defaultTtlHours}`；白名单外 400 |
| `POST /api/folders` | 新建目录 `{name,parentId}`；名长 20 字、层级不限 |
| `PATCH /api/folders/:id` | 改名 **或** 移动（一次只改一项）；改名不换 `_id` |
| `DELETE /api/folders/:id` | 递归删除；`?mode=empty` 只删空目录；`__unfiled__` 一律 400 |
| `PATCH /api/batches/:batch` | 批次整体移动 `{folderId}` |
| `PATCH /api/batches` | 批量移动 `{names:[],folderId}` |
| `DELETE /api/folder/:batch?expectFolder=<id>` | 删除批次；归属不符 → 409 |
| `POST /api/batches/:batch/file-delete` | 单文件删除 `{file, manifest?, expectedManifestHash?}` |
| `POST /api/batches/:batch/file-rename` | 单文件重命名 `{file, manifest, expectedManifestHash}` |
| `GET /api/uploads` | 未完成上传：uploadId/文件数/块数/字节/最近活动（不含真实文件名） |
| `DELETE /api/uploads/:id` | 取消并清理暂存；合并中置取消标记 |
| `GET /api/list` | 旧接口，保持原形状（只少了 `usage.retentionDays`），供旧缓存/兼容调用 |

请求体由 `lib/schemas.js` 的 Zod schema 校验；错误统一 400；目录/批次不存在 404；同名/非空/状态冲突 409。

## 6 界面与任务中心

浏览界面是 macOS Finder 式**多栏视图**：点一级目录向右展开下一栏，层级不限、横向滚动；每一栏都可以把文件拖进去上传，空白处右键「新建文件夹 / 上传文件到此处」，目录行右键或行尾「⋯」提供打开 / 重命名 / 移动 / 复制链接 / 打包下载 / 删除。顶部搜索是**全局搜索**，同时匹配目录名与解密后的文件名，并显示所在路径。

- 目录行直接显示「N 个文件 · 最后更新 X 分钟前」；文件行显示上传时间（几分钟前）与到期倒计时，10 分钟内标「热乎」。文件菜单里的「移动这批上传到…」用于把旧批次整批移入正式目录（批次是物理不可变的，目录只是索引归属）。
- 目录「⋯」菜单里的「复制文件夹链接」始终是 `?f=<目录 ID>`；改名不换 ID，所以链接不变。
- 文件分享：文件「⋯」→「复制文件分享链接」，链接带 `file=<批次>/<密文名>`；打开后进入所在目录、目录行高亮、对应文件高亮并列出分享文件清单。多选后在选择条点「复制分享链接」可一次分享多个文件。
- 目录 / 多选打包下载在浏览器内解密后生成 zip（`fflate`，store 不压缩）；服务端只见过密文，所以 zip 不能由服务端拼。进度、暂停、继续、取消都在任务中心。
- 当前目录每 10 秒刷新；切换目录时立即拉一次最新 `/api/library`，并自动横向滚到新展开的那一栏。批次清单哈希在服务端改名 / 删除时会变，轮询看到哈希变化就重拉清单，不会停在旧文件名上。
- 顶部公共配置区：「所有新上传：1 小时后自动删除」；旁注写明到期即永久删除、已上传文件按各自上传时的设置、设置对所有使用者生效。

前端任务状态：`queued → running → paused / failed / done / canceled`。

| 任务 | 暂停 | 继续 | 取消 | 说明 |
|---|---|---|---|---|
| 上传 | 停发新块，等在途块落定 | 重新 init 拿 `have`，只补缺失块 | 中止在途 + `DELETE /api/uploads/:id` | 刷新后列出服务端未完成批次，重选同一批文件续传 |
| 下载 | abort 当前请求，保留 OPFS partial | 从 partial 长度发 `Range` 续 | abort + 清 OPFS | 无 OPFS 的浏览器退化为从头重试 |
| 目录 / 多选打包 | abort 当前文件请求；已写入 zip 的条目保留 | 从下一个未完成条目继续（当前文件没写完就重下这一件） | abort | 浏览器内解密，进度按明文字节；zip 状态留在任务闭包里 |
| 目录删除 | 当前项完成后停 | 从剩余清单继续 | 停止，剩余保留 | 按“批次 → 最深子目录 → 父目录”逐项；`expectFolder` 防误删被移走的批次 |

- 任务记录目前不做跨刷新持久化（未完成上传通过 `/api/uploads` 恢复；下载 partial 在 OPFS，重新下载同一文件会续）。
- 多标签页不同步任务。

## 7 构建与部署

```bash
npm run setup      # 安装前后端依赖 + 构建 dist-web
npm run dev        # Vite 5173；另开 npm run dev:server 提供 API
npm start          # Express 托管 /api + dist-web
npm run release    # setup（安装 + build）+ 自包含 tar 包
npm run pack       # 依赖已装好时只 build + 出包
```

完整的生产部署、备份、升级/回滚、反代与排障见 [`deploy.md`](deploy.md)。

- 源码：`web/`（Vue 3 + Vite 6 + Reka UI + VueUse + fflate + Lucide）。
- 静态源：`public/`（`crypto.js` / `dec-worker.js` / `transfer.html` / `xfer-*.js` / `progress-strip.css`）。
- 构建产物：`dist-web/`（不入库；Vite 会把 `public/` 复制进去）。
- 目标机：Node ≥18 + `dist-web` + 生产依赖；**不需要 Vite，也不需要单独数据库服务**。
- 生产依赖：`express` / `selfsigned` / `zod` / `@seald-io/nedb`（纯 JS）；前端依赖全部在 devDependencies，已打进静态产物。

## 8 备份 / 恢复 / 回滚

- 备份：`uploads/`、`.stats/`、`.library/` 三处；`.library` 不要放进 `uploads/`。`.library` 里现在有 `folders.db` / `batches.db` / `settings.db` 及各自的 `.bak`。
- 只恢复 `uploads/`：文件在，目录树/TTL/全局设置丢失，全部回到未分档；全局设置会回到默认 1 小时。
- 索引损坏：启动优先加载 `.bak`；主文件与备份都坏 → 把坏文件改名 `*.corrupt-<时间戳>`，从空库启动，文件仍在未分档。
- 回滚到本版本之前的旧包：旧代码不认识 `.library`，文件仍在；但旧代码自带 90 天全局清理，回滚前先备份并确认能接受。
- 单实例假设：NeDB 不是多进程安全；`ecosystem.config.js` 只跑一个进程。

## 9 安全边界

- **没有登录**：能访问端口的人拥有全部权限；目录名与目录结构对服务器明文可见，真实文件名与内容仍加密。
- 上公网前必须在反向代理层加认证；内网使用也要确认端口没有被转发出去。
- 目录名永远不参与文件系统路径；批次名仍走原有路径闸门（日期形状 + realpath 校验）。
- 删除不可恢复（无回收站）；多团队共享盘靠目录约定与二次确认。

## 10 当前版本不做

- 单文件跨目录移动、文件拖拽移动、回收站、预览、上传文件夹自动镜像子目录、按目录单独保留期。
- 目录名加密（当前明文；文件内容/真实文件名仍加密）。
- 跨标签页任务同步、任务记录跨刷新持久化（未完成上传和下载 partial 的恢复见 §6）。
- 全局搜索由浏览器拉取并解密所有清单后完成；清单数量极大时首次搜索需要等待「正在读取文件名」，没有服务端明文索引（那会破坏端到端加密的边界）。
- 目录 / 多选 zip 在浏览器内解密后组装，服务端没有明文，也不能替客户端拼 zip；超大目录会受浏览器内存限制，建议分批打包。

## 11 验证记录（2026-10-27）

- `npm run build`：通过，产物 `dist-web/index.html` + `assets/`。
- `npm run pack`：通过，自包含包内含 `dist-web`、`lib`、`docs`；生产闭包 114 个包，均为纯 JS（本轮未改依赖闭包）。
- 全量：`npm test`（`--test-concurrency=1` + prebuild）在最终树跑 **162/162** 通过（本轮由 154 增至 162：无限层级、20 字目录名、公共设置/全局 TTL、目录 `lastUpdatedAt`、设置重启持久化、热乎/标红/1 小时展示判据、到期状态类不许被布局规则吃掉的静态判据、"删掉的那套重复导航不许长回来"静态判据）。
- 浏览器（真 Chromium，判据打在渲染结果上）：
  - 多栏界面：新建目录、右键新建子目录、上传、目录行「2 个文件 · 最后更新 刚刚」、全局 TTL=4h 落入批次、目录三菜单、文件夹链接改名不变、文件分享链接打开后文件/目录高亮、目录 zip（逐个文件解开并核对内容）、多选 zip、全局搜索带路径、拖拽上传、窄屏后当前栏仍在视野内、窄屏（390px）下「N 小时后删除」那一行量得到渲染尺寸、最后一栏吃掉分栏卡片剩余宽度（右侧空档 ≤2px，否则界面看着套了一层）；无 console/page 错误。
  - `node test/lab/library-smoke.js`：同一套主路径（含整批上传移动、拖拽上传）的冒烟；`SMOKE_MB=2 node test/lab/ui-smoke.js`：无痕传输 `SMOKE PASS`。
  - 定向验证：把批次 `expiresAt` 改到 5 分钟后 → 行带 `.expiring`、文案「5 分钟后删除」、无 toast；40MB 目录 zip 在任务里暂停再继续后，解出的文件长度与首字节都正确。
  - 修掉的一处窄屏缺陷：到期状态类原先返回裸 `expiry`，被旧表格遗留的 `.file-row > .expiry { display: none }` 命中，手机上去掉整行「N 小时后删除」（文字判据看不见，是量渲染几何才抓到的）。状态类改为 `expiry-plain / expiry-warn / expiry-danger`，并留下两把刀：CSS 静态判据（任何 `display:none` 规则不许点名 expiry）+ 390px 渲染几何判据（`.col-expiry` 必须有宽高）。两把刀都用「把那条 display:none 原样加回去」验过会红，红完还原。
  - 导航只留一套：删掉左侧那棵与分栏/面包屑重复的目录树（容量读数移到顶栏一行小字），并给分栏里当前路径经过的每一行加选中态（灰底 + 左侧 3px 强调条 + 名字加粗，与勾选的蓝底分开）。判据三条：`.sidebar` 在 DOM 里必须为 0；三级路径上必须恰好两行带 `.current`、量得到 62px 高度、文字对比度实测 **16.83:1**（≥4.5:1）；静态门扫 `App.vue` 与 `app.css`，那批已删类名（含旧表格遗留的 `table-head`/`row-main`/`folder-main` 等）不许再出现。前两条各下过刀（摘掉 `pathIds` → 实到 0 行；把每一行都点亮 → 名字对不上），第三条下过 `.sidebar { color: red }` 一刀。
- **历史未查明（不当已通过）**：在 151 条版本的一次串行全量里出现 `150/151`，失败在 `test/xfer-channel.test.js` 的“收尾被一直拒收”，错误是 `api/xfer/create` 400；单跑该文件 `30/30` 通过，随后 151 条全量通过，未能复现。154 条版本连跑两遍通过；157 条版本通过一次；本轮 162 条最终树通过一次。这条历史红仍按未查明登记，不当已通过。
- `npm test` 现在带 `--test-concurrency=1`，并在 `pretest` 先执行 `npm run build`；直接 `node --test` 前也要先构建 `dist-web`。
