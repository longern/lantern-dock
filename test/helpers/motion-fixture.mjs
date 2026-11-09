// Synthetic metadata on our own raster/video fixtures; no personal media.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export const liveID = "8F6AB9E4-1234-4A9B-9876-100000000001";
export function jpegSegment(jpeg, marker, data) {
  const header = Buffer.alloc(4);
  header[0] = 255;
  header[1] = marker;
  header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, data, jpeg.subarray(2)]);
}
export async function motionFixture({
  modern = true,
  enabled = 1,
  length,
  version = 1,
} = {}) {
  const jpeg = await readFile(
    new URL("../fixtures/album-thumbnail.jpg", import.meta.url),
  );
  const video = await readFile(
    new URL("../fixtures/video.mp4", import.meta.url),
  );
  const attributes = modern
    ? `GCamera:MotionPhoto="${enabled}" GCamera:MotionPhotoVersion="${version}" GCamera:MotionPhotoPresentationTimestampUs="1000000"`
    : `GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${length ?? video.length}"`;
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ${attributes}><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${length ?? video.length}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`;
  return Buffer.concat([
    jpegSegment(
      jpeg,
      0xe1,
      Buffer.from("http://ns.adobe.com/xap/1.0/\0" + xmp),
    ),
    video,
  ]);
}
export async function applePhoto(id = liveID) {
  const jpeg = await readFile(
    new URL("../fixtures/album-thumbnail.jpg", import.meta.url),
  );
  // TIFF IFD0 -> ExifIFD -> Apple's big-endian MakerNote IFD (tag 0x11).
  const maker = Buffer.alloc(32 + Buffer.byteLength(id) + 1);
  maker.write("Apple iOS\0", 0, "binary");
  maker.writeUInt16BE(1, 10);
  maker.write("MM", 12);
  maker.writeUInt16BE(1, 14);
  maker.writeUInt16BE(0x11, 16);
  maker.writeUInt16BE(2, 18);
  maker.writeUInt32BE(Buffer.byteLength(id) + 1, 20);
  maker.writeUInt32BE(32, 24);
  maker.write(id, 32);
  const tiff = Buffer.alloc(44);
  tiff.write("MM");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt16BE(1, 26);
  tiff.writeUInt16BE(0x927c, 28);
  tiff.writeUInt16BE(7, 30);
  tiff.writeUInt32BE(maker.length, 32);
  tiff.writeUInt32BE(44, 36);
  return jpegSegment(
    jpeg,
    0xe1,
    Buffer.concat([Buffer.from("Exif\0\0"), tiff, maker]),
  );
}
export function appleVideo(output, id = liveID) {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    fileURLToPath(new URL("../fixtures/video.mp4", import.meta.url)),
    "-c",
    "copy",
    "-metadata",
    `com.apple.quicktime.content.identifier=${id}`,
    "-movflags",
    "use_metadata_tags",
    output,
  ]);
}
