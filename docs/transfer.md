# 无痕传输（Ephemeral Transfer）

一条独立的文件通道：发送方选文件 → 生成一次性传输码 → 接收方在另一台设备输入码 → 端到端加密分块传输。
它不写入正式文件库（`uploads/`），不进文件列表，不产生永久分享链接。

- 入口：首页顶栏「无痕传输」→ `public/transfer.html`
- 代码：`public/transfer.html`（页面）、`public/xfer-engine.js`（会话引擎/通道适配器）、
  `public/xfer-proto.js`（协议与密码学，浏览器与 Node 共用同一份）、`public/xfer-worker.js`（加密封装的工作线程）、
  `lib/transfer.js`（服务端：会话、信令、密文中转）、`test/transfer.test.js` + `test/big.test.js`

---

## 1 架构

```
                发送端浏览器                          服务端                     接收端浏览器
  ┌────────────────────────────────┐      ┌────────────────────────┐   ┌────────────────────────────────┐
  │ transfer.html  (UI/进度/状态)  │      │ lib/transfer.js        │   │ transfer.html                  │
  ├────────────────────────────────┤      │  /api/xfer/*           │   ├────────────────────────────────┤
  │ xfer-engine.js  Session        │◀────▶│  会话账本 / 信令 / 密文 │◀─▶│ xfer-engine.js  Session        │
  │   状态机 · 三级进度 · 续传      │ SSE  │  转发（只懂帧头长度）  │SSE│   状态机 · 补拉缺块 · 落盘校验 │
  ├────────────────────────────────┤      └────────────────────────┘   ├────────────────────────────────┤
  │ xfer-proto.js  封帧/密钥/清单   │ xfer-worker.js                    │ xfer-proto.js  开帧/验标签      │
  │  (AES-256-GCM, HKDF, SHA-256)  │◀══ 加解密在工作线程，主线程不卡 ▶══│  (xfer-worker.js 同上)          │
  └────────────┬───────────────────┘                                 └───────────────┬──────────────────┘
               │  通道 1：WebRTC DataChannel（点对点，字节不过服务器）                 │
               │  通道 2：WebRTC DataChannel over TURN 中继（字节不过本服务器）        │
               └───────────────────────┼──────────────────────────────────────────────┘
                          通道 3：服务端密文中转（seg 上传/拉取，服务器只见密文帧）
```

三个通道只是**适配器**：加密、分块、进度、续传逻辑全在 `xfer-engine.js` 一份实现里，任何通道都不会绕开它。
明文从不离开发送端浏览器；服务端与 WebRTC 对端拿到的都是同一种帧（见 §3）。

---

## 2 状态机

两个维度分开走，UI 同时显示。

**phase（会话进度）**

```
idle → fingerprinting → waiting ──▶ pairing ──▶ transferring ──▶ verifying ──▶ ready → saving → done
                          │            │             ▲   │                       （接收端）  （发送端 done）
                          │            ▼             │   ▼
                          │        retrying ─────────┘  paused
                          └─ 任何阶段：cancelled（任一方取消）/ failed（不可恢复错误）
```

| phase | 含义 |
|---|---|
| `fingerprinting` | 只在本地读文件算 SHA-256，尚未上传任何字节 |
| `waiting` | 会话已建，等接收方输入传输码 |
| `pairing` | 已配对，正在派生/核对密钥与安全码 |
| `transferring` | 加密分块推进中 |
| `paused` | 用户暂停；服务端状态与本地暂存全部保留 |
| `retrying` | 连接断了，正在自动重连或改走中转 |
| `verifying` | 全部到齐，逐块验标签 + 算总 SHA-256（仅接收端） |
| `ready` | 校验通过，此时才允许显示文件名并保存（仅接收端） |
| `saving` / `done` | 解密写盘中 / 完成 |

**channel（当前走哪条路）**：`none → p2p_connecting → p2p | turn_relay | server_relay`。
`p2p` 只在 ICE 选中的候选对两边都不是 relay、且 DataChannel 真的 `open` 之后才报；
TURN 中继报 `turn_relay` 并明确写"不是直连"，绝不当成直连。

**进度分三档，不是一条线**：`sent`（发送端已发出）→ `uploaded`（中转区已收到）→ `stored`（接收端已验标签并本地落盘）。
只有 `stored` 算接收完成进度；通道切换用的是同一批 `Set`，不会倒退、不会重复计入。

