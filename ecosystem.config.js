module.exports = {
  apps: [
    {
      name: 'file-box',
      script: 'server.js',
      env: {
        PORT: 4444,        // HTTP 端口（可直接用）
        HTTPS_PORT: 3443,  // HTTPS 端口（推荐，首次访问需信任自签证书一次）
        STORAGE_LIMIT_GB: 10,
        UPLOAD_DIR: './uploads',        // 批次密文（可以指到大盘）
        STAGING_DIR: './.uploading',    // 未完成分块暂存（与 uploads 可以跨盘）
        LIBRARY_DIR: './.library',      // 目录索引（NeDB），不要放进 uploads
        DOWNLOADS_FILE: './.stats/downloads.json', // 下载账本（含只增不减的 __total__）
        TTL_SWEEP_MS: 60000,       // 批次 TTL 扫描间隔
        MAX_FOLDERS: 10000,        // 无认证环境的目录数量保护上限
        UPLOAD_TTL_HOURS: 48, // 未完成的断点续传批次留 2 天，超时回收
        // ---- 限速与并发（都在进程内存里，重启清零；不是权限，换 IP 就能绕开）----
        MAX_EGRESS: 32,            // 下载 + 归档共用的并发名额，满了回 429
        INIT_PER_WINDOW: 60,       // 每个 IP 每窗口允许多少次「开始上传」
        LIBRARY_PER_WINDOW: 240,   // 每个 IP 每窗口允许多少次「刷新列表」（一个页面 6 次/分）
        RATE_WINDOW_MS: 60000,     // 上面两个桶的窗口长度
        SCAN_CACHE_MS: 1500,       // /api/library 扫盘缓冲；走 API 的改动会立刻让它失效
        MEM_DOWNLOAD_MAX_MB: 50,   // 没有可写 OPFS 的浏览器单文件下载内存上限（有 OPFS 的不受限）
        // TRUST_PROXY: 1,         // 反代后必须打开，否则所有客户端共用一个 IP 桶
        // ---- 无痕传输（详见 docs/transfer.md）----
        TRANSFER_DIR: './.transfer', // 密文中转区，必须与 uploads 分开（与 server.js 默认值一致）
        XFER_TTL_MINUTES: 30,       // 会话有效期，到点清密文与账本
        XFER_LIMIT_GB: 8,           // 中转区总配额（要比你实际想传的单文件大；直连不占它）
        XFER_MAX_SESSIONS: 20,
        XFER_MAX_INFLIGHT: 8,       // 同时写入的分块数，超了回 429
        // 内置 STUN（udp）。局域网直连全靠它：Chrome 把 host 候选写成 mDNS 名，跨机器常常解析不了，
        // 于是两端明明在同一交换机上也只能走服务器中转（实测 4MB/s）。设 0 可关掉。
        STUN_PORT: 3478,
        // 跨网段直连才能用到下面这两个；同一个局域网通常内置 STUN 就够了
        STUN_URLS: '',              // 如 stun:stun.l.google.com:19302（与内置 STUN 并存，会一起下发）
        TURN_URLS: '',              // 如 turn:turn.example.com:3478?transport=udp
        TURN_SECRET: '',            // coturn static-auth-secret：服务端用来签发短期口令，别提交进仓库
        TURN_TTL_SECONDS: 3600,
      },
      max_memory_restart: '512M',
    },
  ],
};