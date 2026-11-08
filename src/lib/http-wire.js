import { coreError } from "./errors.js";
const CRLF = new Uint8Array([13, 10]);
const decoder = new TextDecoder("latin1");
export class WireReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array();
    this.ended = false;
  }
  async more() {
    if (this.ended) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return false;
    }
    if (value?.length) {
      const joined = new Uint8Array(this.buffer.length + value.length);
      joined.set(this.buffer);
      joined.set(value, this.buffer.length);
      this.buffer = joined;
    }
    return true;
  }
  take(n) {
    const part = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return part;
  }
  async line(limit = 65536) {
    let scan = 0;
    while (true) {
      for (let i = scan; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === CRLF[0] && this.buffer[i + 1] === CRLF[1]) {
          if (i > limit) throw coreError("HTTP_HEADER_LIMIT");
          const part = this.take(i);
          this.take(2);
          return decoder.decode(part);
        }
      }
      if (this.buffer.length > limit)
        throw coreError("HTTP_HEADER_LIMIT");
      scan = Math.max(0, this.buffer.length - 1);
      if (!(await this.more())) throw coreError("HTTP_MESSAGE_TRUNCATED");
    }
  }
  async some(max = 65536) {
    while (!this.buffer.length) {
      if (!(await this.more())) return null;
    }
    return this.take(Math.min(max, this.buffer.length));
  }
  async exact(n) {
    const bytes = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = await this.some(n - offset);
      if (!chunk) throw coreError("HTTP_BODY_TRUNCATED");
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async cancel(reason) {
    try {
      await this.reader.cancel(reason);
    } catch {}
    try {
      this.reader.releaseLock();
    } catch {}
  }
}
export function requestBytes(method, path, headers, body = new Uint8Array()) {
  if (
    !/^[A-Z]+$/.test(method) ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\s\x00-\x1f\x7f#]/.test(path)
  )
    throw coreError("HTTP_TARGET_INVALID");
  const output = new Headers(headers);
  const length = typeof body === "number" ? body : body.length;
  if (!Number.isSafeInteger(length) || length < 0)
    throw coreError("HTTP_BODY_LENGTH_INVALID");
  output.set("Host", "backend.internal");
  output.set("Accept-Encoding", "identity");
  if (length || !["GET", "HEAD"].includes(method))
    output.set("Content-Length", String(length));
  let text = `${method} ${path} HTTP/1.1\r\n`;
  for (const [name, value] of output) {
    if (/[\r\n]/.test(name + value)) throw coreError("HTTP_HEADER_INVALID");
    text += `${name}: ${value}\r\n`;
  }
  return new TextEncoder().encode(text + "\r\n");
}
export async function readResponse(
  wire,
  { method = "GET", finish = () => {} } = {},
) {
  let status, headers;
  for (let interim = 0; interim < 9; interim++) {
    const line = await wire.line();
    const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: .*)?$/.exec(line);
    if (!match) throw coreError("HTTP_STATUS_INVALID");
    status = Number(match[1]);
    headers = new Headers();
    let bytes = line.length;
    while (true) {
      const line = await wire.line();
      bytes += line.length + 2;
      if (bytes > 65536) throw coreError("HTTP_HEADER_LIMIT");
      if (!line) break;
      const colon = line.indexOf(":");
      if (colon < 1 || /^[ \t]/.test(line))
        throw coreError("HTTP_RESPONSE_HEADER_INVALID");
      const name = line.slice(0, colon),
        value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "content-length" && headers.has(name))
        throw coreError("HTTP_CONTENT_LENGTH_DUPLICATE");
      headers.append(name, value);
    }
    if (status === 101) throw coreError("HTTP_UPGRADE_UNSUPPORTED");
    if (status >= 200) break;
    if (interim === 8) throw coreError("HTTP_INTERIM_LIMIT");
  }
  const transfer = headers.get("transfer-encoding");
  const length = headers.get("content-length");
  if (transfer && (transfer.toLowerCase() !== "chunked" || length !== null))
    throw coreError("HTTP_FRAMING_INVALID");
  let remaining = null;
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
      throw coreError("HTTP_CONTENT_LENGTH_INVALID");
    remaining = Number(length);
  }
  let completed = false,
    chunkRemaining = 0,
    needChunkEnd = false;
  const done = () => {
    if (completed) return;
    completed = true;
    finish();
    void wire.cancel();
  };
  if (
    method === "HEAD" ||
    status === 204 ||
    status === 205 ||
    status === 304 ||
    remaining === 0
  ) {
    done();
    headers.delete("transfer-encoding");
    return new Response(null, { status, headers });
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (completed) return;
        if (transfer) {
          if (needChunkEnd) {
            const end = await wire.exact(2);
            if (end[0] !== 13 || end[1] !== 10)
              throw coreError("HTTP_CHUNK_TERMINATOR_INVALID");
            needChunkEnd = false;
          }
          if (!chunkRemaining) {
            const line = await wire.line(8192);
            if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(line))
              throw coreError("HTTP_CHUNK_SIZE_INVALID");
            chunkRemaining = parseInt(line.split(";")[0], 16);
            if (!Number.isSafeInteger(chunkRemaining))
              throw coreError("HTTP_CHUNK_SIZE_INVALID");
            if (!chunkRemaining) {
              let trailerBytes = 0;
              while (true) {
                const trailer = await wire.line();
                trailerBytes += trailer.length + 2;
                if (trailerBytes > 65536)
                  throw coreError("HTTP_TRAILER_LIMIT");
                if (!trailer) break;
                if (!trailer.includes(":")) throw coreError("HTTP_TRAILER_INVALID");
              }
              controller.close();
              done();
              return;
            }
          }
          const chunk = await wire.some(Math.min(chunkRemaining, 65536));
          if (!chunk) throw coreError("HTTP_CHUNK_TRUNCATED");
          chunkRemaining -= chunk.length;
          needChunkEnd = chunkRemaining === 0;
          controller.enqueue(chunk);
          return;
        }
        const chunk = await wire.some(
          remaining === null ? 65536 : Math.min(remaining, 65536),
        );
        if (!chunk) {
          if (remaining !== null && remaining !== 0)
            throw coreError("HTTP_BODY_TRUNCATED");
          controller.close();
          done();
          return;
        }
        if (remaining !== null) remaining -= chunk.length;
        controller.enqueue(chunk);
        if (remaining === 0) {
          controller.close();
          done();
        }
      } catch (error) {
        controller.error(error);
        done();
      }
    },
    cancel(reason) {
      done();
      return wire.cancel(reason);
    },
  });
  headers.delete("transfer-encoding");
  headers.delete("connection");
  headers.delete("trailer");
  let body = stream;
  const encoding = headers.get("content-encoding");
  if (encoding && encoding !== "identity") {
    if (
      !["gzip", "deflate"].includes(encoding) ||
      typeof DecompressionStream === "undefined"
    ) {
      await stream.cancel();
      throw coreError("HTTP_ENCODING_UNSUPPORTED");
    }
    body = stream.pipeThrough(new DecompressionStream(encoding));
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return new Response(body, { status, headers });
}
