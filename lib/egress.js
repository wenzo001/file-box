// 把密文吐给浏览器：单文件下载（支持 Range 续传）与整目录归档（一条流，不压缩）。
// 两条都属于"一直占着连接吐字节"的路，共用同一个并发名额池：不限并发，匿名者开 200 个归档
// 就能把文件句柄吃光，之后整台机器连页面都打不开。名额在响应结束/断开时归还。
// 路径闸门（resolveFolder/resolveFile）与下载计数由 server.js 注入 —— 这里不认识目录树。
const fs = require('fs');
const path = require('path');

function createEgress({ resolveFolder, resolveFile, countDownload, manifest, maxInFlight = 32 }) {
  let inFlight = 0;

  const gate = (req, res, next) => {
    if (inFlight >= maxInFlight) {
      res.setHeader('Retry-After', '2');
      return res.status(429).json({ error: '服务器正在同时传输的文件太多，请稍后重试' });
    }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.on('finish', release);
    res.on('close', release);
    next();
  };

  /** 单文件：Range 续传从断点起；续传请求（起点 > 0）不重复计下载次数 */
  const download = (req, res) => {
    const folderReal = resolveFolder(req.params.folder);
    const fp = resolveFile(folderReal, req.params.file);
    if (!fp) return res.status(404).json({ error: '文件不存在' }); // 不区分"名字不合法/不在界内/不存在"，不给探测者反馈
    const folderName = path.basename(folderReal);
    const fileName = path.basename(fp);
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (m && (m[1] !== '' || m[2] !== '')) {
        let stat;
        try { stat = fs.statSync(fp); } catch { return res.status(404).json({ error: '文件不存在' }); }
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null) {
          start = Math.max(0, stat.size - end);
          end = stat.size - 1;
        } else if (end === null || end >= stat.size) {
          end = stat.size - 1;
        }
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= stat.size) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
          return res.end();
        }
        if (start === 0) countDownload(folderName, fileName);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        const stream = fs.createReadStream(fp, { start, end });
        stream.on('error', () => {
          if (!res.headersSent) res.status(500).end();
          else res.destroy();
        });
        stream.pipe(res);
        return;
      }
    }

    countDownload(folderName, fileName); // 走到这里才算是"开始吐字节"
    res.download(fp, fileName);
  };

  // 帧格式：[2B 名长][文件名 UTF-8][8B 数据长(大端)][数据]；清单放最前，客户端先解出真实文件名
  const archive = async (req, res) => {
    const dir = resolveFolder(req.params.folder);
    if (!dir) return res.status(404).json({ error: '目录不存在' });
    let parts;
    try {
      parts = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name !== `${manifest}.tmp`)
        .map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size }));
    } catch {
      return res.status(404).json({ error: '目录不存在' });
    }
    if (!parts.length) return res.status(404).json({ error: '目录为空' });
    // 归档 = 整包被取走一次：每个文件各记一次（清单文件仍不记），目录级汇总就是它们的和
    parts.forEach((p) => countDownload(path.basename(dir), p.name));
    parts.sort((a, b) =>
      a.name === manifest ? -1 : b.name === manifest ? 1 : a.name.localeCompare(b.name));

    const total = parts.reduce((s, p) => s + 10 + Buffer.byteLength(p.name) + p.size, 0);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(total));
    res.setHeader('Cache-Control', 'no-store');

    let body = null; // 当前正在读的文件流，客户端断开时要关掉
    res.on('close', () => body && body.destroy());
    const write = (b) =>
      res.write(b) ? Promise.resolve(true) : new Promise((r) => res.once('drain', () => r(!res.writableEnded)));

    try {
      for (const p of parts) {
        const nameB = Buffer.from(p.name, 'utf8');
        const head = Buffer.alloc(10 + nameB.length);
        head.writeUInt16BE(nameB.length, 0);
        head.writeBigUInt64BE(BigInt(p.size), 2);
        nameB.copy(head, 10);
        if (!(await write(head))) return;
        body = fs.createReadStream(path.join(dir, p.name), { highWaterMark: 1024 * 1024 });
        for await (const chunk of body) if (!(await write(chunk))) break;
        body.destroy();
        body = null;
        if (res.writableEnded) return;
      }
      res.end();
    } catch {
      if (body) body.destroy();
      if (!res.headersSent) res.status(500).json({ error: '打包失败' });
      else res.destroy();
    }
  };

  return { gate, download, archive, inFlight: () => inFlight };
}

module.exports = { createEgress };
