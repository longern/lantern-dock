import { createFile } from "mp4box";
import { limitedBytes } from "./content.js";
import { checkResponse } from "./dav.js";

const chunkSize = 1024 * 1024;
const metadataLimit = 16 * 1024 * 1024;
const queueLimit = 16 * 1024 * 1024;
const unsupported = "浏览器不支持此视频的格式或编码，请下载后播放。";

// MP4Box only reorganizes compressed samples into fMP4 fragments. Decoding is
// performed by the browser. Everything is scoped to this preview instance.
export class MP4MediaSource {
  constructor(client, item, signal) {
    this.client = client;
    this.item = item;
    this.mode = "mse";
    this.file = createFile(false);
    this.media = new MediaSource();
    this.url = URL.createObjectURL(this.media);
    this.controller = new AbortController();
    this.signal = signal;
    this.buffers = [];
    this.waiters = new Set();
    this.offset = 0;
    this.size = Infinity;
    this.generation = 0;
    this.queued = 0;
    this.metadataBytes = 0;
    this.dispose = this.dispose.bind(this);
    this.seek = this.seek.bind(this);
    this.notify = this.notify.bind(this);
    signal?.addEventListener("abort", this.dispose, { once: true });
  }
  attach(video, onError) {
    this.video = video;
    this.onError = onError;
    this.file.onError = () =>
      this.fail(new Error("视频文件无法解析，请下载后播放。"));
    this.file.onReady = (info) => this.ready(info);
    this.file.onSegment = (id, buffer, bytes, sample) => {
      if (this.disposed || this.failed) return;
      this.queued += bytes.byteLength;
      buffer.queue.push({ bytes, sample });
      this.pump(buffer);
    };
    this.open = () => {
      if (this.started) return;
      this.started = true;
      void this.run().catch((error) => this.fail(error));
    };
    this.media.addEventListener("sourceopen", this.open);
    video.addEventListener("seeking", this.seek);
    video.addEventListener("timeupdate", this.notify);
    video.addEventListener("playing", this.notify);
    video.addEventListener("waiting", this.notify);
    video.src = this.url;
  }
  ready(info) {
    if (this.info || this.disposed || this.failed) return;
    const video = info.videoTracks?.[0];
    const audio = info.audioTracks?.[0];
    const tracks = [video, audio].filter(Boolean);
    if (
      !video ||
      info.tracks.length > 16 ||
      !Number.isFinite(info.duration / info.timescale) ||
      info.duration <= 0
    )
      throw new Error(unsupported);
    const bitrate = tracks.reduce(
      (sum, track) => sum + (track.bitrate || 0),
      0,
    );
    this.prefetch =
      bitrate > 0
        ? Math.max(2, Math.min(30, (32 * 1024 * 1024 * 8) / bitrate))
        : 10;
    for (const track of tracks) {
      const mime = `${track.video ? "video" : "audio"}/mp4; codecs="${track.codec}"`;
      if (!MediaSource.isTypeSupported(mime)) throw new Error(unsupported);
      const source = this.media.addSourceBuffer(mime);
      const buffer = { id: track.id, source, queue: [], current: null };
      buffer.updated = () => {
        if (buffer.current) {
          const { bytes, sample } = buffer.current;
          this.queued -= bytes.byteLength;
          if (sample !== undefined)
            this.file.releaseUsedSamples(buffer.id, sample);
          buffer.current = null;
        }
        this.pump(buffer);
        this.notify();
      };
      buffer.error = () => this.fail(new Error(unsupported));
      source.addEventListener("updateend", buffer.updated);
      source.addEventListener("error", buffer.error);
      this.buffers.push(buffer);
      this.file.setSegmentOptions(track.id, buffer, {
        nbSamples: 30,
        rapAlignement: false,
        sizePerSegment: 4 * 1024 * 1024,
      });
    }
    this.info = info;
    this.media.duration = info.duration / info.timescale;
    for (const init of this.file.initializeSegmentation("per-track")) {
      this.queued += init.buffer.byteLength;
      init.user.queue.push({ bytes: init.buffer });
      this.pump(init.user);
    }
    // With moov-at-end files, earlier mdat bytes were intentionally discarded.
    // Seek to sample data again instead of retaining the entire original file.
    this.nextSeek = this.file.seek(0, true).offset;
    this.file.start();
  }
  pump(buffer) {
    if (
      this.disposed ||
      this.failed ||
      buffer.source.updating ||
      buffer.current
    )
      return;
    try {
      const source = buffer.source;
      // Keep a small back buffer; native MSE remains responsible for decoding.
      const cutoff = this.video.currentTime - 20;
      if (
        cutoff > 0 &&
        source.buffered.length &&
        source.buffered.start(0) < cutoff - 5
      ) {
        source.remove(0, cutoff);
        return;
      }
      const future = this.video.currentTime + 60;
      if (
        source.buffered.length &&
        source.buffered.end(source.buffered.length - 1) > future + 5
      ) {
        source.remove(future, source.buffered.end(source.buffered.length - 1));
        return;
      }
      const next = buffer.queue.shift();
      if (next) {
        buffer.current = next;
        source.appendBuffer(next.bytes);
      }
    } catch (error) {
      this.fail(error);
    }
  }
  ahead() {
    const time = this.video.currentTime;
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++)
      if (ranges.start(i) <= time + 0.1 && ranges.end(i) >= time)
        return ranges.end(i) - time;
    return 0;
  }
  notify() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  wait() {
    return new Promise((resolve) => this.waiters.add(resolve));
  }
  seek() {
    if (!this.info || this.disposed || this.failed) return;
    // Native seeking inside the common A/V buffer needs no backend requests.
    if (this.ahead() > 0.1) {
      this.notify();
      return;
    }
    try {
      this.generation++;
      this.request?.abort();
      this.file.stop();
      for (const buffer of this.buffers) {
        for (const part of buffer.queue) this.queued -= part.bytes.byteLength;
        buffer.queue.length = 0;
        if (buffer.source.updating && this.media.readyState === "open")
          buffer.source.abort();
      }
      this.nextSeek = this.file.seek(
        Math.max(0, this.video.currentTime),
        true,
      ).offset;
      this.eof = false;
      this.file.start();
      this.notify();
    } catch (error) {
      this.fail(error);
    }
  }
  async read(offset) {
    const request = new AbortController();
    this.request = request;
    const abort = () => request.abort();
    this.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const headers = { Range: `bytes=${offset}-${offset + chunkSize - 1}` };
      if (this.etag) headers["If-Range"] = this.etag;
      const response = await this.client.read(
        this.item.path,
        request.signal,
        headers,
      );
      if (!response.ok) checkResponse(response);
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get("Content-Range") || "",
      );
      if (
        response.status !== 206 ||
        !match ||
        Number(match[1]) !== offset ||
        Number(match[2]) < offset ||
        Number(match[2]) - offset + 1 > chunkSize ||
        !Number.isSafeInteger(Number(match[3]))
      ) {
        await response.body?.cancel();
        throw new Error(
          response.status === 200 && this.etag
            ? "视频已更新，请刷新后重试。"
            : "后端未提供有效的 Range 响应，请下载后播放。",
        );
      }
      if (
        Number(match[2]) >= Number(match[3]) ||
        (this.size !== Infinity && this.size !== Number(match[3]))
      ) {
        await response.body?.cancel();
        throw new Error("视频已更新，请刷新后重试。");
      }
      this.size = Number(match[3]);
      if (!this.etag) {
        const etag = response.headers.get("ETag");
        if (etag && !etag.startsWith("W/")) this.etag = etag;
      }
      const bytes = await limitedBytes(response, chunkSize, request.signal);
      if (bytes.byteLength !== Number(match[2]) - offset + 1)
        throw new Error("视频数据不完整，请重试。");
      const data = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      data.fileStart = offset;
      return data;
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", abort);
      if (this.request === request) this.request = null;
    }
  }
  async run() {
    while (!this.disposed && !this.failed) {
      for (const buffer of this.buffers) this.pump(buffer);
      if (this.nextSeek !== undefined) {
        this.offset = this.nextSeek;
        this.nextSeek = undefined;
      }
      if (!this.eof && this.offset >= this.size) {
        if (!this.info) throw new Error("无法读取视频索引，请下载后播放。");
        this.file.flush();
        this.eof = true;
      }
      if (this.eof) {
        if (
          this.media.readyState === "open" &&
          !this.queued &&
          this.buffers.every((b) => !b.source.updating)
        )
          this.media.endOfStream();
        await this.wait();
        continue;
      }
      if (this.queued > queueLimit || this.ahead() > this.prefetch) {
        await this.wait();
        continue;
      }
      const generation = this.generation;
      let data;
      try {
        data = await this.read(this.offset);
      } catch (error) {
        if (this.disposed) return;
        if (generation !== this.generation) continue;
        throw error;
      }
      if (this.disposed || generation !== this.generation) continue;
      if (!this.info) {
        this.metadataBytes += data.byteLength;
        if (this.metadataBytes > metadataLimit)
          throw new Error("视频索引超过预览处理限制，请下载后播放。");
      }
      const next = this.file.appendBuffer(
        data,
        data.fileStart + data.byteLength >= this.size,
      );
      if (this.file.getAllocatedSampleDataSize() > 2 * queueLimit)
        throw new Error("视频片段超过预览处理限制，请下载后播放。");
      if (this.failed) return;
      if (!Number.isSafeInteger(next) || next < 0 || next > this.size)
        throw new Error("视频索引无效，请下载后播放。");
      this.offset = next;
      if (this.nextSeek === undefined && this.offset >= this.size) {
        if (!this.info) throw new Error("无法读取视频索引，请下载后播放。");
        this.file.flush();
        this.eof = true;
      }
    }
  }
  fail(error) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.controller.abort();
    this.file.stop();
    this.notify();
    this.onError?.(error instanceof Error ? error : new Error(unsupported));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.file.stop();
    this.notify();
    this.signal?.removeEventListener("abort", this.dispose);
    this.media.removeEventListener("sourceopen", this.open);
    this.video?.removeEventListener("seeking", this.seek);
    for (const type of ["timeupdate", "playing", "waiting"])
      this.video?.removeEventListener(type, this.notify);
    for (const buffer of this.buffers) {
      buffer.source.removeEventListener("updateend", buffer.updated);
      buffer.source.removeEventListener("error", buffer.error);
      try {
        if (this.media.readyState === "open") buffer.source.abort();
      } catch {
        /* Already detached by the player. */
      }
      buffer.queue.length = 0;
      buffer.current = null;
    }
    this.file.onReady = this.file.onSegment = this.file.onError = undefined;
    this.buffers.length = 0;
    this.queued = 0;
    URL.revokeObjectURL(this.url);
  }
}
