# Live Photos and Motion Photos

The NAS identifies motion media; the browser handles gestures and playback. The container includes ExifTool and FFmpeg. No additional variables, mounts or bridge namespaces are required. Upgrade both the NAS image and the frontend.

## Supported sources

- Apple: JPEG/HEIC/HEIF plus MOV/MP4/M4V in the same directory, with matching Apple MakerNote and QuickTime `ContentIdentifier` metadata. Names can differ. Ambiguous identifiers are left as separate files; matching filenames alone do not establish a pair.
- Android: JPEG with Google's version 1 Motion Photo XMP container directory and a final embedded MP4/QuickTime video. Legacy `MicroVideoOffset` is supported when modern Motion Photo metadata is absent. A modern disabled flag overrides stale legacy metadata. Offsets, lengths and the video header are validated before exposing a section.

Both older ExifTool output (`XMP-Container:Directory`, including 12.76) and newer output (`XMP-GContainer:ContainerDirectory`) are supported. Intermediate HDR gain maps do not prevent recognition when the motion video is the final container item.

CI runs NAS tests in the Dockerfile's `test` stage with Alpine 3.24 and its FFmpeg/ExifTool packages, matching the production image's distribution and package sources.

The original files are never rewritten. Export tools that remove pairing metadata, missing video companions, vendor-specific trailers and Android HEIC/AVIF motion containers can remain ordinary images/videos. HEIC/HEIF still previews use the NAS's FFmpeg build; standalone installations need a build with HEIF support. Video decoding remains native to the browser: HEVC support depends on the browser and operating system. An unsupported motion clip leaves the still image available; no universal transcoding or WASM codec is included.

## Album interaction

Discovery runs in the background and does not delay the DAV listing. Verified pairs appear as one album item with a LIVE badge. Normal file browsing and downloads keep both originals independently accessible. A video is hidden from the album only when its verified image is present in that album listing.

Open a photo and hold for 250 ms to play its muted motion clip; release to return to the still. Dragging and multiple pointers cancel the hold so swipe/pinch gestures remain available. The LIVE action in the viewer also toggles playback with a mouse or keyboard. Playback stops on page changes, closing, loss of window focus, hiding the page or reaching the clip's end. Video bytes are requested only after playback is requested. A late network response cannot restart a released hold.

HTTPS uses native video; WebTransport reuses page-local MP4Box + MediaSource and bounded Range requests. No Service Worker is installed. See [video playback](video.md).

## Discovery extension

`GET /api/capabilities` advertises `services.media` with `protocol: "lantern-dock-media"`, `version: 1`, `href: "/api/media"`. This envelope is a LanternDock extension, not part of WebDAV or IIIF. Plain DAV servers without it keep their existing behavior.

`GET /api/media/{directoryID}/index.json` returns:

```json
{
  "version": 1,
  "revision": "<64 lowercase hex characters>",
  "items": [
    {
      "image": "/dav/photo.jpg",
      "pairedVideo": "/dav/clip.mov",
      "video": "/api/media/{imageID}/{videoID}/{version}/video.mp4",
      "kind": "apple",
      "length": 123456,
      "posterTime": 0
    }
  ],
  "nextOffset": null
}
```

IDs are unpadded base64url of UTF-8 paths relative to `/public`; the root directory uses `.`. They are identifiers, not credentials. `pairedVideo` is omitted for embedded `kind: "motion-photo"` media. `posterTime` is a nonnegative presentation time in seconds when supplied by the source metadata; playback starts at the clip's beginning.

Metadata is inspected in pages of 64 media files, with at most 10,000 visible entries per directory. Continue with `?offset={nextOffset}&revision={revision}` until `nextOffset` is null. Each continuation checks the directory revision. The final page contains the complete verified directory result; clients must apply that page, since later files can reveal ambiguous pairing IDs. A changed directory returns `409` and requires a fresh discovery. Overlarge directories return `413`, overload returns `503` with `Retry-After`, and errors are `no-store`.

## Resource and cache boundaries

`GET`/`HEAD` on the versioned video resource support standard byte ranges, ETags, `If-Range` and conditional reads. An embedded video's byte zero is its own video header, not the JPEG's byte zero. The NAS streams an `io.SectionReader` over the original file instead of extracting a second video copy. Apple companions use the same resource interface.

Every resource read reopens and validates both public sources, metadata and versions through the confined public filesystem. Recycle bins, symlinks and private inbox contents remain inaccessible. A removed or hidden source fails even with a cached ETag. Resource URLs are not upload permissions or authentication tokens.

Inspection uses read-only file descriptors and ExifTool with config loading disabled, bounded output, one metadata subprocess at a time and a 12-second process deadline. At most two media requests are admitted; their metadata work has a 20-second deadline. Video delivery uses normal HTTP streaming and backpressure. Source metadata, including negative results, shares the existing bounded `/data/cache/images` disk cache and source fingerprints. No original-file content hashing is needed for normal cache validation. Directory metadata has 15-second HTTP freshness; the frontend additionally retains at most 2 MiB/32 complete directory indexes per connection, honoring `no-store` and invalidating on refresh/disconnect.