---

## 3 加密协议与密钥生命周期

全部用浏览器 WebCrypto（`crypto.subtle`）或 Node `crypto`，没有自研算法。
HTTP 入口（非安全上下文）没有 WebCrypto 时，走同一套接口的纯 JS AES-GCM 实现，并在工作线程里跑；
此时两端能力会都落到 `kex='code'`，UI 上明确标出来。

```
传输码 = sid(8 字符，公开) + secret(24 字符，永不发送)，字母表正好 32 个（26 个字母去掉 i/l/o + 数字 1–9），
         一字节取低 5 bit 无偏映射 → secret 有 120 bit 熵
   │
   ├─ proof = HMAC-SHA256(key="filebox-xfer-v1/proof|"+sid, msg=secret)   ← 只有两端能算出来
   │      └ 服务端只存 proof 的 SHA-256，凭它验配对；拿不到 secret，也反推不出码
   │
   ├─ ECDH(P-256) 临时密钥对（安全上下文）→ shared secret
   │      非安全上下文退回 kex='code'（没有前向保密，也不独立抵御主动冒充的服务器，UI 上明写）
   │
   └─ HKDF-SHA256(ikm=shared, salt=transcript, info 各不同) ─┬─ kRec   文件密钥的根
        transcript = SHA-256("filebox-xfer-v1|"+sid+"|"+kex+"|"+两端公钥)   ├─ kMeta  清单帧的密钥
                                                            ├─ kConfirm 配对确认
                                                            └─ 安全码 5 位（两端各显示一次，人眼核对有没有中间人）
   文件密钥 = HKDF-SHA256(kRec, sid8, 'file-v1|'+sid+'|'+fileId)   ← 每个文件独立，绑定会话
   confirm  = HMAC-SHA256(kConfirm, "filebox-xfer-v1/confirm|"+role+"|"+sid)
   传输码本身从不直接当文件密钥用。
```

**帧格式**（`0xfb` + 版本 + 类型 + fileId(4) + chunkIdx(8) + plainLen(4) ‖ 密文 ‖ GCM tag(16)，帧头 19 字节）：

- AES-256-GCM，明文块固定 128 KiB（最后一块为余数）。
- nonce(12B) = `0x78 | type | fileId(4B) | chunkIdx 的低 6 字节(48bit)`，**完全由 (类型, 文件号, 块号) 决定**：
  同一块重传、断点续传、换通道，产生的字节一模一样 → 不存在 nonce 重用，也不会出现"两份不同密文对同一 nonce"。
- AAD = 帧头 + `sid8`：把会话号、文件号、块号、协议版本都绑进认证标签，
  跨会话拼接、分块重排、改内容、改长度、截断，全都在开帧时失败。
- 清单（文件名、相对路径、大小、每块长度、SHA-256）本身是 type=1 的加密帧，用 `kMeta`，服务端读不到。
  相对路径必须在清单里：只给文件名的话，同一批里不同子目录下的两个同名文件在接收端就是同一个东西。
- 接收端先验 GCM 标签再用这块；整文件收齐后再逐块开一遍，比对每块长度、总长度、以及
  "分块 SHA-256 串联后的再哈希" == 清单里的 `sha256`，全部通过才 `verified`。

**密钥只在两端**：服务端 API 没有任何一个接口能递交或取回明文密钥；
刷新后能续传，靠的是浏览器自己 localStorage 里的派生结果，不经过服务器。

---

## 4 自动降级

| 触发 | 行为 |
|---|---|
| 安全上下文 + 有 WebRTC | 先试直连：trickle ICE 交换候选，`p2pTimeoutMs` 内没开成 DataChannel 就转服务器中转 |
| HTTP 入口 / 没有 WebCrypto / 没有 RTCPeerConnection | 直接服务器中转（仍然全程应用层加密，只是慢一点、多一跳） |
| 直连失败 / `disconnected` / `closed` | 关掉 rtc，转 `server_relay`，继续用同一批帧、同一套进度集合，不重发已确认的块 |
| **DataChannel 缓冲满（背压）** | **不是降级理由**。`bufferedAmount` 越过 4MB 高水位就等，等它跌回 1MB 低水位（`bufferedamountlow` + 100ms 轮询双保险）再续发；连续 30 秒排不动才算链路失效并降级 |

