/**
 * Resumable, frame-aware streaming zstd line reader for the Lichess dumps.
 *
 * The monthly dumps are written by a parallel compressor: a sequence of independent zstd frames, each preceded
 * by a 12-byte skippable frame holding the compressed size of the frame that follows. Node's streaming
 * `zlib.createZstdDecompress()` ends after the FIRST frame (the skippable one), so `zstUrlLines` from
 * scripts/lib/pack.ts yields nothing for these files. This reader splits the byte stream into frames itself
 * (using the size hint, or by walking the block headers when there is none) and decompresses each frame with
 * `zstdDecompressSync`. Because only raw compressed bytes are buffered, a dropped connection is resumed with an
 * HTTP `Range: bytes=<offset>-` request and no decoder state is lost.
 */
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';

export interface StreamStatus {
  /** Compressed bytes received so far. */
  offset: number;
  frames: number;
  reconnects: number;
  /** Set when the stream gave up (retries exhausted, Range not honoured, corrupt frame); the iterator then ends quietly. */
  failed: string | null;
  /** True when the end of the remote file was reached. */
  finished: boolean;
}

export function newStreamStatus(): StreamStatus {
  return { offset: 0, frames: 0, reconnects: 0, failed: null, finished: false };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ZSTD_MAGIC = 0xfd2fb528;

/** Size in bytes of the zstd frame starting at buf[0], or null when more bytes are needed. Throws on a bad header. */
export function zstdFrameSize(buf: Buffer): number | null {
  if (buf.length < 6) return null;
  if (buf.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error('not a zstd frame');
  const fhd = buf[4] as number;
  const single = (fhd >> 5) & 1;
  const fcsCode = fhd >> 6;
  const dictCode = fhd & 3;
  const checksum = (fhd >> 2) & 1;
  const fcsBytes = fcsCode === 0 ? (single ? 1 : 0) : fcsCode === 1 ? 2 : fcsCode === 2 ? 4 : 8;
  const dictBytes = dictCode === 3 ? 4 : dictCode;
  let p = 5 + (single ? 0 : 1) + dictBytes + fcsBytes;
  for (;;) {
    if (buf.length < p + 3) return null;
    const hdr = (buf[p] as number) | ((buf[p + 1] as number) << 8) | ((buf[p + 2] as number) << 16);
    const last = hdr & 1;
    const type = (hdr >> 1) & 3;
    const size = hdr >> 3;
    if (type === 3) throw new Error('reserved zstd block type');
    p += 3 + (type === 1 ? 1 : size);
    if (last) {
      p += checksum ? 4 : 0;
      return buf.length >= p ? p : null;
    }
  }
}

export async function* resumableZstUrlLines(
  url: string,
  status: StreamStatus,
  opts: { maxRetries?: number; stallMs?: number; log?: (msg: string) => void } = {},
): AsyncGenerator<string> {
  const maxRetries = opts.maxRetries ?? 25;
  const stallMs = opts.stallMs ?? 90_000;
  const log = opts.log ?? ((m: string) => console.warn(m));
  let ac: AbortController | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let chunks: Buffer[] = [];
  let have = 0;
  let eof = false;

  /** Reads one more network chunk into the buffer, reconnecting as needed. False at EOF or after giving up. */
  const readMore = async (): Promise<boolean> => {
    let attempt = 0;
    while (!eof && !status.failed) {
      try {
        if (!reader) {
          ac = new AbortController();
          const res = await fetch(url, { headers: status.offset ? { Range: `bytes=${status.offset}-` } : {}, signal: ac.signal });
          if (status.offset && res.status === 416) {
            eof = true;
            break;
          }
          if (status.offset && res.status !== 206) {
            status.failed = `server ignored Range (HTTP ${res.status}); cannot resume`;
            break;
          }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        }
        const ctl = ac;
        const timer = setTimeout(() => ctl?.abort(new Error('stalled')), stallMs);
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } finally {
          clearTimeout(timer);
        }
        if (r.done) {
          eof = true;
          break;
        }
        status.offset += r.value.byteLength;
        chunks.push(Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength));
        have += r.value.byteLength;
        return true;
      } catch (e) {
        reader = null;
        attempt++;
        status.reconnects++;
        if (attempt > maxRetries) {
          status.failed = `gave up after ${maxRetries} retries: ${(e as Error).message}`;
          break;
        }
        log(`[stream] connection problem at ${(status.offset / 1e6).toFixed(1)} MB (${(e as Error).message}); retry ${attempt}/${maxRetries}`);
        await sleep(Math.min(60_000, 3000 * attempt));
      }
    }
    return false;
  };
  /** Ensures `n` buffered bytes and returns the buffer (collapsed), or null when the stream ended first. */
  const need = async (n: number): Promise<Buffer | null> => {
    while (have < n) if (!(await readMore())) return null;
    if (chunks.length !== 1) chunks = [Buffer.concat(chunks)];
    return chunks[0] as Buffer;
  };
  const consume = (n: number): void => {
    const b = chunks[0] as Buffer;
    chunks = [b.subarray(n)];
    have -= n;
  };

  const sd = new StringDecoder('utf8');
  let carry = '';
  let hint = 0;
  try {
    for (;;) {
      const head = await need(4);
      if (!head) break;
      const magic = head.readUInt32LE(0);
      if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
        const h = await need(8);
        if (!h) break;
        const len = h.readUInt32LE(4);
        const full = await need(8 + len);
        if (!full) break;
        hint = len === 4 ? full.readUInt32LE(8) : 0;
        consume(8 + len);
        continue;
      }
      if (magic !== ZSTD_MAGIC) {
        status.failed = `unexpected magic 0x${magic.toString(16)} at a frame boundary`;
        break;
      }
      let size: number | null = hint > 0 ? hint : null;
      hint = 0;
      let buf: Buffer | null = head;
      if (size === null) {
        for (;;) {
          size = zstdFrameSize(buf as Buffer);
          if (size !== null) break;
          buf = await need(have + 1);
          if (!buf) break;
        }
        if (size === null) break;
      }
      buf = await need(size);
      if (!buf) break;
      let plain: Buffer;
      try {
        plain = zlib.zstdDecompressSync(buf.subarray(0, size));
      } catch (e) {
        status.failed = `decompress: ${(e as Error).message}`;
        break;
      }
      consume(size);
      status.frames++;
      const parts = (carry + sd.write(plain)).split('\n');
      carry = parts.pop() ?? '';
      for (const p of parts) yield p;
    }
    if (eof && !status.failed) {
      status.finished = true;
      if (carry) yield carry;
    }
  } finally {
    (ac as AbortController | null)?.abort();
  }
}
