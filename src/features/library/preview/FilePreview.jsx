import { t } from "../../../../shared/i18n.js";
import { useEffect, useId, useLayoutEffect, useState } from "preact/hooks";
import { Icon } from "../../../components/Icon.jsx";
import { limitedBytes } from "../../../lib/dav.js";
import {
  useBreakpointDown,
  useCompactLayout,
} from "../../../hooks/useMediaQuery.js";
import { Dialog } from "../../../components/Dialog.jsx";
import { FileInfoDrawer } from "./FileInfoDrawer.jsx";
import { PreviewImage } from "./PreviewImage.jsx";
import { PreviewMetadata } from "./PreviewMetadata.jsx";
import { VideoPreview } from "./VideoPreview.jsx";
import { dialogHeadingFocus } from "../../../lib/overlay-focus.js";

export function FilePreview({
  item,
  thumbnail,
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
  const compact = useCompactLayout();
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const [drawerMounted, setDrawerMounted] = useState(false);
  useLayoutEffect(() => {
    if (compact && details && open) setDrawerMounted(true);
    else if (!compact) {
      setDetails(false);
      setDrawerMounted(false);
    }
  }, [compact, details, open]);

  useEffect(() => {
    if (item.kind !== "text") return;
    const controller = new AbortController();
    setContent(null);
    setError("");
    (async () => {
      const limit = 1024 * 1024;
      if (item.size > limit) throw new Error(t("library.previewTooLarge"));
      const response = await client.get(item.path, controller.signal);
      const data = await limitedBytes(response, limit, controller.signal);
      if (!controller.signal.aborted)
        setContent(new TextDecoder().decode(data));
    })().catch((error) => {
      if (controller.signal.aborted) return;
      setError(t("library.filePreviewFailed"));
      onError(error.message);
    });
    return () => controller.abort();
  }, [item, client]);

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
      </div>
      <div
        class={`preview-scroll${item.kind === "image" || item.kind === "video" ? " preview-media" : ""}`}
      >
        <div class="preview-content">
          {item.kind === "image" ? (
            <PreviewImage
              item={item}
              client={client}
              thumbnail={thumbnail}
              onDimensions={setDimensions}
              onError={onError}
            />
          ) : item.kind === "video" ? (
            <VideoPreview
              item={item}
              client={client}
              open={open}
              onError={onError}
              onDimensions={(width, height) =>
                setDimensions(`${width} × ${height}`)
              }
            />
          ) : content !== null ? (
            <pre>{content}</pre>
          ) : (
            <div class="preview-placeholder">
              <Icon name={item.kind} />
              <p role="status">
                {item.kind === "text"
                  ? error || t("library.loadingPreview")
                  : t("library.downloadToView")}
              </p>
            </div>
          )}
        </div>
        {!compact && (
          <section
            id={detailsId}
            class="preview-details"
            aria-label={t("library.mediaDetails")}
          >
            <PreviewMetadata item={item} dimensions={dimensions} />
          </section>
        )}
      </div>
      <footer class="preview-actions">
        <button
          class="preview-action"
          aria-label={t("library.copyLink")}
          onClick={() => onCopyLink(item)}
        >
          <Icon name="copy" />
          <span>{t("library.copyLink")}</span>
        </button>
        <button
          class="preview-action"
          aria-label={
            favorite ? t("library.unfavoriteFile") : t("library.favoriteFile")
          }
          aria-pressed={favorite}
          onClick={() => onFavorite(item)}
        >
          <Icon name={favorite ? "heart-filled" : "heart"} />
          <span>
            {t(favorite ? "library.removeFavorites" : "library.addFavorites")}
          </span>
        </button>
        <button class="preview-action" onClick={() => onDownload(item)}>
          <Icon name="download" />
          <span>{t("library.download")}</span>
        </button>
        {compact && (
          <button
            class="preview-action"
            aria-label={t("library.mediaDetails")}
            aria-haspopup="dialog"
            aria-expanded={details}
            aria-controls={detailsId}
            onClick={() => setDetails((value) => !value)}
          >
            <Icon name="info" />
            <span>{t("library.info")}</span>
          </button>
        )}
      </footer>
      {compact && drawerMounted && (
        <FileInfoDrawer
          id={detailsId}
          open={details && open}
          onClose={() => setDetails(false)}
          onExited={() => setDrawerMounted(false)}
        >
          <PreviewMetadata item={item} dimensions={dimensions} />
        </FileInfoDrawer>
      )}
      {feedback}
    </Dialog>
  );
}