背压这一条单独说：以前"缓冲满了"和"通道没了"走的是同一个分支，于是健康的直连一旦被对端
读取速度堵住，剩下的整份文件都会被"额外"PUT 进服务器中转区（界面还写着"直连"）。
现在两者分开，并且发送端会记 `dcFrames` / `relayFrames`：一个字节都没走通道的情况下，
通道标识会立刻如实改成 `server_relay`，不会停在"正在建立直连"。
慢确认也不再被当成丢包 —— 同一帧两次重发之间至少隔 `retryGapMs`（5 秒）。
| 配了 TURN 且拿到短期凭证 | ICE 候选里带 TURN；选中候选对是 relay 类型 → 报 `turn_relay`（UI 写明"不是直连"） |
| TURN 拿不到 / 被防火墙挡 / 仍然不通 | 转服务器中转；三方都不行 → `retrying`/`failed`，给出可操作文案，不会无限等 |
| 中转区写入失败、429 太忙 | 指数退避重试 5 次，再失败就把错误报给用户并且可以续传 |

TURN 凭证是服务端按 coturn 的 REST API 口令方式现算的短期凭证：`username = 过期时间戳:随机串`，
`credential = base64(HMAC-SHA1(TURN_SECRET, username))`，有效期 `TURN_TTL_SECONDS`；
长期共享密钥只留在服务端环境变量里，前端拿不到它。TURN 服务器必须以同一个 `static-auth-secret` 配置才能验通。
没配 `TURN_SECRET` 时服务端不发凭证（静态 `TURN_USER/TURN_PASS` 已不再下发，见 §7），
`/api/xfer/config` 的 `turnConfigured` 也就是 false，前端不会尝试 TURN、不会白等一轮 ICE 超时。

**配对机制的定位（不夸大）**：这里没有用 PAKE。传输码里真正承担安全的部分是
`secret`（120 bit 随机，字母表 32 个字符 × 24 位），它不是"人类可猜的短码"，
服务器或被中途截获的一方都无法靠枚举把它试出来 —— 猜测空间配上"10 分钟内错 30 次就冻 IP"的限流，
离线字典攻击不成立。E2E 密钥由 ECDH 派生，`secret` 只用来算配对凭证，所以拿到 sid+secret
也不等于能解密。剩下的短板是"主动冒充服务器的中间人"：HTTPS 入口下靠 §3 的 ECDH + 两端人工核对安全码挡住；
`kex='code'`（HTTP 入口）这一档没有 ECDH，页面会明确标出来，此时不能声称独立挡住了主动中间人。

---

## 5 API（全部挂在 `/api/xfer/`，凭证只走请求头）

| 方法与路径 | 作用 | 鉴权 | 备注 |
|---|---|---|---|
| `GET /config` | 返回 STUN/TURN 是否可用、TTL 等公共配置 | 无 | 不含密钥 |
| `POST /create` | 建会话：`sid, proof, frames, totalBytes` | proof | 返回一次性 sender token（服务端只存其 SHA-256）。无凭证端点，受 `XFER_CREATE_LIMIT` 限速 |
| `POST /join` | 接收方配对 | proof | 失败计数进限流 |
| `GET /events` | SSE：`joined/key/confirm/offer/answer/ice/ack/done/cancelled` | sender token 或 proof | 断线后服务端补发最近一条同类信令 |
| `POST /signal` | 转发一条信令 | 同上 | kind 白名单：offer/answer/ice/key/confirm/channel-ready/xfer-error |
| `GET /turn` | 领取短期 TURN 凭证 | proof/token | 没配 `TURN_SECRET`（含只配了静态账号的情况）一律 503 |
| `PUT /seg?sid&i` | 上传一帧密文 | sender token | 单帧上限 `XFER_MAX_SEG`，并发上限 `XFER_MAX_INFLIGHT` |
| `GET /seg?sid&i` | 拉一帧密文 | proof | 幂等：同一 i 返回同一字节 |
| `GET /state?sid` | 查 uploaded/acked/frames/totalBytes/expiresAt | 任一凭证 | 只回区间，不回内容 |
| `POST /ack` | 接收方上报"已本地落盘"的块 | proof | 这是三档进度里最高的一档。**语义是信任声明**：P2P 直连的块不过服务器，服务端无法验证，能约束的只有协议帧号空间 |
| `POST /done` / `POST /cancel` | 结束会话 | 任一凭证 | 结束后再保留 `XFER_END_KEEP_MS`，然后连目录一起删 |
| `GET /sessions` | 运维视图：状态与字节数 | 无（只含 sid/计数） | 不含文件名、密钥、凭证 |

