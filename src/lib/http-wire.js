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
          if (i > limit) throw new Error("HTTP header limit exceeded");
          const part = this.take(i);
          this.take(2);
          return decoder.decode(part);
        }
      }
      if (this.buffer.length > limit)
        throw new Error("HTTP header limit exceeded");
      scan = Math.max(0, this.buffer.length - 1);
      if (!(await this.more())) throw new Error("Truncated HTTP message");
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
      if (!chunk) throw new Error("Truncated HTTP body");
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
    throw new Error("Invalid HTTP request target");
  const output = new Headers(headers);
  const length = typeof body === "number" ? body : body.length;
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error("Invalid request body length");
  output.set("Host", "backend.internal");
  output.set("Accept-Encoding", "identity");
  if (length || !["GET", "HEAD"].includes(method))
    output.set("Content-Length", String(length));
  let text = `${method} ${path} HTTP/1.1\r\n`;
  for (const [name, value] of output) {
    if (/[\r\n]/.test(name + value)) throw new Error("Invalid header");
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
    if (!match) throw new Error("Invalid HTTP response status");
    status = Number(match[1]);
    headers = new Headers();
    let bytes = line.length;
    while (true) {
      const line = await wire.line();
      bytes += line.length + 2;
      if (bytes > 65536) throw new Error("HTTP header limit exceeded");
      if (!line) break;
      const colon = line.indexOf(":");
      if (colon < 1 || /^[ \t]/.test(line))
        throw new Error("Invalid HTTP response header");
      const name = line.slice(0, colon),
        value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "content-length" && headers.has(name))
        throw new Error("Duplicate Content-Length");
      headers.append(name, value);
    }
    if (status === 101) throw new Error("Protocol upgrades are not supported");
    if (status >= 200) break;
    if (interim === 8) throw new Error("Too many interim responses");
  }
  const transfer = headers.get("transfer-encoding");
  const length = headers.get("content-length");
  if (transfer && (transfer.toLowerCase() !== "chunked" || length !== null))
    throw new Error("Unsupported or ambiguous HTTP framing");
  let remaining = null;
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
      throw new Error("Invalid Content-Length");
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
              throw new Error("Invalid chunk terminator");
            needChunkEnd = false;
          }
          if (!chunkRemaining) {
            const line = await wire.line(8192);
            if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(line))
              throw new Error("Invalid chunk size");
            chunkRemaining = parseInt(line.split(";")[0], 16);
            if (!Number.isSafeInteger(chunkRemaining))
              throw new Error("Invalid chunk size");
            if (!chunkRemaining) {
              let trailerBytes = 0;
              while (true) {
                const trailer = await wire.line();
                trailerBytes += trailer.length + 2;
                if (trailerBytes > 65536)
                  throw new Error("Trailer limit exceeded");
                if (!trailer) break;
                if (!trailer.includes(":")) throw new Error("Invalid trailer");
              }
              controller.close();
              done();
              return;
            }
          }
          const chunk = await wire.some(Math.min(chunkRemaining, 65536));
          if (!chunk) throw new Error("Truncated chunk");
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
            throw new Error("Truncated HTTP body");
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
      throw new Error(`Unsupported content encoding: ${encoding}`);
    }
    body = stream.pipeThrough(new DecompressionStream(encoding));
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return new Response(body, { status, headers });
}
