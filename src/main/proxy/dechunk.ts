/**
 * Minimal `Transfer-Encoding: chunked` decoder.
 *
 * Icecast itself sends identity bodies, but CDN-fronted mounts sometimes chunk
 * them. Since the upstream client speaks raw HTTP, nothing else strips the
 * framing, and a single chunk header left inline would desynchronise the ICY
 * demuxer for the rest of the session.
 */
export class Dechunker {
  private mode: 'size' | 'data' | 'crlf' | 'trailer' | 'done' = 'size';
  private line = '';
  private remaining = 0;

  push(chunk: Buffer): Buffer {
    const out: Buffer[] = [];
    let i = 0;

    while (i < chunk.length && this.mode !== 'done') {
      if (this.mode === 'data') {
        const take = Math.min(this.remaining, chunk.length - i);
        out.push(chunk.subarray(i, i + take));
        i += take;
        this.remaining -= take;
        if (this.remaining === 0) this.mode = 'crlf';
        continue;
      }

      const byte = chunk[i]!;
      i += 1;

      if (this.mode === 'crlf') {
        if (byte === 0x0a) this.mode = 'size';
        continue;
      }

      if (byte !== 0x0a) {
        if (byte !== 0x0d) this.line += String.fromCharCode(byte);
        if (this.line.length > 1024) throw new Error('chunked framing: oversized line');
        continue;
      }

      const line = this.line;
      this.line = '';

      if (this.mode === 'trailer') {
        if (line === '') this.mode = 'done';
        continue;
      }

      const size = Number.parseInt(line.split(';')[0]!.trim(), 16);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error(`chunked framing: bad size ${JSON.stringify(line)}`);
      }
      if (size === 0) {
        this.mode = 'trailer';
      } else {
        this.remaining = size;
        this.mode = 'data';
      }
    }

    return out.length === 1 ? out[0]! : Buffer.concat(out);
  }

  get finished(): boolean {
    return this.mode === 'done';
  }
}
