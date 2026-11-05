# WebTransport bridge contract

This documents the existing mapping used by LanternDock and `webtransport-bridge`. The mapping is project-specific; WebDAV itself remains standard HTTP/WebDAV. **Mapping version 1** is a documentation label for the current wire format, not an implemented version-negotiation header or a standardized HTTP/3 tunnel.

## Session and stream lifecycle

- The browser opens the configured HTTPS `/webtransport` session endpoint using Web PKI or published certificate hashes. The bridge checks the exact frontend Origin. UDP reachability, TLS verification and the WebTransport handshake precede application authentication.
- Each client-created bidirectional stream carries exactly one HTTP/1.1 request and response. Multiple streams share the session; there is no HTTP pipelining or second request on a stream.
- Requests use an origin-form target, for example `GET /dav/photo.jpg HTTP/1.1`, followed by CRLF-delimited headers, a blank line and body bytes. The client sends an exact Content-Length for bodies and closes its write direction after transmission.
- The response uses HTTP framing: Content-Length, chunked transfer encoding or end of the stream. HEAD and no-body statuses do not wait for body bytes. The LanternDock parser rejects duplicate Content-Length, ambiguous framing, truncation and protocol upgrades; it supports gzip/deflate decoding where browser APIs allow it.
- Request and response directions are independent. A bridge can reject headers before reading an upload body; a stopped write direction must not hide a readable error response. Cancellation closes the stream directions and cancels the upstream request. A stream reset/timeout is a transport failure, not a successful empty response.

## Forwarding and authentication boundaries

The bridge forwards only to its configured backend. The request target cannot choose a new upstream origin. Allowed methods and path prefixes are enforced at the bridge, including decoded-path checks; the NAS separately enforces filesystem and authorization rules. The backend Host is rewritten to the configured backend.

| Header / permission               | Owner                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `Proxy-Authorization: Bearer ...` | Optional bridge gateway permission. Consumed by the bridge, not forwarded to the backend. |
| `Authorization: DPoP ...`, `DPoP` | NAS identity. Forwarded without substituting gateway credentials.                         |
| `Authorization: Bearer ...`       | Temporary NAS collection permission, or another backend's bearer permission.              |
| `Authorization: Basic ...`        | Another WebDAV backend's login, if configured.                                            |

Hop-by-hop headers are removed according to HTTP forwarding rules. The current browser transport does not automatically attach cookies to WebTransport streams; NAS identity uses its explicit headers. Bridge public mode disables gateway authentication only; it does not grant NAS upload or administrative permissions. File contents go directly to the bridge/NAS, not through the Worker.

## Errors and limits

| Layer / status                         | Meaning                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Handshake failure / stream reset       | Network, TLS, Origin, session/stream limits or transport timeout; inspect that layer before treating it as a backend login error. |
| Bridge `400`                           | Invalid HTTP request or target.                                                                                                   |
| Bridge `403`                           | Disallowed path.                                                                                                                  |
| Bridge `405` with `Allow`              | Method not enabled on the bridge.                                                                                                 |
| Bridge `407` with `Proxy-Authenticate` | Missing or invalid gateway bearer credential.                                                                                     |
| Bridge `413`                           | Request body exceeds its configured limit.                                                                                        |
| Bridge `417`                           | Unsupported Expect/Upgrade request.                                                                                               |
| Bridge `502` / `504`                   | Upstream failure / upstream response timeout.                                                                                     |
| NAS `401` / `403`                      | Application token/proof failure / insufficient permission. Read `WWW-Authenticate` and its JSON error code.                       |

Bridge-generated failures are currently HTTP text responses; NAS application failures are JSON. Preserve the layer distinction instead of inventing one shared status-code namespace. Default bridge limits are a 32 KiB header block, a 1 GiB request body, 32 global exchanges and 128 sessions. Its default header, idle and response-header deadlines are 15, 60 and 30 seconds respectively. Deployment flags can change those limits; a NAS may impose stricter quotas and deadlines.

These behaviors are covered by the real-bridge integration tests and HTTP framing unit tests. Any future incompatible wire mapping needs an explicit opt-in/version negotiation and tests for both peers. This change does not require an update to the bridge wire format.
