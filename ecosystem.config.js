module.exports = {
  apps: [
    {
      name: 'file-box',
      script: 'server.js',
      env: {
        PORT: 4444,        // HTTP 端口（可直接用）
        HTTPS_PORT: 3443,  // HTTPS 端口（推荐，首次访问需信任自签证书一次）
        STORAGE_LIMIT_GB: 10,
        LIBRARY_DIR: './.library', // 目录索引（NeDB），不要放进 uploads
        TTL_SWEEP_MS: 60000,       // 批次 TTL 扫描间隔
        UPLOAD_TTL_HOURS: 48, // 未完成的断点续传批次留 2 天，超时回收
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