import { t } from "../../shared/i18n.js";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "./Icon.jsx";
import { limitedBytes } from "../lib/dav.js";
import { bytes, date } from "../lib/format.js";
import { useBreakpointDown } from "../hooks/useMediaQuery.js";
import { Dialog } from "./Dialog.jsx";
import { VideoPreview } from "./VideoPreview.jsx";
import { dialogHeadingFocus } from "../lib/overlay-focus.js";

export function FilePreview({
  item,
  client,
  favorite,
  onFavorite,
  onDownload,
  onCopyLink,
  onError,
  onClose,
  onEntered,
  onExited,
  returnTarget,
  open,
  feedback,
}) {
  const modal = useBreakpointDown("lg");
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let url;
    setContent(null);
    setError("");
    setDimensions("");
    (async () => {
      try {
        if (item.kind === "video") {
          setContent({ video: true });
          return;
        }
        if (!["image", "text"].includes(item.kind)) {
          setError(t("library.downloadToView"));
          return;
        }
        if (item.kind === "image" && client.images) {
          const show = (image) => {
            if (!image || controller.signal.aborted) return;
            if (url) URL.revokeObjectURL(url);
            url = URL.createObjectURL(image.blob);
            setContent({ url, width: image.width, height: image.height });
            setDimensions(`${image.width} × ${image.height}`);
          };
          show(client.images.peek(item, 1600));
          const image = await client.images.image(
            item,
            1600,
            controller.signal,
          );
          if (image) {
            show(image);
            return;
          }
        }
        const limit = (item.kind === "image" ? 25 : 1) * 1024 * 1024;
        if (item.size > limit) throw new Error(t("library.previewTooLarge"));
        const response = await client.get(item.path, controller.signal);
        const data = await limitedBytes(response, limit, controller.signal);
        if (controller.signal.aborted) return;
        if (item.kind === "text") {
          setContent({ text: new TextDecoder().decode(data) });
          return;
        }
        const mime = response.headers.get("Content-Type")?.split(";")[0];
        if (mime && !mime.startsWith("image/"))
          throw new Error(t("library.imageResponseInvalid"));
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(
          new Blob([data], { type: mime || "image/*" }),
        );
        setContent({ url });
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(t("library.filePreviewFailed"));
          onError(error.message);
        }
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [item, client, client.images?.revision]);

  return (
    <Dialog
      open={open}
      modal={modal}
      onClose={onClose}
      onEntered={onEntered}
      onExited={onExited}
      returnTarget={returnTarget}
      fallbackFocus=".main-area #file-list"
      id="preview-dialog"
      class="preview-dialog"
      aria-labelledby="preview-name"
    >
      <div class="preview-header" {...dialogHeadingFocus}>
        <button
          class="icon-button edge-start"
          aria-label={t("library.closePreview")}
          onClick={onClose}
        >
          <Icon name={modal ? "chevron-left" : "x"} />
        </button>
        <strong id="preview-name">{item.name}</strong>
        <button
          class="icon-button"
          aria-label={t("library.copyLink")}
          onClick={() => onCopyLink(item)}
        >
          <Icon name="copy" />
        </button>
        <button
          class="icon-button edge-end"
          aria-label={
            favorite ? t("library.unfavoriteFile") : t("library.favoriteFile")
          }
          aria-pressed={favorite}
          style={{ color: favorite ? "#a58b41" : undefined }}
          onClick={() => onFavorite(item)}
        >
          <Icon name={favorite ? "star-filled" : "star"} />
        </button>
      </div>
      <div class="preview-scroll">
        <div class="preview-content">
          {error || !content ? (
            <div class="preview-placeholder">
              <Icon name={item.kind} />
              <p role="status">{error || t("library.loadingPreview")}</p>
            </div>
          ) : content.video ? (
            <VideoPreview
              item={item}
              client={client}
              open={open}
              onError={onError}
              onDimensions={(width, height) =>
                setDimensions(`${width} × ${height}`)
              }
            />
          ) : content.text !== undefined ? (
            <pre>{content.text}</pre>
          ) : (
            <img
              src={content.url}
              alt={item.name}
              onLoad={(event) =>
                setDimensions(
                  `${content.width || event.currentTarget.naturalWidth} × ${content.height || event.currentTarget.naturalHeight}`,
                )
              }
              onError={() => {
                setError(t("library.imagePreviewFailed"));
                onError(t("library.imagePreviewFailed"));
              }}
            />
          )}
        </div>
        <dl class="file-details">
          <div>
            <dt>{t("library.type")}</dt>
            <dd>{item.mime || item.name.split(".").pop().toUpperCase()}</dd>
          </div>
          <div>
            <dt>{t("library.size")}</dt>
            <dd>{bytes(item.size)}</dd>
          </div>
          {dimensions && (
            <div>
              <dt>{t("library.dimensions")}</dt>
              <dd>{dimensions}</dd>
            </div>
          )}
          <div>
            <dt>{t("library.modifiedAt")}</dt>
            <dd>{date(item.modified, true)}</dd>
          </div>
        </dl>
      </div>
      <div class="preview-actions">
        <button class="primary-button" onClick={() => onDownload(item)}>
          <Icon name="download" />
          {t("library.download")}
        </button>
      </div>
      {feedback}
    </Dialog>
  );
}
