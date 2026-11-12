# Video posters and playback

Video files remain read-only WebDAV resources. Playback uses the browser's native media decoder; JavaScript handles transport and, where needed, MP4 fragmentation. There is no Service Worker, persistent media registration, whole-video Blob download or NAS playback transcoding.

## Playback paths

| Backend                                 | Playback                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Public HTTPS                            | Native `<video>` with the original backend URL, anonymous CORS and browser-managed Range requests              |
| WebTransport                            | Page-local MP4Box.js + MediaSource; byte ranges travel through the existing bridge session                     |
| HTTPS with Basic/Bearer request headers | The same page-local MP4 path, preserving the transport's authentication without putting credentials into a URL |

Direct playback supports containers/codecs accepted by that browser. The MediaSource path accepts ordinary MP4, M4V and compatible MOV files, with the first video and optional first audio track; both codecs must be supported by the browser's MediaSource implementation. MP4Box parses and repackages compressed samples into fMP4 fragments. It does not decode, transcode or add codec support. Additional audio tracks, subtitles, DRM, adaptive bitrate and fragmented/live source files are not supported by this first implementation. An unsupported file shows a download action and a concise explanation.

MP4 files can contain QuickTime-style metadata, including non-ASCII box names such as `©xyz`, even when their major brand is `isom`. The parser allows those box names without changing structural checks or resource limits. Parser failures retain a safe parser name, known box name and byte offset when available; filenames, URLs, location values and other raw metadata are not included in the diagnostic or sent to a logging service. This compatibility handling does not make damaged files or unsupported codecs playable.

MP4Box is a separate lazy-loaded bundle: ordinary file browsing and public HTTPS playback do not load it. Its BSD license is distributed at `/licenses/MP4Box.txt`. Playback keeps the usual native controls and inline mobile behavior, without autoplay. Closing the preview pauses playback, aborts pending reads, detaches the player and releases its MediaSource/object URLs.

The MediaSource path requires valid `206`/`Content-Range` replies. Reads use 1 MiB ranges and retain a strong ETag as `If-Range`; an ignored range or changed source is rejected before buffering a whole response. Metadata acquisition has a 16 MiB read budget. Fragment generation uses up to 30 samples or about 4 MiB per segment. Queued fragments apply backpressure at 16 MiB, and excessive retained sample data stops the preview. Prefetch targets at most 30 seconds, reduced for high-bitrate files using a 32 MiB estimate; this is not a hard cap on the browser decoder's memory. Old native buffers are trimmed. Seeking outside the buffer uses the MP4 sample index and a keyframe-aligned file offset; indexes at the end of a file do not require downloading the intervening media.

For anonymous WebTransport playback in the NAS's advertised public `/dav/` namespace, complete ranges with strong ETags can survive closing the player or reloading the page. The browser stores only ranges it already read. When a player opens, the separate Cache Storage budget is `min(2 GiB, max(0, quota - usage + cached video bytes - 256 MiB))`, with a fallback of 512 MiB if the browser cannot estimate site storage. It holds up to 2,048 ranges. When a browser rejects a write for lack of quota, the cache lowers its budget, evicts older ranges, and retries once if the range still fits. Playback falls back to the network when storage is unavailable.

Explicit `max-age` or `Expires` can keep a range fresh. `no-cache` requires an `If-None-Match` check, and `304` reuses the saved bytes. `no-store`, unsupported `Vary`, and credentialed connections bypass persistent video storage. The cache is cleared with the image caches on login, logout, or a connection credential change. Public HTTPS playback continues to use the browser's native HTTP cache.

HTTPS media hosts need the same CORS permission as file browsing. The portal CSP allows media from HTTPS, Blob URLs and local development hosts. A NAS that serves only local HTTP continues to use WebTransport; no additional public NAS HTTPS endpoint is required for that path.

## Poster generation

The NAS image includes FFmpeg/ffprobe. Standalone binaries need these executables on `PATH` (FFmpeg 6+ with the `fd` protocol); without them, video icons and playback still work, while generated posters are unavailable. No new environment variables, mounts, API roots or bridge allowlist entries are required.

A video's representative frame is exposed as an image through the existing IIIF Image API 3 Level 0 service. The identifier still maps to the public file's relative path. `info.json` advertises the display dimensions after pixel-aspect-ratio and rotation adjustments, and JPG rendition paths use the existing 128/384/1600 size policy. The poster comes from at most one second into the video, or half its duration for a shorter clip. Attached cover-art tracks are skipped. Poster extraction is best-effort and does not delay player initialization.

Supported poster containers are MP4/M4V/MOV, Matroska/WebM, AVI and Ogg video, subject to the installed FFmpeg decoders. Poster support is independent of browser playback support: an MKV can have a poster while its original media still needs downloading for playback.

Posters share the existing 1 GiB disk cache, strong ETags, source-version invalidation and single-renderer concurrency limit with images. The 128 MiB still-image input ceiling does not apply to videos: FFmpeg seeks through an already-open file descriptor. Dimension limits remain 64 million pixels, process output is bounded and each process has a 12-second deadline within the image request's 15-second deadline.

The same confined public-file opener is used for posters and original-file reads. Cached posters are rechecked against the source before delivery; missing, recycled and symlinked sources return `404`. FFmpeg receives only the inherited source descriptor, with an `fd`-only input protocol whitelist and a restricted set of demuxers. Embedded playlists, network requests and local sidecar/external-track reads cannot expand access beyond that descriptor. Source filenames and public URLs are never interpolated into a shell command.
