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
  folders.db.bak
  batches.db.bak
```

- 物理批次永远不因为“改名/移动目录”而移动；目录操作只改索引。
- 没有 `batches.db` 条目的旧批次 = **未分档**。
- 索引丢失时：文件仍在 `uploads/`，目录树与 TTL 丢失，所有批次回到未分档；TTL 丢失只会让文件转为手动删除。
- 一个批次只属于一个目录；批次整体移动支持，单文件跨目录移动不在当前版本。

## 2 目录规则

- `id`：`f_` + 12 位小写 hex；改名/移动不变，分享链接稳定。
- `parentId: null` 表示顶级；最大深度 8。
- `name`：NFC 规范化、1–60 字符；拒绝 `/ \ : * ? " < > |`、控制字符、首尾空白/点、`.`/`..`、Windows 设备名；同一父目录下大小写不敏感去重。
- 保留名：`未分档`、`全部文件`。
- `未分档` 是虚拟目录（`__unfiled__`），不写索引，不能改名/移动/删除自身；只接受批次移入。

## 3 每次上传的 TTL

- 上传 `init` 带 `ttlHours`，白名单：`1, 4, 8, 48, 72, 120, 240, 2160`（1h / 4h / 8h / 2d / 3d / 5d / 10d / 90d）。
- 客户端默认 **1 小时**；传完时写 `uploadedAt = finish 时刻`、`expiresAt = uploadedAt + ttlHours`。
- TTL 是**批次级**的：同一次上传的文件一起到期；单个文件手动删除不改变同批剩余文件的到期时间。
- 文件夹没有 TTL，永不自动删除；批次到期后文件消失，空文件夹保留。
- 没有全局保留期：没有“超过 N 天清理所有目录”的兜底；旧批次没有 `expiresAt`，只能手动删。
- 清理：启动、每 `TTL_SWEEP_MS`（默认 60 秒）、每次上传 init 前扫描 `expiresAt <= now`；**物理删除成功才移除索引条目**，失败保留以便重试。

## 4 文件操作

- 文件身份 = `批次名 + 密文名`；真实文件名只在加密清单里。
- 单文件删除：客户端解密清单 → 删条目 → 重新加密 → 服务端原子替换清单 → 删密文。若只剩清单，整批回收。
- 单文件重命名：只改加密清单里的 `name`，密文名/下载次数不变。
- 并发：清单替换带 `expectedManifestHash`（SHA-256）；旧哈希 → 409，客户端重新拉清单后重试。
- 旧数据没有 `manifest.enc`：允许直接删密文，不能重命名。
- 下载：`GET /api/download/:batch/:file` 支持 `Range`；起点 > 0 的续传不重复计下载次数。客户端用 OPFS 存 partial，完成后再流式解密并按清单明文大小裁剪。

## 5 API

| 方法与路径 | 作用 |
|---|---|
| `GET /api/library` | 目录树 + 批次归属 + TTL + 目录汇总 + 用量 + `ttlOptions` + `now` |
| `POST /api/folders` | 新建目录 `{name,parentId}` |
| `PATCH /api/folders/:id` | 改名 **或** 移动（一次只改一项） |
| `DELETE /api/folders/:id` | 递归删除；`?mode=empty` 只删空目录 |
| `PATCH /api/batches/:batch` | 批次整体移动 `{folderId}` |
| `PATCH /api/batches` | 批量移动 `{names:[],folderId}` |
| `DELETE /api/folder/:batch?expectFolder=<id>` | 删除批次；归属不符 → 409 |
| `POST /api/batches/:batch/file-delete` | 单文件删除 `{file, manifest?, expectedManifestHash?}` |
| `POST /api/batches/:batch/file-rename` | 单文件重命名 `{file, manifest, expectedManifestHash}` |
| `GET /api/uploads` | 未完成上传：uploadId/文件数/块数/字节/最近活动（不含真实文件名） |
| `DELETE /api/uploads/:id` | 取消并清理暂存；合并中置取消标记 |
| `GET /api/list` | 旧接口，保持原形状（只少了 `usage.retentionDays`），供旧缓存/兼容调用 |

请求体由 `lib/schemas.js` 的 Zod schema 校验；错误统一 400；目录/批次不存在 404；同名/非空/状态冲突 409。

## 6 任务中心

前端任务状态：`queued → running → paused / failed / done / canceled`。

