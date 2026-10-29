// 按块读流的队列：只要"恰好 n 字节"，不多留。
// 旧实现每来一个网络分片就 new 一个 (旧长度+新长度) 的数组再拷一遍 —— 4MB 块配 64KB 分片
// 要拷 ≈128MB，放大 32 倍。这里只保留未消费的分片，take() 一次分配一块。
export class ChunkQueue {
  constructor(reader) {
    this.reader = reader;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
  }

  async fill(n) {
    while (this.buffered < n && !this.ended) {
      const { done, value } = await this.reader.read();
      if (done) { this.ended = true; break; }
      if (value && value.length) { this.chunks.push(value); this.buffered += value.length; }
    }
  }

  /** 取恰好 n 字节；流提前结束就抛（调用方按"数据不完整"处理） */
  async take(n) {
    await this.fill(n);
    if (this.buffered < n) throw new Error('数据不完整：网络断了或服务器提前结束，请重试');
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const need = n - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.buffered -= head.length;
        this.chunks.shift();
      } else {
        // subarray 是视图，不复制：剩下的部分留在队首继续用
        out.set(head.subarray(0, need), off);
        this.chunks[0] = head.subarray(need);
        this.buffered -= need;
        off += need;
      }
    }
    return out;
  }
}

/** 把 ReadableStream 包成 ChunkQueue（浏览器里 body 就是它） */
export function queueOf(stream) {
  return new ChunkQueue(stream.getReader());
}
