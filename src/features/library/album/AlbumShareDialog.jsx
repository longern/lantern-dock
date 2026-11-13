import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../../../shared/i18n.js";
import { Dialog } from "../../../components/Dialog.jsx";
import { Icon } from "../../../components/Icon.jsx";
import { PageHeader } from "../../../components/PageHeader.jsx";
import { SheetHandle } from "../../../components/SheetHandle.jsx";
import { decodeImage, previewImage } from "../../../lib/image-preview.js";
import { dialogHeadingFocus } from "../../../lib/overlay-focus.js";

const returnToShareButton = (scope) =>
  scope.querySelector(".album-share-trigger");

async function clipboardImage(client, item, signal) {
  const { blob } = await previewImage(client, item, signal);
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  try {
    const { image, width, height } = await decodeImage(url, signal);
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    signal.throwIfAborted();
    if (!png) throw new Error("Image encoding failed");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AlbumShareDialog({
  item,
  client,
  url,
  compact,
  open,
  onClose,
  onExited,
  toast,
}) {
  const [controller] = useState(() => new AbortController());
  const [busy, setBusy] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [qrStatus, setQRStatus] = useState("loading");
  const canvas = useRef(null);
  const current = useRef(open);
  current.current = open;
  const busyRef = useRef(false);
  const data = { title: item.name, url };
  const canShare =
    typeof navigator.share === "function" &&
    (!navigator.canShare || navigator.canShare(data));
  const canCopyImage =
    item.kind === "image" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem === "function" &&
    (!ClipboardItem.supports || ClipboardItem.supports("image/png"));
  useEffect(() => {
    if (!open) controller.abort();
  }, [controller, open]);
  useEffect(() => () => controller.abort(), [controller]);
  useEffect(() => {
    if (!showQR || !open) return;
    let active = true;
    const node = canvas.current;
    import("qrcode")
      .then(async ({ default: encoder }) => {
        if (!active) return;
        await encoder.toCanvas(node, url, { width: 384, margin: 4 });
        node.style.removeProperty("width");
        node.style.removeProperty("height");
      })
      .then(
        () => {
          if (active) setQRStatus("ready");
        },
        () => {
          if (active) setQRStatus("error");
        },
      );
    return () => {
      active = false;
    };
  }, [showQR, open, url]);

  const run = async (action, success, failure) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      if (!current.current || controller.signal.aborted) return;
      onClose();
      if (success) toast(t(success));
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        current.current &&
        !controller.signal.aborted
      )
        toast(t(failure), true);
    } finally {
      busyRef.current = false;
      if (current.current && !controller.signal.aborted) setBusy(false);
    }
  };
  const copyImage = () => {
    // Start the clipboard write in the click, before the image is read or encoded.
    const png = clipboardImage(client, item, controller.signal);
    void png.catch(() => {});
    return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  };

  return (
    <Dialog
      id="album-share-dialog"
      class={`settings-dialog album-share-dialog${compact ? " file-info-drawer" : ""}`}
      open={open}
      inert={!open}
      aria-labelledby="album-share-title"
      onKeyDown={(event) => event.stopPropagation()}
      returnTarget={returnToShareButton}
      onClose={onClose}
      onExited={onExited}
    >
      {compact && <SheetHandle onDismiss={onClose} />}
      <PageHeader
        className="file-info-header"
        title={t("library.share")}
        titleId="album-share-title"
        titleTag="h2"
        actions={
          <button
            type="button"
            class="icon-button edge-end"
            aria-label={t("library.closeShare")}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        }
        {...dialogHeadingFocus}
      />
      <div class="album-share-body" aria-busy={busy}>
        <ul class="album-share-actions">
          {canShare && (
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => navigator.share(data),
                    null,
                    "library.shareFailed",
                  )
                }
              >
                <Icon name="share" />
                {t("library.share")}
              </button>
            </li>
          )}
          <li>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => navigator.clipboard.writeText(url),
                  "library.linkCopied",
                  "library.copyLinkFailed",
                )
              }
            >
              <Icon name="link" />
              {t("library.copyLink")}
            </button>
          </li>
          {canCopyImage && (
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    copyImage,
                    "library.imageCopied",
                    "library.copyImageFailed",
                  )
                }
              >
                <Icon name="copy" />
                {t("library.copyImage")}
              </button>
            </li>
          )}
          <li>
            <button
              type="button"
              disabled={busy}
              aria-expanded={showQR}
              aria-controls="album-share-qr"
              onClick={() => {
                if (!showQR) setQRStatus("loading");
                setShowQR(!showQR);
              }}
            >
              <Icon name="qr-code" />
              {t("library.shareQR")}
            </button>
          </li>
        </ul>
        {showQR && (
          <div class="album-share-qr" id="album-share-qr">
            <canvas
              ref={canvas}
              hidden={qrStatus !== "ready"}
              role="img"
              aria-label={t("library.shareQR")}
            />
            {qrStatus !== "ready" && (
              <p role="status">
                {t(
                  qrStatus === "loading"
                    ? "library.loadingMore"
                    : "library.shareQRFailed",
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
