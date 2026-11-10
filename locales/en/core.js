export default {
  "error.RECORDS_UNAVAILABLE":
    "Unable to read local records. Check browser permissions or try again later.",
  "error.WEBTRANSPORT_UNSUPPORTED":
    "This browser does not support WebTransport. Use a compatible browser or configure an HTTPS backend.",
  "error.CONNECTION_TIMEOUT":
    "The connection timed out. Check the UDP tunnel, page origin, and certificate hashes.",
  "error.MIXED_CONTENT":
    "An HTTPS page cannot access this plain HTTP address. Use an HTTPS backend or WebTransport.",
  "error.BACKEND_UNREACHABLE":
    "Unable to connect directly to the backend. Check its address, HTTPS certificate, network, and WebDAV CORS / OPTIONS settings.",
  "error.IDENTITY_STORAGE_REQUIRED":
    "Sign-in requires browser permission to store a security key for this site.",
  "error.ACCOUNT_SERVICE_ERROR":
    "The account service returned {{status}}. Check the connection settings.",
  "error.AUTHORIZATION_MISMATCH":
    "The site authorization settings do not match. Check the deployment.",
  "error.INVALID_NAS_GRANT": "The site returned invalid NAS credentials.",
  "error.NAS_NOT_CONFIGURED":
    "The NAS connection is not configured yet. You are signed in and can copy your sub.",
  "error.UPLOAD_GATEWAY_AUTH":
    "The upload gateway requires authentication. Ask the recipient to check its settings.",
  "error.UPLOAD_SERVICE_ERROR":
    "The upload service returned {{status}}. Try again later.",
  "error.UPLOAD_HTTPS_REQUIRED":
    "An HTTPS page must upload files over HTTPS or WebTransport.",
  "error.UPLOAD_CONNECTION_INTERRUPTED":
    "The upload connection was interrupted. Check your network and try again.",
  "error.VIDEO_UNSUPPORTED":
    "This browser does not support the video format or codec. Download the video to play it.",
  "error.OUTSIDE_ROOT": "Cannot leave the configured root directory.",
  "error.VIDEO_HTTPS_REQUIRED":
    "Direct video playback requires an HTTPS address.",
  "error.VIDEO_CHANGED": "The video has changed. Refresh and try again.",
  "error.VIDEO_RANGE_INVALID":
    "The backend did not return a valid Range response. Download the video to play it.",
  "error.VIDEO_INCOMPLETE": "The video data is incomplete. Try again.",
  "error.VIDEO_INDEX_UNREADABLE":
    "Unable to read the video index. Download the video to play it.",
  "error.VIDEO_INDEX_LIMIT":
    "The video index exceeds the preview processing limit. Download the video to play it.",
  "error.VIDEO_SEGMENT_LIMIT":
    "The video segment exceeds the preview processing limit. Download the video to play it.",
  "error.VIDEO_INDEX_INVALID":
    "The video index is invalid. Download the video to play it.",
  "error.MEMORY_LIMIT":
    "The file exceeds this browser’s preview / in-memory download limit.",
  "error.INVALID_PATH": "Invalid file path.",
  "error.INVALID_PATH_ENCODING": "Invalid path encoding.",
  "error.PATH_DENIED": "Access to this path is not allowed.",
  "error.UNSAFE_XML": "The backend returned unsafe XML.",
  "error.INVALID_WEBDAV":
    "The backend did not return a valid WebDAV directory. Make sure the address points to the WebDAV mount.",
  "error.BACKEND_LOGIN_REQUIRED":
    "The backend requires sign-in. Enter its account credentials or access token.",
  "error.GATEWAY_AUTH_REQUIRED":
    "The gateway requires authentication. Enter the Bridge access token.",
  "error.BACKEND_ACCESS_DENIED":
    "The backend denied access. Check file permissions and the gateway path allowlist.",
  "error.BACKEND_RESPONSE_ERROR":
    "The backend returned {{status}}. Check its address and access permissions.",
  "error.PREVIEW_READ_ONLY": "File previews support read requests only.",
  "error.INVALID_LIBRARY_NAME":
    "The library name cannot contain line breaks or control characters.",
  "error.TRANSPORT_REQUIRED": "Choose a connection method.",
  "error.BACKEND_URL_REQUIRED":
    "Enter the complete backend address, such as https://files.example.com.",
  "error.BACKEND_URL_INVALID":
    "Use an HTTP(S) address. Enter account credentials and tokens when connecting.",
  "error.WEBTRANSPORT_HTTPS_REQUIRED":
    "A WebTransport address must start with https://.",
  "error.ROOT_PATH_INVALID":
    "The root directory must start with / and cannot contain .., query parameters, or invalid encoding.",
  "error.AUTH_METHOD_REQUIRED": "Choose a backend authentication method.",
  "error.CERTIFICATE_MODE_REQUIRED": "Choose a gateway certificate type.",
  "error.DOWNLOAD_MEMORY_LIMIT":
    "The file exceeds this browser’s 256 MB in-memory download limit.",
  "error.DOWNLOAD_BATCH_MEMORY_LIMIT":
    "This browser limits a download batch to 256 MB. Select fewer files, or use a browser with directory saving support.",
  "error.DOWNLOAD_NAME_CONFLICT":
    "Could not choose an unused destination filename.",
  "error.DOWNLOAD_FILE_API_REQUIRED":
    "This browser limits in-memory downloads to 256 MB. Use a browser with the file-saving API to download larger files.",
  connectionCancelled: "Connection cancelled",
  connectionClosed: "Connection closed",
  uploadCancelled: "Upload cancelled",
  cancelled: "Cancelled",
  recordsSaveDenied: "The browser did not allow local records to be saved.",
  favoriteRemoved: "Removed from favorites",
  favoriteAdded: "Added to favorites",
  secretGenerationUnavailable:
    "Unable to generate a deployment secret. Use a browser that supports Web Crypto.",
  publicLibraryName: "Public library",
  configurationUnavailable: "Service configuration is temporarily unavailable.",
  downloadInProgress:
    "Wait for the current download to finish, or cancel it and try again.",
  downloadCancelled: "Download cancelled",
  imageRemoved: "The file has been removed. Refresh the directory.",
  imagePreviewFailed: "Unable to load the image preview. Try again later.",
  defaultLibraryName: "My files",
  downloadComplete: "Download complete: {{name}}",
  "error.MP4_PARSE_ERROR":
    "Unable to parse the video file ({{context}}). Download the video to play it.",
  diagnosticByte: "byte {{offset}}",
  diagnosticSeparator: ", ",
  "category.album": "Albums",
  "category.video": "Videos",
  "category.text": "Documents",
  "category.book": "Books",
  "category.audio": "Audio",
  "category.image": "Images",
  "album.unknown": "Unknown date",
  "album.today": "Today",
  "album.yesterday": "Yesterday",
  "error.HTTP_HEADER_LIMIT": "HTTP header limit exceeded",
  "error.HTTP_MESSAGE_TRUNCATED": "Truncated HTTP message",
  "error.HTTP_BODY_TRUNCATED": "Truncated HTTP body",
  "error.HTTP_TARGET_INVALID": "Invalid HTTP request target",
  "error.HTTP_BODY_LENGTH_INVALID": "Invalid request body length",
  "error.HTTP_HEADER_INVALID": "Invalid header",
  "error.HTTP_STATUS_INVALID": "Invalid HTTP response status",
  "error.HTTP_RESPONSE_HEADER_INVALID": "Invalid HTTP response header",
  "error.HTTP_CONTENT_LENGTH_DUPLICATE": "Duplicate Content-Length",
  "error.HTTP_UPGRADE_UNSUPPORTED": "Protocol upgrades are not supported",
  "error.HTTP_INTERIM_LIMIT": "Too many interim responses",
  "error.HTTP_FRAMING_INVALID": "Unsupported or ambiguous HTTP framing",
  "error.HTTP_CONTENT_LENGTH_INVALID": "Invalid Content-Length",
  "error.HTTP_CHUNK_TERMINATOR_INVALID": "Invalid chunk terminator",
  "error.HTTP_CHUNK_SIZE_INVALID": "Invalid chunk size",
  "error.HTTP_TRAILER_LIMIT": "Trailer limit exceeded",
  "error.HTTP_TRAILER_INVALID": "Invalid trailer",
  "error.HTTP_CHUNK_TRUNCATED": "Truncated chunk",
  "error.HTTP_ENCODING_UNSUPPORTED":
    "This HTTP content encoding is not supported.",
};
