# Images and caching

The included NAS backend provides [IIIF Image API 3](https://iiif.io/api/image/3.0/), with the [Level 0 compliance profile](https://iiif.io/api/image/3.0/compliance/). Files and directories continue to use read-only WebDAV. No additional required variables, container mounts, bridge routes or image-processing executables are needed.

## Standard interface

The public image service is advertised as `services.images` by `GET /api/capabilities`. Its base path is `/api/iiif/3`. For an image identifier `identifier`:

| Request                                                  | Response                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/api/iiif/3/identifier`                                 | `303` to its `info.json`                                                                        |
| `/api/iiif/3/identifier/info.json`                       | IIIF 3 `ImageService3`, `level0`, oriented source dimensions, size limits and available `sizes` |
| `/api/iiif/3/identifier/full/max/0/default.jpg`          | Largest available JPG rendition                                                                 |
| `/api/iiif/3/identifier/full/width,height/0/default.jpg` | An exact pair advertised in `sizes`                                                             |

`GET`, `HEAD` and `OPTIONS` are supported. Image responses support byte ranges and conditional reads with strong, content-derived ETags. The default information response is JSON-LD with the IIIF context profile; `Accept: application/json` selects plain JSON. Responses vary by `Accept` and `Origin` and include the IIIF profile link.

Level 0 offers the advertised sizes, rather than arbitrary crop, rotation, quality, format or size parameters. Unsupported parameters return `400`; missing/hidden sources return `404`; unsupported source formats return `415`; processing limits return `413`; a changed source during generation can return `409`; overload returns `503` with `Retry-After: 1`. Errors are `no-store`.

## Application mapping

IIIF leaves identifier selection and service discovery to applications. LanternDock uses unpadded base64url of the UTF-8 file path relative to the public WebDAV root. For example, `photo.png` maps to `cGhvdG8ucG5n`. This is an identifier, **not an access token**. The capability-document envelope and this path mapping are LanternDock conventions; image information, rendition paths and HTTP validation follow existing standards.

Images use the same anonymous public-folder policy as `/dav/`. Every request, including a warm-cache or conditional request, opens the source through the confined public filesystem. Recycle-bin exclusions and refusal to follow symbolic links apply equally to image reads. Files in the private inbox are not exposed by this service. Removing a source prevents new API reads, but cannot erase a copy already received by a visitor.

The frontend sends image requests through its existing HTTPS or WebTransport connection. It never follows an origin supplied by `info.json`. The information document uses an explicitly configured `NAS_RESOURCE_ORIGIN` when NAS identity is enabled, or the incoming HTTP origin otherwise. The default logical login/DPoP origin is never substituted for the image server. With WebTransport, the HTTP origin can be reachable only inside the NAS network: the client maps the image path into the current session. **IIIF does not define this WebTransport binding.** A third-party IIIF viewer needs a directly reachable HTTP(S) service and a corresponding absolute `id`; a Worker portal does not proxy these image paths. For an HTTPS deployment with NAS identity enabled, set the existing `NAS_RESOURCE_ORIGIN` to that public backend origin, and forward `/dav` and `/api` unchanged. Without NAS identity, the direct HTTP origin is used; a TLS-terminating proxy must preserve the correct public origin for a fully resolvable IIIF `id`.

The optional capability lookup happens once per frontend connection, when an image first enters the visible area. Third-party DAV services without this capability continue to work: listings retain file-type icons and previews use the existing original-file path. No thumbnail endpoint is guessed.

## Formats and limits

- Source formats: JPEG, PNG, GIF, WebP, BMP and TIFF. GIF/TIFF previews use the first frame/page. JPEG/TIFF EXIF orientation is applied. Generated images do not retain EXIF/GPS metadata; transparency is flattened on white.
- Advertised sizes fit the source into a longest side of 128, 384 or 1600 pixels, preserving aspect ratio without enlarging a smaller source. The browser uses 128 for list thumbnails, 384 for grids and up to 1600 for previews; file details still show oriented source dimensions.
- Input ceiling: 128 MiB and 64 million pixels. One rendition is generated at a time, with at most eight image requests admitted and a 15-second request deadline. Pixel decoding itself is synchronous and may finish after cancellation; its concurrency and input limits still apply.
- HEIC, AVIF, RAW and SVG are not decoded by this generator. Unsupported images fall back to the browser's original-file preview when possible, limited to 25 MiB. Text preview remains limited to 1 MiB. Downloads always use the original file. Live Photo/video playback is not included.

## Cache behavior

| Layer                     | Default behavior                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NAS disk                  | `/data/cache/images`; shared 1 GiB budget for renditions and metadata, at most 20,000 entries, least recently used eviction, atomic writes; safe to delete while the service is stopped            |
| Source invalidation       | Path, device/inode, size, nanosecond mtime and ctime version the disk entries; no original-file hash is needed on every request                                                                    |
| HTTP image/original reads | `Cache-Control: private, no-cache`; stored responses must be validated before reuse, unchanged ETags permit `304`                                                                                  |
| Directories               | Standard WebDAV `PROPFIND`, response limit 8 MiB; successful NAS listings advertise `private, max-age=15`; bounded application-memory cache up to 16 MiB/64 directories                            |
| Browser images            | Per-connection memory: up to 16 MiB/512 response entries plus 16 MiB/256 display previews; a shared lazy observer and at most three image jobs; no image persistence in local storage or IndexedDB |

The browser honors `no-store`, `no-cache`, `max-age` and `Age`; it caps explicit freshness at 15 seconds and validates conservatively when freshness is not supplied. An already displayed directory or image can be painted immediately from the connection's UI state while a required validation runs. This display snapshot is not an authorization decision. A failed validation removes its displayed preview; a failed directory refresh clears the listing. Manual refresh bypasses directory freshness and expires image display snapshots. Reconnecting or changing credentials destroys connection caches and cancels queued image work. Ordinary HTTP connections may additionally use the browser's native HTTP cache; HTTP responses carried in WebTransport streams use the explicit bounded cache because the browser does not cache those streams automatically.

Disk entries survive normal restarts and are migrated with the private application's ownership when `PUID`/`PGID` changes. Cache writes are best-effort: a full or unwritable cache does not prevent a freshly generated rendition from being returned. Cached pixels are disposable, and no cache files are mounted under the public directory.
