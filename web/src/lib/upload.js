// 上传任务：复用原上传引擎的分块规划 / 批次指纹 / 加密 / CRC 语义，只把 DOM 换成 Vue 状态。
import { api } from './api.js';

const UPLOAD_TARGET = 4 * 1024 * 1024;
const PLAIN_BLOCK = 512 * 1024;
const PAD_UNIT = 64 * 1024;
const UPLOAD_PARALLEL = 3;
const CHUNK_ATTEMPTS = 3;
const te = new TextEncoder();

const blockBytes = (plain) => plain + 32;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function planFile(size, pad = true) {
  const blocks = [];
  let left = size || 0;
  if (!left) blocks.push(blockBytes(0));
  while (left > 0) {
    const plain = Math.min(PLAIN_BLOCK, left);
    blocks.push(blockBytes(plain));
    left -= plain;
  }
  const raw = blocks.reduce((a, b) => a + b, 0);
  const padPlain = pad ? Math.ceil((raw + 32) / PAD_UNIT) * PAD_UNIT - raw - 32 : 0;
  const plan = [];
  let cur = 0, p0 = 0, plainEnd = 0;
  for (const b of blocks) {
    cur += b;
    plainEnd += b - 32;
    if (cur >= UPLOAD_TARGET) {
      plan.push({ bytes: cur, p0, p1: plainEnd, padPlain: 0 });
      cur = 0;
      p0 = plainEnd;
    }
  }
  if (cur || !plan.length) plan.push({ bytes: cur, p0, p1: plainEnd, padPlain: 0 });
  if (padPlain > 0) {
    const last = plan[plan.length - 1];
    last.bytes += 32 + padPlain;
    last.padPlain = padPlain;
  }
  return plan;
}

export const relPath = (f) => f.webkitRelativePath || f.name;
export const fileKey = (f) => `${relPath(f)}@${f.size}@${f.lastModified || 0}`;

export function sortSelected(files) {
  return files.sort((a, b) => {
    const x = relPath(a), y = relPath(b);
    if (x !== y) return x < y ? -1 : 1;
    return a.size - b.size || (a.lastModified || 0) - (b.lastModified || 0);
  });
}

function localSalt(raw) {
  const slot = `fb-upload-salt:${FBCrypto.hashHex(raw).slice(0, 16)}`;
  try {
    const hit = localStorage.getItem(slot);
    if (hit) return hit;
  } catch { /* 隐私模式 */ }
  const fresh = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(slot, fresh); } catch { /* 隐私模式 */ }
  return fresh;
}

export function batchIdentity(files) {
  const raw = `filebox-upload-v1\n${files.length}\n${files.map((f) => `${relPath(f)}\t${f.size}\t${f.lastModified || 0}`).join('\n')}`;
  const salt = localSalt(raw);
  return { salt, key: FBCrypto.hashHex(`${salt}\n${raw}`) };
}

const encNameOf = (key, i) => `f_${key.slice(0, 12)}${i.toString(16).padStart(2, '0')}.enc`;

export function planBatch(key, files) {
  const items = files.map((f, i) => ({ name: relPath(f), size: f.size, enc: encNameOf(key, i) }));
  const manifestBytes = te.encode(JSON.stringify({ v: 1, files: items }));
  const layout = files.map((f, i) => ({ enc: items[i].enc, plan: planFile(f.size) }));
  layout.push({ enc: 'manifest.enc', plan: planFile(manifestBytes.length, false), manifestBytes });
  for (const f of layout) f.chunks = f.plan.map((c) => c.bytes);
  return { layout, manifestBytes };
}