`sid` 出现在 URL 查询串里（它是传输码公开的那一半），**`secret`、`proof`、sender token 全在请求头或请求体**，
所以反向代理的访问日志最多记到 sid，凭它解不出内容。

接收链接也一样：整码跟在片段里（`transfer.html#recv?code=…`），浏览器不会把 `#` 之后的内容发给服务器；
页面读到码之后立刻 `replaceState` 把地址擦回 `#recv`。手工拼成 `?code=…` 的链接页面同样认，
但那种写法会整条进访问日志 —— HTTP 入口下等价于把解密密钥写进日志，见 §9 第 8 条。

---

## 6 配置（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `TRANSFER_DIR` | `./.transfer` | 中转区根目录，必须与 `UPLOAD_DIR` 分开（已在 `.gitignore` 里） |
| `XFER_TTL_MINUTES` | 30 | 会话有效期；到点清密文 + 账本，旧码作废 |
| `XFER_LIMIT_GB` | 2 | 中转区总配额（按**真正落盘的密文字节**计；点对点直连一个字节都不进中转区，所以不受它限制） |
| `XFER_MAX_SESSIONS` | 20 | 同时存在的会话数 |
| `XFER_MAX_INFLIGHT` | 8 | 同时在写的分块数（超过回 429） |
| `XFER_MAX_SEG` | 8 MiB | 单帧上限 |
| `XFER_MAX_FRAMES` | 200000 | 单会话帧数上限（≈25 GB @128 KiB） |
| `XFER_JOIN_FAIL_LIMIT` | 30 / 10 分钟 | 猜码代价，超了冻结该 IP |
| `XFER_CREATE_LIMIT` | 10 / 10 分钟 | 无凭证 create 的限速：不给刷会话把别人的活跃会话挤掉的机会 |
| `XFER_END_KEEP_MS` | 60000 | 完成后/取消后密文再留多久 |
| `STUN_URLS` | 空 | 逗号分隔 |
| `TURN_URLS` | 空 | 逗号分隔 |
| `TURN_SECRET` | 空 | 短期凭证的 HMAC 根密钥；不配就不会用 TURN |
| `TURN_USER` / `TURN_PASS` | 空 | **已不再下发**：`/api/xfer/create` 是无凭证端点，任何人自建会话、自己配对就能把这份长期账号领走。配了它们而没配 `TURN_SECRET` 时启动会打一行提示，`/turn` 一律 503。请给 coturn 配 `static-auth-secret` 并用 `TURN_SECRET` |
| `TURN_TTL_SECONDS` | 3600 | 短期 TURN 口令有效期 |
| `TRUST_PROXY` | 空（server.js） | 反代部署时设 `1`，`req.ip` 才是真实客户端地址；限流按 IP 记账，反代不设的话所有用户共享一个桶 |

`ecosystem.config.js` 里给了 `TRANSFER_DIR` 与 `XFER_*` 的示例条目。

---

## 7 断点续传的实际做法

**发送端**：本地记录（localStorage）存 `code / expiresAt / frames / totalBytes / safety / kex / token / 会话密钥`
和每个文件的 `{relPath, name, size, sha256}`。重新选文件时逐个核对：清单里没有这个 relPath、
大小变了、内容 SHA-256 变了 → 直接拒绝续传并说明原因；密钥记录丢了（换浏览器/清了站点数据）→ 明确告知无法恢复，
不会假装能续。加密上下文（文件密钥、nonce 规则）完全复用，所以重传字节一致。

**接收端**：只把"已通过 GCM 标签验证的密文帧"写进 IndexedDB（key = `sid#seq`）。
续传时先把本地已有的 seq 认领回来（不重下），清单帧也从本地读回来恢复布局，
然后只向服务器补拉"服务器有、本地没有"的块；三档确认（发送端已上传 / 服务端已记账 / 接收端已落盘）各自独立，
最后一个块落盘后才走 `verifying → ready`。

**生命周期**：短暂断网、SSE 断开、P2P 掉线都只影响通道，不销毁恢复数据；
真正销毁只发生在：会话过期、任一方取消、完成后超过 `XFER_END_KEEP_MS`。