| 任务 | 暂停 | 继续 | 取消 | 说明 |
|---|---|---|---|---|
| 上传 | 停发新块，等在途块落定 | 重新 init 拿 `have`，只补缺失块 | 中止在途 + `DELETE /api/uploads/:id` | 刷新后列出服务端未完成批次，重选同一批文件续传 |
| 下载 | abort 当前请求，保留 OPFS partial | 从 partial 长度发 `Range` 续 | abort + 清 OPFS | 无 OPFS 的浏览器退化为从头重试 |
| 目录删除 | 当前项完成后停 | 从剩余清单继续 | 停止，剩余保留 | 按“批次 → 最深子目录 → 父目录”逐项；`expectFolder` 防误删被移走的批次 |

- 任务记录目前不做跨刷新持久化（未完成上传通过 `/api/uploads` 恢复；下载 partial 在 OPFS，重新下载同一文件会续）。
- 多标签页不同步任务。

## 7 构建与部署

```bash
npm install
npm run dev        # Vite 5173；另开 npm run dev:server 提供 API
npm run build      # 生成 dist-web/
npm start          # Express 托管 /api + dist-web
npm run pack       # 先 build，再出自包含 tar 包
```

- 源码：`web/`（Vue 3 + Vite 6 + Reka UI + VueUse + SortableJS + fflate + Lucide）。
- 静态源：`public/`（`crypto.js` / `dec-worker.js` / `transfer.html` / `xfer-*.js` / `progress-strip.css`）。
- 构建产物：`dist-web/`（不入库；Vite 会把 `public/` 复制进去）。
- 目标机：Node ≥18 + `dist-web` + 生产依赖；**不需要 Vite，也不需要单独数据库服务**。
- 生产依赖：`express` / `selfsigned` / `zod` / `@seald-io/nedb`（纯 JS）；前端依赖全部在 devDependencies，已打进静态产物。

## 8 备份 / 恢复 / 回滚

- 备份：`uploads/`、`.stats/`、`.library/` 三处；`.library` 不要放进 `uploads/`。
- 只恢复 `uploads/`：文件在，目录树/TTL 丢失，全部回到未分档。
- 索引损坏：启动优先加载 `.bak`；主文件与备份都坏 → 把坏文件改名 `*.corrupt-<时间戳>`，从空库启动，文件仍在未分档。
- 回滚到本版本之前的旧包：旧代码不认识 `.library`，文件仍在；但旧代码自带 90 天全局清理，回滚前先备份并确认能接受。
- 单实例假设：NeDB 不是多进程安全；`ecosystem.config.js` 只跑一个进程。

## 9 安全边界

- **没有登录**：能访问端口的人拥有全部权限；目录名与目录结构对服务器明文可见，真实文件名与内容仍加密。
- 上公网前必须在反向代理层加认证；内网使用也要确认端口没有被转发出去。
- 目录名永远不参与文件系统路径；批次名仍走原有路径闸门（日期形状 + realpath 校验）。
- 删除不可恢复（无回收站）；多团队共享盘靠目录约定与二次确认。

## 10 当前版本不做

- 目录打包下载在新界面（旧 `/api/archive/:batch` 仍保留，供兼容/脚本调用）。
- 单文件跨目录移动、文件拖拽移动、回收站、预览、全局搜索、上传文件夹自动镜像子目录、按目录单独保留期。
- 目录名加密（当前明文；文件内容/真实文件名仍加密）。
- 跨标签页任务同步、任务记录跨刷新持久化（未完成上传和下载 partial 的恢复见 §6）。

## 11 验证记录（2026-10-27）

- `npm run build`：通过，产物 `dist-web/index.html` + `assets/`。
- `npm run pack`：通过，自包含包内含 `dist-web`、`lib`、`docs`；生产闭包 114 个包，均为纯 JS。
- 全量：`node --test --test-concurrency=1 "test/*.test.js"`，**151/151** 通过（第二次串行全量）。
- 浏览器：
  - `node test/lab/library-smoke.js`：建目录 / 上传 / 默认 1h TTL / 下载字节 / 重命名 / 搜索 / 删文件 / 删目录 / 移动端列宽，通过；无 console/page 错误。
  - `SMOKE_MB=2 node test/lab/ui-smoke.js`：无痕传输 `SMOKE PASS`（`transfer.html` 从 `dist-web` 托管后仍可用）。
- **未查明（不当已通过）**：第一次串行全量 `150/151`，失败在 `test/xfer-channel.test.js` 的“收尾被一直拒收”，错误是 `api/xfer/create` 400；单跑该文件 `30/30` 通过，第二次全量 `151/151` 通过，未能复现。该红与文件库改动无直接调用边，但按仓库口径登记为未查明。
- `npm test` 现在带 `--test-concurrency=1`，并在 `pretest` 先执行 `npm run build`；直接 `node --test` 前也要先构建 `dist-web`。
