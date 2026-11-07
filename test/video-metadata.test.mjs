import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MP4MediaSource, mp4ParseError } from "../src/lib/video-mp4.js";
import { baselineMP4, boxes, tailMoovMP4 } from "./helpers/mp4-fixture.mjs";

const MiB = 1024 * 1024;
const item = { path: "/dav/video.mp4", name: "video.mp4" };
const emptyRanges = { length: 0 };
const mediaSourceContexts = new WeakSet();

// This is a synthetic MSE sink, not a decoder or a browser playback test. It
// exercises the real app reader, MP4Box parser, onReady, init and media segments.
function installMediaSource(t) {
  if (mediaSourceContexts.has(t)) return;
  mediaSourceContexts.add(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "MediaSource");
  class SourceBuffer extends EventTarget {
    updating = false;
    buffered = emptyRanges;
    appends = [];
    appendBuffer(bytes) {
      assert.equal(this.updating, false);
      this.appends.push(Buffer.from(bytes));
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
    }
    abort() {
      this.updating = false;
    }
  }
  class SyntheticMediaSource extends Blob {
    events = new EventTarget();
    sourceBuffers = [];
    readyState = "open";
    static isTypeSupported(mime) {
      return /^(video|audio)\/mp4; codecs="(avc1\.|mp4a\.)/.test(mime);
    }
    addEventListener(...args) { this.events.addEventListener(...args); }
    removeEventListener(...args) { this.events.removeEventListener(...args); }
    addSourceBuffer(mime) {
      const source = new SourceBuffer();
      source.mime = mime;
      this.sourceBuffers.push(source);
      return source;
    }
    endOfStream() {
      this.readyState = "ended";
      this.finished?.();
    }
  }
  Object.defineProperty(globalThis, "MediaSource", { configurable: true, writable: true, value: SyntheticMediaSource });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "MediaSource", previous);
    else delete globalThis.MediaSource;
  });
}

async function parseMP4(t, fixture, configure = () => {}) {
  installMediaSource(t);
  const reads = [];
  const errors = [];
  const parserErrors = [];
  const ready = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const client = {
    async read(path, signal, headers) {
      assert.equal(path, item.path);
      signal.throwIfAborted();
      assert.ok(reads.length < 40, "parser must not loop over byte ranges");
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
      assert.ok(match, "every request must be a bounded byte range");
      const start = Number(match[1]);
      const length = Number(match[2]) - start + 1;
      assert.equal(length, MiB);
      assert.ok(start < fixture.size, "no reads beyond EOF");
      if (reads.length) assert.equal(headers["If-Range"], '"fixture-v1"');
      const bytes = fixture.read(start, length);
      reads.push({ start, length: bytes.length });
      return new Response(bytes, { status: 206, headers: {
        "Content-Range": `bytes ${start}-${start + bytes.length - 1}/${fixture.size}`,
        ETag: '"fixture-v1"',
      } });
    },
  };
  const source = new MP4MediaSource(client, item);
  t.after(() => source.dispose());
  const video = Object.assign(new EventTarget(), { currentTime: 0, buffered: emptyRanges });
  source.attach(video, (error) => { errors.push(error); finish(); });
  const onReady = source.file.onReady;
  source.file.onReady = (info) => { ready.push(info); onReady(info); };
  const onError = source.file.onError;
  source.file.onError = (...args) => { parserErrors.push(args); onError(...args); };
  source.media.finished = finish;
  configure(source);
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Synthetic MSE did not finish")), 5000);
  });
  const run = source.run().catch((error) => source.fail(error));
  try {
    await Promise.race([finished, deadline]);
    return {
      reads, errors, parserErrors, ready,
      metadataBytes: source.metadataBytes,
      failed: !!source.failed,
      ended: source.media.readyState === "ended",
      buffers: source.media.sourceBuffers,
    };
  } finally {
    clearTimeout(timer);
    source.dispose();
    await run;
  }
}

function trackSummary(result) {
  return result.ready[0].tracks.map(({ id, codec, nb_samples, duration, timescale }) =>
    ({ id, codec, samples: nb_samples, duration, timescale }));
}

function sampleDigests(result) {
  return result.buffers.map(({ mime, appends }) => {
    const hash = createHash("sha256");
    let length = 0;
    assert.ok(appends.length > 1, "each track must produce init and media segments");
    assert.deepEqual(boxes(appends[0]).map(({ type }) => type), ["ftyp", "moov"]);
    for (const bytes of appends.slice(1)) {
      const parts = boxes(bytes);
      assert.ok(parts.some(({ type }) => type === "moof"));
      for (const { offset, size, type } of parts) {
        if (type !== "mdat") continue;
        hash.update(bytes.subarray(offset + 8, offset + size));
        length += size - 8;
      }
    }
    assert.ok(length > 0);
    return { mime, length, sha256: hash.digest("hex") };
  });
}

function assertReady(result) {
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.parserErrors, []);
  assert.equal(result.failed, false);
  assert.equal(result.ended, true);
  assert.equal(result.ready.length, 1);
  assert.equal(result.buffers.length, 2);
}

