import { readFileSync } from "node:fs";

const original = readFileSync(
  new URL("../fixtures/video.mp4", import.meta.url),
);

export function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) throw new Error("Incomplete test box header");
    const size = bytes.readUInt32BE(offset);
    if (size < 8 || offset + size > end)
      throw new Error("Invalid test box size");
    result.push({
      offset,
      size,
      type: bytes.toString("latin1", offset + 4, offset + 8),
    });
    offset += size;
  }
  return result;
}

export function box(type, payload) {
  const bytes = Buffer.alloc(8 + payload.length);
  bytes.writeUInt32BE(bytes.length);
  bytes.write(type, 4, "latin1");
  payload.copy(bytes, 8);
  return bytes;
}

// Reads materialize only the requested range, even when the logical file has
// hundreds of MiB of unused mdat padding. No large binary fixture is stored.
function virtualFile(size, parts) {
  return {
    size,
    read(start, length) {
      const end = Math.min(size, start + length);
      const bytes = Buffer.alloc(Math.max(0, end - start));
      for (const { offset, bytes: part } of parts) {
        const from = Math.max(start, offset);
        const to = Math.min(end, offset + part.length);
        if (to > from)
          part.copy(bytes, from - start, from - offset, to - offset);
      }
      return bytes;
    },
  };
}

const top = boxes(original);
const moovBox = top.find(({ type }) => type === "moov");
const mdatBox = top.find(({ type }) => type === "mdat");
const originalMoov = original.subarray(
  moovBox.offset,
  moovBox.offset + moovBox.size,
);

export function baselineMP4() {
  return virtualFile(original.length, [{ offset: 0, bytes: original }]);
}

export function tailMoovMP4({
  metadataType,
  size,
  mutateMoov,
  truncate = 0,
  padding = 0,
} = {}) {
  let moov = Buffer.from(originalMoov);
  if (metadataType) {
    const udta = boxes(moov, 8).find(({ type }) => type === "udta");
    const location = Buffer.from("+00.0000+000.0000/", "ascii");
    const payload = Buffer.alloc(4 + location.length);
    payload.writeUInt16BE(location.length);
    location.copy(payload, 4);
    const replacement = box(
      "udta",
      Buffer.concat([
        moov.subarray(udta.offset + 8, udta.offset + udta.size),
        box(metadataType, payload),
      ]),
    );
    moov = box(
      "moov",
      Buffer.concat([
        moov.subarray(8, udta.offset),
        replacement,
        moov.subarray(udta.offset + udta.size),
      ]),
    );
  }
  if (padding)
    moov = box(
      "moov",
      Buffer.concat([moov.subarray(8), box("free", Buffer.alloc(padding))]),
    );
  mutateMoov?.(moov);
  const total = size ?? original.length + moov.length;
  const moovOffset = total - moov.length;
  if (moovOffset < original.length)
    throw new Error("Test tail moov overlaps original samples");
  const head = Buffer.from(original);
  head.write("free", moovBox.offset + 4, "latin1");
  head.writeUInt32BE(moovOffset - mdatBox.offset, mdatBox.offset);
  return Object.assign(
    virtualFile(total - truncate, [
      { offset: 0, bytes: head },
      { offset: moovOffset, bytes: moov },
    ]),
    { moovOffset, moovSize: moov.length },
  );
}
