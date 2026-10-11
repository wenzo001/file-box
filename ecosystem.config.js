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
      },
      max_memory_restart: '512M',
    },
  ],
};