test("synthetic MSE parses baseline, ASCII and ©xyz metadata without changing A/V samples", async (t) => {
  const baseline = await parseMP4(t, baselineMP4());
  assertReady(baseline);
  const tracks = trackSummary(baseline);
  const samples = sampleDigests(baseline);
  assert.deepEqual(tracks.map(({ codec, samples }) => ({ codec, samples })), [
    { codec: "avc1.64001e", samples: 192 },
    { codec: "mp4a.40.2", samples: 346 },
  ]);
  for (const metadataType of ["xxyz", "©xyz"]) {
    const fixture = tailMoovMP4({ metadataType });
    assert.equal(fixture.read(0, 12).toString("ascii", 8, 12), "isom");
    const result = await parseMP4(t, fixture);
    assertReady(result);
    assert.deepEqual(trackSummary(result), tracks);
    assert.deepEqual(sampleDigests(result), samples);
    assert.ok(result.metadataBytes < 2 * MiB);
  }
});

test("a virtual 198 MiB ©xyz MP4 reaches its tail moov using bounded reads", async (t) => {
  const fixture = tailMoovMP4({ metadataType: "©xyz", size: 198 * MiB });
  const result = await parseMP4(t, fixture);
  assertReady(result);
  assert.deepEqual(result.reads.slice(0, 2).map(({ start }) => start), [0, fixture.moovOffset]);
  assert.equal(result.metadataBytes, MiB + fixture.moovSize);
  assert.ok(result.reads.length <= 5);
  assert.ok(result.reads.reduce((sum, { length }) => sum + length, 0) < 4 * MiB);
  const baseline = await parseMP4(t, baselineMP4());
  assert.deepEqual(trackSummary(result), trackSummary(baseline));
  assert.deepEqual(sampleDigests(result), sampleDigests(baseline));
});

test("malformed moov lengths remain rejected when metadata box types are permitted", async (t) => {
  for (const [name, options] of [
    ["truncated moov", { truncate: 128 }],
    ["oversized moov", { mutateMoov: (bytes) => bytes.writeUInt32BE(100 * MiB, 0) }],
    ["child exceeds its container", { mutateMoov: (bytes) => bytes.writeUInt32BE(100 * MiB, 8) }],
  ]) {
    const result = await parseMP4(t, tailMoovMP4({ metadataType: "©xyz", ...options }));
    assert.equal(result.failed, true, name);
    assert.equal(result.ended, false, name);
    assert.equal(result.errors.length, 1, name);
    assert.equal(result.buffers.length, 0, name);
    assert.ok(result.reads.length <= 2, name);
    assert.match(result.errors[0].message, /索引|无法解析/, name);
    if (name === "child exceeds its container") {
      assert.equal(result.errors[0].code, "MP4_PARSE_ERROR");
      assert.equal(result.errors[0].name, "Error");
      assert.ok(Object.isFrozen(result.errors[0].diagnostic));
    }
  }
});

test("the 16 MiB metadata read budget still rejects a real oversized index", async (t) => {
  const result = await parseMP4(t, tailMoovMP4({ metadataType: "©xyz", padding: 17 * MiB }));
  assert.equal(result.failed, true);
  assert.equal(result.ready.length, 0);
  assert.equal(result.buffers.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /视频索引超过预览处理限制/);
  assert.ok(result.metadataBytes > 16 * MiB);
  assert.ok(result.metadataBytes <= 17 * MiB);
  assert.ok(result.reads.length <= 18);
});

test("the 32 MiB allocated-sample guard still rejects a parser budget overflow", async (t) => {
  // Inject only the accounting measurement, retaining actual parsing and MSE
  // callbacks so the run-loop guard is tested without allocating huge samples.
  const result = await parseMP4(t, baselineMP4(), (source) => {
    source.file.getAllocatedSampleDataSize = () => 32 * MiB + 1;
  });
  assert.equal(result.failed, true);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /视频片段超过预览处理限制/);
  assert.equal(result.reads.length, 1);
});

test("the existing metadata and sample budget boundaries remain inclusive", async (t) => {
  const fixture = baselineMP4();
  const result = await parseMP4(t, fixture, (source) => {
    source.metadataBytes = 16 * MiB - fixture.size;
    source.file.getAllocatedSampleDataSize = () => 32 * MiB;
  });
  assertReady(result);
  assert.equal(result.metadataBytes, 16 * MiB);
});

test("parser diagnostics preserve safe context and discard private parser text", () => {
  const known = mp4ParseError("BoxParser", "Box of type 'moov' at position 866186 has an invalid size", 12);
  assert.equal(known.code, "MP4_PARSE_ERROR");
  assert.deepEqual(known.diagnostic, { parser: "BoxParser", box: "moov", offset: 866186 });
  assert.ok(Object.isFrozen(known.diagnostic));
  assert.match(known.message, /BoxParser.*moov.*866186/);
  const privateText = "https://private.example/movie?token=secret /private/home.mp4 +37.3318-122.0312/ personal note";
  const safe = mp4ParseError(privateText, `Invalid box type: 'secr' ${privateText}`, Number.MAX_SAFE_INTEGER + 1);
  assert.deepEqual(safe.diagnostic, { parser: "MP4Box" });
  const visible = `${safe.message} ${JSON.stringify(safe)}`;
  for (const value of ["private.example", "token=secret", "/private/", "37.3318", "personal note", "secr"])
    assert.equal(visible.includes(value), false);
  assert.equal(safe.cause, undefined);
});