function concat(parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function encryptChunk(spec, file, ci) {
  const parts = [];
  if (spec.manifestBytes) {
    parts.push(await FBCrypto.encryptBytes(spec.manifestBytes));
  } else {
    const seg = spec.plan[ci];
    if (seg.p1 === seg.p0) {
      parts.push(await FBCrypto.encryptBytes(new Uint8Array(0)));
    } else {
      for (let off = seg.p0; off < seg.p1; off += PLAIN_BLOCK) {
        const end = Math.min(off + PLAIN_BLOCK, seg.p1);
        const ab = await file.slice(off, end).arrayBuffer();
        parts.push(await FBCrypto.encryptBytes(new Uint8Array(ab)));
      }
    }
    if (seg.padPlain) parts.push(await FBCrypto.encryptBytes(new Uint8Array(seg.padPlain)));
  }
  let c = 0xffffffff;
  for (const p of parts) c = FBCrypto.crcFeed(p, c);
  return { body: concat(parts), crc: FBCrypto.crcDone(c).toString(16).padStart(8, '0') };
}

export class UploadTask {
  constructor(files, { folderId = null, ttlHours = null, onUpdate = () => {} } = {}) {
    this.files = files;
    this.folderId = folderId || null;
    // null = 交给服务端按「公共配置区」的全局设置定稿
    this.ttlHours = Number.isFinite(ttlHours) ? ttlHours : null;
    this.onUpdate = onUpdate;
    this.state = 'queued';
    this.uploadId = '';
    this.key = '';
    this.plan = null;
    this.have = new Set();
    this.total = 0;
    this.doneBytes = 0;
    this.error = '';
    this.result = null;
    this.paused = false;
    this.cancelled = false;
    this.abort = null;
  }

  get title() {
    if (this.files.length === 1) return relPath(this.files[0]);
    return `${relPath(this.files[0])} 等 ${this.files.length} 个文件`;
  }

  emit() {
    this.onUpdate({
      state: this.state,
      done: this.have.size,
      total: this.total,
      doneBytes: this.doneBytes,
      uploadId: this.uploadId,
      error: this.error,
      result: this.result,
    });
  }

  bytesOfHave() {
    let n = 0;
    if (!this.plan) return 0;
    for (let fi = 0; fi < this.plan.layout.length; fi++) {
      this.plan.layout[fi].chunks.forEach((bytes, ci) => {
        if (this.have.has(`${fi}-${ci}`)) n += bytes;
      });
    }
    return n;
  }

  async init() {
    const { key } = batchIdentity(this.files);
    this.key = key;
    this.plan = planBatch(key, this.files);
    const r = await api.uploadInit({
      key,
      files: this.plan.layout.map(({ enc, chunks }) => ({ enc, chunks })),
      folderId: this.folderId,
      ttlHours: this.ttlHours,
    });
    this.uploadId = r.uploadId;
    this.have = new Set(r.have.map((p) => `${p.f}-${p.c}`));
    this.total = r.total;
    this.doneBytes = this.bytesOfHave();
    this.meta = r;
    this.emit();
  }

  async putChunk(fi, ci, body, crc) {
    let lastErr = new Error('上传失败');
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      if (this.paused || this.cancelled) throw new Error(this.cancelled ? '已取消' : '已暂停');
      let res = null;
      let data = {};
      try {
        res = await api.uploadPart(this.uploadId, fi, ci, body, crc, this.abort?.signal);
        if (res.ok) return;
        data = await res.json().catch(() => ({}));
      } catch (err) {
        if (this.paused || this.cancelled || err.name === 'AbortError') throw err;
      }
      const status = res ? res.status : 0;
      lastErr = new Error(data.error || `第 ${fi + 1} 个文件第 ${ci + 1} 块上传失败`);
      const retry = status === 0 || status >= 500 || status === 408 || status === 429 || /校验不通过/.test(data.error || '');
      if (!retry) throw lastErr;
      if (attempt < CHUNK_ATTEMPTS) await sleep(300 * attempt);
    }
    throw lastErr;
  }

  async sendChunk(fi, ci) {
    if (this.paused || this.cancelled) return;
    const spec = this.plan.layout[fi];
    const { body, crc } = await encryptChunk(spec, this.files[fi], ci);
    if (body.length !== spec.chunks[ci]) throw new Error('分块大小不符，请重试');
    if (this.paused || this.cancelled) return;
    await this.putChunk(fi, ci, body, crc);
    this.have.add(`${fi}-${ci}`);
    this.doneBytes += spec.chunks[ci];
    this.emit();
  }

  async run() {
    if (this.cancelled || this.state === 'done') return;
    this.paused = false;
    this.state = 'running';
    this.error = '';
    this.abort = new AbortController();
    this.emit();
    try {
      if (!this.plan || !this.uploadId) await this.init();
      const todo = [];
      for (let fi = 0; fi < this.plan.layout.length; fi++) {
        for (let ci = 0; ci < this.plan.layout[fi].chunks.length; ci++) {
          if (!this.have.has(`${fi}-${ci}`)) todo.push({ fi, ci });
        }
      }
      let cursor = 0;
      const workers = Array.from({ length: Math.min(UPLOAD_PARALLEL, todo.length) }, async () => {
        for (;;) {
          if (this.paused || this.cancelled) return;
          const index = cursor++;
          if (index >= todo.length) return;
          const { fi, ci } = todo[index];
          await this.sendChunk(fi, ci);
        }
      });
      await Promise.all(workers);
      if (this.paused) { this.state = 'paused'; this.emit(); return; }
      if (this.cancelled) { this.state = 'canceled'; this.emit(); return; }
      this.state = 'finishing';
      this.emit();
      const out = await api.uploadFinish(this.uploadId);
      this.result = out;
      this.state = 'done';
      this.emit();
    } catch (err) {
      if (this.cancelled) this.state = 'canceled';
      else if (this.paused) this.state = 'paused';
      else { this.state = 'failed'; this.error = err.message || '上传失败'; }
      this.emit();
    } finally {
      this.abort = null;
    }
  }

  pause() {
    if (this.state !== 'running' && this.state !== 'finishing') return;
    this.paused = true;
    if (this.abort) this.abort.abort();
    this.state = 'paused';
    this.emit();
  }

  async resume() {
    if (this.cancelled || this.state === 'done') return;
    this.paused = false;
    await this.run();
  }

  async cancel() {
    if (this.state === 'done' || this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    if (this.abort) this.abort.abort();
    if (this.uploadId) await api.cancelUpload(this.uploadId).catch(() => {});
    this.state = 'canceled';
    this.emit();
  }
}