**做不到也要说**：接收端本地暂存上限取决于浏览器给的存储配额；浏览器不支持 IndexedDB 或配额被拒时，
页面在能力横幅里直接写明"接收端断线恢复不可用"，并且没有文件系统访问接口的浏览器保存大文件会占内存。

---

## 8 服务端存的到底是什么

`TRANSFER_DIR/<sid>/`：`meta.json`（sid、proof 的 SHA-256、发送方令牌的 SHA-256、帧数、字节数、过期时间、状态）、
`seg-<i>.bin`（一帧密文，文件名是序号，不含原名）。没有明文、没有密钥、没有真实文件名。
配对凭证与发送方令牌都只落 SHA-256：能读到这个目录的人也拿不到可重放的凭证。
权限随进程默认 umask，目录与 `uploads/` 逻辑隔离，正式列表/下载接口读不到它。
重启时 `bootReclaim` 会把"写了一半的 .tmp"清掉、未过期会话保留、账本从磁盘重建（bytes 按磁盘实况修正）。

清理路径：完成 / 取消 / 过期 / 服务重启后的残留 tmp，都有对应代码路径；测试里逐条断言过目录真的消失。

---

## 9 安全边界（不夸大的部分）

1. **服务器不是不可见**。它知道：有会话、sid、帧数、字节数、时间戳、双方 IP、谁在猜码。
   它不知道：文件名、内容、明文长度之外的结构（128 KiB 对齐会泄露量级，最后一块会暴露文件大小模 128 KiB 的余数）。
2. **`kex='code'` 的降级路径**（HTTP 入口）不建立在 ECDH 上，因此**不能独立挡住一个主动冒充的服务器**；
   此时安全性依赖"传输码的 120 bit secret 没被第三方拿到"。页面在这条路上会明确显示当前不是 ECDH。
   HTTPS 入口走 ECDH + 安全码核对，两边数字一致才认为链路上没有别人。
3. **TLS 不替代应用层加密**，反过来应用层加密也不替代 TLS：HTTP 入口下任何人都能看到 sid 和流量模式。
4. **密文会落盘**。为了支持重启后续传，中转帧写在磁盘上；这等于承认"服务器被取证时密文可被拿到"，
   能不能解开取决于 §3 的密钥有没有离开过两端。
5. **物理擦除不承诺**。删除是逻辑删除（unlink）；SSD 磨损均衡、快照、备份、文件系统残留不在保证范围内。
6. **离线不是完整支持**。双方必须都在线才能推进；发送方离线时接收端只能拿到已经上传的块，会话过期后旧码作废。
7. 传输码是一次性的：会话做完/取消/过期后同一个码不能再开，也不会重发新码。
8. **接收链接就是传输码的另一种写法**。它带完整码（含那 120 bit secret），放在 `#` 片段里所以不进服务器与代理的
   访问日志，页面读完后 `replaceState` 也会把当前历史项擦成 `#recv`（所以浏览器历史里留不下）——
   但**发出去的那条聊天消息 / 邮件本身就是密钥**：`kex='code'`（HTTP 入口）下拿到链接等于能直接解密，
   HTTPS + ECDH 下拿到链接也只能冒充接收方去收密文，还得躲过安全码核对。别把链接发到不信任的群里。

---

## 10 测试与验证口径

`node --test "test/*.test.js"`（注意：这个仓库里 `node --test test/` 会报 Cannot find module，必须用 glob 形式）。

- **真正执行**：Node 侧会话/信令/中转/限流/过期/重启/篡改与拼接拒绝等 47 项；
  `test/big.test.js` 用 600 MB 真实文件走中转（分块读写、峰值 RSS、前后 SHA-256、盘上无明文无原名）。
  浏览器侧真机跑过：P2P 直连成功（三文件含 512 KiB/19 B/0 B，SHA-256 全等）、服务器中转独立完成、
  刷新后恢复会话（本地 49 块直接认领、只补拉缺的 16 块、进度不回零）、多文件含空文件与中文/空格/`#` 名。
- **模拟**：把 `capabilities().rtc` 强制关掉来验证"没有 WebRTC 时中转独立可用"。
- **环境受限/未跑**：真实跨 NAT 的公网直连、真实 TURN 服务器（本机没有 TURN 服务，只验了配置与凭证签发路径，
  未验 relay 候选的实际转发）、数 GB 级单文件（配额与 `XFER_MAX_FRAMES` 允许，但本轮没跑）。
