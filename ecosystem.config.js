module.exports = {
  apps: [
    {
      name: 'file-box',
      script: 'server.js',
      env: {
        PORT: 4444,        // HTTP 端口（可直接用）
        HTTPS_PORT: 3443,  // HTTPS 端口（推荐，首次访问需信任自签证书一次）
        STORAGE_LIMIT_GB: 10,
        RETENTION_DAYS: 90,
        UPLOAD_TTL_HOURS: 48, // 未完成的断点续传批次留 2 天，超时回收
        // ---- 无痕传输（详见 docs/transfer.md）----
        TRANSFER_DIR: './transfer', // 密文中转区，必须与 uploads 分开
        XFER_TTL_MINUTES: 30,       // 会话有效期，到点清密文与账本
        XFER_LIMIT_GB: 2,           // 中转区总配额
        XFER_MAX_SESSIONS: 20,
        XFER_MAX_INFLIGHT: 8,       // 同时写入的分块数，超了回 429
        // 跨网段直连需要 STUN；两边都不通才用 TURN，两边都配了才会尝试 TURN
        STUN_URLS: '',              // 如 stun:stun.l.google.com:19302
        TURN_URLS: '',              // 如 turn:turn.example.com:3478?transport=udp
        TURN_SECRET: '',            // coturn static-auth-secret：服务端用来签发短期口令，别提交进仓库
        TURN_TTL_SECONDS: 3600,
      },
      max_memory_restart: '512M',
    },
  ],
};